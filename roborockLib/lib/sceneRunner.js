"use strict";

// Runs a Roborock scene ("routine") over the local connection: each item is a
// device RPC that is replayed verbatim, one at a time. The cloud tells its own
// runner that an item is done with a DP 130 push, which was never seen on the
// local connection, so the end of an item is read from get_status instead.
const POLL_INTERVAL = 15 * 1000;
// An item the robot does not start within this time stops the run.
const START_TIMEOUT = 5 * 60 * 1000;
// An item that runs longer than this stops the run.
const ITEM_TIMEOUT = 4 * 60 * 60 * 1000;
// Charging, fully charged: the robot is back on the dock.
const DOCKED_STATES = [8, 100];
// Emptying the dust bin, washing the mop (23, alias 25), going to wash it:
// the dock is still busy and the next item waits.
const DOCK_BUSY_STATES = [22, 23, 25, 26];

class sceneRunner {
  constructor(adapter) {
    this.adapter = adapter;
    // duid -> the run in progress on that robot
    this.runs = new Map();
  }

  // The scene's action items as stored by the Roborock app, or [] when the
  // scene cannot be parsed.
  sceneItems(scene) {
    try {
      const items = JSON.parse(scene.param).action.items;
      return Array.isArray(items) ? items : [];
    } catch (error) {
      return [];
    }
  }

  // The robots a scene targets.
  targets(scene) {
    return this.sceneItems(scene)
      .map((item) => item && item.entityId)
      .filter((duid) => typeof duid === "string");
  }

  // The scene as ordered { duid, method, params } commands when every item is
  // a device command (CMD) for a V1 robot of this account that is connected
  // locally; null when the scene has to run in the cloud.
  localItems(scene) {
    const items = this.sceneItems(scene);
    if (items.length === 0) {
      return null;
    }

    const commands = [];
    for (const item of items) {
      if (!item || item.type !== "CMD") {
        return null;
      }

      let command;
      try {
        command = JSON.parse(item.param);
      } catch (error) {
        return null;
      }
      if (!command || typeof command.method !== "string" || !command.method) {
        return null;
      }

      const duid = item.entityId;
      if (
        !this.adapter.hasInitializedVacuum(duid) ||
        this.adapter.isSharedDevice(duid) ||
        !this.adapter.isLocallyConnected(duid) ||
        // Connected but not answering: the item would only time out.
        this.adapter.shouldPreferCloudLocally(duid) ||
        // The end of an item is read from get_status, which only V1 robots answer.
        this.adapter.getVacuumDeviceInfo(duid, "pv") !== "1.0"
      ) {
        return null;
      }

      commands.push({
        duid,
        method: command.method,
        params: command.params === undefined ? [] : command.params,
      });
    }
    return commands;
  }

  // Run the scene locally; the caller has cancelled earlier runs on its
  // robots. Resolves true once the first item has started (or the run was
  // cancelled meanwhile), or false when it did not start and the caller
  // should ask the cloud instead. The remaining items run in the background.
  async start(scene, items) {
    const run = {
      name: scene.name || `${scene.id}`,
      items,
      cancelled: false,
      timer: null,
      wake: null,
    };
    for (const item of items) {
      this.runs.set(item.duid, run);
    }

    this.adapter.log.info(`Running scene "${run.name}" locally.`);
    if (!(await this.startItem(run, 0)) && !run.cancelled) {
      this.finish(run);
      this.adapter.log.warn(
        `Scene "${run.name}" could not start locally. Asking the Roborock cloud to run it.`
      );
      return false;
    }

    this.continue(run)
      .catch((error) => {
        this.adapter.log.error(
          `Scene "${run.name}" stopped: ${error && error.message}`
        );
      })
      .finally(() => this.finish(run));
    return true;
  }

  async continue(run) {
    for (let index = 0; index < run.items.length; index++) {
      if (index > 0 && !(await this.startItem(run, index)) && !run.cancelled) {
        this.stop(run, index, "the robot did not accept it");
        return;
      }

      const failure = run.cancelled
        ? "it was cancelled"
        : await this.waitForItem(run, run.items[index].duid);
      if (failure) {
        this.stop(run, index + 1, failure);
        return;
      }
    }
    this.adapter.log.info(`Scene "${run.name}" finished.`);
  }

  // Send one item. A reply other than "ok" (a rejection, a timeout, a lost
  // reply) counts as started only when a fresh status shows the robot busy
  // and it was not busy before, so a scene never falls back to the cloud for
  // an item the robot already runs, nor adopts an unrelated clean.
  async startItem(run, index) {
    const item = run.items[index];
    const wasBusy = this.isBusy(item.duid);
    try {
      const result = await this.adapter.messageQueueHandler.sendLocalRequest(
        item.duid,
        item.method,
        item.params
      );
      if (result === "ok" || (Array.isArray(result) && result[0] === "ok")) {
        return true;
      }
      this.adapter.log.debug(
        `Scene "${run.name}" item ${index + 1} (${item.method}) answered ${JSON.stringify(result)}.`
      );
    } catch (error) {
      this.adapter.log.debug(
        `Scene "${run.name}" item ${index + 1} (${item.method}) failed: ${error && error.message}`
      );
    }

    return (
      (await this.adapter.pollStatus(item.duid)) &&
      !wasBusy &&
      this.isBusy(item.duid)
    );
  }

  // Resolves with null once the robot finished the item and the dock is done,
  // or with the reason the run has to stop.
  async waitForItem(run, duid) {
    const startedAt = Date.now();
    let seenBusy = false;

    for (;;) {
      await this.sleep(run, POLL_INTERVAL);
      if (run.cancelled) {
        return "it was cancelled";
      }

      // Without a fresh status (a failed or skipped poll) the stored one may
      // be the stale HomeData snapshot; only the time limits apply then.
      const fresh = await this.adapter.pollStatus(duid);
      if (run.cancelled) {
        return "it was cancelled";
      }

      if (fresh) {
        const errorCode = this.status(duid, "error_code");
        if (errorCode) {
          return `the robot reported error ${errorCode}`;
        }

        if (this.isBusy(duid)) {
          seenBusy = true;
        } else if (
          seenBusy &&
          DOCKED_STATES.includes(this.status(duid, "state"))
        ) {
          return null;
        }
      }

      const elapsed = Date.now() - startedAt;
      if (!seenBusy && elapsed > START_TIMEOUT) {
        return "the robot did not start it";
      }
      if (elapsed > ITEM_TIMEOUT) {
        return "it did not finish within 4 hours";
      }
    }
  }

  status(duid, field) {
    return Number(this.adapter.getVacuumDeviceStatus(duid, field)) || 0;
  }

  isBusy(duid) {
    const state = this.status(duid, "state");
    return (
      this.status(duid, "in_cleaning") > 0 ||
      this.adapter.isCleaning(state) ||
      DOCK_BUSY_STATES.includes(state)
    );
  }

  // Log the items a stopped run did not send, from index on.
  stop(run, index, reason) {
    const skipped = run.items
      .slice(index)
      .map((item, offset) => `${index + offset + 1} (${item.method})`);
    this.adapter.log.info(
      `Scene "${run.name}" stopped because ${reason}.` +
        (skipped.length ? ` Items not run: ${skipped.join(", ")}.` : "")
    );
  }

  sleep(run, ms) {
    return new Promise((resolve) => {
      run.wake = resolve;
      run.timer = this.adapter.setTimeout(resolve, ms);
    });
  }

  // Drop the remaining items of the run on this robot. The item the robot is
  // running is left to the caller (a stop or dock command).
  cancel(duid) {
    const run = this.runs.get(duid);
    if (!run) {
      return;
    }
    run.cancelled = true;
    this.adapter.clearTimeout(run.timer);
    if (run.wake) {
      run.wake();
    }
    this.finish(run);
  }

  cancelAll() {
    for (const duid of [...this.runs.keys()]) {
      this.cancel(duid);
    }
  }

  finish(run) {
    for (const [duid, entry] of this.runs) {
      if (entry === run) {
        this.runs.delete(duid);
      }
    }
  }
}

module.exports = {
  sceneRunner,
};
