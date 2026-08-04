import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import jiti from "jiti";

const root = resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.deepEqual(pkg.exports, {
  ".": "./src/index.ts",
  "./display": "./src/display-api.ts",
  "./package.json": "./package.json",
});

const load = jiti(import.meta.url, { moduleCache: false });
const display = await load.import("@odradekk/pi-square/display");
assert.equal(display.TOOL_DISPLAY_ADAPTER_VERSION, 1);
assert.equal(display.TOOL_DISPLAY_ADAPTER_QUEUE_MAX, 128);
assert.equal(typeof display.decorateToolForDisplay, "function");
assert.equal(typeof display.validateToolDisplayAdapterV1, "function");
assert.equal(display.__testables, undefined, "internal adapter lifecycle helpers must not be public exports");
const extension = await load.import("@odradekk/pi-square");
assert.equal(typeof extension.default, "function");

console.log("source package display exports: OK");
