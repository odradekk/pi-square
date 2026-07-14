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

function subagentTool() {
  const pi = registered();
  const tool = pi.tools.get("subagent");
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

test("registerSubagentTool exposes exactly one LLM tool", () => {
  const pi = registered();
  assert.deepEqual([...pi.tools.keys()], ["subagent"]);
  const schema = pi.tools.get("subagent").parameters;
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.mode);
  assert.ok(schema.properties.context);
  for (const removed of ["background", "resumeRunId", "resumeArtifactsDir"]) {
    assert.equal(schema.properties[removed], undefined);
  }
});

test("subagent tool uses native renderers and keeps Pi's default tool shell", () => {
  const tool = subagentTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.equal(tool.renderShell, undefined);
});

test("mode-specific validation rejects invalid resume combinations", async () => {
  const tool = subagentTool();
  const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };
  let result = await tool.execute("call-1", { mode: "resume", task: "continue" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "INVALID_ARGUMENT");

  result = await tool.execute("call-2", { mode: "resume", id: "x", task: "continue", model: "p/m" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /does not accept model/);

  result = await tool.execute("call-3", { mode: "fg", task: "delegate", background: true }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown subagent parameter\(s\): background/);
});

test("fg passes the frozen clean parent context into the child", async () => {
  const tool = subagentTool();
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
