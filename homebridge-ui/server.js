"use strict";

const path = require("path");
const Module = require("module");

const homebridgeNodeModules = path.join(process.cwd(), "node_modules");
const nodePathEntries = process.env.NODE_PATH
  ? process.env.NODE_PATH.split(path.delimiter)
  : [];

if (!nodePathEntries.includes(homebridgeNodeModules)) {
  process.env.NODE_PATH = [homebridgeNodeModules, ...nodePathEntries]
    .filter(Boolean)
    .join(path.delimiter);
  Module._initPaths();
}

require("../dist/ui/index.js");
