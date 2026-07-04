/**
 * Jest manual mock for the `homebridge` package.
 *
 * Homebridge v2 ships as pure ESM and imports the full @matter/main and
 * hap-nodejs dependency graphs, which Jest cannot parse without transforming
 * all of node_modules. The plugin only consumes a few runtime values from
 * `homebridge` (everything else is type-only and erased at compile time),
 * so those values are mirrored here.
 */

const APIEvent = {
  DID_FINISH_LAUNCHING: "didFinishLaunching",
  SHUTDOWN: "shutdown",
};

class MatterProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

const statusErrorClass = (defaultMessage) =>
  class extends MatterProtocolError {
    constructor(message = defaultMessage) {
      super(message);
    }
  };

const MatterStatus = {
  MatterProtocolError,
  Busy: statusErrorClass("Device is busy"),
  Timeout: statusErrorClass("Operation timed out"),
  ConstraintError: statusErrorClass("Value out of range"),
  InvalidAction: statusErrorClass("Invalid action"),
  InvalidInState: statusErrorClass("Invalid in current state"),
  Failure: statusErrorClass("Operation failed"),
  ResourceExhausted: statusErrorClass("Resource exhausted"),
  PermissionDenied: statusErrorClass("Permission denied"),
  NotFound: statusErrorClass("Not found"),
};

module.exports = { APIEvent, MatterStatus };
