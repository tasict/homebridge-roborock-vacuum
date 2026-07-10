"use strict";

const crypto = require("crypto");

// Lazily generated, process-wide RSA-2048 keypair in the hex format the
// Roborock photo protocol expects. Only get_photo/secure requests need it, so
// nothing is generated at startup, and generation uses the async native
// implementation instead of node-forge's synchronous pure-JS one (which
// blocked the event loop for seconds per call on low-power hosts).
let keysPromise = null;

function jwkToHex(value) {
  // Match node-forge's BigInteger.toString(16): no leading zero digits
  // (e.g. e = 65537 must serialize as "10001", not "010001").
  const hex = Buffer.from(value, "base64url").toString("hex");
  return hex.replace(/^0+(?=.)/, "");
}

function generateKeys() {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      "rsa",
      { modulusLength: 2048 },
      (error, publicKey, privateKey) => {
        if (error) {
          reject(error);
          return;
        }

        const jwk = privateKey.export({ format: "jwk" });
        resolve({
          public: {
            n: jwkToHex(jwk.n),
            e: jwkToHex(jwk.e),
          },
          private: {
            n: jwkToHex(jwk.n),
            e: jwkToHex(jwk.e),
            d: jwkToHex(jwk.d),
            p: jwkToHex(jwk.p),
            q: jwkToHex(jwk.q),
            dmp1: jwkToHex(jwk.dp),
            dmq1: jwkToHex(jwk.dq),
            coeff: jwkToHex(jwk.qi),
          },
          publicKey,
          privateKey,
        });
      }
    );
  });
}

function getRsaKeys() {
  if (!keysPromise) {
    keysPromise = generateKeys().catch((error) => {
      keysPromise = null; // allow a retry on the next request
      throw error;
    });
  }

  return keysPromise;
}

module.exports = { getRsaKeys };
