/**
 * Typed surface of the JavaScript Roborock API (roborockLib/roborockAPI.js)
 * that this plugin actually consumes. The implementation is still untyped
 * legacy CommonJS code; this interface exists so a rename or
 * signature change over there breaks the build here instead of HomeKit at
 * runtime. Keep it in sync with roborockAPI.js when the surface changes.
 */

/** A device entry from the Roborock home data (owned or shared). */
export interface RoborockDevice {
  duid: string;
  name: string;
  [key: string]: unknown;
}

/** Named room segment served to the Matter ServiceArea cluster. */
export interface RoborockSegmentRoom {
  segmentId: number;
  name: string;
}

/** A saved floor map (get_multi_maps_list). */
export interface RoborockFloorMap {
  mapFlag: number;
  name: string;
}

/** Every floor map and its named rooms, for the Matter ServiceArea cluster. */
export interface RoborockMultiMapAreas {
  currentMapFlag: number;
  maps: RoborockFloorMap[];
  rooms: Array<RoborockSegmentRoom & { mapFlag: number }>;
}

/** A Roborock app scene ("routine") targeting a device. */
export interface RoborockScene {
  id: number | string;
  name: string;
  enabled?: boolean;
  type?: unknown;
  param?: string;
}

/** Motor capabilities consumed by the Matter clean-mode mapping. */
export interface CleanModeCapabilities {
  fanOff: number;
  fanDefault: number;
  waterOff: number;
  waterDefault: number;
  mopSupported: boolean;
}

/**
 * Device-notify callback. `id` is "HomeData" (account-wide refresh, no duid),
 * or "CloudMessage"/"LocalMessage" (a transport message; `duid` identifies
 * the device it belongs to).
 */
export type RoborockDeviceNotify = (
  id: string,
  data: any,
  duid?: string
) => void;

export interface RoborockApi {
  // Lifecycle
  isInited(): boolean;
  startService(callback?: () => void): Promise<void>;
  stopService(): Promise<void>;
  setDeviceNotify(callback: RoborockDeviceNotify): void;

  // Device and product lookups
  getVacuumList(): RoborockDevice[];
  getVacuumDeviceData(duid: string): RoborockDevice | undefined;
  getVacuumDeviceInfo(duid: string, property: string): unknown;
  getVacuumDeviceStatus(duid: string, property: string): number | string;
  isLocallyConnected(duid: string): boolean;
  getProductAttribute(duid: string, attribute: string): string | null;
  getSegmentRooms(duid: string): RoborockSegmentRoom[];
  getMultiMapAreas?(duid: string): RoborockMultiMapAreas;
  getCurrentMapFlag?(duid: string): number | null;
  getScenesForDevice(duid: string): RoborockScene[];
  isDockWashSupported(duid: string): boolean;
  getCleanModeCapabilities(duid: string): CleanModeCapabilities;
  isCleaning(state: number | string): boolean;
  isBatteryCharging(
    duid: string,
    chargeStatus: number | string,
    state: number | string | undefined
  ): boolean;
  getTranslation(key: string): string;

  // Commands
  app_start(duid: string): Promise<void>;
  app_stop(duid: string): Promise<void>;
  app_pause(duid: string): Promise<void>;
  app_charge(duid: string): Promise<void>;
  app_start_wash(duid: string): Promise<void>;
  app_stop_wash(duid: string): Promise<void>;
  app_segment_clean(
    duid: string,
    segmentIds: number[],
    repeat?: number
  ): Promise<void>;
  resume_segment_clean(duid: string): Promise<void>;
  switchToMap?(duid: string, mapFlag: number): Promise<Record<string, string>>;
  setCleanModeParameters(
    duid: string,
    parameters: { fan_power?: number; water_box_mode?: number }
  ): Promise<void>;
  findMe(duid: string): Promise<void>;
  resolveError(duid: string, errorCode?: number): Promise<boolean>;
  executeScene(sceneID: { val: string | number }): Promise<void>;
}
