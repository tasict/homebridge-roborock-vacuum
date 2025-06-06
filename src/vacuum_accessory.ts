import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback, CharacteristicEventTypes } from 'homebridge';
import RoborockPlatform from './platform';


import { catchError, concatMap, distinct } from "rxjs";
import { AccessoryPlugin, API, Logging } from "homebridge";
import { STATUS_CODES } from 'http';
import { log } from 'console';


/**
 * An instance of this class is created for each accessory the platform registers.
 * Each accessory may expose multiple services of different service types.
 */
export default class RoborockVacuumAccessory {
  private services: Service[] = [];
  private sceneServices: Map<string, Service> = new Map();
  private currentScenes: any[] = [];

  constructor(
    private readonly platform: RoborockPlatform,
    private readonly accessory: PlatformAccessory<String>
  )
  {

    const self = this;

    // Accessory Information
    // https://developers.homebridge.io/#/service/AccessoryInformation
    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        'Roborock',
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.platform.roborockAPI.getProductAttribute(accessory.context, "model") || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.platform.roborockAPI.getVacuumDeviceInfo(accessory.context, "sn") || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.platform.roborockAPI.getVacuumDeviceInfo(accessory.context, "fv") || 'Unknown',
      );


    this.services['Fan'] = this.accessory.getService(this.platform.Service.Fanv2)
      || this.accessory.addService(this.platform.Service.Fanv2);

    
    // This is what is displayed as the default name on the Home app
    this.services['Fan'].setCharacteristic(
      this.platform.Characteristic.Name,
      this.platform.roborockAPI.getVacuumDeviceInfo(accessory.context, "name") || 'Roborock Vacuum',
    );

    this.services['Fan'].getCharacteristic(this.platform.Characteristic.Active)
    .onSet(this.setActive.bind(this))
    .onGet(this.getActive.bind(this));
      

    this.services['Battery'] = this.accessory.getService(this.platform.Service.Battery)
      || this.accessory.addService(this.platform.Service.Battery);
    
    this.services['Battery'].setCharacteristic(
      this.platform.Characteristic.BatteryLevel,
      this.platform.roborockAPI.getVacuumDeviceStatus(accessory.context, "battery") || 0,
    );

    this.services['Battery'].setCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      this.platform.roborockAPI.getVacuumDeviceStatus(accessory.context, "battery") < 20 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
    );

    this.services['Battery'].setCharacteristic(
      this.platform.Characteristic.ChargingState,
      this.platform.roborockAPI.getVacuumDeviceStatus(accessory.context, "charge_status") == 1 ? this.platform.Characteristic.ChargingState.CHARGING : this.platform.Characteristic.ChargingState.NOT_CHARGING
    );

    // Initialize scene switches
    this.updateSceneSwitches();

   }



  updateDeviceState() {

    try{

      this.services['Fan'].updateCharacteristic(
        this.platform.Characteristic.Active,
        this.platform.roborockAPI.isCleaning(this.platform.roborockAPI.getVacuumDeviceStatus(this.accessory.context, "state")) ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
      );

      this.services['Battery'].updateCharacteristic(
        this.platform.Characteristic.BatteryLevel,
        this.platform.roborockAPI.getVacuumDeviceStatus(this.accessory.context, "battery") || 0
      );

      this.services['Battery'].updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        this.platform.roborockAPI.getVacuumDeviceStatus(this.accessory.context, "battery") < 20 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );

      this.services['Battery'].updateCharacteristic(
        this.platform.Characteristic.ChargingState,
        this.platform.roborockAPI.getVacuumDeviceStatus(this.accessory.context, "charge_status") != 0 ? this.platform.Characteristic.ChargingState.CHARGING : this.platform.Characteristic.ChargingState.NOT_CHARGING
      );

      this.platform.log.debug("Device state is " + this.state_code_to_state(this.platform.roborockAPI.getVacuumDeviceStatus(this.accessory.context, "state")));
    
    
    }catch(e) {
      this.platform.log.error("Error updating device state: " + e);
    }


  }

  /**
   * Update scene switches based on available scenes for this device
   */
  updateSceneSwitches() {
    try {
      // Get scenes for this device
      const deviceScenes = this.platform.roborockAPI.getScenesForDevice(this.accessory.context);
      
      // Check if scenes have changed
      if (this.scenesChanged(deviceScenes)) {
        this.platform.log.debug(`Updating scene switches for device ${this.accessory.context}`);
        
        // Remove existing scene switches that are no longer available
       
        // Add new scene switches
        for (const scene of deviceScenes) {
          
          try{
            const sceneId = scene.id.toString();
            const sceneName = scene.name.replaceAll(" ", "_");
;
          
            if (!this.sceneServices.has(sceneId) && scene.enabled) {
              this.platform.log.debug(`Adding scene switch for: ${scene.name} (ID: ${sceneId})`);

              const switchService = this.accessory.getServiceById(this.platform.Service.Switch, `scene-${sceneId}`) || this.accessory.addService(
                this.platform.Service.Switch,
                sceneName,
                `scene-${sceneId}`
              );

              switchService.setCharacteristic(
                this.platform.Characteristic.Name,
                sceneName
              );
              
              switchService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
              switchService.setCharacteristic(this.platform.Characteristic.ConfiguredName, sceneName);

              switchService.getCharacteristic(this.platform.Characteristic.On)
                .onSet(this.setSceneSwitch.bind(this, sceneId))
                .onGet(this.getSceneSwitch.bind(this, sceneId));
              
              this.sceneServices.set(sceneId, switchService);
            }

          }catch(e) {
            this.platform.log.error(`Error processing scene ${scene.name}: ${e}`);
          }



        }

        


        
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
    
    const currentIds = this.currentScenes.map(scene => scene.id).sort();
    const newIds = newScenes.map(scene => scene.id).sort();
    
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
        await this.platform.roborockAPI.executeScene({val: sceneId});
        this.platform.log.info(`Executed scene ID: ${sceneId}`);
        
        // Turn off the switch after execution (momentary switch behavior)
        setTimeout(() => {
          const service = this.sceneServices.get(sceneId);
          if (service) {
            service.updateCharacteristic(this.platform.Characteristic.On, false);
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

  notifyDeviceUpdater(id:string, data) {

    try{
      if(id == 'CloudMessage' || id == 'LocalMessage') {

        this.platform.log.debug(`Updating accessory with ${id} data: ` + JSON.stringify(data)); 
        
  
        if(data.length > 0) {
          const messages = data[0];
          if(messages.hasOwnProperty('state')) {
            this.services['Fan'].updateCharacteristic(
              this.platform.Characteristic.Active,
              this.isCleaningState(messages.state) ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
            );
          }
          
          if(messages.hasOwnProperty('battery')) {
            this.services['Battery'].updateCharacteristic(
              this.platform.Characteristic.BatteryLevel,
              messages.battery
            );
      
            this.services['Battery'].updateCharacteristic(
              this.platform.Characteristic.StatusLowBattery,
              messages.battery < 20 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
            );

          }

          if(messages.hasOwnProperty('charge_status')) {
      
            this.services['Battery'].updateCharacteristic(
              this.platform.Characteristic.ChargingState,
              messages.charge_status != 0 ? this.platform.Characteristic.ChargingState.CHARGING : this.platform.Characteristic.ChargingState.NOT_CHARGING
            );
          }

          if(messages.hasOwnProperty('in_cleaning')) {
      
            this.services['Fan'].updateCharacteristic(
              this.platform.Characteristic.Active,
              messages.in_cleaning != 0 ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
            );
          }

        }
  
        if(data.hasOwnProperty('dps') && data.dps.hasOwnProperty('121')) {
          
          this.platform.log.debug(`${this.platform.roborockAPI.getVacuumDeviceInfo(this.accessory.context, "name")} state update to: ${this.state_code_to_state(data.dps['121'])}`);

          this.services['Fan'].updateCharacteristic(
            this.platform.Characteristic.Active,
            this.isCleaningState(data.dps['121']) ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
          );
        }
  
        if(data.hasOwnProperty('dps') && data.dps.hasOwnProperty('122')) {

          this.platform.log.debug(`${this.platform.roborockAPI.getVacuumDeviceInfo(this.accessory.context, "name")} battery update to: ${data.dps['122']}`);
 
          
          this.services['Battery'].updateCharacteristic(
            this.platform.Characteristic.BatteryLevel,
            data.dps['122']
          );
    
          this.services['Battery'].updateCharacteristic(
            this.platform.Characteristic.StatusLowBattery,
            data.dps['122'] < 20 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
          );
        }
        
  
      }
      else if(id == 'HomeData') {
       this.updateDeviceState();
       // Update scene switches when home data changes
       this.updateSceneSwitches();   
      }
    
    
    }catch(e) {
      this.platform.log.error("Error notifying device updater: " + e);
    }
    

  
  
  }

  async setActive(value: CharacteristicValue) {


    try{
      this.platform.log.debug("Setting active to " + value);

      if(value == this.platform.Characteristic.Active.ACTIVE) {
        await this.platform.roborockAPI.app_start(this.accessory.context);
      } 
      else {

          await this.platform.roborockAPI.app_stop(this.accessory.context);
          await this.platform.roborockAPI.app_charge(this.accessory.context);

      }

      this.services['Fan'].updateCharacteristic(
        this.platform.Characteristic.Active,
        value
      );


    }catch(e) {
      this.platform.log.error("Error setting active: " + e);
    }

  }

  async getActive():Promise<CharacteristicValue> {    

    this.updateDeviceState();
    return this.isCleaning() ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  state_code_to_state(code:number):string {

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

  isCleaning():boolean {
    
    return this.isCleaningState(this.platform.roborockAPI.getVacuumDeviceStatus(this.accessory.context, "state"));

  }

  isCleaningState(state:number):boolean {
  
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
