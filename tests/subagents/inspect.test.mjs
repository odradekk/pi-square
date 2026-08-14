import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { createPromptSnapshot, run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-inspect-sdk-${process.pid}.mjs`);
writeFileSync(mockSdkPath, `export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }`, "utf8");
const load = jiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": mockSdkPath } });
const { inspectRun } = await load(join(packageRoot, "src", "subagents", "inspect.ts"));
const { tryAcquireRunLease } = await load(join(packageRoot, "src", "subagents", "lease.ts"));

const ID = "subagent_00000000-0000-4000-8000-000000000101";
const SESSION_ID = "native-inspect";

function root() {
  return join(tmpdir(), `pi-square-inspect-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function writeRun(agentRoot, overrides = {}) {
  const artifactsDir = join(agentRoot, "state", "subagents", ID);
  const sessionFile = join(artifactsDir, "session.jsonl");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: agentRoot })}\n`, "utf8");
  const details = {
    version: 3,
    id: ID,
    mode: "fg",
    artifactsDir,
    sessionFile,
    sessionId: SESSION_ID,
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
    phase: "done",
    task: "inspect task",
    cwd: agentRoot,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    finalText: "latest assistant text",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [{ kind: "assistant", text: "latest assistant text" }],
    ...overrides,
  };
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify(details, null, 2), "utf8");
  return { artifactsDir, details };
}

test("completed runs are resumable when inactive", () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    writeRun(agentRoot);
    const report = inspectRun(ID, 1_700_000_020_000);
    assert.equal(report.resumable, true);
    assert.equal(report.active, false);
    assert.match(report.rendered, /same ID and native session history/);
    assert.match(report.rendered, /resume\(\{ id:/);
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("active runs are reported as SUBAGENT_ACTIVE and not resumable", () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    writeRun(agentRoot, { phase: "running" });
    const lease = tryAcquireRunLease(ID);
    assert.equal(lease.acquired, true);
    const report = inspectRun(ID);
    assert.equal(report.active, true);
    assert.equal(report.resumable, false);
    assert.equal(report.resumeBlockReason, "subagent_active");
    assert.match(report.rendered, /SUBAGENT_ACTIVE/);
    lease.lease.release();
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("inactive running metadata becomes stale without blocking resume", () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    const { artifactsDir } = writeRun(agentRoot, { phase: "running" });
    const now = 1_700_010_000_000;
    utimesSync(artifactsDir, (now - 2 * 60 * 60 * 1000) / 1000, (now - 2 * 60 * 60 * 1000) / 1000);
    const report = inspectRun(ID, now);
    assert.equal(report.isStale, true);
    assert.equal(report.resumable, true);
    assert.match(report.rendered, /inactive stale record/);
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("invalid history returns the structured session-history error", () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    const { details } = writeRun(agentRoot);
    writeFileSync(details.sessionFile, "{ broken\n", "utf8");
    assert.throws(() => inspectRun(ID), /SESSION_HISTORY_UNAVAILABLE/);
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

await run();
