/**
 * Base Matter Accessory Class
 *
 * Provides common functionality for all Matter devices.
 * Based on @homebridge-plugins/homebridge-matter implementation.
 */

import type { API, EndpointType, Logger, MatterAccessory } from "homebridge";

export interface BaseMatterAccessoryConfig {
  UUID: string;
  displayName: string;
  deviceType: EndpointType;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision: string;
  hardwareRevision: string;
  context?: Record<string, unknown>;
  clusters?: MatterAccessory["clusters"];
  handlers?: MatterAccessory["handlers"];
  parts?: MatterAccessory["parts"];
}

/**
 * Base class for all Matter accessories
 * Implements the MatterAccessory interface and provides common methods
 */
export abstract class BaseMatterAccessory implements MatterAccessory {
  // Required MatterAccessory properties
  public readonly UUID: string;
  public readonly displayName: string;
  public readonly deviceType: EndpointType;
  public readonly serialNumber: string;
  public readonly manufacturer: string;
  public readonly model: string;
  public readonly firmwareRevision: string;
  public readonly hardwareRevision: string;
  public readonly context: Record<string, unknown>;
  public readonly clusters?: MatterAccessory["clusters"];
  public readonly handlers?: MatterAccessory["handlers"];
  public readonly parts?: MatterAccessory["parts"];

  // Protected properties available to child classes
  protected readonly api: API;
  protected readonly log: Logger;

  protected constructor(
    api: API,
    log: Logger,
    config: BaseMatterAccessoryConfig
  ) {
    this.api = api;
    this.log = log;

    // Set all required properties
    this.UUID = config.UUID;
    this.displayName = config.displayName;
    this.deviceType = config.deviceType;
    this.serialNumber = config.serialNumber;
    this.manufacturer = config.manufacturer;
    this.model = config.model;
    this.firmwareRevision = config.firmwareRevision;
    this.hardwareRevision = config.hardwareRevision;
    this.clusters = config.clusters;
    this.handlers = config.handlers;
    this.parts = config.parts;

    // Set context with all metadata
    this.context = {
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      ...config.context,
    };
  }

  /**
   * Update the accessory state
   * Helper method to update cluster attributes
   */
  protected async updateState(
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string
  ): Promise<void> {
    const matter = this.api.matter;
    if (!matter) {
      return;
    }
    await matter.updateAccessoryState(this.UUID, cluster, attributes, partId);
    this.log.debug(
      `[${this.displayName}] Updated ${cluster} state:`,
      attributes
    );
  }

  /**
   * Log helper methods
   */
  protected logInfo(message: string, ...args: unknown[]): void {
    this.log.info(`[${this.displayName}] ${message}`, ...args);
  }

  protected logError(message: string, ...args: unknown[]): void {
    this.log.error(`[${this.displayName}] ${message}`, ...args);
  }

  protected logDebug(message: string, ...args: unknown[]): void {
    this.log.debug(`[${this.displayName}] ${message}`, ...args);
  }

  protected logWarn(message: string, ...args: unknown[]): void {
    this.log.warn(`[${this.displayName}] ${message}`, ...args);
  }

  /**
   * Convert this class instance to a plain MatterAccessory object
   * This is what gets registered with Homebridge
   */
  public toAccessory(): MatterAccessory {
    return {
      UUID: this.UUID,
      displayName: this.displayName,
      deviceType: this.deviceType,
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      context: this.context,
      clusters: this.clusters,
      handlers: this.handlers,
      parts: this.parts,
    };
  }
}
