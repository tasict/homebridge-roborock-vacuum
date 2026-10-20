"use strict";

class vacuum {
  constructor(adapter, robotModel) {
    this.adapter = adapter;

    this.adapter.log.debug(`Robot key: ${robotModel}`);
    this.robotModel = robotModel;

    this.parameterFolders = {
      get_mop_mode: "deviceStatus",
      get_water_box_custom_mode: "deviceStatus",
      get_network_info: "networkInfo",
      get_consumable: "consumables",
      get_fw_features: "firmwareFeatures",
      get_carpet_mode: "deviceStatus",
      get_carpet_clean_mode: "deviceStatus",
      get_carpet_cleaning_mode: "deviceStatus",
    };
  }

  async command(duid, parameter, value) {
    try {
      switch (parameter) {
        case "reset_consumable":
          await this.adapter.messageQueueHandler.sendRequest(duid, parameter, [
            value,
          ]);
          this.adapter.log.info(`Consumable ${parameter} successfully reset.`);

          break;

        case "app_set_dryer_status": {
          const result = await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            JSON.parse(value)
          );
          this.adapter.log.debug(`Command: ${parameter} result: ${result}`);

          break;
        }
        case "app_goto_target":
        case "app_zoned_clean": {
          const result = await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            value
          );
          this.adapter.log.debug(
            `Command: ${parameter} with value: ${JSON.stringify(value)} result: ${result}`
          );

          break;
        }
        case "set_water_box_distance_off": {
          const mappedValue = ((value - 1) / (30 - 1)) * (60 - 205) + 205;
          const parameterValue = { distance_off: mappedValue };

          const result = await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            parameterValue
          );
          this.adapter.log.debug(
            `Command: ${parameter} with value: ${JSON.stringify(parameterValue)} result: ${result}`
          );
          break;
        }
        default:
          if (value && typeof value !== "boolean") {
            const valueType = typeof value;

            if (valueType === "string") {
              value = JSON.parse(value);
            } else if (valueType === "number") {
              value = [value];
            }

            // await is important here!!! Wait for the command to finish before sending the request to update deviceConfig!!!
            const result = await this.adapter.messageQueueHandler.sendRequest(
              duid,
              parameter,
              value
            );
            this.adapter.log.debug(
              `Command: ${parameter} with value: ${JSON.stringify(value)} result: ${result}`
            );

            // this is needed to update the states instantly after sending a command
            const getCommand = parameter.replace("set", "get");
            await this.getParameter(duid, getCommand);
          } else {
            const result = await this.adapter.messageQueueHandler.sendRequest(
              duid,
              parameter,
              []
            );
            this.adapter.log.debug(`Command: ${parameter} result: ${result}`);
          }
      }
    } catch (error) {
      this.adapter.catchError(error, parameter, duid, this.robotModel);
    }
  }

  async getParameter(duid, parameter, attribute) {
    let mode;

    try {
      if (parameter == "get_network_info") {
        mode = parameter;
        // B01 devices do not answer get_network_info; they expose the same
        // data via service.get_net_info, with the IP under inconsistent
        // field names depending on firmware (ip / ipAddress / ipAdress).
        const version = await this.adapter.getRobotVersion(duid);
        const method =
          version == "B01" ? "service.get_net_info" : "get_network_info";
        let networkInfo = await this.adapter.messageQueueHandler.sendRequest(
          duid,
          method,
          []
        );

        if (Array.isArray(networkInfo)) {
          networkInfo = networkInfo[0];
        }

        if (networkInfo && typeof networkInfo == "object") {
          if (!networkInfo.ip) {
            const alternateIp = networkInfo.ipAddress || networkInfo.ipAdress;
            if (alternateIp) {
              networkInfo.ip = alternateIp;
            }
          }

          for (const attribute in networkInfo) {
            // Devices demoted to the cloud path after a TCP failure
            // (remoteDevices) still record their IP here so the reconnect
            // loop can dial the fresh address; only devices shared from
            // another account can never be local.
            if (attribute == "ip" && !this.adapter.isSharedDevice(duid)) {
              this.adapter.localDevices[duid] = networkInfo[attribute];
              if (typeof this.adapter.persistLocalDevices === "function") {
                this.adapter.persistLocalDevices();
              }
            }
            this.adapter.setStateAsync(
              `Devices.${duid}.networkInfo.${attribute}`,
              { val: networkInfo[attribute], ack: true }
            );
          }
        }
      } else if (parameter == "get_consumable") {
        const consumables = (
          await this.adapter.messageQueueHandler.sendRequest(
            duid,
            "get_consumable",
            []
          )
        )[0];

        for (const consumable in consumables) {
          const divider =
            this.adapter.vacuums[duid].features.getConsumablesDivider(
              consumable
            );
          if (divider) {
            const consumable_val = divider
              ? Math.round(consumables[consumable] / divider)
              : consumables[consumable];

            this.adapter.setStateAsync(
              `Devices.${duid}.consumables.${consumable}`,
              { val: consumable_val, ack: true }
            );
          }
        }

        if (typeof this.adapter.recordConsumables === "function") {
          this.adapter.recordConsumables(duid, consumables);
        }
      } else if (parameter == "get_status") {
        // current-room -> MQTT (opt-in telemetry): the only consumer of the
        // 1 Hz status tick (see startDeviceIntervals, which only creates the
        // interval when the feature is enabled). Polls fast while cleaning,
        // idle otherwise; serialized by `_roomPollInFlight`.
        const roomMqttCfg =
          this.adapter.config && this.adapter.config.currentRoomMqtt;
        if (roomMqttCfg && roomMqttCfg.enabled) {
          const seconds = new Date().getSeconds();
          const vac = this.adapter.vacuums[duid];
          const idleInterval = this.adapter.updateInterval || 180;
          const fastInterval = roomMqttCfg.cleaningPollSeconds || 10;
          const interval =
            vac && vac._lastIsCleaning
              ? Math.min(fastInterval, idleInterval)
              : idleInterval;
          if (seconds % interval == 0 && !(vac && vac._roomPollInFlight)) {
            if (vac) vac._roomPollInFlight = true;
            try {
              const ds = await this.adapter.messageQueueHandler.sendRequest(
                duid,
                "get_prop",
                ["get_status"]
              );
              const s0 = (ds && ds[0]) || {};
              if (vac)
                vac._lastIsCleaning = this.adapter.isCleaning(s0["state"]);
              this.adapter.publishCurrentRoom(duid, {
                cleaningInfo: s0["cleaning_info"],
                state: s0["state"],
                inCleaning: s0["in_cleaning"],
              });
            } catch (e) {
              this.adapter.log.debug(
                `current_room poll failed: ${e && e.message}`
              );
            } finally {
              if (vac) vac._roomPollInFlight = false;
            }
          }
        }
      } else if (parameter == "get_room_mapping") {
        const mappedRooms = await this.adapter.messageQueueHandler.sendRequest(
          duid,
          "get_room_mapping",
          []
        );

        // if no rooms have been named, processing them can't work
        if (mappedRooms.length < 1) {
          this.adapter.log.warn(
            `Failed to map rooms. You need to name your rooms via the mobile app on your phone.`
          );
        } else if (
          typeof this.adapter.isMapDiscoveryRunning === "function" &&
          this.adapter.isMapDiscoveryRunning(duid)
        ) {
          // Multi-map discovery has a different map loaded right now; its
          // rooms are recorded by discoverMultiMapRooms, not the poll.
        } else {
          // Rebuild from scratch: segment ids repeat across floor maps, so
          // merging into the old cache would keep the previous map's rooms
          // after the robot switches floors.
          const names = {};
          for (const mappedRoom of mappedRooms) {
            const roomID = mappedRoom[1];
            const roomName = this.adapter.roomIDs[roomID];

            if (roomName) {
              this.adapter.log.debug(
                `Mapped room matched: ${roomID} with name: ${roomName}`
              );
              // Cache segment_id -> name for the Matter ServiceArea cluster
              // (getSegmentRooms) and the current-room MQTT publisher.
              names[mappedRoom[0]] = roomName;
            }
          }
          this.adapter.segmentRoomNames[duid] = names;
          if (typeof this.adapter.recordCurrentMapRooms === "function") {
            this.adapter.recordCurrentMapRooms(duid, names);
          }
        }
      } else if (parameter == "get_fw_features") {
        const firmwareFeatures =
          await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            []
          );
        for (const firmwareFeature in firmwareFeatures) {
          const featureID = firmwareFeatures[firmwareFeature];
          const featureName =
            this.adapter.vacuums[duid].features.getFirmwareFeature(featureID);

          // this dynamically processes robot features by ID if they are supported
          if (
            typeof this.adapter.vacuums[duid].features[featureName] ===
            "function"
          ) {
            this.adapter.vacuums[duid].features[featureName]();
          }
        }
      } else if (
        parameter == "get_dust_collection_switch_status" ||
        parameter == "get_wash_towel_mode" ||
        parameter == "get_smart_wash_params" ||
        parameter == "get_dust_collection_mode"
      ) {
        const attribute_val = JSON.stringify(
          await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            {}
          )
        );
        this.adapter.setStateAsync(
          `Devices.${duid}.commands.${parameter.replace("get", "set")}`,
          { val: attribute_val, ack: true }
        );
      } else if (parameter == "app_get_dryer_setting") {
        const attribute_val =
          await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            {}
          );
        const actualVal = JSON.stringify({
          on: { dry_time: attribute_val.on.dry_time },
          status: attribute_val.status,
        });
        this.adapter.setStateAsync(
          `Devices.${duid}.commands.${parameter.replace("get", "set")}`,
          { val: actualVal, ack: true }
        );
      } else if (this.parameterFolders[parameter]) {
        mode = parameter.substring(4);
        const attribute_val =
          await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            []
          );

        if (typeof attribute_val[0] == "object") {
          attribute_val[0] = JSON.stringify(attribute_val[0]);
        }
        const targetFolder = this.parameterFolders[parameter];
        this.adapter.setStateAsync(`Devices.${duid}.${targetFolder}.${mode}`, {
          val: attribute_val[0],
          ack: true,
        });
      } else {
        // unknown parameter
        const unknown_parameter_val =
          await this.adapter.messageQueueHandler.sendRequest(
            duid,
            parameter,
            []
          );

        // this.adapter.setStateAsync("Devices." + duid + "." + targetFolder + "." + mode, { val: attribute_val[0], ack: true });
        if (typeof unknown_parameter_val == "object") {
          if (typeof unknown_parameter_val[0] != "number") {
            this.adapter.catchError(
              `Unknown parameter: ${JSON.stringify(unknown_parameter_val)}`,
              parameter,
              duid,
              this.robotModel
            );
          }
        } else {
          this.adapter.catchError(
            `Unknown parameter: ${unknown_parameter_val}`,
            parameter,
            duid,
            this.robotModel
          );
        }
      }
    } catch (error) {
      this.adapter.catchError(error, parameter, duid, this.robotModel);
    }
  }
}

module.exports = {
  vacuum,
};
