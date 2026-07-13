import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test, waitFor } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const jitiPath = resolve(packageRoot, "node_modules", "jiti", "lib", "jiti.mjs");
const load = jiti(import.meta.url, { moduleCache: false });
const { ensureArtifactsDir } = await load(resolve(packageRoot, "src", "subagents", "artifacts.ts"));
const { isRunLeaseActive, tryAcquireRunLease } = await load(resolve(packageRoot, "src", "subagents", "lease.ts"));
const ID = "subagent_00000000-0000-4000-8000-000000000011";

function makeTempRoot() {
  return join(tmpdir(), `pi-square-lease-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("a second acquisition returns active without waiting or throwing", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  try {
    ensureArtifactsDir(ID);
    const first = tryAcquireRunLease(ID);
    assert.equal(first.acquired, true);
    assert.equal(isRunLeaseActive(ID), true);

    const second = tryAcquireRunLease(ID);
    assert.equal(second.acquired, false);

    first.lease.release();
    assert.equal(isRunLeaseActive(ID), false);
    const third = tryAcquireRunLease(ID);
    assert.equal(third.acquired, true);
    third.lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead owner lease is reclaimed across processes", async () => {
  const root = makeTempRoot();
  const childScript = join(tmpdir(), `pi-square-lease-child-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(childScript, `
import jiti from ${JSON.stringify(jitiPath)};
process.env.PI_AGENT_DIR = ${JSON.stringify(root)};
const load = jiti(import.meta.url, { moduleCache: false });
const { ensureArtifactsDir } = await load(${JSON.stringify(resolve(packageRoot, "src", "subagents", "artifacts.ts"))});
const { tryAcquireRunLease } = await load(${JSON.stringify(resolve(packageRoot, "src", "subagents", "lease.ts"))});
ensureArtifactsDir(${JSON.stringify(ID)});
const result = tryAcquireRunLease(${JSON.stringify(ID)});
if (!result.acquired) process.exit(2);
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`, "utf8");

  const child = spawn(process.execPath, [childScript], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  try {
    await waitFor(() => output.includes("ready"), "child lease acquisition", 3000);
    process.env.PI_AGENT_DIR = root;
    ensureArtifactsDir(ID);
    assert.equal(tryAcquireRunLease(ID).acquired, false);

    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
    const reclaimed = tryAcquireRunLease(ID);
    assert.equal(reclaimed.acquired, true);
    reclaimed.lease.release();
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    rmSync(childScript, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

await run();
