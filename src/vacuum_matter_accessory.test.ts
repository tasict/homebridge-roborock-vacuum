import { MatterStatus } from "homebridge";
import { RoborockVacuumMatterAccessory } from "./vacuum_matter_accessory";

const DUID = "duid-1";

const ROOMS = [
  { segmentId: 16, name: "Kitchen" },
  { segmentId: 17, name: "Living Room" },
  { segmentId: 18, name: "Bedroom" },
];

function makeApi() {
  const updateAccessoryState = jest.fn().mockResolvedValue(undefined);
  return {
    matter: {
      uuid: { generate: (seed: string) => `uuid-${seed}` },
      deviceTypes: { RoboticVacuumCleaner: "RoboticVacuumCleaner" },
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
    app_start: jest.fn().mockResolvedValue(undefined),
    app_stop: jest.fn().mockResolvedValue(undefined),
    app_pause: jest.fn().mockResolvedValue(undefined),
    app_charge: jest.fn().mockResolvedValue(undefined),
    app_segment_clean: jest.fn().mockResolvedValue(undefined),
    resume_segment_clean: jest.fn().mockResolvedValue(undefined),
    findMe: jest.fn().mockResolvedValue(undefined),
    setCleanModeParameters: jest.fn().mockResolvedValue(undefined),
    getVacuumDeviceData: jest.fn().mockReturnValue({ deviceStatus: {} }),
    getSegmentRooms: jest.fn().mockReturnValue(ROOMS),
    getCleanModeCapabilities: jest.fn().mockReturnValue({
      fanOff: 105,
      fanDefault: 102,
      waterOff: 200,
      waterDefault: 202,
      mopSupported: true,
    }),
    ...overrides,
  } as any;
}

function makeAccessory(apiOverrides: Record<string, unknown> = {}) {
  const api = makeApi();
  const roborockAPI = makeRoborockAPI(apiOverrides);
  const accessory = new RoborockVacuumMatterAccessory(
    api,
    makeLog(),
    makeLog(),
    {
      duid: DUID,
      name: "Robo",
      sn: "SN1",
      productModel: "roborock.vacuum.a15",
    },
    roborockAPI
  );
  return {
    accessory,
    roborockAPI,
    updateAccessoryState: api.updateAccessoryState,
  };
}

function clusterUpdates(
  updateAccessoryState: jest.Mock,
  cluster: string
): Record<string, unknown>[] {
  return updateAccessoryState.mock.calls
    .filter((call: unknown[]) => call[1] === cluster)
    .map((call: unknown[]) => call[2] as Record<string, unknown>);
}

describe("RoborockVacuumMatterAccessory", () => {
  describe("cluster definition", () => {
    it("offers Vacuum, Mop, and Vacuum & Mop when the model has a water box", () => {
      const { accessory } = makeAccessory();
      const modes = (accessory.clusters as any).rvcCleanMode.supportedModes;
      expect(modes.map((m: any) => m.label)).toEqual([
        "Vacuum",
        "Mop",
        "Vacuum & Mop",
      ]);
    });

    it("offers only Vacuum when the model has no water box", () => {
      const { accessory } = makeAccessory({
        getCleanModeCapabilities: jest.fn().mockReturnValue({
          fanOff: 105,
          fanDefault: 102,
          waterOff: 200,
          waterDefault: 202,
          mopSupported: false,
        }),
      });
      const cleanMode = (accessory.clusters as any).rvcCleanMode;
      expect(cleanMode.supportedModes.map((m: any) => m.label)).toEqual([
        "Vacuum",
      ]);
      expect(cleanMode.currentMode).toBe(0);
    });

    it("limits run modes to Idle and Cleaning", () => {
      const { accessory } = makeAccessory();
      const modes = (accessory.clusters as any).rvcRunMode.supportedModes;
      expect(modes.map((m: any) => m.label)).toEqual(["Idle", "Cleaning"]);
    });

    it("publishes the known rooms as supported areas", () => {
      const { accessory } = makeAccessory();
      const areas = (accessory.clusters as any).serviceArea.supportedAreas;
      expect(areas.map((a: any) => a.areaId)).toEqual([16, 17, 18]);
      expect(areas[0].areaInfo.locationInfo.locationName).toBe("Kitchen");
    });

    it("starts with an empty area list when rooms are not cached yet", () => {
      const { accessory } = makeAccessory({
        getSegmentRooms: jest.fn().mockReturnValue([]),
      });
      expect((accessory.clusters as any).serviceArea.supportedAreas).toEqual(
        []
      );
    });
  });

  describe("operational state mapping", () => {
    it.each([
      [5, 1], // Cleaning → Running
      [8, 65], // Charging → Charging
      [10, 2], // Paused → Paused
      [12, 3], // Error → Error
      [100, 66], // Fully charged → Docked
      [99, 0], // Unknown → Stopped
    ])("maps Roborock state %i to Matter state %i", (state, expected) => {
      const { accessory, updateAccessoryState } = makeAccessory();
      // Leave the initial Docked state first (via a state that maps to a
      // different Matter state than the one under test) so every mapping,
      // including back-to-Docked, produces a push.
      accessory.updateFromRoborockData({ state: expected === 1 ? 3 : 5 });
      updateAccessoryState.mockClear();
      accessory.updateFromRoborockData({ state });
      const updates = clusterUpdates(
        updateAccessoryState,
        "rvcOperationalState"
      );
      expect(updates).toContainEqual({ operationalState: expected });
    });

    it("does not re-push an unchanged state", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ state: 5 });
      updateAccessoryState.mockClear();
      accessory.updateFromRoborockData({ state: 5 });
      expect(
        clusterUpdates(updateAccessoryState, "rvcOperationalState")
      ).toEqual([]);
    });
  });

  describe("battery", () => {
    it("doubles the percentage and flags critical below 20%", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ battery: 15 });
      expect(
        clusterUpdates(updateAccessoryState, "powerSource")
      ).toContainEqual({ batPercentRemaining: 30, batChargeLevel: 2 });
    });

    it("clamps to the 0-200 range", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ battery: 120 });
      expect(
        clusterUpdates(updateAccessoryState, "powerSource")
      ).toContainEqual({ batPercentRemaining: 200, batChargeLevel: 0 });
    });
  });

  describe("clean mode detection", () => {
    it("reports Mop when suction is off", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ fan_power: 105, water_box_mode: 202 });
      expect(
        clusterUpdates(updateAccessoryState, "rvcCleanMode")
      ).toContainEqual({ currentMode: 1 });
    });

    it("reports Vacuum when water is off", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ fan_power: 102, water_box_mode: 200 });
      expect(
        clusterUpdates(updateAccessoryState, "rvcCleanMode")
      ).toContainEqual({ currentMode: 0 });
    });
  });

  describe("run mode handler", () => {
    it("stops (not docks) on Idle", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      await (accessory.handlers as any).rvcRunMode.changeToMode({ newMode: 0 });
      expect(roborockAPI.app_stop).toHaveBeenCalledWith(DUID);
      expect(roborockAPI.app_charge).not.toHaveBeenCalled();
    });

    it("starts a full clean when no rooms are selected", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      await (accessory.handlers as any).rvcRunMode.changeToMode({ newMode: 1 });
      expect(roborockAPI.app_start).toHaveBeenCalledWith(DUID);
      expect(roborockAPI.app_segment_clean).not.toHaveBeenCalled();
    });

    it("starts a segment clean for a subset selection", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      await (accessory.handlers as any).serviceArea.selectAreas({
        newAreas: [16, 18],
      });
      await (accessory.handlers as any).rvcRunMode.changeToMode({ newMode: 1 });
      expect(roborockAPI.app_segment_clean).toHaveBeenCalledWith(
        DUID,
        [16, 18]
      );
      expect(roborockAPI.app_start).not.toHaveBeenCalled();
    });

    it("degrades to a full clean when every room is selected", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      await (accessory.handlers as any).serviceArea.selectAreas({
        newAreas: [16, 17, 18],
      });
      await (accessory.handlers as any).rvcRunMode.changeToMode({ newMode: 1 });
      expect(roborockAPI.app_start).toHaveBeenCalledWith(DUID);
      expect(roborockAPI.app_segment_clean).not.toHaveBeenCalled();
    });

    it("rejects unknown run modes", async () => {
      const { accessory } = makeAccessory();
      await expect(
        (accessory.handlers as any).rvcRunMode.changeToMode({ newMode: 2 })
      ).rejects.toBeInstanceOf(MatterStatus.InvalidAction);
    });
  });

  describe("selectAreas handler", () => {
    it("rejects unknown area ids", async () => {
      const { accessory } = makeAccessory();
      await expect(
        (accessory.handlers as any).serviceArea.selectAreas({ newAreas: [99] })
      ).rejects.toBeInstanceOf(MatterStatus.InvalidAction);
    });
  });

  describe("pause and resume", () => {
    it("pauses through app_pause while running", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      accessory.updateFromRoborockData({ state: 5 }); // Running
      await (accessory.handlers as any).rvcOperationalState.pause();
      expect(roborockAPI.app_pause).toHaveBeenCalledWith(DUID);
    });

    it("refuses to pause while docked", async () => {
      const { accessory } = makeAccessory();
      await expect(
        (accessory.handlers as any).rvcOperationalState.pause()
      ).rejects.toBeInstanceOf(MatterStatus.InvalidInState);
    });

    it("resumes a paused segment clean with resume_segment_clean", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      await (accessory.handlers as any).serviceArea.selectAreas({
        newAreas: [16],
      });
      await (accessory.handlers as any).rvcRunMode.changeToMode({ newMode: 1 });
      accessory.updateFromRoborockData({ state: 10 }); // Paused
      await (accessory.handlers as any).rvcOperationalState.resume();
      expect(roborockAPI.resume_segment_clean).toHaveBeenCalledWith(DUID);
      expect(roborockAPI.app_start).not.toHaveBeenCalled();
    });

    it("resumes a paused full clean with app_start", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      accessory.updateFromRoborockData({ state: 10 }); // Paused
      await (accessory.handlers as any).rvcOperationalState.resume();
      expect(roborockAPI.app_start).toHaveBeenCalledWith(DUID);
      expect(roborockAPI.resume_segment_clean).not.toHaveBeenCalled();
    });

    it("docks through goHome", async () => {
      const { accessory, roborockAPI } = makeAccessory();
      await (accessory.handlers as any).rvcOperationalState.goHome();
      expect(roborockAPI.app_charge).toHaveBeenCalledWith(DUID);
    });
  });

  describe("operational error reporting", () => {
    it("maps a stuck vacuum to the Matter Stuck error", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ state: 12, error_code: 8 });
      expect(
        clusterUpdates(updateAccessoryState, "rvcOperationalState")
      ).toContainEqual({
        operationalError: {
          errorStateId: 65,
          errorStateLabel: "Device stuck",
          errorStateDetails: "Roborock error 8",
        },
      });
    });

    it("clears the error when the device recovers", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ state: 12, error_code: 8 });
      updateAccessoryState.mockClear();
      accessory.updateFromRoborockData({ state: 5, error_code: 0 });
      expect(
        clusterUpdates(updateAccessoryState, "rvcOperationalState")
      ).toContainEqual({ operationalError: { errorStateId: 0 } });
    });
  });

  describe("service area updates", () => {
    it("pushes new rooms once they become known", () => {
      const { accessory, updateAccessoryState } = makeAccessory({
        getSegmentRooms: jest.fn().mockReturnValue([]),
      });
      accessory.updateSupportedAreas(ROOMS);
      const updates = clusterUpdates(updateAccessoryState, "serviceArea");
      expect(updates).toHaveLength(1);
      expect((updates[0].supportedAreas as any[]).map((a) => a.areaId)).toEqual(
        [16, 17, 18]
      );
    });

    it("does not push an unchanged room list", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateSupportedAreas(ROOMS);
      expect(clusterUpdates(updateAccessoryState, "serviceArea")).toEqual([]);
    });

    it("tracks the room being cleaned as currentArea", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({
        state: 18,
        cleaning_info: { segment_id: 17 },
      });
      expect(
        clusterUpdates(updateAccessoryState, "serviceArea")
      ).toContainEqual({ currentArea: 17 });
    });

    it("clears currentArea for unknown or idle segments", () => {
      const { accessory, updateAccessoryState } = makeAccessory();
      accessory.updateFromRoborockData({ cleaning_info: { segment_id: 17 } });
      updateAccessoryState.mockClear();
      accessory.updateFromRoborockData({ cleaning_info: { segment_id: -1 } });
      expect(
        clusterUpdates(updateAccessoryState, "serviceArea")
      ).toContainEqual({ currentArea: null });
    });
  });
});
