import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { listRunDirs } = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const ID = "subagent_00000000-0000-4000-8000-000000000111";

function root() {
  return join(tmpdir(), `pi-square-retention-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("extension startup contains no automatic artifact cleanup", () => {
  const source = readFileSync(join(packageRoot, "src", "subagents", "index.ts"), "utf8");
  assert.doesNotMatch(source, /cleanupOldRuns|\.\/ttl/);
  assert.equal(existsSync(join(packageRoot, "src", "subagents", "ttl.ts")), false);
});

test("old valid artifact directories remain discoverable", () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    const dir = join(agentRoot, "state", "subagents", ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), "{}", "utf8");
    const old = (Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(dir, old, old);
    assert.deepEqual(listRunDirs(), [resolve(dir)]);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

await run();
