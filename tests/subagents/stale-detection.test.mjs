import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-subagents-stale-sdk-mock-${process.pid}.mjs`);
writeFileSync(mockSdkPath, `
export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }
`, "utf8");
const load = jiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": mockSdkPath,
  },
});
const { isStaleActiveRecord, STALE_RUNNING_THRESHOLD_MS } = await load(resolve(packageRoot, "src", "subagents", "status.ts"));

const now = 1_700_000_000_000;

test("phase=running, mtime=now is not stale", () => {
  assert.equal(isStaleActiveRecord({ phase: "running" }, now, now), false);
});

test("phase=running, mtime=now - 30min is not stale", () => {
  assert.equal(isStaleActiveRecord({ phase: "running" }, now - 30 * 60 * 1000, now), false);
});

test("phase=running just inside 1h boundary is not stale", () => {
  assert.equal(isStaleActiveRecord({ phase: "running" }, now - STALE_RUNNING_THRESHOLD_MS + 1, now), false);
});

test("phase=running just outside 1h boundary is stale", () => {
  assert.equal(isStaleActiveRecord({ phase: "running" }, now - STALE_RUNNING_THRESHOLD_MS - 1, now), true);
});

test("phase=running, mtime=now - 2h is stale", () => {
  assert.equal(isStaleActiveRecord({ phase: "running" }, now - 2 * STALE_RUNNING_THRESHOLD_MS, now), true);
});

test("phase=queued, mtime=now - 2h is stale like a dead running record", () => {
  assert.equal(isStaleActiveRecord({ phase: "queued" }, now - 2 * STALE_RUNNING_THRESHOLD_MS, now), true);
});

test("phase=completed is not stale even when old", () => {
  assert.equal(isStaleActiveRecord({ phase: "completed" }, now - 2 * STALE_RUNNING_THRESHOLD_MS, now), false);
});

test("phase=failed is not stale even when old", () => {
  assert.equal(isStaleActiveRecord({ phase: "failed" }, now - 2 * STALE_RUNNING_THRESHOLD_MS, now), false);
});

test("phase=undefined is not stale even when old", () => {
  assert.equal(isStaleActiveRecord({}, now - 2 * STALE_RUNNING_THRESHOLD_MS, now), false);
});

await run();
