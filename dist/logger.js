"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Decorates the Homebridge logger to only log debug messages when debug mode is enabled.
 */
class RoborockPlatformLogger {
    constructor(logger, debugMode) {
        this.logger = logger;
        this.debugMode = debugMode;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug(...messages) {
        if (this.debugMode) {
            for (let i = 0; i < messages.length; i++) {
                this.logger.debug(messages[i]);
            }
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info(...messages) {
        for (let i = 0; i < messages.length; i++) {
            this.logger.info(messages[i]);
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    warn(...messages) {
        for (let i = 0; i < messages.length; i++) {
            this.logger.warn(messages[i]);
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error(...messages) {
        for (let i = 0; i < messages.length; i++) {
            this.logger.error(messages[i]);
        }
    }
}
exports.default = RoborockPlatformLogger;
//# sourceMappingURL=logger.js.map