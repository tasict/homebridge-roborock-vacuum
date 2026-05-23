"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const module_1 = require("module");
const url_1 = require("url");
const crypto_2 = require("../crypto");
const localRequire = (0, module_1.createRequire)(__filename);
function addHomebridgeModulePath() {
    const homebridgeNodeModules = path_1.default.join(process.cwd(), "node_modules");
    const nodePathEntries = process.env.NODE_PATH
        ? process.env.NODE_PATH.split(path_1.default.delimiter)
        : [];
    if (!nodePathEntries.includes(homebridgeNodeModules)) {
        process.env.NODE_PATH = [homebridgeNodeModules, ...nodePathEntries]
            .filter(Boolean)
            .join(path_1.default.delimiter);
        module_1._initPaths();
    }
}
function resolveInstalledModule(specifier) {
    return localRequire.resolve(specifier, {
        paths: [process.cwd(), path_1.default.join(process.cwd(), "node_modules")],
    });
}
addHomebridgeModulePath();
const roborockAuth = localRequire("../../roborockLib/lib/roborockAuth");
class RoborockUiServer {
    constructor(HomebridgePluginUiServer) {
        this.homebridgePluginUiServer = new HomebridgePluginUiServer();
        this.homebridgeStoragePath =
            this.homebridgePluginUiServer.homebridgeStoragePath;
        this.homebridgePluginUiServer.onRequest("/auth/send-2fa-email", this.sendTwoFactorEmail.bind(this));
        this.homebridgePluginUiServer.onRequest("/auth/verify-2fa-code", this.verifyTwoFactorCode.bind(this));
        this.homebridgePluginUiServer.onRequest("/auth/login", this.loginWithPassword.bind(this));
        this.homebridgePluginUiServer.onRequest("/auth/logout", this.logout.bind(this));
        this.homebridgePluginUiServer.ready();
    }
    getStoragePath() {
        return this.homebridgeStoragePath || process.cwd();
    }
    async getClientId() {
        const storagePath = this.getStoragePath();
        if (storagePath) {
            const clientIdPath = path_1.default.join(storagePath, "roborock.clientID");
            try {
                const stored = JSON.parse(fs_1.default.readFileSync(clientIdPath, "utf8"));
                if (stored && stored.val) {
                    return stored.val;
                }
            }
            catch (error) {
                // Ignore and generate a new client ID.
            }
            const clientId = crypto_1.default.randomUUID();
            fs_1.default.mkdirSync(storagePath, { recursive: true });
            fs_1.default.writeFileSync(clientIdPath, JSON.stringify({ val: clientId, ack: true }, null, 2), "utf8");
            return clientId;
        }
        return crypto_1.default.randomUUID();
    }
    async buildLoginApi(config) {
        const clientID = await this.getClientId();
        return roborockAuth.createLoginApi({
            baseURL: config.baseURL || "usiot.roborock.com",
            username: config.email,
            clientID,
            language: "en",
        });
    }
    async sendTwoFactorEmail(payload) {
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
        }
        catch (error) {
            console.error("2FA email request failed:", (error === null || error === void 0 ? void 0 : error.message) || error);
            return {
                ok: false,
                message: (error === null || error === void 0 ? void 0 : error.message) || "Failed to send verification email.",
            };
        }
    }
    async verifyTwoFactorCode(payload) {
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
            const region = roborockAuth.getRegionConfig(payload.baseURL || "usiot.roborock.com");
            loginResult = await roborockAuth.loginWithCode(loginApi, {
                email,
                code: payload.code,
                country: region.country,
                countryCode: region.countryCode,
                k: signData.k,
                s: nonce,
            });
        }
        catch (error) {
            console.error("2FA verification request failed:", (error === null || error === void 0 ? void 0 : error.message) || error);
            return { ok: false, message: (error === null || error === void 0 ? void 0 : error.message) || "Verification failed." };
        }
        if (loginResult && loginResult.code === 200 && loginResult.data) {
            const encrypted = (0, crypto_2.encryptSession)(loginResult.data, this.getStoragePath());
            return {
                ok: true,
                message: "Login completed and token saved.",
                encryptedToken: encrypted,
            };
        }
        console.error("2FA verification failed:", loginResult);
        return { ok: false, message: (loginResult === null || loginResult === void 0 ? void 0 : loginResult.msg) || "Verification failed." };
    }
    async loginWithPassword(payload) {
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
        }
        catch (error) {
            console.error("Login request failed:", (error === null || error === void 0 ? void 0 : error.message) || error);
            return { ok: false, message: (error === null || error === void 0 ? void 0 : error.message) || "Login failed." };
        }
        if (loginResult && loginResult.code === 200 && loginResult.data) {
            const encrypted = (0, crypto_2.encryptSession)(loginResult.data, this.getStoragePath());
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
            message: (loginResult === null || loginResult === void 0 ? void 0 : loginResult.msg) || "Login failed. Check your credentials.",
        };
    }
    async logout() {
        const storagePath = this.getStoragePath();
        if (!storagePath) {
            return { ok: true, message: "Logged out. Token cleared." };
        }
        const userDataPath = path_1.default.join(storagePath, "roborock.UserData");
        try {
            if (fs_1.default.existsSync(userDataPath)) {
                fs_1.default.unlinkSync(userDataPath);
            }
        }
        catch (error) {
            // Ignore file removal errors.
        }
        return { ok: true, message: "Logged out. Token cleared." };
    }
    buildNonce() {
        return crypto_1.default
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
    const pluginUiUtilsPath = resolveInstalledModule("@homebridge/plugin-ui-utils");
    const { HomebridgePluginUiServer } = await dynamicImport((0, url_1.pathToFileURL)(pluginUiUtilsPath).href);
    new RoborockUiServer(HomebridgePluginUiServer);
})();
//# sourceMappingURL=index.js.map
