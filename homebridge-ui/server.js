"use strict";

// @homebridge/plugin-ui-utils v2+ ships as an ES module, which CommonJS
// code cannot load synchronously. This file is never compiled, so the
// native dynamic import below survives as written; the module specifier is
// a fixed string literal. Once loaded, the constructor is handed to the
// compiled server implementation in dist/ui.
(async () => {
  const { HomebridgePluginUiServer } = await import(
    "@homebridge/plugin-ui-utils"
  );
  const { startUiServer } = require("../dist/ui/index.js");
  startUiServer(HomebridgePluginUiServer);
})().catch((error) => {
  console.error(
    "Failed to start the Roborock plugin UI server:",
    error && error.message ? error.message : error
  );
  process.exit(1);
});
