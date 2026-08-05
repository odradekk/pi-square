import assert from "node:assert/strict";

import {
  createPromptSnapshot,
  getRunSubagentTaskCalls,
  loadToolModule,
  run,
  setRunSubagentTaskMock,
  test,
} from "./lib/test-helpers.mjs";

const { registerSubagentTool } = await loadToolModule();

function createRuntimeState() {
  return {
    registry: { definitions: [], errors: [], projectDir: null },
    background: { jobs: new Map(), onChange: undefined },
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
  const tool = pi.tools.get("subagent_delegate");
  assert.ok(tool);
  return tool;
}

function resumeTool() {
  const pi = registered();
  const tool = pi.tools.get("subagent_resume");
  assert.ok(tool);
  return tool;
}

function runDetails(id, overrides = {}) {
  return {
    version: 3,
    id,
    mode: "fg",
    artifactsDir: `/tmp/${id}`,
    sessionFile: `/tmp/${id}/session.jsonl`,
    sessionId: "native",
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
    phase: "done",
    task: "task",
    cwd: "/tmp/subagents",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    finalText: "ACK",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    timeline: [],
    ...overrides,
  };
}

test("registerSubagentTool exposes the delegate and resume tools", () => {
  const pi = registered();
  assert.deepEqual([...pi.tools.keys()], ["subagent_delegate", "subagent_resume"]);
  const delegateSchema = pi.tools.get("subagent_delegate").parameters;
  assert.equal(delegateSchema.additionalProperties, false);
  assert.ok(delegateSchema.properties.mode);
  assert.ok(delegateSchema.properties.context);
  // Regression: GPT models via the OpenAI Responses API populate every declared
  // property, so id must stay out of the delegate schema entirely.
  assert.equal(delegateSchema.properties.id, undefined);
  assert.deepEqual(delegateSchema.required, ["mode", "task"]);
  const resumeSchema = pi.tools.get("subagent_resume").parameters;
  assert.equal(resumeSchema.additionalProperties, false);
  assert.deepEqual(resumeSchema.required, ["id", "task"]);
  assert.equal(resumeSchema.properties.mode, undefined);
  for (const removed of ["agent", "cwd", "systemPrompt", "model", "thinkingLevel"]) {
    assert.equal(resumeSchema.properties[removed], undefined);
  }
  for (const removed of ["background", "resumeRunId", "resumeArtifactsDir"]) {
    assert.equal(delegateSchema.properties[removed], undefined);
  }
});

test("delegate and resume definitions stay headless before parent decoration", () => {
  for (const tool of [delegateTool(), resumeTool()]) {
    assert.equal(tool.renderCall, undefined);
    assert.equal(tool.renderResult, undefined);
    assert.equal(tool.renderShell, undefined);
  }
});

test("mode-specific validation rejects invalid delegate and resume combinations", async () => {
  const delegate = delegateTool();
  const resume = resumeTool();
  const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };

  let result = await delegate.execute("call-1", { mode: "resume", task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "INVALID_ARGUMENT");
  assert.match(result.content[0].text, /mode must be fg or bg/);

  result = await resume.execute("call-2", { task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /id is required/);

  result = await resume.execute("call-3", { id: "x", task: "continue", model: "p/m" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown subagent_resume parameter\(s\): model/);

  result = await delegate.execute("call-4", { mode: "fg", task: "delegate", background: true }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown subagent_delegate parameter\(s\): background/);
});

test("delegate rejects an id parameter and points to subagent_resume", async () => {
  // Regression: GPT populated id on every fg/bg call ("", "unused", "x", "omit")
  // and the single-tool schema rejected each one as non-retryable.
  const delegate = delegateTool();
  const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };
  const result = await delegate.execute("call-id", { mode: "fg", task: "delegate", id: "" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "INVALID_ARGUMENT");
  assert.match(result.content[0].text, /Unknown subagent_delegate parameter\(s\): id/);
  assert.match(result.content[0].text, /subagent_resume/);
});

test("delegate normalizes blank optional strings to unset", async () => {
  const delegate = delegateTool();
  setRunSubagentTaskMock(async (input) => ({ content: "ACK", details: runDetails(input.id) }));
  const ctx = {
    cwd: "/tmp",
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
  };
  const result = await delegate.execute("call-blank", {
    mode: "fg",
    task: "delegate",
    agent: "",
    cwd: "  ",
    systemPrompt: "",
    model: "",
    thinkingLevel: "",
  }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  const call = getRunSubagentTaskCalls()[0];
  assert.equal(call.modelOverride, undefined);
  assert.equal(call.effortOverride, undefined);
  assert.equal(call.systemPrompt, undefined);
  assert.equal(call.cwd, undefined);
  assert.equal(call.definition, undefined);
});

test("fg passes the frozen clean parent context into the child", async () => {
  const tool = delegateTool();
  setRunSubagentTaskMock(async (input) => ({ content: "ACK", details: runDetails(input.id) }));
  const ctx = {
    cwd: "/tmp",
    model: { provider: "test", id: "model" },
    sessionManager: {
      getSessionId: () => "parent-session",
      getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "assistant text" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "current user" }] } },
      ],
    },
  };
  const result = await tool.execute("call-4", { mode: "fg", task: "delegate", context: 2 }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  const call = getRunSubagentTaskCalls()[0];
  assert.equal(call.mode, "fg");
  assert.equal(call.parentSessionId, "parent-session");
  assert.match(call.id, /^subagent_[0-9a-f-]{36}$/i);
  assert.deepEqual(call.contextMessages, [
    { role: "assistant", text: "assistant text" },
    { role: "user", text: "current user" },
  ]);
});

await run();
