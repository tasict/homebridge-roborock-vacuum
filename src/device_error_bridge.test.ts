import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEVICE_ERRORS_FILE,
  DeviceErrorBridge,
  RESOLVE_REQUEST_DIR,
  requestFilePath,
  resultFilePath,
} from "./device_error_bridge";

function createLogger() {
  return { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

describe("DeviceErrorBridge", () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "rr-errors-"));
    fs.mkdirSync(path.join(storagePath, RESOLVE_REQUEST_DIR));
  });

  afterEach(() => {
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  function writeRequest(id: string, duid: string, requestedAt = Date.now()) {
    fs.writeFileSync(
      requestFilePath(storagePath, id),
      JSON.stringify({ id, duid, requestedAt })
    );
  }

  function readResult(id: string) {
    return JSON.parse(fs.readFileSync(resultFilePath(storagePath, id), "utf8"));
  }

  it("publishes device errors and skips unchanged content", () => {
    const bridge = new DeviceErrorBridge(
      storagePath,
      jest.fn(),
      createLogger()
    );
    const errorsPath = path.join(storagePath, DEVICE_ERRORS_FILE);
    const devices = [
      { duid: "d1", name: "Vacuum", errorCode: 0, dockErrorCode: 38 },
    ];

    bridge.publish(devices);
    expect(JSON.parse(fs.readFileSync(errorsPath, "utf8")).devices).toEqual(
      devices
    );

    fs.unlinkSync(errorsPath);
    bridge.publish(devices.map((device) => ({ ...device })));
    expect(fs.existsSync(errorsPath)).toBe(false);
  });

  it("runs a resolve request once and answers it", async () => {
    const resolve = jest.fn().mockResolvedValue(true);
    const bridge = new DeviceErrorBridge(storagePath, resolve, createLogger());
    writeRequest("req-1", "d1");

    await bridge.processRequests();
    await bridge.processRequests();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("d1");
    expect(fs.existsSync(requestFilePath(storagePath, "req-1"))).toBe(false);
    expect(readResult("req-1")).toMatchObject({
      id: "req-1",
      ok: true,
      message: "Error resolved.",
    });
  });

  it("reports when there was nothing to resolve", async () => {
    const bridge = new DeviceErrorBridge(
      storagePath,
      jest.fn().mockResolvedValue(false),
      createLogger()
    );
    writeRequest("req-2", "d1");

    await bridge.processRequests();

    expect(readResult("req-2")).toMatchObject({
      ok: true,
      message: "There is no error to resolve.",
    });
  });

  it("reports a failed resolve", async () => {
    const bridge = new DeviceErrorBridge(
      storagePath,
      jest.fn().mockRejectedValue(new Error("invalid params")),
      createLogger()
    );
    writeRequest("req-3", "d1");

    await bridge.processRequests();

    const result = readResult("req-3");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid params");
  });

  it("drops expired and malformed requests", async () => {
    const resolve = jest.fn();
    const bridge = new DeviceErrorBridge(storagePath, resolve, createLogger());
    writeRequest("req-4", "d1", Date.now() - 2 * 60 * 1000);
    fs.writeFileSync(
      path.join(storagePath, RESOLVE_REQUEST_DIR, "bad.request.json"),
      JSON.stringify({ id: "../escape", duid: "d1", requestedAt: Date.now() })
    );

    await bridge.processRequests();

    expect(resolve).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(storagePath, RESOLVE_REQUEST_DIR))).toEqual(
      []
    );
  });
});
