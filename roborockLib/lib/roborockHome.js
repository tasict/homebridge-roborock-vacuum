"use strict";

const crypto = require("crypto");
const axios = require("axios");
const roborockAuth = require("./roborockAuth");

function md5hex(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

// Build an axios instance that signs each request with the rriot Hawk
// credentials, mirroring the signing the main plugin uses for the Roborock
// "real" API (see roborockAPI.js initUser).
function createSignedApi(rriot) {
  const api = axios.create({ baseURL: rriot.r.a });
  api.interceptors.request.use((config) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto
      .randomBytes(6)
      .toString("base64")
      .substring(0, 6)
      .replace("+", "X")
      .replace("/", "Y");
    const url = new URL(api.getUri(config));
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
    return config;
  });
  return api;
}

// Read-only: fetch the account's devices (owned + shared) so the config UI can
// let the user pick which to skip instead of typing raw device IDs. The caller
// is responsible for providing a valid, already-decrypted userData; network or
// auth failures reject so the UI can surface a message.
async function fetchDevices({ baseURL, username, clientID, userData }) {
  if (!userData || !userData.token || !userData.rriot) {
    throw new Error("Not logged in.");
  }

  const loginApi = roborockAuth.createLoginApi({
    baseURL,
    username,
    clientID,
    language: "en",
  });
  loginApi.defaults.headers.common["Authorization"] = userData.token;

  const homeDetail = await loginApi.get("api/v1/getHomeDetail");
  const homeId =
    homeDetail && homeDetail.data && homeDetail.data.data
      ? homeDetail.data.data.rrHomeId
      : null;
  if (!homeId) {
    throw new Error("Failed to resolve the Roborock home id.");
  }

  const api = createSignedApi(userData.rriot);
  const homedata = await api.get(`v2/user/homes/${homeId}`);
  const result = (homedata && homedata.data && homedata.data.result) || {};

  const products = result.products || [];
  const modelOf = (productId) => {
    const product = products.find((entry) => entry.id == productId);
    return product ? product.model : null;
  };

  const toEntry = (device, shared) => ({
    duid: device.duid,
    name: device.name,
    model: modelOf(device.productId),
    shared,
  });

  const owned = (result.devices || []).map((device) => toEntry(device, false));
  const received = (result.receivedDevices || []).map((device) =>
    toEntry(device, true)
  );

  return owned.concat(received);
}

module.exports = { fetchDevices };
