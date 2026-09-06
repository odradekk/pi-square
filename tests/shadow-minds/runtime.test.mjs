import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const { createShadowRuntime, SHADOW_MANUAL_NOTE_MAX_CHARS, createFrozenShadowResourceLoader } = await load(
  join(packageRoot, "src", "shadow-minds", "runtime.ts"),
);
const { SUBMIT_SHADOW_RESULT_TOOL } = await load(join(packageRoot, "src", "shadow-minds", "result.ts"));
const { DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));

const COMPLETED_NO_SUBMISSION = {
  status: "completed",
  prompted: true,
  timedOut: false,
  finalText: "final assistant text that must never become a result",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
  streamingCompleted: true,
  messages: [],
};

function definition(overrides = {}) {
  return {
    id: "session-synthesizer",
    name: "Session synthesizer",
    enabled: false,
    hidden: false,
    priority: 0,
    triggers: [],
    triggerInstructions: {},
    delivery: "notify",
    completionGate: false,
    requiredTools: [],
    debug: false,
    outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
    body: "Summarize the trajectory.",
    fieldSources: {},
    layers: [],
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    ...overrides,
    enabled: overrides.enabled ?? true,
    defaults: { ...DEFAULT_SHADOW_MINDS, ...(overrides.defaults ?? {}) },
  };
}

/**
 * Fake runtime deps. `behavior` customizes runSession:
 *  - outcome: return a fixed executor outcome
 *  - submit: execute the real submit tool once with this payload string
 *  - script(input): full control; may fire events or call the tool
 */
function makeFake(behavior = {}) {
  const created = [];
  const ran = [];
  let clock = 1_000;
  const deps = {
    now: () => clock,
    async createSession(input) {
      created.push(input);
      return { session: { __fake: true, customTools: input.customTools } };
    },
    async runSession(input) {
      ran.push(input);
      if (behavior.script) return await behavior.script(input);
      if (behavior.submit !== undefined) {
        const tool = input.session.customTools[0];
        await tool.execute("call-1", { payload: behavior.submit }, undefined, undefined, { cwd: "/repo" });
      }
      return behavior.outcome ?? COMPLETED_NO_SUBMISSION;
    },
  };
  return { deps, created, ran, advance(ms) { clock += ms; } };
}

/** A fake run that settles only when the runtime aborts it. */
function abortSettled() {
  return (input) => new Promise((resolve) => {
    const settle = () => resolve({ ...COMPLETED_NO_SUBMISSION, status: "aborted" });
    if (input.signal.aborted) {
      settle();
      return;
    }
    input.signal.addEventListener("abort", settle, { once: true });
  });
}

function baseRequest(overrides = {}) {
  return {
    definition: definition(),
    system: "SHADOW SYSTEM",
    trajectory: { text: "[user] hello", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" },
    cwd: "/repo",
    ...overrides,
  };
}

{
  // A persistent inbox write failure becomes an observable bounded run error;
  // it never rejects done or leaves the active slot occupied.
  const fake = makeFake({ submit: JSON.stringify({ summary: "accepted before persistence" }) });
  const failingInbox = {
    persistent: true,
    add() { throw new Error("disk full Authorization: Bearer SECRET"); },
    list: () => [], send: () => false, markRead: () => false, dismiss: () => false, delete: () => false, clear() {},
  };
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps, inbox: failingInbox });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "error");
  assert.match(terminal.message, /disk full/);
  assert.doesNotMatch(terminal.message, /SECRET/);
  assert.equal(runtime.snapshot().results.length, 0);
  const next = runtime.startManualRun(baseRequest({ definition: definition({ id: "next" }) }));
  assert.equal(next.started, true, "the failed persistence path releases its active slot");
  await next.done;
}

// ── start refusals ─────────────────────────────────────────────────

{
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config({ enabled: false }), deps: fake.deps });
  const refused = runtime.startManualRun(baseRequest());
  assert.equal(refused.started, false);
  assert.ok(refused.reason.toLowerCase().includes("master switch"), refused.reason);
}

{
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config({ defaults: { maxConcurrentRuns: 1 } }), deps: fake.deps });
  let release;
  const originalRunSession = fake.deps.runSession;
  fake.deps.runSession = async () => new Promise((resolve) => { release = resolve; });
  const first = runtime.startManualRun(baseRequest());
  assert.equal(first.started, true, "the first run occupies the single slot");
  const second = runtime.startManualRun(baseRequest({ definition: definition({ id: "other" }) }));
  assert.equal(second.started, false);
  assert.ok(second.reason.toLowerCase().includes("busy") || second.reason.toLowerCase().includes("slot"), second.reason);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release(COMPLETED_NO_SUBMISSION);
  await first.done;
  fake.deps.runSession = originalRunSession;
  const third = runtime.startManualRun(baseRequest({ definition: definition({ id: "third" }) }));
  assert.equal(third.started, true, "a terminal run frees its slot");
  await third.done;
}

{
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const longNote = runtime.startManualRun(baseRequest({ note: "n".repeat(SHADOW_MANUAL_NOTE_MAX_CHARS + 1) }));
  assert.equal(longNote.started, false);
  assert.ok(longNote.reason.toLowerCase().includes("note"), longNote.reason);
  const badModel = runtime.startManualRun(baseRequest({ modelResolution: { error: "Unknown model 'x/y'." } }));
  assert.equal(badModel.started, false);
  assert.ok(badModel.reason.includes("Unknown model"), badModel.reason);
}

// ── submitted run ──────────────────────────────────────────────────

{
  const fake = makeFake({ submit: JSON.stringify({ summary: "The parser defect is confirmed." }) });
  const notifications = [];
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  runtime.subscribe(() => notifications.push(runtime.snapshot().runs.map((run) => run.phase).join(",")));

  const started = runtime.startManualRun(baseRequest({ note: "Focus on decisions." }));
  assert.equal(started.started, true);
  assert.equal(runtime.snapshot().runs[0].phase, "running");
  const terminal = await started.done;

  assert.equal(terminal.phase, "submitted");
  assert.ok(terminal.resultId, "a result id is attached");

  const create = fake.created[0];
  assert.deepEqual(create.tools, [SUBMIT_SHADOW_RESULT_TOOL], "the no-tool child allowlists exactly the terminating tool");
  assert.equal(create.customTools.length, 1);
  assert.equal(create.customTools[0].name, SUBMIT_SHADOW_RESULT_TOOL);
  assert.equal(create.cwd, "/repo");
  assert.equal(create.model, undefined, "the parent model object is passed through when no explicit model is set");
  assert.equal(create.system, "SHADOW SYSTEM", "the frozen SYSTEM rides to the child-session seam");

  const run = fake.ran[0];
  assert.ok(run.prompt.includes("[user] hello"), "the prompt embeds the trajectory");
  assert.ok(run.prompt.includes("Summarize the trajectory."), "the prompt embeds the responsibility body");
  assert.ok(run.prompt.includes("Focus on decisions."), "the prompt embeds the manual note");
  assert.ok(run.prompt.includes('"summary"'), "the prompt embeds the canonical schema");
  assert.ok(!run.prompt.includes("SHADOW SYSTEM"), "the SYSTEM stays out of the user prompt");
  assert.equal(run.timeoutMs, DEFAULT_SHADOW_MINDS.runTimeoutSeconds * 1000, "the configured default timeout applies");
  assert.ok(run.signal, "an abort signal is wired");

  const results = runtime.snapshot().results;
  assert.equal(results.length, 1);
  assert.equal(results[0].shadowId, "session-synthesizer");
  assert.equal(results[0].shadowName, "Session synthesizer");
  assert.equal(results[0].trigger, "manual");
  assert.deepEqual(results[0].payload, { summary: "The parser defect is confirmed." });
  assert.equal(results[0].summary, "The parser defect is confirmed.");
  assert.equal(results[0].usage.turns, 1, "final usage is recorded on the result");
  assert.ok(notifications.length >= 2, "subscriptions fired for start and terminal");
}

{
  // Definition overrides tighten the runtime bounds.
  const fake = makeFake({ submit: JSON.stringify({ summary: "ok" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest({
    definition: definition({ timeoutSeconds: 45, maxTurns: 3, maxToolCalls: 5 }),
  })).done;
  assert.equal(fake.ran[0].timeoutMs, 45_000);
}

{
  // A rejected first submission stays recoverable; the retry is accepted.
  const fake = makeFake({
    script: async (input) => {
      const tool = input.session.customTools[0];
      const rejected = await tool.execute("c1", { payload: JSON.stringify({ summary: 7 }) }, undefined, undefined, {});
      assert.equal(rejected.isError, true);
      const accepted = await tool.execute("c2", { payload: JSON.stringify({ summary: "Corrected." }) }, undefined, undefined, {});
      assert.equal(accepted.terminate, true);
      assert.equal(input.signal.aborted, true, "a valid submission stops the child even when its tool batch also contained a rejection");
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted", usage: { ...COMPLETED_NO_SUBMISSION.usage, turns: 2 } };
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "submitted");
  assert.deepEqual(runtime.snapshot().results[0].payload, { summary: "Corrected." });
}

// ── silent, bounded, cancelled, and failed outcomes ────────────────

{
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "silent", "no valid submission discards the run without delivering final text");
  assert.equal(terminal.resultId, undefined);
  assert.equal(runtime.snapshot().results.length, 0);
}

{
  const fake = makeFake({ outcome: { ...COMPLETED_NO_SUBMISSION, status: "timeout", timedOut: true } });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "timeout");
  assert.equal(runtime.snapshot().results.length, 0);
}

{
  const fake = makeFake({
    outcome: { ...COMPLETED_NO_SUBMISSION, status: "error", error: new Error("401 unauthorized") },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "error");
  assert.ok(terminal.message.includes("401"), "model/auth failure is observable");
  assert.ok(terminal.message.length <= 200, "the failure message stays bounded to the run-message cap");
  assert.equal(runtime.snapshot().results.length, 0, "an infrastructure failure never becomes a cognitive payload");
}

{
  const fake = makeFake({
    outcome: { ...COMPLETED_NO_SUBMISSION, terminalAssistantError: "rate limited after retries" },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "error", "a terminal assistant error is an error outcome");
}

{
  // max turns: a new assistant turn must not start once the budget is spent.
  const fake = makeFake({
    script: async (input) => {
      input.usage.turns = DEFAULT_SHADOW_MINDS.maxModelTurnsPerRun;
      input.onEvent?.({ type: "turn_start" });
      assert.equal(input.signal.aborted, true, "the over-budget turn aborts the session");
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted" };
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "max_turns", "a bounded outcome is not an infrastructure failure");
}

{
  // max tool calls: the call over the budget is refused by the real tool
  // wrapper before a valid payload can be accepted.
  const fake = makeFake({
    script: async (input) => {
      const tool = input.session.customTools[0];
      for (let index = 0; index < DEFAULT_SHADOW_MINDS.maxToolCallsPerRun; index += 1) {
        input.onEvent?.({ type: "tool_execution_start", toolCallId: `c${index}`, toolName: SUBMIT_SHADOW_RESULT_TOOL });
        const rejected = await tool.execute(`c${index}`, { payload: "not-json" }, undefined, undefined, {});
        assert.equal(rejected.isError, true);
      }
      input.onEvent?.({ type: "tool_execution_start", toolCallId: "over-budget", toolName: SUBMIT_SHADOW_RESULT_TOOL });
      const overBudget = await tool.execute(
        "over-budget",
        { payload: JSON.stringify({ summary: "must not be accepted" }) },
        undefined,
        undefined,
        {},
      );
      assert.equal(overBudget.isError, true);
      assert.equal(overBudget.details.status, "budget_exceeded");
      assert.equal(input.signal.aborted, true);
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted" };
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "max_tool_calls");
  assert.equal(runtime.snapshot().results.length, 0, "the over-budget valid submission creates no result");
}

{
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const started = runtime.startManualRun(baseRequest());
  assert.equal(runtime.snapshot().runs[0].phase, "running");
  const outcome = runtime.cancelRun(started.runId);
  assert.equal(outcome.ok, true);
  const terminal = await started.done;
  assert.equal(terminal.phase, "cancelled");
  assert.equal(runtime.cancelRun(started.runId).ok, false, "a terminal run cannot be cancelled");
}

{
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const started = runtime.startManualRun(baseRequest());
  runtime.reset("session shutdown");
  const terminal = await started.done;
  assert.equal(terminal.phase, "cancelled", "a session reset aborts active runs");
  assert.equal(runtime.snapshot().runs.length, 0, "reset clears the run history");
}

// ── snapshot, runs history, and inbox actions ──────────────────────

{
  const fake = makeFake({ submit: JSON.stringify({ summary: "one" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  await runtime.startManualRun(baseRequest({ definition: definition({ id: "another", name: "Another" }) })).done;

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runs.length, 2, "terminal runs stay observable");
  assert.equal(new Set(snapshot.runs.map((run) => run.phase)).size, 1);
  assert.equal(snapshot.results.length, 2);
  assert.ok(snapshot.results[0].createdAt >= snapshot.results[1].createdAt, "newest results first");

  const target = snapshot.results[0].id;
  assert.equal(runtime.markResultRead(target), true);
  assert.equal(runtime.snapshot().results.find((entry) => entry.id === target).attention, "read");
  assert.equal(runtime.dismissResult(target), true);
  assert.equal(runtime.snapshot().results.find((entry) => entry.id === target).attention, "dismissed");
  const deleted = snapshot.results[1].id;
  assert.equal(runtime.deleteResult(deleted), true);
  assert.equal(runtime.snapshot().results.some((entry) => entry.id === deleted), false);
  assert.equal(runtime.markResultRead("missing"), false);
  const external = runtime.snapshot();
  external.runs[0].phase = "error";
  if (external.runs[0].usage) external.runs[0].usage.turns = 999;
  assert.notEqual(runtime.snapshot().runs[0].phase, "error", "run snapshots cannot mutate internal history");
  assert.notEqual(runtime.snapshot().runs[0].usage?.turns, 999);
}




{
  // Session creation time is part of the frozen run deadline. If creation
  // consumes it, the child executor receives an already-aborted signal and
  // must not prompt the model.
  const fake = makeFake();
  const originalCreate = fake.deps.createSession;
  fake.deps.createSession = async (input) => {
    fake.advance(31_000);
    return await originalCreate(input);
  };
  fake.deps.runSession = async (input) => {
    assert.equal(input.signal.aborted, true);
    assert.equal(input.timeoutMs, 1);
    return { ...COMPLETED_NO_SUBMISSION, status: "aborted", prompted: false };
  };
  const runtime = createShadowRuntime({ config: () => config({ defaults: { runTimeoutSeconds: 30 } }), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "timeout");
}


{
  // Cancellation also preempts a hanging child-session creation and disposes
  // a handle that resolves after the run already settled.
  let releaseCreation;
  let disposed = 0;
  const fake = makeFake();
  fake.deps.createSession = async () => await new Promise((resolve) => { releaseCreation = resolve; });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const started = runtime.startManualRun(baseRequest());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.cancelRun(started.runId).ok, true);
  const terminal = await started.done;
  assert.equal(terminal.phase, "cancelled");
  releaseCreation({ session: { dispose() { disposed += 1; } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposed, 1, "the late-created session is disposed exactly once");
}

// ── Deadline and teardown precedence ────────────────────────────────

{
  // A valid submission arriving after the frozen deadline is rejected even
  // before the executor's timer callback gets a chance to run.
  const fake = makeFake({
    script: async (input) => {
      fake.advance(31_000);
      const tool = input.session.customTools[0];
      const late = await tool.execute("late", { payload: JSON.stringify({ summary: "late" }) }, undefined, undefined, {});
      assert.equal(late.isError, true);
      assert.equal(late.details.status, "budget_exceeded");
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted" };
    },
  });
  const runtime = createShadowRuntime({ config: () => config({ defaults: { runTimeoutSeconds: 30 } }), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "timeout");
  assert.equal(runtime.snapshot().results.length, 0);
}

{
  // Session teardown force-aborts even after the result tool accepted a
  // payload, so a previous-session result cannot land after reset.
  let release;
  let accepted;
  const fake = makeFake({
    script: async (input) => {
      const tool = input.session.customTools[0];
      accepted = await tool.execute("accepted", { payload: JSON.stringify({ summary: "old" }) }, undefined, undefined, {});
      return await new Promise((resolve) => { release = resolve; });
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const started = runtime.startManualRun(baseRequest());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(accepted.terminate, true);
  runtime.reset("new session");
  release({ ...COMPLETED_NO_SUBMISSION, status: "aborted" });
  const terminal = await started.done;
  assert.equal(terminal.phase, "cancelled");
  assert.equal(runtime.snapshot().results.length, 0);
}

// ── Session isolation and frozen authorization ─────────────────────

{
  // Existing inbox state is session-scoped and cleared on reset.
  const fake = makeFake({ submit: JSON.stringify({ summary: "old session" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  assert.equal(runtime.snapshot().results.length, 1);
  runtime.reset("new session");
  assert.deepEqual(runtime.snapshot(), { runs: [], results: [], evictionEvents: [] });
}

{
  // A late result tool call from the previous epoch is refused and cannot
  // write into the new session inbox.
  let release;
  let oldTool;
  const fake = makeFake({
    script: async (input) => {
      oldTool = input.session.customTools[0];
      return await new Promise((resolve) => { release = resolve; });
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const started = runtime.startManualRun(baseRequest());
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.reset("new session");
  const late = await oldTool.execute("late", { payload: JSON.stringify({ summary: "late" }) }, undefined, undefined, {});
  assert.equal(late.isError, true);
  assert.equal(late.details.status, "budget_exceeded");
  release({ ...COMPLETED_NO_SUBMISSION, status: "aborted" });
  await started.done;
  assert.equal(runtime.snapshot().results.length, 0);
}

{
  // Config defaults and the effective definition are frozen at the accepted
  // start boundary; later mutation cannot loosen an in-flight run.
  let current = config({ defaults: { maxToolCallsPerRun: 1, runTimeoutSeconds: 30 } });
  const request = baseRequest();
  const fake = makeFake({
    script: async (input) => {
      const tool = input.session.customTools[0];
      input.onEvent?.({ type: "tool_execution_start", toolCallId: "first", toolName: SUBMIT_SHADOW_RESULT_TOOL });
      const first = await tool.execute("first", { payload: "not-json" }, undefined, undefined, {});
      assert.equal(first.isError, true);
      input.onEvent?.({ type: "tool_execution_start", toolCallId: "second", toolName: SUBMIT_SHADOW_RESULT_TOOL });
      const second = await tool.execute("second", { payload: JSON.stringify({ summary: "late valid" }) }, undefined, undefined, {});
      assert.equal(second.details.status, "budget_exceeded");
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted" };
    },
  });
  const runtime = createShadowRuntime({ config: () => current, deps: fake.deps });
  const started = runtime.startManualRun(request);
  current = config({ defaults: { maxToolCallsPerRun: 100, runTimeoutSeconds: 500 } });
  request.definition.maxToolCalls = 100;
  const terminal = await started.done;
  assert.equal(fake.ran[0].timeoutMs, 30_000);
  assert.equal(terminal.phase, "max_tool_calls");
  assert.equal(runtime.snapshot().results.length, 0);
}

{
  // Deterministic injected IDs are used exactly; default IDs are a bounded
  // session-local sequence and restart only after the session resets.
  let runId = 0;
  let resultId = 0;
  const fake = makeFake({ submit: JSON.stringify({ summary: "id" }) });
  fake.deps.makeRunId = () => `custom-run-${++runId}`;
  fake.deps.makeResultId = () => `custom-result-${++resultId}`;
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const first = runtime.startManualRun(baseRequest());
  await first.done;
  assert.equal(first.runId, "custom-run-1");
  assert.equal(runtime.snapshot().results[0].id, "custom-result-1");
}

// ── frozen child resource loader ───────────────────────────────────

{
  const loader = createFrozenShadowResourceLoader({ cwd: "/repo", systemPrompt: "SHADOW SYSTEM" });
  assert.equal(loader.getSystemPrompt(), "SHADOW SYSTEM");
  assert.equal(loader.getSystemPromptSource(), undefined);
  assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getAppendSystemPromptSources(), []);
  assert.equal(loader.getExtensions().extensions.length, 0);
}

// ── evidence-tool envelope wiring (#156) ──────────────────────────

{
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const evidenceTool = { name: "web_search", parameters: { type: "object" }, execute: async () => ({}) };
  const run = runtime.startManualRun(baseRequest({
    envelope: {
      toolNames: ["read", "web_search"],
      customTools: [evidenceTool],
      schemaHash: "0123456789abcdef",
      warnings: ["Tool 'bash' is not in the Shadow-safe catalog and was excluded."],
    },
  }));
  assert.equal(run.started, true);
  await run.done;
  const created = fake.created[0];
  // Canonical evidence names first, submit tool always last.
  assert.deepEqual(created.tools, ["read", "web_search", SUBMIT_SHADOW_RESULT_TOOL]);
  // Extension definitions precede the per-run submit tool.
  assert.deepEqual(created.customTools.map((tool) => tool.name), ["web_search", SUBMIT_SHADOW_RESULT_TOOL]);
  const view = runtime.snapshot().runs[0];
  assert.deepEqual(view.toolNames, ["read", "web_search"]);
  assert.equal(view.cohorts.toolSchema, "0123456789abcdef");
  assert.deepEqual(view.toolWarnings, ["Tool 'bash' is not in the Shadow-safe catalog and was excluded."]);
  assert.match(view.cohorts.system, /^[0-9a-f]{16}$/);
  assert.match(view.cohorts.trajectory, /^[0-9a-f]{16}$/);
}

{
  // Without an envelope the no-tool trial keeps its single-tool cohort hash.
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const run = runtime.startManualRun(baseRequest());
  await run.done;
  assert.deepEqual(fake.created[0].tools, [SUBMIT_SHADOW_RESULT_TOOL]);
  assert.match(runtime.snapshot().runs[0].cohorts.toolSchema, /^[0-9a-f]{16}$/);
}

{
  // The trajectory hash includes the truncation mode.
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  await runtime.startManualRun(baseRequest({
    trajectory: { text: "[user] hello", includedMessages: 1, totalMessages: 1, truncated: true, truncation: "dropped" },
  })).done;
  const [dropped, full] = runtime.snapshot().runs;
  assert.notEqual(dropped.cohorts.trajectory, full.cohorts.trajectory);
}

// ── per-request usage and TTFT ────────────────────────────────────

{
  const fake = makeFake({ script: async (input) => {
    input.onEvent({ type: "turn_start" });
    fake.advance(120);
    input.onEvent({ type: "message_start", message: { role: "assistant" } });
    fake.advance(480);
    input.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 700, output: 80, cacheRead: 12, cacheWrite: 4, cost: { total: 0.02 } } } });
    return COMPLETED_NO_SUBMISSION;
  } });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  const view = runtime.snapshot().runs[0];
  assert.deepEqual(view.requests, [
    { input: 700, output: 80, cacheRead: 12, cacheWrite: 4, cost: 0.02, turn: 1, toolCalls: 0, ttftMs: 120, cacheReported: true },
  ]);
}

{
  // A usage-less assistant completion finalizes its request with zeros.
  const fake = makeFake({ script: async (input) => {
    input.onEvent({ type: "turn_start" });
    fake.advance(90);
    input.onEvent({ type: "message_start", message: { role: "assistant" } });
    input.onEvent({ type: "message_end", message: { role: "assistant" } });
    return COMPLETED_NO_SUBMISSION;
  } });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  assert.deepEqual(runtime.snapshot().runs[0].requests, [
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turn: 1, toolCalls: 0, ttftMs: 90 },
  ]);
}

{
  // A truncated trajectory marks its run with the qualifier.
  const fake = makeFake();
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest({
    trajectory: { text: "[user] long", includedMessages: 1, totalMessages: 5, truncated: true, truncation: "dropped" },
  })).done;
  assert.equal(runtime.snapshot().runs[0].trajectoryTruncated, true);
}

{
  // A turn that began but ended before assistant completion remains visible as
  // one zero-valued, cache-unreported request metric.
  const fake = makeFake({ script: async (input) => {
    input.onEvent({ type: "turn_start" });
    return { ...COMPLETED_NO_SUBMISSION, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
  } });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  assert.deepEqual(runtime.snapshot().runs[0].requests, [
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turn: 1, toolCalls: 0 },
  ]);
}

// ── persistent inbox and debug wiring (#157) ─────────────────────

{
  // An injected persistent inbox survives runtime resets; the memory
  // fallback is wiped by the same reset.
  const fake = makeFake({ submit: JSON.stringify({ summary: "persisted finding" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  assert.equal(runtime.snapshot().results.length, 1);
  runtime.reset("session switch");
  assert.deepEqual(runtime.snapshot(), { runs: [], results: [], evictionEvents: [] });

  const { createShadowInbox } = await load(join(packageRoot, "src", "shadow-minds", "result.ts"));
  const persistent = createShadowInbox();
  Object.defineProperty(persistent, "persistent", { value: true });
  const second = createShadowRuntime({ config: () => config(), deps: makeFake({ submit: JSON.stringify({ summary: "kept" }) }).deps, inbox: persistent });
  await second.startManualRun(baseRequest()).done;
  assert.equal(second.snapshot().results.length, 1);
  second.reset("session switch");
  assert.equal(second.snapshot().results.length, 1, "a persistent inbox survives the reset");
}

{
  // A debug definition persists its child session and finalizes the log.
  const fake = makeFake({ submit: JSON.stringify({ summary: "debugged" }) });
  const debugCalls = [];
  fake.deps.finalizeDebug = (input) => debugCalls.push(input);
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const run = runtime.startManualRun(baseRequest({
    definition: definition({ debug: true }),
    debug: { sessionDir: "/sessions/alpha", sessionId: "sess-9" },
  }));
  await run.done;
  assert.ok(fake.created[0].debugDir?.includes("/sessions/alpha"), "the child receives the debug directory");
  assert.ok(fake.created[0].debugDir?.includes("run-"), "the debug directory is keyed by run id");
  assert.equal(debugCalls.length, 1);
  assert.equal(debugCalls[0].phase, "submitted");
  assert.equal(debugCalls[0].shadowId, "session-synthesizer");
  assert.ok(Number.isFinite(debugCalls[0].endedAt));
}

{
  // A detached run still finalizes its debug log for sanitization.
  const finalizeCalls = [];
  let currentRuntime;
  const fake = makeFake({ script: () => new Promise((resolve) => {
    // Detach by resetting the session epoch mid-run.
    currentRuntime.reset("session switch");
    resolve(COMPLETED_NO_SUBMISSION);
  }) });
  fake.deps.finalizeDebug = (input) => finalizeCalls.push(input);
  currentRuntime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const run = currentRuntime.startManualRun(baseRequest({
    definition: definition({ debug: true }),
    debug: { sessionDir: "/sessions/alpha", sessionId: "sess-9" },
  }));
  await run.done;
  assert.equal(currentRuntime.snapshot().runs.length, 0, "detached runs leave no history");
  assert.equal(finalizeCalls.length, 1, "detached runs still finalize debug logs");
}

{
  // A non-debug definition never receives a debug directory.
  const fake = makeFake({ submit: JSON.stringify({ summary: "normal" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  assert.equal(fake.created[0].debugDir, undefined);
}

{
  // The recorded definition hash changes when layer content changes.
  const runOne = makeFake({ submit: JSON.stringify({ summary: "a" }) });
  const runtimeOne = createShadowRuntime({ config: () => config(), deps: runOne.deps });
  await runtimeOne.startManualRun(baseRequest({
    definition: definition({ layers: [{ scope: "agent", filePath: "/agent/s.md", contentHash: "aaa" }] }),
  })).done;
  const runTwo = makeFake({ submit: JSON.stringify({ summary: "b" }) });
  const runtimeTwo = createShadowRuntime({ config: () => config(), deps: runTwo.deps });
  await runtimeTwo.startManualRun(baseRequest({
    definition: definition({ layers: [{ scope: "agent", filePath: "/agent/s.md", contentHash: "bbb" }] }),
  })).done;
  const [one, two] = [runtimeOne, runtimeTwo].map((runtime) => runtime.snapshot().results[0]);
  assert.ok(one.definitionHash && two.definitionHash);
  assert.notEqual(one.definitionHash, two.definitionHash, "content edits change the recorded source hash");
}

{
  // Result entities record provenance metadata.
  const fake = makeFake({ submit: JSON.stringify({ summary: "provenance" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest()).done;
  const entity = runtime.snapshot().results[0];
  assert.equal(entity.configuredDelivery, "notify");
  assert.match(entity.schemaHash, /^[0-9a-f]{16}$/);
}

// ── Automatic runs, preemption, interruption, pause, stale notify ──

{
  // Automatic runs carry source, trigger, epoch, and reasons; the prompt
  // includes the bounded trigger task section.
  const fake = makeFake({ submit: JSON.stringify({ summary: "ok" }) });
  const prompts = [];
  const originalRun = fake.deps.runSession;
  fake.deps.runSession = async (input) => {
    prompts.push(input.prompt);
    return await originalRun(input);
  };
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const outcome = runtime.startAutomaticRun(baseRequest({
    trigger: "mutation",
    taskEpoch: 4,
    sourceRun: 7,
    triggerReasons: [{ trigger: "mutation", firstObservedAt: 1, lastObservedAt: 2, detail: "write a.ts" }],
  }));
  assert.equal(outcome.started, true, "the automatic run starts through the same seam");
  const view = await outcome.done;
  assert.equal(view.source, "automatic");
  assert.equal(view.trigger, "mutation");
  assert.equal(view.taskEpoch, 4);
  assert.equal(view.sourceRun, 7);
  assert.ok(prompts[0].includes("[Trigger task — mutation]"), "the prompt carries the trigger task");
  assert.ok(prompts[0].includes("write a.ts"), "merged reasons appear in the prompt");
  assert.ok(!prompts[0].includes("[Manual note]"), "automatic runs carry no manual note");
  const result = runtime.snapshot().results[0];
  assert.equal(result.taskIdentity.sourceRun, 7, "the result freezes the triggering parent run for delivery policy");
}

{
  // Superseded is a distinct terminal outcome: a newer-task preemption
  // aborts the oldest previous-task automatic run and it records superseded.
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const first = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "old" }), trigger: "tool_turn", taskEpoch: 2 }));
  assert.equal(first.started, true);
  const second = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "current-a" }), trigger: "tool_turn", taskEpoch: 3 }));
  assert.equal(second.started, true, "a newer task still gets a slot (default limit 2)");
  const third = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "current-b" }), trigger: "tool_turn", taskEpoch: 3 }));
  assert.equal(third.started, false, "the third start finds the concurrency limit");
  assert.equal(third.kind, "busy");

  const preempted = runtime.preemptOldestAutomatic(3);
  assert.equal(preempted.ok, true, "the oldest previous-task automatic run is superseded");
  const view = await first.done;
  assert.equal(view.phase, "superseded", "superseded is observable, not cancelled");
  const snapshot = runtime.snapshot();
  assert.ok(snapshot.runs.some((run) => run.phase === "superseded"));

  // A freed slot lets the queued newer task start.
  const fourth = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "current-b" }), trigger: "tool_turn", taskEpoch: 3 }));
  assert.equal(fourth.started, true, "the superseded slot is immediately reusable");
  runtime.cancelRun(second.runId);
  runtime.cancelRun(fourth.runId);
  await Promise.all([second.done, fourth.done]);
}

{
  // Runtime enforces one active activation per Shadow independently of the
  // scheduler: duplicate automatic and manual starts both refuse until settle.
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const automatic = runtime.startAutomaticRun(baseRequest({ trigger: "tool_turn", taskEpoch: 2 }));
  assert.equal(automatic.started, true);
  const duplicate = runtime.startAutomaticRun(baseRequest({ trigger: "tool_turn", taskEpoch: 3 }));
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.kind, "busy");
  const manual = runtime.startManualRun(baseRequest({ taskEpoch: 3 }));
  assert.equal(manual.started, false, "same-Shadow manual work stays serialized rather than superseding by identity");
  runtime.cancelRun(automatic.runId);
  await automatic.done;
}

{
  // Manual starts preempt the oldest automatic run when every slot is busy;
  // manual runs are never superseded by automatic scheduling.
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const auto = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "auto" }), trigger: "tool_turn", taskEpoch: 1 }));
  assert.equal(auto.started, true);
  const manualOne = runtime.startManualRun(baseRequest({ definition: definition({ id: "manual-a" }), taskEpoch: 1 }));
  assert.equal(manualOne.started, true);
  const manualTwo = runtime.startManualRun(baseRequest({ definition: definition({ id: "manual-b" }), taskEpoch: 1 }));
  assert.equal(manualTwo.started, true, "a manual start supersedes an automatic run for a slot");
  const autoView = await auto.done;
  assert.equal(autoView.phase, "superseded", "the automatic run was superseded by the manual start");
  runtime.cancelRun(manualOne.runId);
  runtime.cancelRun(manualTwo.runId);
  await Promise.all([manualOne.done, manualTwo.done]);

  // All-manual contention refuses instead of superseding.
  const fakeTwo = makeFake({ script: abortSettled() });
  const runtimeTwo = createShadowRuntime({ config: () => config(), deps: fakeTwo.deps });
  const busyOne = runtimeTwo.startManualRun(baseRequest({ definition: definition({ id: "manual-a" }) }));
  const busyTwo = runtimeTwo.startManualRun(baseRequest({ definition: definition({ id: "manual-b" }) }));
  assert.equal((busyOne.started && busyTwo.started), true);
  const refused = runtimeTwo.startManualRun(baseRequest({ definition: definition({ id: "manual-c" }) }));
  assert.equal(refused.started, false, "with only manual runs busy, the third manual start refuses");
  const duplicate = runtimeTwo.startManualRun(baseRequest({ definition: definition({ id: "manual-a" }) }));
  assert.equal(duplicate.started, false, "one Shadow never has two concurrent manual runs");
  runtimeTwo.cancelRun(busyOne.runId);
  runtimeTwo.cancelRun(busyTwo.runId);
  await Promise.all([busyOne.done, busyTwo.done]);
}

{
  // User interruption cancels every current-task run, manual included;
  // previous-task runs survive.
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const oldTask = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "old" }), trigger: "tool_turn", taskEpoch: 2 }));
  const currentAuto = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "current-auto" }), trigger: "tool_turn", taskEpoch: 5 }));
  const currentManual = runtime.startManualRun(baseRequest({ definition: definition({ id: "current-manual" }), taskEpoch: 5 }));
  assert.equal((await Promise.all([oldTask.started, currentAuto.started, currentManual.started])).every(Boolean), true);
  assert.equal(runtime.cancelTaskRuns(5), 2, "both current-task runs were cancelled");
  const autoView = await currentAuto.done;
  const manualView = await currentManual.done;
  assert.equal(autoView.phase, "cancelled");
  assert.equal(manualView.phase, "cancelled");
  runtime.cancelRun(oldTask.runId);
  const oldView = await oldTask.done;
  assert.notEqual(oldView.phase, "cancelled");
}

{
  // Session pause cancels every automatic run and stamps why; manual runs
  // keep running and manual trials remain available afterwards.
  const fake = makeFake({ script: abortSettled() });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const auto = runtime.startAutomaticRun(baseRequest({ definition: definition({ id: "auto" }), trigger: "tool_turn", taskEpoch: 1 }));
  const manual = runtime.startManualRun(baseRequest({ definition: definition({ id: "manual" }), taskEpoch: 1 }));
  assert.equal(runtime.cancelAutomaticRuns("Session paused"), 1);
  const autoView = await auto.done;
  assert.equal(autoView.phase, "cancelled");
  assert.equal(autoView.message, "Session paused");
  assert.equal(
    runtime.snapshot().runs.find((run) => run.id === manual.runId).phase,
    "running",
    "pause never cancels manual trials",
  );
  runtime.cancelRun(manual.runId);
  await manual.done;
}

{
  // A run that outlives its task persists its result forced to notify.
  const fake = makeFake({ submit: JSON.stringify({ summary: "late" }) });
  let epoch = 4;
  const runtime = createShadowRuntime({
    config: () => config(),
    deps: fake.deps,
    currentTaskEpoch: () => epoch,
  });
  const outcome = runtime.startAutomaticRun(baseRequest({
    trigger: "tool_turn",
    taskEpoch: 4,
    triggerReasons: [{ trigger: "tool_turn", firstObservedAt: 1, lastObservedAt: 1, generation: 2 }],
  }));
  const gate = outcome.done;
  epoch = 5; // A new task began before the old run submitted.
  const view = await gate;
  assert.equal(view.phase, "submitted");
  const result = runtime.snapshot().results.find((entry) => entry.shadowId === view.shadowId);
  assert.equal(result.configuredDelivery, "notify", "stale-task results are forced to notify");
  assert.equal(result.source, "automatic");
  assert.equal(result.primaryTrigger, "tool_turn");
}

{
  // A current-task run keeps its configured delivery.
  const fake = makeFake({ submit: JSON.stringify({ summary: "now" }) });
  let epoch = 4;
  const runtime = createShadowRuntime({
    config: () => config(),
    deps: fake.deps,
    currentTaskEpoch: () => epoch,
  });
  const outcome = runtime.startAutomaticRun(baseRequest({
    trigger: "tool_turn",
    taskEpoch: 4,
    triggerReasons: [{ trigger: "tool_turn", firstObservedAt: 1, lastObservedAt: 1, generation: 2 }],
  }));
  const view = await outcome.done;
  const result = runtime.snapshot().results.find((entry) => entry.shadowId === view.shadowId);
  assert.equal(result.configuredDelivery, definition().delivery, "current-task delivery is untouched");
}

// ── confirmed-delivery inbox transitions (#159) ─────────────────────

{
  const fake = makeFake({ submit: JSON.stringify({ summary: "deliverable" }) });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  await runtime.startManualRun(baseRequest({ definition: definition({ delivery: "steer" }) })).done;
  const result = runtime.snapshot().results[0];
  assert.equal(result.configuredDelivery, "steer", "the definition policy rides the result");

  assert.equal(runtime.markResultDelivered(result.id), false, "a notified result cannot confirm delivery");
  assert.equal(runtime.sendResultForDelivery(result.id), true, "the delivery handoff marks the result pending");
  assert.equal(runtime.sendResultForDelivery(result.id), false, "the handoff is atomic");
  assert.equal(runtime.snapshot().results[0].delivery, "pending");
  assert.equal(runtime.markResultDelivered(result.id), true, "transcript confirmation delivers");
  assert.equal(runtime.markResultDelivered(result.id), false, "confirmation is single-shot");
  assert.equal(runtime.snapshot().results[0].delivery, "delivered");
  assert.equal(runtime.degradeResultDelivery(result.id), false, "a delivered result never degrades");

  await runtime.startManualRun(baseRequest({ definition: definition({ id: "second", name: "Second", delivery: "steer" }) })).done;
  const second = runtime.snapshot().results[0];
  assert.equal(runtime.sendResultForDelivery(second.id), true);
  assert.equal(runtime.degradeResultDelivery(second.id), true, "a degraded delivery returns inbox-only");
  const view = runtime.snapshot().results[0];
  assert.equal(view.delivery, "notified");
  assert.equal(view.configuredDelivery, "notify");
  assert.equal(runtime.sendResultForDelivery("missing"), false);
}

console.log("shadow-minds runtime tests: OK");
