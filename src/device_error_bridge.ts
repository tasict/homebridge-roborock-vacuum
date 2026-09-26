/**
 * Device errors shared between the plugin and its settings page.
 *
 * The settings page runs in the Homebridge UI's own process and cannot reach
 * the vacuums itself — a second cloud MQTT session under the account's
 * client id would disconnect the plugin's. So the files in the Homebridge
 * storage directory carry the exchange instead:
 * - the plugin publishes every bridged vacuum's current errors to
 *   DEVICE_ERRORS_FILE;
 * - the page asks for an error to be resolved by writing a request file
 *   into RESOLVE_REQUEST_DIR, which the plugin picks up, runs and answers
 *   with a result file next to it.
 */

import fs from "fs";
import path from "path";

export const DEVICE_ERRORS_FILE = "roborock.deviceErrors.json";
export const RESOLVE_REQUEST_DIR = "roborock.resolveError";

// A request the plugin has not picked up within this window is dropped, and
// an unread result is removed after the same time.
export const RESOLVE_REQUEST_TTL_MS = 60 * 1000;

export interface DeviceErrorEntry {
  duid: string;
  name: string;
  // Robot error_code; 0 means no error.
  errorCode: number;
  // Dock dock_error_status; 0 means no error.
  dockErrorCode: number;
}

export interface DeviceErrorsFile {
  updatedAt: number;
  devices: DeviceErrorEntry[];
}

export interface ResolveRequest {
  id: string;
  duid: string;
  requestedAt: number;
}

export interface ResolveResult {
  id: string;
  ok: boolean;
  message: string;
  finishedAt: number;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID_PATTERN.test(id);
}

export function requestFilePath(storagePath: string, id: string): string {
  return path.join(storagePath, RESOLVE_REQUEST_DIR, `${id}.request.json`);
}

export function resultFilePath(storagePath: string, id: string): string {
  return path.join(storagePath, RESOLVE_REQUEST_DIR, `${id}.result.json`);
}

/** Write through a temporary file so readers never see a partial file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** Plugin side: publishes device errors and serves resolve requests. */
export class DeviceErrorBridge {
  private lastPublished: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private processing = false;

  constructor(
    private readonly storagePath: string,
    // Resolves the device's current error; true when a resolve was sent,
    // false when there was nothing to resolve. Throws on failure.
    private readonly resolve: (duid: string) => Promise<boolean>,
    private readonly log: BridgeLogger
  ) {}

  /** Publish the current errors; a no-op when nothing changed. */
  publish(devices: DeviceErrorEntry[]): void {
    const content = JSON.stringify(devices);
    if (content === this.lastPublished) {
      return;
    }

    try {
      const file: DeviceErrorsFile = { updatedAt: Date.now(), devices };
      writeJsonAtomic(path.join(this.storagePath, DEVICE_ERRORS_FILE), file);
      this.lastPublished = content;
    } catch (error) {
      this.log.debug(`Failed to publish device errors: ${error}`);
    }
  }

  /** Poll for resolve requests from the settings page. */
  start(intervalMs = 2000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.processRequests();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async processRequests(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      const dir = path.join(this.storagePath, RESOLVE_REQUEST_DIR);
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch (error) {
        return; // No request has been made yet.
      }

      const now = Date.now();
      for (const entry of entries) {
        const filePath = path.join(dir, entry);
        if (entry.endsWith(".result.json")) {
          this.removeIfOlderThan(filePath, now - RESOLVE_REQUEST_TTL_MS);
          continue;
        }
        if (!entry.endsWith(".request.json")) {
          continue;
        }

        const request = readJson(filePath) as ResolveRequest | null;
        // Claim the request before running it so it is never run twice.
        this.remove(filePath);
        if (
          !request ||
          !isValidRequestId(request.id) ||
          typeof request.duid !== "string" ||
          typeof request.requestedAt !== "number" ||
          now - request.requestedAt > RESOLVE_REQUEST_TTL_MS
        ) {
          continue;
        }

        await this.handleRequest(request);
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleRequest(request: ResolveRequest): Promise<void> {
    let result: ResolveResult;
    try {
      const sent = await this.resolve(request.duid);
      result = {
        id: request.id,
        ok: true,
        message: sent ? "Error resolved." : "There is no error to resolve.",
        finishedAt: Date.now(),
      };
    } catch (error) {
      this.log.warn(
        `Failed to resolve the error of ${request.duid} requested from the settings page: ${error}`
      );
      result = {
        id: request.id,
        ok: false,
        message: `Failed to resolve the error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        finishedAt: Date.now(),
      };
    }

    try {
      writeJsonAtomic(resultFilePath(this.storagePath, request.id), result);
    } catch (error) {
      this.log.debug(`Failed to write the resolve result: ${error}`);
    }
  }

  private remove(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      // Already gone.
    }
  }

  private removeIfOlderThan(filePath: string, cutoff: number): void {
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      // Already gone.
    }
  }
}
