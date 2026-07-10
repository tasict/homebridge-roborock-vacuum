"use strict";

const crypto = require("crypto");
const CRC32 = require("crc-32");
const Parser = require("binary-parser").Parser;
const { getRsaKeys } = require("./rsaKeys");

let seq = 1;
let random = 4711; // Should be initialized with a number 0 - 1999?

// This value is stored hardcoded in librrcodec.so, encrypted by the value of "com.roborock.iotsdk.appsecret" from AndroidManifest.xml.
const salt = "TXdfu$jyZ#TZHsg4";
const b01Salt = "5wwh9ikChRjASpMU8cxg7o1d2E";

const messageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint32("random")
  .uint32("timestamp")
  .uint16("protocol")
  .uint16("payloadLen")
  .buffer("payload", {
    length: "payloadLen",
  })
  .uint32("crc32");

class message {
  constructor(adapter) {
    this.adapter = adapter;
    this.missingLocalKeyWarnings = new Set();
    // The photo RSA keypair is shared process-wide and generated lazily on
    // the first photo request — see lib/rsaKeys.js.
  }

  async buildPayload(
    duid,
    protocol,
    messageID,
    method,
    params,
    secure = false,
    photo = false
  ) {
    const timestamp = Math.floor(Date.now() / 1000);
    const endpoint = this.adapter.rr_mqtt_connector.getEndpoint();
    const version = await this.adapter.getRobotVersion(duid);
    // this.adapter.log.debug("sendRequest started with: " + requestId);

    if (photo) {
      const keys = await getRsaKeys();
      params.endpoint = endpoint;
      params.security = {
        cipher_suite: 0,
        pub_key: keys.public,
      };
    }

    const inner = {
      id: messageID,
      method: method,
      params: params,
    };
    if (secure) {
      if (!photo) {
        inner.security = {
          endpoint: endpoint,
          nonce: this.adapter.nonce.toString("hex").toUpperCase(),
        };
      }
    }

    let payload;
    if (version == "B01" || version == "\x81S\x19") {
      inner.msgId = String(messageID);

      if (method == "get_prop") {
        inner.method = "prop.get";
        inner.params = { property: params };
      }

      payload = JSON.stringify({
        dps: {
          10000: inner,
        },
        t: timestamp,
      });
    } else {
      payload = JSON.stringify({
        dps: {
          [protocol]: JSON.stringify(inner),
        },
        t: timestamp,
      });
    }

    return payload;
  }

  async buildRoborockMessage(duid, protocol, timestamp, payload, options = {}) {
    const version = await this.adapter.getRobotVersion(duid);

    let encrypted;

    const currentSeq = seq & 0xffffffff;
    const currentRandom = random & 0xffffffff;

    // Header-only frames (the L01 HELLO request, protocol 0) carry no encrypted
    // payload, so they have NO payloadLen field — just version(3) + seq(4) + random(4)
    // + timestamp(4) + protocol(2) + CRC32(4) = 21 bytes. (The previous build emitted a
    // 23-byte frame with a spurious payloadLen, which L01 robots silently drop, so the
    // handshake never completed.) Optional explicit seq/random let the HELLO pin seq=1
    // and a stable connect_nonce without disturbing the module-global counters used by
    // data messages.
    if (protocol == 0 || protocol == 1) {
      const headerSeq =
        (options.seq !== undefined ? options.seq : currentSeq) >>> 0;
      const headerRandom =
        (options.random !== undefined ? options.random : currentRandom) >>> 0;
      const msg = Buffer.alloc(21);
      msg.write(version);
      msg.writeUint32BE(headerSeq, 3);
      msg.writeUint32BE(headerRandom, 7);
      msg.writeUint32BE(timestamp, 11);
      msg.writeUint16BE(protocol, 15);
      const crc32 = CRC32.buf(msg.subarray(0, 17)) >>> 0;
      msg.writeUint32BE(crc32, 17);
      if (options.seq === undefined) {
        seq++;
        random++;
      }

      return msg;
    }

    if (version == "1.0") {
      const localKey =
        this.adapter.localKeys instanceof Map
          ? this.adapter.localKeys.get(duid)
          : null;
      const aesKey = this.md5bin(
        this._encodeTimestamp(timestamp) + localKey + salt
      );
      const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
      encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    } else if (version == "A01") {
      const localKey = this.adapter.localKeys.get(duid);

      const iv = this.md5hex(
        currentRandom.toString(16).padStart(8, "0") +
          "726f626f726f636b2d67a6d6da"
      ).substring(8, 24); // 726f626f726f636b2d67a6d6da can be found in librrcodec.so of version 4.0 of the roborock app
      const cipher = crypto.createCipheriv("aes-128-cbc", localKey, iv);
      encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    } else if (version == "L01") {
      const localKey = this.adapter.localKeys.get(duid);
      const { connectNonce, ackNonce } = this._getL01Nonces(duid);
      const aesKey = crypto
        .createHash("sha256")
        .update(this._encodeTimestamp(timestamp) + localKey + salt)
        .digest();
      const iv = this._deriveL01Iv(currentSeq, currentRandom, timestamp);
      const aad = this._deriveL01Aad(
        currentSeq,
        connectNonce,
        ackNonce,
        currentRandom,
        timestamp
      );
      const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
      cipher.setAAD(aad);
      const encryptedPayload = Buffer.concat([
        cipher.update(payload),
        cipher.final(),
      ]);
      encrypted = Buffer.concat([encryptedPayload, cipher.getAuthTag()]);
    } else if (version == "B01" || version == "\x81S\x19") {
      const localKey = this.adapter.localKeys.get(duid);
      const iv = this._deriveB01Iv(currentRandom);
      const cipher = crypto.createCipheriv("aes-128-cbc", localKey, iv);
      encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    }

    if (encrypted) {
      const msg = Buffer.alloc(23 + encrypted.length);
      msg.write(version);
      msg.writeUint32BE(currentSeq, 3);
      msg.writeUint32BE(currentRandom, 7);
      msg.writeUint32BE(timestamp, 11);
      msg.writeUint16BE(protocol, 15);
      msg.writeUint16BE(encrypted.length, 17);
      encrypted.copy(msg, 19);
      const crc32 = CRC32.buf(msg.subarray(0, msg.length - 4)) >>> 0;
      msg.writeUint32BE(crc32, msg.length - 4);
      seq++;
      random++;

      return msg;
    }

    return false;
  }

  _decodeMsg(message, duid) {
    try {
      // Do some checks before trying to decode the message.
      const version = message.toString("latin1", 0, 3);

      if (
        version !== "1.0" &&
        version !== "A01" &&
        version !== "L01" &&
        version !== "B01" &&
        version !== "\x81S\x19"
      ) {
        throw new Error(`Unknown protocol version ${version}`);
      }
      const crc32 = CRC32.buf(message.subarray(0, message.length - 4)) >>> 0;
      const expectedCrc32 = message.readUint32BE(message.length - 4);
      if (crc32 != expectedCrc32) {
        throw new Error(`Wrong CRC32 ${crc32}, expected ${expectedCrc32}`);
      }

      const data = this.getParsedData(message);
      delete data.payloadLen;

      const localKey = this.adapter.localKeys.get(duid);
      if (!localKey) {
        if (!this.missingLocalKeyWarnings.has(duid)) {
          this.missingLocalKeyWarnings.add(duid);
          this.adapter.log.warn(
            `Skipping MQTT message for device ${duid}: no localKey available.`
          );
        }

        const error = new Error(`No localKey found for device ${duid}`);
        error.code = "ERR_MISSING_LOCAL_KEY";
        throw error;
      }

      if (version == "1.0") {
        const aesKey = this.md5bin(
          this._encodeTimestamp(data.timestamp) + localKey + salt
        );
        const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
        data.payload = Buffer.concat([
          decipher.update(data.payload),
          decipher.final(),
        ]);
      } else if (version == "A01") {
        const iv = this.md5hex(
          data.random.toString(16).padStart(8, "0") +
            "726f626f726f636b2d67a6d6da"
        ).substring(8, 24);
        const decipher = crypto.createDecipheriv("aes-128-cbc", localKey, iv);
        data.payload = Buffer.concat([
          decipher.update(data.payload),
          decipher.final(),
        ]);
      } else if (version == "L01") {
        const { connectNonce, ackNonce } = this._getL01Nonces(duid);
        const aesKey = crypto
          .createHash("sha256")
          .update(this._encodeTimestamp(data.timestamp) + localKey + salt)
          .digest();
        const iv = this._deriveL01Iv(data.seq, data.random, data.timestamp);
        const aad = this._deriveL01Aad(
          data.seq,
          connectNonce,
          ackNonce,
          data.random,
          data.timestamp
        );
        const authTag = data.payload.subarray(data.payload.length - 16);
        const encryptedPayload = data.payload.subarray(
          0,
          data.payload.length - 16
        );
        const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        data.payload = Buffer.concat([
          decipher.update(encryptedPayload),
          decipher.final(),
        ]);
      } else if (version == "B01" || version == "\x81S\x19") {
        const iv = this._deriveB01Iv(data.random);
        const decipher = crypto.createDecipheriv("aes-128-cbc", localKey, iv);
        data.payload = Buffer.concat([
          decipher.update(data.payload),
          decipher.final(),
        ]);
      }

      return data;
    } catch (error) {
      if (error && error.code === "ERR_MISSING_LOCAL_KEY") {
        return null;
      }

      const preview = message
        .subarray(0, Math.min(message.length, 12))
        .toString("hex");
      const reason = error && error.message ? error.message : String(error);
      this.adapter.log.error(
        `failed to _decodeMsg for ${duid}: ${reason} (len=${message.length}, preview=${preview})`
      );
      // this.adapter.catchError(error, "_decodeMessage", "none");
      return null;
    }
  }

  getParsedData(data) {
    return messageParser.parse(data);
  }

  resolve102Message(messageID, message, secure = false) {
    return new Promise((resolve, reject) => {
      if (message?.code) {
        reject(
          new Error(
            `There was an error processing the request with id ${messageID} error: ${JSON.stringify(message)}`
          )
        );
      } else {
        if (secure) {
          if (message[0] !== "ok") {
            reject(message);
          }
        } else {
          resolve(message);
        }
      }
    });
  }

  resolve301Message(messageID, message) {
    return new Promise((resolve, reject) => {
      this.adapter.clearTimeout(
        this.adapter.messageQueue.get(messageID)?.timeout301
      );
      (this.adapter.messageQueue.get(messageID) || {}).timeout301 = null;
      this.adapter.checkAndClearRequest(messageID);

      if (message?.code) {
        reject(
          new Error(
            `There was an error processing the request with id ${messageID} error: ${JSON.stringify(message)}`
          )
        );
      } else {
        resolve(message);
      }
    });
  }

  _encodeTimestamp(timestamp) {
    const hex = timestamp.toString(16).padStart(8, "0").split("");
    return [5, 6, 3, 7, 1, 2, 0, 4].map((idx) => hex[idx]).join("");
  }

  md5bin(str) {
    return crypto.createHash("md5").update(str).digest();
  }

  md5hex(str) {
    return crypto.createHash("md5").update(str).digest("hex");
  }

  _deriveB01Iv(randomSeed) {
    const randomBuffer = Buffer.alloc(4);
    randomBuffer.writeUInt32BE(randomSeed >>> 0, 0);

    const randomHex = randomBuffer.toString("hex").toLowerCase();
    const hash = this.md5hex(randomHex + b01Salt);
    const iv = hash.substring(9, 25);

    return Buffer.from(iv, "utf8");
  }

  _deriveL01Iv(sequence, randomSeed, timestamp) {
    const digestInput = Buffer.alloc(12);
    digestInput.writeUInt32BE(sequence >>> 0, 0);
    digestInput.writeUInt32BE(randomSeed >>> 0, 4);
    digestInput.writeUInt32BE(timestamp >>> 0, 8);
    return crypto
      .createHash("sha256")
      .update(digestInput)
      .digest()
      .subarray(0, 12);
  }

  _deriveL01Aad(sequence, connectNonce, ackNonce, randomSeed, timestamp) {
    const aad = Buffer.alloc(20);
    aad.writeUInt32BE(sequence >>> 0, 0);
    aad.writeUInt32BE(connectNonce >>> 0, 4);
    aad.writeUInt32BE(ackNonce >>> 0, 8);
    aad.writeUInt32BE(randomSeed >>> 0, 12);
    aad.writeUInt32BE(timestamp >>> 0, 16);
    return aad;
  }

  _getL01Nonces(duid) {
    const nonces =
      this.adapter.localL01Nonces && this.adapter.localL01Nonces.get(duid);
    if (
      !nonces ||
      typeof nonces.connectNonce !== "number" ||
      typeof nonces.ackNonce !== "number"
    ) {
      throw new Error(`Missing L01 nonces for device ${duid}`);
    }

    return nonces;
  }
}

module.exports = {
  message,
};
