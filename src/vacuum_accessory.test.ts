import RoborockVacuumAccessory from "./vacuum_accessory";

const Characteristic = {
  Manufacturer: "Manufacturer",
  Model: "Model",
  SerialNumber: "SerialNumber",
  FirmwareRevision: "FirmwareRevision",
  Name: "Name",
  ConfiguredName: "ConfiguredName",
  BatteryLevel: "BatteryLevel",
  On: "On",
  FilterLifeLevel: "FilterLifeLevel",
  Active: { ACTIVE: 1, INACTIVE: 0 },
  StatusLowBattery: { BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0 },
  ChargingState: { CHARGING: 1, NOT_CHARGING: 0 },
  StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 },
  StatusActive: "StatusActive",
  FilterChangeIndication: { FILTER_OK: 0, CHANGE_FILTER: 1 },
};

const Service = {
  AccessoryInformation: class AccessoryInformation {},
  Fanv2: class Fanv2 {},
  Battery: class Battery {},
  Switch: class Switch {},
  FilterMaintenance: class FilterMaintenance {},
};

type ServiceType = (typeof Service)[keyof typeof Service];

function createServiceStub(
  type: ServiceType,
  subtype?: string,
  values: Record<string, unknown> = {}
) {
  const stored = new Map<unknown, unknown>(Object.entries(values));
  const characteristics = new Map<unknown, any>();
  const characteristic = (key: unknown) => {
    if (!characteristics.has(key)) {
      const listeners: ((change: unknown) => void)[] = [];
      characteristics.set(key, {
        get value() {
          return stored.get(key);
        },
        onSet: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        on: jest.fn((_event: string, listener: (change: unknown) => void) => {
          listeners.push(listener);
        }),
        // Mimics HAP: store the value and emit "change". A controller write
        // carries its connection as originator, a plugin-side set none.
        change: (value: unknown, reason: string, originator?: unknown) => {
          stored.set(key, value);
          listeners.forEach((listener) =>
            listener({ newValue: value, reason, originator })
          );
        },
      });
    }
    return characteristics.get(key);
  };
  const service: any = Object.assign(Object.create(type.prototype), {
    type,
    subtype,
    value: (key: unknown) => stored.get(key),
    characteristic,
    // HAP reports a plugin-side set as reason "write" with no originator.
    setCharacteristic: jest.fn((key: unknown, value: unknown) => {
      characteristic(key).change(value, "write");
      return service;
    }),
    updateCharacteristic: jest.fn((key: unknown, value: unknown) => {
      stored.set(key, value);
      return service;
    }),
    addOptionalCharacteristic: jest.fn(),
    testCharacteristic: jest.fn((key: unknown) => stored.has(key)),
    getCharacteristic: jest.fn((key: unknown) => characteristic(key)),
  });
  return service;
}

function createAccessory(cached: any[] = []) {
  const services: any[] = [
    createServiceStub(Service.AccessoryInformation),
    ...cached,
  ];
  return {
    context: "duid-1",
    services,
    getService: (type: ServiceType) =>
      services.find((s) => s.type === type && s.subtype === undefined),
    getServiceById: (type: ServiceType, subtype: string) =>
      services.find((s) => s.type === type && s.subtype === subtype),
    addService: (type: ServiceType, name?: string, subtype?: string) => {
      const service = createServiceStub(
        type,
        subtype,
        name ? { [Characteristic.Name]: name } : {}
      );
      services.push(service);
      return service;
    },
    removeService: (service: any) => {
      services.splice(services.indexOf(service), 1);
    },
  };
}

// Status values keyed by schema code; "" mimics getVacuumDeviceStatus for a
// code missing from the product schema.
function createPlatform(
  status: Record<string, unknown>,
  info: Record<string, unknown> = {}
) {
  return {
    Service,
    Characteristic,
    log: { debug: jest.fn(), error: jest.fn(), info: jest.fn() },
    saveAccessory: jest.fn(),
    roborockAPI: {
      getProductAttribute: jest.fn(() => "roborock.vacuum.a75"),
      getVacuumDeviceInfo: jest.fn(
        (_duid: string, field: string) => info[field] ?? ""
      ),
      getVacuumDeviceStatus: jest.fn(
        (_duid: string, code: string) => status[code] ?? ""
      ),
      isLocallyConnected: jest.fn(() => info.locallyConnected === true),
      isBatteryCharging: jest.fn(
        (_duid: string, chargeStatus: unknown, state: unknown) =>
          Number(chargeStatus) !== 0 || Number(state) === 8
      ),
      getScenesForDevice: jest.fn(() => []),
      isDockWashSupported: jest.fn(() => false),
      isCleaning: jest.fn(() => false),
      getTranslation: jest.fn((key: string) =>
        key === "reset_filter_work_time" ? "Filter" : ""
      ),
    },
  };
}

function createVacuum(
  status: Record<string, unknown>,
  info: Record<string, unknown> = {},
  setup: {
    scenes?: any[];
    dockWashName?: string;
    cached?: any[];
  } = {}
) {
  const platform = createPlatform(status, info);
  if (setup.scenes) {
    platform.roborockAPI.getScenesForDevice.mockReturnValue(setup.scenes);
  }
  if (setup.dockWashName !== undefined) {
    platform.roborockAPI.isDockWashSupported.mockReturnValue(true);
    platform.roborockAPI.getTranslation.mockImplementation((key: string) =>
      key === "app_start_wash" ? setup.dockWashName! : ""
    );
  }
  const accessory = createAccessory(setup.cached);
  new RoborockVacuumAccessory(platform as any, accessory as any);
  return { platform, accessory };
}

// A switch restored from the Homebridge accessory cache: Name holds the
// default the plugin assigned last time, ConfiguredName what Home shows.
function cachedSwitch(subtype: string, name: string, configuredName: string) {
  return createServiceStub(Service.Switch, subtype, {
    [Characteristic.Name]: name,
    [Characteristic.ConfiguredName]: configuredName,
  });
}

describe("RoborockVacuumAccessory consumables", () => {
  it("creates FilterMaintenance services only for consumables in the schema", () => {
    const { accessory } = createVacuum({
      filter_life: 80,
      main_brush_life: 4,
      // side_brush_life missing from the schema
    });

    const filter = accessory.getServiceById(
      Service.FilterMaintenance,
      "filter"
    );
    const mainBrush = accessory.getServiceById(
      Service.FilterMaintenance,
      "main-brush"
    );

    expect(filter).toBeDefined();
    expect(mainBrush).toBeDefined();
    expect(
      accessory.getServiceById(Service.FilterMaintenance, "side-brush")
    ).toBeUndefined();

    expect(filter.updateCharacteristic).toHaveBeenCalledWith(
      Characteristic.FilterLifeLevel,
      80
    );
    expect(filter.updateCharacteristic).toHaveBeenCalledWith(
      Characteristic.FilterChangeIndication,
      Characteristic.FilterChangeIndication.FILTER_OK
    );
    // 4% is at or below the change threshold
    expect(mainBrush.updateCharacteristic).toHaveBeenCalledWith(
      Characteristic.FilterChangeIndication,
      Characteristic.FilterChangeIndication.CHANGE_FILTER
    );
  });

  it("refreshes consumables when locally computed life arrives", () => {
    const status: Record<string, unknown> = {};
    const platform = createPlatform(status);
    const accessory = createAccessory();
    const vacuum = new RoborockVacuumAccessory(
      platform as any,
      accessory as any
    );
    expect(
      accessory.getServiceById(Service.FilterMaintenance, "filter")
    ).toBeUndefined();

    status.filter_life = 86;
    vacuum.notifyDeviceUpdater("LocalMessage", { filter_life: 86 });

    expect(
      accessory.getServiceById(Service.FilterMaintenance, "filter")
        .updateCharacteristic
    ).toHaveBeenCalledWith(Characteristic.FilterLifeLevel, 86);
  });

  it("names the service from the translation with an English fallback", () => {
    const { accessory } = createVacuum({
      filter_life: 50,
      main_brush_life: 50,
    });

    expect(
      accessory.getServiceById(Service.FilterMaintenance, "filter")
        .setCharacteristic.mock.calls
    ).toContainEqual([Characteristic.ConfiguredName, "Filter"]);
    // Translation returns "" for the main brush key -> fallback name
    expect(
      accessory.getServiceById(Service.FilterMaintenance, "main-brush")
        .setCharacteristic.mock.calls
    ).toContainEqual([Characteristic.ConfiguredName, "Main brush"]);
  });
});

describe("RoborockVacuumAccessory status flags", () => {
  it("reports a fault while the device has an error code and clears it", () => {
    const { platform, accessory } = createVacuum({ error_code: 5 });
    const fan = accessory.getService(Service.Fanv2);

    expect(fan.updateCharacteristic).toHaveBeenCalledWith(
      Characteristic.StatusFault,
      Characteristic.StatusFault.GENERAL_FAULT
    );

    const vacuum = new RoborockVacuumAccessory(
      platform as any,
      accessory as any
    );
    fan.updateCharacteristic.mockClear();
    vacuum.notifyDeviceUpdater("CloudMessage", { error_code: 0 });

    expect(fan.updateCharacteristic).toHaveBeenCalledWith(
      Characteristic.StatusFault,
      Characteristic.StatusFault.NO_FAULT
    );
  });

  it("keeps a locally connected robot reachable when the cloud reports offline", () => {
    const { accessory } = createVacuum(
      {},
      { online: false, locallyConnected: true }
    );

    expect(
      accessory.getService(Service.Fanv2).updateCharacteristic
    ).toHaveBeenCalledWith(Characteristic.StatusActive, true);
  });

  it("marks the accessory inactive only when the cloud reports offline", () => {
    const { accessory } = createVacuum({}, { online: false });

    expect(
      accessory.getService(Service.Fanv2).updateCharacteristic
    ).toHaveBeenCalledWith(Characteristic.StatusActive, false);

    const { accessory: unknownOnline } = createVacuum({});
    expect(
      unknownOnline.getService(Service.Fanv2).updateCharacteristic
    ).toHaveBeenCalledWith(Characteristic.StatusActive, true);
  });

  it("asks the API whether a charge_status means charging", () => {
    const { platform, accessory } = createVacuum({
      state: 8,
      charge_status: 0,
    });

    expect(platform.roborockAPI.isBatteryCharging).toHaveBeenCalledWith(
      "duid-1",
      0,
      8
    );
    expect(
      accessory.getService(Service.Battery).updateCharacteristic
    ).toHaveBeenCalledWith(
      Characteristic.ChargingState,
      Characteristic.ChargingState.CHARGING
    );
  });

  it("refreshes the firmware revision from home data on every poll", () => {
    const { accessory } = createVacuum({}, { fv: "02.20.60" });

    expect(
      accessory.getService(Service.AccessoryInformation).updateCharacteristic
    ).toHaveBeenCalledWith(Characteristic.FirmwareRevision, "02.20.60");
  });
});

describe("RoborockVacuumAccessory switch names", () => {
  const bedroom = { id: 1, name: "Vacuum the Bedroom", enabled: true };

  it("names a scene switch after the Roborock scene, spaces included", () => {
    const { platform, accessory } = createVacuum({}, {}, { scenes: [bedroom] });
    const scene = accessory.getServiceById(Service.Switch, "scene-1");

    expect(scene.value(Characteristic.Name)).toBe("Vacuum the Bedroom");
    expect(scene.value(Characteristic.ConfiguredName)).toBe(
      "Vacuum the Bedroom"
    );
    expect(platform.log.error).not.toHaveBeenCalled();
  });

  it("trims scene names and falls back to the scene id when empty", () => {
    const { accessory } = createVacuum(
      {},
      {},
      {
        scenes: [
          { id: 7, name: "  ", enabled: true },
          { id: 8, name: " Kitchen mop ", enabled: true },
        ],
      }
    );

    expect(
      accessory
        .getServiceById(Service.Switch, "scene-7")
        .value(Characteristic.ConfiguredName)
    ).toBe("Scene 7");
    expect(
      accessory
        .getServiceById(Service.Switch, "scene-8")
        .value(Characteristic.ConfiguredName)
    ).toBe("Kitchen mop");
  });

  it("removes cached scene switches whose scene is gone", () => {
    const gone = cachedSwitch("scene-9", "Old scene", "Old scene");
    const { platform, accessory } = createVacuum(
      {},
      {},
      { scenes: [bedroom], cached: [gone] }
    );

    expect(accessory.services).not.toContain(gone);
    expect(accessory.getServiceById(Service.Switch, "scene-1")).toBeDefined();
    expect(platform.log.error).not.toHaveBeenCalled();
  });

  it("saves the cache as soon as the Home app renames a switch", () => {
    const { platform, accessory } = createVacuum({}, {}, { scenes: [bedroom] });
    const configuredName = accessory
      .getServiceById(Service.Switch, "scene-1")
      .characteristic(Characteristic.ConfiguredName);

    // Naming the switch at startup, a later plugin-side set and a value
    // update do not save; a write from the Home app does.
    expect(platform.saveAccessory).not.toHaveBeenCalled();
    configuredName.change("Bedroom clean", "write");
    configuredName.change("Bedroom clean", "update");
    expect(platform.saveAccessory).not.toHaveBeenCalled();

    const homeApp = { remoteAddress: "192.168.1.20" };
    configuredName.change("Bedroom clean", "write", homeApp);
    expect(platform.saveAccessory).toHaveBeenCalledTimes(1);
    expect(platform.saveAccessory).toHaveBeenCalledWith(accessory);
  });

  it("moves a cached switch off the old underscore name", () => {
    const cached = cachedSwitch(
      "scene-1",
      "Vacuum_the_Bedroom",
      "Vacuum_the_Bedroom"
    );
    createVacuum({}, {}, { scenes: [bedroom], cached: [cached] });

    expect(cached.value(Characteristic.Name)).toBe("Vacuum the Bedroom");
    expect(cached.value(Characteristic.ConfiguredName)).toBe(
      "Vacuum the Bedroom"
    );
  });

  it("keeps a scene switch renamed in the Home app", () => {
    const cached = cachedSwitch(
      "scene-1",
      "Vacuum_the_Bedroom",
      "Bedroom clean"
    );
    createVacuum({}, {}, { scenes: [bedroom], cached: [cached] });

    expect(cached.value(Characteristic.Name)).toBe("Vacuum the Bedroom");
    expect(cached.value(Characteristic.ConfiguredName)).toBe("Bedroom clean");
    expect(cached.setCharacteristic).not.toHaveBeenCalledWith(
      Characteristic.ConfiguredName,
      expect.anything()
    );
    // Already on the cached service, so it is not added again.
    expect(cached.addOptionalCharacteristic).not.toHaveBeenCalled();
  });

  it("names a cached switch that has no ConfiguredName yet", () => {
    const cached = cachedSwitch("scene-1", "Vacuum_the_Bedroom", "");
    createVacuum({}, {}, { scenes: [bedroom], cached: [cached] });

    expect(cached.value(Characteristic.ConfiguredName)).toBe(
      "Vacuum the Bedroom"
    );
  });

  it("renames the dock wash switch after a language change", () => {
    const cached = cachedSwitch("dock-wash", "Start washing", "Start washing");
    createVacuum({}, {}, { dockWashName: "開始洗拖布", cached: [cached] });

    expect(cached.value(Characteristic.Name)).toBe("開始洗拖布");
    expect(cached.value(Characteristic.ConfiguredName)).toBe("開始洗拖布");
  });

  it("keeps a dock wash switch renamed in the Home app", () => {
    const cached = cachedSwitch("dock-wash", "Start washing", "Mop wash");
    createVacuum({}, {}, { dockWashName: "開始洗拖布", cached: [cached] });

    expect(cached.value(Characteristic.Name)).toBe("開始洗拖布");
    expect(cached.value(Characteristic.ConfiguredName)).toBe("Mop wash");
  });
});
