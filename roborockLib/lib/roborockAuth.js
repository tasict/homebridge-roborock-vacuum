"use strict";

const crypto = require("crypto");
const axios = require("axios");

const API_V3_SIGN = "api/v3/key/sign";
const API_V4_LOGIN_CODE = "api/v4/auth/email/login/code";
const API_V4_LOGIN_PASSWORD = "api/v4/auth/email/login/pwd";
const API_V4_EMAIL_CODE = "api/v4/email/code/send";

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

function encryptPassword(password, k) {
	const derivedKey = k.slice(4) + k.slice(0, 4);
	const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(derivedKey, "utf-8"), null);
	cipher.setAutoPadding(true);
	let encrypted = cipher.update(password, "utf8", "base64");
	encrypted += cipher.final("base64");
	return encrypted;
}

function createLoginApi({ baseURL, username, clientID, language }) {
	return axios.create({
		baseURL: `https://${normalizeBaseURL(baseURL)}`,
		headers: {
			header_clientid: crypto.createHash("md5").update(username).update(clientID).digest().toString("base64"),
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
			throw new Error(`Send code failed: ${res.data.msg || "Unknown error"} (Code: ${res.data.code})`);
		}
		return res.data;
	} catch (error) {
		if (error.response && error.response.data) {
			throw new Error(`Send code failed: ${JSON.stringify(error.response.data)}`);
		}
		throw error;
	}
}

async function loginWithCode(loginApi, { email, code, country, countryCode, k, s }) {
	const headers = {
		"x-mercy-k": k,
		"x-mercy-ks": s,
	};

	const params = new URLSearchParams({
		country,
		countryCode,
		email,
		code,
		majorVersion: "14",
		minorVersion: "0",
	});

	try {
		const res = await loginApi.post(API_V4_LOGIN_CODE, params.toString(), { headers });
		return res.data;
	} catch (error) {
		if (error.response && error.response.data) {
			return error.response.data;
		}
		throw error;
	}
}

async function loginByPassword(loginApi, { email, password, k, s }) {
	const headers = {
		"x-mercy-k": k,
		"x-mercy-ks": s,
	};

	const params = new URLSearchParams({
		email,
		password: encryptPassword(password, k),
		majorVersion: "14",
		minorVersion: "0",
	});

	try {
		const res = await loginApi.post(API_V4_LOGIN_PASSWORD, params.toString(), { headers });
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
	getRegionConfig,
	normalizeBaseURL,
	signRequest,
	requestEmailCode,
	loginWithCode,
	loginByPassword,
};
