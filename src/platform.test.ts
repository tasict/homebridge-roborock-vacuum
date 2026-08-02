import { APIEvent, PlatformAccessory } from "homebridge";

import RoborockPlatform from "./platform";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";

jest.mock("../roborockLib/roborockAPI", () => ({
  Roborock: jest.fn().mockImplementation(() => ({
    getVacuumList: jest.fn(() => []),
    isInited: jest.fn(() => false),
    setDeviceNotify: jest.fn(),
    startService: jest.fn(),
    stopService: jest.fn(),
  })),
}));

type TestAccessory = PlatformAccessory<String> & {
  UUID: string;
  displayName: string;
  context: string;
};

function createAccessory(
  displayName: string,
  uuid: string,
  context: string
): TestAccessory {
  return {
    UUID: uuid,
    displayName,
    context,
  } as TestAccessory;
}

function createPlatform(
  skipDevices?: string,
  extraConfig: Record<string, unknown> = {}
) {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  const api = {
    hap: {
      Characteristic: jest.fn(),
      Service: jest.fn(),
      uuid: {
        generate: jest.fn((value: string) => `uuid-${value}`),
      },
    },
    on: jest.fn(),
    platformAccessory: jest.fn(),
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
    updatePlatformAccessories: jest.fn(),
    user: {
      storagePath: jest.fn(() => "/tmp"),
    },
  };

  const platform = new RoborockPlatform(
    logger as any,
    {
      email: "user@example.com",
      password: "password",
      platform: PLATFORM_NAME,
      skipDevices,
      ...extraConfig,
    },
    api as any
  );

  return { api, logger, platform };
}

describe("RoborockPlatform cached accessories", () => {
  it("defers removing skipped cached accessories until launch is complete", async () => {
    const { api, platform } = createPlatform("skip-this-device");
    const accessory = createAccessory("S8", "uuid-s8", "skip-this-device");

    platform.configureAccessory(accessory);

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();

    await platform.configurePlugin();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      PLUGIN_NAME,
      PLATFORM_NAME,
      [accessory]
    );
  });

  it("defers duplicate cached accessory removal until launch is complete", async () => {
    const { api, platform } = createPlatform();
    const firstAccessory = createAccessory("S7", "uuid-s7", "s7-device");
    const duplicateAccessory = createAccessory("S7 Copy", "uuid-s7", "s7-copy");

    platform.configureAccessory(firstAccessory);
    platform.configureAccessory(duplicateAccessory);

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();

    await platform.configurePlugin();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      PLUGIN_NAME,
      PLATFORM_NAME,
      [duplicateAccessory]
    );
  });

  it("registers discovery after Homebridge finishes restoring cached accessories", () => {
    const { api } = createPlatform();

    expect(api.on).toHaveBeenCalledWith(
      APIEvent.DID_FINISH_LAUNCHING,
      expect.any(Function)
    );
  });
});

function setupMatterPlatform({
  devices = [{ duid: "dev1", name: "V1" }],
  scenes = (_duid: string): unknown[] => [],
  statusCache = { state: 5, battery: 80, charge_status: 0 },
  extraConfig = {},
}: {
  devices?: { duid: string; name: string }[];
  scenes?: (duid: string) => unknown[];
  statusCache?: Record<string, number>;
  extraConfig?: Record<string, unknown>;
} = {}) {
  const { api, platform } = createPlatform(undefined, {
    matterDevices: devices.map((device) => device.duid).join(","),
    ...extraConfig,
  });

  const matter = {
    uuid: { generate: jest.fn((value: string) => `m-${value}`) },
    deviceTypes: { RoboticVacuumCleaner: "rvc", OnOffOutlet: "outlet" },
    registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
    unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
    updateAccessoryState: jest.fn().mockResolvedValue(undefined),
  };
  (api as any).matter = matter;
  (api as any).isMatterAvailable = () => true;
  (api as any).isMatterEnabled = () => true;

  const roborockAPI = platform.roborockAPI;
  roborockAPI.isInited = jest.fn(() => true);
  roborockAPI.getVacuumList = jest.fn(() => devices);
  roborockAPI.getProductAttribute = jest.fn(() => "roborock.vacuum.a15");
  roborockAPI.getVacuumDeviceData = jest.fn(() => ({}));
  roborockAPI.getScenesForDevice = jest.fn(scenes);
  roborockAPI.getSegmentRooms = jest.fn(() => []);
  roborockAPI.getVacuumDeviceStatus = jest.fn(
    (_duid: string, field: string) => statusCache[field] ?? ""
  );

  return { api, matter, platform, roborockAPI, statusCache };
}

describe("RoborockPlatform Matter status updates", () => {
  it("seeds the vacuum status after Matter registration", async () => {
    const { matter, platform } = setupMatterPlatform();

    await platform.configurePlugin();
    await (platform as any).discoverDevices();

    expect(matter.updateAccessoryState).toHaveBeenCalledWith(
      "m-dev1",
      "rvcOperationalState",
      { operationalState: 1 },
      undefined
    );
  });

  it("refreshes the vacuum status when HomeData updates", async () => {
    const { matter, platform, roborockAPI, statusCache } =
      setupMatterPlatform();

    await platform.configurePlugin();
    await (platform as any).discoverDevices();
    matter.updateAccessoryState.mockClear();

    statusCache.state = 100; // Fully charged → Docked
    const notify = roborockAPI.setDeviceNotify.mock.calls[0][0];
    notify("HomeData", {});

    expect(matter.updateAccessoryState).toHaveBeenCalledWith(
      "m-dev1",
      "rvcOperationalState",
      { operationalState: 66 },
      undefined
    );
  });

  it("translates dps status payloads for the Matter vacuums", async () => {
    const { matter, platform, roborockAPI } = setupMatterPlatform();

    await platform.configurePlugin();
    await (platform as any).discoverDevices();
    matter.updateAccessoryState.mockClear();

    const notify = roborockAPI.setDeviceNotify.mock.calls[0][0];
    notify("CloudMessage", { dps: { "121": 8, "122": 55 } });

    expect(matter.updateAccessoryState).toHaveBeenCalledWith(
      "m-dev1",
      "rvcOperationalState",
      { operationalState: 65 },
      undefined
    );
  });
});

describe("RoborockPlatform Matter scene buttons", () => {
  it("suffixes duplicate scene names on every device regardless of discovery order", async () => {
    const { matter, platform } = setupMatterPlatform({
      devices: [
        { duid: "dev1", name: "V1" },
        { duid: "dev2", name: "V2" },
      ],
      scenes: (duid: string) => [
        { id: duid === "dev1" ? 10 : 20, name: "Clean", enabled: true },
      ],
    });

    await platform.configurePlugin();
    await (platform as any).discoverDevices();

    const registered = matter.registerPlatformAccessories.mock.calls.flatMap(
      (call: unknown[]) => call[2] as any[]
    );
    const sceneNames = registered
      .filter((accessory) => accessory.context?.sceneId !== undefined)
      .map((accessory) => accessory.displayName)
      .sort();
    expect(sceneNames).toEqual(["Clean (V1)", "Clean (V2)"]);
  });

  it("does not register scene buttons for devices excluded by matterSceneDevices", async () => {
    const { matter, platform } = setupMatterPlatform({
      devices: [
        { duid: "dev1", name: "V1" },
        { duid: "dev2", name: "V2" },
      ],
      scenes: () => [{ id: 10, name: "Clean", enabled: true }],
      extraConfig: { matterSceneDevices: "dev2" },
    });

    await platform.configurePlugin();
    await (platform as any).discoverDevices();

    const registered = matter.registerPlatformAccessories.mock.calls.flatMap(
      (call: unknown[]) => call[2] as any[]
    );
    const sceneOwners = registered
      .filter((accessory) => accessory.context?.sceneId !== undefined)
      .map((accessory) => accessory.context.duid);
    expect(sceneOwners).toEqual(["dev2"]);
  });
});
