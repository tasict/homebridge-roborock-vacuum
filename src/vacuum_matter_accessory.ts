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

// RvcCleanMode mode numbers (stable — controllers persist them).
const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

// RvcCleanMode mode tags (Matter spec): controllers like Apple Home derive
// the Vacuum / Mop / Vacuum & Mop choices from these tags, not the labels.
const MODE_TAG_VACUUM = 16385; // 0x4001
const MODE_TAG_MOP = 16386; // 0x4002

// Roborock motor values shared across supported models: suction off (105)
// means mop-only, water off (200) means vacuum-only.
const FAN_POWER_OFF = 105;
const FAN_POWER_BALANCED = 102;
const WATER_BOX_OFF = 200;
const WATER_BOX_MEDIUM = 202;

const SUPPORTED_CLEAN_MODES = [
  {
    label: "Vacuum",
    mode: CLEAN_MODE_VACUUM,
    modeTags: [{ value: MODE_TAG_VACUUM }],
  },
  {
    label: "Mop",
    mode: CLEAN_MODE_MOP,
    modeTags: [{ value: MODE_TAG_MOP }],
  },
  {
    label: "Vacuum & Mop",
    mode: CLEAN_MODE_VACUUM_AND_MOP,
    modeTags: [{ value: MODE_TAG_VACUUM }, { value: MODE_TAG_MOP }],
  },
];

export class RoborockVacuumMatterAccessory extends BaseMatterAccessory {
  private readonly duid: string;
  private readonly roborockAPI: any;
  private readonly platformLog: RoborockPlatformLogger;
  private currentOperationalState = 66; // Start docked
  private currentCleanMode = CLEAN_MODE_VACUUM_AND_MOP;
  private lastFanPower?: number;
  private lastWaterBoxMode?: number;

  constructor(
    api: API,
    log: Logger,
    platformLog: RoborockPlatformLogger,
    device: any,
    roborockAPI: any
  ) {
    const productModel = device.productModel || device.model || "Unknown";
    const firmwareVersion = device.fv || "1.0.0";

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

        // Run Mode: Idle/Cleaning/Mapping
        rvcRunMode: {
          supportedModes: [
            { label: "Idle", mode: 0, modeTags: [{ value: 16384 }] }, // RvcRunMode.ModeTag.Idle
            { label: "Cleaning", mode: 1, modeTags: [{ value: 16385 }] }, // RvcRunMode.ModeTag.Cleaning
            { label: "Mapping", mode: 2, modeTags: [{ value: 16386 }] }, // RvcRunMode.ModeTag.Mapping
          ],
          currentMode: 0, // Start Idle
        },

        // Clean Mode: Vacuum / Mop / Vacuum & Mop (see SUPPORTED_CLEAN_MODES)
        rvcCleanMode: {
          supportedModes: SUPPORTED_CLEAN_MODES,
          currentMode: CLEAN_MODE_VACUUM_AND_MOP,
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
      },
    });

    this.duid = device.duid;
    this.roborockAPI = roborockAPI;
    this.platformLog = platformLog;

    this.logInfo("Matter accessory initialized for DUID:", this.duid);
  }

  /**
   * Handle Run Mode changes (Idle/Cleaning/Mapping)
   */
  private async handleChangeRunMode(
    request: MatterRequests.ChangeToMode
  ): Promise<void> {
    const { newMode } = request;
    const modeNames = ["Idle", "Cleaning", "Mapping"];
    this.logInfo(`Change run mode to: ${modeNames[newMode] || "Unknown"}`);

    try {
      if (newMode === 0) {
        // Idle - return to dock
        await this.roborockAPI.app_charge(this.duid);
      } else if (newMode === 1) {
        // Cleaning - start
        await this.roborockAPI.app_start(this.duid);
      } else if (newMode === 2) {
        // Mapping mode - not directly supported, use start for now
        this.logWarn(
          "Mapping mode not directly supported, starting cleaning instead"
        );
        await this.roborockAPI.app_start(this.duid);
      }
    } catch (error) {
      this.logError("Failed to change run mode:", error);
      throw new MatterStatus.Failure("Failed to execute command");
    }
  }

  /**
   * Handle Clean Mode changes (Vacuum / Mop / Vacuum & Mop). Mapped onto the
   * Roborock motor settings: suction off (fan 105) = mop only, water off
   * (water box 200) = vacuum only. Existing suction/water levels are kept
   * whenever they are compatible with the requested mode.
   */
  private async handleChangeCleanMode(
    request: MatterRequests.ChangeToMode
  ): Promise<void> {
    const { newMode } = request;
    const modeNames = ["Vacuum", "Mop", "Vacuum & Mop"];
    this.logInfo(`Change clean mode to: ${modeNames[newMode] || newMode}`);

    const status =
      this.roborockAPI.getVacuumDeviceData(this.duid)?.deviceStatus || {};
    const fanPower: number | undefined = status.fan_power;
    const waterBoxMode: number | undefined = status.water_box_mode;
    const fanOn =
      fanPower !== undefined && fanPower !== FAN_POWER_OFF
        ? fanPower
        : FAN_POWER_BALANCED;
    const waterOn =
      waterBoxMode !== undefined && waterBoxMode !== WATER_BOX_OFF
        ? waterBoxMode
        : WATER_BOX_MEDIUM;

    try {
      if (newMode === CLEAN_MODE_VACUUM) {
        await this.roborockAPI.setCleanModeParameters(this.duid, {
          fan_power: fanOn,
          water_box_mode: WATER_BOX_OFF,
        });
      } else if (newMode === CLEAN_MODE_MOP) {
        await this.roborockAPI.setCleanModeParameters(this.duid, {
          fan_power: FAN_POWER_OFF,
          water_box_mode: waterOn,
        });
      } else if (newMode === CLEAN_MODE_VACUUM_AND_MOP) {
        await this.roborockAPI.setCleanModeParameters(this.duid, {
          fan_power: fanOn,
          water_box_mode: waterOn,
        });
      } else {
        throw new MatterStatus.InvalidAction(
          `Clean mode ${newMode} not available`
        );
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
      await this.roborockAPI.app_start(this.duid);
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
   * the current Vacuum / Mop / Vacuum & Mop definition.
   */
  public refreshCleanModes(): void {
    this.updateState("rvcCleanMode", {
      supportedModes: SUPPORTED_CLEAN_MODES,
      currentMode: this.currentCleanMode,
    }).catch((err) => {
      this.logError("Failed to refresh clean modes:", err);
    });
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
          ROBOROCK_STATE_TO_OPERATIONAL_STATE[data.state] || 0;
        if (matterState !== this.currentOperationalState) {
          this.currentOperationalState = matterState;
          this.updateState("rvcOperationalState", {
            operationalState: matterState,
          }).catch((err) =>
            this.logError("Failed to update operational state:", err)
          );
        }
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

        let cleanMode = CLEAN_MODE_VACUUM_AND_MOP;
        if (this.lastFanPower === FAN_POWER_OFF) {
          cleanMode = CLEAN_MODE_MOP;
        } else if (this.lastWaterBoxMode === WATER_BOX_OFF) {
          cleanMode = CLEAN_MODE_VACUUM;
        }

        if (cleanMode !== this.currentCleanMode) {
          this.currentCleanMode = cleanMode;
          this.updateState("rvcCleanMode", { currentMode: cleanMode }).catch(
            (err) => this.logError("Failed to update clean mode:", err)
          );
        }
      }

      // Update run mode based on state
      if (data.state !== undefined) {
        let runMode = 0; // Idle
        if ([5, 11, 17, 18].includes(data.state)) {
          runMode = 1; // Cleaning
        } else if (data.state === 29) {
          runMode = 2; // Mapping
        }

        this.updateState("rvcRunMode", { currentMode: runMode }).catch((err) =>
          this.logError("Failed to update run mode:", err)
        );
      }
    } catch (error) {
      this.logError("Error updating from Roborock data:", error);
    }
  }
}
