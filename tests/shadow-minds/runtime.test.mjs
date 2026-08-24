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
    enabled: true,
    defaults: { ...DEFAULT_SHADOW_MINDS, ...overrides.defaults },
    ...overrides,
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
    trajectory: { text: "[user] hello", includedMessages: 1, totalMessages: 1, truncated: false },
    cwd: "/repo",
    ...overrides,
  };
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
      await tool.execute("c2", { payload: JSON.stringify({ summary: "Corrected." }) }, undefined, undefined, {});
      return { ...COMPLETED_NO_SUBMISSION, usage: { ...COMPLETED_NO_SUBMISSION.usage, turns: 2 } };
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
  assert.ok(terminal.message.length <= 400, "the failure message stays bounded");
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
      input.onEvent?.({ type: "message_start", message: { role: "assistant" } });
      assert.equal(input.signal.aborted, true, "the over-budget turn aborts the session");
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted" };
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "max_turns", "a bounded outcome is not an infrastructure failure");
}

{
  // max tool calls: the call over the budget aborts before executing.
  const fake = makeFake({
    script: async (input) => {
      for (let index = 0; index < DEFAULT_SHADOW_MINDS.maxToolCallsPerRun + 1; index += 1) {
        input.onEvent?.({ type: "tool_execution_start", toolCallId: `c${index}`, toolName: SUBMIT_SHADOW_RESULT_TOOL });
      }
      assert.equal(input.signal.aborted, true);
      return { ...COMPLETED_NO_SUBMISSION, status: "aborted" };
    },
  });
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const terminal = await runtime.startManualRun(baseRequest()).done;
  assert.equal(terminal.phase, "max_tool_calls");
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

console.log("shadow-minds runtime tests: OK");
