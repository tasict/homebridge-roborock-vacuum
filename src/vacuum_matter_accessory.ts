/**
 * Roborock Vacuum Matter Accessory
 *
 * Implements Matter RoboticVacuumCleaner device type for Roborock vacuums.
 * Maps Roborock API to Matter clusters and handles bidirectional state sync.
 */

import type { API, Logger, MatterRequests } from "homebridge";
import { MatterStatus } from "homebridge";
import { BaseMatterAccessory } from "./base_matter_accessory";
import { RoborockApi, RoborockMultiMapAreas } from "./roborock_api";
import { ROBOROCK_ERROR_LABELS } from "./error_codes";

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
  6: 64, // Returning Dock → Seeking charger
  7: 1, // Manual Mode → Running
  8: 65, // Charging → Charging (Matter state 65)
  9: 3, // Charging Error → Error
  10: 2, // Paused → Paused
  11: 1, // Spot Cleaning → Running
  12: 3, // In Error → Error
  13: 0, // Shutting Down → Stopped
  14: 0, // Updating → Stopped
  15: 64, // Docking → Seeking charger
  16: 1, // Go To → Running
  17: 1, // Zone Clean → Running
  18: 1, // Room Clean → Running
  22: 67, // Emptying dust container → EmptyingDustBin
  23: 68, // Washing the mop → Cleaning mop
  25: 68, // Washing the mop (Q7 Max family alias) → Cleaning mop
  26: 1, // Going to wash the mop → Running (still driving to the dock)
  28: 0, // In call → Stopped
  29: 1, // Mapping → Running
  33: 1, // Attaching the mop → Running (mid-run transition)
  34: 1, // Detaching the mop → Running (mid-run transition)
  100: 66, // Fully Charged → Docked
  101: 0, // Device offline → Stopped
  103: 0, // Locked → Stopped
  // B01/Q10-generation mopping states (python-roborock RoborockStateCode).
  6301: 1, // Mopping → Running
  6302: 1, // Clean+mop, vacuum phase → Running
  6303: 1, // Clean+mop, mop phase → Running
  6304: 1, // Segment mopping → Running
  6305: 1, // Segment clean+mop, vacuum phase → Running
  6306: 1, // Segment clean+mop, mop phase → Running
  6307: 1, // Zoned mopping → Running
  6308: 1, // Zoned clean+mop, vacuum phase → Running
  6309: 1, // Zoned clean+mop, mop phase → Running
  6310: 68, // Back at dock washing the duster → Cleaning mop
};

// Roborock states that report the Cleaning run mode (state 29, Mapping, is
// active motion too — Mapping is not a selectable mode, so it reports as
// Cleaning). The 63xx entries are the B01/Q10-generation mopping states.
const CLEANING_RUN_MODE_STATES = [
  5, 11, 17, 18, 29, 6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309,
];

// Status fields mirrored into Matter attributes; refreshFromDevice reads them
// from the HomeData cache by name (mapped to schema ids by the API).
const STATUS_FIELDS = [
  "state",
  "battery",
  "charge_status",
  "fan_power",
  "water_box_mode",
  "error_code",
];

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

// A room on one floor map. Whole-floor areas (see buildRooms) carry no
// segment: selecting one cleans the whole floor.
interface MapRoom {
  mapFlag: number;
  segmentId: number | null;
  name: string;
  areaId: number;
  mapId: number;
  wholeFloor?: boolean;
}

// Matter RvcOperationalState OperationalStateEnum values used by handlers.
const OP_STATE_STOPPED = 0;
const OP_STATE_PAUSED = 2;
const OP_STATE_SEEKING_CHARGER = 64;
const OP_STATE_CHARGING = 65;
const OP_STATE_DOCKED = 66;
const OP_STATE_EMPTYING_DUST_BIN = 67;
const OP_STATE_CLEANING_MOP = 68;

// Matter PowerSource BatChargeStateEnum values.
const BAT_CHARGE_STATE_IS_CHARGING = 1;
const BAT_CHARGE_STATE_IS_AT_FULL_CHARGE = 2;
const BAT_CHARGE_STATE_IS_NOT_CHARGING = 3;

// Roborock states in which the vacuum sits on its charger.
const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_FULLY_CHARGED = 100;

// ServiceArea maps. Homebridge enables the Maps feature whenever
// supportedMaps is present, and matter.js requires it to be present. With
// the feature on but supportedMaps empty (areas on mapId null), Apple Home
// showed no rooms (#60). Every saved floor map is published as its own map
// (mapId = mapFlag + 1); Apple Home shows them as a "Cleaning Map" picker.
// Segment ids repeat across floor maps, so an area id packs both:
// (mapFlag + 1) * 1000 + segmentId. The first map (mapFlag 0) and a vacuum
// with a single map keep the original ids (map id 1, area id = segment id),
// so existing room selections and automations survive the update and adding
// a floor later.
const SINGLE_MAP_ID = 1;
const AREA_ID_MAP_STRIDE = 1000;
// A map with no named rooms (floor not divided in the Roborock app) gets one
// area named after the floor: a full clean of it. Maps with rooms need none,
// since selecting every room of a map already means a full clean.
const WHOLE_FLOOR_SEGMENT = 999;

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

function isMultiMap(areas: RoborockMultiMapAreas): boolean {
  return areas.maps.length > 1;
}

function toMatterMapId(areas: RoborockMultiMapAreas, mapFlag: number): number {
  return isMultiMap(areas) ? mapFlag + 1 : SINGLE_MAP_ID;
}

function toMatterAreaId(
  areas: RoborockMultiMapAreas,
  mapFlag: number,
  segmentId: number
): number {
  return isMultiMap(areas) && mapFlag !== 0
    ? toMatterMapId(areas, mapFlag) * AREA_ID_MAP_STRIDE + segmentId
    : segmentId;
}

// Map names must be unique (matter.js rejects the attribute otherwise), but
// two maps can share a name in the Roborock app.
function toMatterMaps(areas: RoborockMultiMapAreas) {
  const names = new Set<string>();
  return areas.maps.map((map) => {
    const name = names.has(map.name)
      ? `${map.name} (${map.mapFlag + 1})`
      : map.name;
    names.add(name);
    return { mapId: toMatterMapId(areas, map.mapFlag), name };
  });
}

/**
 * Floor maps and rooms from the API. Without multi-map support in the API
 * the loaded map's rooms are published alone, as before.
 */
function readAreas(
  roborockAPI: RoborockApi,
  duid: string
): RoborockMultiMapAreas {
  if (typeof roborockAPI.getMultiMapAreas === "function") {
    return roborockAPI.getMultiMapAreas(duid);
  }
  const rooms = roborockAPI.getSegmentRooms?.(duid) ?? [];
  return {
    currentMapFlag: 0,
    maps: [{ mapFlag: 0, name: "Map" }],
    rooms: rooms.map((room) => ({ mapFlag: 0, ...room })),
  };
}

/** Rooms with area ids, plus a whole-floor area for each map without rooms. */
function buildRooms(areas: RoborockMultiMapAreas): MapRoom[] {
  const rooms: MapRoom[] = areas.rooms.map((room) => ({
    ...room,
    areaId: toMatterAreaId(areas, room.mapFlag, room.segmentId),
    mapId: toMatterMapId(areas, room.mapFlag),
  }));
  if (isMultiMap(areas)) {
    for (const map of areas.maps) {
      if (rooms.some((room) => room.mapFlag === map.mapFlag)) {
        continue;
      }
      rooms.push({
        mapFlag: map.mapFlag,
        segmentId: null,
        wholeFloor: true,
        name: map.name,
        areaId: toMatterAreaId(areas, map.mapFlag, WHOLE_FLOOR_SEGMENT),
        mapId: toMatterMapId(areas, map.mapFlag),
      });
    }
  }
  return rooms;
}

function toMatterArea(room: MapRoom) {
  return {
    areaId: room.areaId,
    mapId: room.mapId,
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
  private readonly roborockAPI: RoborockApi;
  private readonly platformLog: RoborockPlatformLogger;
  private readonly capabilities: CleanModeCapabilities;
  private readonly supportedCleanModes: ReturnType<
    typeof buildSupportedCleanModes
  >;
  private currentOperationalState = OP_STATE_DOCKED;
  private currentCleanMode: number;
  private currentRunMode = RUN_MODE_IDLE;
  private currentErrorCode = 0;
  private currentAreaId: number | null = null;
  private currentBatPercent?: number;
  private currentBatChargeLevel?: number;
  private currentBatChargeState?: number;
  // Last reported Roborock state, battery and charge_status — the charge
  // state is derived from all three.
  private lastState?: number;
  private lastBattery?: number;
  private lastChargeStatus?: number;
  private lastFanPower?: number;
  private lastWaterBoxMode?: number;
  // ServiceArea: floor maps, rooms on every floor known to the controller
  // and the current selection (area ids).
  private areas: RoborockMultiMapAreas = {
    currentMapFlag: 0,
    maps: [],
    rooms: [],
  };
  private rooms: MapRoom[] = [];
  private selectedAreaIds: number[] = [];
  // Whether the running/paused clean was started as a segment (room) clean —
  // resuming one needs resume_segment_clean (app_start restarts a full clean).
  private segmentCleanActive = false;

  constructor(
    api: API,
    log: Logger,
    platformLog: RoborockPlatformLogger,
    device: any,
    roborockAPI: RoborockApi
  ) {
    // Home-data device objects carry no model field — the model lives in the
    // products table, resolved via getProductAttribute (same as the HAP side).
    const productModel =
      roborockAPI.getProductAttribute?.(device.duid, "model") ||
      device.productModel ||
      device.model ||
      "Unknown";
    const firmwareVersion = device.fv || "1.0.0";
    const capabilities: CleanModeCapabilities = {
      ...DEFAULT_CLEAN_MODE_CAPABILITIES,
      ...(roborockAPI.getCleanModeCapabilities?.(device.duid) ?? {}),
    };
    const supportedCleanModes = buildSupportedCleanModes(capabilities);
    const initialAreas = readAreas(roborockAPI, device.duid);
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
          operationalState: OP_STATE_DOCKED,
        },

        // Service Area: named rooms for room-by-room cleaning. Rooms load
        // asynchronously from get_room_mapping, so this often starts empty
        // and is pushed once the cache fills (see updateSupportedAreas).
        serviceArea: {
          // One map per saved floor (see toMatterMaps).
          supportedMaps: toMatterMaps(initialAreas),
          supportedAreas: buildRooms(initialAreas).map(toMatterArea),
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
    this.setAreas(initialAreas);

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
        if (this.currentOperationalState === OP_STATE_PAUSED) {
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
   * proper subset of their floor's rooms, the whole floor otherwise (an
   * empty or complete selection, or a whole-floor area, means a full clean,
   * like the Roborock app). Rooms on another floor map load that map first.
   */
  private async startCleaning(): Promise<void> {
    const selected = this.selectedRooms();
    if (selected.length > 0) {
      await this.ensureMapLoaded(selected);
    }
    // ensureMapLoaded made the selection's floor the loaded one.
    const floor = selected.length > 0 ? selected[0].mapFlag : null;
    const mapRooms = this.rooms.filter(
      (room) => room.mapFlag === floor && !room.wholeFloor
    );
    const segments = selected.some((room) => room.wholeFloor)
      ? []
      : selected.map((room) => room.segmentId as number);
    const isSubset =
      segments.length > 0 &&
      mapRooms.length > 0 &&
      segments.length < mapRooms.length;

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
    const fanPower = this.readStatus("fan_power");
    const waterBoxMode = this.readStatus("water_box_mode");
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
    const byAreaId = new Map(this.rooms.map((room) => [room.areaId, room]));
    const unknown = newAreas.filter((areaId) => !byAreaId.has(areaId));
    if (unknown.length > 0) {
      throw new MatterStatus.InvalidAction(
        `Unknown area id(s): ${unknown.join(",")}`
      );
    }

    const rooms = newAreas.map((areaId) => byAreaId.get(areaId) as MapRoom);
    // One floor per clean; another floor's map is loaded when the clean
    // starts (see ensureMapLoaded), not on selection.
    this.assertSingleFloor(rooms);
    this.selectedAreaIds = [...newAreas];
    this.logInfo(
      newAreas.length > 0
        ? `Rooms selected for next clean: ${rooms
            .map((room) => room.name)
            .join(", ")}`
        : "Room selection cleared (full clean)"
    );
  }

  /** The loaded floor map's mapFlag, from the live status when known. */
  private loadedMapFlag(): number | null {
    const live = this.roborockAPI.getCurrentMapFlag?.(this.duid);
    return typeof live === "number" ? live : this.areas.currentMapFlag;
  }

  private mapName(mapFlag: number | null): string {
    const map = this.areas.maps.find((m) => m.mapFlag === mapFlag);
    return map ? map.name : `map ${mapFlag}`;
  }

  /** Throws a Matter error when the rooms span several floor maps. */
  private assertSingleFloor(rooms: MapRoom[]): void {
    const flags = [...new Set(rooms.map((room) => room.mapFlag))];
    if (flags.length > 1) {
      this.logWarn(
        `Refused rooms on several floors (${flags
          .map((flag) => this.mapName(flag))
          .join(", ")}); pick rooms from one floor.`
      );
      throw new MatterStatus.InvalidAction(
        "Rooms span more than one floor map"
      );
    }
  }

  /**
   * Make sure the rooms' floor map is loaded, switching maps (like a
   * Roborock scene that changes floors) when another floor's rooms were
   * picked. The vacuum must already be on that floor. The vacuum's own room
   * list must then name every picked room the same, also without a switch
   * (the floor may have changed in the Roborock app since the last status
   * poll), so a stale cache never cleans the wrong segment. A vacuum with a
   * single map cleans as before, without these checks.
   */
  private async ensureMapLoaded(rooms: MapRoom[]): Promise<void> {
    if (!isMultiMap(this.areas)) {
      return;
    }
    this.assertSingleFloor(rooms);
    const target = rooms[0].mapFlag;
    const loaded = this.loadedMapFlag();
    if (typeof this.roborockAPI.switchToMap !== "function") {
      if (target === loaded) {
        return;
      }
      throw new MatterStatus.InvalidInState(
        `Vacuum is on ${this.mapName(loaded)}, not ${this.mapName(target)}`
      );
    }

    if (target !== loaded) {
      this.logInfo(
        `Switching map '${this.mapName(loaded)}' -> '${this.mapName(
          target
        )}' for this clean`
      );
    }
    let names: Record<string, string>;
    try {
      names = await this.roborockAPI.switchToMap(this.duid, target);
    } catch (error) {
      this.logWarn(
        `Map switch to '${this.mapName(target)}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw new MatterStatus.InvalidInState(
        `Could not load ${this.mapName(target)}`
      );
    }

    const mismatch = rooms.filter(
      (room) => !room.wholeFloor && names[String(room.segmentId)] !== room.name
    );
    if (mismatch.length > 0) {
      this.logWarn(
        `Refused clean: after loading '${this.mapName(
          target
        )}' the vacuum does not list ${mismatch
          .map((room) => room.name)
          .join(", ")}`
      );
      // switchToMap cached the vacuum's current rooms; publish them.
      this.updateSupportedAreas();
      throw new MatterStatus.InvalidInState(
        "Rooms changed on the vacuum; try again"
      );
    }
    this.areas.currentMapFlag = target;
  }

  private selectedRooms(): MapRoom[] {
    const byAreaId = new Map(this.rooms.map((room) => [room.areaId, room]));
    return this.selectedAreaIds
      .map((areaId) => byAreaId.get(areaId))
      .filter((room): room is MapRoom => room !== undefined);
  }

  private setAreas(areas: RoborockMultiMapAreas): void {
    this.areas = areas;
    this.rooms = buildRooms(areas);
  }

  /**
   * Handle Pause command
   */
  private async handlePause(): Promise<void> {
    this.logInfo("Pausing vacuum");

    const invalidStates = [
      OP_STATE_CHARGING,
      OP_STATE_DOCKED,
      OP_STATE_EMPTYING_DUST_BIN,
      OP_STATE_CLEANING_MOP,
    ];
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
   * Handle Resume command. Controllers may send Resume rather than a
   * run-mode change for their start button (Apple Home did while the run
   * mode read Cleaning, #60), so a Resume from a stopped or docked vacuum
   * starts a clean instead of being refused.
   */
  private async handleResume(): Promise<void> {
    const state = this.currentOperationalState;
    if (
      state === OP_STATE_EMPTYING_DUST_BIN ||
      state === OP_STATE_CLEANING_MOP
    ) {
      throw new MatterStatus.InvalidInState("Cannot resume in current state");
    }

    const startStates = [
      OP_STATE_STOPPED,
      OP_STATE_SEEKING_CHARGER,
      OP_STATE_CHARGING,
      OP_STATE_DOCKED,
    ];

    try {
      if (startStates.includes(state)) {
        this.logInfo(
          "Resume requested with no clean in progress; starting one"
        );
        await this.startCleaning();
      } else {
        this.logInfo("Resuming vacuum");
        await this.resumeCleaning();
      }
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
    // supportedMaps goes first: the areas' mapId must resolve against it.
    this.updateState("serviceArea", {
      supportedMaps: toMatterMaps(this.areas),
      supportedAreas: this.rooms.map(toMatterArea),
      selectedAreas: this.selectedAreaIds,
      currentArea: this.currentAreaId,
    }).catch((err) => {
      this.logError("Failed to refresh service area:", err);
    });
  }

  /**
   * Re-seed every status attribute from the HomeData device cache. The raw
   * cache is keyed by schema id, so fields are read through the API's
   * name-to-id mapping (getVacuumDeviceStatus). The platform calls this with
   * force=true once after registration — attribute pushes before registration
   * are discarded by the Matter server, and attribute state restored from the
   * Matter cache may be stale — and without force on every HomeData refresh,
   * the only periodic status source.
   */
  public refreshFromDevice(force = false): void {
    const data: Record<string, number> = {};
    for (const field of STATUS_FIELDS) {
      const value = this.readStatus(field);
      if (value !== undefined) {
        data[field] = value;
      }
    }
    this.updateFromRoborockData(data, force);
  }

  /** One status field from the HomeData cache (mapped to its schema id). */
  private readStatus(field: string): number | undefined {
    const value = this.roborockAPI.getVacuumDeviceStatus(this.duid, field);
    return typeof value === "number" ? value : undefined;
  }

  /**
   * Sync the ServiceArea maps and rooms from the Roborock caches (floor
   * maps, rooms of every floor). Called by the platform whenever device data
   * flows; only pushes to the Matter server when the list actually changed.
   */
  public updateSupportedAreas(
    areas: RoborockMultiMapAreas = readAreas(this.roborockAPI, this.duid)
  ): void {
    if (!areas || !Array.isArray(areas.rooms) || !Array.isArray(areas.maps)) {
      return;
    }

    const key = (a: RoborockMultiMapAreas) => JSON.stringify([a.maps, a.rooms]);
    if (key(areas) === key(this.areas)) {
      this.areas.currentMapFlag = areas.currentMapFlag;
      return;
    }

    this.setAreas(areas);
    // Drop selections that no longer resolve to a known room.
    const known = new Set(this.rooms.map((room) => room.areaId));
    this.selectedAreaIds = this.selectedAreaIds.filter((id) => known.has(id));

    this.logInfo(
      `Room list updated (${this.rooms.length} room(s) on ${this.areas.maps.length} map(s)): ` +
        this.rooms.map((room) => room.name).join(", ")
    );
    this.updateState("serviceArea", {
      supportedMaps: toMatterMaps(this.areas),
      supportedAreas: this.rooms.map(toMatterArea),
      selectedAreas: this.selectedAreaIds,
    }).catch((err) => this.logError("Failed to update supported areas:", err));
  }

  /**
   * Update state from Roborock API data. Called by the platform when device
   * state changes; force bypasses the change-detection mirrors so every
   * present field is published (used for the post-registration seed).
   */
  public updateFromRoborockData(data: any, force = false): void {
    try {
      // Update operational state
      if (data.state !== undefined) {
        const matterState =
          ROBOROCK_STATE_TO_OPERATIONAL_STATE[data.state] ?? 0;
        if (force || matterState !== this.currentOperationalState) {
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
        this.updateOperationalError(data.error_code, force);
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

        if (
          force ||
          batPercentRemaining !== this.currentBatPercent ||
          batChargeLevel !== this.currentBatChargeLevel
        ) {
          this.currentBatPercent = batPercentRemaining;
          this.currentBatChargeLevel = batChargeLevel;
          this.updateState("powerSource", {
            batPercentRemaining,
            batChargeLevel,
          }).catch((err) => this.logError("Failed to update battery:", err));
        }
      }

      // Update charging state
      if (typeof data.state === "number") {
        this.lastState = data.state;
      }
      if (typeof data.battery === "number") {
        this.lastBattery = data.battery;
      }
      if (typeof data.charge_status === "number") {
        this.lastChargeStatus = data.charge_status;
      }
      const batChargeState = this.deriveBatChargeState();
      if (
        batChargeState !== undefined &&
        (force || batChargeState !== this.currentBatChargeState)
      ) {
        this.currentBatChargeState = batChargeState;
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
          (force || cleanMode !== this.currentCleanMode) &&
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

        if (force || runMode !== this.currentRunMode) {
          this.currentRunMode = runMode;
          this.updateState("rvcRunMode", { currentMode: runMode }).catch(
            (err) => this.logError("Failed to update run mode:", err)
          );
        }

        // A clean that ended clears the segment-clean resume flag.
        if (
          runMode === RUN_MODE_IDLE &&
          this.currentOperationalState !== OP_STATE_PAUSED
        ) {
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

  /**
   * Matter charge state from charge_status, or — on models whose status
   * lacks it — from the charger states. Undefined until either is known.
   */
  private deriveBatChargeState(): number | undefined {
    const onCharger =
      this.lastState === ROBOROCK_STATE_CHARGING ||
      this.lastState === ROBOROCK_STATE_FULLY_CHARGED;
    let charging: boolean;
    if (this.lastChargeStatus !== undefined) {
      charging = this.roborockAPI.isBatteryCharging(
        this.duid,
        this.lastChargeStatus,
        this.lastState
      );
    } else if (this.lastState !== undefined) {
      charging = onCharger;
    } else {
      return undefined;
    }

    if (!charging) {
      return BAT_CHARGE_STATE_IS_NOT_CHARGING;
    }
    return this.lastState === ROBOROCK_STATE_FULLY_CHARGED ||
      this.lastBattery === 100
      ? BAT_CHARGE_STATE_IS_AT_FULL_CHARGE
      : BAT_CHARGE_STATE_IS_CHARGING;
  }

  private updateOperationalError(errorCode: number, force = false): void {
    if (!force && errorCode === this.currentErrorCode) {
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
      const mapFlag = this.loadedMapFlag();
      const room = this.rooms.find(
        (r) => r.segmentId === segId && r.mapFlag === mapFlag
      );
      areaId = segId >= 0 && room ? room.areaId : null;
    }

    if (areaId !== this.currentAreaId) {
      this.currentAreaId = areaId;
      this.updateState("serviceArea", { currentArea: areaId }).catch((err) =>
        this.logError("Failed to update current area:", err)
      );
    }
  }
}
