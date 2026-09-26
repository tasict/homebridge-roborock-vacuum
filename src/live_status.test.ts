const { Roborock } = require("../roborockLib/roborockAPI");

function createLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

const DUID = "d1";

// HomeData snapshot with a stale status (idle, 50 %) and a schema that, like
// older products, has no charge_status entry.
const HOME_DATA = {
  products: [
    {
      id: "p1",
      model: "roborock.vacuum.a19",
      schema: [
        { id: 121, code: "state" },
        { id: 122, code: "battery" },
      ],
    },
  ],
  devices: [
    {
      duid: DUID,
      name: "Vacuum",
      productId: "p1",
      pv: "1.0",
      deviceStatus: { "121": 3, "122": 50 },
    },
  ],
  receivedDevices: [],
};

function createApi(homeData: Record<string, unknown> = HOME_DATA) {
  const api = new Roborock({ log: createLogger() });
  api.states["HomeData"] = { val: JSON.stringify(homeData), ack: true };
  api.messageQueueHandler = { sendRequest: jest.fn() };
  return api;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("live device status", () => {
  it("falls back to the HomeData snapshot while nothing live is known", () => {
    const api = createApi();
    expect(api.getVacuumDeviceStatus(DUID, "state")).toBe(3);
    expect(api.getVacuumDeviceStatus(DUID, "charge_status")).toBe("");
  });

  it("serves polled get_status fields over the HomeData snapshot", async () => {
    const api = createApi();
    api.messageQueueHandler.sendRequest.mockResolvedValue([
      { state: 8, battery: 100, charge_status: 1, msg_ver: 2 },
    ]);

    await api.pollStatus(DUID);

    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      DUID,
      "get_status",
      []
    );
    expect(api.getVacuumDeviceStatus(DUID, "state")).toBe(8);
    expect(api.getVacuumDeviceStatus(DUID, "battery")).toBe(100);
    // Missing from the product schema, available from get_status.
    expect(api.getVacuumDeviceStatus(DUID, "charge_status")).toBe(1);
  });

  it("does not poll get_status on non-V1 devices", async () => {
    const api = createApi({
      ...HOME_DATA,
      devices: [{ ...HOME_DATA.devices[0], pv: "B01" }],
    });

    await api.pollStatus(DUID);

    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });

  it("records status broadcasts by schema id", () => {
    const api = createApi();
    api.recordStatusBroadcast(DUID, { "121": 5, "133": 0 });

    expect(api.getVacuumDeviceStatus(DUID, "state")).toBe(5);
    expect(api.getVacuumDeviceStatus(DUID, "charge_status")).toBe(0);
    // Fields the broadcast did not carry still come from HomeData.
    expect(api.getVacuumDeviceStatus(DUID, "battery")).toBe(50);
  });

  it("falls back to HomeData once live values are stale", () => {
    jest.useFakeTimers();
    const api = createApi();
    api.recordLiveStatus(DUID, { state: 8 });
    expect(api.getVacuumDeviceStatus(DUID, "state")).toBe(8);

    jest.advanceTimersByTime(api.updateInterval * 3 * 1000 + 1);

    expect(api.getVacuumDeviceStatus(DUID, "state")).toBe(3);
  });
});
