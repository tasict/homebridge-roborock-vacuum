import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { Roborock } = require("../roborockLib/roborockAPI");

function createLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

const HOME_DATA = {
  products: [
    {
      id: "p1",
      model: "roborock.vacuum.a87",
      schema: [{ id: 125, code: "main_brush_life" }],
    },
  ],
  devices: [
    {
      duid: "d1",
      name: "3F",
      productId: "p1",
      localKey: "0123456789abcdef",
      pv: "1.0",
      online: false,
      deviceStatus: { 125: 50 },
    },
    {
      duid: "d2",
      name: "4F",
      productId: "p1",
      localKey: "fedcba9876543210",
      pv: "1.0",
      online: true,
    },
  ],
  receivedDevices: [],
  rooms: [],
};

/** A Roborock instance with home data loaded and both robots initialized. */
function createApi(options: Record<string, unknown> = {}) {
  const api = new Roborock({
    username: "user@example.com",
    log: createLogger(),
    ...options,
  });
  api.states["HomeData"] = { val: JSON.stringify(HOME_DATA), ack: true };
  for (const duid of ["d1", "d2"]) {
    api.initializedVacuumDuids.add(duid);
    api.vacuums[duid] = { command: jest.fn() };
  }
  api.localConnector.isConnected = jest.fn(() => true);
  api.rr_mqtt_connector.isConnected = jest.fn(() => true);
  api.rr_mqtt_connector.sendMessage = jest.fn();
  api.localConnector.sendMessage = jest.fn();
  return api;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("messageQueueHandler local-first requests", () => {
  // Skip the real framing and crypto; the tests are about routing.
  function stubMessages(api: any) {
    api.message.buildPayload = jest.fn(
      async (_duid: string, _protocol: number, id: number, method: string) =>
        JSON.stringify({ id, method })
    );
    api.message.buildRoborockMessage = jest.fn(async () => Buffer.from("x"));
  }

  // The cloud answers whatever request is pending.
  function answerOverCloud(api: any, result: unknown) {
    api.rr_mqtt_connector.sendMessage = jest.fn(() => {
      for (const [id, request] of api.pendingRequests) {
        clearTimeout(request.timeout);
        api.pendingRequests.delete(id);
        request.resolve(result);
      }
    });
  }

  it("retries a timed-out local request once over the cloud", async () => {
    jest.useFakeTimers();
    const api = createApi();
    stubMessages(api);
    answerOverCloud(api, ["ok"]);

    const request = api.messageQueueHandler.sendRequest("d1", "app_start", []);
    await jest.advanceTimersByTimeAsync(10000);

    await expect(request).resolves.toEqual(["ok"]);
    expect(api.localConnector.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Retrying method app_start over the cloud")
    );
  });

  it("retries a local request that cannot be written", async () => {
    const api = createApi();
    stubMessages(api);
    answerOverCloud(api, ["ok"]);
    api.localConnector.sendMessage = jest.fn(() => {
      throw new Error("write EPIPE");
    });

    await expect(
      api.messageQueueHandler.sendRequest("d1", "app_charge", [])
    ).resolves.toEqual(["ok"]);
    expect(api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the cloud is not connected", async () => {
    jest.useFakeTimers();
    const api = createApi();
    stubMessages(api);
    api.rr_mqtt_connector.isConnected.mockReturnValue(false);

    const request = api.messageQueueHandler.sendRequest("d1", "app_start", []);
    const outcome = expect(request).rejects.toThrow("Local request");
    await jest.advanceTimersByTimeAsync(10000);

    await outcome;
    expect(api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  it("never retries a request that already went over the cloud", async () => {
    jest.useFakeTimers();
    const api = createApi();
    stubMessages(api);
    api.localConnector.isConnected.mockReturnValue(false);

    const request = api.messageQueueHandler.sendRequest("d2", "app_start", []);
    const outcome = expect(request).rejects.toThrow("Cloud request");
    await jest.advanceTimersByTimeAsync(10000);

    await outcome;
    expect(api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps scene items on the local connection", async () => {
    jest.useFakeTimers();
    const api = createApi();
    stubMessages(api);

    const request = api.messageQueueHandler.sendLocalRequest(
      "d1",
      "do_scenes_app_start",
      []
    );
    const outcome = expect(request).rejects.toThrow("Local request");
    await jest.advanceTimersByTimeAsync(10000);

    await outcome;
    expect(api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  it("logs a cloud fallback once per method and robot", async () => {
    const api = createApi();
    stubMessages(api);
    answerOverCloud(api, ["ok"]);
    api.localConnector.isConnected.mockReturnValue(false);

    await api.messageQueueHandler.sendRequest("d2", "app_start", []);
    await api.messageQueueHandler.sendRequest("d2", "app_start", []);
    await api.messageQueueHandler.sendRequest("d2", "app_charge", []);

    const fallbacks = api.log.info.mock.calls.filter(([message]: [string]) =>
      message.includes("Falling back to cloud")
    );
    expect(fallbacks).toHaveLength(2);
  });
});

describe("cloud MQTT replies", () => {
  function pending(api: any, awaitsPayload: boolean) {
    const resolve = jest.fn();
    api.pendingRequests.set(7, {
      resolve,
      reject: jest.fn(),
      timeout: setTimeout(() => undefined, 10000),
      awaitsPayload,
    });
    return resolve;
  }

  it('settles a command answered with ["ok"] instead of letting it time out', () => {
    const api = createApi();
    const resolve = pending(api, false);

    api.rr_mqtt_connector.resolveResponse({ id: 7, result: ["ok"] });

    expect(resolve).toHaveBeenCalledWith(["ok"]);
    expect(api.pendingRequests.has(7)).toBe(false);
  });

  it("keeps a secure request waiting for its data after the ok acknowledgement", () => {
    const api = createApi();
    const resolve = pending(api, true);

    api.rr_mqtt_connector.resolveResponse({ id: 7, result: "ok" });
    expect(resolve).not.toHaveBeenCalled();

    api.rr_mqtt_connector.resolveResponse({ id: 7, result: [{ map: 1 }] });
    expect(resolve).toHaveBeenCalledWith([{ map: 1 }]);
  });

  it("marks only secure and photo requests as waiting for a payload", async () => {
    const api = createApi();
    api.message.buildPayload = jest.fn(async () => "{}");
    api.message.buildRoborockMessage = jest.fn(async () => Buffer.from("x"));
    api.rr_mqtt_connector.sendMessage = jest.fn();
    api.localConnector.isConnected.mockReturnValue(false);

    api.messageQueueHandler.sendRequest("d2", "app_start", []);
    api.messageQueueHandler.sendRequest("d2", "get_map_v1", [], true);
    await new Promise((resolve) => setImmediate(resolve));

    const flags = [...api.pendingRequests.values()].map(
      (request: any) => request.awaitsPayload
    );
    expect(flags).toEqual([false, true]);
    api.clearTimersAndIntervals();
  });
});

describe("Roborock active status polling", () => {
  function createPollingApi(state: number) {
    const api = createApi();
    api.recordLiveStatus("d1", { state });
    api.pollStatus = jest.fn();
    return api;
  }

  it("polls a cleaning, returning or docking robot", async () => {
    for (const state of [5, 6, 15]) {
      const api = createPollingApi(state);
      await api.pollActiveStatus("d1");
      expect(api.pollStatus).toHaveBeenCalledWith("d1");
    }
  });

  it("leaves an idle robot to the regular poll while cloud pushes work", async () => {
    const api = createPollingApi(8);
    await api.pollActiveStatus("d1");
    expect(api.pollStatus).not.toHaveBeenCalled();
  });

  it("polls an idle robot while the cloud push channel is down", async () => {
    const api = createPollingApi(8);
    api.rr_mqtt_connector.isConnected.mockReturnValue(false);
    await api.pollActiveStatus("d1");
    expect(api.pollStatus).toHaveBeenCalledWith("d1");
  });

  it("does not poll a robot without a local connection", async () => {
    const api = createPollingApi(5);
    api.localConnector.isConnected.mockReturnValue(false);
    await api.pollActiveStatus("d1");
    expect(api.pollStatus).not.toHaveBeenCalled();
  });

  it("runs the short poll every 15 s next to the regular interval", () => {
    const api = createApi();
    api.setInterval = jest.fn(() => 1);
    api.startDeviceIntervals("d1");
    expect(api.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      15000,
      "d1"
    );
    expect(api.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      180000,
      "d1",
      api.vacuums["d1"],
      "roborock.vacuum.a87"
    );
  });
});

describe("Roborock local consumable readings", () => {
  it("computes remaining life from get_consumable work times", () => {
    const api = createApi();
    api.deviceNotify = jest.fn();

    // Values read from a real robot; the cloud snapshot showed 93, 74, 86.
    api.recordConsumables("d1", {
      main_brush_work_time: 76227,
      side_brush_work_time: 188182,
      filter_work_time: 76227,
    });

    expect(api.getVacuumDeviceStatus("d1", "main_brush_life")).toBe(93);
    expect(api.getVacuumDeviceStatus("d1", "side_brush_life")).toBe(74);
    expect(api.getVacuumDeviceStatus("d1", "filter_life")).toBe(86);
    expect(api.deviceNotify).toHaveBeenCalledWith(
      "LocalMessage",
      { main_brush_life: 93, side_brush_life: 74, filter_life: 86 },
      "d1"
    );
  });

  it("never reports less than 0 % for a worn-out consumable", () => {
    const api = createApi();
    api.recordConsumables("d1", { filter_work_time: 600000 });
    expect(api.getVacuumDeviceStatus("d1", "filter_life")).toBe(0);
  });

  it("keeps the cloud snapshot for a consumable the robot did not report", () => {
    const api = createApi();
    api.recordConsumables("d1", { filter_work_time: 76227 });
    expect(api.getVacuumDeviceStatus("d1", "main_brush_life")).toBe(50);
  });

  it("is fed by the regular get_consumable poll", async () => {
    const { vacuum } = require("../roborockLib/lib/vacuum");
    const adapter = {
      log: createLogger(),
      messageQueueHandler: {
        sendRequest: jest.fn().mockResolvedValue([{ filter_work_time: 1 }]),
      },
      vacuums: { d1: { features: { getConsumablesDivider: () => 3600 } } },
      setStateAsync: jest.fn(),
      recordConsumables: jest.fn(),
      catchError: jest.fn(),
    };

    await new vacuum(adapter, "roborock.vacuum.a87").getParameter(
      "d1",
      "get_consumable"
    );

    expect(adapter.recordConsumables).toHaveBeenCalledWith("d1", {
      filter_work_time: 1,
    });
  });
});

describe("localConnector address rediscovery", () => {
  function createConnectorApi(discovered: Record<string, string>) {
    const api = createApi();
    api.localConnector.getLocalDevices = jest
      .fn()
      .mockResolvedValue(discovered);
    api.vacuums["d1"].getParameter = jest.fn();
    api.persistLocalDevices = jest.fn();
    return api;
  }

  it("uses UDP discovery before asking the cloud", async () => {
    const api = createConnectorApi({ d1: "10.0.0.5" });

    await expect(api.localConnector.refreshLocalIp("d1")).resolves.toBe(
      "10.0.0.5"
    );
    expect(api.localDevices["d1"]).toBe("10.0.0.5");
    expect(api.persistLocalDevices).toHaveBeenCalled();
    expect(api.vacuums["d1"].getParameter).not.toHaveBeenCalled();
  });

  it("asks the cloud when UDP discovery does not find the robot", async () => {
    const api = createConnectorApi({ d2: "10.0.0.6" });

    await api.localConnector.refreshLocalIp("d1");

    expect(api.vacuums["d1"].getParameter).toHaveBeenCalledWith(
      "d1",
      "get_network_info"
    );
  });

  it("shares one discovery between robots reconnecting together", async () => {
    const api = createConnectorApi({ d1: "10.0.0.5", d2: "10.0.0.6" });

    await Promise.all([
      api.localConnector.refreshLocalIp("d1"),
      api.localConnector.refreshLocalIp("d2"),
    ]);

    expect(api.localConnector.getLocalDevices).toHaveBeenCalledTimes(1);
  });
});

// Scenes as the Roborock cloud returns them: param is a JSON string whose
// items carry the RPC as another JSON string.
function sceneItem(duid: string, method: string, params: unknown) {
  return {
    type: "CMD",
    entityId: duid,
    finishDpIds: [130],
    param: JSON.stringify({ id: 1, method, params }),
  };
}

function scene(id: number, items: unknown[]) {
  return {
    id,
    name: `Scene ${id}`,
    enabled: true,
    type: "WORKFLOW",
    param: JSON.stringify({ triggers: [], action: { type: "S", items } }),
  };
}

const FULL_CLEAN = [
  {
    fan_power: 108,
    water_box_mode: 200,
    mop_mode: 300,
    repeat: 1,
    source: 101,
  },
];
const MOP_PASS = [{ fan_power: 105, water_box_mode: 202, source: 101 }];

describe("Roborock scene cache", () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "roborock-test-"));
  });

  afterEach(() => {
    fs.rmSync(storagePath, { force: true, recursive: true });
  });

  async function fetchScenes(api: any, scenes: unknown[]) {
    api.loginApi = {};
    api.homeId = 4242;
    api.api = {
      get: jest.fn().mockResolvedValue({ data: { result: scenes } }),
    };
    await api.getScenes();
  }

  it("writes every fetched scene list to disk, owner-only", async () => {
    const api = createApi({ storagePath });
    await fetchScenes(api, [scene(1, [])]);

    const file = path.join(storagePath, "roborock.Scenes");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      account: "user@example.com",
      val: { result: [{ id: 1 }] },
    });
  });

  it("serves the cached list after a restart and ignores another account's", async () => {
    await fetchScenes(createApi({ storagePath }), [scene(1, [])]);

    const restarted = createApi({ storagePath });
    expect(restarted.loadCachedScenes().result[0].id).toBe(1);

    const otherAccount = createApi({
      storagePath,
      username: "other@example.com",
    });
    expect(otherAccount.loadCachedScenes()).toBeNull();
  });

  it("loads the cached scenes on a local-only start", async () => {
    await fetchScenes(createApi({ storagePath }), [
      scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)]),
    ]);

    const api = createApi({ storagePath });
    api.setInterval = jest.fn(() => 0);
    api.localConnector.getLocalDevices = jest.fn().mockResolvedValue({});
    api.localConnector.createClient = jest.fn();
    api.loadSharedDeviceRooms = jest.fn();
    api.createDevices = jest.fn();
    api.getNetworkInfo = jest.fn();
    api.initializeDeviceUpdates = jest.fn();
    api.updateHomeData = jest.fn();

    await api.initializeFromHomeData(null, HOME_DATA, null, true);

    expect(api.getScenesForDevice("d1").map((s: any) => s.id)).toEqual([1]);
  });
});

describe("Roborock local scene execution", () => {
  // Status reads return the queued get_status results in order; the last one
  // repeats.
  function createSceneApi(scenes: unknown[], statuses: object[] = []) {
    const api = createApi();
    api.bInited = true;
    api.scenesData = { result: scenes };
    api.api = { post: jest.fn() };
    api.messageQueueHandler.sendLocalRequest = jest
      .fn()
      .mockResolvedValue(["ok"]);
    api.pollStatus = jest.fn(async (duid: string) => {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      api.recordLiveStatus(duid, status);
      return status !== undefined;
    });
    return api;
  }

  const CLEANING = { state: 5, in_cleaning: 1, error_code: 0 };
  const EMPTYING = { state: 22, in_cleaning: 0, error_code: 0 };
  const DOCKED = { state: 8, in_cleaning: 0, error_code: 0 };

  it("sends the items' commands verbatim over the local connection", async () => {
    const api = createSceneApi([
      scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)]),
    ]);

    await api.executeScene({ val: "1" });

    expect(api.messageQueueHandler.sendLocalRequest).toHaveBeenCalledWith(
      "d1",
      "do_scenes_app_start",
      FULL_CLEAN
    );
    expect(api.api.post).not.toHaveBeenCalled();
    api.sceneRunner.cancelAll();
  });

  it("asks the cloud when a target robot has no local connection", async () => {
    const api = createSceneApi([
      scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)]),
    ]);
    api.localConnector.isConnected.mockReturnValue(false);

    await api.executeScene({ val: 1 });

    expect(api.messageQueueHandler.sendLocalRequest).not.toHaveBeenCalled();
    expect(api.api.post).toHaveBeenCalledWith("user/scene/1/execute");
  });

  it("asks the cloud for a robot whose local connection does not answer", async () => {
    const api = createSceneApi([
      scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)]),
    ]);
    api.localCloudPreference.set("d1", Date.now() + 60000);

    await api.executeScene({ val: 1 });

    expect(api.messageQueueHandler.sendLocalRequest).not.toHaveBeenCalled();
    expect(api.api.post).toHaveBeenCalledWith("user/scene/1/execute");
  });

  it("asks the cloud for a shared target robot", async () => {
    const api = createSceneApi([
      scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)]),
    ]);
    api.receivedDevices = [{ duid: "d1" }];

    await api.executeScene({ val: 1 });

    expect(api.api.post).toHaveBeenCalledWith("user/scene/1/execute");
  });

  it("asks the cloud for a scene with an item that is not a device command", async () => {
    const api = createSceneApi([
      scene(1, [
        sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
        { type: "DELAY", param: "{}" },
      ]),
      scene(2, [{ ...sceneItem("d1", "x", []), param: "not json" }]),
    ]);

    await api.executeScene({ val: 1 });
    await api.executeScene({ val: 2 });

    expect(api.messageQueueHandler.sendLocalRequest).not.toHaveBeenCalled();
    expect(api.api.post).toHaveBeenCalledWith("user/scene/1/execute");
    expect(api.api.post).toHaveBeenCalledWith("user/scene/2/execute");
  });

  it("asks the cloud when the robot rejects the first item", async () => {
    const api = createSceneApi(
      [scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)])],
      [DOCKED]
    );
    api.messageQueueHandler.sendLocalRequest.mockResolvedValue(undefined);

    await api.executeScene({ val: 1 });

    expect(api.api.post).toHaveBeenCalledWith("user/scene/1/execute");
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not start locally")
    );
  });

  it("does not run the scene twice when the reply is lost but the robot started", async () => {
    const api = createSceneApi(
      [scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)])],
      [CLEANING]
    );
    api.messageQueueHandler.sendLocalRequest.mockRejectedValue(
      new Error("Local request timed out")
    );

    await api.executeScene({ val: 1 });

    expect(api.api.post).not.toHaveBeenCalled();
    api.sceneRunner.cancelAll();
  });

  it("does not adopt a clean that was running before the scene", async () => {
    const api = createSceneApi(
      [scene(1, [sceneItem("d1", "do_scenes_app_start", FULL_CLEAN)])],
      [CLEANING]
    );
    api.recordLiveStatus("d1", CLEANING);
    api.messageQueueHandler.sendLocalRequest.mockResolvedValue(undefined);

    await api.executeScene({ val: 1 });

    expect(api.api.post).toHaveBeenCalledWith("user/scene/1/execute");
  });

  it("sends the next item only after the robot finished and the dock is done", async () => {
    jest.useFakeTimers();
    const api = createSceneApi(
      [
        scene(1, [
          sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
          sceneItem("d1", "do_scenes_app_start", MOP_PASS),
        ]),
      ],
      [CLEANING, CLEANING, EMPTYING, DOCKED]
    );
    const send = api.messageQueueHandler.sendLocalRequest;

    await api.executeScene({ val: 1 });
    expect(send).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(45000); // cleaning, cleaning, emptying
    expect(send).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15000); // docked
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      "d1",
      "do_scenes_app_start",
      MOP_PASS
    );
    api.sceneRunner.cancelAll();
  });

  it("stops and logs the skipped items when the robot reports an error", async () => {
    jest.useFakeTimers();
    const api = createSceneApi(
      [
        scene(1, [
          sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
          sceneItem("d1", "do_scenes_app_start", MOP_PASS),
        ]),
      ],
      [CLEANING, { state: 12, in_cleaning: 1, error_code: 3 }]
    );

    await api.executeScene({ val: 1 });
    await jest.advanceTimersByTimeAsync(60000);

    expect(api.messageQueueHandler.sendLocalRequest).toHaveBeenCalledTimes(1);
    expect(api.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Items not run: 2 (do_scenes_app_start)")
    );
    expect(api.sceneRunner.runs.size).toBe(0);
  });

  it("drops the remaining items when the robot is docked from Apple Home", async () => {
    jest.useFakeTimers();
    const api = createSceneApi(
      [
        scene(1, [
          sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
          sceneItem("d1", "do_scenes_app_start", MOP_PASS),
        ]),
      ],
      [CLEANING, DOCKED]
    );

    await api.executeScene({ val: 1 });
    await api.app_charge("d1");
    await jest.advanceTimersByTimeAsync(120000);

    expect(api.vacuums["d1"].command).toHaveBeenCalledWith(
      "d1",
      "app_charge",
      null
    );
    expect(api.messageQueueHandler.sendLocalRequest).toHaveBeenCalledTimes(1);
    expect(api.pollStatus).toHaveBeenCalledTimes(0);
  });

  it("ignores a stale status while get_status cannot be read", async () => {
    jest.useFakeTimers();
    const api = createSceneApi([
      scene(1, [
        sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
        sceneItem("d1", "do_scenes_app_start", MOP_PASS),
      ]),
    ]);
    api.pollStatus.mockImplementationOnce(async () => {
      api.recordLiveStatus("d1", CLEANING);
      return true;
    });
    // Later polls fail and leave a docked status behind.
    api.pollStatus.mockImplementation(async () => {
      api.recordLiveStatus("d1", DOCKED);
      return false;
    });

    await api.executeScene({ val: 1 });
    await jest.advanceTimersByTimeAsync(120000);

    expect(api.messageQueueHandler.sendLocalRequest).toHaveBeenCalledTimes(1);
    api.sceneRunner.cancelAll();
  });

  it("does not send the next item when cancelled during a status read", async () => {
    jest.useFakeTimers();
    const api = createSceneApi(
      [
        scene(1, [
          sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
          sceneItem("d1", "do_scenes_app_start", MOP_PASS),
        ]),
      ],
      [CLEANING]
    );
    api.pollStatus.mockImplementation(async (duid: string) => {
      api.recordLiveStatus(
        duid,
        api.pollStatus.mock.calls.length > 1 ? DOCKED : CLEANING
      );
      if (api.pollStatus.mock.calls.length === 2) {
        await api.app_stop("d1"); // the user stops it while the read is in flight
      }
      return true;
    });

    await api.executeScene({ val: 1 });
    await jest.advanceTimersByTimeAsync(60000);

    expect(api.messageQueueHandler.sendLocalRequest).toHaveBeenCalledTimes(1);
  });

  it("drops the earlier run when another scene for the same robot starts", async () => {
    jest.useFakeTimers();
    const api = createSceneApi(
      [
        scene(1, [
          sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
          sceneItem("d1", "do_scenes_app_start", MOP_PASS),
        ]),
        scene(2, [sceneItem("d1", "do_scenes_segments", { source: 101 })]),
      ],
      [CLEANING, DOCKED]
    );

    await api.executeScene({ val: 1 });
    await api.executeScene({ val: 2 });
    await jest.advanceTimersByTimeAsync(120000);

    const methods = api.messageQueueHandler.sendLocalRequest.mock.calls.map(
      (call: unknown[]) => call[2]
    );
    expect(methods).toEqual([FULL_CLEAN, { source: 101 }]);
  });

  it("sends nothing more after a shutdown", async () => {
    jest.useFakeTimers();
    const api = createSceneApi(
      [
        scene(1, [
          sceneItem("d1", "do_scenes_app_start", FULL_CLEAN),
          sceneItem("d1", "do_scenes_app_start", MOP_PASS),
        ]),
      ],
      [CLEANING, DOCKED]
    );
    api.localConnector.shutdown = jest.fn();
    api.rr_mqtt_connector.disconnectClient = jest.fn();

    await api.executeScene({ val: 1 });
    api.clearTimersAndIntervals();
    await jest.advanceTimersByTimeAsync(120000);

    expect(api.messageQueueHandler.sendLocalRequest).toHaveBeenCalledTimes(1);
  });
});
