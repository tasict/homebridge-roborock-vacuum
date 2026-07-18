const elements = {
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  passwordRow: document.getElementById("password-row"),
  baseUrl: document.getElementById("base-url"),
  language: document.getElementById("language"),
  skipDevices: document.getElementById("skip-devices"),
  addSkipDevice: document.getElementById("add-skip-device"),
  loadDevices: document.getElementById("load-devices"),
  discoveredDevices: document.getElementById("discovered-devices"),
  debugMode: document.getElementById("debug-mode"),
  matterSection: document.getElementById("matter-section"),
  matterChildBridge: document.getElementById("matter-child-bridge"),
  roomMqttEnabled: document.getElementById("room-mqtt-enabled"),
  roomMqttBroker: document.getElementById("room-mqtt-broker"),
  roomMqttTopic: document.getElementById("room-mqtt-topic"),
  roomMqttPoll: document.getElementById("room-mqtt-poll"),
  code: document.getElementById("two-factor-code"),
  login: document.getElementById("login"),
  logout: document.getElementById("logout"),
  send2fa: document.getElementById("send-2fa"),
  verify2fa: document.getElementById("verify-2fa"),
  twoFactorSection: document.getElementById("two-factor-section"),
  toastContainer: document.getElementById("toast-container"),
};

// Whether Homebridge Matter support is enabled (gates the Matter option).
let matterSupported = false;
// Device IDs the user selected to publish over Matter.
const matterSelected = new Set();
// Devices whose Roborock scenes are bridged as Matter buttons.
const matterSceneSelected = new Set();
// Per-device Matter pairing info (duid -> entry), fetched lazily.
let matterPairings = null;
let matterBridgePairing = null;

// Homebridge accepts `matter: true` (legacy shorthand) or a MatterConfig
// object where a missing `enabled` means enabled.
function matterFlagEnabled(value) {
  if (value === true) {
    return true;
  }
  return typeof value === "object" && value !== null && value.enabled !== false;
}

// getPluginConfig/updatePluginConfig go through the parent-frame
// postMessage bridge (not the plugin server). The same config-ui-x 5.24.0
// stale-listener bug can drop those responses too, so guard them with the
// same timeout instead of letting the page hang.
async function getPluginConfigs() {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    return null;
  }
  return withTimeout(
    window.homebridge.getPluginConfig(),
    REQUEST_TIMEOUT_MS,
    null
  );
}

function showBridgeStuckError() {
  showToast(
    "error",
    "The Homebridge UI did not respond. Close this settings window, " +
      "reload the Homebridge UI page (or close and reopen the browser tab) " +
      "and try again."
  );
}

async function getPlatformConfig() {
  const configs = await getPluginConfigs();
  if (!configs) {
    return null;
  }
  return (
    configs.find((entry) => entry.platform === "RoborockVacuumPlatform") || null
  );
}

function showToast(type, message) {
  if (
    window.homebridge &&
    window.homebridge.toast &&
    typeof window.homebridge.toast[type] === "function"
  ) {
    window.homebridge.toast[type](message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `rr-toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// How long to wait for the Homebridge UI to relay a response before giving
// up. Guards against config-ui-x dropping responses (e.g. stale iframe
// references after the settings modal is reopened), which would otherwise
// leave the page hanging forever.
const REQUEST_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

async function request(path, body) {
  try {
    return await withTimeout(
      window.homebridge.request(path, body),
      REQUEST_TIMEOUT_MS,
      {
        ok: false,
        message:
          "The Homebridge UI did not respond in time. " +
          "Close this window, reload the Homebridge UI page and try again.",
      }
    );
  } catch (error) {
    return { ok: false, message: error.message || "Request failed." };
  }
}

async function loadConfig() {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    return;
  }

  const configs = await getPluginConfigs();
  if (!configs) {
    showBridgeStuckError();
    renderDevicesMessage(
      "Could not load the plugin config. Close this window, reload the " +
        "Homebridge UI page and try again."
    );
    return;
  }
  const config = configs.find(
    (entry) => entry.platform === "RoborockVacuumPlatform"
  );
  if (!config) {
    renderSkipDevices([]);
    return;
  }

  if (config.email) {
    elements.email.value = config.email;
  }
  elements.baseUrl.value = normalizeBaseUrl(
    config.baseURL || "https://usiot.roborock.com"
  );
  elements.language.value = config.language || "en";
  renderSkipDevices(config.skipDevices);
  matterSelected.clear();
  parseDeviceIds(config.matterDevices).forEach((id) => matterSelected.add(id));
  matterSceneSelected.clear();
  if (config.matterSceneDevices === undefined) {
    // Legacy config without the option: scene buttons were always bridged,
    // so default every Matter device to enabled.
    matterSelected.forEach((id) => matterSceneSelected.add(id));
  } else {
    parseDeviceIds(config.matterSceneDevices).forEach((id) =>
      matterSceneSelected.add(id)
    );
  }
  elements.debugMode.checked = Boolean(config.debugMode);

  const roomMqtt = config.currentRoomMqtt || {};
  elements.roomMqttEnabled.checked = Boolean(roomMqtt.enabled);
  elements.roomMqttBroker.value = roomMqtt.brokerUrl || "";
  elements.roomMqttTopic.value = roomMqtt.topic || "";
  elements.roomMqttPoll.value =
    roomMqtt.cleaningPollSeconds != null ? roomMqtt.cleaningPollSeconds : "";

  setLoggedInState(Boolean(config.encryptedToken));

  // Populate the device list automatically so saved protocol selections
  // are visible without pressing "Load devices" after every reopen.
  if (config.encryptedToken) {
    loadDevices().catch(() => {
      renderDevicesMessage(
        "Could not load devices. Press Load devices to retry."
      );
    });
  }
}

function getEmail() {
  return elements.email.value.trim();
}

function getPassword() {
  return elements.password.value;
}

function getBaseUrl() {
  return elements.baseUrl.value;
}

function getLanguage() {
  return elements.language.value || "en";
}

function getSkipDevices() {
  return getSkipDeviceInputs()
    .map((input) => input.value.trim())
    .filter((entry) => entry)
    .join(",");
}

function getDebugMode() {
  return Boolean(elements.debugMode.checked);
}

function getMatterDevices() {
  return [...matterSelected].join(",");
}

function getMatterSceneDevices() {
  return [...matterSceneSelected].join(",");
}

async function loadMatterStatus() {
  let enabled = false;
  const config = await getPlatformConfig();

  if (config && config._bridge) {
    // Child-bridge mode: the runtime Matter API only exists on the bridge
    // the plugin actually runs on, so gate on the child bridge's own flag.
    enabled = matterFlagEnabled(config._bridge.matter);
  } else {
    // Main-bridge mode: bridge.matter in the Homebridge config.json.
    const result = await request("/matter/status");
    enabled = Boolean(result && result.ok && result.enabled);
  }

  matterSupported = enabled;
}

async function initMatterToggle() {
  const config = await getPlatformConfig();
  if (!config || !config._bridge) {
    // Not child-bridged: Matter is governed by the main bridge's own
    // settings, nothing to toggle from here.
    return;
  }

  const status = await request("/matter/status");
  if (!status || !status.ok || !status.coreSupportsMatter) {
    return;
  }

  elements.matterSection.classList.remove("hidden");
  elements.matterChildBridge.checked = matterFlagEnabled(config._bridge.matter);
}

async function saveMatterChildBridge() {
  const config = await getPlatformConfig();
  if (!config || !config._bridge) {
    return;
  }

  const bridge = { ...config._bridge };
  const existing =
    bridge.matter && typeof bridge.matter === "object" ? bridge.matter : {};
  if (elements.matterChildBridge.checked) {
    bridge.matter = { ...existing, enabled: true };
  } else if (bridge.matter) {
    // Disable in place: Homebridge preserves the commissioning info so
    // Matter can be re-enabled later without re-pairing.
    bridge.matter = { ...existing, enabled: false };
  }

  await updatePluginConfig({ _bridge: bridge });
  await loadMatterStatus();
  showToast(
    "info",
    "Matter bridge setting saved. Restart Homebridge to apply."
  );
}

function getCode() {
  return elements.code.value.trim();
}

function getRoomMqtt() {
  const config = { enabled: Boolean(elements.roomMqttEnabled.checked) };

  const brokerUrl = elements.roomMqttBroker.value.trim();
  if (brokerUrl) {
    config.brokerUrl = brokerUrl;
  }

  const topic = elements.roomMqttTopic.value.trim();
  if (topic) {
    config.topic = topic;
  }

  const pollRaw = elements.roomMqttPoll.value.trim();
  const cleaningPollSeconds = Number(pollRaw);
  if (pollRaw && Number.isFinite(cleaningPollSeconds)) {
    config.cleaningPollSeconds = cleaningPollSeconds;
  }

  return config;
}

async function saveRoomMqtt() {
  await updatePluginConfig({ currentRoomMqtt: getRoomMqtt() });
}

function parseDeviceIds(value) {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : String(value).split(/[\n,]+/);
  return entries.map((entry) => String(entry).trim()).filter((entry) => entry);
}

function getSkipDeviceInputs() {
  return Array.from(elements.skipDevices.querySelectorAll("input"));
}

function renderSkipDevices(value) {
  elements.skipDevices.textContent = "";

  const deviceIds = parseDeviceIds(value);
  if (deviceIds.length === 0) {
    addSkipDeviceRow("", false);
    return;
  }

  deviceIds.forEach((deviceId) => addSkipDeviceRow(deviceId, false));
}

function addSkipDeviceRow(value = "", shouldFocus = true) {
  const row = document.createElement("div");
  row.className = "skip-device-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "form-control";
  input.placeholder = "Device ID";
  input.setAttribute("aria-label", "Skipped device ID");
  input.value = value;
  input.addEventListener("change", saveCredentials);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button remove";
  remove.title = "Remove skipped device";
  remove.setAttribute("aria-label", "Remove skipped device");
  remove.textContent = "-";
  remove.addEventListener("click", () => {
    row.remove();
    if (getSkipDeviceInputs().length === 0) {
      addSkipDeviceRow();
    }
    saveCredentials();
  });

  row.append(input, remove);
  elements.skipDevices.appendChild(row);
  if (shouldFocus) {
    input.focus();
  }
}

function getSkipDeviceSet() {
  return new Set(
    getSkipDeviceInputs()
      .map((input) => input.value.trim())
      .filter((entry) => entry)
  );
}

function currentProtocol(deviceId) {
  if (getSkipDeviceSet().has(deviceId)) {
    return "skip";
  }
  if (matterSelected.has(deviceId)) {
    return "matter";
  }
  return "hap";
}

function setDeviceProtocol(deviceId, protocol) {
  const skipped = getSkipDeviceSet();
  skipped.delete(deviceId);
  matterSelected.delete(deviceId);
  matterSceneSelected.delete(deviceId);

  if (protocol === "skip") {
    skipped.add(deviceId);
  } else if (protocol === "matter") {
    matterSelected.add(deviceId);
    // Scene buttons default to enabled when a device is switched to Matter;
    // the per-device checkbox can turn them off.
    matterSceneSelected.add(deviceId);
  }

  renderSkipDevices([...skipped]);
  renderPairingPanels().catch(() => {
    // Best-effort.
  });
  saveCredentials();
  showToast(
    "warning",
    "Protocol changed. The device is re-created on restart and loses its " +
      "room and automation assignments in your home app."
  );
}

async function fetchMatterPairings() {
  if (matterPairings) {
    return matterPairings;
  }
  const map = {};
  const result = await request("/matter/pairing");
  if (result && result.ok && Array.isArray(result.pairings)) {
    result.pairings.forEach((entry) => {
      map[entry.duid] = entry;
    });
    matterBridgePairing = result.bridgePairing || null;
  }
  matterPairings = map;
  return map;
}

// Show the Matter pairing QR/manual code under every device that is
// published over Matter, so it can be commissioned without digging
// through the Homebridge log.
async function renderPairingPanels() {
  elements.discoveredDevices
    .querySelectorAll(".pairing-panel")
    .forEach((panel) => panel.remove());

  const matterRows = Array.from(
    elements.discoveredDevices.querySelectorAll(".device-row")
  ).filter(
    (row) => row.dataset.duid && currentProtocol(row.dataset.duid) === "matter"
  );
  if (matterRows.length === 0) {
    return;
  }

  const pairings = await fetchMatterPairings();
  matterRows.forEach((row) => {
    const pairing = pairings[row.dataset.duid];
    const panel = document.createElement("div");
    panel.className = "pairing-panel";

    if (!pairing) {
      const hint = document.createElement("p");
      hint.className = "help";
      hint.textContent =
        "Pairing code not available yet. Restart Homebridge to publish " +
        "this device over Matter, then reopen this page.";
      panel.appendChild(hint);
      row.after(panel);
      return;
    }

    const qr = document.createElement("div");
    qr.className = "pairing-qr";
    qr.innerHTML = pairing.qrSvg;

    const info = document.createElement("div");
    info.className = "pairing-info";

    const codeLabel = document.createElement("p");
    codeLabel.className = "help";
    codeLabel.textContent = "Matter manual pairing code";
    const code = document.createElement("p");
    code.className = "pairing-code";
    code.textContent = pairing.manualPairingCode || "";
    const status = document.createElement("p");
    status.className = "help";
    status.textContent = pairing.commissioned
      ? "Paired with " +
        pairing.fabricCount +
        " controller(s). Scan the QR code to add it to another controller."
      : "Not paired yet. In your controller app (e.g. Apple Home) choose " +
        "Add Accessory and scan the QR code or enter the manual code.";

    // Controllers look the bridge's test vendor ID up in the certification
    // database and fall back to a generic label, ignoring the name the
    // device advertises — tell the user what to type in the naming step.
    const nameHint = document.createElement("p");
    nameHint.className = "help";
    nameHint.append(
      "During pairing the controller shows this device as generic " +
        "“Matter Accessory” (uncertified-bridge limitation). " +
        "When asked for a name, enter: "
    );
    const suggestedName = document.createElement("strong");
    suggestedName.textContent = pairing.name || "";
    nameHint.appendChild(suggestedName);

    info.append(codeLabel, code, status, nameHint);
    panel.append(qr, info);
    row.after(panel);
  });

  renderSceneBridgePanel();
}

// The Roborock scene buttons are bridged accessories on the plugin's own
// Matter bridge — a separate Matter node from the per-vacuum nodes above,
// with its own pairing code. Without pairing it, the scene buttons never
// appear in the controller, so surface its QR code here too.
function renderSceneBridgePanel() {
  const pairing = matterBridgePairing;
  if (!pairing || !pairing.qrSvg) {
    return;
  }

  // No point offering the bridge pairing when no Matter device currently
  // has its scene buttons enabled.
  const anySceneEnabled = [...matterSelected].some((id) =>
    matterSceneSelected.has(id)
  );
  if (!anySceneEnabled) {
    return;
  }

  const panel = document.createElement("div");
  panel.className = "pairing-panel";

  const qr = document.createElement("div");
  qr.className = "pairing-qr";
  qr.innerHTML = pairing.qrSvg;

  const info = document.createElement("div");
  info.className = "pairing-info";

  const title = document.createElement("p");
  title.className = "help";
  const sceneNames = Array.isArray(pairing.sceneNames)
    ? pairing.sceneNames.join(", ")
    : "";
  title.textContent =
    "Scene buttons (" +
    sceneNames +
    ") are published on the plugin's own Matter bridge — a separate " +
    "pairing from the vacuum above.";

  const codeLabel = document.createElement("p");
  codeLabel.className = "help";
  codeLabel.textContent = "Matter manual pairing code";
  const code = document.createElement("p");
  code.className = "pairing-code";
  code.textContent = pairing.manualPairingCode || "";

  const status = document.createElement("p");
  status.className = "help";
  status.textContent = pairing.commissioned
    ? "Paired with " +
      pairing.fabricCount +
      " controller(s). Scan the QR code to add it to another controller."
    : "Not paired yet. Scan the QR code (or enter the manual code) to add " +
      "the scene buttons to your controller.";

  info.append(title, codeLabel, code, status);
  panel.append(qr, info);
  elements.discoveredDevices.appendChild(panel);
}

function renderDevicesMessage(text) {
  elements.discoveredDevices.textContent = "";
  const message = document.createElement("p");
  message.className = "help";
  message.textContent = text;
  elements.discoveredDevices.appendChild(message);
}

function renderDiscoveredDevices(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    renderDevicesMessage("No devices found on this account.");
    return;
  }

  elements.discoveredDevices.textContent = "";

  devices.forEach((device) => {
    const row = document.createElement("div");
    row.className = "device-row";
    row.dataset.duid = device.duid;

    const label = document.createElement("span");
    const model = device.model ? ` (${device.model})` : "";
    const shared = device.shared ? " — shared" : "";
    label.textContent = `${device.name || device.duid}${model} — ${device.duid}${shared}`;

    const select = document.createElement("select");
    select.className = "form-select form-select-sm";
    const current = currentProtocol(device.duid);
    const options = [{ value: "hap", text: "HomeKit (HAP)" }];
    if (matterSupported || current === "matter") {
      options.push({
        value: "matter",
        text: matterSupported ? "Matter (Beta)" : "Matter (Beta, unavailable)",
      });
    }
    options.push({ value: "skip", text: "Skip" });

    options.forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.text;
      select.appendChild(option);
    });
    select.value = current;

    // Per-device toggle for bridging the Roborock scenes as Matter buttons;
    // only meaningful (and visible) while the device is published over Matter.
    const sceneToggle = document.createElement("label");
    sceneToggle.className = "scene-toggle";
    const sceneCheckbox = document.createElement("input");
    sceneCheckbox.type = "checkbox";
    sceneCheckbox.checked = matterSceneSelected.has(device.duid);
    sceneCheckbox.addEventListener("change", () => {
      if (sceneCheckbox.checked) {
        matterSceneSelected.add(device.duid);
      } else {
        matterSceneSelected.delete(device.duid);
      }
      saveCredentials();
      renderPairingPanels().catch(() => {
        // Best-effort; the checkbox state is already saved.
      });
      showToast(
        "warning",
        "Scene button setting saved. Restart Homebridge to apply."
      );
    });
    sceneToggle.append(sceneCheckbox, " Bridge scene buttons over Matter");
    sceneToggle.style.display = current === "matter" ? "" : "none";

    select.addEventListener("change", () => {
      setDeviceProtocol(device.duid, select.value);
      sceneCheckbox.checked = matterSceneSelected.has(device.duid);
      sceneToggle.style.display = select.value === "matter" ? "" : "none";
    });

    row.append(label, select, sceneToggle);
    elements.discoveredDevices.appendChild(row);
  });

  renderPairingPanels().catch(() => {
    // Pairing info is best-effort; the device list stays usable without it.
  });
}

async function loadDevices(forceRefresh) {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    return;
  }

  const config = await getPlatformConfig();
  const encryptedToken = config && config.encryptedToken;
  if (!encryptedToken) {
    showToast("warning", "Log in first to load your devices.");
    return;
  }

  elements.loadDevices.disabled = true;
  renderDevicesMessage("Loading devices…");
  try {
    await loadMatterStatus();
    const result = await request("/devices/list", {
      email: getEmail(),
      baseURL: getBaseUrl(),
      encryptedToken,
      refresh: Boolean(forceRefresh),
    });
    if (result.ok) {
      renderDiscoveredDevices(result.devices);
      // Cached answer: render instantly, then refresh from the cloud in the
      // background so newly added/removed vacuums still show up.
      if (result.cached) {
        refreshDevicesInBackground(encryptedToken, result.devices);
      }
    } else {
      renderDevicesMessage(
        "Could not load devices. Press Load devices to retry."
      );
      showToast("error", result.message || "Failed to load devices.");
    }
  } finally {
    elements.loadDevices.disabled = false;
  }
}

function refreshDevicesInBackground(encryptedToken, cachedDevices) {
  request("/devices/list", {
    email: getEmail(),
    baseURL: getBaseUrl(),
    encryptedToken,
    refresh: true,
  })
    .then((result) => {
      if (!result.ok || !Array.isArray(result.devices)) {
        return; // Silent: the cached list stays on screen.
      }
      const key = (devices) =>
        JSON.stringify(
          (devices || []).map((d) => [d.duid, d.name, d.model, d.shared])
        );
      if (key(result.devices) !== key(cachedDevices)) {
        renderDiscoveredDevices(result.devices);
      }
    })
    .catch(() => {
      // Silent: the cached list stays on screen.
    });
}

async function saveCredentials() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  const skipDevices = getSkipDevices();
  const matterDevices = getMatterDevices();
  const debugMode = getDebugMode();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  await updatePluginConfig({
    email,
    baseURL,
    language: getLanguage(),
    skipDevices,
    matterDevices: matterDevices || undefined,
    // Always written as a string (possibly empty): an absent key means the
    // legacy "scenes enabled for every Matter device" default.
    matterSceneDevices: getMatterSceneDevices(),
    debugMode,
  });
}

async function login() {
  const email = getEmail();
  const password = getPassword();
  const baseURL = getBaseUrl();
  const result = await request("/auth/login", { email, password, baseURL });

  if (result.ok) {
    await updatePluginConfig({
      email,
      password,
      baseURL,
      encryptedToken: result.encryptedToken,
    });
    showToast("success", result.message || "Login successful.");
    setLoggedInState(true);
    return;
  }

  if (result.twoFactorRequired) {
    showToast(
      "warning",
      result.message || "Two-factor authentication required."
    );
    return;
  }

  showToast("error", result.message || "Login failed.");
}

async function sendTwoFactorEmail() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  const result = await request("/auth/send-2fa-email", { email, baseURL });
  if (result.ok) {
    showToast("success", result.message || "Verification email sent.");
  } else {
    showToast("error", result.message || "Failed to send verification email.");
  }
}

async function verifyTwoFactorCode() {
  const email = getEmail();
  const code = getCode();
  const baseURL = getBaseUrl();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }
  if (!code) {
    showToast("error", "Verification code is required.");
    return;
  }

  const result = await request("/auth/verify-2fa-code", {
    email,
    code,
    baseURL,
  });
  if (result.ok) {
    await updatePluginConfig({
      email,
      baseURL,
      encryptedToken: result.encryptedToken,
    });
    showToast("success", result.message || "Verification successful.");
    setLoggedInState(true);
  } else {
    showToast("error", result.message || "Verification failed.");
  }
}

async function logout() {
  const result = await request("/auth/logout");
  if (result.ok) {
    await updatePluginConfig({ encryptedToken: undefined });
    showToast("success", result.message || "Logged out.");
    setLoggedInState(false);
  } else {
    showToast("error", result.message || "Logout failed.");
  }
}

function normalizeBaseUrl(value) {
  if (!value) {
    return "https://usiot.roborock.com";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `https://${value.replace(/\/+$/, "")}`;
}

function setLoggedInState(isLoggedIn) {
  elements.logout.classList.toggle("hidden", !isLoggedIn);
  elements.login.classList.toggle("hidden", isLoggedIn);
  elements.passwordRow.classList.toggle("hidden", isLoggedIn);
  elements.twoFactorSection.classList.toggle("hidden", isLoggedIn);
  elements.email.readOnly = isLoggedIn;
  elements.email.parentElement.classList.toggle("readonly", isLoggedIn);
  elements.baseUrl.disabled = isLoggedIn;
  elements.baseUrl.parentElement.classList.toggle("readonly", isLoggedIn);
}

async function updatePluginConfig(patch) {
  if (
    !window.homebridge ||
    typeof window.homebridge.getPluginConfig !== "function"
  ) {
    return;
  }

  const configs = await getPluginConfigs();
  if (!configs) {
    showBridgeStuckError();
    return;
  }
  let config = configs.find(
    (entry) => entry.platform === "RoborockVacuumPlatform"
  );
  if (!config) {
    config = { platform: "RoborockVacuumPlatform", name: "Roborock Vacuum" };
    configs.push(config);
  }

  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
  });

  await withTimeout(
    window.homebridge.updatePluginConfig(configs),
    REQUEST_TIMEOUT_MS,
    undefined
  );
  // config-ui-x 5.24.0 posts back a Promise for the config.save ack, which
  // fails structured cloning (DataCloneError) — the save itself succeeds but
  // the ack never arrives. Don't let that hang the page.
  await withTimeout(window.homebridge.savePluginConfig(), 3000, undefined);
}

// The Homebridge UI injects its themed stylesheet into this iframe shortly
// after "ready". Sample the theme's accent from a .primary-text probe once it
// lands, so native checkboxes follow the user's theme color (--rr-primary in
// styles.css). Retries because the injected stylesheet arrives asynchronously.
function adoptThemeAccent(attempt = 0) {
  const probe = document.createElement("span");
  probe.className = "primary-text";
  probe.style.display = "none";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  if (color && color !== getComputedStyle(document.body).color) {
    document.documentElement.style.setProperty("--rr-primary", color);
    return;
  }
  if (attempt < 10) {
    setTimeout(() => adoptThemeAccent(attempt + 1), 300);
  }
}

function init() {
  adoptThemeAccent();
  renderSkipDevices([]);
  loadConfig().catch(() => {
    showToast("error", "Failed to load current config.");
  });
  elements.login.addEventListener("click", login);
  elements.send2fa.addEventListener("click", sendTwoFactorEmail);
  elements.verify2fa.addEventListener("click", verifyTwoFactorCode);
  elements.logout.addEventListener("click", logout);
  elements.baseUrl.addEventListener("change", saveCredentials);
  elements.language.addEventListener("change", saveCredentials);
  elements.addSkipDevice.addEventListener("click", () => {
    addSkipDeviceRow();
  });
  elements.loadDevices.addEventListener("click", () => {
    // Explicit button press always bypasses the cache.
    loadDevices(true).catch(() => {
      showToast("error", "Failed to load devices.");
    });
  });
  elements.debugMode.addEventListener("change", saveCredentials);
  elements.email.addEventListener("change", saveCredentials);
  elements.matterChildBridge.addEventListener("change", () => {
    saveMatterChildBridge().catch(() => {
      showToast("error", "Failed to save the Matter bridge setting.");
    });
  });
  initMatterToggle().catch(() => {
    // Leave the Matter section hidden if status can't be determined.
  });
  elements.roomMqttEnabled.addEventListener("change", saveRoomMqtt);
  elements.roomMqttBroker.addEventListener("change", saveRoomMqtt);
  elements.roomMqttTopic.addEventListener("change", saveRoomMqtt);
  elements.roomMqttPoll.addEventListener("change", saveRoomMqtt);
}

if (window.homebridge) {
  window.homebridge.addEventListener("ready", () => {
    init();
  });
} else {
  document.addEventListener("DOMContentLoaded", init);
}
