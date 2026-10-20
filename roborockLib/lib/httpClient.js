"use strict";

// Small HTTP client on Node's built-in fetch, covering what the Roborock
// cloud code needs from axios: a base URL, default headers
// (client.defaults.headers.common), query params, a timeout, a per-request
// signing hook, JSON or text response bodies, and axios-style errors
// (error.response = { status, headers, data } for a non-2xx answer).

function requestError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.isRequestError = true;
  return error;
}

function joinURL(baseURL, url) {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${baseURL.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

// sign(url) returns extra headers for a request, such as a Hawk
// Authorization header computed from the request path.
function createHttpClient({ baseURL = "", timeout = 0, headers = {}, sign }) {
  const client = {
    defaults: { headers: { common: { ...headers } } },
    get: (url, config) => request("GET", url, undefined, config),
    post: (url, data, config) => request("POST", url, data, config),
  };

  async function request(method, url, data, config = {}) {
    const target = new URL(joinURL(baseURL, url));
    for (const [key, value] of Object.entries(config.params || {})) {
      target.searchParams.append(key, value);
    }

    const requestHeaders = {
      ...client.defaults.headers.common,
      ...(sign ? sign(target) : {}),
      ...config.headers,
    };
    let body;
    if (data != null) {
      // Strings are URL-encoded forms here, as axios sends them by default.
      body = typeof data === "string" ? data : JSON.stringify(data);
      requestHeaders["Content-Type"] =
        typeof data === "string"
          ? "application/x-www-form-urlencoded"
          : "application/json";
    }

    let res;
    let text;
    try {
      res = await fetch(target, {
        method,
        headers: requestHeaders,
        body,
        signal: timeout ? AbortSignal.timeout(timeout) : undefined,
      });
      text = await res.text();
    } catch (error) {
      throw requestError(
        error && error.name === "TimeoutError"
          ? `timeout of ${timeout}ms exceeded`
          : (error && error.cause && error.cause.message) ||
              (error && error.message) ||
              String(error),
        error
      );
    }

    let responseData = text;
    try {
      responseData = JSON.parse(text);
    } catch (error) {
      // Not JSON: keep the text.
    }
    const response = {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      data: responseData,
    };
    if (!res.ok) {
      const error = requestError(
        `Request failed with status code ${res.status}`
      );
      error.response = response;
      throw error;
    }
    return response;
  }

  return client;
}

module.exports = { createHttpClient };
