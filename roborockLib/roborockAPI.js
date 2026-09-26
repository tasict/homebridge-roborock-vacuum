"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const crypto = require("crypto");

const roborockAuth = require("./lib/roborockAuth");

const rrLocalConnector = require("./lib/localConnector").localConnector;
const roborock_mqtt_connector =
  require("./lib/roborock_mqtt_connector").roborock_mqtt_connector;
const rrMessage = require("./lib/message").message;
const vacuum_class = require("./lib/vacuum").vacuum;
const deviceFeatures = require("./lib/deviceFeatures").deviceFeatures;
const messageQueueHandler =
  require("./lib/messageQueueHandler").messageQueueHandler;
const mqtt = require("mqtt");

// Schema ids of the status fields in spontaneous status broadcasts
// (python-roborock RoborockDataProtocol). src/platform.ts translates the
// same ids for the accessories.
const DPS_STATUS_FIELDS = {
  120: "error_code",
  121: "state",
  122: "battery",
  123: "fan_power",
  124: "water_box_mode",
  133: "charge_status",
};

function md5hex(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

// Dock types whose station cannot wash the mop: 0 = plain charging dock,
// 1 and 5 = auto-empty only. Every other dock code (2, 3, 6-40 and future
// generations) washes the mop, so the gate is membership in this small
// exception set rather than an ever-growing wash-capable list
// (see deviceFeatures.processDockType).
const NON_MOP_WASHING_DOCK_TYPES = [0, 1, 5];

// Bundled i18n catalogs, loaded statically so translation lookup never
// hands a computed path to the module loader.
const TRANSLATIONS = {
  de: require("./i18n/de/translations.json"),
  en: require("./i18n/en/translations.json"),
  es: require("./i18n/es/translations.json"),
  fr: require("./i18n/fr/translations.json"),
  it: require("./i18n/it/translations.json"),
  nl: require("./i18n/nl/translations.json"),
  pl: require("./i18n/pl/translations.json"),
  pt: require("./i18n/pt/translations.json"),
  ru: require("./i18n/ru/translations.json"),
  uk: require("./i18n/uk/translations.json"),
  "zh-cn": require("./i18n/zh-cn/translations.json"),
  "zh-tw": require("./i18n/zh-tw/translations.json"),
};

// Only languages with a bundled i18n catalog are accepted; anything else
// falls back to English.
function sanitizeLanguage(language) {
  if (
    typeof language === "string" &&
    Object.prototype.hasOwnProperty.call(TRANSLATIONS, language)
  ) {
    return language;
  }
  return "en";
}

class Roborock {
  constructor(options) {
    this.bInited = false;

    this.config = options;

    this.updateInterval = options.updateInterval || 180;
    this.log = options.log || console;
    this.language = sanitizeLanguage(options.language);

    this.localKeys = null;
    this.localL01Nonces = new Map();
    this.roomIDs = {};
    // current-room -> MQTT (opt-in telemetry): per-duid segment_id -> room name
    // cache, a lazily-opened local publisher client, and the last-published
    // dedupe key per duid. All inert unless config.currentRoomMqtt.enabled.
    this.segmentRoomNames = {};
    this.localMqttClient = null;
    this._lastRoomPublishKey = {};
    this.vacuums = {};
    this.initializedVacuumDuids = new Set();
    this.socket = null;

    this.states = {};

    // Parsed-once cache of the HomeData JSON string. Every hot path
    // (getRobotVersion, onlineChecker, device lookups) reads this instead of
    // re-JSON.parsing the whole document per call. Invalidated on write.
    this.homedataCache = null;

    this.idCounter = 0;
    this.nonce = crypto.randomBytes(16);

    this.localConnector = new rrLocalConnector(this);
    this.rr_mqtt_connector = new roborock_mqtt_connector(this);
    this.message = new rrMessage(this);

    this.messageQueueHandler = new messageQueueHandler(this);

    this.pendingRequests = new Map();

    // Throttle repeated transient errors (timeouts/retries) so the log
    // is not flooded when a device keeps failing the same request.
    this.transientErrorLog = new Map();
    this.transientErrorLogInterval = 10 * 60 * 1000; // 10 min

    // Response-driven polling: a device that never answers a given method is
    // treated as not supporting it, so optional polls back off instead of
    // timing out every cycle. Keyed by `${duid}:${method}`.
    this.methodTimeoutStreak = new Map();
    this.methodPollBackoff = new Map();
    this.methodBackoffThreshold = 3; // consecutive timeouts before backing off
    this.methodBackoffInterval = 30 * 60 * 1000; // 30 min before a retry

    // Some newer models (e.g. the Qrevo / roborock.vacuum.a185) keep the local TCP
    // connection open but never answer, so every local request times out. Track
    // consecutive local timeouts per device and, once over the threshold, prefer the
    // cloud path for a cooldown window (retrying local afterwards). Keyed by duid.
    this.localTimeoutStreak = new Map();
    this.localCloudPreference = new Map();
    this.localFailoverThreshold = 3; // consecutive local timeouts before preferring cloud
    this.localFailoverInterval = 5 * 60 * 1000; // 5 min preferring cloud before retrying local

    // The cloud MQTT session can stay connected while delivering nothing
    // (python-roborock's HealthManager restarts it for the same reason).
    // Consecutive cloud request timeouts with no MQTT traffic at all in
    // between restart the session; see recordCloudTimeout for what does not
    // count. Restarts back off exponentially until traffic resumes.
    this.cloudTimeoutStreak = 0;
    this.cloudRestartThreshold = 3; // silent cloud timeouts before a restart
    this.cloudRestartBaseCooldown = 30 * 60 * 1000; // 30 min after the first restart
    this.cloudRestartMaxCooldown = 6 * 60 * 60 * 1000; // backoff cap
    this.cloudRestartCount = 0; // restarts since MQTT traffic was last seen
    this.lastCloudRestart = null;

    // Live status reported by the device itself (get_status polls and status
    // broadcasts), keyed by duid, then by get_status field name:
    // { value, at }. getVacuumDeviceStatus prefers it over the HomeData
    // deviceStatus snapshot while fresh — see getLiveStatus.
    this.liveStatus = new Map();

    this.localDevices = {};
    this.remoteDevices = new Set();

    this.scenesData = null; // Store scenes data locally

    // Resolved Roborock home id. May start null on a cloud-failed (local-only)
    // startup; updateHomeData learns it once the cloud is reachable.
    this.homeId = null;

    this.name = "roborock";
    this.deviceNotify = null;
    this.baseURL = options.baseURL || "usiot.roborock.com";
    // Region discovered from the account email when no baseURL is
    // configured; carries the account's real country/countryCode for 2FA.
    this.accountRegion = null;

    this.userData = options.userData || null;
    this.authState = {
      twoFactorRequired: false,
      statusMessage: "",
    };
    this.pendingAuth = null;
    this.persistBasePath = null;
  }

  isInited() {
    return this.bInited;
  }

  setInterval(callback, interval, ...args) {
    return setInterval(() => callback(...args), interval);
  }

  clearInterval(interval) {
    clearInterval(interval);
  }

  setTimeout(callback, timeout, ...args) {
    return setTimeout(() => callback(...args), timeout);
  }

  clearTimeout(timeout) {
    clearTimeout(timeout);
  }

  // State ids that are mirrored to disk so they survive a restart: the cloud
  // session/client id, and the home data (device list + local keys), its
  // home id and the devices' last LAN addresses, which let the plugin start
  // over the LAN when the cloud is down.
  isPersistedStateId(id) {
    return (
      id == "UserData" ||
      id == "clientID" ||
      id == "HomeData" ||
      id == "HomeId" ||
      id == "LocalDevices"
    );
  }

  getStateAsync(id) {
    try {
      if (this.isPersistedStateId(id)) {
        const persistPath = this.getPersistPath(id);
        if (fs.existsSync(persistPath)) {
          return JSON.parse(fs.readFileSync(persistPath, "utf8"));
        }

        const legacyPath = this.getLegacyPersistPath(id);
        if (legacyPath && fs.existsSync(legacyPath)) {
          const legacyState = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
          this.tryMigrateLegacyStateFile(
            id,
            legacyState,
            legacyPath,
            persistPath
          );
          return legacyState;
        }

        // Fall back to the in-memory copy when nothing is on disk yet.
        return this.states[id] !== undefined ? this.states[id] : null;
      }

      return this.states[id];
    } catch (error) {
      if (error && error.code == "ENOENT") {
        return null;
      }
      this.log.error(`getStateAsync: ${error}`);
    }

    return null;
  }

  async setStateAsync(id, state) {
    try {
      if (this.isPersistedStateId(id)) {
        const persistPath = this.getPersistPath(id);
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        // 0600: UserData holds the cloud token/rriot secrets and HomeData
        // holds per-device localKey secrets.
        fs.writeFileSync(persistPath, JSON.stringify(state, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
      }

      this.states[id] = state;

      if (id == "HomeData") {
        this.homedataCache = null; // re-parsed lazily on next read
      }

      // Transport messages (CloudMessage/LocalMessage) notify directly from
      // the connectors so the device id can be passed along; only the
      // account-wide HomeData refresh notifies from here.
      if (this.deviceNotify && id == "HomeData") {
        this.deviceNotify(id, state);
      }
    } catch (error) {
      if (this.isPersistedStateId(id) && error && error.code == "EACCES") {
        try {
          const fallbackPath = path.join(
            this.forceTemporaryPersistPath(),
            `roborock.${id}`
          );
          fs.writeFileSync(fallbackPath, JSON.stringify(state, null, 2), {
            encoding: "utf8",
            mode: 0o600,
          });
          this.states[id] = state;
          this.log.warn(
            `Write access denied for persistent state. Saved '${id}' in temporary path '${fallbackPath}'.`
          );
          return;
        } catch (fallbackError) {
          this.log.error(`setStateAsync fallback failed: ${fallbackError}`);
        }
      }
      this.log.error(`setStateAsync: ${error}`);
    }
  }

  async deleteStateAsync(id) {
    try {
      // Only the session files are removed from disk. HomeData, HomeId and
      // LocalDevices are the offline cache and deliberately survive a failed
      // login; loadCachedHomeData rejects a cache from another account.
      if (id == "UserData" || id == "clientID") {
        const persistPath = this.getPersistPath(id);
        if (fs.existsSync(persistPath)) {
          fs.unlinkSync(persistPath);
        }

        const legacyPath = this.getLegacyPersistPath(id);
        if (
          legacyPath &&
          legacyPath !== persistPath &&
          fs.existsSync(legacyPath)
        ) {
          fs.unlinkSync(legacyPath);
        }
      }

      delete this.states[id];
    } catch (error) {
      this.log.error(`deleteStateAsync: ${error}`);
    }
  }

  // Parsed HomeData object (or null). Parses the stored JSON string at most
  // once per update instead of on every access.
  getParsedHomeData() {
    if (this.homedataCache) {
      return this.homedataCache;
    }

    const homedata = this.states["HomeData"];
    if (homedata && typeof homedata.val == "string") {
      try {
        this.homedataCache = JSON.parse(homedata.val);
      } catch (error) {
        this.log.error(`Failed to parse HomeData: ${error.message}`);
        this.homedataCache = null;
      }
    }

    return this.homedataCache;
  }

  // All devices from HomeData (owned + received/shared), never null.
  getAllHomeDevices() {
    const homedata = this.getParsedHomeData();
    if (!homedata) {
      return [];
    }

    return (homedata.devices || []).concat(homedata.receivedDevices || []);
  }

  getPersistPath(id) {
    const basePath = this.resolvePersistBasePath();
    return path.join(basePath, `roborock.${id}`);
  }

  resolvePersistBasePath() {
    if (this.persistBasePath) {
      return this.persistBasePath;
    }

    const candidates = [];
    if (this.config.storagePath) {
      candidates.push(this.config.storagePath);
    }
    candidates.push(path.resolve(__dirname, "./data"));
    candidates.push(path.join(os.tmpdir(), "homebridge-roborock-vacuum"));

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      try {
        const resolved = path.resolve(candidate);
        fs.mkdirSync(resolved, { recursive: true });
        fs.accessSync(resolved, fs.constants.W_OK);
        this.persistBasePath = resolved;
        return this.persistBasePath;
      } catch (error) {
        this.log.debug(
          `Persist path candidate '${candidate}' is not writable: ${error.message}`
        );
      }
    }

    return this.forceTemporaryPersistPath();
  }

  forceTemporaryPersistPath() {
    const emergencyPath = path.join(os.tmpdir(), "homebridge-roborock-vacuum");
    fs.mkdirSync(emergencyPath, { recursive: true });
    this.persistBasePath = emergencyPath;
    this.log.warn(`Using emergency temporary persist path '${emergencyPath}'.`);
    return this.persistBasePath;
  }

  getLegacyPersistPath(id) {
    if (this.config.storagePath) {
      return path.join(this.config.storagePath, `roborock.${id}`);
    }

    return path.resolve(__dirname, `./data/${id}`);
  }

  tryMigrateLegacyStateFile(id, state, legacyPath, persistPath) {
    if (!state || !legacyPath || !persistPath || legacyPath === persistPath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(persistPath, JSON.stringify(state, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      this.log.info(
        `Migrated legacy '${id}' state file from '${legacyPath}' to '${persistPath}'.`
      );
    } catch (error) {
      this.log.debug(
        `Failed to migrate legacy '${id}' state file: ${error.message}`
      );
    }
  }

  parseSkipDevices(value) {
    if (!value) {
      return [];
    }
    if (Array.isArray(value)) {
      return value.map((entry) => `${entry}`.trim()).filter((entry) => entry);
    }
    if (typeof value === "string") {
      return value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry);
    }
    return [];
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async startService(callback) {
    this.log.info(
      `Starting adapter. This might take a few minutes depending on your setup. Please wait.`
    );
    this.translations = TRANSLATIONS[this.language] || TRANSLATIONS.en;

    // create new clientID if it doesn't exist yet
    let clientID = "";
    try {
      const storedClientID = await this.getStateAsync("clientID");
      if (storedClientID) {
        clientID = storedClientID.val?.toString() ?? "";
      } else {
        clientID = crypto.randomUUID();
        await this.setStateAsync("clientID", { val: clientID, ack: true });
      }
    } catch (error) {
      this.log.error(
        `Error while retrieving or setting clientID: ${error.message}`
      );
    }

    if (!this.config.username) {
      this.log.error("Email is missing!");
      return;
    }
    if (!this.config.password && !this.isValidUserData(this.userData)) {
      this.log.error("Password or valid token is missing!");
      return;
    }

    this.instance = clientID;

    // Region auto-detection: without a configured baseURL, ask the cloud
    // which regional endpoint serves this account. An explicit baseURL in
    // the config always wins; on failure the previous default (US) is kept
    // so behavior never regresses.
    if (!this.config.baseURL) {
      const discovered = await roborockAuth.discoverAccountRegion(
        this.config.username,
        this.log
      );
      if (discovered) {
        this.accountRegion = discovered;
        this.baseURL = discovered.baseURL;
        this.log.info(`Roborock region auto-detected: ${discovered.baseURL}`);
      } else {
        this.log.warn(
          `Could not auto-detect the Roborock region for this account; using ${this.baseURL}. ` +
            `Set baseURL in the plugin config to pin a region.`
        );
      }
    }

    // Initialize the login API (which is needed to get access to the real API).
    this.loginApi = roborockAuth.createLoginApi({
      baseURL: this.baseURL,
      username: this.config.username,
      clientID,
      language: this.language,
    });
    await this.setStateAsync("info.connection", { val: true, ack: true });
    // api/v1/getUrlByEmail(email = ...)

    const userdata = await this.getUserData(this.loginApi);
    if (userdata) {
      this.setupCloudApi(userdata);
    } else {
      // No session (cloud unreachable, or 2FA pending): local control only
      // needs the cached local keys and IPs, so try the local-only start.
      // updateHomeData logs in again once the cloud answers.
      this.log.error(
        "Login failed or requires 2FA. Please complete authentication in the " +
          "Config UI. Trying to start in local-only mode from the cached " +
          "device list."
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
    }

    // Fetch home data (device list + local keys). The cloud is tried first; on
    // failure we fall back to the last cached copy so the plugin can still
    // control the vacuums over the LAN while the cloud is unreachable.
    let homeId = null;
    let homedataResult = null;
    let fromCache = false;

    if (userdata) {
      try {
        const fetched = await this.fetchHomeDataFromCloud();
        homeId = fetched.homeId;
        homedataResult = fetched.homedataResult;

        await this.setStateAsync(
          "HomeData",
          this.homeDataState(homedataResult)
        );
        if (homeId != null) {
          await this.setStateAsync("HomeId", { val: homeId, ack: true });
        }
      } catch (error) {
        this.log.error(
          "Failed to fetch home data from the Roborock cloud: " +
            (error && error.message ? error.message : error)
        );
      }
    }

    if (!homedataResult) {
      const cached = this.loadCachedHomeData();
      if (!cached) {
        this.log.error(
          "No cached device data is available, so the plugin cannot start " +
            "offline. It needs at least one successful online startup to cache " +
            "the device list and local keys. Staying idle until the Roborock " +
            "cloud is reachable."
        );
        await this.setStateAsync("info.connection", { val: false, ack: true });
        if (callback) {
          callback();
        }
        return;
      }

      homedataResult = cached.homedataResult;
      homeId = cached.homeId;
      fromCache = true;
      // The startup error above already said why; keep the periodic refresh
      // quiet until the cloud answers again.
      this.cloudUnreachable = true;

      // Publish the cached copy as the live home data. Everything
      // downstream - the device list, the protocol version used to frame
      // local messages, and every status read - goes through
      // getParsedHomeData, which reads this.states. Without this the plugin
      // would look like it owns no devices and would unregister every
      // cached accessory.
      await this.setStateAsync("HomeData", this.homeDataState(homedataResult));

      this.log.warn(
        "Roborock cloud is unreachable - starting in LOCAL-ONLY mode using " +
          "the last cached device list. Commands are sent over the LAN; " +
          "cloud features (scenes, push updates) resume automatically once " +
          "the cloud is reachable again."
      );
    }

    try {
      await this.initializeFromHomeData(
        userdata,
        homedataResult,
        homeId,
        fromCache
      );
    } catch (error) {
      this.log.error(
        "Failed to initialize devices from home data: " +
          (error && error.stack ? error.stack : error)
      );
    }

    if (callback) {
      callback();
    }
  }

  // Authorize the login API with the session token and build the Hawk-signed
  // device API. Runs at startup and again from updateHomeData when a
  // session-less (local-only) start logs in once the cloud is back.
  setupCloudApi(userdata) {
    this.userData = userdata;
    this.loginApi.defaults.headers.common["Authorization"] = userdata.token;
    const rriot = userdata.rriot;

    this.api = axios.create({
      baseURL: rriot.r.a,
      // Fail instead of hanging when the cloud black-holes connections;
      // otherwise the periodic refresh piles up requests every interval.
      timeout: 20000,
    });
    this.api.interceptors.request.use((config) => {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = crypto
          .randomBytes(6)
          .toString("base64")
          .substring(0, 6)
          .replace("+", "X")
          .replace("/", "Y");
        let url;
        if (this.api) {
          url = new URL(this.api.getUri(config));
          const prestr = [
            rriot.u,
            rriot.s,
            nonce,
            timestamp,
            md5hex(url.pathname),
            /*queryparams*/ "",
            /*body*/ "",
          ].join(":");
          const mac = crypto
            .createHmac("sha256", rriot.h)
            .update(prestr)
            .digest("base64");

          config.headers["Authorization"] =
            `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
        }
      } catch (error) {
        this.log.error("Failed to initialize API. Error: " + error);
      }
      return config;
    });
  }

  // Start (or restart) the cloud MQTT client for a session. Any previous
  // client is closed first so a re-login never leaves a second one
  // reconnecting in the background.
  async initCloudMqtt(userdata) {
    this.rr_mqtt_connector.disconnectClient();
    await this.rr_mqtt_connector.initUser(userdata);
    await this.rr_mqtt_connector.initMQTT_Subscribe();
    await this.rr_mqtt_connector.initMQTT_Message();
  }

  // Log in again after a session-less (local-only) start. Only network-level
  // login failures are retried; a rejected login or a pending 2FA is left for
  // the user. Returns true once the signed API and MQTT client are up.
  async reconnectCloud() {
    if (this.loginRetryable === false || !this.config.password) {
      return false;
    }

    try {
      const userdata = await this.getUserData(this.loginApi);
      if (!userdata) {
        return false;
      }

      this.setupCloudApi(userdata);
      await this.initCloudMqtt(userdata);
      this.log.info("Logged in to the Roborock cloud again.");
      return true;
    } catch (error) {
      this.log.debug(`Cloud re-login failed: ${error && error.message}`);
      return false;
    }
  }

  // Cloud failures repeat every refresh interval during an outage: log the
  // first at error level, the rest at debug, and announce the recovery once.
  logCloudFailure(message) {
    if (this.cloudUnreachable) {
      this.log.debug(message);
      return;
    }

    this.cloudUnreachable = true;
    this.log.error(
      `${message} Further failures are logged at debug level until the cloud answers again.`
    );
  }

  noteCloudReachable() {
    if (this.cloudUnreachable) {
      this.cloudUnreachable = false;
      this.log.info(
        "Roborock cloud is reachable again; resuming cloud features."
      );
    }
  }

  // True when the login API explicitly rejected the session. A degraded cloud
  // can answer 200 with an empty or non-JSON body; that is not a rejection,
  // and wiping the session on it would force a password login (possibly with
  // 2FA) on the next start.
  isSessionRejection(body) {
    return !!(body && typeof body.code === "number" && body.code !== 200);
  }

  // Ask the login API whether the current session is still accepted. Returns
  // true only on an explicit rejection; an unreachable cloud cannot tell.
  async isSessionRejected() {
    try {
      const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
      return this.isSessionRejection(homeDetail && homeDetail.data);
    } catch (error) {
      return false;
    }
  }

  // Fetch the account's home data from the cloud. Throws on any failure
  // (network, timeout, or an unusable response) so the caller can fall back to
  // the cached copy. Only an explicit rejection clears the cached session so
  // the next startup re-logs in.
  async fetchHomeDataFromCloud() {
    const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
    const body = homeDetail && homeDetail.data;
    if (!(body && body.data)) {
      if (this.isSessionRejection(body)) {
        this.log.warn(
          `The stored Roborock session was rejected (code ${body.code}: ${body.msg || "no message"}). ` +
            "Clearing it so the next startup re-authenticates."
        );
        this.userData = null;
        await this.deleteStateAsync("UserData");
        throw new Error(
          `getHomeDetail rejected the session (code ${body.code})`
        );
      }
      throw new Error("getHomeDetail returned no usable data");
    }

    const homeId = body.data.rrHomeId;

    if (!this.api) {
      throw new Error("Signed cloud API is not initialized");
    }

    const homedata = await this.api.get(`v2/user/homes/${homeId}`);
    const homedataResult = homedata && homedata.data && homedata.data.result;
    if (!homedataResult) {
      throw new Error("home data response was empty");
    }

    return { homeId, homedataResult };
  }

  // HomeData state as stored: tagged with the account it belongs to, so a
  // cache left behind by a previous account is never used for a local-only
  // start.
  homeDataState(homedataResult) {
    return {
      val: JSON.stringify(homedataResult),
      ack: true,
      account: this.config.username,
    };
  }

  // Load the last home data cached on disk (written on every successful cloud
  // fetch). Returns { homeId, homedataResult } or null when nothing is cached.
  loadCachedHomeData() {
    try {
      const cached = this.getStateAsync("HomeData");
      const raw = cached && typeof cached.val === "string" ? cached.val : null;
      if (!raw) {
        return null;
      }

      if (cached.account && cached.account !== this.config.username) {
        this.log.warn(
          `Ignoring cached device data: it belongs to ${cached.account}, not ${this.config.username}.`
        );
        return null;
      }

      const homedataResult = JSON.parse(raw);
      if (!homedataResult) {
        return null;
      }

      const cachedHomeId = this.getStateAsync("HomeId");
      const homeId =
        cachedHomeId && cachedHomeId.val != null ? cachedHomeId.val : null;

      return { homeId, homedataResult };
    } catch (error) {
      this.log.debug(
        `Failed to read cached home data: ${error && error.message}`
      );
      return null;
    }
  }

  // Last known LAN address per device, so a local-only start can dial the
  // vacuums even when UDP discovery finds nothing (other VLAN, port 58866
  // taken by another integration) and get_network_info needs the cloud.
  loadCachedLocalDevices() {
    const cached = this.getStateAsync("LocalDevices");
    return cached && cached.val && typeof cached.val === "object"
      ? cached.val
      : {};
  }

  persistLocalDevices() {
    if (Object.keys(this.localDevices).length === 0) {
      return; // never replace a useful cache with nothing
    }

    return this.setStateAsync("LocalDevices", {
      val: this.localDevices,
      ack: true,
    });
  }

  // Build the device list, local keys, MQTT/local connections and polling from
  // home data - shared by the online path (fresh cloud data) and the
  // local-only path (cached data). The cloud MQTT client and the home-data
  // refresh interval are set up in both cases so cloud features recover on
  // their own once the cloud is reachable again.
  async initializeFromHomeData(userdata, homedataResult, homeId, fromCache) {
    if (homeId != null) {
      this.homeId = homeId;
    }

    // skip devices whose serial number or device ID is in ignoredDevices or skipDevices
    const ignoredDevices = this.config.ignoredDevices || [];
    const skipDevices = this.parseSkipDevices(this.config.skipDevices);
    const ignoredSet = new Set([...ignoredDevices, ...skipDevices]);
    // create devices and set states
    this.products = homedataResult.products;
    this.devices = homedataResult.devices || [];
    this.devices = this.devices.filter(
      (device) => !ignoredSet.has(device.sn) && !ignoredSet.has(device.duid)
    );
    this.receivedDevices = (homedataResult.receivedDevices || []).filter(
      (device) => !ignoredSet.has(device.sn) && !ignoredSet.has(device.duid)
    );

    const allManagedDevices = (homedataResult.devices || []).concat(
      homedataResult.receivedDevices || []
    );
    const localKeyDevices = [];
    for (const device of allManagedDevices) {
      if (!device || !device.duid) {
        continue;
      }

      if (
        (device.sn && ignoredSet.has(device.sn)) ||
        (device.duid && ignoredSet.has(device.duid))
      ) {
        continue;
      }

      if (!device.localKey) {
        this.log.warn(
          `Device ${device.duid} (product ${device.productId || "unknown"}) has no localKey in home data and cannot be controlled. Fields returned by the API: ${Object.keys(device).join(", ")}`
        );
        continue;
      }

      localKeyDevices.push(device);
    }

    this.localKeys = new Map(
      localKeyDevices.map((device) => [device.duid, device.localKey])
    );

    // The cloud MQTT client is initialised from the (cached) session even in
    // local-only mode: it keeps retrying in the background, so the cloud path
    // and push updates recover on their own once the broker is reachable.
    // Without a session, reconnectCloud brings it up after the re-login.
    if (userdata) {
      await this.initCloudMqtt(userdata);
    }

    // store name of each room via ID
    const rooms = homedataResult.rooms;
    for (const room in rooms) {
      const roomID = rooms[room].id;
      const roomName = rooms[room].name;

      this.roomIDs[roomID] = roomName;
    }

    await this.loadSharedDeviceRooms();
    this.log.debug(`RoomIDs debug: ${JSON.stringify(this.roomIDs)}`);

    // reconnect every 3 hours (10800 seconds)
    this.reconnectIntervall = this.setInterval(async () => {
      this.log.debug(`Reconnecting after 3 hours!`);

      await this.rr_mqtt_connector.reconnectClient();
    }, 10800 * 1000);

    // Periodic home-data refresh. It also drives cloud recovery: on a
    // local-only start (no homeId yet) updateHomeData learns it via
    // getHomeDetail before refreshing.
    this.homedataInterval = this.setInterval(
      () => this.updateHomeData(this.homeId),
      this.updateInterval * 1000
    );
    // A fresh online start pulls once more to load scenes and reconcile
    // intervals. In local-only mode the cloud is down, so defer to the interval
    // instead of blocking startup on a call that will fail.
    if (!fromCache) {
      await this.updateHomeData(this.homeId);
    }

    const discoveredDevices = await this.localConnector.getLocalDevices();

    await this.createDevices();
    await this.getNetworkInfo();

    // merge udp discovered devices with local devices found via mqtt
    Object.entries(discoveredDevices).forEach(([duid, ip]) => {
      if (!Object.prototype.hasOwnProperty.call(this.localDevices, duid)) {
        this.localDevices[duid] = ip;
      }
    });

    // Devices that answered neither the UDP broadcast nor (cloud down) the
    // get_network_info request: dial the address they had last time. A stale
    // one just fails to connect and goes through the usual reconnect loop.
    for (const [duid, ip] of Object.entries(this.loadCachedLocalDevices())) {
      if (!this.localDevices[duid] && this.localKeys.has(duid)) {
        this.localDevices[duid] = ip;
      }
    }
    await this.persistLocalDevices();
    this.log.debug(`localDevices: ${JSON.stringify(this.localDevices)}`);

    for (const device in this.localDevices) {
      const duid = device;
      const ip = this.localDevices[device];

      await this.localConnector.createClient(duid, ip);
    }

    await this.initializeDeviceUpdates();
    this.bInited = true;
    this.log.info(
      fromCache
        ? "Starting adapter finished in local-only mode (cloud unreachable)."
        : "Starting adapter finished. Lets go!!!!!!!"
    );
  }

  async stopService() {
    try {
      await this.clearTimersAndIntervals();
      this.bInited = false;
    } catch (e) {
      this.catchError(e.stack);
    }
  }

  async getUserData(loginApi) {
    try {
      if (this.isValidUserData(this.userData)) {
        this.log.info("Using session from config.");
        return this.userData;
      }

      const cachedState = await this.getStateAsync("UserData");
      if (cachedState && cachedState.val) {
        try {
          const cached = JSON.parse(cachedState.val);
          if (this.isValidUserData(cached)) {
            this.userData = cached;
            this.log.info("Using cached session from disk.");
            return cached;
          }
        } catch (error) {
          this.log.warn("Cached session is invalid and will be ignored.");
        }
      }

      if (!this.config.password) {
        this.log.error("Password is missing and no valid token is available.");
        this.loginRetryable = false;
        return null;
      }

      const signData = await this.ensureAuthSignature();
      if (!signData) {
        throw new Error("Failed to obtain login signature.");
      }

      const loginResult = await roborockAuth.loginByPassword(loginApi, {
        email: this.config.username,
        password: this.config.password,
        country: this.getLoginRegion().country,
        k: signData.k,
        s: signData.s,
      });

      if (loginResult && loginResult.code === 200 && loginResult.data) {
        this.userData = loginResult.data;
        this.pendingAuth = null;
        await this.setStateAsync("UserData", {
          val: JSON.stringify(this.userData),
          ack: true,
        });
        this.authState.twoFactorRequired = false;
        this.authState.statusMessage = "";
        return this.userData;
      }

      if (loginResult && loginResult.code === 2031) {
        this.authState.twoFactorRequired = true;
        this.authState.statusMessage = "Two-factor authentication required.";
        this.loginRetryable = false;
        this.log.error(
          "Two-factor authentication required. Use the Config UI to continue."
        );
        return null;
      }

      throw new Error(`Login failed: ${JSON.stringify(loginResult)}`);
    } catch (error) {
      // Failed logins (bad credentials, unreachable cloud) are expected
      // runtime conditions — report "no user data" so startService aborts
      // gracefully instead of crashing Homebridge with an unhandled
      // rejection. Only a network-level failure (no HTTP answer, or a server
      // error) may be retried automatically by reconnectCloud; a rejected
      // login must never be repeated every interval.
      this.loginRetryable = !!(
        error &&
        error.isAxiosError &&
        (!error.response || error.response.status >= 500)
      );
      if (this.loginRetryable) {
        // Repeats every refresh interval while the cloud is down.
        this.logCloudFailure(`Error in getUserData: ${error.message}.`);
      } else {
        this.log.error(`Error in getUserData: ${error.message}`);
      }
      await this.deleteStateAsync("HomeData");
      await this.deleteStateAsync("UserData");
      return null;
    }
  }

  isValidUserData(userdata) {
    return userdata && userdata.token && userdata.rriot;
  }

  async ensureAuthSignature() {
    if (this.pendingAuth && this.pendingAuth.k && this.pendingAuth.s) {
      return this.pendingAuth;
    }

    if (!this.loginApi) {
      throw new Error("Login API is not initialized.");
    }

    const s = crypto
      .randomBytes(12)
      .toString("base64")
      .substring(0, 16)
      .replace(/\+/g, "X")
      .replace(/\//g, "Y");
    const signData = await roborockAuth.signRequest(this.loginApi, s);
    if (!signData || !signData.k) {
      return null;
    }

    this.pendingAuth = { k: signData.k, s };
    return this.pendingAuth;
  }

  async sendTwoFactorEmail() {
    if (!this.loginApi) {
      throw new Error("Login API is not initialized.");
    }

    try {
      await roborockAuth.requestEmailCode(this.loginApi, this.config.username);
    } catch (error) {
      this.log.error(`2FA email request failed: ${error.message}`);
      throw error;
    }
    this.authState.twoFactorRequired = true;
    this.authState.statusMessage = "Verification email sent.";
    return { ok: true };
  }

  // Country and country code sent with a login. The discovered region carries
  // the account's real ones; the host-based mapping is only a guess (e.g.
  // every euiot account maps to DE/49) and stays as the fallback.
  getLoginRegion() {
    const guess = roborockAuth.getRegionConfig(this.baseURL);
    return {
      country:
        (this.accountRegion && this.accountRegion.country) || guess.country,
      countryCode:
        (this.accountRegion && this.accountRegion.countryCode) ||
        guess.countryCode,
    };
  }

  async verifyTwoFactorCode(code) {
    if (!this.loginApi) {
      throw new Error("Login API is not initialized.");
    }

    const signData = await this.ensureAuthSignature();
    if (!signData) {
      throw new Error("Missing login signature.");
    }

    const region = this.getLoginRegion();
    const loginResult = await roborockAuth.loginWithCode(this.loginApi, {
      email: this.config.username,
      code,
      country: region.country,
      countryCode: region.countryCode,
      k: signData.k,
      s: signData.s,
    });

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      this.userData = loginResult.data;
      this.pendingAuth = null;
      await this.setStateAsync("UserData", {
        val: JSON.stringify(this.userData),
        ack: true,
      });
      this.authState.twoFactorRequired = false;
      this.authState.statusMessage = "Two-factor authentication completed.";
      return this.userData;
    }

    this.log.error(`2FA verification failed: ${JSON.stringify(loginResult)}`);
    throw new Error(
      `2FA verification failed: ${loginResult?.msg || "Unknown error"}`
    );
  }

  async getNetworkInfo() {
    for (const device of this.devices) {
      const duid = device.duid;
      if (!this.hasInitializedVacuum(duid)) {
        continue;
      }

      await this.vacuums[duid].getParameter(duid, "get_network_info");
    }
  }

  async createDevices() {
    const devices = this.devices;
    this.initializedVacuumDuids.clear();

    for (const device of devices) {
      const duid = device.duid;
      const name = device.name;

      this.log.debug(`Creating device: ${name} with duid: ${duid}`);

      const robotModel = this.getProductAttribute(duid, "model");

      // model must start with "roborock.vacuum."
      if (!this.isSupportedVacuumModel(robotModel)) {
        this.log.warn(
          `Unsupported vacuum model '${robotModel || "unknown"}' for device ${duid}; skipping initialization.`
        );
        continue;
      }

      this.vacuums[duid] = new vacuum_class(this, robotModel);
      this.initializedVacuumDuids.add(duid);
      this.vacuums[duid].name = name;
      this.vacuums[duid].features = new deviceFeatures(
        this,
        device.featureSet,
        device.newFeatureSet,
        duid
      );

      await this.vacuums[duid].features.processSupportedFeatures();
    }
  }

  async initializeDeviceUpdates() {
    this.log.debug(`initializeDeviceUpdates`);

    const devices = this.devices;

    for (const device of devices) {
      const duid = device.duid;
      if (!this.hasInitializedVacuum(duid)) {
        continue;
      }

      const robotModel = this.getProductAttribute(duid, "model");

      // onlineChecker also reports a locally connected device as reachable, so
      // polling still runs for LAN-reachable devices during a cloud outage.
      if (await this.onlineChecker(duid)) {
        this.log.debug(`${duid} reachable. Starting update intervals.`);
        this.startDeviceIntervals(duid);
      }

      await this.updateDataExtraData(duid, this.vacuums[duid]);
      await this.updateDataMinimumData(duid, this.vacuums[duid], robotModel);
    }
  }

  // Start the per-device polling intervals, keeping the real timer handles so
  // they can actually be cleared again. Idempotent: an already-running
  // interval is never duplicated (the previous implementation stored factory
  // functions instead of handles, so intervals could neither be stopped nor
  // deduplicated and stacked up on every online transition).
  startDeviceIntervals(duid) {
    if (!this.hasInitializedVacuum(duid)) {
      return;
    }

    const vacuum = this.vacuums[duid];
    const robotModel = this.getProductAttribute(duid, "model");

    if (!vacuum.mainUpdateIntervalHandle) {
      vacuum.mainUpdateIntervalHandle = this.setInterval(
        this.updateDataMinimumData.bind(this),
        this.updateInterval * 1000,
        duid,
        vacuum,
        robotModel
      );
    }

    // The 1 Hz status tick only serves the opt-in current-room MQTT
    // telemetry (its own seconds-based gating lives in vacuum.getParameter).
    // Without that feature the interval would fire 86400 no-ops per device
    // per day, so it is not created at all.
    const roomMqttEnabled = !!(
      this.config.currentRoomMqtt && this.config.currentRoomMqtt.enabled
    );
    if (roomMqttEnabled && !vacuum.getStatusIntervalHandle) {
      vacuum.getStatusIntervalHandle = this.setInterval(
        this.getStatus.bind(this),
        1000,
        duid
      );
    }
  }

  stopDeviceIntervals(duid) {
    const vacuum = this.vacuums[duid];
    if (!vacuum) {
      return;
    }

    if (vacuum.mainUpdateIntervalHandle) {
      this.clearInterval(vacuum.mainUpdateIntervalHandle);
      vacuum.mainUpdateIntervalHandle = null;
    }

    if (vacuum.getStatusIntervalHandle) {
      this.clearInterval(vacuum.getStatusIntervalHandle);
      vacuum.getStatusIntervalHandle = null;
    }
  }

  async executeScene(sceneID) {
    if (this.api) {
      try {
        await this.api.post(`user/scene/${sceneID.val}/execute`);
      } catch (error) {
        if (!(await this.handleApiUnauthorized(error, "executeScene"))) {
          this.catchError(error.stack, "executeScene");
        }
      }
    }
  }

  /**
   * Get the home ID from the login API
   * @returns {Promise<string>} The home ID
   */
  async getHomeID() {
    if (!this.loginApi) {
      throw new Error("loginApi is not initialized. Call init() first.");
    }

    if (this.homeId != null) {
      return this.homeId; // resolved at startup; no cloud round trip needed
    }

    try {
      const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
      if (homeDetail && homeDetail.data && homeDetail.data.data) {
        return homeDetail.data.data.rrHomeId;
      }
      throw new Error("Failed to get home ID from homeDetail response");
    } catch (error) {
      this.log.error(`Failed to get home ID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get scenes from the Roborock API
   * @returns {Promise<Object>} The scenes data
   */
  async getScenes() {
    if (!this.loginApi) {
      throw new Error("loginApi is not initialized. Call init() first.");
    }
    if (!this.api) {
      throw new Error("api is not initialized. Call initializeRealApi() first");
    }

    try {
      const homeId = await this.getHomeID();
      const response = await this.api.get(`user/scene/home/${homeId}`);

      // Store scenes data locally
      this.scenesData = response.data;

      return response.data;
    } catch (error) {
      if (!(await this.handleApiUnauthorized(error, "getScenes"))) {
        this.log.error(`Failed to get scenes: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get scenes for a specific device by duid
   * @param {string} duid - The device unique identifier
   * @returns {Array} Array of scenes for the specified device
   */
  getScenesForDevice(duid) {
    // If duid provided, filter scenes for that device
    if (!this.scenesData || !this.scenesData.result) {
      this.log.warn(`No scenes data available. Call getScenes() first.`);
      return [];
    }

    try {
      const deviceScenes = [];

      for (const scene of this.scenesData.result) {
        if (scene.param) {
          try {
            const param = JSON.parse(scene.param);
            if (param.action && param.action.items) {
              // Check if any item in the scene has the matching entityId (duid)
              const hasMatchingDevice = param.action.items.some(
                (item) => item.entityId === duid
              );

              if (hasMatchingDevice) {
                deviceScenes.push({
                  id: scene.id,
                  name: scene.name,
                  enabled: scene.enabled,
                  type: scene.type,
                  param: scene.param,
                });
              }
            }
          } catch (parseError) {
            this.log.warn(
              `Failed to parse scene param for scene ${scene.id}: ${parseError.message}`
            );
          }
        }
      }

      this.log.debug(`Found ${deviceScenes.length} scenes for device ${duid}`);
      return deviceScenes;
    } catch (error) {
      this.log.error(
        `Failed to filter scenes for device ${duid}: ${error.message}`
      );
      return [];
    }
  }

  getProductAttribute(duid, attribute) {
    // Owned devices live in this.devices; shared devices in this.receivedDevices.
    // Fall back to the HomeData cache when startService has not populated the
    // device lists yet, so early accessory reads cannot throw.
    const device =
      (this.devices || []).find((device) => device.duid == duid) ||
      (this.receivedDevices || []).find((device) => device.duid == duid) ||
      this.getVacuumDeviceData(duid);

    if (!device) {
      this.log.warn(
        `getProductAttribute: no device found for duid ${duid}, returning null for "${attribute}".`
      );
      return null;
    }

    const products = this.products || this.getParsedHomeData()?.products || [];
    const product = products.find((product) => product.id == device.productId);

    return product ? product[attribute] : null;
  }

  // Whether the per-device local TCP client is currently connected.
  isLocallyConnected(duid) {
    try {
      return !!(
        this.localConnector &&
        typeof this.localConnector.isConnected === "function" &&
        this.localConnector.isConnected(duid)
      );
    } catch (error) {
      return false;
    }
  }

  async onlineChecker(duid) {
    // A device we hold a live local connection to is reachable regardless of
    // the cached cloud online flag, which is stale (and may be false) while the
    // cloud is unreachable. Trusting the live socket is what keeps local
    // commands from being rejected during a cloud outage.
    if (this.isLocallyConnected(duid)) {
      return true;
    }

    const homedata = this.getParsedHomeData();
    if (!homedata) {
      return false;
    }

    const device = (homedata.devices || []).find(
      (device) => device.duid == duid
    );
    const receivedDevice = (homedata.receivedDevices || []).find(
      (device) => device.duid == duid
    );

    // If the device is not found, return false.
    if (!device && !receivedDevice) {
      return false;
    }

    return device?.online || receivedDevice?.online;
  }

  async isRemoteDevice(duid) {
    const homedata = this.getParsedHomeData();
    if (!homedata) {
      return false;
    }

    const receivedDevice = (homedata.receivedDevices || []).find(
      (device) => device.duid == duid
    );

    return !!receivedDevice || this.remoteDevices.has(duid);
  }

  // Rooms of a device shared from another account are not part of this
  // account's home data, so their segment ids would never resolve to names.
  // Query them per shared device and merge into roomIDs. Room entries carry
  // their id as either `id` or `roomId` depending on the backend.
  async loadSharedDeviceRooms() {
    if (!this.api) {
      return; // session-less local-only start: shared devices are cloud-only
    }

    for (const device of this.receivedDevices || []) {
      try {
        const response = await this.api.get(
          `user/deviceshare/query/${device.duid}/rooms`
        );
        const rooms = response?.data?.result;
        if (!Array.isArray(rooms)) {
          continue;
        }

        for (const room of rooms) {
          const roomID = room.id !== undefined ? room.id : room.roomId;
          if (roomID !== undefined && room.name) {
            this.roomIDs[roomID] = room.name;
          }
        }
      } catch (error) {
        this.log.warn(
          `Failed to load rooms for shared device ${device.duid}: ${error && error.message}`
        );
      }
    }
  }

  // A device shared from another account (receivedDevices) can never use the
  // local connection. Unlike isRemoteDevice, this excludes remoteDevices
  // membership, which is only a temporary TCP-failure fallback.
  isSharedDevice(duid) {
    const homedata = this.getParsedHomeData();
    const received = this.receivedDevices || homedata?.receivedDevices || [];

    return received.some((device) => device.duid == duid);
  }

  async manageDeviceIntervals(duid) {
    if (!this.hasInitializedVacuum(duid)) {
      return false;
    }

    return this.onlineChecker(duid)
      .then((onlineState) => {
        if (!onlineState) {
          this.stopDeviceIntervals(duid);
        } else {
          this.startDeviceIntervals(duid); // idempotent, never stacks
        }
        return onlineState;
      })
      .catch((error) => {
        this.log.error("startStopIntervals " + error);

        return false; // Make device appear as offline on error. Just in case.
      });
  }

  isSupportedVacuumModel(model) {
    return typeof model === "string" && model.startsWith("roborock.vacuum.");
  }

  hasInitializedVacuum(duid) {
    return this.initializedVacuumDuids.has(duid) && !!this.vacuums[duid];
  }

  async updateDataMinimumData(duid, vacuum, robotModel) {
    this.log.debug(`Latest data requested`);

    if (this.isSupportedVacuumModel(robotModel)) {
      await this.pollStatus(duid);

      await vacuum.getParameter(duid, "get_room_mapping");

      await vacuum.getParameter(duid, "get_consumable");

      switch (robotModel) {
        case "roborock.vacuum.s4":
        case "roborock.vacuum.s5":
        case "roborock.vacuum.s5e":
        case "roborock.vacuum.a08":
        case "roborock.vacuum.a10":
        case "roborock.vacuum.a40":
        case "roborock.vacuum.a140":
        case "roborock.vacuum.a95":
        case "roborock.vacuum.a159":
        case "roborock.vacuum.ss07":
          //do nothing
          break;
        case "roborock.vacuum.s6":
          await this.pollOptional(duid, vacuum, "get_carpet_mode");
          break;
        case "roborock.vacuum.a27":
          await this.pollOptional(
            duid,
            vacuum,
            "get_dust_collection_switch_status"
          );
          await this.pollOptional(duid, vacuum, "get_wash_towel_mode");
          await this.pollOptional(duid, vacuum, "get_smart_wash_params");
          await this.pollOptional(duid, vacuum, "app_get_dryer_setting");
          break;
        default:
          await this.pollOptional(duid, vacuum, "get_carpet_mode");
          await this.pollOptional(duid, vacuum, "get_carpet_clean_mode");
          await this.pollOptional(duid, vacuum, "get_water_box_custom_mode");
      }
    } else {
      this.log.warn(
        `Unsupported model '${robotModel || "unknown"}'. Skipping minimum data update for ${duid}.`
      );
    }
  }

  async updateDataExtraData(duid, vacuum) {
    try {
      await this.pollOptional(duid, vacuum, "get_fw_features");
    } catch (error) {
      this.log.error(
        `Failed to get extra data for ${vacuum}: ${error.message}`
      );
    }
  }

  clearTimersAndIntervals() {
    if (this.reconnectIntervall) {
      this.clearInterval(this.reconnectIntervall);
    }
    if (this.homedataInterval) {
      this.clearInterval(this.homedataInterval);
    }

    this.localConnector.shutdown();
    this.rr_mqtt_connector.disconnectClient();

    for (const duid in this.vacuums) {
      this.stopDeviceIntervals(duid);
    }

    // current-room -> MQTT: tear down the local publisher client.
    if (this.localMqttClient) {
      try {
        this.localMqttClient.end(true);
      } catch (e) {
        /* ignore */
      }
      this.localMqttClient = null;
    }

    // In-flight request timeouts (10 s each) must not outlive the service.
    for (const { timeout } of this.pendingRequests.values()) {
      this.clearTimeout(timeout);
    }
    this.pendingRequests.clear();
  }

  async updateHomeData(homeId) {
    // Cloud recovery for a session-less (local-only) start: nothing
    // cloud-side works until a login succeeds, so retry that first.
    if (!this.api && !(await this.reconnectCloud())) {
      return;
    }

    if (homeId == null) {
      homeId = this.homeId;
    }

    // Cloud recovery: a local-only start may have no home id yet. Learn it
    // from getHomeDetail before refreshing, so cloud features resume without
    // a Homebridge restart. While the cloud is still down this just retries
    // on the next tick.
    if (homeId == null) {
      try {
        const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
        homeId =
          homeDetail && homeDetail.data && homeDetail.data.data
            ? homeDetail.data.data.rrHomeId
            : null;
      } catch (error) {
        this.log.debug(
          `Home id still unavailable (cloud likely still down): ${error && error.message}`
        );
        return;
      }

      if (homeId == null) {
        return;
      }

      this.homeId = homeId;
      await this.setStateAsync("HomeId", { val: homeId, ack: true });
    }

    this.log.debug(`Updating HomeData with homeId: ${homeId}`);
    try {
      const home = await this.api.get(`user/homes/${homeId}`);
      const homedata = home.data.result;

      if (homedata) {
        await this.setStateAsync("HomeData", this.homeDataState(homedata));
        this.log.debug(`homedata successfully updated`);
        this.noteCloudReachable();

        await this.getScenes();

        // Fresh online flags just arrived: stop polling devices that went
        // offline and resume devices that came back (both idempotent).
        for (const duid of this.initializedVacuumDuids) {
          await this.manageDeviceIntervals(duid);
        }
      } else {
        this.log.warn("homedata failed to download");
      }
    } catch (error) {
      if (!(await this.handleApiUnauthorized(error, "updateHomeData"))) {
        this.logCloudFailure(
          `Failed to update updateHomeData with error: ${error}.`
        );
      }
    }
  }

  /**
   * Shared 401 handling for the Hawk-signed cloud API. Two distinct causes:
   * - Host clock skew: the Hawk signature embeds a local timestamp, so NTP
   *   drift (common on NAS hosts) invalidates every request. Detected via the
   *   server Date header; self-heals once the clock is fixed, so polling
   *   continues and only a clear hint is logged.
   * - Invalidated session (password change, session revoked): retrying forever
   *   just loops the same error, so the cached session is cleared and the
   *   HomeData polling stops until the user re-authenticates.
   * Returns true when the error was a 401 and has been handled here.
   */
  async handleApiUnauthorized(error, context) {
    if (!error || !error.response || error.response.status !== 401) {
      return false;
    }

    const serverDate = error.response.headers?.date;
    if (serverDate) {
      const skewSeconds = Math.round(
        (new Date(serverDate).getTime() - Date.now()) / 1000
      );
      if (Number.isFinite(skewSeconds) && Math.abs(skewSeconds) > 60) {
        // Skew 401s hit every signed request; log the hint at most every 10 min.
        const now = Date.now();
        if (
          !this.lastClockSkewWarning ||
          now - this.lastClockSkewWarning > 10 * 60 * 1000
        ) {
          this.lastClockSkewWarning = now;
          this.log.error(
            `Roborock API rejected the request (401) in ${context}, and this host's clock is off by ${skewSeconds} seconds from the server. ` +
              `Fix the system time (enable NTP) — the API request signature embeds a timestamp, so large clock skew invalidates every request.`
          );
        }
        return true;
      }
    }

    if (this.sessionInvalidated) {
      return true;
    }

    // A 401 from the signed API normally means a revoked session, but a
    // degraded cloud can produce one too. Ask the login API before throwing
    // the session away; while it still accepts the token (or cannot be
    // reached) the request simply retries on the next interval.
    if (!(await this.isSessionRejected())) {
      this.logCloudFailure(
        `Roborock API rejected the request (401) in ${context}, but the login API still accepts the session. Keeping it and retrying later.`
      );
      return true;
    }
    this.sessionInvalidated = true;

    this.log.warn(
      `Roborock API rejected the session (401) in ${context}. ` +
        `Clearing the cached session — please re-authenticate in the plugin settings and restart Homebridge.`
    );

    this.userData = null;
    this.deleteStateAsync("UserData");

    if (this.homedataInterval) {
      this.clearInterval(this.homedataInterval);
      this.homedataInterval = undefined;
    }

    return true;
  }

  async startCommand(duid, command, parameters) {
    if (!this.isInited()) {
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    // Shared (received) devices get an accessory but no vacuum instance, so
    // an unguarded lookup would throw on the first command sent to them.
    if (!this.vacuums[duid]) {
      this.log.warn(`${command}: unknown device ${duid}.`);
      return;
    }

    switch (command) {
      case "app_zoned_clean":
      case "app_goto_target":
      case "app_start":
      case "app_stop":
      case "stop_zoned_clean":
      case "app_pause":
      case "app_charge":
        this.vacuums[duid].command(duid, command, parameters);
        break;

      default:
        this.log.warn(`Command ${command} not found.`);
    }
  }

  // Single source of truth for "the cleaning session is running" — the HAP
  // and Matter accessories must not keep their own diverging copies of this
  // table, or push and poll updates flap the same characteristic.
  // State names follow python-roborock's RoborockStateCode, the maintained
  // reference for codes newer models report (25, 33/34, and the 63xx
  // mopping family used by B01/Q10-generation devices).
  isCleaning(state) {
    switch (state) {
      case 4: // Remote Control
      case 5: // Cleaning
      case 6: // Returning Dock
      case 7: // Manual Mode
      case 11: // Spot Cleaning
      case 15: // Docking
      case 16: // Go To
      case 17: // Zone Clean
      case 18: // Room Clean
      case 23: // Washing the mop (mid-run dock stop; the session continues)
      case 25: // Washing the mop (alias reported by the Q7 Max family)
      case 26: // Going to wash the mop
      case 33: // Attaching the mop (mid-run, e.g. G20S Ultra)
      case 34: // Detaching the mop (mid-run, e.g. G20S Ultra)
      case 6301: // Mopping
      case 6302: // Clean+mop, vacuum phase
      case 6303: // Clean+mop, mop phase
      case 6304: // Segment mopping
      case 6305: // Segment clean+mop, vacuum phase
      case 6306: // Segment clean+mop, mop phase
      case 6307: // Zoned mopping
      case 6308: // Zoned clean+mop, vacuum phase
      case 6309: // Zoned clean+mop, mop phase
      case 6310: // Back at dock washing the duster (session continues)
        return true;
      default:
        return false;
    }
  }

  // current-room -> MQTT: lazily open a LOCAL mqtt publisher (separate from the
  // Roborock cloud connection). Telemetry only — it never subscribes. Never
  // throws; a down broker only logs at debug and retries via reconnectPeriod.
  ensureLocalMqtt() {
    const cfg = this.config && this.config.currentRoomMqtt;
    if (!cfg || !cfg.enabled) return null;
    if (this.localMqttClient) return this.localMqttClient;

    try {
      const url = cfg.brokerUrl || "mqtt://127.0.0.1:1883";
      const client = mqtt.connect(url, {
        reconnectPeriod: 5000,
        connectTimeout: 10000,
      });
      client.on("error", (e) =>
        this.log.debug(`current_room MQTT error: ${e && e.message}`)
      );
      client.on("connect", () =>
        this.log.debug(`current_room MQTT connected to ${url}`)
      );
      // After a reconnect, drop the dedupe cache so the (retained) current room
      // is re-published — a broker bounce may have lost the retained message.
      client.on("reconnect", () => {
        this._lastRoomPublishKey = {};
      });
      this.localMqttClient = client;
    } catch (e) {
      this.log.debug(`current_room MQTT connect failed: ${e && e.message}`);
      this.localMqttClient = null;
    }
    return this.localMqttClient;
  }

  // current-room -> MQTT: resolve the publish topic for a device. The configured
  // topic is a template: {duid} and {name} tokens are substituted; if it contains
  // no token, /{duid} is appended so multiple vacuums never collide on one topic.
  resolveRoomTopic(duid) {
    const cfg = this.config && this.config.currentRoomMqtt;
    let topic = (cfg && cfg.topic) || "homebridge/roborock/{duid}/current_room";
    const hasToken = topic.includes("{duid}") || topic.includes("{name}");
    if (!hasToken) {
      topic = `${topic.replace(/\/+$/, "")}/${duid}`;
    }
    const rawName = (this.vacuums[duid] && this.vacuums[duid].name) || duid;
    const slug = String(rawName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    // Fall back to duid if the name slugifies to empty (e.g. a symbol-only name),
    // so a {name}-only template can never collide or produce a malformed topic.
    const name = slug || duid;
    return topic.replace(/\{duid\}/g, duid).replace(/\{name\}/g, name);
  }

  // current-room -> MQTT: publish the room a vacuum is currently cleaning.
  // segment_id comes from get_status.cleaning_info; the name is resolved from the
  // segmentRoomNames cache (populated by the get_room_mapping handler). -1 means
  // docked/idle or, when state indicates motion, relocalizing. target_* expose the
  // next room (cleaning_info.target_segment_id populates during transitions) so a
  // consumer can pre-light it; in_cleaning is the device flag (0 once a clean
  // concludes, even while it returns/empties). Fire-and-forget; never rejects.
  publishCurrentRoom(duid, raw) {
    try {
      const cfg = this.config && this.config.currentRoomMqtt;
      if (!cfg || !cfg.enabled) return;
      const client = this.ensureLocalMqtt();
      if (!client || !client.connected) return;

      const ci = raw && raw.cleaningInfo;
      const segId =
        ci && typeof ci.segment_id === "number" ? ci.segment_id : -1;
      const room =
        segId >= 0 ? this.segmentRoomNames?.[duid]?.[segId] ?? null : null;
      const tSegId =
        ci && typeof ci.target_segment_id === "number"
          ? ci.target_segment_id
          : -1;
      const targetRoom =
        tSegId >= 0 ? this.segmentRoomNames?.[duid]?.[tSegId] ?? null : null;
      const state = typeof raw.state === "number" ? raw.state : null;
      const inCleaning =
        typeof raw.inCleaning === "number" ? raw.inCleaning : null;

      // target_segment_id and in_cleaning MUST be in the dedupe key: they change
      // while segment_id/state may not, so without them those transitions (e.g. a
      // target flip -1 -> N -> -1) would be deduped away.
      const key = `${segId}|${room}|${state}|${tSegId}|${targetRoom}|${inCleaning}`;
      if (key === this._lastRoomPublishKey[duid]) return; // dedupe (ts excluded)
      this._lastRoomPublishKey[duid] = key;

      const topic = this.resolveRoomTopic(duid);
      const payload = JSON.stringify({
        segment_id: segId,
        room,
        state,
        target_segment_id: tSegId,
        target_room: targetRoom,
        in_cleaning: inCleaning,
        ts: Date.now(),
      });
      client.publish(topic, payload, { retain: true, qos: 0 }, (err) => {
        if (err) {
          this.log.debug(`current_room MQTT publish failed: ${err.message}`);
          this._lastRoomPublishKey[duid] = undefined; // allow retry on next change
        }
      });
    } catch (e) {
      this.log.debug(`publishCurrentRoom error: ${e && e.message}`);
    }
  }

  async getRobotVersion(duid) {
    const device = this.getAllHomeDevices().find(
      (device) => device.duid == duid
    );
    if (device) {
      return device.pv;
    }

    return "Error in getRobotVersion. Version not found.";
  }

  getRequestId() {
    if (this.idCounter >= 9999) {
      this.idCounter = 0;
      return this.idCounter;
    }
    return this.idCounter++;
  }

  async catchError(error, attribute, duid, model) {
    if (!error) {
      return;
    }

    const errorText = error.toString();
    const isTransient =
      errorText.includes("retry") ||
      errorText.includes("locating") ||
      errorText.includes("timed out after 10 seconds");

    if (isTransient) {
      this.logTransientError(error, attribute, duid, model);
    } else {
      this.log.error(
        `Failed to execute ${attribute} on robot ${duid} (${model || "unknown model"}): ${error.stack || error}`
      );
    }
  }

  logTransientError(error, attribute, duid, model) {
    const key = `${duid}:${attribute}`;
    const now = Date.now();
    const entry = this.transientErrorLog.get(key);

    if (entry && now - entry.lastLogged < this.transientErrorLogInterval) {
      entry.suppressedCount++;
      return;
    }

    const suppressedNote =
      entry && entry.suppressedCount > 0
        ? ` (suppressed ${entry.suppressedCount} identical message(s) in the last ${Math.round(this.transientErrorLogInterval / 60000)} min)`
        : "";

    this.log.warn(
      `Failed to execute ${attribute} on robot ${duid} (${model || "unknown model"}): ${error}${suppressedNote}`
    );

    this.transientErrorLog.set(key, { lastLogged: now, suppressedCount: 0 });
  }

  // Called by the message queue when a request times out. After a few
  // consecutive timeouts for the same method we assume the device does not
  // support it and pause polling that method for a cooldown window.
  recordMethodTimeout(duid, method) {
    if (!duid || !method) {
      return;
    }

    const key = `${duid}:${method}`;
    const streak = (this.methodTimeoutStreak.get(key) || 0) + 1;

    if (streak >= this.methodBackoffThreshold) {
      this.methodPollBackoff.set(key, Date.now() + this.methodBackoffInterval);
      this.methodTimeoutStreak.set(key, 0);
      this.log.info(
        `Pausing polling of ${method} for ${duid} after ${streak} consecutive timeouts; will retry in ${Math.round(this.methodBackoffInterval / 60000)} min.`
      );
    } else {
      this.methodTimeoutStreak.set(key, streak);
    }
  }

  // Called by the message queue when a request succeeds. Clears any timeout
  // streak/backoff so a method that starts responding is polled normally again.
  recordMethodSuccess(duid, method) {
    if (!duid || !method) {
      return;
    }

    const key = `${duid}:${method}`;
    this.methodTimeoutStreak.delete(key);
    this.methodPollBackoff.delete(key);
  }

  // Whether an optional method should be polled now (false while backing off).
  shouldPollMethod(duid, method) {
    const until = this.methodPollBackoff.get(`${duid}:${method}`);
    return !until || Date.now() >= until;
  }

  // Called by the message queue when a LOCAL request times out. After a few
  // consecutive local timeouts we treat the device's local connection as
  // unresponsive (connected but mute) and prefer the cloud path for a cooldown.
  recordLocalTimeout(duid) {
    if (!duid) {
      return;
    }

    const streak = (this.localTimeoutStreak.get(duid) || 0) + 1;

    if (streak >= this.localFailoverThreshold) {
      this.localCloudPreference.set(
        duid,
        Date.now() + this.localFailoverInterval
      );
      this.localTimeoutStreak.set(duid, 0);
      this.log.info(
        `Local connection for ${duid} is unresponsive after ${streak} consecutive timeouts; preferring cloud for ${Math.round(this.localFailoverInterval / 60000)} min.`
      );
    } else {
      this.localTimeoutStreak.set(duid, streak);
    }
  }

  // Called by the message queue when a CLOUD request times out. Only a
  // session that claims to be connected yet delivers nothing is restarted:
  // - while MQTT reports itself disconnected (network down, broker gone) the
  //   mqtt client's own reconnect loop is already at work;
  // - while the Roborock cloud API is unreachable the outage is server-side
  //   and a new session would not help;
  // - any MQTT message (see noteCloudMessage) resets the streak, so requests
  //   one device leaves unanswered never restart a session that works.
  recordCloudTimeout() {
    if (!this.rr_mqtt_connector.isConnected() || this.cloudUnreachable) {
      return;
    }

    this.cloudTimeoutStreak++;
    if (this.cloudTimeoutStreak < this.cloudRestartThreshold) {
      return;
    }

    const now = Date.now();
    if (
      this.lastCloudRestart !== null &&
      now - this.lastCloudRestart < this.cloudRestartCooldown()
    ) {
      return;
    }

    this.log.info(
      `Cloud MQTT session delivered nothing for ${this.cloudTimeoutStreak} consecutive requests; restarting it.`
    );
    this.lastCloudRestart = now;
    this.cloudRestartCount++;
    this.cloudTimeoutStreak = 0;
    this.rr_mqtt_connector.reconnectClient();
  }

  // Minimum time since the last restart before the next one: 30 min, doubled
  // for every further restart that did not bring traffic back, up to 6 h.
  cloudRestartCooldown() {
    const exponent = Math.max(0, this.cloudRestartCount - 1);
    return Math.min(
      this.cloudRestartBaseCooldown * 2 ** exponent,
      this.cloudRestartMaxCooldown
    );
  }

  // Called for every MQTT message received: the session is delivering.
  noteCloudMessage() {
    this.cloudTimeoutStreak = 0;
    this.cloudRestartCount = 0;
  }

  // Called by the message queue when a CLOUD request succeeds.
  recordCloudSuccess() {
    this.noteCloudMessage();
  }

  // Called by the message queue when a LOCAL request succeeds. Clears any local
  // failover state so a recovered local connection is used again.
  recordLocalSuccess(duid) {
    if (!duid) {
      return;
    }

    this.localTimeoutStreak.delete(duid);
    this.localCloudPreference.delete(duid);
  }

  // Whether requests for a device should prefer the cloud path because its local
  // connection is connected but unresponsive (true during the failover cooldown).
  shouldPreferCloudLocally(duid) {
    const until = this.localCloudPreference.get(duid);
    return !!until && Date.now() < until;
  }

  // Poll a method that a device may not support. A device that never answers
  // (e.g. a newer-protocol model lacking the V1 method) backs off instead of
  // timing out every cycle. See recordMethodTimeout/backoff.
  async pollOptional(duid, vacuum, method) {
    if (this.shouldPollMethod(duid, method)) {
      await vacuum.getParameter(duid, method);
    } else {
      this.log.debug(
        `Skipping ${method} for ${duid}; backing off after repeated timeouts.`
      );
    }
  }

  async app_start(duid) {
    await this.startCommand(duid, "app_start", null);
  }

  /**
   * Play the locate sound on the vacuum ("find me"). Used by the Matter
   * Identify command.
   */
  async findMe(duid) {
    if (!this.isInited()) {
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    const vacuum = this.vacuums[duid];
    if (!vacuum) {
      this.log.warn(`findMe: unknown device ${duid}.`);
      return;
    }

    await vacuum.command(duid, "find_me", null);
  }

  /**
   * Start washing the mop at the dock. Used by the HAP/Matter dock-wash
   * switch; only meaningful on washing-capable docks (isDockWashSupported).
   */
  async app_start_wash(duid) {
    await this.dockWashCommand(duid, "app_start_wash");
  }

  /** Stop an in-progress mop wash at the dock. */
  async app_stop_wash(duid) {
    await this.dockWashCommand(duid, "app_stop_wash");
  }

  async dockWashCommand(duid, command) {
    if (!this.isInited()) {
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    const vacuum = this.vacuums[duid];
    if (!vacuum) {
      this.log.warn(`${command}: unknown device ${duid}.`);
      return;
    }

    await vacuum.command(duid, command, null);
  }

  /**
   * Whether the device's dock can wash the mop. The featureSet bit from the
   * cloud home data is authoritative and available at discovery; the polled
   * dock_type (see deviceFeatures.processDockType) is the fallback for
   * devices whose featureSet does not carry the bit.
   */
  isDockWashSupported(duid) {
    try {
      const features = this.vacuums[duid]?.features?.getFeatureList?.();
      if (features && features.isWashThenChargeCmdSupported) {
        return true;
      }
    } catch (error) {
      this.log.debug(`isDockWashSupported: ${error}`);
    }

    const dockType = Number(
      this.getStateAsync(`Devices.${duid}.deviceStatus.dock_type`)?.val
    );
    return (
      Number.isFinite(dockType) &&
      !NON_MOP_WASHING_DOCK_TYPES.includes(dockType)
    );
  }

  /**
   * Localized label from the bundled i18n catalog selected by the `language`
   * option (loaded in startService). Falls back to the key itself so callers
   * always get a usable string.
   */
  getTranslation(key) {
    return (this.translations && this.translations[key]) || key;
  }

  /**
   * Set the cleaning motor parameters used by the Matter clean-mode mapping.
   * parameters: { fan_power?: number, water_box_mode?: number }
   * fan_power uses set_custom_mode (105 = suction off / mop only) and
   * water_box_mode uses set_water_box_custom_mode (200 = water off / vacuum only).
   */
  async setCleanModeParameters(duid, parameters) {
    if (!this.isInited()) {
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    const vacuum = this.vacuums[duid];
    if (!vacuum) {
      this.log.warn(`setCleanModeParameters: unknown device ${duid}.`);
      return;
    }

    if (parameters && parameters.fan_power !== undefined) {
      await vacuum.command(duid, "set_custom_mode", parameters.fan_power);
    }
    if (parameters && parameters.water_box_mode !== undefined) {
      await vacuum.command(
        duid,
        "set_water_box_custom_mode",
        parameters.water_box_mode
      );
    }
  }

  async app_stop(duid) {
    await this.startCommand(duid, "app_stop", null);
  }

  async app_pause(duid) {
    await this.startCommand(duid, "app_pause", null);
  }

  async app_charge(duid) {
    await this.startCommand(duid, "app_charge", null);
  }

  /**
   * Named rooms for a device, from the segmentRoomNames cache populated by the
   * periodic get_room_mapping poll. Used by the Matter ServiceArea cluster.
   * Returns [{ segmentId, name }] sorted by segmentId; empty until the first
   * successful room-mapping poll (rooms must be named in the Roborock app).
   */
  getSegmentRooms(duid) {
    const rooms = (this.segmentRoomNames && this.segmentRoomNames[duid]) || {};

    return Object.keys(rooms)
      .map((segmentId) => ({
        segmentId: Number(segmentId),
        name: String(rooms[segmentId]),
      }))
      .filter((room) => Number.isFinite(room.segmentId))
      .sort((a, b) => a.segmentId - b.segmentId);
  }

  /**
   * Clean specific rooms (segments). segmentIds is an array of segment ids as
   * reported by get_room_mapping. Used by the Matter ServiceArea cluster.
   */
  async app_segment_clean(duid, segmentIds, repeat = 1) {
    if (!this.isInited()) {
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    if (!this.vacuums[duid]) {
      this.log.warn(`app_segment_clean: unknown device ${duid}.`);
      return;
    }

    const segments = (segmentIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (segments.length === 0) {
      this.log.warn(`app_segment_clean: no valid segment ids for ${duid}.`);
      return;
    }

    await this.messageQueueHandler.sendRequest(duid, "app_segment_clean", [
      { segments: segments, repeat: repeat },
    ]);
  }

  /**
   * Resume a paused segment (room) clean. app_start would restart a full
   * clean instead, so the Matter Resume command uses this for segment cleans.
   */
  async resume_segment_clean(duid) {
    if (!this.isInited()) {
      this.log.warn("Adapter not inited. Command not executed.");
      return;
    }

    if (!this.vacuums[duid]) {
      this.log.warn(`resume_segment_clean: unknown device ${duid}.`);
      return;
    }

    await this.messageQueueHandler.sendRequest(
      duid,
      "resume_segment_clean",
      []
    );
  }

  /**
   * Motor capabilities used by the Matter clean-mode mapping. Values follow
   * the V1 protocol shared by the supported models (fan 101-105, water
   * 200-203); mopSupported comes from the per-model feature list so mop-less
   * vacuums do not advertise mop modes.
   */
  getCleanModeCapabilities(duid) {
    let mopSupported = true;

    try {
      const features = this.vacuums[duid]?.features?.getFeatureList?.();
      if (features && typeof features.isWaterBoxSupported === "boolean") {
        mopSupported = features.isWaterBoxSupported;
      }
    } catch (error) {
      this.log.debug(`getCleanModeCapabilities: ${error}`);
    }

    // The Qrevo Edge 2 (a298) does not use the classic 200-203 water levels:
    // it keeps 200 = Off but replaces 201-203 with banded levels 221-250,
    // so writing the classic default 202 would be rejected by the device.
    // 233 is the middle ("Medium") band. The sibling Qrevo Edge (a187) still
    // uses the classic values.
    const model = this.getProductAttribute(duid, "model");
    const usesBandedWaterLevels = model === "roborock.vacuum.a298";

    return {
      fanOff: 105,
      fanDefault: 102,
      waterOff: 200,
      waterDefault: usesBandedWaterLevels ? 233 : 202,
      mopSupported: mopSupported,
    };
  }

  async getStatus(duid) {
    try {
      await this.vacuums[duid].getParameter(duid, "get_status", "state");
    } catch (error) {
      this.catchError(error, "getStatus", duid);
    }
  }

  getProductData(productId) {
    const homedata = this.getParsedHomeData();

    if (homedata) {
      return (homedata.products || []).find(
        (product) => product.id == productId
      );
    }
  }

  getVacuumDeviceData(duid) {
    return this.getAllHomeDevices().find((device) => device.duid == duid);
  }

  getVacuumSchemaId(duid, code) {
    const productId = this.getVacuumDeviceInfo(duid, "productId");
    const product = this.getProductData(productId);

    if (product) {
      const schema = product.schema;
      const schemaId = schema.find((schema) => schema.code == code);

      if (schemaId) {
        return schemaId.id;
      }
    }

    return null;
  }

  getVacuumDeviceInfo(duid, property) {
    const device = this.getVacuumDeviceData(duid);

    if (device) {
      return device[property];
    } else {
      return "";
    }
  }

  // Poll get_status, the device's own status report. V1 devices only (B01
  // devices use a different method set). The HomeData deviceStatus snapshot
  // is a cloud-side copy that can lag behind the device, and older products'
  // schemas lack fields such as charge_status. python-roborock polls
  // get_status for V1 status as well.
  async pollStatus(duid) {
    if (this.getVacuumDeviceInfo(duid, "pv") !== "1.0") {
      return;
    }

    if (!this.shouldPollMethod(duid, "get_status")) {
      this.log.debug(
        `Skipping get_status for ${duid}; backing off after repeated timeouts.`
      );
      return;
    }

    try {
      const result = await this.messageQueueHandler.sendRequest(
        duid,
        "get_status",
        []
      );
      this.recordLiveStatus(duid, Array.isArray(result) ? result[0] : result);
    } catch (error) {
      this.catchError(error, "get_status", duid);
    }
  }

  // Record named status fields (a get_status result) as live status.
  recordLiveStatus(duid, status) {
    if (!duid || !status || typeof status !== "object") {
      return;
    }

    const now = Date.now();
    const fields = this.liveStatus.get(duid) || {};
    for (const [field, value] of Object.entries(status)) {
      if (typeof value === "number") {
        fields[field] = { value, at: now };
      }
    }
    this.liveStatus.set(duid, fields);
  }

  // Record a status broadcast, which carries schema ids instead of get_status
  // field names (python-roborock RoborockDataProtocol).
  recordStatusBroadcast(duid, dps) {
    if (!dps || typeof dps !== "object") {
      return;
    }

    const status = {};
    for (const [dpsId, field] of Object.entries(DPS_STATUS_FIELDS)) {
      if (dps[dpsId] !== undefined) {
        status[field] = dps[dpsId];
      }
    }
    this.recordLiveStatus(duid, status);
  }

  // A live status field, or undefined when unknown or stale. Values older
  // than three poll intervals (polling stops while a device is offline) fall
  // back to the HomeData snapshot.
  getLiveStatus(duid, property) {
    const fields = this.liveStatus.get(duid);
    const field = fields && fields[property];
    if (!field || Date.now() - field.at > this.updateInterval * 3 * 1000) {
      return undefined;
    }
    return field.value;
  }

  getVacuumDeviceStatus(duid, property) {
    const liveValue = this.getLiveStatus(duid, property);
    if (liveValue !== undefined) {
      return liveValue;
    }

    const propertyID = this.getVacuumSchemaId(duid, property);

    if (propertyID == null) {
      return "";
    }

    const device = this.getVacuumDeviceData(duid);

    if (
      device &&
      device.deviceStatus &&
      device.deviceStatus[propertyID] != undefined
    ) {
      return device.deviceStatus[propertyID];
    }

    return "";
  }

  getVacuumList() {
    return this.getAllHomeDevices();
  }

  setDeviceNotify(callback) {
    this.deviceNotify = callback;
  }
}

module.exports = { Roborock };

////////////////////////////////////////////////////////////////////////////////////////////////////
