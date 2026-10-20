"use strict";

const crypto = require("crypto");
const { createHttpClient } = require("./httpClient");

const API_V3_SIGN = "api/v3/key/sign";
const API_V4_LOGIN_CODE = "api/v4/auth/email/login/code";
const API_V4_LOGIN_PASSWORD = "api/v4/auth/email/login/pwd";
const API_V4_EMAIL_CODE = "api/v4/email/code/send";
const API_V1_GET_URL_BY_EMAIL = "api/v1/getUrlByEmail";
const API_V3_AGREEMENT_LATEST = "api/v3/app/agreement/latest";

// User agreement version sent with a login when the latest one cannot be
// fetched (the value that used to be hardcoded).
const DEFAULT_AGREEMENT_VERSION = { majorVersion: 14, minorVersion: 0 };

// Hosts probed for account-region discovery. Any of them answers
// getUrlByEmail with the account's true regional endpoint; the list only
// provides fallbacks when a host is unreachable. Mirrors python-roborock.
const DISCOVERY_BASE_URLS = [
  "usiot.roborock.com",
  "euiot.roborock.com",
  "cniot.roborock.com",
  "ruiot.roborock.com",
];

const DEFAULT_HEADERS = {
  header_appversion: "4.54.02",
  header_clientlang: "en",
  header_phonemodel: "Pixel 7",
  header_phonesystem: "Android",
};

function normalizeBaseURL(baseURL) {
  if (!baseURL) {
    return "usiot.roborock.com";
  }
  return baseURL.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function getRegionConfig(baseURL) {
  const lower = normalizeBaseURL(baseURL).toLowerCase();
  if (lower.includes("euiot")) {
    return { country: "DE", countryCode: "49" };
  }
  if (lower.includes("usiot")) {
    return { country: "US", countryCode: "1" };
  }
  if (lower.includes("cniot")) {
    return { country: "CN", countryCode: "86" };
  }
  if (lower.includes("api.roborock.com")) {
    return { country: "SG", countryCode: "65" };
  }
  return { country: "US", countryCode: "1" };
}

// Credentials must only ever be sent to Roborock's own infrastructure, even
// if a discovery response were tampered with or the API changed shape.
function isRoborockHost(baseURL) {
  const host = normalizeBaseURL(baseURL).split("/")[0].toLowerCase();
  return host === "roborock.com" || host.endsWith(".roborock.com");
}

/**
 * Resolve the account's regional API endpoint (and registered country) from
 * its email via getUrlByEmail. Returns { baseURL, country, countryCode } or
 * null; never throws — callers fall back to the configured/default endpoint.
 */
async function discoverAccountRegion(email, log) {
  for (const host of DISCOVERY_BASE_URLS) {
    try {
      const res = await createHttpClient({ timeout: 10000 }).post(
        `https://${host}/${API_V1_GET_URL_BY_EMAIL}`,
        null,
        { params: { email, needtwostepauth: "false" } }
      );
      const body = res && res.data;
      if (!body || body.code !== 200 || !body.data || !body.data.url) {
        if (log && log.debug) {
          log.debug(
            `Region discovery via ${host} answered code ${body && body.code}: ${(body && body.msg) || "no data"}`
          );
        }
        continue;
      }

      if (!isRoborockHost(body.data.url)) {
        if (log && log.warn) {
          log.warn(
            `Region discovery returned a non-Roborock endpoint ('${body.data.url}'); ignoring it.`
          );
        }
        return null;
      }

      return {
        baseURL: normalizeBaseURL(body.data.url),
        country: body.data.country || null,
        countryCode:
          body.data.countrycode != null && body.data.countrycode !== ""
            ? String(body.data.countrycode)
            : null,
      };
    } catch (error) {
      if (log && log.debug) {
        log.debug(
          `Region discovery via ${host} failed: ${error && error.message}`
        );
      }
    }
  }

  return null;
}

function encryptPassword(password, k) {
  const derivedKey = k.slice(4) + k.slice(0, 4);
  const cipher = crypto.createCipheriv(
    "aes-128-ecb",
    Buffer.from(derivedKey, "utf-8"),
    null
  );
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(password, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

function createLoginApi({ baseURL, username, clientID, language }) {
  return createHttpClient({
    baseURL: `https://${normalizeBaseURL(baseURL)}`,
    // Fail with a real error instead of hanging: the config UI budgets 60s
    // per action, and login/2FA-verify chain two requests through this client.
    timeout: 20000,
    headers: {
      header_clientid: crypto
        .createHash("md5")
        .update(username)
        .update(clientID)
        .digest()
        .toString("base64"),
      header_clientlang: language || DEFAULT_HEADERS.header_clientlang,
      header_appversion: DEFAULT_HEADERS.header_appversion,
      header_phonemodel: DEFAULT_HEADERS.header_phonemodel,
      header_phonesystem: DEFAULT_HEADERS.header_phonesystem,
    },
  });
}

async function signRequest(loginApi, s) {
  const res = await loginApi.post(`${API_V3_SIGN}?s=${s}`);
  return res.data && res.data.data ? res.data.data : null;
}

async function requestEmailCode(loginApi, email) {
  const params = new URLSearchParams();
  params.append("type", "login");
  params.append("email", email);
  params.append("platform", "");

  try {
    const res = await loginApi.post(API_V4_EMAIL_CODE, params.toString());
    if (res.data && res.data.code !== 200) {
      throw new Error(
        `Send code failed: ${res.data.msg || "Unknown error"} (Code: ${res.data.code})`
      );
    }
    return res.data;
  } catch (error) {
    if (error.response && error.response.data) {
      throw new Error(
        `Send code failed: ${JSON.stringify(error.response.data)}`
      );
    }
    throw error;
  }
}

/**
 * Latest user agreement version for a country. The login endpoint rejects a
 * stale version with code 3006 ("user agreement version is not up-to-date"),
 * and the current version differs per server and country, so it is looked up
 * instead of hardcoded. Falls back to DEFAULT_AGREEMENT_VERSION so a failed
 * lookup never blocks a login. Mirrors python-roborock.
 */
async function getAgreementVersion(loginApi, country) {
  try {
    const res = await loginApi.get(API_V3_AGREEMENT_LATEST, {
      params: { country },
      headers: { header_clientlang: "en" },
    });
    const body = res && res.data;
    const data = body && body.code === 200 ? body.data : null;
    if (
      data &&
      Number.isInteger(data.majorVersion) &&
      Number.isInteger(data.minorVersion)
    ) {
      return {
        majorVersion: data.majorVersion,
        minorVersion: data.minorVersion,
      };
    }
  } catch (error) {
    // Fall through to the default version.
  }
  return { ...DEFAULT_AGREEMENT_VERSION };
}

async function agreementParams(loginApi, country) {
  const { majorVersion, minorVersion } = await getAgreementVersion(
    loginApi,
    country
  );
  return {
    majorVersion: String(majorVersion),
    minorVersion: String(minorVersion),
  };
}

async function loginWithCode(
  loginApi,
  { email, code, country, countryCode, k, s }
) {
  const headers = {
    "x-mercy-k": k,
    "x-mercy-ks": s,
  };

  const params = new URLSearchParams({
    country,
    countryCode,
    email,
    code,
    ...(await agreementParams(loginApi, country)),
  });

  try {
    const res = await loginApi.post(API_V4_LOGIN_CODE, params.toString(), {
      headers,
    });
    return res.data;
  } catch (error) {
    if (error.response && error.response.data) {
      return error.response.data;
    }
    throw error;
  }
}

async function loginByPassword(loginApi, { email, password, country, k, s }) {
  const headers = {
    "x-mercy-k": k,
    "x-mercy-ks": s,
  };

  const params = new URLSearchParams({
    email,
    password: encryptPassword(password, k),
    ...(await agreementParams(loginApi, country)),
  });

  try {
    const res = await loginApi.post(API_V4_LOGIN_PASSWORD, params.toString(), {
      headers,
    });
    return res.data;
  } catch (error) {
    if (error.response && error.response.data) {
      return error.response.data;
    }
    throw error;
  }
}

module.exports = {
  createLoginApi,
  discoverAccountRegion,
  getAgreementVersion,
  getRegionConfig,
  normalizeBaseURL,
  signRequest,
  requestEmailCode,
  loginWithCode,
  loginByPassword,
};
