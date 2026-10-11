"use strict";

const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const net = require("net");
const dgram = require("dgram");

const PORT = 58866;
const TIMEOUT = 5000; // 5 Sekunden Timeout
const LOCAL_PORT = 58867;

const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

// Framing sanity bounds for the local TCP stream. A corrupt 4-byte length
// prefix (e.g. 0xFFFFFFFF) must not make the connector buffer data forever.
const MAX_SEGMENT_LENGTH = 8 * 1024 * 1024; // 8 MB per frame
const MAX_CHUNK_BUFFER = 16 * 1024 * 1024; // 16 MB total buffered
const RECONNECT_DELAY = 60000;
// Minimum spacing between cloud-side IP refreshes per device, so the
// reconnect loop cannot flood the cloud API when a device stays unreachable.
const IP_REFRESH_MIN_INTERVAL = 60000;
// How long the local protocol probe waits for an answer to its L01 HELLO.
const PROBE_TIMEOUT = 3000;
// PING spacing for L01 devices, which close a local connection after 60 s
// without traffic.
const KEEPALIVE_INTERVAL = 30000;

class EnhancedSocket extends net.Socket {
  constructor(options) {
    super(options);
    this.connected = false;
    this.chunkBuffer = Buffer.alloc(0);
    this.keepaliveTimer = null;

    this.on("connect", () => {
      this.connected = true;
    });

    this.on("close", () => {
      this.connected = false;
      this.stopKeepalive();
    });

    this.on("error", () => {
      this.connected = false;
    });

    this.on("end", () => {
      this.connected = false;
    });
  }

  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

// Local TCP frames are sent with a 4-byte big-endian length prefix.
function withLengthPrefix(message) {
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(message.length, 0);
  return Buffer.concat([lengthBuffer, message]);
}

// Random value in [10000, 32767], the range used for the L01 connect_nonce.
function randomNonce() {
  return 10000 + Math.floor(Math.random() * 22768);
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

    try {
      await this.detectLocalVersion(duid, ip);
    } catch (error) {
      this.adapter.log.debug(
        `Local protocol probe failed for ${duid}: ${error.message}`
      );
    }
    if (this.shuttingDown) {
      return;
    }

    const client = new EnhancedSocket();

    // Wrap the connect method in a promise to await its completion
    await new Promise((resolve, reject) => {
      client
        .connect(LOCAL_PORT, ip, async () => {
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
          this.startKeepalive(duid, client).catch((error) => {
            this.adapter.log.debug(
              `Keepalive setup failed for ${duid}: ${error.message}`
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
                      this.adapter.deviceNotify("LocalMessage", result, duid);
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
        this.localClients[duid].stopKeepalive();
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

  // Some firmwares report pv "1.0" in HomeData but only speak L01 on the LAN
  // and silently drop 1.0 frames. Probe over a throwaway connection: a device
  // that answers an L01 HELLO gets L01 for all its local traffic. 1.0 devices
  // don't answer, which costs them up to PROBE_TIMEOUT per connect. Only an
  // L01 answer is remembered, so a device that switches to L01 with a
  // firmware update is picked up on its next reconnect.
  async detectLocalVersion(duid, ip, port = LOCAL_PORT) {
    if (this.adapter.localVersions.has(duid)) {
      return;
    }
    if ((await this.adapter.getRobotVersion(duid)) != "1.0") {
      return;
    }

    const hello = await this.adapter.message.buildRoborockMessage(
      duid,
      0,
      Math.floor(Date.now() / 1000),
      Buffer.alloc(0),
      { version: "L01", seq: 1, random: randomNonce() }
    );

    const answersL01 = await new Promise((resolve) => {
      const probe = new net.Socket();
      const done = (result) => {
        clearTimeout(timer);
        probe.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => done(false), PROBE_TIMEOUT);
      probe.on("data", (data) => {
        done(data.length >= 7 && data.toString("latin1", 4, 7) == "L01");
      });
      probe.on("error", () => done(false));
      probe.on("close", () => done(false));
      probe.connect(port, ip, () => probe.write(withLengthPrefix(hello)));
    });

    if (answersL01) {
      this.adapter.localVersions.set(duid, "L01");
      this.adapter.log.info(
        `Robot ${duid} reports protocol 1.0 but answers L01 locally. Using L01 for the local connection.`
      );
    }
  }

  // A header-only PING (protocol 2, answered with protocol 3, which the data
  // handler ignores) every KEEPALIVE_INTERVAL keeps an L01 connection open.
  // 1.0 devices keep idle connections open and get no PING.
  async startKeepalive(duid, client) {
    if ((await this.adapter.getRobotVersion(duid, "local")) != "L01") {
      return;
    }
    // The connection may have closed while the version was looked up.
    if (!client.connected || client.keepaliveTimer) {
      return;
    }

    let pingSeq = 0x10000;
    client.keepaliveTimer = setInterval(async () => {
      try {
        const ping = await this.adapter.message.buildRoborockMessage(
          duid,
          2,
          Math.floor(Date.now() / 1000),
          Buffer.alloc(0),
          { seq: pingSeq++, random: randomNonce() }
        );
        if (ping && client.connected) {
          client.write(withLengthPrefix(ping));
        }
      } catch (error) {
        this.adapter.log.debug(
          `Keepalive ping failed for ${duid}: ${error.message}`
        );
      }
    }, KEEPALIVE_INTERVAL);
  }

  async ensureL01Handshake(duid) {
    const version = await this.adapter.getRobotVersion(duid, "local");
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
    const connectNonce = randomNonce();
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

    client.write(withLengthPrefix(handshakeMessage));

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
    // Only strip when pad is 1..16 and the last `pad` bytes all equal pad.
    if (pad > 0 && pad <= 16) {
      for (let i = 0; i < pad; i++) {
        if (buf[buf.length - 1 - i] !== pad) return buf; // malformed padding; treat as unpadded
      }
      return buf.slice(0, buf.length - pad);
    }
    return buf; // no standard PKCS#7 padding present
  }

  decryptECB(encrypted, aesKey) {
    // AES-128 requires a 16-byte key.
    const key = Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey);
    if (key.length !== 16) {
      return null;
    }

    const input = Buffer.isBuffer(encrypted)
      ? encrypted
      : Buffer.from(encrypted, "latin1"); // "binary" is an alias of latin1
    if (input.length === 0 || input.length % 16 !== 0) {
      // Ciphertext not a multiple of 16 bytes usually means a truncated
      // packet; return null so the caller ignores this broadcast.
      return null;
    }

    try {
      // Auto-padding is disabled because the padding is stripped manually
      // (safeRemovePkcs7 tolerates unpadded payloads).
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(false);

      const decryptedBuf = Buffer.concat([
        decipher.update(input),
        decipher.final(),
      ]);
      const unpadded = this.safeRemovePkcs7(decryptedBuf);

      return unpadded.toString("utf8");
    } catch (err) {
      // e.g. wrong final block length or a wrong key — a malformed LAN
      // broadcast must not crash discovery, so just drop the packet.
      return null;
    }
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
