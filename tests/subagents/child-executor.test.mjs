import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-child-executor-sdk-${process.pid}.mjs`);
const state = {
  createCalls: [],
  inMemoryCalls: [],
};

globalThis.__pi_square_child_executor_state__ = state;

writeFileSync(mockSdkPath, `
export async function createAgentSession(input) {
  globalThis.__pi_square_child_executor_state__.createCalls.push(input);
  return { session: { state: { messages: [] } }, extensionsResult: { errors: [] } };
}
export function createExtensionRuntime() { return {}; }
export const SessionManager = {
  inMemory(cwd) {
    globalThis.__pi_square_child_executor_state__.inMemoryCalls.push(cwd);
    return { kind: "in-memory", cwd };
  },
};
export const SettingsManager = { inMemory(value) { return value; } };
`, "utf8");
const load = jiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": mockSdkPath } });
const {
  createOneTimeChildSession,
  runOneTimeChildSession,
} = await load(join(packageRoot, "src", "subagents", "child-session-executor.ts"));

function reset() {
  state.createCalls = [];
  state.inMemoryCalls = [];
}

function makeSession(script) {
  const calls = { abortRetry: 0, abort: 0, dispose: 0, prompt: 0 };
  let subscriber;
  const session = {
    calls,
    state: { messages: [] },
    agent: {
      abort() { calls.abort += 1; },
    },
    abortRetry() { calls.abortRetry += 1; },
    subscribe(listener) {
      subscriber = listener;
      return () => { calls.unsubscribe = (calls.unsubscribe ?? 0) + 1; };
    },
    async prompt(prompt, options) {
      calls.prompt += 1;
      calls.promptArgs = { prompt, options };
      await script((event) => subscriber?.(event), session);
    },
    dispose() { calls.dispose += 1; },
  };
  return session;
}

function assistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.0001 } },
    model: { provider: "prov", id: "model" },
    stopReason: "stop",
    ...overrides,
  };
}

test("create passes the full native contract and defaults to an in-memory session manager", async () => {
  reset();
  const resourceLoader = { tag: "loader" };
  const settingsManager = { tag: "settings" };

  const created = await createOneTimeChildSession({
    cwd: "/work",
    model: { id: "m" },
    thinkingLevel: "high",
    tools: ["read"],
    customTools: [{ name: "github" }],
    resourceLoader,
    settingsManager,
  });

  assert.equal(state.inMemoryCalls.length, 1, "an omitted manager must default to SessionManager.inMemory");
  assert.equal(state.inMemoryCalls[0], "/work");
  assert.equal(state.createCalls.length, 1);
  const call = state.createCalls[0];
  assert.equal(call.cwd, "/work");
  assert.deepEqual(call.model, { id: "m" });
  assert.equal(call.thinkingLevel, "high");
  assert.deepEqual(call.tools, ["read"]);
  assert.deepEqual(call.customTools, [{ name: "github" }]);
  assert.equal(call.resourceLoader, resourceLoader);
  assert.deepEqual(call.sessionManager, { kind: "in-memory", cwd: "/work" });
  assert.equal(call.settingsManager, settingsManager);
  assert.ok(created.session, "the native creation result must be returned to the caller");
});

test("create accepts a caller-provided persistent session manager and gates empty custom tools", async () => {
  reset();
  const persistent = { kind: "persistent" };

  const created = await createOneTimeChildSession({
    cwd: "/work",
    resourceLoader: { tag: "loader" },
    sessionManager: persistent,
    customTools: [],
  });

  assert.equal(state.inMemoryCalls.length, 0, "an explicit manager must never be replaced");
  assert.equal(state.createCalls[0].sessionManager, persistent);
  assert.equal(state.createCalls[0].customTools, undefined, "an empty custom tool list must stay absent so native call arguments are unchanged");
  assert.equal(state.createCalls[0].settingsManager, undefined);
  assert.ok(created.session, "the native creation result must be returned to the caller");
});

test("a completed run accumulates usage, final text, model, events, and a message snapshot", async () => {
  reset();
  const usageSink = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  const observed = [];
  const message = assistantMessage();
  const session = makeSession(async (emit, current) => {
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streaming" } });
    emit({ type: "tool_execution_start", toolName: "grep", args: { pattern: "needle" } });
    emit({ type: "tool_execution_end", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "1 match" }] } });
    emit({ type: "message_end", message });
    current.state.messages = [message];
    emit({ type: "agent_end" });
  });

  const outcome = await runOneTimeChildSession({
    session,
    prompt: "do the task",
    onEvent: (event) => observed.push(event.type),
    usage: usageSink,
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.prompted, true);
  assert.equal(outcome.finalText, "final answer");
  assert.equal(outcome.streamingCompleted, true);
  assert.equal(outcome.model, "prov/model");
  assert.equal(outcome.terminalAssistantError, undefined);
  assert.deepEqual(outcome.messages, [message]);
  assert.deepEqual(
    observed,
    ["agent_start", "message_update", "tool_execution_start", "tool_execution_end", "message_end", "agent_end"],
    "every native event, including tool events, must reach the observer in order");
  assert.deepEqual(usageSink, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: 0.0001, turns: 1 }, "usage must accumulate into the caller sink before the observer sees the event");
  assert.deepEqual(outcome.usage, usageSink);
  assert.equal(session.calls.prompt, 1);
  assert.deepEqual(session.calls.promptArgs.options, { expandPromptTemplates: false });
  assert.equal(session.calls.dispose, 1, "a one-time session is disposed exactly once");
  assert.equal(session.calls.unsubscribe, 1);
});

test("a terminal assistant error is captured and cleared by a later clean message", async () => {
  reset();
  let first = true;
  const session = makeSession(async (emit, current) => {
    const failed = assistantMessage({ stopReason: "error", errorMessage: "boom" });
    emit({ type: "message_end", message: failed });
    if (first) {
      first = false;
      const recovered = assistantMessage({ content: [{ type: "text", text: "recovered" }] });
      emit({ type: "message_end", message: recovered });
      current.state.messages = [recovered];
    }
    emit({ type: "agent_end" });
  });

  const outcome = await runOneTimeChildSession({ session, prompt: "task" });
  assert.equal(outcome.terminalAssistantError, undefined, "a later clean assistant message clears the terminal error");
  assert.equal(outcome.finalText, "recovered");

  reset();
  const failing = makeSession(async (emit) => {
    emit({ type: "message_end", message: assistantMessage({ stopReason: "aborted" }) });
    emit({ type: "agent_end" });
  });
  const failedOutcome = await runOneTimeChildSession({ session: failing, prompt: "task" });
  assert.equal(failedOutcome.terminalAssistantError, "aborted", "stopReason text is reported when no error message exists");
});

test("an already-aborted signal aborts the session without prompting", async () => {
  reset();
  const session = makeSession(async () => { throw new Error("must not prompt"); });
  const controller = new AbortController();
  controller.abort();

  const outcome = await runOneTimeChildSession({ session, prompt: "task", signal: controller.signal });

  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.prompted, false);
  assert.equal(outcome.error, undefined);
  assert.equal(session.calls.prompt, 0);
  assert.equal(session.calls.abortRetry, 1, "a pre-aborted signal still triggers abortRetry");
  assert.equal(session.calls.abort, 1, "a pre-aborted signal still aborts the agent");
  assert.equal(session.calls.dispose, 1, "cleanup still runs without a prompt");
  assert.equal(session.calls.unsubscribe, 1);
});

test("a mid-run abort reaches the session and classifies the outcome as aborted", async () => {
  reset();
  const controller = new AbortController();
  const session = makeSession(async (emit) => {
    controller.abort();
    emit({ type: "message_end", message: assistantMessage({ stopReason: "aborted" }) });
    await Promise.resolve();
    emit({ type: "agent_end" });
  });

  const outcome = await runOneTimeChildSession({ session, prompt: "task", signal: controller.signal });

  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.prompted, true, "the prompt itself resolved; only the signal classifies the run");
  assert.equal(outcome.terminalAssistantError, "aborted");
  assert.equal(session.calls.abortRetry, 1);
  assert.equal(session.calls.abort, 1);
  assert.equal(session.calls.dispose, 1);
});

test("a deadline timeout aborts the session and wins the terminal classification", async () => {
  reset();
  const session = makeSession(async (emit) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    emit({ type: "message_end", message: assistantMessage() });
    emit({ type: "agent_end" });
  });

  const outcome = await runOneTimeChildSession({ session, prompt: "task", timeoutMs: 10 });

  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.timedOut, true);
  assert.equal(session.calls.abortRetry, 1);
  assert.equal(session.calls.abort, 1);
  assert.equal(session.calls.dispose, 1, "a timed-out run still disposes exactly once");
});

test("a prompt failure becomes an error outcome and an observer failure propagates with cleanup", async () => {
  reset();
  const thrown = new Error("provider exploded");
  const failing = makeSession(async () => { throw thrown; });
  const errorOutcome = await runOneTimeChildSession({ session: failing, prompt: "task" });
  assert.equal(errorOutcome.status, "error");
  assert.equal(errorOutcome.error, thrown);
  assert.equal(errorOutcome.timedOut, false);
  assert.equal(failing.calls.dispose, 1);

  reset();
  const observerError = new Error("observer exploded");
  const observed = makeSession(async (emit) => {
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: assistantMessage() });
  });
  const observedOutcome = await runOneTimeChildSession({
    session: observed,
    prompt: "task",
    onEvent: (event) => {
      if (event.type === "message_end") throw observerError;
    },
  });
  assert.equal(observedOutcome.status, "error");
  assert.equal(observedOutcome.error, observerError);
  assert.equal(observed.calls.dispose, 1, "observer failures still dispose the session");
  assert.equal(observed.calls.unsubscribe, 1);
});

test("a deadline that also fails the prompt still classifies as a timeout", async () => {
  reset();
  const session = makeSession(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    throw new Error("prompt rejected after abort");
  });

  const outcome = await runOneTimeChildSession({ session, prompt: "task", timeoutMs: 10 });

  assert.equal(outcome.status, "timeout", "the deadline is the root cause and beats the error");
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.error, undefined, "a timeout outcome carries no error object");
  assert.equal(session.calls.dispose, 1);
});

test("a session that cannot be subscribed to fails without prompting and still disposes", async () => {
  reset();
  const thrown = new Error("subscribe refused");
  const session = {
    calls: { dispose: 0, abort: 0, abortRetry: 0, prompt: 0 },
    state: { messages: [] },
    agent: { abort() { session.calls.abort += 1; } },
    abortRetry() { session.calls.abortRetry += 1; },
    subscribe() { throw thrown; },
    async prompt() { throw new Error("must not prompt"); },
    dispose() { session.calls.dispose += 1; },
  };

  const outcome = await runOneTimeChildSession({ session, prompt: "task" });

  assert.equal(outcome.status, "error");
  assert.equal(outcome.error, thrown);
  assert.equal(outcome.prompted, false);
  assert.equal(session.calls.prompt, 0);
  assert.equal(session.calls.dispose, 1, "a subscribe failure still disposes exactly once");
});

test("a prompt rejection carrying no error value still reports an error outcome", async () => {
  reset();
  const session = makeSession(async () => {
    throw undefined;
  });

  const outcome = await runOneTimeChildSession({ session, prompt: "task" });

  assert.equal(outcome.status, "error");
  assert.equal(outcome.prompted, true);
  assert.equal(outcome.error, undefined, "an absent thrown value is not a pre-start abort");
});

test("an aborted run does not dispose twice and stops listening after the run", async () => {
  reset();
  let subscriber;
  const session = {
    calls: { dispose: 0, abort: 0, abortRetry: 0 },
    state: { messages: [] },
    agent: { abort() { session.calls.abort += 1; } },
    abortRetry() { session.calls.abortRetry += 1; },
    subscribe(listener) { subscriber = listener; return () => { subscriber = undefined; }; },
    async prompt() {
      subscriber?.({ type: "agent_start" });
    },
    dispose() { session.calls.dispose += 1; },
  };
  const controller = new AbortController();
  controller.abort();
  await runOneTimeChildSession({ session, prompt: "task", signal: controller.signal });
  assert.equal(session.calls.dispose, 1);
  assert.equal(typeof subscriber, "undefined", "the executor must unsubscribe its listener");
});

await run();
