"use strict";

const requestTimeout = 10000; // 10s

class messageQueueHandler {
  constructor(adapter) {
    this.adapter = adapter;
    // duid -> methods whose cloud fallback was already logged at info level
    this.loggedFallbacks = new Map();
  }

  async sendRequest(duid, method, params, secure = false, photo = false) {
    const remoteConnection = await this.adapter.isRemoteDevice(duid);
    const mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
    const localConnectionState = this.adapter.localConnector.isConnected(duid);

    let useCloudConnection =
      remoteConnection ||
      secure ||
      photo ||
      method == "get_network_info" ||
      method == "service.get_net_info";
    if (!useCloudConnection && !localConnectionState && mqttConnectionState) {
      useCloudConnection = true;
      this.logFallback(
        duid,
        method,
        `Local connection unavailable for ${duid}. Falling back to cloud connection for method ${method}.`
      );
    }

    // Some devices (e.g. the Qrevo / roborock.vacuum.a185) keep the local socket
    // connected but never answer, so the disconnect-based fallback above never
    // triggers. After repeated local timeouts, prefer cloud for a cooldown window.
    if (
      !useCloudConnection &&
      mqttConnectionState &&
      typeof this.adapter.shouldPreferCloudLocally === "function" &&
      this.adapter.shouldPreferCloudLocally(duid)
    ) {
      useCloudConnection = true;
      this.logFallback(
        duid,
        method,
        `Local connection for ${duid} is unresponsive. Falling back to cloud connection for method ${method}.`
      );
    }

    if (useCloudConnection) {
      return this.send(duid, method, params, true, secure, photo);
    }

    try {
      return await this.send(duid, method, params, false, secure, photo);
    } catch (error) {
      // A local request that timed out or could not be written is sent once
      // more over the cloud. A request that was never sent (device offline,
      // no connection at all) rejects without an Error and is not retried.
      if (
        !(error instanceof Error) ||
        !this.adapter.rr_mqtt_connector.isConnected()
      ) {
        throw error;
      }
      this.logFallback(
        duid,
        method,
        `Local request for ${duid} failed (${error.message}). Retrying method ${method} over the cloud connection.`
      );
      return this.send(duid, method, params, true, secure, photo);
    }
  }

  // Scene items: local connection only, never retried over the cloud, so a
  // lost reply cannot start the same item twice.
  sendLocalRequest(duid, method, params) {
    return this.send(duid, method, params, false);
  }

  // Log a cloud fallback at info level once per method and robot until the
  // robot answers locally again; repeats go to debug.
  logFallback(duid, method, message) {
    const methods = this.loggedFallbacks.get(duid) || new Set();
    if (methods.has(method)) {
      this.adapter.log.debug(message);
      return;
    }
    methods.add(method);
    this.loggedFallbacks.set(duid, methods);
    this.adapter.log.info(message);
  }

  async send(
    duid,
    method,
    params,
    useCloudConnection,
    secure = false,
    photo = false
  ) {
    const version = await this.adapter.getRobotVersion(duid, "local");
    const deviceOnline = await this.adapter.onlineChecker(duid);
    const mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
    const localConnectionState = this.adapter.localConnector.isConnected(duid);

    if (!useCloudConnection && version == "L01") {
      try {
        await this.adapter.localConnector.ensureL01Handshake(duid);
      } catch (error) {
        this.adapter.log.debug(
          `L01 handshake before request failed for ${duid}: ${error.message}`
        );
      }
    }

    let messageID = this.adapter.getRequestId();
    if (photo) messageID = messageID % 256; // this is a special case. Otherwise photo requests will not have the correct ID in the response.
    const timestamp = Math.floor(Date.now() / 1000);

    const protocol = useCloudConnection ? 101 : 4;
    const payload = await this.adapter.message.buildPayload(
      duid,
      protocol,
      messageID,
      method,
      params,
      secure,
      photo
    );
    const roborockMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      protocol,
      timestamp,
      payload
    );

    if (roborockMessage) {
      return new Promise((resolve, reject) => {
        if (!deviceOnline) {
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Device ${duid} offline. Not sending for method ${method} request!`
          );
          reject();
        } else if (!mqttConnectionState && useCloudConnection) {
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Cloud connection not available. Not sending for method ${method} request!`
          );
          reject();
        } else if (!localConnectionState && !useCloudConnection) {
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Adapter not connect locally to robot ${duid}. Not sending for method ${method} request!`
          );
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
              if (typeof this.adapter.recordCloudTimeout === "function") {
                this.adapter.recordCloudTimeout();
              }
              reject(
                new Error(
                  `Cloud request with id ${messageID} with method ${method} timed out after 10 seconds. MQTT connection state: ${mqttConnectionState}`
                )
              );
            } else {
              if (typeof this.adapter.recordLocalTimeout === "function") {
                this.adapter.recordLocalTimeout(duid);
              }
              reject(
                new Error(
                  `Local request with id ${messageID} with method ${method} timed out after 10 seconds Local connect state: ${localConnectionState}`
                )
              );
            }
          }, requestTimeout);

          // Track a successful response so a recovering method resumes normal polling.
          const trackedResolve = (value) => {
            if (typeof this.adapter.recordMethodSuccess === "function") {
              this.adapter.recordMethodSuccess(duid, method);
            }
            if (!useCloudConnection) {
              this.loggedFallbacks.delete(duid);
              if (typeof this.adapter.recordLocalSuccess === "function") {
                this.adapter.recordLocalSuccess(duid);
              }
            }
            if (
              useCloudConnection &&
              typeof this.adapter.recordCloudSuccess === "function"
            ) {
              this.adapter.recordCloudSuccess();
            }
            resolve(value);
          };

          // Store request with resolve and reject functions
          this.adapter.pendingRequests.set(messageID, {
            resolve: trackedResolve,
            reject,
            timeout,
            // Answered with protocol 300/301 after an "ok" acknowledgement.
            awaitsPayload: secure || photo,
          });

          if (useCloudConnection) {
            this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using cloud connection`
            );
            //client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${duid}`, roborockMessage, { qos: 1 });
            // this.adapter.log.debug(`Promise for messageID ${messageID} created. ${this.adapter.message._decodeMsg(roborockMessage, duid).payload}`);
          } else {
            const lengthBuffer = Buffer.alloc(4);
            lengthBuffer.writeUInt32BE(roborockMessage.length, 0);

            const fullMessage = Buffer.concat([lengthBuffer, roborockMessage]);
            try {
              this.adapter.localConnector.sendMessage(duid, fullMessage);
            } catch (error) {
              this.adapter.clearTimeout(timeout);
              this.adapter.pendingRequests.delete(messageID);
              reject(error);
              return;
            }
            // this.adapter.log.debug(`sent fullMessage: ${fullMessage.toString("hex")}`);
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using local connection`
            );
          }
        }
      }).finally(() => {
        this.adapter.log.debug(
          `Size of message queue: ${this.adapter.pendingRequests.size}`
        );
      });
    } else {
      this.adapter.catchError(
        "Failed to build buildRoborockMessage!",
        "function send",
        duid
      );
    }
  }
}

module.exports = {
  messageQueueHandler,
};
