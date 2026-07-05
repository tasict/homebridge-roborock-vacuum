/**
 * Roborock Vacuum Matter Accessory
 *
 * Implements Matter RoboticVacuumCleaner device type for Roborock vacuums.
 * Maps Roborock API to Matter clusters and handles bidirectional state sync.
 */

import type { API, Logger, MatterRequests } from "homebridge";
import { MatterStatus } from "homebridge";
import { BaseMatterAccessory } from "./base_matter_accessory";

function getMatterAPI(api: API): NonNullable<API["matter"]> {
  const matter = api.matter;
  if (!matter) {
    throw new Error(
      "The Homebridge Matter API is unavailable; cannot create a Matter accessory."
    );
  }
  return matter;
}
import type RoborockPlatformLogger from "./logger";

/**
 * Roborock state to Matter OperationalState mapping
 */
const ROBOROCK_STATE_TO_OPERATIONAL_STATE: Record<number, number> = {
  0: 0, // Unknown → Stopped
  1: 1, // Initiating → Running
  2: 0, // Sleeping → Stopped
  3: 0, // Idle → Stopped
  4: 1, // Remote Control → Running
  5: 1, // Cleaning → Running
  6: 1, // Returning Dock → Running
  7: 1, // Manual Mode → Running
  8: 65, // Charging → Charging (Matter state 65)
  9: 3, // Charging Error → Error
  10: 2, // Paused → Paused
  11: 1, // Spot Cleaning → Running
  12: 3, // In Error → Error
  13: 0, // Shutting Down → Stopped
  14: 0, // Updating → Stopped
  15: 1, // Docking → Running
  16: 1, // Go To → Running
  17: 1, // Zone Clean → Running
  18: 1, // Room Clean → Running
  22: 67, // Emptying dust container → EmptyingDustBin
  23: 1, // Washing the mop → Running
  26: 1, // Going to wash the mop → Running
  28: 0, // In call → Stopped
  29: 1, // Mapping → Running
  100: 66, // Fully Charged → Docked
};

// Roborock states that report the Cleaning run mode (state 29, Mapping, is
// active motion too — Mapping is not a selectable mode, so it reports as
// Cleaning).
const CLEANING_RUN_MODE_STATES = [5, 11, 17, 18, 29];

// RvcRunMode mode numbers (stable — controllers persist them).
const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;

// RvcCleanMode mode numbers (stable — controllers persist them).
const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

// RvcCleanMode mode tags (Matter spec): controllers like Apple Home derive
// the Vacuum / Mop / Vacuum & Mop choices from these tags, not the labels.
const MODE_TAG_VACUUM = 16385; // 0x4001
const MODE_TAG_MOP = 16386; // 0x4002

// Fallback motor values (V1 protocol) used when the Roborock API does not
// expose getCleanModeCapabilities: suction off (105) means mop-only, water
// off (200) means vacuum-only.
const DEFAULT_CLEAN_MODE_CAPABILITIES: CleanModeCapabilities = {
  fanOff: 105,
  fanDefault: 102,
  waterOff: 200,
  waterDefault: 202,
  mopSupported: true,
};

interface CleanModeCapabilities {
  fanOff: number;
  fanDefault: number;
  waterOff: number;
  waterDefault: number;
  mopSupported: boolean;
}

interface SegmentRoom {
  segmentId: number;
  name: string;
}

// Matter RvcOperationalState ErrorStateEnum values.
const MATTER_ERROR_NO_ERROR = 0;
const MATTER_ERROR_UNABLE_TO_COMPLETE = 2;
const MATTER_ERROR_FAILED_TO_FIND_DOCK = 64;
const MATTER_ERROR_STUCK = 65;
const MATTER_ERROR_DUST_BIN_MISSING = 66;
const MATTER_ERROR_DUST_BIN_FULL = 67;

// Roborock error_code → closest Matter ErrorStateEnum. Codes without a
// direct equivalent report UnableToCompleteOperation with the label below.
const ROBOROCK_ERROR_TO_MATTER_ERROR: Record<number, number> = {
  3: MATTER_ERROR_STUCK, // Wheel floating
  8: MATTER_ERROR_STUCK, // Device stuck
  9: MATTER_ERROR_DUST_BIN_MISSING, // Dust bin missing
  13: MATTER_ERROR_FAILED_TO_FIND_DOCK, // Charging problem
  19: MATTER_ERROR_FAILED_TO_FIND_DOCK, // Unpowered charging station
  23: MATTER_ERROR_FAILED_TO_FIND_DOCK, // Dock problem
  254: MATTER_ERROR_DUST_BIN_FULL, // Bin full
};

const ROBOROCK_ERROR_LABELS: Record<number, string> = {
  1: "Laser sensor fault",
  2: "Collision sensor fault",
  3: "Wheel floating",
  4: "Cliff sensor fault",
  5: "Main brush blocked",
  6: "Side brush blocked",
  7: "Wheel blocked",
  8: "Device stuck",
  9: "Dust bin missing",
  10: "Filter blocked",
  11: "Magnetic field detected",
  12: "Low battery",
  13: "Charging problem",
  14: "Battery failure",
  15: "Wall sensor fault",
  16: "Uneven surface",
  17: "Side brush failure",
  18: "Suction fan failure",
  19: "Unpowered charging station",
  21: "Laser pressure sensor problem",
  22: "Charge sensor problem",
  23: "Dock problem",
  24: "No-go zone or invisible wall detected",
  254: "Bin full",
  255: "Internal error",
};

function buildSupportedCleanModes(capabilities: CleanModeCapabilities) {
  const modes = [
    {
      label: "Vacuum",
      mode: CLEAN_MODE_VACUUM,
      modeTags: [{ value: MODE_TAG_VACUUM }],
    },
  ];

  if (capabilities.mopSupported) {
    modes.push(
      {
        label: "Mop",
        mode: CLEAN_MODE_MOP,
        modeTags: [{ value: MODE_TAG_MOP }],
      },
      {
        label: "Vacuum & Mop",
        mode: CLEAN_MODE_VACUUM_AND_MOP,
        modeTags: [{ value: MODE_TAG_VACUUM }, { value: MODE_TAG_MOP }],
      }
    );
  }

  return modes;
}

function toMatterArea(room: SegmentRoom) {
  return {
    areaId: room.segmentId,
    mapId: null,
    areaInfo: {
      locationInfo: {
        locationName: room.name,
        floorNumber: null,
        areaType: null,
      },
      landmarkInfo: null,
    },
  };
}

export class RoborockVacuumMatterAccessory extends BaseMatterAccessory {
  private readonly duid: string;
  private readonly roborockAPI: any;
  private readonly platformLog: RoborockPlatformLogger;
  private readonly capabilities: CleanModeCapabilities;
  private readonly supportedCleanModes: ReturnType<
    typeof buildSupportedCleanModes
  >;
  private currentOperationalState = 66; // Start docked
  private currentCleanMode: number;
  private currentRunMode = RUN_MODE_IDLE;
  private currentErrorCode = 0;
  private currentAreaId: number | null = null;
  private lastFanPower?: number;
  private lastWaterBoxMode?: number;
  // ServiceArea: rooms known to the controller and the current selection.
  private rooms: SegmentRoom[] = [];
  private selectedSegments: number[] = [];
  // Whether the running/paused clean was started as a segment (room) clean —
  // resuming one needs resume_segment_clean (app_start restarts a full clean).
  private segmentCleanActive = false;

  constructor(
    api: API,
    log: Logger,
    platformLog: RoborockPlatformLogger,
    device: any,
    roborockAPI: any
  ) {
    const productModel = device.productModel || device.model || "Unknown";
    const firmwareVersion = device.fv || "1.0.0";
    const capabilities: CleanModeCapabilities = {
      ...DEFAULT_CLEAN_MODE_CAPABILITIES,
      ...(roborockAPI.getCleanModeCapabilities?.(device.duid) ?? {}),
    };
    const supportedCleanModes = buildSupportedCleanModes(capabilities);
    const initialRooms: SegmentRoom[] =
      roborockAPI.getSegmentRooms?.(device.duid) ?? [];
    const initialCleanMode = capabilities.mopSupported
      ? CLEAN_MODE_VACUUM_AND_MOP
      : CLEAN_MODE_VACUUM;

    super(api, log, {
      UUID: getMatterAPI(api).uuid.generate(device.duid),
      displayName: device.name || "Roborock Vacuum",
      deviceType: getMatterAPI(api).deviceTypes.RoboticVacuumCleaner,
      serialNumber: device.sn || device.duid,
      manufacturer: "Roborock",
      model: productModel,
      firmwareRevision: firmwareVersion,
      hardwareRevision: "1.0.0",
      context: {
        duid: device.duid,
      },

      clusters: {
        // Power Source: Battery status
        powerSource: {
          status: 0, // Active
          order: 0, // Primary power source
          description: "Battery",
          batPercentRemaining: 200, // Start at 100% (0-200 range)
          batChargeLevel: 0, // OK
          batReplaceability: 1, // Not replaceable
        },

        // Run Mode: Idle/Cleaning
        rvcRunMode: {
          supportedModes: [
            {
              label: "Idle",
              mode: RUN_MODE_IDLE,
              modeTags: [{ value: 16384 }], // RvcRunMode.ModeTag.Idle
            },
            {
              label: "Cleaning",
              mode: RUN_MODE_CLEANING,
              modeTags: [{ value: 16385 }], // RvcRunMode.ModeTag.Cleaning
            },
          ],
          currentMode: RUN_MODE_IDLE,
        },

        // Clean Mode: Vacuum / Mop / Vacuum & Mop, gated on the model's
        // water-box support (see buildSupportedCleanModes).
        rvcCleanMode: {
          supportedModes: supportedCleanModes,
          currentMode: initialCleanMode,
        },

        // Operational State: Current state
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: 0 }, // Stopped
            { operationalStateId: 1 }, // Running
            { operationalStateId: 2 }, // Paused
            { operationalStateId: 3 }, // Error
            { operationalStateId: 64 }, // Seeking charger
            { operationalStateId: 65 }, // Charging
            { operationalStateId: 66 }, // Docked
            { operationalStateId: 67 }, // Emptying dust bin
            { operationalStateId: 68 }, // Cleaning mop
          ],
          operationalState: 66, // Start docked
        },

        // Service Area: named rooms for room-by-room cleaning. Rooms load
        // asynchronously from get_room_mapping, so this often starts empty
        // and is pushed once the cache fills (see updateSupportedAreas).
        serviceArea: {
          supportedAreas: initialRooms.map(toMatterArea),
          // matter.js reads supportedMaps unconditionally during behavior
          // initialization, so it must be present even though multi-map
          // support is not exposed (areas carry mapId: null).
          supportedMaps: [],
          selectedAreas: [],
          currentArea: null,
        },
      },

      handlers: {
        identify: {
          // Apple Home's "play sound to locate" sends the Matter Identify
          // command; map it to Roborock's find_me locate sound.
          identify: async () => this.handleIdentify(),
        },
        rvcRunMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) =>
            this.handleChangeRunMode(request),
        },
        rvcCleanMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) =>
            this.handleChangeCleanMode(request),
        },
        rvcOperationalState: {
          // Matter's RVC Operational State cluster only supports Pause,
          // Resume and GoHome; Stop/Start are driven through RvcRunMode.
          pause: async () => this.handlePause(),
          resume: async () => this.handleResume(),
          goHome: async () => this.handleGoHome(),
        },
        serviceArea: {
          selectAreas: async (request: MatterRequests.SelectAreas) =>
            this.handleSelectAreas(request),
        },
      },
    });

    this.duid = device.duid;
    this.roborockAPI = roborockAPI;
    this.platformLog = platformLog;
    this.capabilities = capabilities;
    this.supportedCleanModes = supportedCleanModes;
    this.currentCleanMode = initialCleanMode;
    this.rooms = initialRooms;

    this.logInfo("Matter accessory initialized for DUID:", this.duid);
  }

  /**
   * Handle Run Mode changes (Idle/Cleaning). Idle stops the current activity
   * (Matter semantics — docking is the separate GoHome command); Cleaning
   * starts a segment clean when rooms are selected, a full clean otherwise.
   */
  private async handleChangeRunMode(
    request: MatterRequests.ChangeToMode
  ): Promise<void> {
    const { newMode } = request;

    try {
      if (newMode === RUN_MODE_IDLE) {
        this.logInfo("Change run mode to: Idle (stop)");
        await this.roborockAPI.app_stop(this.duid);
        this.segmentCleanActive = false;
      } else if (newMode === RUN_MODE_CLEANING) {
        if (this.currentOperationalState === 2) {
          // Paused — resume instead of restarting from scratch.
          this.logInfo("Change run mode to: Cleaning (resume)");
          await this.resumeCleaning();
        } else {
          await this.startCleaning();
        }
      } else {
        throw new MatterStatus.InvalidAction(
          `Run mode ${newMode} not available`
        );
      }
    } catch (error) {
      if (MatterStatus.isMatterProtocolError(error)) {
        throw error;
      }
      this.logError("Failed to change run mode:", error);
      throw new MatterStatus.Failure("Failed to execute command");
    }
  }

  /**
   * Start cleaning: the rooms selected through ServiceArea when they are a
   * proper subset of the known rooms, everything otherwise (an empty or
   * complete selection means a full clean, like the Roborock app).
   */
  private async startCleaning(): Promise<void> {
    const segments = this.selectedSegments;
    const isSubset =
      segments.length > 0 &&
      this.rooms.length > 0 &&
      segments.length < this.rooms.length;

    if (isSubset && typeof this.roborockAPI.app_segment_clean === "function") {
      this.logInfo(
        `Change run mode to: Cleaning (rooms ${segments.join(",")})`
      );
      await this.roborockAPI.app_segment_clean(this.duid, segments);
      this.segmentCleanActive = true;
      return;
    }

    this.logInfo("Change run mode to: Cleaning (full clean)");
    await this.roborockAPI.app_start(this.duid);
    this.segmentCleanActive = false;
  }

  /** Resume a paused clean, honoring how the clean was started. */
  private async resumeCleaning(): Promise<void> {
    if (
      this.segmentCleanActive &&
      typeof this.roborockAPI.resume_segment_clean === "function"
    ) {
      await this.roborockAPI.resume_segment_clean(this.duid);
      return;
    }

    await this.roborockAPI.app_start(this.duid);
  }

  /**
   * Handle Clean Mode changes (Vacuum / Mop / Vacuum & Mop). Mapped onto the
   * Roborock motor settings: suction off = mop only, water off = vacuum
   * only, with the motor values coming from the device capabilities.
   * Existing suction/water levels are kept whenever they are compatible with
   * the requested mode.
   */
  private async handleChangeCleanMode(
    request: MatterRequests.ChangeToMode
  ): Promise<void> {
    const { newMode } = request;
    const modeNames = ["Vacuum", "Mop", "Vacuum & Mop"];
    this.logInfo(`Change clean mode to: ${modeNames[newMode] || newMode}`);

    const { fanOff, fanDefault, waterOff, waterDefault, mopSupported } =
      this.capabilities;
    const status =
      this.roborockAPI.getVacuumDeviceData(this.duid)?.deviceStatus || {};
    const fanPower: number | undefined = status.fan_power;
    const waterBoxMode: number | undefined = status.water_box_mode;
    const fanOn =
      fanPower !== undefined && fanPower !== fanOff ? fanPower : fanDefault;
    const waterOn =
      waterBoxMode !== undefined && waterBoxMode !== waterOff
        ? waterBoxMode
        : waterDefault;

    const isSupported = this.supportedCleanModes.some(
      (mode) => mode.mode === newMode
    );

    try {
      if (!isSupported) {
        throw new MatterStatus.InvalidAction(
          `Clean mode ${newMode} not available`
        );
      }

      if (newMode === CLEAN_MODE_VACUUM) {
        await this.roborockAPI.setCleanModeParameters(this.duid, {
          fan_power: fanOn,
          ...(mopSupported ? { water_box_mode: waterOff } : {}),
        });
      } else if (newMode === CLEAN_MODE_MOP) {
        await this.roborockAPI.setCleanModeParameters(this.duid, {
          fan_power: fanOff,
          water_box_mode: waterOn,
        });
      } else if (newMode === CLEAN_MODE_VACUUM_AND_MOP) {
        await this.roborockAPI.setCleanModeParameters(this.duid, {
          fan_power: fanOn,
          water_box_mode: waterOn,
        });
      }
      this.currentCleanMode = newMode;
    } catch (error) {
      if (MatterStatus.isMatterProtocolError(error)) {
        throw error;
      }
      this.logError("Failed to change clean mode:", error);
      throw new MatterStatus.Failure("Failed to change clean mode");
    }
  }

  /**
   * Handle Identify (locate) — play the vacuum's find-me sound.
   */
  private async handleIdentify(): Promise<void> {
    this.logInfo("Identify requested; playing locate sound");

    try {
      await this.roborockAPI.findMe(this.duid);
    } catch (error) {
      this.logError("Failed to play locate sound:", error);
      throw new MatterStatus.Failure("Failed to play locate sound");
    }
  }

  /**
   * Handle SelectAreas: record the rooms to clean. Cleaning itself starts on
   * the RvcRunMode change that controllers send afterwards; the Matter server
   * validates the ids against supportedAreas and updates selectedAreas.
   */
  private async handleSelectAreas(
    request: MatterRequests.SelectAreas
  ): Promise<void> {
    const newAreas = Array.isArray(request.newAreas) ? request.newAreas : [];
    const known = new Set(this.rooms.map((room) => room.segmentId));
    const unknown = newAreas.filter((areaId) => !known.has(areaId));
    if (unknown.length > 0) {
      throw new MatterStatus.InvalidAction(
        `Unknown area id(s): ${unknown.join(",")}`
      );
    }

    this.selectedSegments = [...newAreas];
    this.logInfo(
      newAreas.length > 0
        ? `Rooms selected for next clean: ${newAreas.join(",")}`
        : "Room selection cleared (full clean)"
    );
  }

  /**
   * Handle Pause command
   */
  private async handlePause(): Promise<void> {
    this.logInfo("Pausing vacuum");

    // Validate current state
    const invalidStates = [65, 66, 67, 68]; // Charging, Docked, Emptying, Cleaning mop
    if (invalidStates.includes(this.currentOperationalState)) {
      throw new MatterStatus.InvalidInState("Cannot pause in current state");
    }

    try {
      await this.roborockAPI.app_pause(this.duid);
    } catch (error) {
      this.logError("Failed to pause:", error);
      throw new MatterStatus.Failure("Failed to pause vacuum");
    }
  }

  /**
   * Handle Resume command
   */
  private async handleResume(): Promise<void> {
    this.logInfo("Resuming vacuum");

    // Validate current state
    const invalidStates = [64, 65, 66, 67, 68]; // Seeking, Charging, Docked, Emptying, Cleaning mop
    if (invalidStates.includes(this.currentOperationalState)) {
      throw new MatterStatus.InvalidInState("Cannot resume in current state");
    }

    try {
      await this.resumeCleaning();
    } catch (error) {
      this.logError("Failed to resume:", error);
      throw new MatterStatus.Failure("Failed to resume vacuum");
    }
  }

  /**
   * Handle Go Home command
   */
  private async handleGoHome(): Promise<void> {
    this.logInfo("Sending vacuum home");

    try {
      await this.roborockAPI.app_charge(this.duid);
    } catch (error) {
      this.logError("Failed to go home:", error);
      throw new MatterStatus.Failure("Failed to send vacuum home");
    }
  }

  /**
   * Push the clean-mode definition to the Matter server. Called by the
   * platform after registration so an accessory restored from cache (whose
   * cached attribute state may hold an older mode list) is brought back to
   * the current definition.
   */
  public refreshCleanModes(): void {
    this.updateState("rvcCleanMode", {
      supportedModes: this.supportedCleanModes,
      currentMode: this.currentCleanMode,
    }).catch((err) => {
      this.logError("Failed to refresh clean modes:", err);
    });
  }

  /**
   * Push the service-area definition to the Matter server. Called by the
   * platform after registration so cached attribute state (stale rooms or a
   * leftover selection from the previous session) is reset.
   */
  public refreshServiceArea(): void {
    this.updateState("serviceArea", {
      supportedAreas: this.rooms.map(toMatterArea),
      selectedAreas: this.selectedSegments,
      currentArea: this.currentAreaId,
    }).catch((err) => {
      this.logError("Failed to refresh service area:", err);
    });
  }

  /**
   * Sync the ServiceArea room list from the Roborock room-mapping cache.
   * Called by the platform whenever device data flows; only pushes to the
   * Matter server when the list actually changed.
   */
  public updateSupportedAreas(rooms: SegmentRoom[]): void {
    if (!Array.isArray(rooms)) {
      return;
    }

    const changed =
      rooms.length !== this.rooms.length ||
      rooms.some(
        (room, i) =>
          room.segmentId !== this.rooms[i].segmentId ||
          room.name !== this.rooms[i].name
      );
    if (!changed) {
      return;
    }

    this.rooms = rooms.map((room) => ({ ...room }));
    // Drop selections that no longer resolve to a known room.
    const known = new Set(this.rooms.map((room) => room.segmentId));
    this.selectedSegments = this.selectedSegments.filter((id) => known.has(id));

    this.logInfo(
      `Room list updated (${this.rooms.length} room(s)): ` +
        this.rooms.map((room) => room.name).join(", ")
    );
    this.updateState("serviceArea", {
      supportedAreas: this.rooms.map(toMatterArea),
      selectedAreas: this.selectedSegments,
    }).catch((err) => this.logError("Failed to update supported areas:", err));
  }

  /**
   * Update state from Roborock API data
   * Called by platform when device state changes
   */
  public updateFromRoborockData(data: any): void {
    try {
      // Update operational state
      if (data.state !== undefined) {
        const matterState =
          ROBOROCK_STATE_TO_OPERATIONAL_STATE[data.state] ?? 0;
        if (matterState !== this.currentOperationalState) {
          this.currentOperationalState = matterState;
          this.updateState("rvcOperationalState", {
            operationalState: matterState,
          }).catch((err) =>
            this.logError("Failed to update operational state:", err)
          );
        }
      }

      // Update the operational error from the Roborock error code.
      if (typeof data.error_code === "number") {
        this.updateOperationalError(data.error_code);
      }

      // Update battery
      if (data.battery !== undefined) {
        const batPercentRemaining = Math.max(
          0,
          Math.min(200, data.battery * 2)
        );

        let batChargeLevel = 0; // OK
        if (data.battery < 20) {
          batChargeLevel = 2; // Critical
        } else if (data.battery < 40) {
          batChargeLevel = 1; // Warning
        }

        this.updateState("powerSource", {
          batPercentRemaining,
          batChargeLevel,
        }).catch((err) => this.logError("Failed to update battery:", err));
      }

      // Update charging state
      if (data.charge_status !== undefined) {
        const batChargeState = data.charge_status === 0 ? 2 : 1; // 2 = NOT_CHARGING, 1 = CHARGING
        this.updateState("powerSource", { batChargeState }).catch((err) =>
          this.logError("Failed to update charge state:", err)
        );
      }

      // Update clean mode from the motor settings.
      if (data.fan_power !== undefined || data.water_box_mode !== undefined) {
        if (data.fan_power !== undefined) {
          this.lastFanPower = data.fan_power;
        }
        if (data.water_box_mode !== undefined) {
          this.lastWaterBoxMode = data.water_box_mode;
        }

        let cleanMode = this.capabilities.mopSupported
          ? CLEAN_MODE_VACUUM_AND_MOP
          : CLEAN_MODE_VACUUM;
        if (this.lastFanPower === this.capabilities.fanOff) {
          cleanMode = CLEAN_MODE_MOP;
        } else if (this.lastWaterBoxMode === this.capabilities.waterOff) {
          cleanMode = CLEAN_MODE_VACUUM;
        }

        if (
          cleanMode !== this.currentCleanMode &&
          this.supportedCleanModes.some((mode) => mode.mode === cleanMode)
        ) {
          this.currentCleanMode = cleanMode;
          this.updateState("rvcCleanMode", { currentMode: cleanMode }).catch(
            (err) => this.logError("Failed to update clean mode:", err)
          );
        }
      }

      // Update run mode based on state
      if (data.state !== undefined) {
        const runMode = CLEANING_RUN_MODE_STATES.includes(data.state)
          ? RUN_MODE_CLEANING
          : RUN_MODE_IDLE;

        if (runMode !== this.currentRunMode) {
          this.currentRunMode = runMode;
          this.updateState("rvcRunMode", { currentMode: runMode }).catch(
            (err) => this.logError("Failed to update run mode:", err)
          );
        }

        // A clean that ended clears the segment-clean resume flag.
        if (runMode === RUN_MODE_IDLE && this.currentOperationalState !== 2) {
          this.segmentCleanActive = false;
        }
      }

      // Update the room currently being cleaned (ServiceArea currentArea).
      if (data.cleaning_info !== undefined) {
        this.updateCurrentArea(data.cleaning_info);
      }
    } catch (error) {
      this.logError("Error updating from Roborock data:", error);
    }
  }

  private updateOperationalError(errorCode: number): void {
    if (errorCode === this.currentErrorCode) {
      return;
    }
    this.currentErrorCode = errorCode;

    const operationalError =
      errorCode === 0
        ? { errorStateId: MATTER_ERROR_NO_ERROR }
        : {
            errorStateId:
              ROBOROCK_ERROR_TO_MATTER_ERROR[errorCode] ??
              MATTER_ERROR_UNABLE_TO_COMPLETE,
            errorStateLabel:
              ROBOROCK_ERROR_LABELS[errorCode] ?? "Unknown error",
            errorStateDetails: `Roborock error ${errorCode}`,
          };

    this.updateState("rvcOperationalState", { operationalError }).catch((err) =>
      this.logError("Failed to update operational error:", err)
    );
  }

  private updateCurrentArea(cleaningInfo: unknown): void {
    let areaId: number | null = null;

    if (
      cleaningInfo &&
      typeof cleaningInfo === "object" &&
      typeof (cleaningInfo as { segment_id?: unknown }).segment_id === "number"
    ) {
      const segId = (cleaningInfo as { segment_id: number }).segment_id;
      const known = this.rooms.some((room) => room.segmentId === segId);
      areaId = segId >= 0 && known ? segId : null;
    }

    if (areaId !== this.currentAreaId) {
      this.currentAreaId = areaId;
      this.updateState("serviceArea", { currentArea: areaId }).catch((err) =>
        this.logError("Failed to update current area:", err)
      );
    }
  }
}
