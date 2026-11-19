"use strict";

// Roborock Q10 series (protocol B01, models roborock.vacuum.ss*, e.g. the
// Q10 S5+ roborock.vacuum.ss07).
//
// B01 is shared by two device families that speak different dialects inside
// the same encrypted frame. The Q7 series (sc*) wraps a JSON-RPC call in data
// point 10000. A Q10 understands none of that: it is controlled by writing
// numbered data points directly, {"dps":{"201":1}}, and it never replies to a
// write. Its state arrives as data point pushes on protocol 102, and its map
// and cleaning path as binary packets on protocol 301. There is no local
// (LAN) protocol, so everything goes through the cloud MQTT broker.
//
// The data point numbers, payloads and enums follow python-roborock
// (roborock/data/b01_q10, roborock/devices/traits/b01/q10), whose commands
// are marked as verified on ss07 hardware, and the Q10 protocol notes of
// roborock-q10-cli (DP_DICTIONARY.md, FRAME_ANATOMY.md). The command set
// matches homebridge-roborock-matter, where it was confirmed on a Q10 S5.
//
// This module translates between that dialect and the V1 shapes the rest of
// the plugin speaks: V1 method names going out, V1 status fields (state,
// battery, fan_power, ...) coming in. It keeps no state of its own.

const DP = {
  FAULT: 90,
  COMMON: 101,
  REQUEST_DPS: 102,
  STATUS: 121,
  BATTERY: 122,
  FAN_LEVEL: 123,
  WATER_LEVEL: 124,
  MAIN_BRUSH_LIFE: 125,
  SIDE_BRUSH_LIFE: 126,
  FILTER_LIFE: 127,
  CLEAN_MODE: 137,
  START_CLEAN: 201,
  START_BACK: 202,
  START_DOCK_TASK: 203,
  PAUSE: 204,
  RESUME: 205,
  STOP: 206,
};

// dpStartClean (201) task codes.
const CLEAN_TASK_WHOLE_HOME = 1;
const CLEAN_TASK_ROOMS = 2;
// dpStartBack (202): 5 returns to the dock to charge, as the Roborock app
// does (1 and 4 also wash the mop or empty the bin on the way).
const BACK_TO_DOCK_CHARGE = 5;
// dpStartDockTask (203): 2 empties the dust bin.
const DOCK_TASK_EMPTY_BIN = 2;

// dpCleanMode (137).
const CLEAN_MODE_VACUUM_AND_MOP = 1;
const CLEAN_MODE_VACUUM = 2;
const CLEAN_MODE_MOP = 3;

// V1 values the rest of the plugin uses for suction and water.
const V1_FAN_OFF = 105;
const V1_WATER_OFF = 200;

// dpFanLevel (123) <-> V1 fan_power. Q10: 0 off, 1 quiet, 2 balanced,
// 3 turbo, 4 max, 8 max+.
const FAN_LEVEL_TO_V1 = {
  0: V1_FAN_OFF,
  1: 101,
  2: 102,
  3: 103,
  4: 104,
  8: 108,
};
const V1_TO_FAN_LEVEL = { 101: 1, 102: 2, 103: 3, 104: 4, 108: 8 };

// dpWaterLevel (124) <-> V1 water_box_mode. Q10: 0 off, 1 low, 2 medium,
// 3 high.
const WATER_LEVEL_TO_V1 = { 0: V1_WATER_OFF, 1: 201, 2: 202, 3: 203 };
const V1_TO_WATER_LEVEL = { 201: 1, 202: 2, 203: 3 };

// dpStatus (121) -> the V1 state with the same meaning. The common states use
// the V1 numbers already. The Q10 adds sub-states of a running clean (99
// saving the map, 101 relocating, 102 vacuuming, 103 mopping, 104 vacuuming
// and mopping, 105 transitioning) and 108 waiting to charge; read as V1
// numbers, 101 and 103 would mean "offline" and "locked", so they are folded
// into cleaning (5) and charging (8). 7 is remote control, V1 state 4.
const STATE_TO_V1 = {
  2: 2, // sleeping
  3: 3, // idle
  5: 5, // cleaning
  6: 6, // returning to the dock
  7: 4, // remote control
  8: 8, // charging
  10: 10, // paused
  12: 12, // error
  14: 14, // updating
  22: 22, // emptying the bin
  29: 29, // mapping
  99: 5, // saving the map
  101: 5, // relocating
  102: 5, // vacuuming
  103: 5, // mopping
  104: 5, // vacuuming and mopping
  105: 5, // transitioning
  108: 8, // waiting to charge
};

// The V1 error state. dpFault lingers after the event that set it (and can
// read 0 while the robot is in error), so the robot's state decides whether
// there is a fault at all: one is reported only while the state is "error".
const V1_STATE_ERROR = 12;

// dpFault (90) codes that share a V1 error_code's meaning, so the existing
// labels and Matter error mapping apply. Most of the low Q10 codes are the
// V1 numbers.
const FAULT_TO_V1_ERROR = {
  1: 1, // lidar blocked -> laser sensor fault
  2: 2, // bumper stuck -> collision sensor fault
  3: 3, // robot suspended -> wheel floating
  4: 4, // cliff sensor error
  5: 5, // main brush stuck
  7: 7, // main wheels stuck -> wheel blocked
  8: 8, // robot trapped -> device stuck
  9: 9, // check dust bin and filter -> dust bin missing
  16: 16, // robot tilted -> uneven surface
  21: 21, // lidar cover obstructed -> laser pressure sensor problem
  24: 24, // no-go zone detected
  46: 9, // install the dust bag -> dust bin missing
  310: 254, // dust bag full -> bin full
  503: 23, // docking error -> dock problem
};

// dpFault codes that report a step of a normal clean, not a problem: low
// battery (the robot recharges and resumes), consumable reminders, starting a
// scheduled clean, clean in progress, clean finished, recharge and resume,
// "too frequent emptying", positioning and target outcomes, offline warnings.
const INFORMATIONAL_FAULTS = new Set([
  0, 12, 301, 302, 303, 304, 400, 407, 501, 502, 556, 569, 570, 588, 589, 591,
  3001,
]);

// Names of the dpFault codes for the log (python-roborock YXFault).
const FAULT_NAMES = {
  1: "lidar blocked",
  2: "bumper stuck",
  3: "robot suspended",
  4: "cliff sensor error",
  5: "main brush stuck",
  7: "main wheels stuck",
  8: "robot trapped",
  9: "check the dust bin and filter",
  12: "low battery",
  14: "temperature out of range",
  16: "robot tilted",
  21: "lidar cover obstructed",
  24: "no-go zone detected",
  27: "mopping module stuck",
  28: "carpet avoidance",
  29: "cannot cross the carpet",
  46: "install the dust bag",
  54: "mop mount fell off",
  58: "lidar dirty",
  310: "dust bag full",
  503: "docking error",
  707: "clean the carpet sensors",
  1002: "robot error reset",
};

// Remaining-life fields for dpMainBrushLife/dpSideBrushLife/dpFilterLife,
// which report hours of use (rated 300/200/150 h, as on V1 robots).
const CONSUMABLE_DPS = {
  main_brush: DP.MAIN_BRUSH_LIFE,
  side_brush: DP.SIDE_BRUSH_LIFE,
  filter: DP.FILTER_LIFE,
};

/** Whether a device with this protocol version and model is a Q10. */
function isQ10Model(pv, model) {
  if (pv !== "B01" || typeof model !== "string") {
    return false;
  }
  return model.split(".").pop().startsWith("ss");
}

function firstParam(params) {
  return Array.isArray(params) ? params[0] : params;
}

// Room ids from app_segment_clean's [{ segments: [...] }] or a plain list.
function segmentIds(params) {
  const first = firstParam(params);
  const ids =
    first && typeof first === "object" && Array.isArray(first.segments)
      ? first.segments
      : Array.isArray(params)
        ? params
        : [];
  return ids.map(Number).filter((id) => Number.isInteger(id) && id >= 0);
}

/**
 * The data point write for a V1 method, as { dp, value }, or null when the
 * Q10 has no equivalent (every read included: a Q10 never answers).
 * context.paused: the robot is paused, so app_start resumes the paused task
 * instead of starting a new whole-home clean.
 */
function encodeCommand(method, params, context = {}) {
  switch (method) {
    case "app_start":
      return context.paused
        ? { dp: DP.RESUME, value: 0 }
        : { dp: DP.START_CLEAN, value: CLEAN_TASK_WHOLE_HOME };
    case "resume_segment_clean":
    case "resume_zoned_clean":
      return { dp: DP.RESUME, value: 0 };
    case "app_pause":
      return { dp: DP.PAUSE, value: 0 };
    case "app_stop":
      return { dp: DP.STOP, value: 0 };
    case "app_charge":
      return { dp: DP.START_BACK, value: BACK_TO_DOCK_CHARGE };
    case "app_start_collect_dust":
      return { dp: DP.START_DOCK_TASK, value: DOCK_TASK_EMPTY_BIN };
    case "app_segment_clean": {
      const rooms = segmentIds(params);
      if (rooms.length === 0) {
        return null;
      }
      // "clean_paramters" is the firmware's own spelling; it accepts no other.
      return {
        dp: DP.START_CLEAN,
        value: { cmd: CLEAN_TASK_ROOMS, clean_paramters: rooms },
      };
    }
    case "set_custom_mode": {
      const level = V1_TO_FAN_LEVEL[Number(firstParam(params))];
      return level === undefined ? null : { dp: DP.FAN_LEVEL, value: level };
    }
    case "set_water_box_custom_mode": {
      const level = V1_TO_WATER_LEVEL[Number(firstParam(params))];
      return level === undefined ? null : { dp: DP.WATER_LEVEL, value: level };
    }
    default:
      return null;
  }
}

/**
 * The data point write for a Matter clean mode given in V1 terms: suction off
 * (105) means mop only, water off (200) means vacuum only, both on means
 * vacuum and mop. Returns null when the values name no mode.
 *
 * Only the mode is written. A Q10 keeps its suction and water levels per mode,
 * and the levels the Matter accessory passes along are V1 defaults whenever
 * the current mode had that motor off, so writing them would overwrite the
 * levels set in the Roborock app.
 */
function encodeCleanMode(fanPower, waterBoxMode) {
  const fan = fanPower === undefined ? undefined : Number(fanPower);
  const water = waterBoxMode === undefined ? undefined : Number(waterBoxMode);

  if (fan === V1_FAN_OFF) {
    return { dp: DP.CLEAN_MODE, value: CLEAN_MODE_MOP };
  }
  if (water === V1_WATER_OFF) {
    return { dp: DP.CLEAN_MODE, value: CLEAN_MODE_VACUUM };
  }
  if (fan !== undefined && water !== undefined) {
    return { dp: DP.CLEAN_MODE, value: CLEAN_MODE_VACUUM_AND_MOP };
  }
  return null;
}

/** The MQTT payload for a data point write. 0 is a real value. */
function encodePayload(dp, value) {
  return JSON.stringify({
    dps: { [String(dp)]: value === undefined || value === null ? {} : value },
  });
}

/**
 * A data point map with the nested dpCommon (101) values lifted to the top
 * level, where python-roborock reads them too (the fault arrives there).
 */
function flattenDps(dps) {
  if (!dps || typeof dps !== "object") {
    return {};
  }
  const flat = { ...dps };
  const common = flat[String(DP.COMMON)];
  delete flat[String(DP.COMMON)];
  if (common && typeof common === "object" && !Array.isArray(common)) {
    Object.assign(flat, common);
  }
  return flat;
}

function numberAt(dps, dp) {
  const value = dps[String(dp)];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * V1 status fields for a flattened data point map (see flattenDps). Pass the
 * robot's accumulated data points: a push often carries one or two, and
 * suction and water depend on the clean mode as well.
 *
 * Returns { status, unknownState, unmappedFault }. status holds only the
 * fields that could be read faithfully; unknownState and unmappedFault carry
 * a code the plugin has no translation for, for the log.
 */
function toV1Status(dps, options = {}) {
  const status = {};
  let unknownState;
  let unmappedFault;

  const rawState = numberAt(dps, DP.STATUS);
  if (rawState !== undefined) {
    const state = STATE_TO_V1[rawState];
    if (state === undefined) {
      unknownState = rawState;
    } else {
      status.state = state;
      // Emptying the bin happens in the dock, but whether the robot charges
      // meanwhile is not reported.
      if (state !== 22) {
        status.charge_status = state === 8 ? 1 : 0;
      }
    }
  }

  const battery = numberAt(dps, DP.BATTERY);
  if (battery !== undefined) {
    status.battery = battery;
  }

  const mode = numberAt(dps, DP.CLEAN_MODE);
  const fanLevel = numberAt(dps, DP.FAN_LEVEL);
  const waterLevel = numberAt(dps, DP.WATER_LEVEL);
  if (mode === CLEAN_MODE_MOP) {
    status.fan_power = V1_FAN_OFF;
  } else if (
    fanLevel !== undefined &&
    FAN_LEVEL_TO_V1[fanLevel] !== undefined
  ) {
    status.fan_power = FAN_LEVEL_TO_V1[fanLevel];
  }
  if (mode === CLEAN_MODE_VACUUM) {
    status.water_box_mode = V1_WATER_OFF;
  } else if (
    waterLevel !== undefined &&
    WATER_LEVEL_TO_V1[waterLevel] !== undefined
  ) {
    status.water_box_mode = WATER_LEVEL_TO_V1[waterLevel];
  }

  if (status.state !== undefined) {
    const fault = numberAt(dps, DP.FAULT);
    if (
      status.state !== V1_STATE_ERROR ||
      fault === undefined ||
      INFORMATIONAL_FAULTS.has(fault)
    ) {
      status.error_code = 0;
    } else if (FAULT_TO_V1_ERROR[fault] !== undefined) {
      status.error_code = FAULT_TO_V1_ERROR[fault];
    } else {
      status.error_code = 0;
      unmappedFault = fault;
    }
  }

  const ratedHours = options.ratedHours || {};
  for (const [name, dp] of Object.entries(CONSUMABLE_DPS)) {
    const hoursUsed = numberAt(dps, dp);
    const rated = ratedHours[name];
    if (hoursUsed !== undefined && rated > 0) {
      status[`${name}_life`] = Math.max(
        0,
        Math.round(100 - (hoursUsed / rated) * 100)
      );
    }
  }

  return { status, unknownState, unmappedFault };
}

/** A readable name for a dpFault code. */
function describeFault(code) {
  return FAULT_NAMES[code] || `fault ${code}`;
}

// Current-map packet (protocol 301, marker 01 01): map id u32 BE at 2, grid
// width and height u16 BE at 7 and 9, the LZ4 block length u16 BE at 27 and
// the block from 29. Inflated, it holds width * height grid cells followed by
// 01 <room count> and one 47-byte record per room: id u16 BE at 0, name
// length at 26, UTF-8 name from 27. Other markers (02 01 cleaning path,
// 03 01 clean record, 04 01 saved map) carry no room list.
const MAP_ID_OFFSET = 2;
const MAP_WIDTH_OFFSET = 7;
const MAP_HEIGHT_OFFSET = 9;
const MAP_BLOCK_LENGTH_OFFSET = 27;
const MAP_BLOCK_OFFSET = 29;
const ROOM_RECORD_LENGTH = 47;
const ROOM_NAME_LENGTH_OFFSET = 26;
const ROOM_NAME_OFFSET = 27;
const MAX_ROOMS = 32;
const MAX_GRID_CELLS = 16000000;

/**
 * Inflate a raw LZ4 block (no frame header). Throws on a malformed block or
 * one that would grow past maxOutput bytes.
 */
function lz4BlockDecompress(input, maxOutput) {
  let output = Buffer.alloc(
    Math.min(maxOutput, Math.max(64, input.length * 4))
  );
  let outLength = 0;
  let position = 0;

  const ensure = (extra) => {
    const needed = outLength + extra;
    if (needed > maxOutput) {
      throw new Error("LZ4 block is larger than expected");
    }
    if (needed > output.length) {
      const grown = Buffer.alloc(
        Math.min(maxOutput, Math.max(needed, output.length * 2))
      );
      output.copy(grown, 0, 0, outLength);
      output = grown;
    }
  };
  const readLength = (length) => {
    if (length !== 15) {
      return length;
    }
    for (;;) {
      if (position >= input.length) {
        throw new Error("LZ4 block ends inside a length");
      }
      const byte = input[position++];
      length += byte;
      if (byte !== 255) {
        return length;
      }
    }
  };

  for (;;) {
    if (position >= input.length) {
      throw new Error("LZ4 block ends before a sequence");
    }
    const token = input[position++];
    const literals = readLength(token >> 4);
    if (position + literals > input.length) {
      throw new Error("LZ4 block ends inside its literals");
    }
    ensure(literals);
    input.copy(output, outLength, position, position + literals);
    outLength += literals;
    position += literals;

    // The last sequence carries literals only.
    if (position === input.length) {
      return output.subarray(0, outLength);
    }

    if (position + 2 > input.length) {
      throw new Error("LZ4 block ends inside a match offset");
    }
    const offset = input[position] | (input[position + 1] << 8);
    position += 2;
    if (offset === 0 || offset > outLength) {
      throw new Error("LZ4 block has an invalid match offset");
    }
    const matchLength = readLength(token & 0x0f) + 4;
    ensure(matchLength);
    // Byte by byte: a match may overlap the bytes it produces.
    for (let i = 0; i < matchLength; i++) {
      output[outLength] = output[outLength - offset];
      outLength++;
    }
  }
}

function isRoomSection(section, count) {
  return (
    section.length === 2 + count * ROOM_RECORD_LENGTH &&
    section[0] === 1 &&
    section[1] === count
  );
}

// The room records follow the width * height grid. Older firmware leaves the
// height empty; then the split is found from the record count.
function findRoomSection(layout, width, height) {
  if (height > 0 && width * height <= layout.length) {
    const section = layout.subarray(width * height);
    if (section.length >= 2 && isRoomSection(section, section[1])) {
      return section;
    }
  }
  for (let count = 0; count <= MAX_ROOMS; count++) {
    const gridLength = layout.length - (2 + count * ROOM_RECORD_LENGTH);
    if (gridLength > 0 && gridLength % width === 0) {
      const section = layout.subarray(gridLength);
      if (isRoomSection(section, count)) {
        return section;
      }
    }
  }
  return null;
}

// Firmware default names look like "rr_living_room"; the Roborock app shows
// them as "Living Room". Names the user typed are kept as they are.
function roomName(rawName, id) {
  const name = rawName.replace(/\0+$/, "").trim();
  if (!name) {
    return `Room ${id}`;
  }
  if (!name.startsWith("rr_")) {
    return name;
  }
  const words = name.slice(3).split("_").filter(Boolean);
  if (words.length === 0) {
    return `Room ${id}`;
  }
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * The rooms of a current-map packet as { mapId, rooms: [{ id, name }] }, or
 * null for any other protocol 301 packet. Throws on a malformed map packet.
 */
function parseMapRooms(payload) {
  if (payload.length < 2 || payload[0] !== 1 || payload[1] !== 1) {
    return null;
  }
  if (payload.length < MAP_BLOCK_OFFSET) {
    throw new Error(`map packet too short (${payload.length} bytes)`);
  }

  const mapId = payload.readUInt32BE(MAP_ID_OFFSET);
  const width = payload.readUInt16BE(MAP_WIDTH_OFFSET);
  const height = payload.readUInt16BE(MAP_HEIGHT_OFFSET);
  if (width === 0 || width * height > MAX_GRID_CELLS) {
    throw new Error(`map packet has invalid dimensions ${width}x${height}`);
  }
  const blockLength = payload.readUInt16BE(MAP_BLOCK_LENGTH_OFFSET);
  const blockEnd = MAP_BLOCK_OFFSET + blockLength;
  if (blockLength === 0 || blockEnd > payload.length) {
    throw new Error("map packet has an invalid layout length");
  }

  const layout = lz4BlockDecompress(
    payload.subarray(MAP_BLOCK_OFFSET, blockEnd),
    MAX_GRID_CELLS + 2 + MAX_ROOMS * ROOM_RECORD_LENGTH
  );
  const section = findRoomSection(layout, width, height);
  if (!section) {
    throw new Error("map packet has no room records");
  }

  const rooms = [];
  const seen = new Map();
  for (let index = 0; index < section[1]; index++) {
    const record = section.subarray(
      2 + index * ROOM_RECORD_LENGTH,
      2 + (index + 1) * ROOM_RECORD_LENGTH
    );
    const id = record.readUInt16BE(0);
    const nameLength = Math.min(
      record[ROOM_NAME_LENGTH_OFFSET],
      ROOM_RECORD_LENGTH - ROOM_NAME_OFFSET
    );
    let name = roomName(
      record
        .subarray(ROOM_NAME_OFFSET, ROOM_NAME_OFFSET + nameLength)
        .toString("utf8"),
      id
    );
    // Apple Home needs distinct names.
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    if (count > 1) {
      name = `${name} ${count}`;
    }
    rooms.push({ id, name });
  }
  return { mapId, rooms };
}

module.exports = {
  DP,
  isQ10Model,
  encodeCommand,
  encodeCleanMode,
  encodePayload,
  flattenDps,
  toV1Status,
  describeFault,
  parseMapRooms,
  lz4BlockDecompress,
};
