const elements = {
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  passwordRow: document.getElementById("password-row"),
  baseUrl: document.getElementById("base-url"),
  skipDevices: document.getElementById("skip-devices"),
  addSkipDevice: document.getElementById("add-skip-device"),
  debugMode: document.getElementById("debug-mode"),
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
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

async function request(path, body) {
  try {
    return await window.homebridge.request(path, body);
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

  const configs = await window.homebridge.getPluginConfig();
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
  renderSkipDevices(config.skipDevices);
  elements.debugMode.checked = Boolean(config.debugMode);

  const roomMqtt = config.currentRoomMqtt || {};
  elements.roomMqttEnabled.checked = Boolean(roomMqtt.enabled);
  elements.roomMqttBroker.value = roomMqtt.brokerUrl || "";
  elements.roomMqttTopic.value = roomMqtt.topic || "";
  elements.roomMqttPoll.value =
    roomMqtt.cleaningPollSeconds != null ? roomMqtt.cleaningPollSeconds : "";

  setLoggedInState(Boolean(config.encryptedToken));
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

function getSkipDevices() {
  return getSkipDeviceInputs()
    .map((input) => input.value.trim())
    .filter((entry) => entry)
    .join(",");
}

function getDebugMode() {
  return Boolean(elements.debugMode.checked);
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

async function saveCredentials() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  const skipDevices = getSkipDevices();
  const debugMode = getDebugMode();
  if (!email) {
    showToast("error", "Email is required.");
    return;
  }

  await updatePluginConfig({
    email,
    baseURL,
    skipDevices,
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

  const configs = await window.homebridge.getPluginConfig();
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

  await window.homebridge.updatePluginConfig(configs);
  await window.homebridge.savePluginConfig();
}

function init() {
  renderSkipDevices([]);
  loadConfig().catch(() => {
    showToast("error", "Failed to load current config.");
  });
  elements.login.addEventListener("click", login);
  elements.send2fa.addEventListener("click", sendTwoFactorEmail);
  elements.verify2fa.addEventListener("click", verifyTwoFactorCode);
  elements.logout.addEventListener("click", logout);
  elements.baseUrl.addEventListener("change", saveCredentials);
  elements.addSkipDevice.addEventListener("click", () => {
    addSkipDeviceRow();
  });
  elements.debugMode.addEventListener("change", saveCredentials);
  elements.email.addEventListener("change", saveCredentials);
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
