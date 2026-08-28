import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

// #191: file-driven refresh meets the scheduler. Reopening /shadow reloads
// definition files and immediately revalidates pending activations against
// the refreshed registry — deleted, disabled, invalid, or unsubscribed work
// drops with visible scheduling evidence — while running work keeps its
// frozen definition and authority and completed inbox results are never
// mutated by a refresh.

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { createShadowScheduler } = await load(join(packageRoot, "src", "shadow-minds", "scheduler.ts"));

function definition(over = {}) {
  return {
    id: "lens",
    name: "Architecture lens",
    enabled: true,
    hidden: false,
    priority: 0,
    triggers: ["mutation", "completion"],
    triggerInstructions: {},
    delivery: "steer",
    completionGate: false,
    requiredTools: [],
    debug: false,
    outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    body: "Watch architecture.",
    fieldSources: {},
    layers: [],
    ...over,
  };
}

function makeSchedulerHarness(options = {}) {
  const state = {
    config: options.config ?? {
      enabled: true,
      defaults: {
        maxConcurrentRuns: 2,
        maxAutomaticStartsPerTask: 8,
        runTimeoutSeconds: 120,
        maxModelTurnsPerRun: 8,
        maxToolCallsPerRun: 16,
        completionGateWindowSeconds: 10,
        headlessDrainSeconds: 30,
        maxQueuedShadowIds: 32,
      },
    },
    definitions: options.definitions ?? [definition()],
    starts: [],
    clock: 1000,
  };
  const scheduler = createShadowScheduler({
    now: () => state.clock,
    config: () => state.config,
    definitions: () => state.definitions,
    start(input) {
      state.starts.push(input);
      return { outcome: "busy" };
    },
    preemptOldestAutomatic() { return { ok: false }; },
    activeRun() { return undefined; },
    cancelTaskRuns() { return 0; },
    cancelAutomaticRuns() { return 0; },
    forceNotifyOldResults() { return 0; },
  });
  return { state, scheduler };
}

/** Queues one pending mutation activation (busy start keeps it pending). */
function queuePendingMutation(harness) {
  harness.scheduler.handleInput("interactive");
  harness.scheduler.handleRunStart(true);
  harness.scheduler.observeToolStart("write", { file_path: "src/a.ts" });
  harness.scheduler.observeToolEnd("write", false, { file_path: "src/a.ts" });
  harness.state.clock += 1;
  harness.scheduler.handleTurnEnd({ pinned: "checkpoint" });
}

// ── Refresh revalidates pending work immediately (#191) ─────────────

{
  // Deleted definition: the pending activation drops with visible evidence.
  const harness = makeSchedulerHarness();
  queuePendingMutation(harness);
  assert.equal(harness.scheduler.snapshot().pending.length, 1, "sanity: the activation is queued");

  const startsBefore = harness.state.starts.length;
  harness.state.definitions = [];
  harness.scheduler.revalidate();
  const snapshot = harness.scheduler.snapshot();
  assert.equal(snapshot.pending.length, 0, "a deleted definition drops its pending activation at refresh");
  assert.ok(
    snapshot.diagnostics.some((line) => line.includes("'lens'") && line.includes("no longer eligible")),
    "the drop is visible in the scheduling diagnostics",
  );
  assert.equal(harness.state.starts.length, startsBefore, "nothing started from stale configuration");
}

{
  // Disabled definition.
  const harness = makeSchedulerHarness();
  queuePendingMutation(harness);
  harness.state.definitions = [definition({ enabled: false })];
  harness.scheduler.revalidate();
  assert.equal(harness.scheduler.snapshot().pending.length, 0, "a disabled definition drops its pending activation");
}

{
  // Hidden definition.
  const harness = makeSchedulerHarness();
  queuePendingMutation(harness);
  harness.state.definitions = [definition({ hidden: true })];
  harness.scheduler.revalidate();
  assert.equal(harness.scheduler.snapshot().pending.length, 0, "a hidden definition drops its pending activation");
}

{
  // Invalid definitions leave the registry, so their pending work drops the
  // same way (the refreshed registry simply does not contain the ID).
  const harness = makeSchedulerHarness({ definitions: [definition({ id: "broken" })] });
  queuePendingMutation(harness);
  harness.state.definitions = [definition({ id: "other" })];
  harness.scheduler.revalidate();
  assert.equal(harness.scheduler.snapshot().pending.length, 0, "an invalidated definition drops its pending activation");
}

{
  // No-longer-subscribed trigger drops the activation; a still-subscribed
  // reason survives with its rank and priority refreshed.
  const harness = makeSchedulerHarness();
  queuePendingMutation(harness);
  harness.state.definitions = [definition({ triggers: ["completion"] })];
  harness.scheduler.revalidate();
  assert.equal(harness.scheduler.snapshot().pending.length, 0, "an unsubscribed trigger drops the activation");

  const both = makeSchedulerHarness();
  queuePendingMutation(both);
  both.state.definitions = [definition({ priority: 7 })];
  both.scheduler.revalidate();
  const kept = both.scheduler.snapshot().pending;
  assert.equal(kept.length, 1, "still-eligible activations survive the revalidation");
  assert.equal(kept[0].shadowPriority, 7, "the refreshed priority replaces the queued snapshot priority");
}

{
  // Trust never enters the decision: the revalidation contract is registry-
  // driven only. (No trust input exists; this pins the seam's shape.)
  const harness = makeSchedulerHarness();
  queuePendingMutation(harness);
  harness.scheduler.revalidate();
  assert.equal(harness.scheduler.snapshot().pending.length, 1, "an unchanged registry keeps the activation queued");
}

// ── Full user-owned lifecycle through the real wiring (#191) ─────────

{
  const { default: registerShadowMinds } = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
  const { __testables } = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
  const { loadConfig } = await load(join(packageRoot, "src", "core", "config.ts"));

  const dir = mkdtempSync(join(tmpdir(), "pi-square-shadow-lifecycle-"));
  const agentDir = join(dir, "agent");
  const project = join(dir, "project");
  mkdirSync(join(agentDir, "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const projectScope = join(project, ".pi", "shadow-minds");
    const agentScope = join(agentDir, "shadow-minds");
    const writeDefinition = (scopeDir, id, lines) => {
      mkdirSync(scopeDir, { recursive: true });
      writeFileSync(join(scopeDir, `${id}.md`), lines.join("\n"), "utf8");
    };

    // 1. Natural-language CRUD lands as ordinary files in both scopes.
    writeDefinition(agentScope, "lifecycle-lens", [
      "---", "promptVersion: 1", "id: lifecycle-lens", "name: Lifecycle lens",
      "triggers: [mutation]", "delivery: wake", "tools: [read]", "---", "Watch the lifecycle.", "",
    ]);
    writeDefinition(projectScope, "lifecycle-lens", [
      "---", "promptVersion: 1", "id: lifecycle-lens", "enabled: true", "---", "",
    ]);

    // 2. Explicit master enablement through the real agent config file,
    //    preserving unrelated settings.
    mkdirSync(join(agentDir, "config"), { recursive: true });
    writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
      banner: { enabled: false },
      shadowMinds: { enabled: true },
    }), "utf8");
    const loaded = loadConfig(project);
    assert.equal(loaded.config.shadowMinds.enabled, true, "the explicit enablement loads");
    assert.equal(loaded.config.banner.enabled, false, "unrelated settings survive");

    const harness = {
      commands: new Map(), renderers: new Map(), handlers: new Map(),
      events: [], entries: [], notifications: [], statusCalls: [],
    };
    const pi = {
      registerCommand: (name, definition) => harness.commands.set(name, definition),
      registerMessageRenderer: (name, renderer) => harness.renderers.set(name, renderer),
      on: (event, handler) => harness.handlers.set(event, handler),
      sendMessage: (message, options) => harness.events.push(["guide", message, options]),
      sendUserMessage: (message, options) => harness.events.push(["user", message, options]),
      appendEntry: (type, data) => harness.entries.push({ type, data }),
    };
    // Unapproved project: definitions and rules participate identically (#188).
    const eventCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        custom: async () => {},
        confirm: async () => true,
        notify: (message, level) => harness.notifications.push({ message, level }),
        setStatus: (key, text) => harness.statusCalls.push({ key, text }),
      },
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
      sessionManager: {
        getSessionDir: () => "",
        getSessionFile: () => undefined,
        getSessionId: () => "lifecycle-1",
        getLeafId: () => "leaf-1",
        getBranch: () => [{ type: "message", message: { role: "user", content: "Ship the feature." } }],
        buildContextEntries: () => [{ type: "message", message: { role: "user", content: "Ship the feature." } }],
      },
    };

    const created = [];
    const ran = [];
    const hold = { active: false };
    const runtimeDeps = {
      now: () => 1_000,
      async createSession(input) {
        created.push(input);
        return { session: { customTools: input.customTools } };
      },
      async runSession(input) {
        if (hold.active) {
          await new Promise((resolveHold) => input.signal.addEventListener("abort", () => resolveHold(), { once: true }));
          return { status: "aborted", prompted: true, timedOut: false, finalText: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, streamingCompleted: false, messages: [] };
        }
        ran.push(input);
        const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
        if (submit) {
          await submit.execute("c1", { payload: JSON.stringify({ summary: "lifecycle finding" }) }, undefined, undefined, eventCtx);
        }
        return { status: "completed", prompted: true, timedOut: false, finalText: "", model: "acme/parent-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, streamingCompleted: true, messages: [] };
      },
    };
    const state = registerShadowMinds(pi, () => loaded.config, runtimeDeps);
    await harness.handlers.get("session_start")({}, eventCtx);

    // 3. Reopening the manager rediscovers and shows the merged definition.
    await harness.commands.get("shadow").handler("", eventCtx);
    const merged = state.registry.definitions.find((definition) => definition.id === "lifecycle-lens");
    assert.ok(merged, "the file-authored definition is discovered after the reopen");
    assert.equal(merged.enabled, true, "the project overlay enables the agent base");
    const managerSnapshot = state.managerSnapshot();
    assert.equal(managerSnapshot.definitions.length, 1);
    assert.deepEqual(managerSnapshot.diagnostics, [], "a clean registry reports no diagnostics");

    // 4. Manual trial through the read-only manager services.
    const services = __testables.makeServices(state, eventCtx);
    const started = services.runtime.runManual({ shadowId: "lifecycle-lens" });
    assert.equal(started.ok, true, started.message);
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    assert.equal(created.length, 1, "the manual trial created its child session");
    assert.deepEqual(created[0].tools, ["read", "submit_shadow_result"], "the fixed read-only catalog resolves the envelope");
    assert.ok(!created[0].system.includes("WRITE"), "the envelope stays read-only for an unapproved project");

    // 5. Automatic trigger, delivery, and inbox confirmation.
    const deliveriesBeforeAuto = harness.events.filter((event) => event[0] === "guide" && event[1].customType === "pi-square.shadow-notification").length;
    harness.handlers.get("input")({ type: "input", text: "work", source: "interactive" });
    await harness.handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "work", systemPromptOptions: { cwd: project, customPrompt: "Core.", contextFiles: [] } },
      eventCtx,
    );
    harness.handlers.get("agent_start")({ type: "agent_start" }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { file_path: "src/a.ts" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: {}, isError: false });
    await harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    assert.equal(created.length, 2, "the mutation trigger started the automatic run");
    const automatic = state.runtime.snapshot().runs.find((run) => run.source === "automatic");
    assert.ok(automatic, "the automatic run is recorded with its source");
    const deliveries = () => harness.events.filter((event) => event[0] === "guide" && event[1].customType === "pi-square.shadow-notification");
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    assert.equal(deliveries().length, deliveriesBeforeAuto + 1, "the settled parent received the automatic run's wake delivery");
    await harness.handlers.get("message_start")({ type: "message_start", message: deliveries().at(-1)[1] }, eventCtx);
    const deliveredResult = state.runtime.snapshot().results.find((result) => result.source === "automatic");
    assert.ok(deliveredResult, "the automatic run produced its result");
    assert.equal(deliveredResult.delivery, "delivered", "transcript observation confirmed the delivery");

    // 6. Completed inbox results survive later refreshes untouched.
    const resultsBefore = structuredClone(state.runtime.snapshot().results);
    await harness.commands.get("shadow").handler("", eventCtx);
    assert.deepEqual(
      state.runtime.snapshot().results.map((result) => ({ id: result.id, delivery: result.delivery, attention: result.attention })),
      resultsBefore.map((result) => ({ id: result.id, delivery: result.delivery, attention: result.attention })),
      "a refresh never mutates completed inbox results",
    );

    // 7. Running work stays frozen while files change underneath it, and a
    //    busy slot keeps a fresh activation pending until the refresh decides.
    hold.active = true;
    harness.handlers.get("input")({ type: "input", text: "next", source: "interactive" });
    await harness.handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "next", systemPromptOptions: { cwd: project, customPrompt: "Second core.", contextFiles: [{ path: "/p/R.md", content: "RULE-2" }] } },
      eventCtx,
    );
    harness.handlers.get("agent_start")({ type: "agent_start" }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t2", toolName: "edit", args: { file_path: "src/b.ts" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t2", toolName: "edit", result: {}, isError: false });
    await harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    const frozenRun = state.runtime.snapshot().runs.find((run) => run.phase === "running");
    assert.ok(frozenRun, "the second automatic run is held active");
    const frozenStart = created.at(-1);
    const frozenId = frozenRun.id;

    // A third task queues one more mutation activation; the busy slot keeps
    // it pending rather than starting a duplicate run.
    harness.handlers.get("input")({ type: "input", text: "third", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "third", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t3", toolName: "write", args: { file_path: "src/c.ts" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t3", toolName: "write", result: {}, isError: false });
    await harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    assert.equal(state.scheduler.snapshot().pending.length, 1, "the busy slot keeps the new activation pending");

    // 8. Correction loop: an invalid file is diagnosed at the reopen, the
    //    pending activation drops with visible evidence, and the running run
    //    keeps its frozen definition and authority.
    writeDefinition(agentScope, "lifecycle-lens", [
      "---", "promptVersion: 1", "id: lifecycle-lens", "name: Broken lens", "color: red", "---", "Body.", "",
    ]);
    await harness.commands.get("shadow").handler("", eventCtx);
    assert.ok(state.registry.invalid.some((entry) => entry.id === "lifecycle-lens"), "the invalid file is diagnosed");
    assert.equal(state.registry.definitions.length, 0, "no definition runs from the invalid file");
    assert.equal(state.scheduler.snapshot().pending.length, 0, "the pending activation dropped at the refresh");
    assert.ok(state.scheduler.snapshot().diagnostics.length > 0, "the drop is visible in the scheduling notes");
    assert.equal(state.runtime.snapshot().runs.filter((run) => run.phase === "running").length, 1, "the running run survives the refresh");
    assert.equal(
      state.runtime.snapshot().results.length,
      resultsBefore.length,
      "the refresh never mutated the completed inbox results",
    );

    services.runtime.cancelRun(frozenId);
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    const frozenView = state.runtime.snapshot().runs.find((run) => run.id === frozenId);
    assert.ok(frozenView, "the frozen run stays observable after cancellation");
    assert.deepEqual(frozenView.toolNames, ["read"], "the run keeps its frozen tool envelope after file changes");
    assert.ok(ran.at(-1).prompt.includes("Watch the lifecycle."), "the run kept its frozen responsibility body");
    assert.ok(frozenStart.system.includes("Second core."), "the run kept its frozen authority snapshot");

    // Repair: the file returns to a valid shape and rediscovery picks it up.
    writeDefinition(agentScope, "lifecycle-lens", [
      "---", "promptVersion: 1", "id: lifecycle-lens", "name: Healed lens",
      "triggers: [mutation]", "delivery: wake", "tools: [read]", "---", "Healed body.", "",
    ]);
    await harness.commands.get("shadow").handler("", eventCtx);
    const healed = state.registry.definitions.find((definition) => definition.id === "lifecycle-lens");
    assert.ok(healed, "the repaired file returns to the effective catalog");
    assert.equal(healed.enabled, true, "the project overlay enablement is honored after repair");

    // 9. The parameterized command keeps its ordering contract end to end.
    await harness.commands.get("shadow").handler("  tighten the lens budget  ", eventCtx);
    assert.equal(harness.events.at(-2)[0], "guide");
    assert.equal(harness.events.at(-1)[0], "user");
    assert.equal(harness.events.at(-1)[1], "  tighten the lens budget  ", "the request is forwarded byte-for-byte");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("shadow-minds refresh revalidation tests: OK");
