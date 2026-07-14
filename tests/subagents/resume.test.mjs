import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { createPromptSnapshot, run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-resume-validation-sdk-${process.pid}.mjs`);
writeFileSync(mockSdkPath, `
export async function createAgentSession() { throw new Error("createAgentSession must not run in validation tests"); }
export function createExtensionRuntime() { return {}; }
export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }
export class DefaultResourceLoader { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: {} }; } getSkills() { return { skills: [] }; } getPrompts() { return { prompts: [], diagnostics: [] }; } getThemes() { return { themes: [], diagnostics: [] }; } getAgentsFiles() { return { agentsFiles: [] }; } getSystemPrompt() { return ""; } getAppendSystemPrompt() { return []; } extendResources() {} }
export const SessionManager = { open() { throw new Error("SessionManager.open must not run in validation tests"); } };
export const SettingsManager = { inMemory(value) { return value; } };
`, "utf8");

const load = jiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": mockSdkPath } });
const { resumeSubagentTask } = await load(join(packageRoot, "src", "subagents", "session.ts"));
const { tryAcquireRunLease } = await load(join(packageRoot, "src", "subagents", "lease.ts"));

const ID = "subagent_00000000-0000-4000-8000-000000000071";
const SESSION_ID = "native-session-71";

function root() {
  return join(tmpdir(), `pi-square-resume-validation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseDetails(agentRoot, overrides = {}) {
  const artifactsDir = join(agentRoot, "state", "subagents", ID);
  return {
    version: 3,
    id: ID,
    mode: "fg",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: SESSION_ID,
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
    phase: "error",
    task: "task",
    cwd: "/tmp/project",
    startedAt: 1,
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    ...overrides,
  };
}

function writeValidRun(agentRoot, overrides = {}) {
  const details = baseDetails(agentRoot, overrides);
  mkdirSync(details.artifactsDir, { recursive: true });
  writeFileSync(details.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: details.cwd })}\n`, "utf8");
  writeFileSync(join(details.artifactsDir, "run.json"), JSON.stringify(details, null, 2), "utf8");
  return details;
}

function ctx(agentRoot) {
  return {
    cwd: agentRoot,
    sessionManager: { getSessionId() { return "parent-session"; } },
    modelRegistry: { find() { return undefined; } },
  };
}

async function captureFailure(agentRoot, id = ID) {
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    await resumeSubagentTask({ ctx: ctx(agentRoot), id, task: "continue" });
  } catch (error) {
    return error;
  }
  throw new Error("resume unexpectedly resolved");
}

test("legacy IDs are rejected without compatibility lookup", async () => {
  const agentRoot = root();
  try {
    const error = await captureFailure(agentRoot, "subagent_1717945200000_001");
    assert.equal(error.info.code, "SUBAGENT_NOT_FOUND");
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("missing artifacts return SESSION_HISTORY_UNAVAILABLE", async () => {
  const agentRoot = root();
  try {
    const error = await captureFailure(agentRoot);
    assert.equal(error.info.code, "SESSION_HISTORY_UNAVAILABLE");
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("corrupt run.json fails before SessionManager.open", async () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    const dir = join(agentRoot, "state", "subagents", ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), "{ broken", "utf8");
    const error = await captureFailure(agentRoot);
    assert.equal(error.info.code, "SESSION_HISTORY_UNAVAILABLE");
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("missing and malformed JSONL fail before SessionManager.open", async () => {
  for (const variant of ["missing", "malformed"]) {
    const agentRoot = root();
    process.env.PI_AGENT_DIR = agentRoot;
    try {
      const details = writeValidRun(agentRoot);
      if (variant === "missing") rmSync(details.sessionFile, { force: true });
      else writeFileSync(details.sessionFile, "{ broken\n", "utf8");
      const error = await captureFailure(agentRoot);
      assert.equal(error.info.code, "SESSION_HISTORY_UNAVAILABLE");
    } finally {
      rmSync(agentRoot, { recursive: true, force: true });
    }
  }
});

test("an active ID returns already_running without opening the session", async () => {
  const agentRoot = root();
  process.env.PI_AGENT_DIR = agentRoot;
  try {
    writeValidRun(agentRoot, { phase: "running" });
    const lease = tryAcquireRunLease(ID);
    assert.equal(lease.acquired, true);
    const result = await resumeSubagentTask({ ctx: ctx(agentRoot), id: ID, task: "continue" });
    assert.equal(result.status, "already_running");
    assert.deepEqual(result.details, { status: "already_running", id: ID });
    lease.lease.release();
  } finally {
    rmSync(agentRoot, { recursive: true, force: true });
  }
});

await run();
