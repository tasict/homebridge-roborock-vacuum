import * as crypto from "crypto";
import * as zlib from "zlib";

jest.mock("mqtt", () => {
  const { EventEmitter } = require("events");
  return {
    connect: jest.fn(() => {
      const client = new EventEmitter();
      client.subscribe = jest.fn();
      client.publish = jest.fn();
      client.end = jest.fn();
      return client;
    }),
  };
});

const mqtt = require("mqtt");
const { Roborock } = require("../roborockLib/roborockAPI");

const DUID = "d1";
const LOCAL_KEY = "0123456789abcdef";

/** A Roborock instance whose cloud MQTT client is a local EventEmitter. */
async function createApi() {
  const api = new Roborock({
    username: "user@example.com",
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  });
  api.localKeys = new Map([[DUID, LOCAL_KEY]]);

  mqtt.connect.mockClear();
  await api.rr_mqtt_connector.initUser({
    rriot: { u: "user", k: "key", s: "secret", r: { m: "mqtts://example" } },
  });
  await api.rr_mqtt_connector.initMQTT_Message();
  const client = mqtt.connect.mock.results[0].value;
  return { api, client };
}

/** Deliver a protocol 301 frame from the robot on its MQTT topic. */
async function deliver301(
  api: any,
  client: any,
  payload: Buffer,
  version: string
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const frame = await api.message.buildRoborockMessage(
    DUID,
    301,
    timestamp,
    payload,
    { version }
  );
  client.emit("message", `rr/m/o/user/mqttuser/${DUID}`, frame);
}

describe("cloud MQTT protocol 301 messages", () => {
  it("ignores a B01 Q10 live-trace packet shorter than the map header", async () => {
    const { api, client } = await createApi();
    // A Q10 trace packet ("02 01") with no points is its 14-byte header alone.
    const emptyTrace = Buffer.from("0201000100000000000000000000", "hex");
    expect(emptyTrace.length).toBe(14);

    await deliver301(api, client, emptyTrace, "B01");

    expect(api.log.error).not.toHaveBeenCalled();
    expect(api.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring protocol 301 message for d1 (14 bytes)")
    );
  });

  it("ignores a packet whose header carries no endpoint", async () => {
    const { api, client } = await createApi();

    await deliver301(api, client, Buffer.alloc(40), "B01");

    expect(api.log.error).not.toHaveBeenCalled();
    expect(api.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring protocol 301 message for d1 (40 bytes)")
    );
  });

  it("still resolves a V1 map response addressed to this client", async () => {
    const { api, client } = await createApi();
    const resolve = jest.fn();
    api.pendingRequests.set(42, {
      resolve,
      reject: jest.fn(),
      timeout: setTimeout(() => undefined, 10000),
      awaitsPayload: true,
    });

    const header = Buffer.alloc(24);
    header.write(api.rr_mqtt_connector.getEndpoint(), 0, "utf8");
    header.writeUInt16LE(42, 16);
    const cipher = crypto.createCipheriv(
      "aes-128-cbc",
      api.nonce,
      Buffer.alloc(16, 0)
    );
    const body = Buffer.concat([
      cipher.update(zlib.gzipSync(Buffer.from("map data"))),
      cipher.final(),
    ]);

    await deliver301(api, client, Buffer.concat([header, body]), "1.0");
    await new Promise((done) => setTimeout(done, 50));

    expect(api.log.error).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(Buffer.from("map data"));
    expect(api.pendingRequests.has(42)).toBe(false);
  });
});
