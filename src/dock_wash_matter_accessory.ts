/**
 * Roborock Dock Wash Matter Accessory
 *
 * Publishes the dock's mop-washing function as a Matter on/off outlet,
 * bridged like the scene buttons (bridged accessories carry
 * BridgedDeviceBasicInformation, so controllers show the name). Unlike the
 * momentary scene buttons this switch is stateful: on sends app_start_wash,
 * off sends app_stop_wash, and the reported state mirrors the device's
 * mop-washing states (23 washing, 26 going to wash) — including washes
 * started from the Roborock app.
 */

import type { API, Logger } from "homebridge";
import { MatterStatus } from "homebridge";
import { BaseMatterAccessory } from "./base_matter_accessory";

const MOP_WASHING_STATES = [23, 26];

export class RoborockDockWashMatterAccessory extends BaseMatterAccessory {
  private readonly duid: string;
  private readonly roborockAPI: any;
  private currentOn = false;

  constructor(
    api: API,
    log: Logger,
    device: any,
    displayName: string,
    roborockAPI: any
  ) {
    const matter = api.matter;
    if (!matter) {
      throw new Error(
        "The Homebridge Matter API is unavailable; cannot create a Matter accessory."
      );
    }

    super(api, log, {
      // The UUID only depends on the device id — never on the (localized)
      // display name — so a language change never requires re-pairing.
      UUID: matter.uuid.generate(`${device.duid}-dock-wash`),
      displayName,
      deviceType: matter.deviceTypes.OnOffOutlet,
      serialNumber: `${device.sn || device.duid}-DW`,
      manufacturer: "Roborock",
      model: device.productModel || device.model || "Dock",
      firmwareRevision: device.fv || "1.0.0",
      hardwareRevision: "1.0.0",
      context: {
        duid: device.duid,
        dockWash: true,
      },

      clusters: {
        onOff: {
          onOff: false,
        },
      },

      handlers: {
        onOff: {
          on: async () => this.handleOn(),
          off: async () => this.handleOff(),
        },
      },
    });

    this.duid = device.duid;
    this.roborockAPI = roborockAPI;
  }

  private async handleOn(): Promise<void> {
    this.logInfo("Starting dock mop wash");

    try {
      await this.roborockAPI.app_start_wash(this.duid);
    } catch (error) {
      this.logError("Failed to start mop wash:", error);
      throw new MatterStatus.Failure("Failed to start mop wash");
    }
  }

  private async handleOff(): Promise<void> {
    this.logInfo("Stopping dock mop wash");

    try {
      await this.roborockAPI.app_stop_wash(this.duid);
    } catch (error) {
      this.logError("Failed to stop mop wash:", error);
      throw new MatterStatus.Failure("Failed to stop mop wash");
    }
  }

  /**
   * Mirror the device state into the switch. Called by the platform with
   * CloudMessage/LocalMessage payloads (same fan-out as the vacuum endpoint).
   */
  public updateFromRoborockData(data: any): void {
    if (!data || data.state === undefined) {
      return;
    }
    this.setOn(MOP_WASHING_STATES.includes(Number(data.state)));
  }

  /** Re-read the cached device state (used after registration and on HomeData). */
  public refreshFromDevice(): void {
    const state = this.roborockAPI.getVacuumDeviceStatus(this.duid, "state");
    if (state === "" || state === undefined || state === null) {
      return;
    }
    this.setOn(MOP_WASHING_STATES.includes(Number(state)));
  }

  private setOn(on: boolean): void {
    if (on === this.currentOn) {
      return;
    }
    this.currentOn = on;
    this.updateState("onOff", { onOff: on }).catch((err) =>
      this.logError("Failed to update dock wash state:", err)
    );
  }
}
