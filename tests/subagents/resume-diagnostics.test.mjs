import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPromptSnapshot, loadToolModule, run, test } from "./lib/test-helpers.mjs";

const { registerSubagentTool } = await loadToolModule();

const ID = "subagent_00000000-0000-4000-8000-000000000091";
const agentRoot = join(tmpdir(), `pi-square-resume-tool-${process.pid}-${Date.now()}`);
process.env.PI_AGENT_DIR = agentRoot;
mkdirSync(agentRoot, { recursive: true });

// The activity lease is imported lazily through the real lease seam so the
// conflict below reflects a genuinely held lease, not a mock.
const { tryAcquireRunLease } = await import("jiti").then(({ default: jiti }) =>
  jiti(import.meta.url, { moduleCache: false })(join(process.cwd(), "src", "subagents", "lease.ts")));

function tool() {
  const tools = new Map();
  registerSubagentTool({
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    registerCommand() {},
    getThinkingLevel() { return "off"; },
  }, {
    registry: { definitions: [], errors: [], projectDir: null },
    background: { jobs: new Map(), listeners: new Set() },
  });
  return tools.get("resume_subagent");
}

const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-resume-session", getBranch: () => [] } };

function writeValidRun() {
  const artifactsDir = join(agentRoot, "state", "subagents", ID);
  const sessionFile = join(artifactsDir, "session.jsonl");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "native-91", timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`, "utf8");
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify({
    version: 3,
    id: ID,
    mode: "bg",
    artifactsDir,
    sessionFile,
    sessionId: "native-91",
    originParentSessionId: "parent-resume-session",
    lastParentSessionId: "parent-resume-session",
    promptSnapshot: createPromptSnapshot(),
    phase: "done",
    task: "task",
    cwd: "/tmp",
    startedAt: 1,
    endedAt: 2,
    finalText: "done",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    timeline: [],
  }, null, 2), "utf8");
  return { artifactsDir, sessionFile };
}

test("an effective activity lease is rejected as a specific tool error before queueing", async () => {
  writeValidRun();
  const lease = tryAcquireRunLease(ID);
  assert.equal(lease.acquired, true);
  try {
    const result = await tool().execute("resume-active", { id: ID, task: "continue" }, undefined, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "SUBAGENT_ACTIVE");
    assert.equal(result.details.error.operation, "resume");
    assert.equal(result.details.error.id, ID);
    assert.equal(result.details.error.retryable, true);
    assert.match(result.content[0].text, /active and cannot be resumed concurrently/);
    assert.match(result.content[0].text, /Wait for the active run to finish, or cancel it before retrying resume/);
  } finally {
    lease.lease.release();
  }
});

test("corrupt persisted history becomes a clear structured tool failure", async () => {
  const { artifactsDir } = writeValidRun();
  writeFileSync(join(artifactsDir, "run.json"), "{ broken", "utf8");
  const result = await tool().execute("resume-corrupt", { id: ID, task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SESSION_HISTORY_UNAVAILABLE");
  assert.equal(result.details.error.operation, "resume");
  assert.equal(result.details.error.id, ID);
  assert.match(result.content[0].text, /run\.json|history/i);
});

await run();
rmSync(agentRoot, { recursive: true, force: true });
