"use strict";

const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const net = require("net");
const dgram = require("dgram");

const PORT = 58866;
const TIMEOUT = 5000; // 5 Sekunden Timeout

const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

// Framing sanity bounds for the local TCP stream. A corrupt 4-byte length
// prefix (e.g. 0xFFFFFFFF) must not make the connector buffer data forever.
const MAX_SEGMENT_LENGTH = 8 * 1024 * 1024; // 8 MB per frame
const MAX_CHUNK_BUFFER = 16 * 1024 * 1024; // 16 MB total buffered
const RECONNECT_DELAY = 60000;
// Minimum spacing between cloud-side IP refreshes per device, so the
// reconnect loop cannot flood the cloud API when a device stays unreachable.
const IP_REFRESH_MIN_INTERVAL = 60000;

class EnhancedSocket extends net.Socket {
  constructor(options) {
    super(options);
    this.connected = false;
    this.chunkBuffer = Buffer.alloc(0);

    this.on("connect", () => {
      this.connected = true;
    });

    this.on("close", () => {
      this.connected = false;
    });

    this.on("error", () => {
      this.connected = false;
    });

    this.on("end", () => {
      this.connected = false;
    });
  }
}

const localMessageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint16("protocol")
  .uint16("payloadLen")
  .buffer("payload", {
    length: "payloadLen",
  })
  .uint32("crc32");

const shortMessageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint32("random")
  .uint32("timestamp")
  .uint16("protocol");

class localConnector {
  constructor(adapter) {
    this.adapter = adapter;

    this.localClients = {};
    this.l01HandshakeWaiters = new Map();
    this.reconnectTimeouts = new Map();
    this.lastIpRefresh = new Map();
    this.shuttingDown = false;
  }

  async createClient(duid, ip) {
    if (this.shuttingDown) {
      return;
    }

    const client = new EnhancedSocket();

    // Wrap the connect method in a promise to await its completion
    await new Promise((resolve, reject) => {
      client
        .connect(58867, ip, async () => {
          this.adapter.log.debug(`tcp client for ${duid} connected`);
          // A device that was demoted to the cloud path after a failed TCP
          // connect is reachable again — promote it back to local mode.
          if (this.adapter.remoteDevices.delete(duid)) {
            this.adapter.log.info(
              `Local connection for ${duid} restored. Switching back from cloud to local mode.`
            );
          }
          this.ensureL01Handshake(duid).catch((error) => {
            this.adapter.log.debug(
              `L01 handshake on connect failed for ${duid}: ${error.message}`
            );
          });
          resolve();
        })
        .on("error", (error) => {
          this.adapter.log.debug(
            `error on tcp client for ${duid}. ${error.message}`
          );
          reject(error);
        });
    }).catch(async (error) => {
      const online = await this.adapter.onlineChecker(duid);
      if (online) {
        // if the device is online, we can assume that the device is a remote device
        this.adapter.log.info(
          `error on tcp client for ${duid}. Marking this device as remote device. Connecting via MQTT instead ${error.message}`
        );
        this.adapter.remoteDevices.add(duid);
        // this.adapter.catchError(`Failed to create tcp client: ${error.stack}`, `function createClient`, duid);
      }
      // Keep probing in the background (with a cloud-side IP refresh) so a
      // device that becomes reachable — or got a new DHCP address — is
      // promoted back to local mode instead of staying cloud-only forever.
      this.scheduleReconnect(duid, ip);
    });

    client.on("data", async (message) => {
      try {
        if (client.chunkBuffer.length == 0) {
          this.adapter.log.debug(`new chunk started`);
          client.chunkBuffer = message;
        } else {
          this.adapter.log.debug(`new chunk received`);
          client.chunkBuffer = Buffer.concat([client.chunkBuffer, message]);
        }
        // this.adapter.log.debug(`new chunk received: ${message.toString("hex")}`);

        // Corrupt framing protection: a bogus length prefix would make
        // checkComplete() wait forever while the buffer grows without bound.
        // Drop the buffer and reset the connection instead.
        if (!this.hasSaneFraming(client.chunkBuffer)) {
          this.adapter.log.warn(
            `Corrupt local frame from ${duid} (buffered ${client.chunkBuffer.length} bytes). Resetting connection.`
          );
          client.chunkBuffer = Buffer.alloc(0);
          client.destroy(); // "close" handler schedules the reconnect
          return;
        }

        let offset = 0;
        if (this.checkComplete(client.chunkBuffer)) {
          this.adapter.log.debug(
            `Chunk buffer data is complete. Processing...`
          );
          // this.adapter.log.debug(`chunkBuffer: ${client.chunkBuffer.toString("hex")}`);
          while (offset + 4 <= client.chunkBuffer.length) {
            const segmentLength = client.chunkBuffer.readUInt32BE(offset);
            const currentBuffer = client.chunkBuffer.subarray(
              offset + 4,
              offset + segmentLength + 4
            );
            // Short, header-only handshake frames carry no encrypted payload:
            // the L01 HELLO_RESPONSE is 21 bytes (version+seq+random+timestamp+
            // protocol+CRC32); a bare 17-byte header may also appear. Route both
            // to the shortMessage handler below; anything larger is a data
            // message with an encrypted payload.
            if (segmentLength != 17 && segmentLength != 21) {
              const data = this.adapter.message._decodeMsg(currentBuffer, duid);
              if (!data) {
                offset += 4 + segmentLength;
                continue;
              }

              if (data.protocol == 4) {
                const dps = JSON.parse(data.payload).dps;

                if (dps) {
                  const _102 = JSON.stringify(dps["102"]);
                  const parsed_102 = JSON.parse(JSON.parse(_102));
                  const id = parsed_102.id;
                  const result = parsed_102.result;

                  if (this.adapter.pendingRequests.has(id)) {
                    this.adapter.log.debug(
                      `Local message with protocol 4 and id ${id} received. Result: ${JSON.stringify(result)}`
                    );
                    const { resolve, timeout } =
                      this.adapter.pendingRequests.get(id);
                    this.adapter.clearTimeout(timeout);
                    this.adapter.pendingRequests.delete(id);
                    resolve(result);

                    if (this.adapter.deviceNotify !== undefined) {
                      this.adapter.deviceNotify("LocalMessage", result);
                    }
                  }
                }
              }
            } else {
              try {
                const shortMessage = shortMessageParser.parse(currentBuffer);
                // HELLO_RESPONSE (protocol 1) echoing our seq=1 HELLO; its
                // random field is the ack_nonce.
                if (
                  shortMessage.version == "L01" &&
                  shortMessage.protocol == 1 &&
                  shortMessage.seq == 1
                ) {
                  const currentNonces =
                    this.adapter.localL01Nonces.get(duid) || {};
                  this.adapter.localL01Nonces.set(duid, {
                    connectNonce: currentNonces.connectNonce,
                    ackNonce: shortMessage.random,
                  });

                  const waiter = this.l01HandshakeWaiters.get(duid);
                  if (waiter) {
                    this.adapter.clearTimeout(waiter.timeout);
                    this.l01HandshakeWaiters.delete(duid);
                    this.adapter.log.debug(
                      `L01 handshake complete for ${duid}: ackNonce=${shortMessage.random}`
                    );
                    waiter.resolve(true);
                  }
                }
              } catch (error) {
                this.adapter.log.debug(
                  `Failed parsing short local message for ${duid}: ${error.message}`
                );
              }
            }
            offset += 4 + segmentLength;
          }
          this.clearChunkBuffer(duid);
        }
      } catch (error) {
        this.adapter.catchError(
          `Failed to create tcp client: ${error.stack}`,
          `function createClient`,
          duid
        );
      }
    });

    client.on("close", () => {
      this.adapter.log.debug(
        `tcp client for ${duid} disconnected, attempting to reconnect...`
      );
      const waiter = this.l01HandshakeWaiters.get(duid);
      if (waiter) {
        this.adapter.clearTimeout(waiter.timeout);
        this.l01HandshakeWaiters.delete(duid);
        waiter.reject(
          new Error(`TCP client closed during L01 handshake for ${duid}`)
        );
      }
      this.adapter.localL01Nonces.delete(duid);
      this.scheduleReconnect(duid, ip);
      client.connected = false;
    });

    client.on("error", (error) => {
      this.adapter.log.debug(
        `error on tcp client for ${duid}. ${error.message}`
      );
    });

    this.localClients[duid] = client;
  }

  // One tracked, cancellable reconnect timer per device. Cleared by
  // shutdown() so a stopped service does not keep reconnecting forever.
  scheduleReconnect(duid, ip) {
    if (this.shuttingDown) {
      return;
    }

    const existing = this.reconnectTimeouts.get(duid);
    if (existing) {
      clearTimeout(existing);
    }

    this.reconnectTimeouts.set(
      duid,
      setTimeout(async () => {
        this.reconnectTimeouts.delete(duid);
        // The IP captured at startup goes stale when DHCP hands the device a
        // new address; re-query it over the cloud before dialing.
        const refreshedIp = await this.refreshLocalIp(duid);
        await this.createClient(duid, refreshedIp || ip);
      }, RECONNECT_DELAY)
    );
  }

  // Re-query the device's current local IP over the cloud channel
  // (get_network_info updates adapter.localDevices). Rate-limited per device;
  // returns the freshest known IP or undefined when none is available.
  async refreshLocalIp(duid) {
    const now = Date.now();
    const lastRefresh = this.lastIpRefresh.get(duid) || 0;
    if (now - lastRefresh >= IP_REFRESH_MIN_INTERVAL) {
      this.lastIpRefresh.set(duid, now);
      try {
        if (
          this.adapter.hasInitializedVacuum &&
          this.adapter.hasInitializedVacuum(duid)
        ) {
          await this.adapter.vacuums[duid].getParameter(
            duid,
            "get_network_info"
          );
        }
      } catch (error) {
        this.adapter.log.debug(
          `Cloud IP refresh failed for ${duid}: ${error && error.message}`
        );
      }
    }

    return this.adapter.localDevices[duid];
  }

  shutdown() {
    this.shuttingDown = true;

    for (const timeout of this.reconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimeouts.clear();

    this.clearLocalDevicedTimeout();

    for (const duid in this.localClients) {
      try {
        this.localClients[duid].destroy();
      } catch (error) {
        /* ignore */
      }
    }
  }

  // Whether every visible length prefix is plausible and the total buffered
  // data stays under the hard cap.
  hasSaneFraming(buffer) {
    if (buffer.length > MAX_CHUNK_BUFFER) {
      return false;
    }

    let offset = 0;
    while (offset + 4 <= buffer.length) {
      const segmentLength = buffer.readUInt32BE(offset);
      if (segmentLength > MAX_SEGMENT_LENGTH) {
        return false;
      }
      offset += 4 + segmentLength;
    }

    return true;
  }

  checkComplete(buffer) {
    let totalLength = 0;
    let offset = 0;

    while (offset + 4 <= buffer.length) {
      const segmentLength = buffer.readUInt32BE(offset);
      totalLength += 4 + segmentLength;
      offset += 4 + segmentLength;

      if (offset > buffer.length) {
        return false; // Data is not complete yet
      }
    }

    return totalLength <= buffer.length;
  }

  clearChunkBuffer(duid) {
    if (this.localClients[duid]) {
      this.localClients[duid].chunkBuffer = Buffer.alloc(0);
    }
  }

  sendMessage(duid, message) {
    const client = this.localClients[duid];
    if (client) {
      client.write(message);
    }
  }

  isConnected(duid) {
    if (this.localClients[duid]) {
      return this.localClients[duid].connected;
    }
  }

  async ensureL01Handshake(duid) {
    const version = await this.adapter.getRobotVersion(duid);
    if (version != "L01") {
      return;
    }

    const client = this.localClients[duid];
    if (!client || !client.connected) {
      return;
    }

    const existingNonces = this.adapter.localL01Nonces.get(duid);
    if (
      existingNonces &&
      typeof existingNonces.connectNonce == "number" &&
      typeof existingNonces.ackNonce == "number"
    ) {
      return;
    }

    // HELLO request: protocol 0 (HELLO_REQUEST), 21-byte header+CRC frame, seq=1, a
    // real timestamp, and random=connect_nonce. The robot replies with a protocol-1
    // (HELLO_RESPONSE) frame whose random field is the ack_nonce. Pick a stable
    // connect_nonce in [10000, 32767] and store it BEFORE sending, so the follow-up
    // L01 data-message AAD reuses the exact value the robot saw in the HELLO.
    const timestamp = Math.floor(Date.now() / 1000);
    const connectNonce = 10000 + Math.floor(Math.random() * 22768);
    this.adapter.localL01Nonces.set(duid, {
      connectNonce,
      ackNonce: undefined,
    });

    const handshakeMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      0,
      timestamp,
      Buffer.alloc(0),
      { seq: 1, random: connectNonce }
    );
    if (!handshakeMessage) {
      throw new Error(`Failed to build HELLO handshake message for ${duid}`);
    }

    if (this.l01HandshakeWaiters.has(duid)) {
      const waiter = this.l01HandshakeWaiters.get(duid);
      this.adapter.clearTimeout(waiter.timeout);
      this.l01HandshakeWaiters.delete(duid);
    }

    const handshakePromise = new Promise((resolve, reject) => {
      const timeout = this.adapter.setTimeout(() => {
        this.l01HandshakeWaiters.delete(duid);
        reject(
          new Error(`Timed out waiting for L01 handshake response for ${duid}`)
        );
      }, 3000);

      this.l01HandshakeWaiters.set(duid, { resolve, reject, timeout });
    });

    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(handshakeMessage.length, 0);
    const fullMessage = Buffer.concat([lengthBuffer, handshakeMessage]);
    client.write(fullMessage);

    await handshakePromise;
  }

  async getLocalDevices() {
    return new Promise((resolve, reject) => {
      const devices = {};
      // Socket per discovery run. The previous module-global socket could
      // neither be re-bound after close nor avoid stacking listeners.
      const server = dgram.createSocket("udp4");
      let settled = false;

      const closeServer = () => {
        try {
          server.close();
        } catch (error) {
          /* already closed */
        }
      };

      server.on("message", (msg) => {
        try {
          const parsedMessage = localMessageParser.parse(msg);
          const decodedMessage = this.decryptECB(
            parsedMessage.payload,
            BROADCAST_TOKEN
          ); // this might be decryptCBC for A01. Haven't checked this yet

          if (decodedMessage == null) {
            this.adapter.log.debug(`getLocalDevices: decodedMessage is null`);
            return;
          }

          const parsedDecodedMessage = JSON.parse(decodedMessage);
          this.adapter.log.debug(
            `getLocalDevices parsedDecodedMessage: ${JSON.stringify(parsedDecodedMessage)}`
          );

          if (parsedDecodedMessage) {
            const localKey = this.adapter.localKeys.get(
              parsedDecodedMessage.duid
            );
            this.adapter.log.debug(`getLocalDevices localKey: ${localKey}`);

            if (localKey) {
              // if there's no localKey, decryption cannot work. For example when the found robot is not associated with a roborock account
              if (!devices[parsedDecodedMessage.duid]) {
                devices[parsedDecodedMessage.duid] = parsedDecodedMessage.ip;
              }
            }
          }
        } catch (error) {
          // A malformed broadcast (any LAN peer can send one) must not
          // break discovery of well-formed responses.
          this.adapter.log.debug(
            `getLocalDevices: ignoring malformed broadcast: ${error.message}`
          );
        }
      });

      server.on("error", (error) => {
        // Port 58866 may already be taken by another Roborock integration on
        // the same host. Discovery is best-effort (get_network_info provides
        // IPs too), so a bind failure must not abort device creation.
        this.adapter.log.warn(
          `UDP discovery unavailable (${error.message}). Continuing without it; local IPs will come from the cloud instead.`
        );
        closeServer();
        if (this.localDevicesTimeout) {
          this.adapter.clearTimeout(this.localDevicesTimeout);
        }
        if (!settled) {
          settled = true;
          resolve(devices);
        }
      });

      server.bind(PORT);

      this.localDevicesTimeout = this.adapter.setTimeout(() => {
        closeServer();

        if (!settled) {
          settled = true;
          resolve(devices);
        }
      }, TIMEOUT);
    });
  }

  safeRemovePkcs7(buf) {
    if (!buf || buf.length === 0) return Buffer.alloc(0);
    const pad = buf[buf.length - 1];
    // 僅在 1..16 且最後 pad 個 byte 都等於 pad 時才移除
    if (pad > 0 && pad <= 16) {
      for (let i = 0; i < pad; i++) {
        if (buf[buf.length - 1 - i] !== pad) return buf; // padding 形狀不對，視為無 padding
      }
      return buf.slice(0, buf.length - pad);
    }
    return buf; // 看起來沒有標準 PKCS#7 padding
  }

  decryptECB(encrypted, aesKey) {
    // --- 1) Key/輸入檢查 ---
    const key = Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey);
    if (key.length !== 16) {
      // AES-128 需要 16 bytes 的 key
      return null;
    }

    const input = Buffer.isBuffer(encrypted)
      ? encrypted
      : Buffer.from(encrypted, "latin1"); // "binary" 等同 latin1
    if (input.length === 0 || input.length % 16 !== 0) {
      // 密文長度不是 16 的倍數，多半是封包不完整；丟回 null 讓上層忽略本次
      return null;
    }

    try {
      // --- 2) 固定用 Buffer，關閉自動 padding（你要自己移除） ---
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(false);

      const decryptedBuf = Buffer.concat([
        decipher.update(input),
        decipher.final(),
      ]);
      const unpadded = this.safeRemovePkcs7(decryptedBuf);

      // 若原協定內容是 UTF-8，這裡再轉字串；否則直接回傳 Buffer 讓上層處理
      return unpadded.toString("utf8");
    } catch (err) {
      // 例如 wrong final block length、key 不對等情況
      // 這裡不要讓程式炸掉，直接忽略這個封包
      // 你也可以在這裡做一次 debug log
      // console.debug("decryptECB error:", err);
      return null;
    }
  }

  removePadding(str) {
    const paddingLength = str.charCodeAt(str.length - 1);
    return str.slice(0, -paddingLength);
  }

  clearLocalDevicedTimeout() {
    if (this.localDevicesTimeout) {
      this.adapter.clearTimeout(this.localDevicesTimeout);
    }
  }
}

module.exports = {
  localConnector,
};
