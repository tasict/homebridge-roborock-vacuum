import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const KEY_FILENAME = 'roborock.token.key';

function loadOrCreateKey(storagePath: string): Buffer {
  const keyPath = path.join(storagePath, KEY_FILENAME);

  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === 32) {
      return existing;
    }
  } catch (error) {
    // Ignore and create a new key.
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export function encryptSession(session: Record<string, unknown>, storagePath: string): string {
  const key = loadOrCreateKey(storagePath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

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

export function decryptSession(encrypted: string, storagePath: string): Record<string, unknown> | null {
  if (!encrypted) {
    return null;
  }

  try {
    const key = loadOrCreateKey(storagePath);
    const raw = Buffer.from(encrypted, 'base64').toString('utf8');
    const payload = JSON.parse(raw) as { iv: string; tag: string; data: string };

    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const ciphertext = Buffer.from(payload.data, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as Record<string, unknown>;
  } catch (error) {
    return null;
  }
}
