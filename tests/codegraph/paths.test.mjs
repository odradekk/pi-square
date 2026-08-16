import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { resolveCodeGraphPath } = await load(join(packageRoot, "src", "codegraph", "paths.ts"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("CodeGraph preserves its legacy double-dot-prefix rejection", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-codegraph-legacy-path-"));
  mkdirSync(join(workspace, "..inside"));
  try {
    assert.throws(
      () => resolveCodeGraphPath(workspace, "..inside"),
      (error) => error?.code === "PATH_OUTSIDE_WORKSPACE",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} - ${error instanceof Error ? error.stack : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed) process.exit(1);
