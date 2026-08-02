import { Service, PlatformAccessory, CharacteristicValue } from "homebridge";
import RoborockPlatform from "./platform";

/**
 * An instance of this class is created for each accessory the platform registers.
 * Each accessory may expose multiple services of different service types.
 */
// Roborock device states meaning the dock is washing the mop (23) or the
// vacuum is on its way to be washed (26).
const MOP_WASHING_STATES = [23, 26];

// Consumables reported as remaining-life percentages in the HomeData device
// status, exposed as HomeKit FilterMaintenance services. The translation keys
// are the short consumable names from the reset actions ("Filter", ...).
const CONSUMABLES = [
  {
    code: "filter_life",
    subtype: "filter",
    nameKey: "reset_filter_work_time",
    fallbackName: "Filter",
  },
  {
    code: "main_brush_life",
    subtype: "main-brush",
    nameKey: "reset_main_brush_work_time",
    fallbackName: "Main brush",
  },
  {
    code: "side_brush_life",
    subtype: "side-brush",
    nameKey: "reset_side_brush_work_time",
    fallbackName: "Side brush",
  },
];

// Remaining life at or below which HomeKit shows the "change filter" alert —
// matches the Roborock app, which nags when a consumable is nearly used up.
const CONSUMABLE_CHANGE_THRESHOLD = 5;

export default class RoborockVacuumAccessory {
  private services: Service[] = [];
  private sceneServices: Map<string, Service> = new Map();
  private currentScenes: any[] = [];
  private dockWashService?: Service;

  constructor(
    private readonly platform: RoborockPlatform,
    private readonly accessory: PlatformAccessory<String>
  ) {
    const self = this;

    // Accessory Information
    // https://developers.homebridge.io/#/service/AccessoryInformation
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.platform.roborockAPI.getProductAttribute(
          accessory.context,
          "model"
        ) || "Unknown"
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.platform.roborockAPI.getVacuumDeviceInfo(
          accessory.context,
          "sn"
        ) || "Unknown"
      )
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.platform.roborockAPI.getVacuumDeviceInfo(
          accessory.context,
          "fv"
        ) || "Unknown"
      );

    this.services["Fan"] =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    // This is what is displayed as the default name on the Home app
    this.services["Fan"].setCharacteristic(
      this.platform.Characteristic.Name,
      this.platform.roborockAPI.getVacuumDeviceInfo(
        accessory.context,
        "name"
      ) || "Roborock Vacuum"
    );

    this.services["Fan"]
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // Device error code and cloud online flag, surfaced on the main service.
    this.services["Fan"].addOptionalCharacteristic(
      this.platform.Characteristic.StatusFault
    );
    this.services["Fan"].addOptionalCharacteristic(
      this.platform.Characteristic.StatusActive
    );

    this.services["Battery"] =
      this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery);

    this.services["Battery"].setCharacteristic(
      this.platform.Characteristic.BatteryLevel,
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "battery"
      ) || 0
    );

    this.services["Battery"].setCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "battery"
      ) < 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
    );

    this.services["Battery"].setCharacteristic(
      this.platform.Characteristic.ChargingState,
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "charge_status"
      ) == 1
        ? this.platform.Characteristic.ChargingState.CHARGING
        : this.platform.Characteristic.ChargingState.NOT_CHARGING
    );

    // Initialize scene switches
    this.updateSceneSwitches();

    // Dock mop-wash switch (only on washing-capable docks)
    this.updateDockWashSwitch();

    // Seed fault/online/consumable state from the already-loaded HomeData
    // instead of waiting for the first poll.
    this.updateDeviceState();
  }

  /**
   * Add or remove the dock mop-wash switch depending on whether the device
   * reports a washing-capable dock. The subtype is fixed ("dock-wash") so a
   * language change only renames the service and never re-creates it.
   */
  updateDockWashSwitch() {
    try {
      const supported = this.platform.roborockAPI.isDockWashSupported(
        this.accessory.context
      );
      const existingService = this.accessory.getServiceById(
        this.platform.Service.Switch,
        "dock-wash"
      );

      if (!supported) {
        if (existingService) {
          this.platform.log.debug(
            `Removing dock wash switch for device ${this.accessory.context}`
          );
          this.accessory.removeService(existingService);
        }
        this.dockWashService = undefined;
        return;
      }

      if (this.dockWashService) {
        return;
      }

      const switchName =
        this.platform.roborockAPI.getTranslation("app_start_wash");

      this.platform.log.debug(
        `Adding dock wash switch '${switchName}' for device ${this.accessory.context}`
      );

      const switchService =
        existingService ||
        this.accessory.addService(
          this.platform.Service.Switch,
          switchName,
          "dock-wash"
        );

      switchService.setCharacteristic(
        this.platform.Characteristic.Name,
        switchName
      );
      switchService.addOptionalCharacteristic(
        this.platform.Characteristic.ConfiguredName
      );
      switchService.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        switchName
      );

      switchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setDockWash.bind(this))
        .onGet(this.getDockWash.bind(this));

      this.dockWashService = switchService;
    } catch (error) {
      this.platform.log.error(`Error updating dock wash switch: ${error}`);
    }
  }

  async setDockWash(value: CharacteristicValue) {
    try {
      if (value) {
        await this.platform.roborockAPI.app_start_wash(this.accessory.context);
      } else {
        await this.platform.roborockAPI.app_stop_wash(this.accessory.context);
      }
    } catch (error) {
      this.platform.log.error(`Error setting dock wash: ${error}`);
      this.dockWashService?.updateCharacteristic(
        this.platform.Characteristic.On,
        this.isWashing()
      );
    }
  }

  async getDockWash(): Promise<CharacteristicValue> {
    return this.isWashing();
  }

  isWashing(): boolean {
    return this.isWashingState(
      this.platform.roborockAPI.getVacuumDeviceStatus(
        this.accessory.context,
        "state"
      )
    );
  }

  isWashingState(state: number): boolean {
    return MOP_WASHING_STATES.includes(state);
  }

  private updateDockWashState(state: number) {
    this.dockWashService?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.isWashingState(state)
    );
  }

  updateDeviceState() {
    try {
      this.services["Fan"].updateCharacteristic(
        this.platform.Characteristic.Active,
        this.platform.roborockAPI.isCleaning(
          this.platform.roborockAPI.getVacuumDeviceStatus(
            this.accessory.context,
            "state"
          )
        )
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE
      );

      this.services["Battery"].updateCharacteristic(
        this.platform.Characteristic.BatteryLevel,
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "battery"
        ) || 0
      );

      this.services["Battery"].updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "battery"
        ) < 20
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );

      this.services["Battery"].updateCharacteristic(
        this.platform.Characteristic.ChargingState,
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "charge_status"
        ) != 0
          ? this.platform.Characteristic.ChargingState.CHARGING
          : this.platform.Characteristic.ChargingState.NOT_CHARGING
      );

      this.updateDockWashState(
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "state"
        )
      );

      // The firmware version (fv) may be missing from the first HomeData
      // snapshot and changes after device OTA updates, so refresh it on
      // every poll instead of trusting the constructor-time value.
      const firmwareVersion = this.platform.roborockAPI.getVacuumDeviceInfo(
        this.accessory.context,
        "fv"
      );
      if (firmwareVersion) {
        this.accessory
          .getService(this.platform.Service.AccessoryInformation)
          ?.updateCharacteristic(
            this.platform.Characteristic.FirmwareRevision,
            firmwareVersion
          );
      }

      this.updateStatusFault(
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "error_code"
        )
      );

      // Cloud-reported online flag; anything but an explicit false counts as
      // online so an unknown value never flags a healthy device.
      this.services["Fan"].updateCharacteristic(
        this.platform.Characteristic.StatusActive,
        this.platform.roborockAPI.getVacuumDeviceInfo(
          this.accessory.context,
          "online"
        ) !== false
      );

      this.updateConsumables();

      this.platform.log.debug(
        "Device state is " +
          this.state_code_to_state(
            this.platform.roborockAPI.getVacuumDeviceStatus(
              this.accessory.context,
              "state"
            )
          )
      );
    } catch (e) {
      this.platform.log.error("Error updating device state: " + e);
    }
  }

  private updateStatusFault(errorCode: unknown) {
    const code = Number(errorCode);
    this.services["Fan"].updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      Number.isFinite(code) && code !== 0
        ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
        : this.platform.Characteristic.StatusFault.NO_FAULT
    );
  }

  /**
   * Expose consumable remaining-life percentages (filter, brushes) as
   * FilterMaintenance services. A service is only created once its value
   * shows up in the device status, so models without a consumable in their
   * schema never get an empty tile.
   */
  private updateConsumables() {
    for (const consumable of CONSUMABLES) {
      const rawLife = this.platform.roborockAPI.getVacuumDeviceStatus(
        this.accessory.context,
        consumable.code
      );
      const life = Number(rawLife);
      if (rawLife === "" || rawLife == null || !Number.isFinite(life)) {
        continue;
      }

      let service = this.accessory.getServiceById(
        this.platform.Service.FilterMaintenance,
        consumable.subtype
      );
      if (!service) {
        const name =
          this.platform.roborockAPI.getTranslation?.(consumable.nameKey) ||
          consumable.fallbackName;
        service = this.accessory.addService(
          this.platform.Service.FilterMaintenance,
          name,
          consumable.subtype
        );
        service.setCharacteristic(this.platform.Characteristic.Name, name);
        service.addOptionalCharacteristic(
          this.platform.Characteristic.ConfiguredName
        );
        service.setCharacteristic(
          this.platform.Characteristic.ConfiguredName,
          name
        );
        service.addOptionalCharacteristic(
          this.platform.Characteristic.FilterLifeLevel
        );
      }

      const clampedLife = Math.max(0, Math.min(100, life));
      service.updateCharacteristic(
        this.platform.Characteristic.FilterLifeLevel,
        clampedLife
      );
      service.updateCharacteristic(
        this.platform.Characteristic.FilterChangeIndication,
        clampedLife <= CONSUMABLE_CHANGE_THRESHOLD
          ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.platform.Characteristic.FilterChangeIndication.FILTER_OK
      );
    }
  }

  /**
   * Update scene switches based on available scenes for this device
   */
  updateSceneSwitches() {
    try {
      // Get scenes for this device
      const deviceScenes = this.platform.roborockAPI.getScenesForDevice(
        this.accessory.context
      );

      // Check if scenes have changed
      if (this.scenesChanged(deviceScenes)) {
        this.platform.log.debug(
          `Updating scene switches for device ${this.accessory.context}`
        );

        // Remove existing scene switches that are no longer available

        // Add new scene switches
        for (const scene of deviceScenes) {
          try {
            const sceneId = scene.id.toString();
            const sceneName = scene.name.replaceAll(" ", "_");
            if (!this.sceneServices.has(sceneId) && scene.enabled) {
              this.platform.log.debug(
                `Adding scene switch for: ${scene.name} (ID: ${sceneId})`
              );

              const switchService =
                this.accessory.getServiceById(
                  this.platform.Service.Switch,
                  `scene-${sceneId}`
                ) ||
                this.accessory.addService(
                  this.platform.Service.Switch,
                  sceneName,
                  `scene-${sceneId}`
                );

              switchService.setCharacteristic(
                this.platform.Characteristic.Name,
                sceneName
              );

              switchService.addOptionalCharacteristic(
                this.platform.Characteristic.ConfiguredName
              );
              switchService.setCharacteristic(
                this.platform.Characteristic.ConfiguredName,
                sceneName
              );

              switchService
                .getCharacteristic(this.platform.Characteristic.On)
                .onSet(this.setSceneSwitch.bind(this, sceneId))
                .onGet(this.getSceneSwitch.bind(this, sceneId));

              this.sceneServices.set(sceneId, switchService);
            }
          } catch (e) {
            this.platform.log.error(
              `Error processing scene ${scene.name}: ${e}`
            );
          }
        }

        //Remove scene switches that are no longer available
        this.accessory.services.forEach((service) => {
          if (
            service instanceof this.platform.Service.Switch &&
            service.subtype?.startsWith("scene-")
          ) {
            const sceneId = service.subtype.replace("scene-", "");

            // Check if the scene id in deviceScenes
            if (
              !deviceScenes.some((scene) => scene.id.toString() === sceneId)
            ) {
              this.platform.log.debug(
                `Removing scene switch for: ${service.displayName} (ID: ${sceneId})`
              );
              this.accessory.removeService(service);
              this.sceneServices.delete(sceneId);
            }
          }
        });

        // Update current scenes
        this.currentScenes = deviceScenes;
      }
    } catch (error) {
      this.platform.log.error(`Error updating scene switches: ${error}`);
    }
  }

  /**
   * Check if scenes have changed
   */
  private scenesChanged(newScenes: any[]): boolean {
    if (this.currentScenes.length !== newScenes.length) {
      return true;
    }

    const currentIds = this.currentScenes.map((scene) => scene.id).sort();
    const newIds = newScenes.map((scene) => scene.id).sort();

    return JSON.stringify(currentIds) !== JSON.stringify(newIds);
  }

  /**
   * Handle scene switch activation
   */
  async setSceneSwitch(sceneId: string, value: CharacteristicValue) {
    try {
      this.platform.log.debug(`Scene switch ${sceneId} set to: ${value}`);

      if (value) {
        // Execute the scene
        await this.platform.roborockAPI.executeScene({ val: sceneId });
        this.platform.log.info(`Executed scene ID: ${sceneId}`);

        // Turn off the switch after execution (momentary switch behavior)
        setTimeout(() => {
          const service = this.sceneServices.get(sceneId);
          if (service) {
            service.updateCharacteristic(
              this.platform.Characteristic.On,
              false
            );
          }
        }, 1000);
      }
    } catch (error) {
      this.platform.log.error(`Error executing scene ${sceneId}: ${error}`);

      // Turn off the switch if there was an error
      const service = this.sceneServices.get(sceneId);
      if (service) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    }
  }

  /**
   * Get scene switch state (always returns false for momentary behavior)
   */
  async getSceneSwitch(sceneId: string): Promise<CharacteristicValue> {
    return false; // Momentary switch - always return false
  }

  /**
   * Handle a device-notify payload from the platform. CloudMessage and
   * LocalMessage payloads arrive unwrapped and with dps ids already
   * translated to named fields (see the platform's setDeviceNotify fan-out).
   */
  notifyDeviceUpdater(id: string, data) {
    try {
      if (id == "CloudMessage" || id == "LocalMessage") {
        this.platform.log.debug(
          `Updating accessory with ${id} data: ` + JSON.stringify(data)
        );

        if (data.hasOwnProperty("state")) {
          this.services["Fan"].updateCharacteristic(
            this.platform.Characteristic.Active,
            this.isCleaningState(data.state)
              ? this.platform.Characteristic.Active.ACTIVE
              : this.platform.Characteristic.Active.INACTIVE
          );

          this.updateDockWashState(data.state);
        }

        if (data.hasOwnProperty("battery")) {
          this.services["Battery"].updateCharacteristic(
            this.platform.Characteristic.BatteryLevel,
            data.battery
          );

          this.services["Battery"].updateCharacteristic(
            this.platform.Characteristic.StatusLowBattery,
            data.battery < 20
              ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
              : this.platform.Characteristic.StatusLowBattery
                  .BATTERY_LEVEL_NORMAL
          );
        }

        if (data.hasOwnProperty("charge_status")) {
          this.services["Battery"].updateCharacteristic(
            this.platform.Characteristic.ChargingState,
            data.charge_status != 0
              ? this.platform.Characteristic.ChargingState.CHARGING
              : this.platform.Characteristic.ChargingState.NOT_CHARGING
          );
        }

        if (data.hasOwnProperty("in_cleaning")) {
          this.services["Fan"].updateCharacteristic(
            this.platform.Characteristic.Active,
            data.in_cleaning != 0
              ? this.platform.Characteristic.Active.ACTIVE
              : this.platform.Characteristic.Active.INACTIVE
          );
        }

        if (data.hasOwnProperty("error_code")) {
          this.updateStatusFault(data.error_code);
        }
      } else if (id == "HomeData") {
        this.updateDeviceState();
        // Update scene switches when home data changes
        this.updateSceneSwitches();
        // Dock-wash support can become known after startup
        this.updateDockWashSwitch();
      }
    } catch (e) {
      this.platform.log.error("Error notifying device updater: " + e);
    }
  }

  async setActive(value: CharacteristicValue) {
    try {
      this.platform.log.debug("Setting active to " + value);

      if (value == this.platform.Characteristic.Active.ACTIVE) {
        await this.platform.roborockAPI.app_start(this.accessory.context);
      } else {
        await this.platform.roborockAPI.app_stop(this.accessory.context);
        await this.platform.roborockAPI.app_charge(this.accessory.context);
      }

      this.services["Fan"].updateCharacteristic(
        this.platform.Characteristic.Active,
        value
      );
    } catch (e) {
      this.platform.log.error("Error setting active: " + e);
    }
  }

  async getActive(): Promise<CharacteristicValue> {
    this.updateDeviceState();
    return this.isCleaning()
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  state_code_to_state(code: number): string {
    const RoborockStateCodes = {
      0: "Unknown",
      1: "Initiating",
      2: "Sleeping",
      3: "Idle",
      4: "Remote Control",
      5: "Cleaning",
      6: "Returning Dock",
      7: "Manual Mode",
      8: "Charging",
      9: "Charging Error",
      10: "Paused",
      11: "Spot Cleaning",
      12: "In Error",
      13: "Shutting Down",
      14: "Updating",
      15: "Docking",
      16: "Go To",
      17: "Zone Clean",
      18: "Room Clean",
      22: "Empying dust container",
      23: "Washing the mop",
      26: "Going to wash the mop",
      28: "In call",
      29: "Mapping",
      100: "Fully Charged",
    };

    return RoborockStateCodes[code] || "Unknown";
  }

  isCleaning(): boolean {
    return this.isCleaningState(
      this.platform.roborockAPI.getVacuumDeviceStatus(
        this.accessory.context,
        "state"
      )
    );
  }

  isCleaningState(state: number): boolean {
    switch (state) {
      case 4: // Remote Control
      case 5: // Cleaning
      case 6: // Returning Dock
      case 7: // Manual Mode
      case 11: // Spot Cleaning
      case 15: // Docking
      case 16: // Go To
      case 17: // Zone Clean
      case 18: // Room Clean
      case 23: // Washing the mop
      case 26: // Going to wash the mop
        return true;
      default:
        return false;
    }
  }
}
