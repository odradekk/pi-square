import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPromptSnapshot,
  getRunSubagentTaskCalls,
  loadBackgroundModule,
  loadToolModule,
  run,
  setRunSubagentTaskMock,
  test,
} from "./lib/test-helpers.mjs";

const { registerSubagentTool } = await loadToolModule();
const { createBackgroundState } = await loadBackgroundModule();

const agentRoot = join(tmpdir(), `pi-square-subagent-tool-${process.pid}-${Date.now()}`);
process.env.PI_AGENT_DIR = agentRoot;
mkdirSync(agentRoot, { recursive: true });

function createRuntimeState() {
  return {
    registry: { definitions: [], errors: [], projectDir: null },
    background: createBackgroundState(),
  };
}

function createPiRecorder() {
  const tools = new Map();
  return {
    tools,
    api: {
      registerTool(definition) { tools.set(definition.name, definition); },
      registerMessageRenderer() {},
      registerCommand() {},
      getThinkingLevel() { return "off"; },
    },
  };
}

function registered() {
  const pi = createPiRecorder();
  registerSubagentTool(pi.api, createRuntimeState());
  return pi;
}

function delegateTool() {
  const pi = registered();
  const tool = pi.tools.get("delegate_subagent");
  assert.ok(tool);
  return tool;
}

function resumeTool() {
  const pi = registered();
  const tool = pi.tools.get("resume_subagent");
  assert.ok(tool);
  return tool;
}

const PARENT_SESSION = "parent-session";

function delegateCtx() {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => PARENT_SESSION, getBranch: () => [] },
  };
}

function writePersistedRun(id) {
  const artifactsDir = join(agentRoot, "state", "subagents", id);
  const sessionFile = join(artifactsDir, "session.jsonl");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "native-1", timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`, "utf8");
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify({
    version: 4,
    id,
    operation: "delegate",
    artifactsDir,
    sessionFile,
    sessionId: "native-1",
    originParentSessionId: PARENT_SESSION,
    lastParentSessionId: PARENT_SESSION,
    promptSnapshot: createPromptSnapshot(),
    phase: "completed",
    agent: { promptVersion: 2, name: "worker", inheritParentSystem: true },
    task: "initial",
    cwd: "/tmp",
    startedAt: 1,
    endedAt: 2,
    finalText: "done",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    timeline: [],
  }, null, 2), "utf8");
  return artifactsDir;
}

test("registerSubagentTool exposes the delegate_subagent, resume_subagent, and wait_subagent tools", () => {
  const pi = registered();
  assert.deepEqual([...pi.tools.keys()], ["wait_subagent", "delegate_subagent", "resume_subagent"]);
  const waitSchema = pi.tools.get("wait_subagent").parameters;
  assert.equal(waitSchema.additionalProperties, false);
  assert.equal(waitSchema.anyOf, undefined);
  assert.deepEqual(waitSchema.required, ["ids"]);
  assert.equal(waitSchema.properties.ids.maxItems, 6);
  const delegateSchema = pi.tools.get("delegate_subagent").parameters;
  assert.equal(delegateSchema.additionalProperties, false);
  assert.ok(delegateSchema.properties.context);
  assert.ok(delegateSchema.properties.agent);
  assert.ok(delegateSchema.properties.model);
  assert.ok(delegateSchema.properties.thinkingLevel);
  // Regression: GPT models via the OpenAI Responses API populate every declared
  // property, so id must stay out of the delegation schema entirely.
  assert.equal(delegateSchema.properties.id, undefined);
  assert.deepEqual(delegateSchema.required, ["task"]);
  const resumeSchema = pi.tools.get("resume_subagent").parameters;
  assert.equal(resumeSchema.additionalProperties, false);
  assert.deepEqual(resumeSchema.required, ["id", "task"]);
  for (const rejected of ["agent", "cwd", "model", "thinkingLevel"]) {
    assert.equal(resumeSchema.properties[rejected], undefined);
  }
});

test("delegate and resume definitions stay headless before parent decoration", () => {
  for (const tool of [delegateTool(), resumeTool()]) {
    assert.equal(tool.renderCall, undefined);
    assert.equal(tool.renderResult, undefined);
    assert.equal(tool.renderShell, undefined);
  }
});

test("strict parameter validation rejects invalid delegate and resume combinations", async () => {
  const delegate = delegateTool();
  const resume = resumeTool();
  const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };

  let result = await resume.execute("call-1", { task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "INVALID_ARGUMENT");
  assert.match(result.content[0].text, /id is required/);

  result = await resume.execute("call-2", { id: "x", task: "continue", model: "p/m" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown resume_subagent parameter\(s\): model/);

  result = await delegate.execute("call-3", { task: "delegate", background: true }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown delegate_subagent parameter\(s\): background/);

  result = await delegate.execute("call-4", { context: 51, task: "delegate" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /context must be an integer from 0 to 50/);
});

test("delegate rejects an id parameter and points to resume_subagent", async () => {
  // Regression: GPT populated id on every delegation call ("", "unused", "x", "omit")
  // and a shared schema would have rejected each one as non-retryable.
  const delegate = delegateTool();
  const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };
  const result = await delegate.execute("call-id", { task: "delegate", id: "" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "INVALID_ARGUMENT");
  assert.match(result.content[0].text, /Unknown delegate_subagent parameter\(s\): id/);
  assert.match(result.content[0].text, /resume_subagent/);
});

test("delegate queues a fresh background child and returns its new id and queued state", async () => {
  const tool = delegateTool();
  setRunSubagentTaskMock(async (input) => ({
    details: {
      ...input,
      phase: "completed",
      finalText: "ACK",
      endedAt: 2,
      durationMs: 1,
    },
  }));
  const result = await tool.execute("call-queue", { task: "delegate work" }, undefined, undefined, delegateCtx());
  assert.equal(result.isError, undefined);
  const id = /^Queued background subagent (subagent_[0-9a-f-]{36})\.$/.exec(result.content[0].text)?.[1];
  assert.ok(id, `content states the new public id: ${result.content[0].text}`);
  assert.equal(result.details.id, id);
  assert.equal(result.details.operation, "delegate");
  assert.equal(result.details.phase, "queued");
  assert.equal(result.details.task, "delegate work");
  const call = getRunSubagentTaskCalls()[0];
  assert.equal(call.id, id);
  assert.equal(call.task, "delegate work");
  assert.equal(call.parentSessionId, PARENT_SESSION);
});

test("delegate normalizes blank optional strings to unset", async () => {
  const delegate = delegateTool();
  setRunSubagentTaskMock(async (input) => ({ details: { ...input, phase: "completed", finalText: "ACK" } }));
  const result = await delegate.execute("call-blank", {
    task: "delegate",
    agent: "",
    cwd: "  ",
    model: "",
    thinkingLevel: "",
  }, undefined, undefined, delegateCtx());
  assert.equal(result.isError, undefined);
  const call = getRunSubagentTaskCalls()[0];
  assert.equal(call.modelOverride, undefined);
  assert.equal(call.effortOverride, undefined);
  assert.equal(call.cwd, undefined);
  assert.equal(call.definition, undefined);
});

test("delegate passes the frozen clean parent context into the child", async () => {
  const tool = delegateTool();
  setRunSubagentTaskMock(async (input) => ({ details: { ...input, phase: "completed", finalText: "ACK" } }));
  const ctx = {
    cwd: "/tmp",
    model: { provider: "test", id: "model" },
    sessionManager: {
      getSessionId: () => PARENT_SESSION,
      getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "assistant text" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "current user" }] } },
      ],
    },
  };
  const result = await tool.execute("call-4", { task: "delegate", context: 2 }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  const call = getRunSubagentTaskCalls()[0];
  assert.equal(call.parentSessionId, PARENT_SESSION);
  assert.match(call.id, /^subagent_[0-9a-f-]{36}$/i);
  assert.deepEqual(call.contextMessages, [
    { role: "assistant", text: "assistant text" },
    { role: "user", text: "current user" },
  ]);
});

test("delegate rejects an unknown named agent with the visible catalog", async () => {
  const tool = delegateTool();
  const result = await tool.execute("call-agent", { task: "delegate", agent: "missing" }, undefined, undefined, delegateCtx());
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "UNKNOWN_AGENT");
  assert.match(result.content[0].text, /Unknown subagent 'missing'/);
});

test("resume queues the continuation in the background and returns the same id", async () => {
  const tool = resumeTool();
  writePersistedRun("subagent_00000000-0000-4000-8000-000000000081");
  setRunSubagentTaskMock(async (input) => ({ details: { ...input, phase: "completed", finalText: "continued" } }));
  const result = await tool.execute("resume-queue", {
    id: "subagent_00000000-0000-4000-8000-000000000081",
    task: "continue",
    context: 1,
  }, undefined, undefined, {
    cwd: "/tmp",
    sessionManager: {
      getSessionId: () => PARENT_SESSION,
      getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "current user" }] } }],
    },
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Queued background resume subagent subagent_00000000-0000-4000-8000-000000000081/);
  assert.equal(result.details.id, "subagent_00000000-0000-4000-8000-000000000081");
  assert.equal(result.details.operation, "resume");
  assert.equal(result.details.phase, "queued");
  await new Promise((resolve) => setImmediate(resolve));
  const call = getRunSubagentTaskCalls()[0];
  assert.equal(call.id, "subagent_00000000-0000-4000-8000-000000000081");
  assert.equal(call.task, "continue");
  assert.deepEqual(call.contextMessages, [{ role: "user", text: "current user" }]);
});

test("resume rejects unknown history with a structured tool error", async () => {
  const tool = resumeTool();
  const result = await tool.execute("resume-unknown", {
    id: "subagent_00000000-0000-4000-8000-000000000082",
    task: "continue",
  }, undefined, undefined, delegateCtx());
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SESSION_HISTORY_UNAVAILABLE");
  assert.equal(result.details.error.operation, "resume");
  assert.match(result.content[0].text, /does not exist/);
});

await run();
rmSync(agentRoot, { recursive: true, force: true });
