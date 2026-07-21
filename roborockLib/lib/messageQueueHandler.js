"use strict";

const requestTimeout = 10000; // 10s

class messageQueueHandler {
	constructor(adapter) {
		this.adapter = adapter;
	}

	async sendRequest(duid, method, params, secure = false, photo = false) {
		const remoteConnection = await this.adapter.isRemoteDevice(duid);
		const version = await this.adapter.getRobotVersion(duid);

		const deviceOnline = await this.adapter.onlineChecker(duid);
		const mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
		const localConnectionState = this.adapter.localConnector.isConnected(duid);

		let useCloudConnection = remoteConnection || secure || photo || method == "get_network_info" || method == "service.get_net_info";
		if (!useCloudConnection && !localConnectionState && mqttConnectionState) {
			useCloudConnection = true;
			this.adapter.log.info(`Local connection unavailable for ${duid}. Falling back to cloud connection for method ${method}.`);
		}

		// Some devices (e.g. the Qrevo / roborock.vacuum.a185) keep the local socket
		// connected but never answer, so the disconnect-based fallback above never
		// triggers. After repeated local timeouts, prefer cloud for a cooldown window.
		if (!useCloudConnection && mqttConnectionState && typeof this.adapter.shouldPreferCloudLocally === "function" && this.adapter.shouldPreferCloudLocally(duid)) {
			useCloudConnection = true;
			this.adapter.log.info(`Local connection for ${duid} is unresponsive. Falling back to cloud connection for method ${method}.`);
		}

		if (!useCloudConnection && version == "L01") {
			try {
				await this.adapter.localConnector.ensureL01Handshake(duid);
			} catch (error) {
				this.adapter.log.debug(`L01 handshake before request failed for ${duid}: ${error.message}`);
			}
		}

		let messageID = this.adapter.getRequestId();
		if (photo) messageID = messageID % 256; // this is a special case. Otherwise photo requests will not have the correct ID in the response.
		const timestamp = Math.floor(Date.now() / 1000);

		const protocol = useCloudConnection ? 101 : 4;
		const payload = await this.adapter.message.buildPayload(duid, protocol, messageID, method, params, secure, photo);
		const roborockMessage = await this.adapter.message.buildRoborockMessage(duid, protocol, timestamp, payload);

		if (roborockMessage) {
			return new Promise((resolve, reject) => {
				if (!deviceOnline) {
					this.adapter.pendingRequests.delete(messageID);
					this.adapter.log.debug(`Device ${duid} offline. Not sending for method ${method} request!`);
					reject();
				}
				else if (!mqttConnectionState && useCloudConnection) {
					this.adapter.pendingRequests.delete(messageID);
					this.adapter.log.debug(`Cloud connection not available. Not sending for method ${method} request!`);
					reject();
				}
				else if (!localConnectionState && !useCloudConnection) {
					this.adapter.pendingRequests.delete(messageID);
					this.adapter.log.debug(`Adapter not connect locally to robot ${duid}. Not sending for method ${method} request!`);
					reject();
				} else {
					// setup Timeout
					const timeout = this.adapter.setTimeout(() => {
						this.adapter.pendingRequests.delete(messageID);
						this.adapter.localConnector.clearChunkBuffer(duid);
						if (typeof this.adapter.recordMethodTimeout === "function") {
							this.adapter.recordMethodTimeout(duid, method);
						}
						if (useCloudConnection) {
							reject(new Error(`Cloud request with id ${messageID} with method ${method} timed out after 10 seconds. MQTT connection state: ${mqttConnectionState}`));
						} else {
							if (typeof this.adapter.recordLocalTimeout === "function") {
								this.adapter.recordLocalTimeout(duid);
							}
							reject(new Error(`Local request with id ${messageID} with method ${method} timed out after 10 seconds Local connect state: ${localConnectionState}`));
						}
					}, requestTimeout);

					// Track a successful response so a recovering method resumes normal polling.
					const trackedResolve = (value) => {
						if (typeof this.adapter.recordMethodSuccess === "function") {
							this.adapter.recordMethodSuccess(duid, method);
						}
						if (!useCloudConnection && typeof this.adapter.recordLocalSuccess === "function") {
							this.adapter.recordLocalSuccess(duid);
						}
						resolve(value);
					};

					// Store request with resolve and reject functions
					this.adapter.pendingRequests.set(messageID, { resolve: trackedResolve, reject, timeout });

					if (useCloudConnection) {
						this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
						this.adapter.log.debug(`Sent payload for ${duid} with ${payload} using cloud connection`);
						//client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${duid}`, roborockMessage, { qos: 1 });
						// this.adapter.log.debug(`Promise for messageID ${messageID} created. ${this.adapter.message._decodeMsg(roborockMessage, duid).payload}`);
					} else {
						const lengthBuffer = Buffer.alloc(4);
						lengthBuffer.writeUInt32BE(roborockMessage.length, 0);

						const fullMessage = Buffer.concat([lengthBuffer, roborockMessage]);
						this.adapter.localConnector.sendMessage(duid, fullMessage);
						// this.adapter.log.debug(`sent fullMessage: ${fullMessage.toString("hex")}`);
						this.adapter.log.debug(`Sent payload for ${duid} with ${payload} using local connection`);
					}
				}
			}).finally(() => {
				this.adapter.log.debug(`Size of message queue: ${this.adapter.pendingRequests.size}`);
			});
		} else {
			this.adapter.catchError("Failed to build buildRoborockMessage!", "function sendRequest", duid);
		}
	}
}

module.exports = {
	messageQueueHandler,
};
