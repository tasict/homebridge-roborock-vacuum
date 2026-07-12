import { MatterStatus } from "homebridge";
import { RoborockDockWashMatterAccessory } from "./dock_wash_matter_accessory";

const DUID = "duid-1";

function makeApi() {
  const updateAccessoryState = jest.fn().mockResolvedValue(undefined);
  return {
    matter: {
      uuid: { generate: (seed: string) => `uuid-${seed}` },
      deviceTypes: { OnOffOutlet: "OnOffOutlet" },
      updateAccessoryState,
    },
    updateAccessoryState,
  } as any;
}

function makeLog() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function makeRoborockAPI(overrides: Record<string, unknown> = {}) {
  return {
    app_start_wash: jest.fn().mockResolvedValue(undefined),
    app_stop_wash: jest.fn().mockResolvedValue(undefined),
    getVacuumDeviceStatus: jest.fn().mockReturnValue(8),
    ...overrides,
  } as any;
}

function makeAccessory(
  apiOverrides: Record<string, unknown> = {},
  displayName = "Start Mop Washing"
) {
  const api = makeApi();
  const roborockAPI = makeRoborockAPI(apiOverrides);
  const accessory = new RoborockDockWashMatterAccessory(
    api,
    makeLog(),
    {
      duid: DUID,
      name: "Robo",
      sn: "SN1",
      productModel: "roborock.vacuum.a70",
    },
    displayName,
    roborockAPI
  );
  return {
    accessory,
    roborockAPI,
    updateAccessoryState: api.updateAccessoryState,
  };
}

function onOffUpdates(updateAccessoryState: jest.Mock): boolean[] {
  return updateAccessoryState.mock.calls
    .filter((call: unknown[]) => call[1] === "onOff")
    .map((call: unknown[]) => (call[2] as { onOff: boolean }).onOff);
}

describe("RoborockDockWashMatterAccessory", () => {
  it("starts off and derives its UUID from the duid only", () => {
    const { accessory } = makeAccessory();
    expect((accessory.clusters as any).onOff.onOff).toBe(false);
    expect(accessory.UUID).toBe(`uuid-${DUID}-dock-wash`);

    // A language change only alters the display name; the UUID (and thus the
    // Matter pairing) must stay the same.
    const renamed = makeAccessory({}, "開始拖布清洗").accessory;
    expect(renamed.UUID).toBe(accessory.UUID);
  });

  it("sends app_start_wash on and app_stop_wash off", async () => {
    const { accessory, roborockAPI } = makeAccessory();

    await (accessory.handlers as any).onOff.on();
    expect(roborockAPI.app_start_wash).toHaveBeenCalledWith(DUID);

    await (accessory.handlers as any).onOff.off();
    expect(roborockAPI.app_stop_wash).toHaveBeenCalledWith(DUID);
  });

  it("reports a Matter failure when the wash command rejects", async () => {
    const { accessory } = makeAccessory({
      app_start_wash: jest.fn().mockRejectedValue(new Error("offline")),
    });

    await expect((accessory.handlers as any).onOff.on()).rejects.toBeInstanceOf(
      MatterStatus.Failure
    );
  });

  it("mirrors the mop-washing device states into the switch", () => {
    const { accessory, updateAccessoryState } = makeAccessory();

    accessory.updateFromRoborockData({ state: 23 }); // Washing the mop
    accessory.updateFromRoborockData({ state: 23 }); // no-op (unchanged)
    accessory.updateFromRoborockData({ state: 26 }); // Going to wash (still on)
    accessory.updateFromRoborockData({ state: 8 }); // Charging → off
    accessory.updateFromRoborockData({ battery: 50 }); // no state field → ignored

    expect(onOffUpdates(updateAccessoryState)).toEqual([true, false]);
  });

  it("refreshes from the cached device state", () => {
    const { accessory, roborockAPI, updateAccessoryState } = makeAccessory({
      getVacuumDeviceStatus: jest.fn().mockReturnValue(23),
    });

    accessory.refreshFromDevice();
    expect(roborockAPI.getVacuumDeviceStatus).toHaveBeenCalledWith(
      DUID,
      "state"
    );
    expect(onOffUpdates(updateAccessoryState)).toEqual([true]);
  });

  it("ignores an unknown cached state", () => {
    const { accessory, updateAccessoryState } = makeAccessory({
      getVacuumDeviceStatus: jest.fn().mockReturnValue(""),
    });

    accessory.refreshFromDevice();
    expect(onOffUpdates(updateAccessoryState)).toEqual([]);
  });
});
