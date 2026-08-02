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
  AccessoryInformation: "AccessoryInformation",
  Fanv2: "Fanv2",
  Battery: "Battery",
  Switch: "Switch",
  FilterMaintenance: "FilterMaintenance",
};

function createServiceStub(type: string, subtype?: string) {
  const service: any = {
    type,
    subtype,
    setCharacteristic: jest.fn(() => service),
    updateCharacteristic: jest.fn(() => service),
    addOptionalCharacteristic: jest.fn(),
    getCharacteristic: jest.fn(() => ({
      onSet: jest.fn().mockReturnThis(),
      onGet: jest.fn().mockReturnThis(),
    })),
  };
  return service;
}

function createAccessory() {
  const services: any[] = [createServiceStub(Service.AccessoryInformation)];
  return {
    context: "duid-1",
    services,
    getService: (type: string) =>
      services.find((s) => s.type === type && s.subtype === undefined),
    getServiceById: (type: string, subtype: string) =>
      services.find((s) => s.type === type && s.subtype === subtype),
    addService: (type: string, _name?: string, subtype?: string) => {
      const service = createServiceStub(type, subtype);
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
    roborockAPI: {
      getProductAttribute: jest.fn(() => "roborock.vacuum.a75"),
      getVacuumDeviceInfo: jest.fn(
        (_duid: string, field: string) => info[field] ?? ""
      ),
      getVacuumDeviceStatus: jest.fn(
        (_duid: string, code: string) => status[code] ?? ""
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
  info: Record<string, unknown> = {}
) {
  const platform = createPlatform(status, info);
  const accessory = createAccessory();
  new RoborockVacuumAccessory(platform as any, accessory as any);
  return { platform, accessory };
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

  it("refreshes the firmware revision from home data on every poll", () => {
    const { accessory } = createVacuum({}, { fv: "02.20.60" });

    expect(
      accessory.getService(Service.AccessoryInformation).updateCharacteristic
    ).toHaveBeenCalledWith(Characteristic.FirmwareRevision, "02.20.60");
  });
});
