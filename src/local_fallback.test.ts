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

const USER_DATA = {
  token: "token",
  rriot: {
    u: "u",
    s: "s",
    h: "h",
    k: "k",
    r: { a: "https://example.invalid", m: "mqtt://example.invalid" },
  },
};

const HOME_DATA = {
  products: [{ id: "p1", model: "roborock.vacuum.a27" }],
  devices: [
    {
      duid: "d1",
      name: "Vacuum",
      productId: "p1",
      localKey: "0123456789abcdef",
      pv: "1.0",
      online: false,
    },
  ],
  receivedDevices: [],
  rooms: [{ id: 1, name: "Kitchen" }],
};

/**
 * A Roborock instance whose slow/networked collaborators are stubbed, so the
 * tests exercise the startup decision (cloud vs cached home data) rather than
 * the transports.
 */
function createApi(storagePath: string) {
  const api = new Roborock({
    username: "user@example.com",
    password: "secret",
    // An explicit baseURL skips the region-discovery network calls.
    baseURL: "usiot.roborock.com",
    storagePath,
    userData: USER_DATA,
    log: createLogger(),
  });

  api.setInterval = jest.fn(() => 0);
  api.clearInterval = jest.fn();
  api.rr_mqtt_connector.initUser = jest.fn();
  api.rr_mqtt_connector.initMQTT_Subscribe = jest.fn();
  api.rr_mqtt_connector.initMQTT_Message = jest.fn();
  api.localConnector.getLocalDevices = jest.fn().mockResolvedValue({});
  api.localConnector.createClient = jest.fn();
  api.loadSharedDeviceRooms = jest.fn();
  api.createDevices = jest.fn();
  api.getNetworkInfo = jest.fn();
  api.initializeDeviceUpdates = jest.fn();
  api.updateHomeData = jest.fn();

  return api;
}

describe("Roborock startup without the cloud", () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "roborock-test-"));
  });

  afterEach(() => {
    fs.rmSync(storagePath, { force: true, recursive: true });
  });

  it("starts in local-only mode from cached home data when the cloud fails", async () => {
    const api = createApi(storagePath);
    api.fetchHomeDataFromCloud = jest
      .fn()
      .mockRejectedValue(new Error("timeout of 20000ms exceeded"));
    api.states["HomeData"] = { val: JSON.stringify(HOME_DATA), ack: true };

    const callback = jest.fn();
    await api.startService(callback);

    expect(api.isInited()).toBe(true);
    expect(api.localKeys.get("d1")).toBe("0123456789abcdef");
    expect(api.devices).toHaveLength(1);
    expect(api.roomIDs[1]).toBe("Kitchen");
    // The local transport is still brought up, and the cloud MQTT client is
    // started too so it can reconnect on its own.
    expect(api.localConnector.getLocalDevices).toHaveBeenCalled();
    expect(api.rr_mqtt_connector.initUser).toHaveBeenCalled();
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("LOCAL-ONLY")
    );
    expect(callback).toHaveBeenCalled();
  });

  it("serves the device list from the on-disk cache after a restart", async () => {
    // The realistic outage: the cache exists only on disk, with nothing in
    // memory. Everything downstream reads home data through getParsedHomeData,
    // so the cached copy has to become the live state — otherwise the platform
    // sees an empty account and unregisters every cached accessory.
    const seed = createApi(storagePath);
    await seed.setStateAsync("HomeData", {
      val: JSON.stringify(HOME_DATA),
      ack: true,
    });
    await seed.setStateAsync("HomeId", { val: 4242, ack: true });

    const api = createApi(storagePath);
    api.fetchHomeDataFromCloud = jest
      .fn()
      .mockRejectedValue(new Error("timeout of 20000ms exceeded"));

    await api.startService();

    expect(api.isInited()).toBe(true);
    expect(api.getVacuumList().map((device: any) => device.duid)).toEqual([
      "d1",
    ]);
    expect(api.getVacuumDeviceData("d1").name).toBe("Vacuum");
    expect(await api.getRobotVersion("d1")).toBe("1.0");
    expect(api.getProductAttribute("d1", "model")).toBe("roborock.vacuum.a27");
    expect(api.homeId).toBe(4242);
  });

  it("stays idle when the cloud fails and nothing is cached", async () => {
    const api = createApi(storagePath);
    api.fetchHomeDataFromCloud = jest
      .fn()
      .mockRejectedValue(new Error("ECONNRESET"));

    const callback = jest.fn();
    await api.startService(callback);

    expect(api.isInited()).toBe(false);
    expect(api.localConnector.getLocalDevices).not.toHaveBeenCalled();
    expect(api.log.error).toHaveBeenCalledWith(
      expect.stringContaining("No cached device data")
    );
    expect(callback).toHaveBeenCalled();
  });

  it("caches home data and the home id after a successful cloud start", async () => {
    const api = createApi(storagePath);
    api.fetchHomeDataFromCloud = jest
      .fn()
      .mockResolvedValue({ homeId: 4242, homedataResult: HOME_DATA });

    await api.startService();

    expect(api.isInited()).toBe(true);
    expect(api.homeId).toBe(4242);

    const cachedHomeData = JSON.parse(
      fs.readFileSync(path.join(storagePath, "roborock.HomeData"), "utf8")
    );
    expect(JSON.parse(cachedHomeData.val).devices[0].duid).toBe("d1");

    const cachedHomeId = JSON.parse(
      fs.readFileSync(path.join(storagePath, "roborock.HomeId"), "utf8")
    );
    expect(cachedHomeId.val).toBe(4242);

    // Home data carries per-device localKey secrets, so it must not be
    // world-readable.
    const mode = fs.statSync(path.join(storagePath, "roborock.HomeData")).mode;
    expect(mode & 0o077).toBe(0);
  });

  it("reloads cached home data written by an earlier run", async () => {
    const seed = createApi(storagePath);
    await seed.setStateAsync("HomeData", {
      val: JSON.stringify(HOME_DATA),
      ack: true,
    });
    await seed.setStateAsync("HomeId", { val: 99, ack: true });

    const api = createApi(storagePath);
    const cached = api.loadCachedHomeData();

    expect(cached.homeId).toBe(99);
    expect(cached.homedataResult.devices[0].duid).toBe("d1");
  });

  it("reports no cached home data when none was ever stored", () => {
    const api = createApi(storagePath);
    expect(api.loadCachedHomeData()).toBeNull();
  });
});

describe("Roborock.onlineChecker", () => {
  it("treats a locally connected device as online despite a stale cloud flag", async () => {
    const api = new Roborock({ log: createLogger() });
    // HOME_DATA marks d1 as online: false, which is what a cached snapshot
    // looks like after a cloud outage.
    api.states["HomeData"] = { val: JSON.stringify(HOME_DATA), ack: true };

    // The cached flag alone reports the device as not reachable.
    expect(await api.onlineChecker("d1")).toBeFalsy();

    api.localConnector.isConnected = jest.fn((duid: string) => duid === "d1");

    expect(await api.onlineChecker("d1")).toBe(true);
    expect(await api.onlineChecker("unknown")).toBeFalsy();
  });
});

describe("Roborock.updateHomeData cloud recovery", () => {
  it("learns the home id once the cloud answers again", async () => {
    const api = new Roborock({ log: createLogger() });
    api.setStateAsync = jest.fn();
    api.loginApi = {
      get: jest.fn().mockResolvedValue({ data: { data: { rrHomeId: 7 } } }),
    };
    api.api = { get: jest.fn().mockResolvedValue({ data: { result: null } }) };

    await api.updateHomeData(null);

    expect(api.homeId).toBe(7);
    expect(api.setStateAsync).toHaveBeenCalledWith("HomeId", {
      val: 7,
      ack: true,
    });
    expect(api.api.get).toHaveBeenCalledWith("user/homes/7");
  });

  it("retries later while the cloud is still unreachable", async () => {
    const api = new Roborock({ log: createLogger() });
    api.loginApi = { get: jest.fn().mockRejectedValue(new Error("timeout")) };
    api.api = { get: jest.fn() };

    await api.updateHomeData(null);

    expect(api.homeId).toBeNull();
    expect(api.api.get).not.toHaveBeenCalled();
  });
});

describe("Roborock local-only start without a session or discovery", () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "roborock-test-"));
  });

  afterEach(() => {
    fs.rmSync(storagePath, { force: true, recursive: true });
  });

  it("starts local-only from the cache when the login fails", async () => {
    const seed = createApi(storagePath);
    await seed.setStateAsync("HomeData", seed.homeDataState(HOME_DATA));
    await seed.setStateAsync("HomeId", { val: 4242, ack: true });

    const api = createApi(storagePath);
    api.getUserData = jest.fn().mockResolvedValue(null);
    api.fetchHomeDataFromCloud = jest.fn();

    await api.startService();

    expect(api.isInited()).toBe(true);
    expect(api.api).toBeFalsy();
    expect(api.fetchHomeDataFromCloud).not.toHaveBeenCalled();
    expect(api.rr_mqtt_connector.initUser).not.toHaveBeenCalled();
    expect(api.getVacuumList().map((device: any) => device.duid)).toEqual([
      "d1",
    ]);
  });

  it("dials the cached LAN address when discovery finds nothing", async () => {
    const seed = createApi(storagePath);
    await seed.setStateAsync("HomeData", seed.homeDataState(HOME_DATA));
    await seed.setStateAsync("LocalDevices", {
      val: { d1: "10.0.0.5", removed: "10.0.0.6" },
      ack: true,
    });

    const api = createApi(storagePath);
    api.fetchHomeDataFromCloud = jest
      .fn()
      .mockRejectedValue(new Error("timeout"));

    await api.startService();

    expect(api.localConnector.createClient).toHaveBeenCalledTimes(1);
    expect(api.localConnector.createClient).toHaveBeenCalledWith(
      "d1",
      "10.0.0.5"
    );
  });

  it("remembers discovered LAN addresses for the next offline start", async () => {
    const api = createApi(storagePath);
    api.fetchHomeDataFromCloud = jest
      .fn()
      .mockResolvedValue({ homeId: 1, homedataResult: HOME_DATA });
    api.localConnector.getLocalDevices = jest
      .fn()
      .mockResolvedValue({ d1: "10.0.0.9" });

    await api.startService();

    const cached = JSON.parse(
      fs.readFileSync(path.join(storagePath, "roborock.LocalDevices"), "utf8")
    );
    expect(cached.val).toEqual({ d1: "10.0.0.9" });
  });

  it("ignores a cache written for another account", async () => {
    const seed = createApi(storagePath);
    await seed.setStateAsync("HomeData", {
      ...seed.homeDataState(HOME_DATA),
      account: "other@example.com",
    });

    expect(createApi(storagePath).loadCachedHomeData()).toBeNull();
  });
});

describe("Roborock session handling during a cloud outage", () => {
  function createSessionApi(getHomeDetail: jest.Mock) {
    const api = new Roborock({
      username: "user@example.com",
      log: createLogger(),
    });
    api.userData = { ...USER_DATA };
    api.loginApi = { get: getHomeDetail };
    api.api = { get: jest.fn() };
    api.deleteStateAsync = jest.fn();
    api.clearInterval = jest.fn();
    return api;
  }

  it("keeps the session when getHomeDetail answers without a rejection", async () => {
    const api = createSessionApi(jest.fn().mockResolvedValue({ data: {} }));

    await expect(api.fetchHomeDataFromCloud()).rejects.toThrow(
      "no usable data"
    );
    expect(api.deleteStateAsync).not.toHaveBeenCalled();
    expect(api.userData).not.toBeNull();
  });

  it("clears the session when getHomeDetail rejects it with an API code", async () => {
    const api = createSessionApi(
      jest
        .fn()
        .mockResolvedValue({ data: { code: 2010, msg: "invalid token" } })
    );

    await expect(api.fetchHomeDataFromCloud()).rejects.toThrow("rejected");
    expect(api.deleteStateAsync).toHaveBeenCalledWith("UserData");
    expect(api.userData).toBeNull();
  });

  it("keeps the session on a 401 the login API does not confirm", async () => {
    const api = createSessionApi(
      jest
        .fn()
        .mockResolvedValue({ data: { code: 200, data: { rrHomeId: 1 } } })
    );
    const error = { response: { status: 401, headers: {} } };

    expect(await api.handleApiUnauthorized(error, "test")).toBe(true);
    expect(api.deleteStateAsync).not.toHaveBeenCalled();
    expect(api.sessionInvalidated).toBeFalsy();
  });

  it("clears the session on a 401 the login API confirms", async () => {
    const api = createSessionApi(
      jest.fn().mockResolvedValue({ data: { code: 2010 } })
    );
    const error = { response: { status: 401, headers: {} } };

    expect(await api.handleApiUnauthorized(error, "test")).toBe(true);
    expect(api.deleteStateAsync).toHaveBeenCalledWith("UserData");
    expect(api.userData).toBeNull();
  });
});

describe("Roborock cloud re-login after a session-less start", () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "roborock-test-"));
  });

  afterEach(() => {
    fs.rmSync(storagePath, { force: true, recursive: true });
  });

  function createOfflineApi() {
    const api = new Roborock({
      username: "user@example.com",
      password: "secret",
      storagePath,
      log: createLogger(),
    });
    api.userData = null;
    api.homeId = 4242;
    api.loginApi = { defaults: { headers: { common: {} } }, get: jest.fn() };
    api.setStateAsync = jest.fn();
    api.deleteStateAsync = jest.fn();
    api.initCloudMqtt = jest.fn();
    api.getScenes = jest.fn();
    return api;
  }

  it("logs in again and refreshes home data once the cloud answers", async () => {
    const api = createOfflineApi();
    api.getUserData = jest.fn().mockResolvedValue(USER_DATA);
    api.setupCloudApi = jest.fn((userdata: any) => {
      api.userData = userdata;
      api.api = {
        get: jest.fn().mockResolvedValue({ data: { result: HOME_DATA } }),
      };
    });

    await api.updateHomeData(null);

    expect(api.initCloudMqtt).toHaveBeenCalledWith(USER_DATA);
    expect(api.api.get).toHaveBeenCalledWith("user/homes/4242");
    expect(api.setStateAsync).toHaveBeenCalledWith(
      "HomeData",
      expect.objectContaining({ account: "user@example.com" })
    );
  });

  it("does not repeat a rejected login every interval", async () => {
    const api = createOfflineApi();
    api.loginRetryable = false;
    api.getUserData = jest.fn();

    await api.updateHomeData(null);

    expect(api.getUserData).not.toHaveBeenCalled();
  });

  it("retries only network-level login failures", async () => {
    const roborockAuth = require("../roborockLib/lib/roborockAuth");
    const login = jest.spyOn(roborockAuth, "loginByPassword");
    const api = createOfflineApi();
    api.ensureAuthSignature = jest.fn().mockResolvedValue({ k: "k", s: "s" });

    login.mockRejectedValueOnce(
      Object.assign(new Error("ECONNRESET"), { isRequestError: true })
    );
    expect(await api.getUserData(api.loginApi)).toBeNull();
    expect(api.loginRetryable).toBe(true);

    login.mockResolvedValueOnce({ code: 2012, msg: "wrong password" });
    expect(await api.getUserData(api.loginApi)).toBeNull();
    expect(api.loginRetryable).toBe(false);

    login.mockRestore();
  });
});
