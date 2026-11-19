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
const b01Q10 = require("../roborockLib/lib/b01Q10");
const { vacuum } = require("../roborockLib/lib/vacuum");

const Q10 = "q10";
const V1 = "v1";
const Q7 = "q7";

const HOME_DATA = {
  products: [
    { id: "p-q10", model: "roborock.vacuum.ss07", schema: [] },
    { id: "p-v1", model: "roborock.vacuum.a87", schema: [] },
    { id: "p-q7", model: "roborock.vacuum.sc05", schema: [] },
  ],
  devices: [
    {
      duid: Q10,
      name: "Q10",
      productId: "p-q10",
      localKey: "0123456789abcdef",
      pv: "B01",
      online: true,
      deviceStatus: {
        101: { 90: 0 },
        121: 8,
        122: 100,
        123: 2,
        124: 1,
        125: 6,
        126: 6,
        127: 6,
        137: 1,
      },
    },
    {
      duid: V1,
      name: "S8",
      productId: "p-v1",
      localKey: "fedcba9876543210",
      pv: "1.0",
      online: true,
    },
    {
      duid: Q7,
      name: "Q7",
      productId: "p-q7",
      localKey: "abcdef0123456789",
      pv: "B01",
      online: true,
    },
  ],
  receivedDevices: [],
  rooms: [],
};

function createLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/** A Roborock instance with the three robots and a fake cloud MQTT client. */
async function createApi() {
  const api = new Roborock({
    username: "user@example.com",
    log: createLogger(),
  });
  api.states["HomeData"] = { val: JSON.stringify(HOME_DATA), ack: true };
  api.localKeys = new Map(
    HOME_DATA.devices.map((device) => [device.duid, device.localKey])
  );
  for (const device of HOME_DATA.devices) {
    api.initializedVacuumDuids.add(device.duid);
    api.vacuums[device.duid] = {
      name: device.name,
      getParameter: jest.fn(),
      command: jest.fn(),
    };
  }

  mqtt.connect.mockClear();
  await api.rr_mqtt_connector.initUser({
    rriot: { u: "user", k: "key", s: "secret", r: { m: "mqtts://example" } },
  });
  await api.rr_mqtt_connector.initMQTT_Message();
  const client = mqtt.connect.mock.results[0].value;
  api.rr_mqtt_connector.isConnected = jest.fn(() => true);
  api.localConnector.isConnected = jest.fn(() => false);
  api.deviceNotify = jest.fn();
  return { api, client };
}

/** The decoded frames published to the cloud for a robot. */
function published(api: any, client: any, duid: string) {
  return client.publish.mock.calls
    .filter(([topic]: [string]) => topic.endsWith(`/${duid}`))
    .map(([, frame]: [string, Buffer]) => {
      const data = api.message._decodeMsg(frame, duid);
      return {
        version: data.version,
        protocol: data.protocol,
        payload: JSON.parse(data.payload.toString("utf8")),
      };
    });
}

/** Deliver a frame from a robot on its MQTT topic. */
async function deliver(
  api: any,
  client: any,
  duid: string,
  protocol: number,
  payload: Buffer,
  version = "B01"
) {
  const frame = await api.message.buildRoborockMessage(
    duid,
    protocol,
    Math.floor(Date.now() / 1000),
    payload,
    { version }
  );
  client.emit("message", `rr/m/o/user/mqttuser/${duid}`, frame);
}

function pushDps(api: any, client: any, dps: Record<string, unknown>) {
  return deliver(
    api,
    client,
    Q10,
    102,
    Buffer.from(JSON.stringify({ dps, t: 1766800000 }))
  );
}

// A literal-only LZ4 block holding data.
function literalBlock(data: Buffer): Buffer {
  const header =
    data.length < 15
      ? [data.length << 4]
      : (() => {
          const bytes = [0xf0];
          let rest = data.length - 15;
          while (rest >= 255) {
            bytes.push(255);
            rest -= 255;
          }
          bytes.push(rest);
          return bytes;
        })();
  return Buffer.concat([Buffer.from(header), data]);
}

function roomRecord(id: number, name: string): Buffer {
  const record = Buffer.alloc(47);
  record.writeUInt16BE(id, 0);
  const encoded = Buffer.from(name, "utf8");
  record[26] = encoded.length;
  encoded.copy(record, 27);
  return record;
}

// A Q10 current-map packet (01 01) with the given grid and rooms.
function mapPacket(
  width: number,
  height: number,
  rooms: Buffer[],
  headerHeight = height
): Buffer {
  const layout = Buffer.concat([
    Buffer.alloc(width * height, 243),
    Buffer.from([1, rooms.length]),
    ...rooms,
  ]);
  const block = literalBlock(layout);
  const header = Buffer.alloc(29);
  header[0] = 1;
  header[1] = 1;
  header.writeUInt32BE(7, 2);
  header.writeUInt16BE(width, 7);
  header.writeUInt16BE(headerHeight, 9);
  header.writeUInt16BE(layout.length, 25);
  header.writeUInt16BE(block.length, 27);
  return Buffer.concat([header, block]);
}

describe("b01Q10 translation", () => {
  it("recognises Q10 robots by protocol and model", () => {
    expect(b01Q10.isQ10Model("B01", "roborock.vacuum.ss07")).toBe(true);
    expect(b01Q10.isQ10Model("B01", "roborock.vacuum.sc05")).toBe(false);
    expect(b01Q10.isQ10Model("1.0", "roborock.vacuum.ss07")).toBe(false);
    expect(b01Q10.isQ10Model("B01", undefined)).toBe(false);
  });

  it.each([
    ["app_start", null, {}, { dp: 201, value: 1 }],
    ["app_start", null, { paused: true }, { dp: 205, value: 0 }],
    ["resume_segment_clean", [], {}, { dp: 205, value: 0 }],
    ["app_pause", null, {}, { dp: 204, value: 0 }],
    ["app_stop", null, {}, { dp: 206, value: 0 }],
    ["app_charge", null, {}, { dp: 202, value: 5 }],
    [
      "app_segment_clean",
      [{ segments: [3, 5], repeat: 1 }],
      {},
      { dp: 201, value: { cmd: 2, clean_paramters: [3, 5] } },
    ],
    ["set_custom_mode", [104], {}, { dp: 123, value: 4 }],
    ["set_custom_mode", [108], {}, { dp: 123, value: 8 }],
    ["set_water_box_custom_mode", [203], {}, { dp: 124, value: 3 }],
  ])("writes %s %j as a data point", (method, params, context, expected) => {
    expect(b01Q10.encodeCommand(method, params, context)).toEqual(expected);
  });

  it.each([
    ["get_status"],
    ["get_room_mapping"],
    ["get_consumable"],
    ["find_me"],
    ["app_start_wash"],
  ])("has no data point for %s", (method) => {
    expect(b01Q10.encodeCommand(method, [])).toBeNull();
  });

  it("writes only the clean mode, keeping the robot's own levels", () => {
    expect(b01Q10.encodeCleanMode(105, 202)).toEqual({ dp: 137, value: 3 });
    expect(b01Q10.encodeCleanMode(102, 200)).toEqual({ dp: 137, value: 2 });
    expect(b01Q10.encodeCleanMode(103, 203)).toEqual({ dp: 137, value: 1 });
    expect(b01Q10.encodeCleanMode(102, undefined)).toBeNull();
  });

  it("encodes a write without a message id or timestamp", () => {
    expect(b01Q10.encodePayload(204, 0)).toBe('{"dps":{"204":0}}');
    expect(b01Q10.encodePayload(102, {})).toBe('{"dps":{"102":{}}}');
  });

  it("reads a full status push as V1 fields", () => {
    const { status } = b01Q10.toV1Status(
      b01Q10.flattenDps(HOME_DATA.devices[0].deviceStatus),
      { ratedHours: { main_brush: 300, side_brush: 200, filter: 150 } }
    );
    expect(status).toEqual({
      state: 8,
      charge_status: 1,
      battery: 100,
      fan_power: 102,
      water_box_mode: 201,
      error_code: 0,
      main_brush_life: 98,
      side_brush_life: 97,
      filter_life: 96,
    });
  });

  it.each([
    [102, 5],
    [103, 5],
    [104, 5],
    [101, 5],
    [105, 5],
    [7, 4],
    [108, 8],
    [10, 10],
    [6, 6],
    [22, 22],
  ])("reads state %i as V1 state %i", (q10State, v1State) => {
    expect(b01Q10.toV1Status({ 121: q10State }).status.state).toBe(v1State);
  });

  it("does not guess an unknown state", () => {
    const result = b01Q10.toV1Status({ 121: 77 });
    expect(result.status.state).toBeUndefined();
    expect(result.unknownState).toBe(77);
  });

  it("reads suction and water through the clean mode", () => {
    expect(b01Q10.toV1Status({ 137: 3, 123: 2, 124: 2 }).status).toMatchObject({
      fan_power: 105,
      water_box_mode: 202,
    });
    expect(b01Q10.toV1Status({ 137: 2, 123: 8, 124: 2 }).status).toMatchObject({
      fan_power: 108,
      water_box_mode: 200,
    });
  });

  it("reports a fault only while the robot is in error", () => {
    expect(b01Q10.toV1Status({ 121: 12, 90: 8 }).status.error_code).toBe(8);
    expect(b01Q10.toV1Status({ 121: 12, 90: 310 }).status.error_code).toBe(254);
    expect(b01Q10.toV1Status({ 121: 5, 90: 8 }).status.error_code).toBe(0);
    expect(b01Q10.toV1Status({ 121: 8, 90: 8 }).status.error_code).toBe(0);
    expect(b01Q10.toV1Status({ 121: 12, 90: 501 }).status.error_code).toBe(0);

    const unmapped = b01Q10.toV1Status({ 121: 12, 90: 27 });
    expect(unmapped.status.error_code).toBe(0);
    expect(unmapped.unmappedFault).toBe(27);

    expect(
      b01Q10.toV1Status(b01Q10.flattenDps({ 121: 12, 101: { 90: 5 } })).status
        .error_code
    ).toBe(5);
  });
});

describe("b01Q10 map packets", () => {
  it("reads the rooms of a current-map packet", () => {
    const packet = mapPacket(8, 6, [
      roomRecord(2, "rr_living_room"),
      roomRecord(3, "Kitchen"),
      roomRecord(4, ""),
      roomRecord(5, "Kitchen"),
    ]);
    expect(b01Q10.parseMapRooms(packet)).toEqual({
      mapId: 7,
      rooms: [
        { id: 2, name: "Living Room" },
        { id: 3, name: "Kitchen" },
        { id: 4, name: "Room 4" },
        { id: 5, name: "Kitchen 2" },
      ],
    });
  });

  it("finds the rooms when the header has no height", () => {
    const packet = mapPacket(4, 3, [roomRecord(9, "Den")], 0);
    expect(b01Q10.parseMapRooms(packet).rooms).toEqual([
      { id: 9, name: "Den" },
    ]);
  });

  it("reads a map without rooms", () => {
    expect(b01Q10.parseMapRooms(mapPacket(4, 3, [])).rooms).toEqual([]);
  });

  it("ignores the other protocol 301 packets", () => {
    const emptyTrace = Buffer.from("0201000100000000000000000000", "hex");
    expect(b01Q10.parseMapRooms(emptyTrace)).toBeNull();
  });

  it("rejects a truncated map packet", () => {
    const packet = mapPacket(8, 6, [roomRecord(2, "Hall")]);
    expect(() => b01Q10.parseMapRooms(packet.subarray(0, 40))).toThrow();
  });

  it("inflates LZ4 back-references, including overlapping ones", () => {
    const block = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x00]);
    expect(b01Q10.lz4BlockDecompress(block, 100).toString()).toBe(
      "abcabcabcabc"
    );
    expect(() => b01Q10.lz4BlockDecompress(block, 5)).toThrow();
    const badOffset = Buffer.from([0x15, 0x61, 0x09, 0x00, 0x00]);
    expect(() => b01Q10.lz4BlockDecompress(badOffset, 100)).toThrow();
  });
});

describe("Q10 commands", () => {
  it("sends a command as a data point write without waiting for a reply", async () => {
    const { api, client } = await createApi();

    await expect(
      api.messageQueueHandler.sendRequest(Q10, "app_start", null)
    ).resolves.toBe("ok");

    expect(published(api, client, Q10)).toEqual([
      { version: "B01", protocol: 101, payload: { dps: { 201: 1 } } },
    ]);
    expect(api.pendingRequests.size).toBe(0);
  });

  it("resumes a paused clean instead of starting a new one", async () => {
    const { api, client } = await createApi();
    await pushDps(api, client, { 121: 10 });

    await api.messageQueueHandler.sendRequest(Q10, "app_start", null);

    expect(published(api, client, Q10)[0].payload).toEqual({
      dps: { 205: 0 },
    });
  });

  it("cleans rooms with the firmware's own parameter name", async () => {
    const { api, client } = await createApi();
    api.isInited = () => true;

    await api.app_segment_clean(Q10, [16, 17]);

    expect(published(api, client, Q10)[0].payload).toEqual({
      dps: { 201: { cmd: 2, clean_paramters: [16, 17] } },
    });
  });

  it("refuses a read without sending anything", async () => {
    const { api, client } = await createApi();

    await expect(
      api.messageQueueHandler.sendRequest(Q10, "get_status", [])
    ).rejects.toMatchObject({ code: "ERR_Q10_UNSUPPORTED" });
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("logs a refused command at info level", async () => {
    const { api } = await createApi();
    const error = Object.assign(new Error("find_me is not available"), {
      code: "ERR_Q10_UNSUPPORTED",
    });

    await api.catchError(error, "find_me", Q10);

    expect(api.log.info).toHaveBeenCalledWith("find_me is not available");
    expect(api.log.error).not.toHaveBeenCalled();
  });

  it("does not send while the cloud connection is down", async () => {
    const { api, client } = await createApi();
    api.rr_mqtt_connector.isConnected.mockReturnValue(false);

    await expect(
      api.messageQueueHandler.sendRequest(Q10, "app_stop", null)
    ).rejects.toMatchObject({ code: "ERR_Q10_NOT_SENT" });
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("sets the Matter clean mode through the Q10 data points", async () => {
    const { api, client } = await createApi();
    api.isInited = () => true;

    await api.setCleanModeParameters(Q10, {
      fan_power: 105,
      water_box_mode: 202,
    });

    expect(published(api, client, Q10).map((frame) => frame.payload)).toEqual([
      { dps: { 137: 3 } },
    ]);
    expect(api.vacuums[Q10].command).not.toHaveBeenCalled();
  });

  it("sends the HomeKit and Matter commands through the vacuum", async () => {
    const { api, client } = await createApi();
    api.isInited = () => true;
    api.vacuums[Q10] = new vacuum(api, "roborock.vacuum.ss07");
    api.vacuums[Q10].name = "Q10";

    await api.app_start(Q10);
    await api.app_pause(Q10);
    await api.resume_segment_clean(Q10);
    await api.app_stop(Q10);
    await api.app_charge(Q10);
    await new Promise((resolve) => setImmediate(resolve));

    expect(published(api, client, Q10).map((frame) => frame.payload)).toEqual([
      { dps: { 201: 1 } },
      { dps: { 204: 0 } },
      { dps: { 205: 0 } },
      { dps: { 206: 0 } },
      { dps: { 202: 5 } },
    ]);
    expect(api.log.error).not.toHaveBeenCalled();
    expect(api.log.warn).not.toHaveBeenCalled();
  });

  it("says in the log when a command has no Q10 equivalent", async () => {
    const { api, client } = await createApi();
    api.isInited = () => true;
    api.vacuums[Q10] = new vacuum(api, "roborock.vacuum.ss07");

    await api.findMe(Q10);

    expect(client.publish).not.toHaveBeenCalled();
    expect(api.log.info).toHaveBeenCalledWith(
      expect.stringContaining("find_me is not available on Q10-series robots")
    );
    expect(api.log.error).not.toHaveBeenCalled();
  });

  it("leaves V1 and Q7 robots on their own wire formats", async () => {
    const { api, client } = await createApi();

    api.messageQueueHandler.sendRequest(V1, "app_start", null);
    api.messageQueueHandler.sendRequest(Q7, "app_start", null);
    await new Promise((resolve) => setImmediate(resolve));

    const [v1] = published(api, client, V1);
    expect(v1.version).toBe("1.0");
    expect(JSON.parse(v1.payload.dps["101"])).toMatchObject({
      method: "app_start",
    });
    const [q7] = published(api, client, Q7);
    expect(q7.payload.dps["10000"]).toMatchObject({ method: "app_start" });
    api.clearTimersAndIntervals();
  });
});

describe("Q10 status", () => {
  it("passes a push to the accessories as V1 fields", async () => {
    const { api, client } = await createApi();

    await pushDps(api, client, { 121: 104, 122: 80, 137: 1, 123: 4, 124: 3 });

    expect(api.deviceNotify).toHaveBeenLastCalledWith(
      "CloudMessage",
      {
        state: 5,
        charge_status: 0,
        battery: 80,
        fan_power: 104,
        water_box_mode: 203,
        error_code: 0,
      },
      Q10
    );
    expect(api.getVacuumDeviceStatus(Q10, "state")).toBe(5);
    expect(api.getVacuumDeviceStatus(Q10, "battery")).toBe(80);
  });

  it("combines a partial push with what the robot pushed before", async () => {
    const { api, client } = await createApi();
    await pushDps(api, client, { 121: 5, 137: 3, 123: 2 });

    await pushDps(api, client, { 122: 64 });

    expect(api.deviceNotify).toHaveBeenLastCalledWith(
      "CloudMessage",
      expect.objectContaining({ state: 5, battery: 64, fan_power: 105 }),
      Q10
    );
  });

  it("names a fault Apple Home cannot show in the log, once", async () => {
    const { api, client } = await createApi();

    await pushDps(api, client, { 121: 12, 101: { 90: 27 } });
    await pushDps(api, client, { 122: 50 });

    const notices = api.log.info.mock.calls.filter(([message]: [string]) =>
      message.includes("fault 27 (mopping module stuck)")
    );
    expect(notices).toHaveLength(1);
  });

  it("reads the HomeData snapshot in V1 units until the robot pushes", async () => {
    const { api } = await createApi();

    expect(api.getVacuumDeviceStatus(Q10, "state")).toBe(8);
    expect(api.getVacuumDeviceStatus(Q10, "fan_power")).toBe(102);
    expect(api.getVacuumDeviceStatus(Q10, "filter_life")).toBe(96);
    expect(api.getVacuumDeviceStatus(Q10, "dock_error_status")).toBe("");
  });

  it("asks the robot to push its status instead of polling V1 reads", async () => {
    const { api, client } = await createApi();
    const sendRequest = jest.spyOn(api.messageQueueHandler, "sendRequest");

    await api.updateDataMinimumData(
      Q10,
      api.vacuums[Q10],
      "roborock.vacuum.ss07"
    );

    expect(published(api, client, Q10).map((frame) => frame.payload)).toEqual([
      { dps: { 102: {} } },
    ]);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(api.vacuums[Q10].getParameter).not.toHaveBeenCalled();
  });

  it("counts a status request the robot never answers toward a stalled session", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    try {
      const { api } = await createApi();
      const recordCloudTimeout = jest.spyOn(api, "recordCloudTimeout");

      await api.requestQ10Status(Q10);
      jest.advanceTimersByTime(10000);
      expect(recordCloudTimeout).toHaveBeenCalledTimes(1);

      await api.requestQ10Status(Q10);
      api.handleQ10Push(Q10, { 122: 90 });
      jest.advanceTimersByTime(10000);
      expect(recordCloudTimeout).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Q10 rooms", () => {
  it("reads the rooms from the map the robot pushes", async () => {
    const { api, client } = await createApi();

    await deliver(
      api,
      client,
      Q10,
      301,
      mapPacket(8, 6, [roomRecord(16, "rr_kitchen"), roomRecord(17, "Study")])
    );

    expect(api.getSegmentRooms(Q10)).toEqual([
      { segmentId: 16, name: "Kitchen" },
      { segmentId: 17, name: "Study" },
    ]);
    expect(api.deviceNotify).toHaveBeenCalledWith("CloudMessage", {}, Q10);
    expect(api.log.error).not.toHaveBeenCalled();
  });

  it("ignores the cleaning-path packets", async () => {
    const { api, client } = await createApi();

    await deliver(
      api,
      client,
      Q10,
      301,
      Buffer.from("0201000100000000000000000000", "hex")
    );

    expect(api.getSegmentRooms(Q10)).toEqual([]);
    expect(api.deviceNotify).not.toHaveBeenCalled();
    expect(api.log.error).not.toHaveBeenCalled();
  });
});
