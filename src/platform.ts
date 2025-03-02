import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import RoborockVacuumAccessory from './vacuum_accessory';

import RoborockPlatformLogger from './logger';
import { RoborockPlatformConfig } from './types';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { forEach } from 'jszip';

const Roborock = require("../roborockLib/roborockAPI").Roborock;

/**
 * Roborock App Platform Plugin for Homebridge
 * Based on https://github.com/homebridge/homebridge-plugin-template
 */
export default class RoborockPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // Used to track restored cached accessories
  private readonly accessories: PlatformAccessory<String>[] = [];
  private readonly vacuums: RoborockVacuumAccessory[] = [];

  public readonly roborockAPI: any;
  public readonly log: RoborockPlatformLogger;

  public platformConfig: RoborockPlatformConfig;

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
    private readonly api: API,
  ) {
    this.platformConfig = config as RoborockPlatformConfig;

    // Initialise logging utility
    this.log = new RoborockPlatformLogger(homebridgeLogger, this.platformConfig.debugMode);
    // Create Roborock App communication module

    const username = this.platformConfig.email;
    const password = this.platformConfig.password;
    const baseURL = this.platformConfig.baseURL;
    const debugMode = this.platformConfig.debugMode;

    this.roborockAPI = new Roborock({username: username, password: password, debug: debugMode, baseURL: baseURL, log: this.log});
  
    /**
     * When this event is fired it means Homebridge has restored all cached accessories from disk.
     * Dynamic Platform plugins should only register new accessories after this event was fired,
     * in order to ensure they weren't added to homebridge already. This event can also be used
     * to start discovery of new accessories.
     */
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug('Finished launching and restored cached accessories.');
      this.configurePlugin();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {

      this.log.debug('Shutting down...');
      
      if(this.roborockAPI){
        this.roborockAPI.stopService();
      }
    });

  }

  async configurePlugin() {
    await this.loginAndDiscoverDevices();
  }

  async loginAndDiscoverDevices() {

    if (!this.platformConfig.email) {
      this.log.error('Email is not configured - aborting plugin start. '
        + 'Please set the field `email` in your config and restart Homebridge.');
      return;
    }

    if (!this.platformConfig.password) {
      this.log.error('Password is not configured - aborting plugin start. '
        + 'Please set the field `password` in your config and restart Homebridge.');
      return;
    }

    const self = this;

    self.roborockAPI.setDeviceNotify(function(id, homeData){
      self.log.debug(`${id} notifyDeviceUpdater:${JSON.stringify(homeData)}`);

      for (const vacuum of self.vacuums) {
        vacuum.notifyDeviceUpdater(id, homeData);
      }

           
    });

    self.roborockAPI.startService(function(){
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

    /**
     * We don't have to set up the handlers here,
     * because our device discovery function takes care of that.
     *
     * But we need to add the restored accessory to the
     * accessories cache so we can access it during that process.
     */
    this.accessories.push(accessory);
  }

  isSupportedDevice(deviceType: string): boolean {

    return true;

  }

  /**
   * Fetches all of the user's devices from Roborock App and sets up handlers.
   *
   * Accessories must only be registered once. Previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    this.log.info('Discovering vacuum devices...');

    try {

      const self = this;

      if(self.roborockAPI.isInited()){ 
 
        self.roborockAPI.getVacuumList().forEach(function(device){
          var duid = device.duid;
          var name = device.name;
          var battery = self.roborockAPI.getVacuumDeviceStatus(duid, "battery");
          
          if(!self.isSupportedDevice(device.deviceType)){
            self.log.info(`Device '${name}' (${duid}) is not supported.`);
            return;
          }

          const uuid = self.api.hap.uuid.generate(device.duid);

          const existingAccessory = self.accessories.find(accessory => accessory.UUID === uuid);
          
          if (existingAccessory !== undefined) {
            self.log.info(`Restoring accessory '${existingAccessory.displayName}' ` + `(${uuid}) from cache.`);
  
            // If you need to update the accessory.context then you should run
            // `api.updatePlatformAccessories`. eg.:
            existingAccessory.context = duid;
            self.api.updatePlatformAccessories([existingAccessory]);
  
            // Create the accessory handler for the restored accessory
  
            self.createRoborockAccessory(existingAccessory);
          }
          
          self.log.info(`Adding accessory '${name}' (${uuid}).`);
          // The accessory does not yet exist, so we need to create it
          const accessory = new self.api.platformAccessory<String>(name, uuid);
  
          // Store a copy of the device object in the `accessory.context` property,
          // which can be used to store any data about the accessory you may need.
          accessory.context = duid;
  
          // Create the accessory handler for the newly create accessory
          // this is imported from `platformAccessory.ts`
          self.createRoborockAccessory(accessory);
  
          // Link the accessory to your platform
          self.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        
        });  
  
      }


      // At this point, we set up all devices from Roborock App, but we did not unregister
      // cached devices that do not exist on the Roborock App account anymore.
      for (const cachedAccessory of this.accessories) {

        if (cachedAccessory.context) {
          
          const vacuum = self.roborockAPI.getVacuumDeviceData(cachedAccessory.context);

          if (vacuum === undefined) {
            // This cached devices does not exist on the Roborock App account (anymore).
            this.log.info(`Removing accessory '${cachedAccessory.displayName}' (${cachedAccessory.context}) ` + 'because it does not exist on the Roborock account anymore.');

            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cachedAccessory]);
          }
        }
      }
    } catch (error) {
      this.log.error('An error occurred during device discovery. ' + 'Turn on debug mode for more information.');
      this.log.debug(error);
    }

  }

  createRoborockAccessory(
    accessory: PlatformAccessory<String>) {
    this.vacuums.push(new RoborockVacuumAccessory(this, accessory));
  }

}
