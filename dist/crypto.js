"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptSession = encryptSession;
exports.decryptSession = decryptSession;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const KEY_FILENAME = 'roborock.token.key';
function loadOrCreateKey(storagePath) {
    const keyPath = path_1.default.join(storagePath, KEY_FILENAME);
    try {
        const existing = fs_1.default.readFileSync(keyPath);
        if (existing.length === 32) {
            return existing;
        }
    }
    catch (error) {
        // Ignore and create a new key.
    }
    const key = crypto_1.default.randomBytes(32);
    fs_1.default.mkdirSync(storagePath, { recursive: true });
    fs_1.default.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
}
function encryptSession(session, storagePath) {
    const key = loadOrCreateKey(storagePath);
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: ciphertext.toString('base64'),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
function decryptSession(encrypted, storagePath) {
    if (!encrypted) {
        return null;
    }
    try {
        const key = loadOrCreateKey(storagePath);
        const raw = Buffer.from(encrypted, 'base64').toString('utf8');
        const payload = JSON.parse(raw);
        const iv = Buffer.from(payload.iv, 'base64');
        const tag = Buffer.from(payload.tag, 'base64');
        const ciphertext = Buffer.from(payload.data, 'base64');
        const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return JSON.parse(plaintext);
    }
    catch (error) {
        return null;
    }
}
//# sourceMappingURL=crypto.js.map