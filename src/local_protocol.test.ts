import * as net from "net";

const CRC32 = require("crc-32");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

const LOCAL_KEY = "0123456789abcdef";
const ACK_NONCE = 23456;

/** A Roborock instance with HomeData for a "1.0" (v1) and an "L01" (l1) device. */
function createApi() {
  const api = new Roborock({ log: createLogger() });
  api.states["HomeData"] = {
    val: JSON.stringify({
      products: [{ id: "p1", model: "roborock.vacuum.a97" }],
      devices: [
        { duid: "v1", productId: "p1", localKey: LOCAL_KEY, pv: "1.0" },
        { duid: "l1", productId: "p1", localKey: LOCAL_KEY, pv: "L01" },
      ],
      receivedDevices: [],
    }),
  };
  api.localKeys = new Map([
    ["v1", LOCAL_KEY],
    ["l1", LOCAL_KEY],
  ]);
  return api;
}

type Frame = {
  version: string;
  seq: number;
  random: number;
  protocol: number;
  length: number;
  crcOk: boolean;
};

function parseFrame(frame: Buffer): Frame {
  return {
    version: frame.toString("latin1", 0, 3),
    seq: frame.readUInt32BE(3),
    random: frame.readUInt32BE(7),
    protocol: frame.readUInt16BE(15),
    length: frame.length,
    crcOk:
      CRC32.buf(frame.subarray(0, frame.length - 4)) >>> 0 ==
      frame.readUInt32BE(frame.length - 4),
  };
}

// A length-prefixed header-only frame, built independently of message.js.
function headerFrame(
  version: string,
  seq: number,
  random: number,
  protocol: number
) {
  const frame = Buffer.alloc(25);
  frame.writeUInt32BE(21, 0);
  frame.write(version, 4, "latin1");
  frame.writeUInt32BE(seq, 7);
  frame.writeUInt32BE(random, 11);
  frame.writeUInt32BE(Math.floor(Date.now() / 1000), 15);
  frame.writeUInt16BE(protocol, 19);
  frame.writeUInt32BE(CRC32.buf(frame.subarray(4, 21)) >>> 0, 21);
  return frame;
}

/**
 * A robot on 127.0.0.1 that only understands `speaks`: it answers HELLO
 * (protocol 0) and PING (protocol 2) frames of that version and ignores
 * everything else, like the a97 ignores 1.0 and the a70 ignores L01.
 */
async function startRobot(speaks: string) {
  const connections: { socket: net.Socket; frames: Frame[] }[] = [];
  const server = net.createServer((socket) => {
    const connection = { socket, frames: [] as Frame[] };
    connections.push(connection);
    socket.on("error", () => {});
    socket.on("data", (data) => {
      let offset = 0;
      while (offset + 4 <= data.length) {
        const length = data.readUInt32BE(offset);
        const frame = parseFrame(
          data.subarray(offset + 4, offset + 4 + length)
        );
        offset += 4 + length;
        connection.frames.push(frame);
        if (frame.version != speaks || frame.length != 21) {
          continue;
        }
        if (frame.protocol == 0) {
          socket.write(headerFrame(speaks, frame.seq, ACK_NONCE, 1));
        } else if (frame.protocol == 2) {
          socket.write(headerFrame(speaks, frame.seq, frame.random, 3));
        }
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const port = (server.address() as net.AddressInfo).port;
  const close = () =>
    new Promise<void>((resolve) => {
      connections.forEach(({ socket }) => socket.destroy());
      server.close(() => resolve());
    });
  return { port, connections, close };
}

// Polls on setImmediate, which the fake timers below leave real.
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 20000; i++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

describe("Roborock.getRobotVersion", () => {
  it("returns HomeData's pv when no local version was detected", async () => {
    const api = createApi();
    expect(await api.getRobotVersion("v1")).toBe("1.0");
    expect(await api.getRobotVersion("v1", "local")).toBe("1.0");
    expect(await api.getRobotVersion("v1", "cloud")).toBe("1.0");
  });

  it("returns the detected version for local traffic only", async () => {
    const api = createApi();
    api.localVersions.set("v1", "L01");
    expect(await api.getRobotVersion("v1", "local")).toBe("L01");
    expect(await api.getRobotVersion("v1", "cloud")).toBe("1.0");
    expect(await api.getRobotVersion("v1")).toBe("1.0");
  });
});

describe("message.buildRoborockMessage protocol version", () => {
  const ts = Math.floor(Date.now() / 1000);

  it("encodes local requests with the detected version and cloud requests with HomeData's", async () => {
    const api = createApi();
    api.localVersions.set("v1", "L01");
    api.localL01Nonces.set("v1", { connectNonce: 12345, ackNonce: ACK_NONCE });
    const payload = JSON.stringify({ dps: { 4: "{}" }, t: ts });

    const local = await api.message.buildRoborockMessage("v1", 4, ts, payload);
    const cloud = await api.message.buildRoborockMessage(
      "v1",
      101,
      ts,
      payload
    );

    expect(local.toString("latin1", 0, 3)).toBe("L01");
    expect(api.message._decodeMsg(local, "v1").payload.toString()).toBe(
      payload
    );
    expect(cloud.toString("latin1", 0, 3)).toBe("1.0");
    expect(api.message._decodeMsg(cloud, "v1").payload.toString()).toBe(
      payload
    );
  });

  it("builds 21-byte header-only HELLO and PING frames", async () => {
    const api = createApi();

    const hello = await api.message.buildRoborockMessage(
      "v1",
      0,
      ts,
      Buffer.alloc(0),
      { version: "L01", seq: 1, random: 12345 }
    );
    const ping = await api.message.buildRoborockMessage(
      "l1",
      2,
      ts,
      Buffer.alloc(0),
      { seq: 0x10000, random: 23456 }
    );

    expect(parseFrame(hello)).toEqual({
      version: "L01",
      seq: 1,
      random: 12345,
      protocol: 0,
      length: 21,
      crcOk: true,
    });
    expect(parseFrame(ping)).toEqual({
      version: "L01",
      seq: 0x10000,
      random: 23456,
      protocol: 2,
      length: 21,
      crcOk: true,
    });
  });

  it("does not advance the data message sequence for a PING with its own seq", async () => {
    const api = createApi();
    const payload = JSON.stringify({ dps: { 4: "{}" }, t: ts });

    const first = await api.message.buildRoborockMessage("v1", 4, ts, payload);
    await api.message.buildRoborockMessage("v1", 2, ts, Buffer.alloc(0), {
      seq: 0x10000,
      random: 23456,
    });
    const second = await api.message.buildRoborockMessage("v1", 4, ts, payload);

    expect(second.readUInt32BE(3)).toBe(first.readUInt32BE(3) + 1);
  });
});

describe("localConnector.detectLocalVersion", () => {
  let robot: Awaited<ReturnType<typeof startRobot>> | undefined;

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (robot) {
      await robot.close();
      robot = undefined;
    }
  });

  it("switches a 1.0 device that answers an L01 HELLO to L01", async () => {
    robot = await startRobot("L01");
    const api = createApi();

    await api.localConnector.detectLocalVersion("v1", "127.0.0.1", robot.port);

    expect(api.localVersions.get("v1")).toBe("L01");
    expect(robot.connections[0].frames).toEqual([
      expect.objectContaining({
        version: "L01",
        seq: 1,
        protocol: 0,
        length: 21,
        crcOk: true,
      }),
    ]);
    expect(api.log.info).toHaveBeenCalledWith(
      expect.stringContaining("answers L01 locally")
    );
  });

  it("keeps 1.0 when the device does not answer", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    robot = await startRobot("1.0");
    const api = createApi();

    const probe = api.localConnector.detectLocalVersion(
      "v1",
      "127.0.0.1",
      robot.port
    );
    await waitFor(() => robot!.connections[0]?.frames.length == 1);
    jest.advanceTimersByTime(3000);
    await probe;

    expect(api.localVersions.has("v1")).toBe(false);
    expect(await api.getRobotVersion("v1", "local")).toBe("1.0");
  });

  it("keeps 1.0 when the device closes the connection without answering", async () => {
    robot = await startRobot("1.0");
    const server = robot;
    const api = createApi();

    const probe = api.localConnector.detectLocalVersion(
      "v1",
      "127.0.0.1",
      server.port
    );
    await waitFor(() => server.connections[0]?.frames.length == 1);
    server.connections[0].socket.destroy();
    await probe;

    expect(api.localVersions.has("v1")).toBe(false);
  });

  it("does not probe devices whose HomeData version is not 1.0, or already detected", async () => {
    const connect = jest.spyOn(net.Socket.prototype, "connect");
    const api = createApi();
    api.localVersions.set("v1", "L01");

    await api.localConnector.detectLocalVersion("l1", "127.0.0.1", 1);
    await api.localConnector.detectLocalVersion("v1", "127.0.0.1", 1);

    expect(connect).not.toHaveBeenCalled();
  });
});

describe("localConnector keepalive", () => {
  let robot: Awaited<ReturnType<typeof startRobot>>;
  let api: ReturnType<typeof createApi>;

  // createClient dials the fixed local port; send every connection to the
  // fake robot instead.
  async function setup(speaks: string) {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    robot = await startRobot(speaks);
    const realConnect = net.Socket.prototype.connect;
    jest.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      return Reflect.apply(realConnect, this, [
        robot.port,
        "127.0.0.1",
        args[2],
      ]);
    });
    api = createApi();
  }

  afterEach(async () => {
    api.localConnector.shutdown();
    await robot.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const pings = (frames: Frame[]) => frames.filter((f) => f.protocol == 2);

  it("pings a detected L01 connection every 30 s until it closes", async () => {
    await setup("L01");

    await api.localConnector.createClient("v1", "192.0.2.1");
    // Connection 0 is the probe, connection 1 the client.
    await waitFor(
      () =>
        robot.connections.length == 2 &&
        !!api.localConnector.localClients.v1.keepaliveTimer
    );
    const client = robot.connections[1];

    jest.advanceTimersByTime(29999);
    expect(pings(client.frames)).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await waitFor(() => pings(client.frames).length == 1);
    jest.advanceTimersByTime(30000);
    await waitFor(() => pings(client.frames).length == 2);

    expect(pings(client.frames)).toEqual([
      expect.objectContaining({
        version: "L01",
        seq: 0x10000,
        length: 21,
        crcOk: true,
      }),
      expect.objectContaining({ version: "L01", seq: 0x10001 }),
    ]);
    expect(api.localConnector.isConnected("v1")).toBe(true);

    const closed = new Promise((resolve) =>
      api.localConnector.localClients.v1.once("close", resolve)
    );
    client.socket.destroy();
    await closed;
    expect(api.localConnector.isConnected("v1")).toBe(false);
    expect(api.localConnector.localClients.v1.keepaliveTimer).toBeNull();
  });

  it("stops pinging on shutdown", async () => {
    await setup("L01");

    await api.localConnector.createClient("l1", "192.0.2.1");
    await waitFor(() => !!api.localConnector.localClients.l1?.keepaliveTimer);
    const socket = api.localConnector.localClients.l1;

    api.localConnector.shutdown();

    expect(socket.keepaliveTimer).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not ping 1.0 connections", async () => {
    await setup("1.0");

    const connecting = api.localConnector.createClient("v1", "192.0.2.1");
    await waitFor(() => robot.connections[0]?.frames.length == 1);
    jest.advanceTimersByTime(3000);
    await connecting;
    await waitFor(() => robot.connections.length == 2);

    jest.advanceTimersByTime(90000);
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(api.localVersions.has("v1")).toBe(false);
    expect(api.localConnector.localClients.v1.keepaliveTimer).toBeNull();
    expect(robot.connections[1].frames).toEqual([]);
  });
});
