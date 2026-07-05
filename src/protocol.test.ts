import {
  isMatterFallback,
  parseDeviceIds,
  resolveDeviceProtocol,
} from "./protocol";

const opts = (skip: string[], matter: string[], matterEnabled: boolean) => ({
  skipIds: new Set(skip),
  matterIds: new Set(matter),
  matterEnabled,
});

describe("parseDeviceIds", () => {
  it("returns [] for empty input", () => {
    expect(parseDeviceIds(undefined)).toEqual([]);
    expect(parseDeviceIds("")).toEqual([]);
    expect(parseDeviceIds([])).toEqual([]);
  });

  it("splits comma and newline separated strings and trims", () => {
    expect(parseDeviceIds("a, b\nc")).toEqual(["a", "b", "c"]);
  });

  it("accepts arrays and drops blanks", () => {
    expect(parseDeviceIds(["a", " ", "b"])).toEqual(["a", "b"]);
  });
});

describe("resolveDeviceProtocol", () => {
  it("defaults to hap when unconfigured", () => {
    expect(resolveDeviceProtocol("dev", opts([], [], true))).toBe("hap");
  });

  it("returns matter when selected and matter enabled", () => {
    expect(resolveDeviceProtocol("dev", opts([], ["dev"], true))).toBe(
      "matter"
    );
  });

  it("falls back to hap when matter selected but disabled", () => {
    expect(resolveDeviceProtocol("dev", opts([], ["dev"], false))).toBe("hap");
  });

  it("returns skip when skipped", () => {
    expect(resolveDeviceProtocol("dev", opts(["dev"], [], true))).toBe("skip");
  });

  it("gives skip precedence over matter when in both lists", () => {
    expect(resolveDeviceProtocol("dev", opts(["dev"], ["dev"], true))).toBe(
      "skip"
    );
  });

  it("trims the device id before matching", () => {
    expect(resolveDeviceProtocol(" dev ", opts([], ["dev"], true))).toBe(
      "matter"
    );
  });
});

describe("isMatterFallback", () => {
  it("is true only when matter-selected and matter disabled", () => {
    expect(isMatterFallback("dev", opts([], ["dev"], false))).toBe(true);
    expect(isMatterFallback("dev", opts([], ["dev"], true))).toBe(false);
    expect(isMatterFallback("dev", opts([], [], false))).toBe(false);
  });

  it("is false when the device is skipped", () => {
    expect(isMatterFallback("dev", opts(["dev"], ["dev"], false))).toBe(false);
  });
});
