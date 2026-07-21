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

  it("ignores errors that are not HTTP 401", () => {
    const api = createApi();
    expect(api.handleApiUnauthorized(new Error("boom"), "test")).toBe(false);
    expect(
      api.handleApiUnauthorized(
        { response: { status: 500, headers: {} } },
        "test"
      )
    ).toBe(false);
  });

  it("clears the session and stops HomeData polling on a session 401", () => {
    const api = createApi();
    api.deleteStateAsync = jest.fn();
    api.userData = { rriot: {} };
    api.homedataInterval = setInterval(() => {}, 1000000);

    const handled = api.handleApiUnauthorized(
      { response: { status: 401, headers: {} } },
      "updateHomeData"
    );

    expect(handled).toBe(true);
    expect(api.userData).toBeNull();
    expect(api.deleteStateAsync).toHaveBeenCalledWith("UserData");
    expect(api.homedataInterval).toBeUndefined();

    // Subsequent 401s stay handled without re-clearing anything.
    expect(
      api.handleApiUnauthorized(
        { response: { status: 401, headers: {} } },
        "getScenes"
      )
    ).toBe(true);
    expect(api.deleteStateAsync).toHaveBeenCalledTimes(1);
  });

  it("diagnoses clock skew instead of clearing the session", () => {
    const api = createApi();
    api.deleteStateAsync = jest.fn();
    api.userData = { rriot: {} };

    const serverDate = new Date(Date.now() + 300 * 1000).toUTCString();
    const handled = api.handleApiUnauthorized(
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
