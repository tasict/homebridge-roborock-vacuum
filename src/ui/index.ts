import crypto from "crypto";
import path from "path";
import fs from "fs";
import { encryptSession, decryptSession } from "../crypto";

const roborockAuth = require("../../roborockLib/lib/roborockAuth");
const roborockHome = require("../../roborockLib/lib/roborockHome");
const QRCode = require("qrcode");

/**
 * Homebridge accepts `matter: true` (legacy shorthand) or a MatterConfig
 * object where a missing `enabled` means enabled. Mirrors homebridge's
 * `isMatterConfigEnabled`.
 */
function isMatterFlagEnabled(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { enabled?: unknown }).enabled !== false
  );
}

// Type definition for HomebridgePluginUiServer to maintain type safety
interface IHomebridgePluginUiServer {
  homebridgeStoragePath?: string;
  homebridgeConfigPath?: string;
  onRequest(path: string, handler: (payload: any) => Promise<any>): void;
  ready(): void;
}

type HomebridgePluginUiServerConstructor = new () => IHomebridgePluginUiServer;

/** Regional endpoint plus the account's country, resolved per login. */
interface ResolvedRegion {
  baseURL: string;
  country: string;
  countryCode: string;
}

class RoborockUiServer {
  private homebridgePluginUiServer: IHomebridgePluginUiServer;
  private homebridgeStoragePath?: string;
  private homebridgeConfigPath?: string;
  // Discovered regions per account email, kept for the server's lifetime so
  // one settings-page session only performs discovery once per account.
  private readonly regionCache = new Map<string, ResolvedRegion>();

  constructor(HomebridgePluginUiServer: HomebridgePluginUiServerConstructor) {
    this.homebridgePluginUiServer = new HomebridgePluginUiServer();
    this.homebridgeStoragePath =
      this.homebridgePluginUiServer.homebridgeStoragePath;
    this.homebridgeConfigPath =
      this.homebridgePluginUiServer.homebridgeConfigPath;

    this.homebridgePluginUiServer.onRequest(
      "/auth/send-2fa-email",
      this.sendTwoFactorEmail.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/verify-2fa-code",
      this.verifyTwoFactorCode.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/login",
      this.loginWithPassword.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/logout",
      this.logout.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/devices/list",
      this.listDevices.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/matter/status",
      this.getMatterStatus.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/matter/pairing",
      this.getMatterPairings.bind(this)
    );

    this.homebridgePluginUiServer.ready();
  }

  private getStoragePath(): string {
    return this.homebridgeStoragePath || process.cwd();
  }

  /**
   * Device-list cache so the settings page renders instantly instead of
   * waiting for a Roborock cloud round-trip on every open. Written after a
   * successful login (prefetch) and after every cloud fetch; keyed by
   * account so switching accounts never shows another account's devices.
   */
  private getDeviceCachePath(): string {
    return path.join(this.getStoragePath(), "roborock.uiDevices.json");
  }

  private deviceCacheKey(email?: string, baseURL?: string): string {
    return `${(email || "").trim().toLowerCase()}@${baseURL || "usiot.roborock.com"}`;
  }

  private readDeviceCache(
    email?: string,
    baseURL?: string
  ): { devices: unknown[]; updatedAt: number } | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.getDeviceCachePath(), "utf8")
      );
      if (
        raw &&
        Array.isArray(raw.devices) &&
        raw.account === this.deviceCacheKey(email, baseURL)
      ) {
        return { devices: raw.devices, updatedAt: raw.updatedAt || 0 };
      }
    } catch (error) {
      // Missing or unreadable cache is simply a miss.
    }
    return null;
  }

  private writeDeviceCache(
    email: string | undefined,
    baseURL: string | undefined,
    devices: unknown[]
  ): void {
    try {
      fs.writeFileSync(
        this.getDeviceCachePath(),
        JSON.stringify(
          {
            account: this.deviceCacheKey(email, baseURL),
            updatedAt: Date.now(),
            devices,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (error) {
      // Cache is best-effort; the next page open just fetches live.
    }
  }

  private clearDeviceCache(): void {
    try {
      if (fs.existsSync(this.getDeviceCachePath())) {
        fs.unlinkSync(this.getDeviceCachePath());
      }
    } catch (error) {
      // Ignore file removal errors.
    }
  }

  /**
   * Resolve the account's region. An explicitly chosen baseURL wins;
   * otherwise the region is discovered from the account email via
   * getUrlByEmail (cached in-process; failures are not cached so a retry
   * can succeed) and falls back to the US endpoint like before.
   */
  private async resolveRegion(
    email: string | undefined,
    baseURL: string | undefined
  ): Promise<ResolvedRegion> {
    if (baseURL) {
      return { baseURL, ...roborockAuth.getRegionConfig(baseURL) };
    }

    const cacheKey = (email || "").trim().toLowerCase();
    const cached = this.regionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const discovered = email
      ? await roborockAuth.discoverAccountRegion(email)
      : null;
    if (discovered) {
      const guess = roborockAuth.getRegionConfig(discovered.baseURL);
      const resolved: ResolvedRegion = {
        baseURL: discovered.baseURL,
        country: discovered.country || guess.country,
        countryCode: discovered.countryCode || guess.countryCode,
      };
      this.regionCache.set(cacheKey, resolved);
      return resolved;
    }

    const fallback = "usiot.roborock.com";
    return { baseURL: fallback, ...roborockAuth.getRegionConfig(fallback) };
  }

  /** Fetch the account's bridgeable vacuums from the Roborock cloud. */
  private async fetchSupportedDevices(
    email: string | undefined,
    baseURL: string | undefined,
    userData: unknown
  ): Promise<unknown[]> {
    const clientID = await this.getClientId();
    const region = await this.resolveRegion(email, baseURL);
    const devices = await roborockHome.fetchDevices({
      baseURL: region.baseURL,
      username: email,
      clientID,
      userData,
    });
    // Only list devices this plugin can bridge (same rule as
    // platform.isSupportedDevice).
    return (devices || []).filter(
      (device: { model?: unknown }) =>
        typeof device.model === "string" &&
        device.model.startsWith("roborock.vacuum.")
    );
  }

  /**
   * Fire-and-forget device prefetch right after a successful login, so the
   * first settings-page open renders from cache instead of waiting for the
   * cloud.
   */
  private prefetchDeviceCache(
    email: string | undefined,
    baseURL: string | undefined,
    userData: unknown
  ): void {
    void this.fetchSupportedDevices(email, baseURL, userData)
      .then((devices) => this.writeDeviceCache(email, baseURL, devices))
      .catch((error: any) => {
        console.error(
          "Device prefetch after login failed:",
          error?.message || error
        );
      });
  }

  private async getClientId(): Promise<string> {
    const storagePath = this.getStoragePath();
    if (storagePath) {
      const clientIdPath = path.join(storagePath, "roborock.clientID");
      try {
        const stored = JSON.parse(fs.readFileSync(clientIdPath, "utf8"));
        if (stored && stored.val) {
          return stored.val;
        }
      } catch (error) {
        // Ignore and generate a new client ID.
      }
      const clientId = crypto.randomUUID();
      fs.mkdirSync(storagePath, { recursive: true });
      fs.writeFileSync(
        clientIdPath,
        JSON.stringify({ val: clientId, ack: true }, null, 2),
        "utf8"
      );
      return clientId;
    }

    return crypto.randomUUID();
  }

  private async buildLoginApi(config: Record<string, any>) {
    const clientID = await this.getClientId();
    return roborockAuth.createLoginApi({
      baseURL: config.baseURL || "usiot.roborock.com",
      username: config.email,
      clientID,
      language: "en",
    });
  }

  private async sendTwoFactorEmail(payload: {
    email?: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    if (!email) {
      return { ok: false, message: "Email is required." };
    }

    try {
      const region = await this.resolveRegion(email, payload.baseURL);
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: region.baseURL,
      });
      await roborockAuth.requestEmailCode(loginApi, email);
      return { ok: true, message: "Verification email sent." };
    } catch (error: any) {
      console.error("2FA email request failed:", error?.message || error);
      return {
        ok: false,
        message: error?.message || "Failed to send verification email.",
      };
    }
  }

  private async verifyTwoFactorCode(payload: {
    email?: string;
    code: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    if (!email) {
      return { ok: false, message: "Email is required." };
    }

    if (!payload.code) {
      return { ok: false, message: "Verification code is required." };
    }

    let loginResult;
    try {
      // The resolved region carries the account's real country/countryCode
      // when discovery ran; the host-based mapping remains the fallback.
      const region = await this.resolveRegion(email, payload.baseURL);
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: region.baseURL,
      });
      const nonce = this.buildNonce();
      const signData = await roborockAuth.signRequest(loginApi, nonce);
      if (!signData || !signData.k) {
        return { ok: false, message: "Failed to create login signature." };
      }

      loginResult = await roborockAuth.loginWithCode(loginApi, {
        email,
        code: payload.code,
        country: region.country,
        countryCode: region.countryCode,
        k: signData.k,
        s: nonce,
      });
    } catch (error: any) {
      console.error(
        "2FA verification request failed:",
        error?.message || error
      );
      return { ok: false, message: error?.message || "Verification failed." };
    }

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      const encrypted = encryptSession(loginResult.data, this.getStoragePath());
      this.prefetchDeviceCache(email, payload.baseURL, loginResult.data);
      return {
        ok: true,
        message: "Login completed and token saved.",
        encryptedToken: encrypted,
      };
    }

    console.error("2FA verification failed:", loginResult);
    return { ok: false, message: loginResult?.msg || "Verification failed." };
  }

  private async loginWithPassword(payload: {
    email?: string;
    password?: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    const password = payload.password;

    if (!email || !password) {
      return { ok: false, message: "Email and password are required." };
    }

    let loginResult;
    try {
      const region = await this.resolveRegion(email, payload.baseURL);
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: region.baseURL,
      });
      const nonce = this.buildNonce();
      const signData = await roborockAuth.signRequest(loginApi, nonce);
      if (!signData || !signData.k) {
        return { ok: false, message: "Failed to create login signature." };
      }

      loginResult = await roborockAuth.loginByPassword(loginApi, {
        email,
        password,
        k: signData.k,
        s: nonce,
      });
    } catch (error: any) {
      console.error("Login request failed:", error?.message || error);
      return { ok: false, message: error?.message || "Login failed." };
    }

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      const encrypted = encryptSession(loginResult.data, this.getStoragePath());
      this.prefetchDeviceCache(email, payload.baseURL, loginResult.data);
      return {
        ok: true,
        message: "Login successful. Token saved.",
        encryptedToken: encrypted,
      };
    }

    if (loginResult && loginResult.code === 2031) {
      return {
        ok: false,
        twoFactorRequired: true,
        message: "Two-factor authentication required.",
      };
    }

    console.error("Login failed:", loginResult);
    return {
      ok: false,
      message: loginResult?.msg || "Login failed. Check your credentials.",
    };
  }

  private async logout() {
    const storagePath = this.getStoragePath();
    if (!storagePath) {
      return { ok: true, message: "Logged out. Token cleared." };
    }

    const userDataPath = path.join(storagePath, "roborock.UserData");
    try {
      if (fs.existsSync(userDataPath)) {
        fs.unlinkSync(userDataPath);
      }
    } catch (error) {
      // Ignore file removal errors.
    }

    this.clearDeviceCache();

    return { ok: true, message: "Logged out. Token cleared." };
  }

  private async listDevices(payload: {
    email?: string;
    baseURL?: string;
    encryptedToken?: string;
    refresh?: boolean;
  }) {
    if (!payload.encryptedToken) {
      return { ok: false, message: "Log in first to load your devices." };
    }

    // Cached-first: unless the UI asks for a refresh, answer from the cache
    // written at login/last fetch so the page renders without a cloud
    // round-trip. The UI refreshes in the background when it sees cached=true.
    if (!payload.refresh) {
      const cached = this.readDeviceCache(payload.email, payload.baseURL);
      if (cached) {
        return {
          ok: true,
          devices: cached.devices,
          cached: true,
          updatedAt: cached.updatedAt,
        };
      }
    }

    const userData = decryptSession(
      payload.encryptedToken,
      this.getStoragePath()
    );
    if (!userData) {
      return {
        ok: false,
        message: "Saved login could not be read. Please log in again.",
      };
    }

    try {
      const supported = await this.fetchSupportedDevices(
        payload.email,
        payload.baseURL,
        userData
      );
      this.writeDeviceCache(payload.email, payload.baseURL, supported);
      return { ok: true, devices: supported, cached: false };
    } catch (error: any) {
      console.error("Device list request failed:", error?.message || error);
      return {
        ok: false,
        message: error?.message || "Failed to load devices.",
      };
    }
  }

  /**
   * Report whether Homebridge Matter support is enabled on the main bridge
   * (read from the Homebridge config.json) and whether the installed
   * Homebridge core supports Matter at all (2.x). The UI checks the plugin's
   * own `_bridge.matter` (child-bridge mode) client-side. Returns
   * enabled=false on any read/parse failure so the UI simply hides the
   * Matter option.
   */
  private async getMatterStatus() {
    try {
      if (!this.homebridgeConfigPath) {
        return { ok: true, enabled: false, coreSupportsMatter: false };
      }
      const raw = fs.readFileSync(this.homebridgeConfigPath, "utf8");
      const config = JSON.parse(raw);
      return {
        ok: true,
        enabled: isMatterFlagEnabled(config?.bridge?.matter),
        coreSupportsMatter: this.coreSupportsMatter(),
      };
    } catch (error) {
      return { ok: true, enabled: false, coreSupportsMatter: false };
    }
  }

  /**
   * Per-device Matter pairing codes. Homebridge 2.x stores one Matter node
   * per external accessory (and per bridge) under `<storage>/matter/<id>/`
   * with `accessories.json` (identifies the accessory, including our
   * `context.duid`) and `commissioning.json` (QR/manual pairing code and
   * commissioning state). Returns one entry per accessory this plugin
   * published, with the QR content pre-rendered as an SVG so the config UI
   * can display it without external resources (the plugin UI iframe blocks
   * remote scripts).
   */
  private async getMatterPairings() {
    try {
      const matterRoot = path.join(this.getStoragePath(), "matter");
      if (!fs.existsSync(matterRoot)) {
        return { ok: true, pairings: [], bridgePairing: null };
      }

      const pairings: unknown[] = [];
      // The scene buttons are bridged accessories on the plugin's Matter
      // bridge node — a separate node from the per-device external nodes,
      // with its own pairing code the user must commission to see them.
      let bridgePairing: Record<string, unknown> | null = null;
      for (const entry of fs.readdirSync(matterRoot, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) {
          continue;
        }

        const nodeDir = path.join(matterRoot, entry.name);
        let accessories: any;
        let commissioning: any;
        try {
          accessories = JSON.parse(
            fs.readFileSync(path.join(nodeDir, "accessories.json"), "utf8")
          );
          commissioning = JSON.parse(
            fs.readFileSync(path.join(nodeDir, "commissioning.json"), "utf8")
          );
        } catch (error) {
          continue; // Not a fully initialized Matter node; skip it.
        }

        if (!Array.isArray(accessories) || !commissioning?.qrCode) {
          continue;
        }

        const sceneNames: string[] = [];
        for (const accessory of accessories) {
          const duid = accessory?.context?.duid;
          if (accessory?.plugin !== "homebridge-roborock-vacuum" || !duid) {
            continue;
          }
          if (accessory?.context?.sceneId !== undefined) {
            sceneNames.push(String(accessory.displayName));
            continue;
          }
          pairings.push({
            duid,
            name: accessory.displayName,
            qrCode: commissioning.qrCode,
            manualPairingCode: commissioning.manualPairingCode,
            commissioned: Boolean(commissioning.commissioned),
            fabricCount: commissioning.fabricCount || 0,
            qrSvg: await QRCode.toString(commissioning.qrCode, {
              type: "svg",
              margin: 1,
            }),
          });
        }

        if (sceneNames.length > 0 && !bridgePairing) {
          bridgePairing = {
            sceneNames,
            qrCode: commissioning.qrCode,
            manualPairingCode: commissioning.manualPairingCode,
            commissioned: Boolean(commissioning.commissioned),
            fabricCount: commissioning.fabricCount || 0,
            qrSvg: await QRCode.toString(commissioning.qrCode, {
              type: "svg",
              margin: 1,
            }),
          };
        }
      }

      return { ok: true, pairings, bridgePairing };
    } catch (error: any) {
      return {
        ok: false,
        message: error?.message || "Failed to read Matter pairing info.",
      };
    }
  }

  /**
   * Whether the Homebridge installation next to the config file is 2.x+
   * (the first release line with the Matter API). Conservative false when
   * the version cannot be determined.
   */
  private coreSupportsMatter(): boolean {
    try {
      if (!this.homebridgeConfigPath) {
        return false;
      }
      const pkgPath = path.join(
        path.dirname(this.homebridgeConfigPath),
        "node_modules",
        "homebridge",
        "package.json"
      );
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const major = parseInt(String(pkg.version).split(".")[0], 10);
      return Number.isFinite(major) && major >= 2;
    } catch (error) {
      return false;
    }
  }

  private buildNonce(): string {
    return crypto
      .randomBytes(12)
      .toString("base64")
      .substring(0, 16)
      .replace(/\+/g, "X")
      .replace(/\//g, "Y");
  }
}

/**
 * Entry point called by homebridge-ui/server.js. That file stays plain
 * CommonJS outside the TypeScript build, so it can load the ESM-only
 * @homebridge/plugin-ui-utils package with a native dynamic import (this
 * compiled bundle cannot — tsc rewrites dynamic imports for CommonJS
 * output) and then hands the constructor over.
 */
export function startUiServer(
  HomebridgePluginUiServer: HomebridgePluginUiServerConstructor
): void {
  new RoborockUiServer(HomebridgePluginUiServer);
}
