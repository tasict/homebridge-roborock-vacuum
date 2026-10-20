import * as crypto from "crypto";

const { Roborock } = require("../roborockLib/roborockAPI");
const { localConnector } = require("../roborockLib/lib/localConnector");
const { vacuum } = require("../roborockLib/lib/vacuum");
const { deviceFeatures } = require("../roborockLib/lib/deviceFeatures");

function createLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  return new Roborock({ log: createLogger() });
}

describe("localConnector.decryptECB", () => {
  it("round-trips a PKCS7-padded AES-128-ECB payload", () => {
    const connector = new localConnector({ log: createLogger() });
    const key = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");
    const payload = JSON.stringify({ duid: "abc123", ip: "192.168.1.50" });

    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([
      cipher.update(payload, "utf8"),
      cipher.final(),
    ]);

    const decrypted = connector.decryptECB(encrypted, key);
    expect(decrypted).not.toBeNull();
    expect(JSON.parse(decrypted)).toEqual({
      duid: "abc123",
      ip: "192.168.1.50",
    });
  });

  it("returns null for a truncated ciphertext", () => {
    const connector = new localConnector({ log: createLogger() });
    const key = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

    expect(connector.decryptECB(Buffer.alloc(15), key)).toBeNull();
  });
});

describe("deviceFeatures.processDockType", () => {
  function createFeatures() {
    const adapter = { log: createLogger() };
    const features = new deviceFeatures(adapter, 0, "0", "duid1");
    const spies = {
      collect: jest.spyOn(features, "isDustCollectionSettingSupported"),
      wash: jest.spyOn(features, "isWashThenChargeCmdSupported"),
      dry: jest.spyOn(features, "isSupportedDrying"),
    };
    return { features, spies };
  }

  it("enables no dock features for a plain charging dock (0)", () => {
    const { features, spies } = createFeatures();
    features.processDockType(0);
    expect(spies.collect).not.toHaveBeenCalled();
    expect(spies.wash).not.toHaveBeenCalled();
    expect(spies.dry).not.toHaveBeenCalled();
  });

  it("enables only dust collection for auto-empty docks (1, 5)", () => {
    for (const dockType of [1, 5]) {
      const { features, spies } = createFeatures();
      features.processDockType(dockType);
      expect(spies.collect).toHaveBeenCalled();
      expect(spies.wash).not.toHaveBeenCalled();
      expect(spies.dry).not.toHaveBeenCalled();
    }
  });

  it("treats new dock generations (codes 10-40) as full-featured", () => {
    for (const dockType of [10, 17, 18, 22, 27, 40]) {
      const { features, spies } = createFeatures();
      features.processDockType(dockType);
      expect(spies.collect).toHaveBeenCalled();
      expect(spies.wash).toHaveBeenCalled();
      expect(spies.dry).toHaveBeenCalled();
    }
  });
});

describe("Roborock.isDockWashSupported", () => {
  it("reports wash support for washing docks and new dock codes", () => {
    const api = createApi();
    for (const dockType of [2, 3, 6, 7, 8, 9, 17, 27, 40]) {
      api.states["Devices.d1.deviceStatus.dock_type"] = {
        val: dockType,
        ack: true,
      };
      expect(api.isDockWashSupported("d1")).toBe(true);
    }
  });

  it("reports no wash support for charge/auto-empty docks and unknown state", () => {
    const api = createApi();
    for (const dockType of [0, 1, 5]) {
      api.states["Devices.d1.deviceStatus.dock_type"] = {
        val: dockType,
        ack: true,
      };
      expect(api.isDockWashSupported("d1")).toBe(false);
    }

    expect(api.isDockWashSupported("no-such-device")).toBe(false);
  });
});

describe("Roborock.handleApiUnauthorized", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("ignores errors that are not HTTP 401", async () => {
    const api = createApi();
    expect(await api.handleApiUnauthorized(new Error("boom"), "test")).toBe(
      false
    );
    expect(
      await api.handleApiUnauthorized(
        { response: { status: 500, headers: {} } },
        "test"
      )
    ).toBe(false);
  });

  it("clears the session and stops HomeData polling on a session 401", async () => {
    const api = createApi();
    api.deleteStateAsync = jest.fn();
    api.userData = { rriot: {} };
    api.homedataInterval = setInterval(() => {}, 1000000);
    // The login API confirms the rejection, so this is a revoked session.
    api.loginApi = {
      get: jest.fn().mockResolvedValue({ data: { code: 2010 } }),
    };

    const handled = await api.handleApiUnauthorized(
      { response: { status: 401, headers: {} } },
      "updateHomeData"
    );

    expect(handled).toBe(true);
    expect(api.userData).toBeNull();
    expect(api.deleteStateAsync).toHaveBeenCalledWith("UserData");
    expect(api.homedataInterval).toBeUndefined();

    // Subsequent 401s stay handled without re-clearing anything.
    expect(
      await api.handleApiUnauthorized(
        { response: { status: 401, headers: {} } },
        "getScenes"
      )
    ).toBe(true);
    expect(api.deleteStateAsync).toHaveBeenCalledTimes(1);
  });

  it("diagnoses clock skew instead of clearing the session", async () => {
    const api = createApi();
    api.deleteStateAsync = jest.fn();
    api.userData = { rriot: {} };

    const serverDate = new Date(Date.now() + 300 * 1000).toUTCString();
    const handled = await api.handleApiUnauthorized(
      { response: { status: 401, headers: { date: serverDate } } },
      "updateHomeData"
    );

    expect(handled).toBe(true);
    expect(api.userData).not.toBeNull();
    expect(api.deleteStateAsync).not.toHaveBeenCalled();
    expect(api.log.error).toHaveBeenCalledWith(
      expect.stringContaining("clock")
    );
  });
});

describe("Roborock.getCleanModeCapabilities", () => {
  it("uses banded water levels for the Qrevo Edge 2 (a298)", () => {
    const api = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a298");
    expect(api.getCleanModeCapabilities("d1").waterDefault).toBe(233);
    expect(api.getCleanModeCapabilities("d1").waterOff).toBe(200);
  });

  it("keeps the classic water levels for other models", () => {
    const api = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a187");
    expect(api.getCleanModeCapabilities("d1").waterDefault).toBe(202);
  });

  it("uses slider water levels for any model with the water-slide feature bit", () => {
    const api = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a306");
    // Bit 106 of newFeatureSet: 27th hex digit from the end, value 4.
    api.vacuums["d1"] = {
      features: new deviceFeatures(api, 0, "4" + "0".repeat(26), "d1"),
    };
    expect(api.getCleanModeCapabilities("d1").waterDefault).toBe(233);
  });
});

describe("deviceFeatures new-feature string bits", () => {
  it("reads a bit counted from the end of the hex string", () => {
    const adapter = { getProductAttribute: () => null };
    const slide = new deviceFeatures(adapter, 0, "4" + "0".repeat(26), "d1");
    const other = new deviceFeatures(adapter, 0, "b" + "0".repeat(26), "d1");
    const short = new deviceFeatures(adapter, 0, "ffff", "d1");

    expect(slide.getFeatureList().isWaterSlideModeSupported).toBe(true);
    expect(other.getFeatureList().isWaterSlideModeSupported).toBe(false);
    expect(short.getFeatureList().isWaterSlideModeSupported).toBe(false);
    expect(
      new deviceFeatures(adapter, 0, undefined, "d1").hasNewFeatureStrBit(106)
    ).toBe(false);
  });
});

describe("Roborock.isBatteryCharging", () => {
  // featureSet with upper-32 bit 13 (off-peak charging) set, or not.
  function createChargingApi(offPeak: boolean) {
    const api = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a75");
    const featureSet = offPeak ? 2 ** 32 * 2 ** 13 : 0;
    api.vacuums["d1"] = {
      features: new deviceFeatures(api, featureSet, "0", "d1"),
    };
    return api;
  }

  it("treats charge_status 0 on the charger as charging without off-peak charging", () => {
    const api = createChargingApi(false);
    expect(api.isBatteryCharging("d1", 0, 8)).toBe(true);
    expect(api.isBatteryCharging("d1", 0, 5)).toBe(false);
    expect(api.isBatteryCharging("d1", 1, 8)).toBe(true);
  });

  it("treats charge_status 0 as waiting for off-peak power when supported", () => {
    const api = createChargingApi(true);
    expect(api.isBatteryCharging("d1", 0, 8)).toBe(false);
    expect(api.isBatteryCharging("d1", 1, 8)).toBe(true);
  });
});

describe("Roborock.isCleaning", () => {
  it("treats mop washing (23) and going to wash (26) as cleaning", () => {
    const api = createApi();
    expect(api.isCleaning(23)).toBe(true);
    expect(api.isCleaning(26)).toBe(true);
    expect(api.isCleaning(8)).toBe(false);
    expect(api.isCleaning("")).toBe(false);
  });

  it("covers the newer state codes from python-roborock", () => {
    const api = createApi();
    // Washing-the-mop alias (Q7 Max family) and mop attach/detach.
    expect(api.isCleaning(25)).toBe(true);
    expect(api.isCleaning(33)).toBe(true);
    expect(api.isCleaning(34)).toBe(true);
    // B01/Q10-generation mopping family.
    for (const state of [
      6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309, 6310,
    ]) {
      expect(api.isCleaning(state)).toBe(true);
    }
    // Non-cleaning newcomers stay off.
    expect(api.isCleaning(32)).toBe(false); // patrol
    expect(api.isCleaning(101)).toBe(false); // device offline
    expect(api.isCleaning(103)).toBe(false); // locked
  });
});

describe("Roborock.startCommand", () => {
  it("warns instead of throwing for a device without a vacuum instance", async () => {
    const api = createApi();
    api.bInited = true;

    await expect(
      api.startCommand("shared1", "app_start", null)
    ).resolves.toBeUndefined();
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown device")
    );
  });
});

describe("Roborock.clearTimersAndIntervals", () => {
  it("clears in-flight request timers on shutdown", () => {
    const api = createApi();
    const timeout = setTimeout(() => {}, 1000000);
    api.pendingRequests.set(7, {
      resolve: jest.fn(),
      reject: jest.fn(),
      timeout,
    });

    api.clearTimersAndIntervals();

    expect(api.pendingRequests.size).toBe(0);
  });
});

describe("Roborock.isSharedDevice", () => {
  it("matches only devices in receivedDevices", () => {
    const api = createApi();
    api.receivedDevices = [{ duid: "shared1" }];
    expect(api.isSharedDevice("shared1")).toBe(true);
    expect(api.isSharedDevice("owned1")).toBe(false);
  });

  it("returns false when no device lists are loaded", () => {
    const api = createApi();
    expect(api.isSharedDevice("any")).toBe(false);
  });
});

describe("vacuum.getParameter network info", () => {
  function createAdapter(version: string, response: unknown) {
    return {
      log: createLogger(),
      getRobotVersion: jest.fn().mockResolvedValue(version),
      messageQueueHandler: {
        sendRequest: jest.fn().mockResolvedValue(response),
      },
      setStateAsync: jest.fn(),
      isSharedDevice: jest.fn(() => false),
      catchError: jest.fn(),
      localDevices: {} as Record<string, string>,
    };
  }

  it("queries service.get_net_info on B01 and accepts misspelled IP fields", async () => {
    const adapter = createAdapter("B01", { ipAdress: "10.0.0.9", ssid: "x" });
    const device = new vacuum(adapter, "roborock.vacuum.ss07");

    await device.getParameter("d1", "get_network_info");

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "d1",
      "service.get_net_info",
      []
    );
    expect(adapter.localDevices["d1"]).toBe("10.0.0.9");
  });

  it("keeps get_network_info for V1 devices", async () => {
    const adapter = createAdapter("1.0", { ip: "10.0.0.7" });
    const device = new vacuum(adapter, "roborock.vacuum.a27");

    await device.getParameter("d1", "get_network_info");

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "d1",
      "get_network_info",
      []
    );
    expect(adapter.localDevices["d1"]).toBe("10.0.0.7");
  });

  it("records the IP even for devices demoted to the cloud path", async () => {
    const adapter = createAdapter("1.0", { ip: "10.0.0.8" });
    // isSharedDevice false covers remoteDevices members: only devices shared
    // from another account are excluded from local addressing.
    const device = new vacuum(adapter, "roborock.vacuum.a27");

    await device.getParameter("d1", "get_network_info");

    expect(adapter.localDevices["d1"]).toBe("10.0.0.8");
  });

  it("never records local IPs for shared devices", async () => {
    const adapter = createAdapter("1.0", { ip: "10.0.0.6" });
    adapter.isSharedDevice = jest.fn(() => true);
    const device = new vacuum(adapter, "roborock.vacuum.a27");

    await device.getParameter("d1", "get_network_info");

    expect(adapter.localDevices["d1"]).toBeUndefined();
    expect(adapter.setStateAsync).toHaveBeenCalledWith(
      "Devices.d1.networkInfo.ip",
      { val: "10.0.0.6", ack: true }
    );
  });
});

describe("roborockAuth user agreement version", () => {
  const roborockAuth = require("../roborockLib/lib/roborockAuth");

  function createLoginApi(agreement: unknown) {
    return {
      get:
        agreement instanceof Error
          ? jest.fn().mockRejectedValue(agreement)
          : jest.fn().mockResolvedValue({ data: agreement }),
      post: jest.fn().mockResolvedValue({ data: { code: 200, data: {} } }),
    };
  }

  function postedParams(loginApi: { post: jest.Mock }) {
    return new URLSearchParams(loginApi.post.mock.calls[0][1]);
  }

  it("sends the latest agreement version with a code login", async () => {
    const loginApi = createLoginApi({
      code: 200,
      data: { majorVersion: 16, minorVersion: 1 },
    });

    await roborockAuth.loginWithCode(loginApi, {
      email: "a@b.c",
      code: "123456",
      country: "US",
      countryCode: "1",
      k: "k",
      s: "s",
    });

    expect(loginApi.get).toHaveBeenCalledWith("api/v3/app/agreement/latest", {
      params: { country: "US" },
      headers: { header_clientlang: "en" },
    });
    const params = postedParams(loginApi);
    expect(params.get("majorVersion")).toBe("16");
    expect(params.get("minorVersion")).toBe("1");
  });

  it("sends the latest agreement version with a password login", async () => {
    const loginApi = createLoginApi({
      code: 200,
      data: { majorVersion: 15, minorVersion: 0 },
    });

    await roborockAuth.loginByPassword(loginApi, {
      email: "a@b.c",
      password: "pw",
      country: "DE",
      k: "0123456789abcdef",
      s: "s",
    });

    expect(loginApi.get.mock.calls[0][1].params).toEqual({ country: "DE" });
    expect(postedParams(loginApi).get("majorVersion")).toBe("15");
  });

  it.each([
    ["the lookup fails", new Error("boom")],
    ["the answer is not a success", { code: 500, data: null }],
    ["the version is malformed", { code: 200, data: { majorVersion: "x" } }],
  ])("falls back to 14.0 when %s", async (_case, agreement) => {
    const loginApi = createLoginApi(agreement);

    await roborockAuth.loginWithCode(loginApi, {
      email: "a@b.c",
      code: "123456",
      country: "US",
      countryCode: "1",
      k: "k",
      s: "s",
    });

    const params = postedParams(loginApi);
    expect(params.get("majorVersion")).toBe("14");
    expect(params.get("minorVersion")).toBe("0");
  });
});

describe("cloud MQTT session health", () => {
  function createHealthApi() {
    const api = createApi();
    api.rr_mqtt_connector = {
      isConnected: jest.fn(() => true),
      reconnectClient: jest.fn(),
    };
    return api;
  }

  function timeouts(api: any, count: number) {
    for (let i = 0; i < count; i++) {
      api.recordCloudTimeout();
    }
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it("restarts a connected session that delivers nothing", () => {
    const api = createHealthApi();
    timeouts(api, 2);
    expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();

    api.recordCloudTimeout();
    expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(1);
  });

  it("ignores timeouts while MQTT reports itself disconnected", () => {
    const api = createHealthApi();
    api.rr_mqtt_connector.isConnected.mockReturnValue(false);
    timeouts(api, 5);
    expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
  });

  it("ignores timeouts while the cloud API is unreachable", () => {
    const api = createHealthApi();
    api.cloudUnreachable = true;
    timeouts(api, 5);
    expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
  });

  it("keeps a session that still delivers messages", () => {
    const api = createHealthApi();
    timeouts(api, 2);
    api.noteCloudMessage();
    timeouts(api, 2);
    expect(api.rr_mqtt_connector.reconnectClient).not.toHaveBeenCalled();
  });

  it("backs off exponentially while restarts do not help", () => {
    jest.useFakeTimers();
    const api = createHealthApi();
    const minute = 60 * 1000;

    timeouts(api, 3); // first restart
    jest.advanceTimersByTime(30 * minute);
    timeouts(api, 3); // second restart after the 30 min cooldown
    expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30 * minute);
    timeouts(api, 3); // now 60 min are required
    expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30 * minute);
    timeouts(api, 3);
    expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledTimes(3);
  });

  it("resets the backoff once messages arrive again", () => {
    const api = createHealthApi();
    api.cloudRestartCount = 5;
    api.noteCloudMessage();
    expect(api.cloudRestartCooldown()).toBe(30 * 60 * 1000);
  });
});

describe("resolveError", () => {
  const HOME_DATA = {
    products: [{ id: "p1", model: "roborock.vacuum.a117", schema: [] }],
    devices: [{ duid: "d1", name: "Vacuum", productId: "p1", pv: "1.0" }],
    receivedDevices: [],
  };

  function createResolveApi(status: Record<string, number>) {
    const api = createApi();
    api.states["HomeData"] = { val: JSON.stringify(HOME_DATA), ack: true };
    api.bInited = true;
    api.vacuums["d1"] = {};
    api.messageQueueHandler = {
      sendRequest: jest.fn(async (_duid: string, method: string) =>
        method === "get_status" ? [status] : ["ok"]
      ),
    };
    return api;
  }

  function resolveCalls(api: any) {
    return api.messageQueueHandler.sendRequest.mock.calls.filter(
      (call: unknown[]) => call[1] === "resolve_error"
    );
  }

  it("resolves the dock error first, with dict params", async () => {
    const api = createResolveApi({ dock_error_status: 38, error_code: 12 });

    expect(await api.resolveError("d1")).toBe(true);

    expect(resolveCalls(api)).toEqual([
      ["d1", "resolve_error", { error_code: 38 }],
    ]);
    // Status is refreshed afterwards.
    const calls = api.messageQueueHandler.sendRequest.mock.calls;
    expect(calls[calls.length - 1][1]).toBe("get_status");
  });

  it("falls back to the robot error", async () => {
    const api = createResolveApi({ dock_error_status: 0, error_code: 12 });
    await api.resolveError("d1");
    expect(resolveCalls(api)[0][2]).toEqual({ error_code: 12 });
  });

  it("sends nothing when there is no error", async () => {
    const api = createResolveApi({ dock_error_status: 0, error_code: 0 });
    expect(await api.resolveError("d1")).toBe(false);
    expect(resolveCalls(api)).toEqual([]);
  });

  it("propagates a failed request", async () => {
    const api = createResolveApi({ error_code: 12 });
    api.messageQueueHandler.sendRequest.mockImplementation(
      async (_duid: string, method: string) => {
        if (method === "resolve_error") {
          throw new Error("invalid params");
        }
        return [{ error_code: 12 }];
      }
    );
    await expect(api.resolveError("d1")).rejects.toThrow("invalid params");
  });
});
