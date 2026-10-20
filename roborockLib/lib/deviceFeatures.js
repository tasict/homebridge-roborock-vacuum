"use strict";

// The ioBroker object tree this module used to build (commands, device
// states, cleaning records, ...) fed no-op stubs in this plugin and was
// removed. What remains is the part the Homebridge plugin actually consumes:
// the featureSet bit decoding (getFeatureList), the dock-type capability
// markers (processDockType), the consumable dividers and the firmware
// feature name lookup.

const firmwareFeatures = {
  111: "isSupportFDSEndPoint",
  112: "isSupportAutoSplitSegments",
  114: "isSupportOrderSegmentClean",
  116: "isMapSegmentSupported",
  119: "isSupportLedStatusSwitch",
  120: "isMultiFloorSupported",
  122: "isSupportFetchTimerSummary",
  123: "isOrderCleanSupported",
  125: "isRemoteSupported",
};

const consumablesInt = {
  main_brush_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  side_brush_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  filter_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  filter_element_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  sensor_dirty_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  dust_collection_work_times: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  125: { type: "number", unit: "%", divider: 60 * 60, write: false },
  126: { type: "number", unit: "%", divider: 60 * 60, write: false },
  127: { type: "number", unit: "%", divider: 60 * 60, write: false },
};
const consumablesString = {
  main_brush_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  side_brush_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  filter_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  filter_element_work_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  sensor_dirty_time: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  dust_collection_work_times: {
    type: "number",
    unit: "h",
    divider: 60 * 60,
    write: false,
  },
  main_brush_life: {
    type: "number",
    unit: "%",
    divider: 60 * 60,
    write: false,
  },
  side_brush_life: {
    type: "number",
    unit: "%",
    divider: 60 * 60,
    write: false,
  },
  filter_life: { type: "number", unit: "%", divider: 60 * 60, write: false },
};

class deviceFeatures {
  constructor(adapter, features, featuresStr, duid) {
    this.adapter = adapter;
    this.features = features;
    this.featuresStr = featuresStr;
    this.duid = duid;
  }

  // Dock capability markers, invoked by processDockType. Their ioBroker
  // side effects (command/state object creation) were removed with the
  // object layer; the calls are kept because processDockType's dispatch is
  // the documented map of which dock generation supports what.
  isWashThenChargeCmdSupported() {}

  isDustCollectionSettingSupported() {}

  isSupportedDrying() {}

  // A bit of the hex new-feature string (HomeData newFeatureSet), counted
  // from its last character: bit n is bit n % 4 of the hex digit n / 4 from
  // the end.
  hasNewFeatureStrBit(bit) {
    const str = typeof this.featuresStr === "string" ? this.featuresStr : "";
    const nibble = parseInt(
      str.charAt(str.length - 1 - Math.floor(bit / 4)),
      16
    );
    return Number.isFinite(nibble) && !!((nibble >> bit % 4) & 1);
  }

  getFeatureList() {
    const robotModel = this.adapter.getProductAttribute(this.duid, "model");

    return {
      isWashThenChargeCmdSupported:
        ((this.features / Math.pow(2, 32)) >> 5) & 1,
      isDustCollectionSettingSupported: !!(33554432 & this.features),
      isSupportedDrying: ((this.features / Math.pow(2, 32)) >> 15) & 1,
      // Off-peak ("valley electricity") charging: the robot may wait on the
      // dock for cheaper power. Bit 13 of the upper 32 bits.
      isSupportedValleyElectricity:
        ((this.features / Math.pow(2, 32)) >> 13) & 1,
      // Water flow set with a 30-step slider (220 + position) instead of the
      // classic 201-203 levels. Bit 106 of the new-feature string.
      isWaterSlideModeSupported: this.hasNewFeatureStrBit(106),
      isShakeMopSetSupported: !!(262144 & this.features),
      isVideoMonitorSupported: !!(8 & this.features), // I tested this for S7 MaxV, S8 MaxV
      isVideoSettingSupported: !!(64 & this.features), // I tested this for S7 MaxV, S8 MaxV
      isCarpetSupported: !!(512 & this.features),
      isPhotoUploadSupported: !!(65536 & this.features),
      isAvoidCollisionSupported: !!(134217728 & this.features),
      isCornerCleanModeSupported: !!(2147483648 & this.features),
      isCameraSupported: !![
        "roborock.vacuum.a10",
        "roborock.vacuum.a27",
        "roborock.vacuum.a51",
        "roborock.vacuum.a87",
      ].includes(robotModel),
      isSupportSetSwitchMapMode: !!(268435456 & this.features),
      isMopForbiddenSupported: [
        "roborock.vacuum.s6", // S6
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.s5e", // S5 Max
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a72", // Q5 Pro
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a104", // Roborock Qrevo S
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a21", // Qrevo Slim
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      isShakeMopStrengthSupported: [
        "roborock.vacuum.a08", // S6 Pure
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a19", // S4 Max
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.s5e", // S5 Max
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      isWaterBoxSupported: [
        "roborock.vacuum.s5e", // S5 Max
        "roborock.vacuum.s6", // S6
        "roborock.vacuum.a08", // S6 Pure
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.a72", // Q5 Pro
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a104", // Roborock Qrevo S
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a21", // Qrevo Slim
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      isCustomWaterBoxDistanceSupported: !!(2147483648 & this.features),
      isBackChargeAutoWashSupported:
        this.featuresStr &&
        !!(4096 & parseInt("0x" + this.featuresStr.slice(-8))),
      isAvoidCarpetSupported: [
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.s6", // S6
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a104", // Roborock Qrevo S
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      isVoiceControlSupported: [
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
      ],
      isElectronicWaterBoxSupported: [], // nothing for now. If this is needed, add the models here
      isCleanRouteFastModeSupported:
        this.featuresStr &&
        !!(256 & parseInt("0x" + this.featuresStr.slice(-8))),
      isVideoLiveCallSupported: [
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a21", // Qrevo Slim
      ].includes(robotModel),
    };
  }

  async processSupportedFeatures() {
    const robotModel = this.adapter.getProductAttribute(this.duid, "model");
    this.adapter.log.debug(
      `Supported features of robot ${this.duid} - ${robotModel}: ${JSON.stringify(this.getFeatureList())}`
    );
  }

  processDockType(dockType) {
    switch (dockType) {
      case 0: // Charging dock
        // nothing to do here
        break;
      case 1: // Auto-Empty Dock - Onyx: S7+/S7Plus (Empty Dock)
        this.isDustCollectionSettingSupported();
        break;
      case 2: // Empty Wash Fill Dock - Onyx2: G10
        this.isWashThenChargeCmdSupported();
        break;
      case 3: // Empty Wash Fill (Dry) Dock - Onyx3: S7 Pro, MaxV Ultra
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
      case 5: // Onyx-C: S8, S8 Plus, Q8, Q8 Max
        this.isDustCollectionSettingSupported();
        break;
      case 6: // Onyx3 Plus: S7 Max Ultra
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
      case 7: // Onyx4: S8 Pro Ultra
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
      case 8: // PEARL: Q Revo, P10
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
      // Not much info on this one. Might be missing some features
      case 9: // Unknown codename for now: Q Revo Pro
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
      default:
        // Every dock code not listed above (10-40 and any future code) is a
        // full-featured dock: collect + wash + dry. Only the small legacy
        // exception set above lacks features, so unknown codes must enable
        // everything instead of silently disabling dock controls.
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
    }
  }

  getConsumablesDivider(consumable) {
    const robotModel = this.adapter.getProductAttribute(this.duid, "model");
    const consumables =
      robotModel == "roborock.vacuum.s4" ? consumablesInt : consumablesString;

    if (consumables[consumable]) {
      return consumables[consumable].divider;
    } else {
      return false;
    }
  }

  getFirmwareFeature(featureID) {
    const feature = firmwareFeatures[featureID];

    if (feature) {
      return feature;
    } else {
      return "unknown feature";
    }
  }
}

module.exports = {
  deviceFeatures,
};
