export type DeviceProtocol = "skip" | "matter" | "hap";

export interface ProtocolResolution {
  skipIds: Set<string>;
  matterIds: Set<string>;
  matterEnabled: boolean;
}

/**
 * Parse a device ID list from config, accepting either an array or a
 * comma/newline separated string. Shared by the skip and matter lists.
 */
export function parseDeviceIds(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : value.split(/[\n,]+/);

  return entries
    .map((entry) => `${entry}`.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve which protocol a device is published over.
 * Precedence: skip > matter > hap. A device selected for Matter falls back to
 * HAP when Matter is unavailable so the device is never lost.
 */
export function resolveDeviceProtocol(
  deviceId: string,
  { skipIds, matterIds, matterEnabled }: ProtocolResolution
): DeviceProtocol {
  const id = `${deviceId}`.trim();

  if (skipIds.has(id)) {
    return "skip";
  }

  if (matterIds.has(id)) {
    return matterEnabled ? "matter" : "hap";
  }

  return "hap";
}

/**
 * True when a device was selected for Matter but is being published over HAP
 * because Matter is unavailable — used to warn the user once at startup.
 */
export function isMatterFallback(
  deviceId: string,
  { skipIds, matterIds, matterEnabled }: ProtocolResolution
): boolean {
  const id = `${deviceId}`.trim();
  return !skipIds.has(id) && matterIds.has(id) && !matterEnabled;
}
