"use strict";

const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const net = require("net");
const dgram = require("dgram");

const server = dgram.createSocket("udp4");
const PORT = 58866;
const TIMEOUT = 5000; // 5 Sekunden Timeout

const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

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
	}

	async createClient(duid, ip) {
		const client = new EnhancedSocket();

		// Wrap the connect method in a promise to await its completion
		await new Promise((resolve, reject) => {
			client
				.connect(58867, ip, async () => {
					this.adapter.log.debug(`tcp client for ${duid} connected`);
					this.ensureL01Handshake(duid).catch((error) => {
						this.adapter.log.debug(`L01 handshake on connect failed for ${duid}: ${error.message}`);
					});
					resolve();
				})
				.on("error", (error) => {
					this.adapter.log.debug(`error on tcp client for ${duid}. ${error.message}`);
					reject(error);
				});
		}).catch((error) => {
			const online = this.adapter.onlineChecker(duid);
			if (online) { // if the device is online, we can assume that the device is a remote device
				this.adapter.log.info(`error on tcp client for ${duid}. Marking this device as remote device. Connecting via MQTT instead ${error.message}`);
				this.adapter.remoteDevices.add(duid);
				// this.adapter.catchError(`Failed to create tcp client: ${error.stack}`, `function createClient`, duid);
			}
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

				let offset = 0;
				if (this.checkComplete(client.chunkBuffer)) {
					this.adapter.log.debug(`Chunk buffer data is complete. Processing...`);
					// this.adapter.log.debug(`chunkBuffer: ${client.chunkBuffer.toString("hex")}`);
					while (offset + 4 <= client.chunkBuffer.length) {
						const segmentLength = client.chunkBuffer.readUInt32BE(offset);
						const currentBuffer = client.chunkBuffer.subarray(offset + 4, offset + segmentLength + 4);
						// length of 17 does not contain any useful data.
						// It seems to be protocol handshake metadata.
						if (segmentLength != 17) {
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
										this.adapter.log.debug(`Local message with protocol 4 and id ${id} received. Result: ${JSON.stringify(result)}`);
										const { resolve, timeout } = this.adapter.pendingRequests.get(id);
										this.adapter.clearTimeout(timeout);
										this.adapter.pendingRequests.delete(id);
										resolve(result);

										if(this.adapter.deviceNotify !== undefined){
											this.adapter.deviceNotify("LocalMessage", result);
										}
									}
								}
							}
						}
						else {
							try {
								const shortMessage = shortMessageParser.parse(currentBuffer);
								if (shortMessage.version == "L01" && shortMessage.protocol == 1) {
									const currentNonces = this.adapter.localL01Nonces.get(duid) || {};
									this.adapter.localL01Nonces.set(duid, {
										connectNonce: currentNonces.connectNonce,
										ackNonce: shortMessage.random,
									});

									const waiter = this.l01HandshakeWaiters.get(duid);
									if (waiter) {
										this.adapter.clearTimeout(waiter.timeout);
										this.l01HandshakeWaiters.delete(duid);
										waiter.resolve(true);
									}
								}
							} catch (error) {
								this.adapter.log.debug(`Failed parsing short local message for ${duid}: ${error.message}`);
							}
						}
						offset += 4 + segmentLength;
					}
					this.clearChunkBuffer(duid);
				}
			} catch (error) {
				this.adapter.catchError(`Failed to create tcp client: ${error.stack}`, `function createClient`, duid);
			}
		});

		client.on("close", () => {
			this.adapter.log.debug(`tcp client for ${duid} disconnected, attempting to reconnect...`);
			const waiter = this.l01HandshakeWaiters.get(duid);
			if (waiter) {
				this.adapter.clearTimeout(waiter.timeout);
				this.l01HandshakeWaiters.delete(duid);
				waiter.reject(new Error(`TCP client closed during L01 handshake for ${duid}`));
			}
			this.adapter.localL01Nonces.delete(duid);
			setTimeout(async () => {
				await this.createClient(duid, ip);
			}, 60000);
			client.connected = false;
		});

		client.on("error", (error) => {
			this.adapter.log.debug(`error on tcp client for ${duid}. ${error.message}`);
		});

		this.localClients[duid] = client;
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
		if (existingNonces && typeof existingNonces.connectNonce == "number" && typeof existingNonces.ackNonce == "number") {
			return;
		}

		const timestamp = Math.floor(Date.now() / 1000);
		const handshakeMessage = await this.adapter.message.buildRoborockMessage(duid, 1, timestamp, Buffer.alloc(0));
		if (!handshakeMessage) {
			throw new Error(`Failed to build protocol 1 handshake message for ${duid}`);
		}

		const connectNonce = handshakeMessage.readUInt32BE(7);
		this.adapter.localL01Nonces.set(duid, {
			connectNonce,
			ackNonce: undefined,
		});

		if (this.l01HandshakeWaiters.has(duid)) {
			const waiter = this.l01HandshakeWaiters.get(duid);
			this.adapter.clearTimeout(waiter.timeout);
			this.l01HandshakeWaiters.delete(duid);
		}

		const handshakePromise = new Promise((resolve, reject) => {
			const timeout = this.adapter.setTimeout(() => {
				this.l01HandshakeWaiters.delete(duid);
				reject(new Error(`Timed out waiting for L01 handshake response for ${duid}`));
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

			server.on("message", (msg) => {
				const parsedMessage = localMessageParser.parse(msg);
				const decodedMessage = this.decryptECB(parsedMessage.payload, BROADCAST_TOKEN); // this might be decryptCBC for A01. Haven't checked this yet
				
				if(decodedMessage == null){
					this.adapter.log.debug(`getLocalDevices: decodedMessage is null`);
					return;
				}
				
				const parsedDecodedMessage = JSON.parse(decodedMessage);
				this.adapter.log.debug(`getLocalDevices parsedDecodedMessage: ${JSON.stringify(parsedDecodedMessage)}`);

				if (parsedDecodedMessage) {
					const localKey = this.adapter.localKeys.get(parsedDecodedMessage.duid);
					this.adapter.log.debug(`getLocalDevices localKey: ${localKey}`);

					if (localKey) {
						// if there's no localKey, decryption cannot work. For example when the found robot is not associated with a roborock account
						if (!devices[parsedDecodedMessage.duid]) {
							devices[parsedDecodedMessage.duid] = parsedDecodedMessage.ip;
						}
					}
				}
			});

			server.on("error", (error) => {
				this.adapter.catchError(`Discover server error: ${error.stack}`);
				server.close();
				reject(error);
			});

			server.bind(PORT);

			this.localDevicesTimeout = this.adapter.setTimeout(() => {
				server.close();

				resolve(devices);
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

	const input = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted, "latin1"); // "binary" 等同 latin1
	if (input.length === 0 || (input.length % 16) !== 0) {
		// 密文長度不是 16 的倍數，多半是封包不完整；丟回 null 讓上層忽略本次
		return null;
	}

	try {
		// --- 2) 固定用 Buffer，關閉自動 padding（你要自己移除） ---
		const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
		decipher.setAutoPadding(false);

		const decryptedBuf = Buffer.concat([decipher.update(input), decipher.final()]);
		const unpadded = safeRemovePkcs7(decryptedBuf);

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
