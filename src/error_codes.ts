/**
 * Labels for Roborock error codes, shared by the Matter operational-error
 * reporting and the settings page's device error display.
 */

// Robot error_code values.
export const ROBOROCK_ERROR_LABELS: Record<number, string> = {
  1: "Laser sensor fault",
  2: "Collision sensor fault",
  3: "Wheel floating",
  4: "Cliff sensor fault",
  5: "Main brush blocked",
  6: "Side brush blocked",
  7: "Wheel blocked",
  8: "Device stuck",
  9: "Dust bin missing",
  10: "Filter blocked",
  11: "Magnetic field detected",
  12: "Low battery",
  13: "Charging problem",
  14: "Battery failure",
  15: "Wall sensor fault",
  16: "Uneven surface",
  17: "Side brush failure",
  18: "Suction fan failure",
  19: "Unpowered charging station",
  21: "Laser pressure sensor problem",
  22: "Charge sensor problem",
  23: "Dock problem",
  24: "No-go zone or invisible wall detected",
  254: "Bin full",
  255: "Internal error",
};

// Dock dock_error_status values (python-roborock RoborockDockErrorCode).
export const ROBOROCK_DOCK_ERROR_LABELS: Record<number, string> = {
  32: "No dock dustbin or filter",
  33: "Auto-empty dock fan error",
  34: "Auto-empty dock jammed",
  35: "Auto-empty dock voltage error",
  38: "Clean water tank empty",
  39: "Dirty water tank full or missing",
  42: "Maintenance brush jammed",
  44: "Water filter blocked",
  46: "Dustbin not installed",
  53: "Cleaning tank full or blocked",
};
