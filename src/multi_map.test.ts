const { Roborock } = require("../roborockLib/roborockAPI");

const DUID = "d1";

const HOME_DATA = {
  products: [{ id: "p1", model: "roborock.vacuum.a27", schema: [] }],
  devices: [{ duid: DUID, name: "Vacuum", productId: "p1", pv: "1.0" }],
  receivedDevices: [],
};

const MAPS = [
  { mapFlag: 0, name: "Ground" },
  { mapFlag: 2, name: "First" },
  { mapFlag: 3, name: "Attic" },
];

// get_room_mapping per map: [segment id, room id]. The attic is not divided.
const ROOM_MAPPING: Record<number, Array<[number, string]>> = {
  0: [
    [16, "r1"],
    [17, "r2"],
  ],
  2: [[16, "r3"]],
  3: [],
};

// A robot on its dock with map 0 loaded. A loaded map shows up in get_status
// only on the second poll, and until then get_room_mapping still answers
// with the previous map's rooms.
function createApi() {
  const api = new Roborock({
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  });
  api.states["HomeData"] = { val: JSON.stringify(HOME_DATA), ack: true };
  api.roomIDs = { r1: "Kitchen", r2: "Hall", r3: "Bedroom" };
  api.multiMapData[DUID] = { maps: MAPS, rooms: {} };
  api.saveMultiMapCache = jest.fn();
  api.bInited = true;
  api.vacuums[DUID] = { command: jest.fn() };

  const robot = { map: 0, state: 8, pending: null as number | null, lag: 0 };
  const loads: number[] = [];
  api.messageQueueHandler = {
    sendRequest: jest.fn(async (_duid: string, method: string, params) => {
      if (method === "get_status") {
        if (robot.pending !== null && robot.lag-- <= 0) {
          robot.map = robot.pending;
          robot.pending = null;
        }
        return [{ state: robot.state, map_status: robot.map * 4 + 3 }];
      }
      if (method === "get_room_mapping") {
        return ROOM_MAPPING[robot.map];
      }
      if (method === "load_multi_map") {
        loads.push(params[0]);
        robot.pending = params[0];
        robot.lag = 1;
        return ["ok"];
      }
      if (method === "get_multi_maps_list") {
        return [{ map_info: MAPS }];
      }
      throw new Error(`unexpected ${method}`);
    }),
  };
  return { api, robot, loads };
}

// Runs an API call to completion through its sleeps.
async function settle<T>(promise: Promise<T>): Promise<T> {
  await jest.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("multi-floor maps", () => {
  it("reads each other map once it is loaded, then restores the original", async () => {
    const { api, robot, loads } = createApi();
    await api.pollStatus(DUID);

    await settle(api.refreshMultiMaps(DUID));

    expect(api.multiMapData[DUID].rooms).toEqual({
      0: { 16: "Kitchen", 17: "Hall" },
      2: { 16: "Bedroom" },
      3: {},
    });
    expect(loads).toEqual([2, 3, 0]);
    expect(robot.map).toBe(0);
    expect(api.isMapDiscoveryRunning(DUID)).toBe(false);

    // Every map was read: no further map cycling, even for the attic.
    await settle(api.refreshMultiMaps(DUID));
    expect(loads).toEqual([2, 3, 0]);
  });

  it("does not cycle maps while the vacuum is off its dock", async () => {
    const { api, robot, loads } = createApi();
    robot.state = 3;
    await api.pollStatus(DUID);

    await settle(api.refreshMultiMaps(DUID));

    expect(loads).toEqual([]);
  });

  it("refuses to start a clean while another map is loaded", async () => {
    const { api } = createApi();
    api._mapDiscoveryRunning.add(DUID);

    await expect(api.app_segment_clean(DUID, [16])).rejects.toThrow(
      /switching floor maps/
    );
    await expect(api.app_start(DUID)).rejects.toThrow(/switching floor maps/);
    await api.app_charge(DUID);
    expect(api.vacuums[DUID].command).toHaveBeenCalledTimes(1);
  });

  it("checks the loaded map's rooms without loading it again", async () => {
    const { api, loads } = createApi();

    const names = await settle(api.switchToMap(DUID, 0));

    expect(names).toEqual({ 16: "Kitchen", 17: "Hall" });
    expect(loads).toEqual([]);
  });

  it("loads another map for a clean and returns its rooms", async () => {
    const { api, loads } = createApi();

    const names = await settle(api.switchToMap(DUID, 2));

    expect(names).toEqual({ 16: "Bedroom" });
    expect(loads).toEqual([2]);
    expect(api.multiMapData[DUID].rooms[2]).toEqual({ 16: "Bedroom" });
  });

  it("only switches maps on the dock", async () => {
    const { api, robot, loads } = createApi();
    robot.state = 3;

    await expect(api.switchToMap(DUID, 2)).rejects.toThrow(/not on its dock/);
    expect(loads).toEqual([]);
  });

  it("keeps publishing every floor while the loaded map is unknown", () => {
    const { api } = createApi();

    const areas = api.getMultiMapAreas(DUID);

    expect(areas.currentMapFlag).toBeNull();
    expect(areas.maps).toEqual(MAPS);
  });
});
