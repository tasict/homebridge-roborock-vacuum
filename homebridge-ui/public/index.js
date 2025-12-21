const elements = {
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  passwordRow: document.getElementById('password-row'),
  baseUrl: document.getElementById('base-url'),
  skipDevices: document.getElementById('skip-devices'),
  debugMode: document.getElementById('debug-mode'),
  code: document.getElementById('two-factor-code'),
  login: document.getElementById('login'),
  logout: document.getElementById('logout'),
  send2fa: document.getElementById('send-2fa'),
  verify2fa: document.getElementById('verify-2fa'),
  twoFactorSection: document.getElementById('two-factor-section'),
  toastContainer: document.getElementById('toast-container'),
};

function showToast(type, message) {
  if (window.homebridge && window.homebridge.toast && typeof window.homebridge.toast[type] === 'function') {
    window.homebridge.toast[type](message);
    return;
  }

  const toast = document.createElement('div');
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
    return { ok: false, message: error.message || 'Request failed.' };
  }
}

async function loadConfig() {
  if (!window.homebridge || typeof window.homebridge.getPluginConfig !== 'function') {
    return;
  }

  const configs = await window.homebridge.getPluginConfig();
  const config = configs.find((entry) => entry.platform === 'RoborockVacuumPlatform');
  if (!config) {
    return;
  }

  if (config.email) {
    elements.email.value = config.email;
  }
  elements.baseUrl.value = normalizeBaseUrl(config.baseURL || 'https://usiot.roborock.com');
  if (config.skipDevices) {
    elements.skipDevices.value = config.skipDevices;
  }
  elements.debugMode.checked = Boolean(config.debugMode);

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
  return elements.skipDevices.value.trim();
}

function getDebugMode() {
  return Boolean(elements.debugMode.checked);
}

function getCode() {
  return elements.code.value.trim();
}

async function saveCredentials() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  const skipDevices = getSkipDevices();
  const debugMode = getDebugMode();
  if (!email) {
    showToast('error', 'Email is required.');
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
  const result = await request('/auth/login', { email, password, baseURL });

  if (result.ok) {
    await updatePluginConfig({
      email,
      password,
      baseURL,
      encryptedToken: result.encryptedToken,
    });
    showToast('success', result.message || 'Login successful.');
    setLoggedInState(true);
    return;
  }

  if (result.twoFactorRequired) {
    showToast('warning', result.message || 'Two-factor authentication required.');
    return;
  }

  showToast('error', result.message || 'Login failed.');
}

async function sendTwoFactorEmail() {
  const email = getEmail();
  const baseURL = getBaseUrl();
  if (!email) {
    showToast('error', 'Email is required.');
    return;
  }

  const result = await request('/auth/send-2fa-email', { email, baseURL });
  if (result.ok) {
    showToast('success', result.message || 'Verification email sent.');
  } else {
    showToast('error', result.message || 'Failed to send verification email.');
  }
}

async function verifyTwoFactorCode() {
  const email = getEmail();
  const code = getCode();
  const baseURL = getBaseUrl();
  if (!email) {
    showToast('error', 'Email is required.');
    return;
  }
  if (!code) {
    showToast('error', 'Verification code is required.');
    return;
  }

  const result = await request('/auth/verify-2fa-code', { email, code, baseURL });
  if (result.ok) {
    await updatePluginConfig({
      email,
      baseURL,
      encryptedToken: result.encryptedToken,
    });
    showToast('success', result.message || 'Verification successful.');
    setLoggedInState(true);
  } else {
    showToast('error', result.message || 'Verification failed.');
  }
}

async function logout() {
  const result = await request('/auth/logout');
  if (result.ok) {
    await updatePluginConfig({ encryptedToken: undefined });
    showToast('success', result.message || 'Logged out.');
    setLoggedInState(false);
  } else {
    showToast('error', result.message || 'Logout failed.');
  }
}

function normalizeBaseUrl(value) {
  if (!value) {
    return 'https://usiot.roborock.com';
  }
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value.replace(/\/+$/, '');
  }
  return `https://${value.replace(/\/+$/, '')}`;
}

function setLoggedInState(isLoggedIn) {
  elements.logout.classList.toggle('hidden', !isLoggedIn);
  elements.login.classList.toggle('hidden', isLoggedIn);
  elements.passwordRow.classList.toggle('hidden', isLoggedIn);
  elements.twoFactorSection.classList.toggle('hidden', isLoggedIn);
  elements.email.readOnly = isLoggedIn;
  elements.email.parentElement.classList.toggle('readonly', isLoggedIn);
}

async function updatePluginConfig(patch) {
  if (!window.homebridge || typeof window.homebridge.getPluginConfig !== 'function') {
    return;
  }

  const configs = await window.homebridge.getPluginConfig();
  let config = configs.find((entry) => entry.platform === 'RoborockVacuumPlatform');
  if (!config) {
    config = { platform: 'RoborockVacuumPlatform', name: 'Roborock Vacuum' };
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
  loadConfig().catch(() => {
    showToast('error', 'Failed to load current config.');
  });
  elements.login.addEventListener('click', login);
  elements.send2fa.addEventListener('click', sendTwoFactorEmail);
  elements.verify2fa.addEventListener('click', verifyTwoFactorCode);
  elements.logout.addEventListener('click', logout);
  elements.baseUrl.addEventListener('change', saveCredentials);
  elements.skipDevices.addEventListener('change', saveCredentials);
  elements.debugMode.addEventListener('change', saveCredentials);
  elements.email.addEventListener('change', saveCredentials);
}

if (window.homebridge) {
  window.homebridge.addEventListener('ready', () => {
    init();
  });
} else {
  document.addEventListener('DOMContentLoaded', init);
}
