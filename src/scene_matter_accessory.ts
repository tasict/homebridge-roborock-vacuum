/**
 * Roborock Scene Matter Accessory
 *
 * Publishes one Roborock cleaning scene as a Matter on/off outlet, bridged
 * on the plugin's Matter bridge. Bridged accessories carry
 * BridgedDeviceBasicInformation, so controllers show the scene name — child
 * endpoints (composed-device parts) do not, and Apple Home renders them as
 * nameless switches while flip-flopping the parent's icon. Turning the
 * switch on executes the scene and it flips back off (momentary, like the
 * HAP scene switches).
 */

import type { API, Logger } from "homebridge";
import { MatterStatus } from "homebridge";
import { BaseMatterAccessory } from "./base_matter_accessory";

const RESET_DELAY_MS = 1000;

export class RoborockSceneMatterAccessory extends BaseMatterAccessory {
  private readonly sceneId: string;
  private readonly roborockAPI: any;

  constructor(
    api: API,
    log: Logger,
    device: any,
    scene: any,
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
      UUID: matter.uuid.generate(`${device.duid}-scene-${scene.id}`),
      displayName,
      deviceType: matter.deviceTypes.OnOffOutlet,
      serialNumber: `${device.sn || device.duid}-S${scene.id}`,
      manufacturer: "Roborock",
      model: device.productModel || device.model || "Scene",
      firmwareRevision: device.fv || "1.0.0",
      hardwareRevision: "1.0.0",
      context: {
        duid: device.duid,
        sceneId: scene.id,
      },

      clusters: {
        onOff: {
          onOff: false,
        },
      },

      handlers: {
        onOff: {
          on: async () => this.handleOn(),
          off: async () => {
            // Momentary button — nothing to stop.
          },
        },
      },
    });

    this.sceneId = scene.id;
    this.roborockAPI = roborockAPI;
  }

  private async handleOn(): Promise<void> {
    this.logInfo(`Executing scene ${this.sceneId}`);

    try {
      await this.roborockAPI.executeScene({ val: this.sceneId });
    } catch (error) {
      this.logError("Failed to execute scene:", error);
      throw new MatterStatus.Failure("Failed to execute scene");
    }

    setTimeout(() => {
      this.updateState("onOff", { onOff: false }).catch((err) =>
        this.logError("Failed to reset scene switch:", err)
      );
    }, RESET_DELAY_MS);
  }
}
