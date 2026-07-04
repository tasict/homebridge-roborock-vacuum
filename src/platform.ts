import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";

import RoborockVacuumAccessory from "./vacuum_accessory";
import { RoborockVacuumMatterAccessory } from "./vacuum_matter_accessory";
import { RoborockSceneMatterAccessory } from "./scene_matter_accessory";

import RoborockPlatformLogger from "./logger";
import { RoborockPlatformConfig } from "./types";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { decryptSession } from "./crypto";
import {
  DeviceProtocol,
  isMatterFallback,
  parseDeviceIds,
  resolveDeviceProtocol,
} from "./protocol";

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
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Used to track restored cached accessories
  private readonly accessories: PlatformAccessory<String>[] = [];
  private readonly cachedAccessoriesToRemove: PlatformAccessory<String>[] = [];
  private readonly vacuums: RoborockVacuumAccessory[] = [];

  // Matter (Homebridge 2.x) — populated only when Matter is available.
  private readonly matterAccessories: Map<string, MatterAccessory> = new Map();
  private readonly matterVacuums: Map<string, RoborockVacuumMatterAccessory> =
    new Map();
  private matterEnabled = false;
  // Matter scene buttons registered this session, and per-device info needed
  // to (re)create them when scenes finish loading after startup.
  private readonly matterSceneUuids: Set<string> = new Set();
  private readonly matterDeviceInfo: Map<string, any> = new Map();
  private matterSceneSyncInProgress = false;

  public readonly roborockAPI: any;
  public readonly log: RoborockPlatformLogger;
  private readonly homebridgeLogger: Logger;

  public platformConfig: RoborockPlatformConfig;
  private readonly skippedDeviceIds: Set<string>;
  private readonly matterDeviceIds: Set<string>;

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
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.platformConfig = config as RoborockPlatformConfig;
    this.homebridgeLogger = homebridgeLogger;
    this.skippedDeviceIds = new Set(
      parseDeviceIds(this.platformConfig.skipDevices)
    );
    this.matterDeviceIds = new Set(
      parseDeviceIds(this.platformConfig.matterDevices)
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
      currentRoomMqtt: this.platformConfig.currentRoomMqtt,
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
    await this.detectMatterSupport();
    this.reconcileHapCachedAccessories();
    await this.reconcileMatterCachedAccessories();
    this.removeDeferredCachedAccessories();
    await this.loginAndDiscoverDevices();
  }

  /**
   * Detect whether the Homebridge runtime exposes an enabled Matter bridge.
   * On Homebridge 1.x, or when Matter is disabled, this stays false and every
   * device is published over HAP (Matter selections fall back with a warning).
   */
  private async detectMatterSupport(): Promise<void> {
    const available = this.api.isMatterAvailable?.() ?? false;
    const enabled = this.api.isMatterEnabled?.() ?? false;

    if (available && enabled) {
      this.matterEnabled = true;
      this.log.info("Matter support is enabled.");
      return;
    }

    this.matterEnabled = false;
    if (this.matterDeviceIds.size > 0) {
      this.log.warn(
        "One or more devices are configured for Matter, but Matter is not " +
          "available in this Homebridge. They will be published over HAP instead. " +
          'Enable Matter (Homebridge 2.x, "matter": true on the bridge or ' +
          '"_bridge") to use it.'
      );
    }
  }

  private resolveProtocol(deviceId: unknown): DeviceProtocol {
    if (typeof deviceId !== "string" && !(deviceId instanceof String)) {
      return "hap";
    }

    return resolveDeviceProtocol(`${deviceId}`, {
      skipIds: this.skippedDeviceIds,
      matterIds: this.matterDeviceIds,
      matterEnabled: this.matterEnabled,
    });
  }

  private isMatterFallbackDevice(deviceId: string): boolean {
    return isMatterFallback(deviceId, {
      skipIds: this.skippedDeviceIds,
      matterIds: this.matterDeviceIds,
      matterEnabled: this.matterEnabled,
    });
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

      if (id === "HomeData") {
        // Scenes load asynchronously; sync the Matter scene buttons once
        // they are available (or when they change).
        self.syncMatterScenes();
      } else {
        const matterVacuum = self.matterVacuums.get(id);
        if (matterVacuum) {
          const deviceData = homeData?.deviceStatus || homeData;
          matterVacuum.updateFromRoborockData(deviceData);
        }
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
  configureAccessory(restoredAccessory: PlatformAccessory) {
    // This plugin stores the device id (duid) string directly in context.
    const accessory = restoredAccessory as PlatformAccessory<String>;
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

  /**
   * Invoked by Homebridge 2.x when it restores cached Matter accessories from
   * disk at startup. Never called on Homebridge 1.x.
   */
  configureMatterAccessory(accessory: MatterAccessory) {
    this.log.info(
      `Loading Matter accessory '${accessory.displayName}' from cache.`
    );
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  isSupportedDevice(model: string): boolean {
    //model nust starts with "roborock.vacuum."
    return model.startsWith("roborock.vacuum.");
  }

  isSkippedDeviceId(deviceId: unknown): boolean {
    return this.resolveProtocol(deviceId) === "skip";
  }

  /**
   * Remove HAP cached accessories whose device is no longer published over HAP
   * (now skipped, or now published over Matter). Matter fallback devices keep
   * their HAP accessory because resolveProtocol reports them as "hap".
   */
  private reconcileHapCachedAccessories(): void {
    for (const cachedAccessory of [...this.accessories]) {
      const protocol = this.resolveProtocol(cachedAccessory.context);
      if (protocol === "hap") {
        continue;
      }

      this.unregisterCachedAccessory(
        cachedAccessory,
        protocol === "skip"
          ? "because it is configured to be skipped"
          : "because it is now published over Matter"
      );
    }
  }

  /**
   * Remove Matter cached accessories whose device is no longer published over
   * Matter (switched back to HAP, or now skipped).
   */
  private async reconcileMatterCachedAccessories(): Promise<void> {
    if (!this.matterEnabled) {
      return;
    }

    for (const [uuid, cachedAccessory] of [...this.matterAccessories]) {
      const duid = cachedAccessory.context?.duid as string | undefined;
      if (duid && this.resolveProtocol(duid) === "matter") {
        continue;
      }

      await this.unregisterMatterAccessory(
        uuid,
        cachedAccessory,
        "because it is no longer published over Matter"
      );
    }
  }

  private async unregisterMatterAccessory(
    uuid: string,
    accessory: MatterAccessory,
    reason: string
  ): Promise<void> {
    if (!this.api.matter) {
      return;
    }
    this.log.info(
      `Removing Matter accessory '${accessory.displayName}' (${uuid}) ${reason}.`
    );

    try {
      await this.api.matter.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        [accessory]
      );
    } catch (error) {
      this.log.error(
        `Unable to remove Matter accessory '${accessory.displayName}': ${error}`
      );
      this.log.debug(error);
    }

    const duid = accessory.context?.duid as string | undefined;
    if (duid && accessory.context?.sceneId === undefined) {
      this.matterVacuums.delete(duid);
    }
    this.matterAccessories.delete(uuid);
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
      const matterToRegister: MatterAccessory[] = [];

      if (self.roborockAPI.isInited()) {
        self.roborockAPI.getVacuumList().forEach(function (device) {
          var duid = device.duid;
          var name = device.name;
          var model = self.roborockAPI.getProductAttribute(duid, "model");

          const protocol = self.resolveProtocol(duid);

          if (protocol === "skip") {
            self.log.info(
              `Skipping device '${name}' (${duid}) because it is configured to be skipped.`
            );

            return;
          }

          if (!self.isSupportedDevice(model)) {
            self.log.info(`Device '${name}' (${duid}) is not supported.`);

            return;
          }

          if (self.isMatterFallbackDevice(duid)) {
            self.log.warn(
              `Device '${name}' (${duid}) is configured for Matter, but Matter ` +
                "is unavailable; publishing it over HAP instead."
            );
          }

          if (protocol === "matter") {
            self.discoverMatterDevice(device, duid, name, matterToRegister);
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

      // Register all newly discovered Matter accessories in a single batch.
      if (
        matterToRegister.length > 0 &&
        self.matterEnabled &&
        self.api.matter
      ) {
        self.log.info(
          `Registering ${matterToRegister.length} new Matter accessory(ies)...`
        );
        await self.api.matter.registerPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          matterToRegister
        );

        for (const vacuum of self.matterVacuums.values()) {
          vacuum.refreshCleanModes();
        }
      }

      // At this point, we set up all devices from Roborock App, but we did not unregister
      // cached devices that do not exist on the Roborock App account anymore.
      // Only do this when the Roborock service initialized successfully;
      // otherwise a login/network failure would wipe every cached accessory.
      if (!self.roborockAPI.isInited()) {
        this.log.warn(
          "Skipping cached accessory cleanup because the Roborock service " +
            "did not initialize successfully."
        );
        return;
      }
      for (const cachedAccessory of [...this.accessories]) {
        if (cachedAccessory.context) {
          const protocol = this.resolveProtocol(cachedAccessory.context);
          if (protocol !== "hap") {
            this.unregisterCachedAccessory(
              cachedAccessory,
              protocol === "skip"
                ? "because it is configured to be skipped"
                : "because it is now published over Matter"
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

      // Remove Matter cached accessories whose device is gone from the account.
      if (self.matterEnabled) {
        for (const [uuid, cachedAccessory] of [...self.matterAccessories]) {
          const duid = cachedAccessory.context?.duid as string | undefined;
          if (
            duid &&
            self.roborockAPI.getVacuumDeviceData(duid) === undefined
          ) {
            await self.unregisterMatterAccessory(
              uuid,
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

  private discoverMatterDevice(
    device: any,
    duid: string,
    name: string,
    toRegister: MatterAccessory[]
  ): void {
    const matter = this.api.matter;
    if (!matter) {
      this.log.warn(
        `Cannot publish '${name}' over Matter because the Matter API is unavailable.`
      );
      return;
    }
    const uuid = matter.uuid.generate(duid);
    const isCached = this.matterAccessories.has(uuid);

    const vacuum = new RoborockVacuumMatterAccessory(
      this.api,
      this.homebridgeLogger,
      this.log,
      device,
      this.roborockAPI
    );
    this.matterVacuums.set(duid, vacuum);
    this.matterDeviceInfo.set(duid, device);

    // Unlike HAP, Homebridge does not rebuild Matter endpoints or command
    // handlers from its cache — the plugin must register every accessory on
    // every launch. The Matter cache only preserves attribute state and the
    // commissioning info, so re-registering never requires re-pairing.
    this.log.info(
      isCached
        ? `Re-registering Matter accessory '${name}' (${uuid}) from cache.`
        : `Adding Matter accessory '${name}' (${uuid}).`
    );
    const accessory = vacuum.toAccessory();
    this.matterAccessories.set(uuid, accessory);
    toRegister.push(accessory);

    this.collectMatterSceneAccessories(device, duid, toRegister);

    const deviceData = this.roborockAPI.getVacuumDeviceData(duid);
    if (deviceData && deviceData.deviceStatus) {
      vacuum.updateFromRoborockData(deviceData.deviceStatus);
    }
  }

  /** Enabled Roborock scenes targeting the device (empty when unknown). */
  private getMatterScenes(duid: string): any[] {
    try {
      const scenes = this.roborockAPI.getScenesForDevice(duid) || [];
      return scenes.filter((scene: any) => scene.enabled !== false);
    } catch (error) {
      this.log.debug(`Failed to read scenes for ${duid}: ${error}`);
      return [];
    }
  }

  /**
   * Scene names that appear on more than one Matter device (or more than
   * once). Buttons for these get the vacuum name appended so they stay
   * distinguishable in the controller app.
   */
  private duplicateMatterSceneNames(): Set<string> {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const duid of this.matterDeviceInfo.keys()) {
      for (const scene of this.getMatterScenes(duid)) {
        const sceneName = String(scene.name || "");
        if (seen.has(sceneName)) {
          duplicates.add(sceneName);
        } else {
          seen.add(sceneName);
        }
      }
    }
    return duplicates;
  }

  /**
   * Create Matter scene buttons (one bridged on/off outlet per enabled
   * Roborock scene that targets the device) and queue the new ones for
   * registration. Bridged accessories carry BridgedDeviceBasicInformation,
   * so controllers show their names — child endpoints of the vacuum's node
   * do not (Apple Home renders them nameless and mislabels the node).
   * Cached buttons whose scene no longer exists are unregistered.
   */
  private collectMatterSceneAccessories(
    device: any,
    duid: string,
    toRegister: MatterAccessory[]
  ): void {
    const matter = this.api.matter;
    if (!matter) {
      return;
    }

    const duplicates = this.duplicateMatterSceneNames();
    const activeUuids = new Set<string>();
    for (const scene of this.getMatterScenes(duid)) {
      const uuid = matter.uuid.generate(`${duid}-scene-${scene.id}`);
      activeUuids.add(uuid);
      if (this.matterSceneUuids.has(uuid)) {
        continue; // Already registered this session.
      }

      const sceneName = String(scene.name || `Scene ${scene.id}`);
      const displayName = duplicates.has(sceneName)
        ? `${sceneName} (${device.name})`
        : sceneName;

      const sceneAccessory = new RoborockSceneMatterAccessory(
        this.api,
        this.homebridgeLogger,
        device,
        scene,
        displayName,
        this.roborockAPI
      ).toAccessory();

      this.log.info(
        `Adding Matter scene button '${displayName}' (${uuid}) ` +
          `for '${device.name}'.`
      );
      this.matterSceneUuids.add(uuid);
      this.matterAccessories.set(uuid, sceneAccessory);
      toRegister.push(sceneAccessory);
    }

    for (const [uuid, cached] of [...this.matterAccessories]) {
      const context = cached.context || {};
      if (
        context.duid === duid &&
        context.sceneId !== undefined &&
        !activeUuids.has(uuid)
      ) {
        this.matterSceneUuids.delete(uuid);
        this.unregisterMatterAccessory(
          uuid,
          cached,
          "because its scene no longer exists"
        ).catch((error) => {
          this.log.debug(`Failed to remove stale scene button: ${error}`);
        });
      }
    }
  }

  /**
   * Register scene buttons that become known after startup — the Roborock
   * scene list loads asynchronously, so the first HomeData notification is
   * often the earliest moment scenes exist.
   */
  private syncMatterScenes(): void {
    if (
      !this.matterEnabled ||
      !this.api.matter ||
      this.matterSceneSyncInProgress ||
      this.matterDeviceInfo.size === 0
    ) {
      return;
    }

    this.matterSceneSyncInProgress = true;
    const toRegister: MatterAccessory[] = [];
    for (const [duid, device] of this.matterDeviceInfo) {
      this.collectMatterSceneAccessories(device, duid, toRegister);
    }

    if (toRegister.length === 0) {
      this.matterSceneSyncInProgress = false;
      return;
    }

    this.api.matter
      .registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister)
      .catch((error) => {
        this.log.warn(`Failed to register Matter scene buttons: ${error}`);
      })
      .finally(() => {
        this.matterSceneSyncInProgress = false;
      });
  }

  createRoborockAccessory(accessory: PlatformAccessory<String>) {
    this.vacuums.push(new RoborockVacuumAccessory(this, accessory));
  }
}
