"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const homebridge_1 = require("homebridge");
const vacuum_accessory_1 = __importDefault(require("./vacuum_accessory"));
const logger_1 = __importDefault(require("./logger"));
const settings_1 = require("./settings");
const crypto_1 = require("./crypto");
const DEP0040_CODE = "DEP0040";
let dep0040FilterInstalled = false;
function installDeprecationWarningFilter() {
    if (dep0040FilterInstalled) {
        return;
    }
    dep0040FilterInstalled = true;
    const originalEmitWarning = process.emitWarning.bind(process);
    let dep0040Logged = false;
    process.emitWarning = ((warning, type, code, ctor) => {
        const warningCode = typeof warning === "object" && warning !== null && "code" in warning
            ? String(warning.code)
            : code;
        if (warningCode === DEP0040_CODE) {
            if (!dep0040Logged) {
                dep0040Logged = true;
                process.stderr.write("[Roborock Vacuum] Suppressed Node.js DEP0040 warning from upstream dependency.\n");
            }
            return;
        }
        originalEmitWarning(warning, type, code, ctor);
    });
}
installDeprecationWarningFilter();
const Roborock = require("../roborockLib/roborockAPI").Roborock;
/**
 * Roborock App Platform Plugin for Homebridge
 * Based on https://github.com/homebridge/homebridge-plugin-template
 */
class RoborockPlatform {
    /**
     * This constructor is where you should parse the user config
     * and discover/register accessories with Homebridge.
     *
     * @param logger Homebridge logger
     * @param config Homebridge platform config
     * @param api Homebridge API
     */
    constructor(homebridgeLogger, config, api) {
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        // Used to track restored cached accessories
        this.accessories = [];
        this.vacuums = [];
        this.platformConfig = config;
        this.skippedDeviceIds = new Set(this.parseDeviceIds(this.platformConfig.skipDevices));
        // Initialise logging utility
        this.log = new logger_1.default(homebridgeLogger, this.platformConfig.debugMode);
        // Create Roborock App communication module
        const username = this.platformConfig.email;
        const password = this.platformConfig.password;
        const baseURL = this.platformConfig.baseURL;
        const debugMode = this.platformConfig.debugMode;
        const storagePath = this.api.user.storagePath();
        const decryptedSession = this.platformConfig.encryptedToken
            ? (0, crypto_1.decryptSession)(this.platformConfig.encryptedToken, storagePath)
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
        this.api.on(homebridge_1.APIEvent.DID_FINISH_LAUNCHING, () => {
            this.log.debug("Finished launching and restored cached accessories.");
            this.configurePlugin();
        });
        this.api.on(homebridge_1.APIEvent.SHUTDOWN, () => {
            this.log.debug("Shutting down...");
            if (this.roborockAPI) {
                this.roborockAPI.stopService();
            }
        });
    }
    async configurePlugin() {
        await this.loginAndDiscoverDevices();
    }
    async loginAndDiscoverDevices() {
        if (!this.platformConfig.email) {
            this.log.error("Email is not configured - aborting plugin start. " +
                "Please set the field `email` in your config and restart Homebridge.");
            return;
        }
        if (!this.platformConfig.password && !this.platformConfig.encryptedToken) {
            this.log.error("Password is not configured - aborting plugin start. " +
                "Please set `password` or complete login in the Config UI.");
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
    configureAccessory(accessory) {
        this.log.info(`Loading accessory '${accessory.displayName}' from cache.`);
        if (this.isSkippedDeviceId(accessory.context)) {
            this.log.info(`Removing accessory '${accessory.displayName}' (${accessory.context}) ` +
                "because it is configured to be skipped.");
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                accessory,
            ]);
            return;
        }
        // Store restored accessory in the cached accessories list
        // remove duplicates accessories
        try {
            const existingAccessory = this.accessories.find((a) => a.UUID === accessory.UUID);
            if (existingAccessory) {
                this.log.info(`Removing duplicate accessory '${existingAccessory.displayName}' from cache.`);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                    existingAccessory,
                ]);
            }
        }
        catch (e) {
            this.log.error("Error loading accessory from cache: " + e);
        }
        this.accessories.push(accessory);
    }
    isSupportedDevice(model) {
        //model nust starts with "roborock.vacuum."
        return model.startsWith("roborock.vacuum.");
    }
    parseDeviceIds(value) {
        if (!value) {
            return [];
        }
        const entries = Array.isArray(value) ? value : value.split(/[\n,]+/);
        return entries
            .map((entry) => `${entry}`.trim())
            .filter((entry) => entry.length > 0);
    }
    isSkippedDeviceId(deviceId) {
        if (typeof deviceId !== "string" && !(deviceId instanceof String)) {
            return false;
        }
        return this.skippedDeviceIds.has(`${deviceId}`.trim());
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
                        self.log.info(`Skipping device '${name}' (${duid}) because it is configured to be skipped.`);
                        return;
                    }
                    if (!self.isSupportedDevice(model)) {
                        self.log.info(`Device '${name}' (${duid}) is not supported.`);
                        return;
                    }
                    const uuid = self.api.hap.uuid.generate(device.duid);
                    const existingAccessory = self.accessories.find((accessory) => accessory.UUID === uuid);
                    if (existingAccessory !== undefined) {
                        self.log.info(`Restoring accessory '${existingAccessory.displayName}' ` +
                            `(${uuid}) from cache.`);
                        // If you need to update the accessory.context then you should run
                        // `api.updatePlatformAccessories`. eg.:
                        existingAccessory.context = duid;
                        self.api.updatePlatformAccessories([existingAccessory]);
                        // Create the accessory handler for the restored accessory
                        self.createRoborockAccessory(existingAccessory);
                    }
                    else {
                        // The accessory already exists, so we need to create it
                        self.log.info(`Adding accessory '${name}' (${uuid}).`);
                        // The accessory does not yet exist, so we need to create it
                        const accessory = new self.api.platformAccessory(name, uuid);
                        // Store a copy of the device object in the `accessory.context` property,
                        // which can be used to store any data about the accessory you may need.
                        accessory.context = duid;
                        // Create the accessory handler for the newly create accessory
                        // this is imported from `platformAccessory.ts`
                        self.createRoborockAccessory(accessory);
                        // Link the accessory to your platform
                        self.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                            accessory,
                        ]);
                    }
                });
            }
            // At this point, we set up all devices from Roborock App, but we did not unregister
            // cached devices that do not exist on the Roborock App account anymore.
            for (const cachedAccessory of this.accessories) {
                if (cachedAccessory.context) {
                    if (this.isSkippedDeviceId(cachedAccessory.context)) {
                        this.log.info(`Removing accessory '${cachedAccessory.displayName}' (${cachedAccessory.context}) ` +
                            "because it is configured to be skipped.");
                        this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                            cachedAccessory,
                        ]);
                        continue;
                    }
                    const vacuum = self.roborockAPI.getVacuumDeviceData(cachedAccessory.context);
                    if (vacuum === undefined) {
                        // This cached devices does not exist on the Roborock App account (anymore).
                        this.log.info(`Removing accessory '${cachedAccessory.displayName}' (${cachedAccessory.context}) ` +
                            "because it does not exist on the Roborock account anymore.");
                        this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                            cachedAccessory,
                        ]);
                    }
                }
            }
        }
        catch (error) {
            this.log.error("An error occurred during device discovery. " +
                "Turn on debug mode for more information.");
            this.log.debug(error);
        }
    }
    createRoborockAccessory(accessory) {
        this.vacuums.push(new vacuum_accessory_1.default(this, accessory));
    }
}
exports.default = RoborockPlatform;
//# sourceMappingURL=platform.js.map