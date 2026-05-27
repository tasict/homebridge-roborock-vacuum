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

function createPlatform(skipDevices?: string) {
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
