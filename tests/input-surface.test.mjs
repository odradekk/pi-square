import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { isOwnedInputSurfaceActive, withOwnedInputSurface } = await load(
  join(packageRoot, "src", "core", "input-surface.ts"),
);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("the marker is inactive until an owned surface opens", () => {
  assert.equal(isOwnedInputSurfaceActive(), false);
});

test("the marker covers the modal's lifetime and nests", async () => {
  await withOwnedInputSurface(async () => {
    assert.equal(isOwnedInputSurfaceActive(), true);
    await withOwnedInputSurface(async () => {
      assert.equal(isOwnedInputSurfaceActive(), true, "nested modals stay marked");
    });
    assert.equal(isOwnedInputSurfaceActive(), true, "the outer modal keeps the marker");
  });
  assert.equal(isOwnedInputSurfaceActive(), false);
});

test("the marker releases on rejection and never drops below zero", async () => {
  await withOwnedInputSurface(async () => {
    throw new Error("modal failed");
  }).catch(() => {});
  assert.equal(isOwnedInputSurfaceActive(), false, "a rejected modal releases the marker");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
