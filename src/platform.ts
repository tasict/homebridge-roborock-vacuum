import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";

import RoborockVacuumAccessory from "./vacuum_accessory";

import RoborockPlatformLogger from "./logger";
import { RoborockPlatformConfig } from "./types";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { forEach } from "jszip";
import { decryptSession } from "./crypto";

const DEP0040_CODE = "DEP0040";
let dep0040FilterInstalled = false;

function installDeprecationWarningFilter(): void {
  if (dep0040FilterInstalled) {
    return;
  }

  dep0040FilterInstalled = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  let dep0040Logged = false;

  process.emitWarning = ((
    warning: string | Error,
    type?: string,
    code?: string,
    ctor?: Function
  ): void => {
    const warningCode =
      typeof warning === "object" && warning !== null && "code" in warning
        ? String((warning as { code?: string }).code)
        : code;

    if (warningCode === DEP0040_CODE) {
      if (!dep0040Logged) {
        dep0040Logged = true;
        process.stderr.write(
          "[Roborock Vacuum] Suppressed Node.js DEP0040 warning from upstream dependency.\n"
        );
      }
      return;
    }

    (originalEmitWarning as (...args: unknown[]) => void)(
      warning,
      type,
      code,
      ctor
    );
  }) as typeof process.emitWarning;
}

installDeprecationWarningFilter();

const Roborock = require("../roborockLib/roborockAPI").Roborock;

/**
 * Roborock App Platform Plugin for Homebridge
 * Based on https://github.com/homebridge/homebridge-plugin-template
 */
export default class RoborockPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // Used to track restored cached accessories
  private readonly accessories: PlatformAccessory<String>[] = [];
  private readonly cachedAccessoriesToRemove: PlatformAccessory<String>[] = [];
  private readonly vacuums: RoborockVacuumAccessory[] = [];

  public readonly roborockAPI: any;
  public readonly log: RoborockPlatformLogger;

  public platformConfig: RoborockPlatformConfig;
  private readonly skippedDeviceIds: Set<string>;

  /**
   * This constructor is where you should parse the user config
   * and discover/register accessories with Homebridge.
   *
   * @param logger Homebridge logger
   * @param config Homebridge platform config
   * @param api Homebridge API
   */
  constructor(
    homebridgeLogger: Logger,
    config: PlatformConfig,
    private readonly api: API
  ) {
    this.platformConfig = config as RoborockPlatformConfig;
    this.skippedDeviceIds = new Set(
      this.parseDeviceIds(this.platformConfig.skipDevices)
    );

    // Initialise logging utility
    this.log = new RoborockPlatformLogger(
      homebridgeLogger,
      this.platformConfig.debugMode
    );
    // Create Roborock App communication module

    const username = this.platformConfig.email;
    const password = this.platformConfig.password;
    const baseURL = this.platformConfig.baseURL;
    const debugMode = this.platformConfig.debugMode;

    const storagePath = this.api.user.storagePath();
    const decryptedSession = this.platformConfig.encryptedToken
      ? decryptSession(this.platformConfig.encryptedToken, storagePath)
      : null;

    this.roborockAPI = new Roborock({
      username: username,
      password: password,
      debug: debugMode,
      baseURL: baseURL,
      log: this.log,
      userData: decryptedSession,
      storagePath: storagePath,
    });

    /**
     * When this event is fired it means Homebridge has restored all cached accessories from disk.
     * Dynamic Platform plugins should only register new accessories after this event was fired,
     * in order to ensure they weren't added to homebridge already. This event can also be used
     * to start discovery of new accessories.
     */
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug("Finished launching and restored cached accessories.");
      this.configurePlugin();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.log.debug("Shutting down...");

      if (this.roborockAPI) {
        this.roborockAPI.stopService();
      }
    });
  }

  async configurePlugin() {
    this.removeSkippedCachedAccessories();
    this.removeDeferredCachedAccessories();
    await this.loginAndDiscoverDevices();
  }

  async loginAndDiscoverDevices() {
    if (!this.platformConfig.email) {
      this.log.error(
        "Email is not configured - aborting plugin start. " +
          "Please set the field `email` in your config and restart Homebridge."
      );
      return;
    }

    if (!this.platformConfig.password && !this.platformConfig.encryptedToken) {
      this.log.error(
        "Password is not configured - aborting plugin start. " +
          "Please set `password` or complete login in the Config UI."
      );
      return;
    }

    const self = this;

    self.roborockAPI.setDeviceNotify(function (id, homeData) {
      self.log.debug(`${id} notifyDeviceUpdater:${JSON.stringify(homeData)}`);

      for (const vacuum of self.vacuums) {
        vacuum.notifyDeviceUpdater(id, homeData);
      }
    });

    self.roborockAPI.startService(function () {
      self.log.info("Service started");
      //call the discoverDevices function
      self.discoverDevices();
    });
  }

  /**
   * This function is invoked when Homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory<String>) {
    this.log.info(`Loading accessory '${accessory.displayName}' from cache.`);

    if (this.isSkippedDeviceId(accessory.context)) {
      this.log.info(
        `Accessory '${accessory.displayName}' (${accessory.context}) is configured ` +
          "to be skipped and will be removed after Homebridge finishes launching."
      );
      this.accessories.push(accessory);
      return;
    }

    // Store restored accessory in the cached accessories list
    // remove duplicates accessories

    try {
      const existingAccessory = this.accessories.find(
        (a) => a.UUID === accessory.UUID
      );
      if (existingAccessory) {
        this.log.info(
          `Accessory '${accessory.displayName}' is a duplicate and will be ` +
            "removed after Homebridge finishes launching."
        );
        this.cachedAccessoriesToRemove.push(accessory);
        return;
      }
    } catch (e) {
      this.log.error("Error loading accessory from cache: " + e);
    }

    this.accessories.push(accessory);
  }

  isSupportedDevice(model: string): boolean {
    //model nust starts with "roborock.vacuum."
    return model.startsWith("roborock.vacuum.");
  }

  parseDeviceIds(value: RoborockPlatformConfig["skipDevices"]): string[] {
    if (!value) {
      return [];
    }

    const entries = Array.isArray(value) ? value : value.split(/[\n,]+/);

    return entries
      .map((entry) => `${entry}`.trim())
      .filter((entry) => entry.length > 0);
  }

  isSkippedDeviceId(deviceId: unknown): boolean {
    if (typeof deviceId !== "string" && !(deviceId instanceof String)) {
      return false;
    }

    return this.skippedDeviceIds.has(`${deviceId}`.trim());
  }

  private removeSkippedCachedAccessories(): void {
    for (const cachedAccessory of [...this.accessories]) {
      if (this.isSkippedDeviceId(cachedAccessory.context)) {
        this.unregisterCachedAccessory(
          cachedAccessory,
          "because it is configured to be skipped"
        );
      }
    }
  }

  private removeDeferredCachedAccessories(): void {
    for (const cachedAccessory of [...this.cachedAccessoriesToRemove]) {
      this.unregisterCachedAccessory(
        cachedAccessory,
        "because another cached accessory with the same UUID was already restored"
      );
    }
  }

  private unregisterCachedAccessory(
    accessory: PlatformAccessory<String>,
    reason: string
  ): void {
    this.log.info(
      `Removing accessory '${accessory.displayName}' (${accessory.context}) ${reason}.`
    );

    try {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
      this.removeTrackedAccessory(accessory);
    } catch (error) {
      this.log.error(
        `Unable to remove accessory '${accessory.displayName}' (${accessory.context}): ${error}`
      );
      this.log.debug(error);
    }
  }

  private removeTrackedAccessory(accessory: PlatformAccessory<String>): void {
    const accessoryIndex = this.accessories.indexOf(accessory);
    if (accessoryIndex !== -1) {
      this.accessories.splice(accessoryIndex, 1);
    }

    const deferredIndex = this.cachedAccessoriesToRemove.indexOf(accessory);
    if (deferredIndex !== -1) {
      this.cachedAccessoriesToRemove.splice(deferredIndex, 1);
    }
  }

  /**
   * Fetches all of the user's devices from Roborock App and sets up handlers.
   *
   * Accessories must only be registered once. Previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    this.log.info("Discovering vacuum devices...");

    try {
      const self = this;

      if (self.roborockAPI.isInited()) {
        self.roborockAPI.getVacuumList().forEach(function (device) {
          var duid = device.duid;
          var name = device.name;
          var model = self.roborockAPI.getProductAttribute(duid, "model");

          if (self.isSkippedDeviceId(duid)) {
            self.log.info(
              `Skipping device '${name}' (${duid}) because it is configured to be skipped.`
            );

            return;
          }

          if (!self.isSupportedDevice(model)) {
            self.log.info(`Device '${name}' (${duid}) is not supported.`);

            return;
          }

          const uuid = self.api.hap.uuid.generate(device.duid);

          const existingAccessory = self.accessories.find(
            (accessory) => accessory.UUID === uuid
          );

          if (existingAccessory !== undefined) {
            self.log.info(
              `Restoring accessory '${existingAccessory.displayName}' ` +
                `(${uuid}) from cache.`
            );

            // If you need to update the accessory.context then you should run
            // `api.updatePlatformAccessories`. eg.:
            existingAccessory.context = duid;
            self.api.updatePlatformAccessories([existingAccessory]);

            // Create the accessory handler for the restored accessory

            self.createRoborockAccessory(existingAccessory);
          } else {
            // The accessory already exists, so we need to create it

            self.log.info(`Adding accessory '${name}' (${uuid}).`);
            // The accessory does not yet exist, so we need to create it
            const accessory = new self.api.platformAccessory<String>(
              name,
              uuid
            );

            // Store a copy of the device object in the `accessory.context` property,
            // which can be used to store any data about the accessory you may need.
            accessory.context = duid;

            // Create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            self.createRoborockAccessory(accessory);

            // Link the accessory to your platform
            self.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
              accessory,
            ]);
          }
        });
      }

      // At this point, we set up all devices from Roborock App, but we did not unregister
      // cached devices that do not exist on the Roborock App account anymore.
      for (const cachedAccessory of [...this.accessories]) {
        if (cachedAccessory.context) {
          if (this.isSkippedDeviceId(cachedAccessory.context)) {
            this.unregisterCachedAccessory(
              cachedAccessory,
              "because it is configured to be skipped"
            );
            continue;
          }

          const vacuum = self.roborockAPI.getVacuumDeviceData(
            cachedAccessory.context
          );

          if (vacuum === undefined) {
            // This cached devices does not exist on the Roborock App account (anymore).
            this.unregisterCachedAccessory(
              cachedAccessory,
              "because it does not exist on the Roborock account anymore"
            );
          }
        }
      }
    } catch (error) {
      this.log.error(
        "An error occurred during device discovery. " +
          "Turn on debug mode for more information."
      );
      this.log.debug(error);
    }
  }

  createRoborockAccessory(accessory: PlatformAccessory<String>) {
    this.vacuums.push(new RoborockVacuumAccessory(this, accessory));
  }
}
