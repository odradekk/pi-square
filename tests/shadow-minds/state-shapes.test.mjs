import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

import { addComposedEventHandler } from "../subagents/lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { default: registerShadowMinds } = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
const {
  createRegisteredState,
  isShadowSessionState,
  makeServices,
} = await load(join(packageRoot, "src", "shadow-minds", "state.ts"));
const { DEFAULT_CONFIG } = await load(join(packageRoot, "src", "core", "config.ts"));
const { installShadowFixtures } = await import("./lib/fixtures.mjs");

// Registered and session state shapes (odradekk/pi-square#373): the
// registration root holds one of the two shapes, session_start promotes the
// former into the latter, and every event that only makes sense for the
// session shape is an explicit, non-throwing no-op before a session exists.

const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-square-shadow-state-shapes-"));
const fixtureProject = join(fixtureRoot, "project");
mkdirSync(fixtureProject, { recursive: true });
installShadowFixtures(join(fixtureRoot, "agent"));
process.env.PI_AGENT_DIR = join(fixtureRoot, "agent");
process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");

function makeHarness() {
  const commands = new Map();
  const renderers = new Map();
  const handlers = new Map();
  const sent = [];
  const entries = [];
  const notifications = [];
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
    sendMessage(message, options) { sent.push({ message, options }); },
    sendUserMessage(message, options) { sent.push({ message, options }); },
    appendEntry(type, data) { entries.push({ type, data }); },
    // Pi invokes every handler registered for one event, so a second
    // subscriber (the delivery lifecycle subscription) never displaces the
    // first — mirror that composition here.
    on(event, handler) { addComposedEventHandler(handlers, event, handler); },
  };
  return { commands, renderers, handlers, sent, entries, notifications, pi };
}

function makeRuntimeDeps(created, ran) {
  return {
    now: () => 1_000,
    async createSession(input) {
      created.push(input);
      return { session: { customTools: input.customTools } };
    },
    async runSession(input) {
      ran.push(input);
      const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
      if (submit) {
        // One payload shape matches the structured schema, the other the
        // default summary schema; a rejection is an in-run retry, so try both.
        const payloads = [
          JSON.stringify({
            decisions: [{ title: "Adopt the registered shape", rationale: "It removes the half-filled state object." }],
            progress: "State-shape trial passed.",
            open_questions: [],
          }),
          JSON.stringify({ summary: "State-shape trial result." }),
        ];
        for (const payload of payloads) {
          const result = await submit.execute("c1", { payload }, undefined, undefined, {});
          if (!result?.isError) break;
        }
      }
      return {
        status: "completed", prompted: true, timedOut: false,
        finalText: "", model: "acme/parent-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        streamingCompleted: true, messages: [],
      };
    },
  };
}

function makeCommandCtx(cwd, notifications) {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      confirm: async () => true,
      custom: async () => {},
    },
    model: { provider: "acme", id: "parent-model" },
    modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [], getLeafId: () => undefined, buildContextEntries: () => [] },
    getSystemPromptOptions: () => ({ cwd }),
  };
}

function makeSessionCtx(cwd, sessionDir, notifications) {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    mode: "tui",
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      confirm: async () => true,
      custom: async () => {},
    },
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionId: () => "parent-state-shapes",
      getBranch: () => [],
      getLeafId: () => undefined,
    },
  };
}

const enabledConfig = () => ({
  ...DEFAULT_CONFIG,
  shadowMinds: { enabled: true, defaults: { ...DEFAULT_CONFIG.shadowMinds.defaults } },
});

// ── Registration owns the registered shape ──────────────────────────

{
  const harness = makeHarness();
  const created = [];
  const ran = [];
  const state = registerShadowMinds(harness.pi, enabledConfig, makeRuntimeDeps(created, ran));

  assert.equal(state.kind, "registered", "registration owns the registered shape");
  assert.equal(isShadowSessionState(state), false, "the guard narrows only the session shape");
  assert.equal("delivery" in state, false, "the registered shape owns no delivery core");
  assert.equal("gate" in state, false, "the registered shape owns no completion gate");
  assert.equal("partition" in state, false, "the registered shape owns no session partition");
  assert.equal("taskSnapshot" in state, false, "the registered shape owns no task snapshot");
  assert.equal(typeof state.refresh, "function", "registered-state methods exist from registration");
  assert.equal(typeof state.managerSnapshot, "function", "the manager view is reachable pre-session");
  state.refresh(fixtureProject);
  assert.ok(
    state.registry.definitions.some((definition) => definition.id === "session-synthesizer"),
    "the registry discovers definitions before any session starts",
  );
}

// ── Session-only events before session_start: explicit no-ops ───────

{
  const harness = makeHarness();
  const created = [];
  const ran = [];
  const state = registerShadowMinds(harness.pi, enabledConfig, makeRuntimeDeps(created, ran));
  const ctx = makeSessionCtx(fixtureProject, join(fixtureRoot, "session-dir-a"), harness.notifications);

  // The complete pre-session event battery: every handler that touches
  // session-only state must skip it explicitly instead of throwing.
  harness.handlers.get("input")({ source: "real" });
  await harness.handlers.get("before_agent_start")(
    { type: "before_agent_start", prompt: "task", systemPromptOptions: { cwd: fixtureProject, contextFiles: [] } },
    ctx,
  );
  harness.handlers.get("agent_start")();
  harness.handlers.get("message_start")({ message: { role: "user" } });
  harness.handlers.get("tool_execution_start")({ toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } });
  harness.handlers.get("tool_execution_end")({ toolCallId: "call-1", toolName: "bash", isError: false });
  await harness.handlers.get("turn_end")({ message: { stopReason: "stop" } }, ctx);
  await harness.handlers.get("agent_end")({ messages: [{ stopReason: "stop" }] }, ctx);
  harness.handlers.get("agent_settled")();

  assert.equal(state.kind, "registered", "no event before session_start promotes the state");
  assert.equal(isShadowSessionState(state), false, "the state stays registered through the battery");
  assert.equal(
    state.scheduler.snapshot().toolGeneration,
    1,
    "registered-state observations still apply: the scheduler records the tool generation",
  );
  assert.equal(harness.entries.length, 0, "no transcript reference is appended without a session");
  assert.equal(harness.sent.length, 0, "no message is sent without a session");

  // A manual trial still composes against the registered state, and its
  // result stays in the store without entering any session-scoped machine.
  const commandCtx = makeCommandCtx(fixtureProject, harness.notifications);
  const services = makeServices(state, commandCtx);
  const outcome = services.runtime.runManual({ shadowId: "session-synthesizer" });
  assert.equal(outcome.ok, true, outcome.message);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
  assert.equal(created.length, 1, "the trial ran through the injected child seam");
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
  assert.equal(state.runtime.snapshot().results.length, 1, "the trial result settles into the runtime view");
  assert.equal(state.resultStore.list().length, 1, "the trial result persists into the registered state's store");
  assert.equal(harness.entries.length, 0, "the pre-session result renders no transcript reference");
  assert.equal(harness.sent.length, 0, "the pre-session result enters no delivery machine");

  // Explicit delivery actions are session-scoped: refused with a truthful
  // reason, never a throw.
  const refused = services.delivery.sendResultToAgent("shr-missing");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /no longer available/, "a missing result refuses before the session gate");
  const preSessionResult = state.runtime.snapshot().results[0];
  assert.ok(preSessionResult, "the pre-session trial produced a result");
  const gated = services.delivery.sendResultToAgent(preSessionResult.id);
  assert.equal(gated.ok, false, "explicit sends stay unavailable before session_start");
  assert.match(gated.message, /once the parent session starts/, "the refusal names the session boundary truthfully");

  // Shutdown before any session started is equally explicit: no throw, no
  // drain, and the state stays registered for the first real session.
  await harness.handlers.get("session_shutdown")({ reason: "quit" });
  assert.equal(state.kind, "registered", "shutdown without a session leaves the registered shape");
}

// ── session_start promotes; the same handlers now drive session work ──

{
  const harness = makeHarness();
  const created = [];
  const ran = [];
  const state = registerShadowMinds(harness.pi, enabledConfig, makeRuntimeDeps(created, ran));
  const sessionDir = join(fixtureRoot, "session-dir-b");
  mkdirSync(sessionDir, { recursive: true });
  const ctx = makeSessionCtx(fixtureProject, sessionDir, harness.notifications);

  await harness.handlers.get("session_start")({}, ctx);
  assert.equal(state.kind, "session", "session_start converts the registered state into the session state");
  assert.equal(isShadowSessionState(state), true, "the guard now narrows");
  assert.equal(typeof state.delivery.pendingCount, "function", "the session shape owns the delivery core");
  assert.equal(typeof state.gate.handleRunTransition, "function", "the session shape owns the completion gate");
  assert.equal(state.partition?.sessionDir, sessionDir, "a persisted session publishes its partition");
  assert.equal(state.taskSnapshot, undefined, "the task snapshot is honestly undefined before the first task");

  // The same manual trial now enters the session-scoped machines: the result
  // reaches the delivery pending set and the transcript reference lands.
  // A real-user task opens the parent run: steer delivery enters only while
  // the source run is the active run, and the first task freezes its
  // authority snapshot.
  harness.handlers.get("input")({ source: "real" });
  await harness.handlers.get("before_agent_start")(
    { type: "before_agent_start", prompt: "task", systemPromptOptions: { cwd: fixtureProject, contextFiles: [] } },
    ctx,
  );
  assert.equal(state.taskSnapshot?.cwd, fixtureProject, "the first task freezes its authority snapshot");

  const commandCtx = makeCommandCtx(fixtureProject, harness.notifications);
  const services = makeServices(state, commandCtx);
  // project-grounding is a steer-delivery definition: its result enters the
  // confirmed-delivery machine instead of staying inbox-only.
  const outcome = services.runtime.runManual({ shadowId: "project-grounding" });
  assert.equal(outcome.ok, true, outcome.message);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
  assert.equal(created.length, 1, "the trial ran through the injected child seam");
  assert.equal(state.runtime.snapshot().results.length, 1, "the session runtime keeps the result");
  assert.equal(state.delivery.pendingCount(), 1, "the steer result enters the delivery machine and waits for confirmation");
  assert.equal(state.runtime.snapshot().results[0]?.delivery, "notified", "a running parent receives the result at the next turn boundary, not at enqueue");

  // The turn boundary flushes the pending batch to the idle-checking core:
  // sent into the transcript, kept pending until transcript confirmation.
  await harness.handlers.get("turn_end")({ message: { stopReason: "stop" } }, ctx);
  assert.equal(state.runtime.snapshot().results[0]?.delivery, "pending", "the store carries the sent-not-confirmed transition");
  assert.equal(harness.sent.length, 1, "the running parent receives the steer delivery at its turn boundary");
  assert.equal(harness.entries.length, 1, "the session result lands one bounded transcript reference");
  assert.equal(harness.entries[0].type, "pi-square.shadow-result");
  assert.ok(
    harness.notifications.some((entry) => entry.message.includes("finished")),
    "terminal run outcomes notify through the session UI",
  );
  assert.ok(harness.sent.length >= 1, "the idle parent receives the steer delivery at once");

  // Shutdown keeps the session shape (the next session_start re-promotes with
  // fresh session members), matching the pre-split object lifetime.
  await harness.handlers.get("session_shutdown")({ reason: "quit" });
  assert.equal(state.kind, "session", "shutdown does not demote the state");
  assert.equal(
    state.taskSnapshot?.cwd,
    fixtureProject,
    "the frozen task snapshot survives shutdown until the next session_start, as before the split",
  );
}

// ── The state factory alone gives manager tests a usable state ──────

{
  // #373: a manager-service test no longer loads the registration root to
  // obtain a usable state — the state module builds the registered shape and
  // its services directly.
  const state = createRegisteredState({
    config: enabledConfig,
    runtimeDeps: makeRuntimeDeps([], []),
  });
  assert.equal(state.kind, "registered");
  state.refresh(fixtureProject);
  const commandCtx = makeCommandCtx(fixtureProject, []);
  const services = makeServices(state, commandCtx);
  const missing = services.runtime.runManual({ shadowId: "missing-role" });
  assert.equal(missing.ok, false, "a factory-built state drives the manager services without the registration root");
  assert.match(missing.message, /no longer available/);
}

console.log("shadow-minds state-shape tests: OK");
