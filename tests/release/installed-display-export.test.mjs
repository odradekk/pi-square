import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import jiti from "jiti";

const root = resolve(import.meta.dirname, "..", "..");
const temp = mkdtempSync(join(root, ".pi-square-packed-consumer-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", temp], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.equal(packed.length, 1);
  const archive = join(temp, packed[0].filename);
  const installed = join(temp, "node_modules", "@odradekk", "pi-square");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", installed, "--strip-components=1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedPackage.name, "@odradekk/pi-square");
  assert.equal(installedPackage.exports["./display"], "./src/display-api.ts");

  const consumer = join(temp, "consumer.mjs");
  writeFileSync(consumer, "// packed package export consumer\n");
  const load = jiti(consumer, { moduleCache: false });
  const rootExport = await load.import("@odradekk/pi-square");
  const displayExport = await load.import("@odradekk/pi-square/display");
  assert.equal(typeof rootExport.default, "function");
  assert.equal(typeof displayExport.decorateToolForDisplay, "function");
  assert.equal(displayExport.TOOL_DISPLAY_ADAPTER_VERSION, 1);
  console.log("packed consumer display exports: OK");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
