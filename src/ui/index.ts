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

class RoborockUiServer {
  private homebridgePluginUiServer: IHomebridgePluginUiServer;
  private homebridgeStoragePath?: string;
  private homebridgeConfigPath?: string;

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
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
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
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
      });
      const nonce = this.buildNonce();
      const signData = await roborockAuth.signRequest(loginApi, nonce);
      if (!signData || !signData.k) {
        return { ok: false, message: "Failed to create login signature." };
      }

      const region = roborockAuth.getRegionConfig(
        payload.baseURL || "usiot.roborock.com"
      );
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
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
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

    return { ok: true, message: "Logged out. Token cleared." };
  }

  private async listDevices(payload: {
    email?: string;
    baseURL?: string;
    encryptedToken?: string;
  }) {
    if (!payload.encryptedToken) {
      return { ok: false, message: "Log in first to load your devices." };
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
      const clientID = await this.getClientId();
      const devices = await roborockHome.fetchDevices({
        baseURL: payload.baseURL || "usiot.roborock.com",
        username: payload.email,
        clientID,
        userData,
      });
      // Only list devices this plugin can bridge (same rule as
      // platform.isSupportedDevice).
      const supported = (devices || []).filter(
        (device: { model?: unknown }) =>
          typeof device.model === "string" &&
          device.model.startsWith("roborock.vacuum.")
      );
      return { ok: true, devices: supported };
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
        return { ok: true, pairings: [] };
      }

      const pairings: unknown[] = [];
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

        for (const accessory of accessories) {
          const duid = accessory?.context?.duid;
          if (accessory?.plugin !== "homebridge-roborock-vacuum" || !duid) {
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
      }

      return { ok: true, pairings };
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

// IMPORTANT: Use Function constructor to create a dynamic import that TypeScript won't transform
//
// Background: @homebridge/plugin-ui-utils v2+ is a pure ES module that cannot be loaded with require()
// in Node.js 18+. Normally we would use `await import('@homebridge/plugin-ui-utils')`, but because
// this project uses TypeScript with "module": "commonjs" in tsconfig.json, TypeScript transforms
// dynamic imports into require() calls in the compiled output, which defeats the purpose.
//
// Solution: Using the Function constructor prevents TypeScript from transforming the import statement.
// The Function constructor is evaluated at runtime, so TypeScript cannot statically analyze or transform it.
// This is the recommended workaround for ES module/CommonJS interop when using TypeScript with CommonJS output.
//
// Security note: This is safe because the module specifier is a hardcoded string literal, not user input.
(async () => {
  const dynamicImport = new Function("specifier", "return import(specifier)");
  const { HomebridgePluginUiServer } = await dynamicImport(
    "@homebridge/plugin-ui-utils"
  );
  new RoborockUiServer(HomebridgePluginUiServer);
})();
