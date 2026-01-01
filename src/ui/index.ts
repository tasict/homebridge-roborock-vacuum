import crypto from "crypto";
import path from "path";
import fs from "fs";
import { encryptSession } from "../crypto";

const roborockAuth = require("../../roborockLib/lib/roborockAuth");

// Type definition for HomebridgePluginUiServer to maintain type safety
interface IHomebridgePluginUiServer {
  homebridgeStoragePath?: string;
  onRequest(path: string, handler: (payload: any) => Promise<any>): void;
  ready(): void;
}

type HomebridgePluginUiServerConstructor = new () => IHomebridgePluginUiServer;

class RoborockUiServer {
  private homebridgePluginUiServer: IHomebridgePluginUiServer;
  private homebridgeStoragePath?: string;

  constructor(HomebridgePluginUiServer: HomebridgePluginUiServerConstructor) {
    this.homebridgePluginUiServer = new HomebridgePluginUiServer();
    this.homebridgeStoragePath =
      this.homebridgePluginUiServer.homebridgeStoragePath;

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

  private buildNonce(): string {
    return crypto
      .randomBytes(12)
      .toString("base64")
      .substring(0, 16)
      .replace(/\+/g, "X")
      .replace(/\//g, "Y");
  }
}

// Use Function constructor to create a dynamic import that TypeScript won't transform to require()
// This is necessary because @homebridge/plugin-ui-utils is an ES module and cannot be required() in Node.js 18+
(async () => {
  const dynamicImport = new Function("specifier", "return import(specifier)");
  const { HomebridgePluginUiServer } = await dynamicImport(
    "@homebridge/plugin-ui-utils"
  );
  new RoborockUiServer(HomebridgePluginUiServer);
})();
