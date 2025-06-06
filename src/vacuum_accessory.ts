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
  private sceneServices: Record<string, Service> = {};

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

    this.updateSceneServices();

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
       this.updateSceneServices();
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

  async runScene(sceneId:number, value: CharacteristicValue) {
    if(value) {
      try{
        await this.platform.roborockAPI.executeScene(sceneId);
      } catch(e) {
        this.platform.log.error("Error executing scene: " + e);
      }
    }
    const service = this.sceneServices[`scene_${sceneId}`];
    if(service) {
      service.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  updateSceneServices() {
    const scenes = this.platform.roborockAPI.getScenes(this.accessory.context);
    const existing = new Set(Object.keys(this.sceneServices).map(k => parseInt(k.replace('scene_', ''))));
    const newIds = new Set<number>();
    for (const scene of scenes) {
      newIds.add(scene.id);
      if (!this.sceneServices[`scene_${scene.id}`]) {
        const service = this.accessory.getService(scene.name) ||
          this.accessory.addService(this.platform.Service.Switch, scene.name, `scene_${scene.id}`);
        service.getCharacteristic(this.platform.Characteristic.On)
          .onSet(async (value) => this.runScene(scene.id, value))
          .onGet(() => false);
        this.sceneServices[`scene_${scene.id}`] = service;
      }
    }
    for (const idStr of Object.keys(this.sceneServices)) {
      const id = parseInt(idStr.replace('scene_', ''));
      if (!newIds.has(id)) {
        const svc = this.sceneServices[idStr];
        if (svc) {
          this.accessory.removeService(svc);
        }
        delete this.sceneServices[idStr];
      }
    }
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
