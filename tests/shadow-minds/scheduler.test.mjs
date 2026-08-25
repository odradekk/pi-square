import assert from "node:assert/strict";
import jiti from "jiti";

const schedulerModule = jiti(import.meta.url)("../../src/shadow-minds/scheduler.ts", { moduleCache: false });
const {
  classifyQualityCommand,
  isMutationToolName,
  MUTATION_TOOL_NAMES,
  TRIGGER_PRIORITY,
  mergeTriggerReason,
  orderReasons,
  compareActivations,
  formatTriggerReason,
  createShadowScheduler,
} = schedulerModule;

// ── Pure boundaries ────────────────────────────────────────────────

{
  assert.deepEqual(TRIGGER_PRIORITY, { completion: 3, failure: 2, mutation: 1, tool_turn: 0 });
  assert.deepEqual([...MUTATION_TOOL_NAMES], ["edit", "write", "replace", "revert"]);
  assert.equal(isMutationToolName("edit"), true);
  assert.equal(isMutationToolName("bash"), false, "shell is never a declarative mutation");
  assert.equal(isMutationToolName("some_mcp_write_thing"), false, "unknown tools are never guessed");
}

{
  // Quality-command classifier: declarative families only.
  assert.equal(classifyQualityCommand("npm test"), "test");
  assert.equal(classifyQualityCommand("npm run test"), "test");
  assert.equal(classifyQualityCommand("npm run test -- --watch=false"), "test");
  assert.equal(classifyQualityCommand("CI=1 npm run build"), "build", "env prefix is stripped");
  assert.equal(classifyQualityCommand("pnpm --filter pkg typecheck"), "typecheck", "flags before the verb are skipped");
  assert.equal(classifyQualityCommand("yarn run smoke"), "smoke");
  assert.equal(classifyQualityCommand("npm run package-check"), "package-check");
  assert.equal(classifyQualityCommand("npm run package:check"), "package-check");
  assert.equal(classifyQualityCommand("npx tsc --noEmit"), "typecheck", "direct tsc binary");
  assert.equal(classifyQualityCommand("make test"), "test");

  // Not classified: arbitrary scripts and probes.
  assert.equal(classifyQualityCommand("npm run deploy"), undefined);
  assert.equal(classifyQualityCommand("curl -sf http://localhost || exit 1"), undefined);
  assert.equal(classifyQualityCommand("pytest"), undefined, "unfamiliar runners stay unclassified");
  assert.equal(classifyQualityCommand("grep -r TODO ."), undefined);
  assert.equal(classifyQualityCommand("npm run deploy-and-test-everything"), undefined, "substring matches do not qualify");
  assert.equal(classifyQualityCommand(""), undefined);
}

{
  // Reason merge: first/last timestamps, detail replacement, bounded detail.
  const reasons = [];
  mergeTriggerReason(reasons, { trigger: "mutation", at: 10, detail: "write a.ts" });
  mergeTriggerReason(reasons, { trigger: "mutation", at: 30, detail: "write b.ts" });
  assert.equal(reasons.length, 1, "same trigger merges into one reason");
  assert.equal(reasons[0].firstObservedAt, 10);
  assert.equal(reasons[0].lastObservedAt, 30);
  assert.equal(reasons[0].detail, "write b.ts");
  mergeTriggerReason(reasons, { trigger: "failure", at: 20, detail: "test command failed" });
  const ordered = orderReasons(reasons);
  assert.equal(ordered[0].trigger, "failure", "failure outranks mutation");
  const long = mergeTriggerReason([], { trigger: "mutation", at: 1, detail: "x".repeat(500) });
  assert.ok(long[0].detail.length <= 160, "details are bounded");
  assert.equal(formatTriggerReason({ trigger: "tool_turn", firstObservedAt: 1, lastObservedAt: 2, generation: 7 }), "tool_turn: generation 7");
}

{
  // Deterministic arbitration: epoch, trigger priority, shadow priority, ID.
  const base = { reasons: [], generation: 0, checkpoint: undefined, enqueuedAt: 0, lastObservedAt: 0 };
  const activation = (over) => ({ ...base, bestTrigger: "tool_turn", shadowPriority: 0, ...over });
  const older = activation({ shadowId: "a", taskEpoch: 1 });
  const newer = activation({ shadowId: "z", taskEpoch: 2 });
  assert.equal(compareActivations(newer, older) < 0, true, "newer task generation outranks everything");
  const completion = activation({ shadowId: "z", taskEpoch: 1, bestTrigger: "completion" });
  const failure = activation({ shadowId: "a", taskEpoch: 1, bestTrigger: "failure" });
  assert.equal(compareActivations(completion, failure) < 0, true, "completion outranks failure");
  const high = activation({ shadowId: "z", taskEpoch: 1, shadowPriority: 5 });
  const low = activation({ shadowId: "a", taskEpoch: 1, shadowPriority: 1 });
  assert.equal(compareActivations(high, low) < 0, true, "shadow priority breaks trigger ties");
  const same = [activation({ shadowId: "b" }), activation({ shadowId: "a" }), activation({ shadowId: "c" })]
    .sort(compareActivations);
  assert.deepEqual(same.map((item) => item.shadowId), ["a", "b", "c"], "ID is the final stable order");
}

// ── Scheduler harness ─────────────────────────────────────────────

function makeHarness(options = {}) {
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
    definitions: options.definitions ?? [],
    starts: [],
    preemptions: [],
    cancelledTaskRuns: [],
    cancelledAutomatic: 0,
    forcedNotifyBefore: [],
    activeShadows: new Set(options.activeShadows ?? []),
    clock: 1000,
  };
  const scheduler = createShadowScheduler({
    now: () => state.clock,
    config: () => state.config,
    definitions: () => state.definitions,
    start(input) {
      state.starts.push(input);
      const busy = options.busyUntil !== undefined && state.starts.length > options.busyUntil;
      if (busy) return { outcome: "busy" };
      if (options.failStarts?.includes(input.definition.id)) {
        return { outcome: "failed", reason: "model unavailable" };
      }
      return { outcome: "started", runId: `run-${state.starts.length}` };
    },
    preemptOldestAutomatic(currentEpoch) {
      state.preemptions.push(currentEpoch);
      if (options.preemptFails) return { ok: false };
      return { ok: true, runId: "run-old" };
    },
    activeRun(shadowId) {
      return state.activeShadows.has(shadowId) ? { source: "automatic", taskEpoch: 2 } : undefined;
    },
    cancelTaskRuns(epoch) {
      state.cancelledTaskRuns.push(epoch);
      return options.cancelledTaskCount ?? 0;
    },
    cancelAutomaticRuns() {
      state.cancelledAutomatic += 1;
      return options.cancelledAutomaticCount ?? 0;
    },
    forceNotifyOldResults(beforeEpoch) {
      state.forcedNotifyBefore.push(beforeEpoch);
      return options.forcedNotifyCount ?? 0;
    },
  });
  return { state, scheduler };
}

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

/** Drives one real-user turn with the given tool events. */
function runRealUserTurn(harness, toolEvents = [], { turnEnd = true } = {}) {
  harness.scheduler.handleInput("interactive");
  harness.scheduler.handleRunStart(true);
  for (const event of toolEvents) {
    harness.scheduler.observeToolStart(event.tool, event.args);
    harness.scheduler.observeToolEnd(event.tool, event.isError ?? false, event.args);
    harness.state.clock += 1;
  }
  if (turnEnd) harness.scheduler.handleTurnEnd({ marker: harness.state.clock });
  return harness;
}

// ── AC1: only real-user parent runs create trigger opportunities ──

{
  const { state, scheduler } = makeHarness({ definitions: [definition()] });
  // Extension continuation: input + run + tools + turn end → no activation.
  scheduler.handleInput("extension");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("write", { file_path: "a.ts" });
  scheduler.observeToolEnd("write", false, { file_path: "a.ts" });
  scheduler.handleTurnEnd({ marker: 1 });
  assert.equal(state.starts.length, 0, "extension continuations never trigger");

  // A run opened without a preceding real-user input (launch continuation)
  // is not a trigger opportunity either.
  scheduler.handleInput("extension");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("edit", { file_path: "b.ts" });
  scheduler.handleTurnEnd({ marker: 2 });
  assert.equal(state.starts.length, 0);
}

{
  // Real-user runs trigger; rpc input counts as a real user.
  const { state, scheduler } = makeHarness({ definitions: [definition()] });
  scheduler.handleInput("rpc");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("write", { file_path: "a.ts" });
  scheduler.observeToolEnd("write", false, { file_path: "a.ts" });
  scheduler.handleTurnEnd({ marker: 1 });
  assert.equal(state.starts.length, 1, "rpc input is a real user task");
}

// ── AC2: mutation metadata and quality failures; dirty generations ─

{
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["mutation"] })] });
  runRealUserTurn({ state, scheduler }, [
    { tool: "write", args: { file_path: "src/a.ts" } },
    { tool: "bash", args: { command: "npm run deploy" }, isError: true },
    { tool: "grep", args: { pattern: "x" } },
  ]);
  assert.equal(state.starts.length, 1, "mutation starts the subscribed Shadow");
  assert.deepEqual(
    state.starts[0].reasons.map((reason) => reason.trigger),
    ["mutation"],
  );
  assert.equal(state.starts[0].reasons[0].detail, "write src/a.ts");
  assert.ok(state.starts[0].generation > 0, "generation is carried");
}

{
  // Unsuccessful mutations and unclassified failures never trigger.
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["mutation", "failure"] })] });
  runRealUserTurn({ state, scheduler }, [
    { tool: "write", args: { file_path: "a.ts" }, isError: true },
    { tool: "bash", args: { command: "curl -x http://localhost" }, isError: true },
  ]);
  assert.equal(state.starts.length, 0, "failed writes and unclassified failures do not trigger");
}

{
  // Anchored mutation refusals and noops are non-error tool outcomes, but they
  // changed nothing and must not create a successful mutation trigger.
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["mutation"] })] });
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("replace", { path: "a.ts" });
  scheduler.observeToolEnd("replace", false, { path: "a.ts" }, { details: { status: "warning", errorCode: "E_RANGE_STALE" } });
  scheduler.observeToolStart("replace", { path: "a.ts" });
  scheduler.observeToolEnd("replace", false, { path: "a.ts" }, { details: { classification: "noop" } });
  scheduler.handleTurnEnd({});
  assert.equal(state.starts.length, 0, "refused/noop anchored edits do not trigger mutation Shadows");

  scheduler.observeToolStart("replace", { path: "a.ts" });
  scheduler.observeToolEnd("replace", false, { path: "a.ts" }, { details: { metrics: { classification: "applied" } } });
  scheduler.handleTurnEnd({});
  assert.equal(state.starts.length, 1, "an applied anchored edit triggers the subscribed Shadow");
}

{
  // Quality-command failure classification.
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["failure"] })] });
  runRealUserTurn({ state, scheduler }, [
    { tool: "bash", args: { command: "npm run typecheck" }, isError: true },
  ]);
  assert.equal(state.starts.length, 1);
  assert.equal(state.starts[0].reasons[0].trigger, "failure");
  assert.equal(state.starts[0].reasons[0].detail, "typecheck command failed");
}

{
  // tool_turn: unreviewed dirty generations.
  const { state, scheduler } = makeHarness({ definitions: [definition({ id: "ground", triggers: ["tool_turn"] })] });
  runRealUserTurn({ state, scheduler }, [{ tool: "read", args: { path: "x" } }]);
  assert.equal(state.starts.length, 1, "tool activity starts a tool-turn Shadow");
  assert.equal(state.starts[0].reasons[0].trigger, "tool_turn");

  // The reviewed generation is not re-run; a new generation runs again.
  state.clock += 100;
  runRealUserTurn({ state, scheduler }, []);
  assert.equal(state.starts.length, 1, "no new activity means no new start");

  state.clock += 100;
  runRealUserTurn({ state, scheduler }, [{ tool: "grep", args: { pattern: "y" } }]);
  assert.equal(state.starts.length, 2, "a new dirty generation starts again");
  assert.ok(state.starts[1].generation > state.starts[0].generation);
}

// ── AC3: same-turn coalescing; latest pending checkpoint ──────────

{
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["mutation", "tool_turn"] })] });
  runRealUserTurn({ state, scheduler }, [
    { tool: "read", args: { path: "a" } },
    { tool: "write", args: { file_path: "b.ts" } },
    { tool: "write", args: { file_path: "c.ts" } },
  ]);
  assert.equal(state.starts.length, 1, "mutation and tool-turn reasons from one turn coalesce into one activation");
  const reasons = state.starts[0].reasons.map((reason) => reason.trigger).sort();
  assert.deepEqual(reasons, ["mutation", "tool_turn"]);
  assert.equal(state.starts[0].reasons.find((reason) => reason.trigger === "mutation").detail, "write c.ts", "the latest observation wins");
}

{
  // A running Shadow retains one latest pending checkpoint: while busy, a
  // second activation for the same Shadow replaces the pending snapshot and
  // unions reasons; it dispatches when a slot frees.
  let busy = true;
  const harness = makeHarness({
    definitions: [definition({ id: "ground", triggers: ["tool_turn"] })],
  });
  harness.state.definitions.push(definition({ id: "other", triggers: ["tool_turn"] }));
  // Make starts busy for the second activation only, then free.
  const attempts = [];
  const successes = [];
  let startCount = 0;
  const schedulerWithBusy = createShadowScheduler({
    now: () => harness.state.clock,
    config: () => harness.state.config,
    definitions: () => harness.state.definitions,
    start(input) {
      startCount += 1;
      attempts.push(input);
      if (startCount === 1) {
        successes.push(input);
        return { outcome: "started", runId: "run-1" };
      }
      if (busy && input.definition.id === "ground") return { outcome: "busy" };
      successes.push(input);
      return { outcome: "started", runId: `run-${startCount}` };
    },
    preemptOldestAutomatic: () => ({ ok: false }),
    activeRun: () => undefined,
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  runRealUserTurn({ state: harness.state, scheduler: schedulerWithBusy }, [{ tool: "read", args: {} }]);
  assert.equal(startCount, 2, "both tool-turn Shadows started in the first turn");
  harness.state.clock += 50;
  schedulerWithBusy.handleInput("interactive");
  schedulerWithBusy.handleRunStart(true);
  schedulerWithBusy.observeToolStart("grep", { pattern: "later" });
  schedulerWithBusy.handleTurnEnd({ marker: "latest" });
  // ground stayed queued (busy); exactly one pending entry exists for it.
  const pending = schedulerWithBusy.snapshot().pending.filter((entry) => entry.shadowId === "ground");
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].checkpoint, { marker: "latest" }, "the pending checkpoint is the latest observation");
  busy = false;
  schedulerWithBusy.handleRunSettled();
  const groundStarts = successes.filter((input) => input.definition.id === "ground");
  assert.equal(groundStarts.length, 2, "the queued activation dispatches when a slot frees");
  assert.deepEqual(groundStarts[1].checkpoint, { marker: "latest" });
}

// ── AC4: arbitration order at dispatch ────────────────────────────

{
  // Trigger priority order: completion > failure > mutation > tool_turn.
  const order = [];
  const harness = makeHarness({});
  const defs = [
    definition({ id: "a-tool", triggers: ["tool_turn"] }),
    definition({ id: "b-mut", triggers: ["mutation"] }),
    definition({ id: "c-fail", triggers: ["failure"] }),
    definition({ id: "d-comp", triggers: ["completion"] }),
  ];
  harness.state.definitions.push(...defs);
  const scheduler = createShadowScheduler({
    now: () => harness.state.clock,
    config: () => harness.state.config,
    definitions: () => harness.state.definitions,
    start(input) {
      order.push(input.definition.id);
      return { outcome: "started" };
    },
    preemptOldestAutomatic: () => ({ ok: false }),
    activeRun: () => undefined,
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("read", {});
  scheduler.observeToolStart("write", { file_path: "x" });
  scheduler.observeToolEnd("write", false, { file_path: "x" });
  scheduler.observeToolEnd("bash", true, { command: "npm test" });
  scheduler.handleTurnEnd({});
  assert.deepEqual(order, ["c-fail", "b-mut", "a-tool"], "turn dispatch follows trigger priority: failure > mutation > tool turn");
  scheduler.handleAgentEnd({ interrupted: false, checkpoint: {} });
  assert.deepEqual(order, ["c-fail", "b-mut", "a-tool", "d-comp"], "completion dispatches at agent end");
}

// ── AC5: limits enforced and visible ─────────────────────────────

{
  // Automatic starts per task budget: exceeded activations drop visibly.
  const { state, scheduler } = makeHarness({
    definitions: [definition({ id: "ground", triggers: ["tool_turn"] })],
    config: {
      enabled: true,
      defaults: {
        maxConcurrentRuns: 2,
        maxAutomaticStartsPerTask: 2,
        runTimeoutSeconds: 120,
        maxModelTurnsPerRun: 8,
        maxToolCallsPerRun: 16,
        completionGateWindowSeconds: 10,
        headlessDrainSeconds: 30,
        maxQueuedShadowIds: 32,
      },
    },
  });
  // One task, three turns: the budget counts automatic starts per task.
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  for (let turn = 0; turn < 3; turn += 1) {
    scheduler.observeToolStart("read", {});
    state.clock += 10;
    scheduler.handleTurnEnd({});
  }
  assert.equal(state.starts.length, 2, "the exhausted budget blocks the third start within one task");
  const snapshot = scheduler.snapshot();
  assert.ok(snapshot.diagnostics.some((text) => text.includes("ground") && text.includes("budget")));
  assert.equal(snapshot.automaticStartsByTask[0].starts, 2, "the count is visible");
}

{
  // A new task epoch opens a fresh automatic-start budget.
  const { state, scheduler } = makeHarness({
    definitions: [definition({ id: "ground", triggers: ["tool_turn"] })],
    config: {
      enabled: true,
      defaults: {
        maxConcurrentRuns: 2,
        maxAutomaticStartsPerTask: 1,
        runTimeoutSeconds: 120,
        maxModelTurnsPerRun: 8,
        maxToolCallsPerRun: 16,
        completionGateWindowSeconds: 10,
        headlessDrainSeconds: 30,
        maxQueuedShadowIds: 32,
      },
    },
  });
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("read", {});
  scheduler.handleTurnEnd({});
  scheduler.observeToolStart("read", {});
  state.clock += 10;
  scheduler.handleTurnEnd({});
  assert.equal(state.starts.length, 1, "the first task's budget of one is exhausted");
  state.clock += 10;
  runRealUserTurn({ state, scheduler }, [{ tool: "read", args: {} }]);
  assert.equal(state.starts.length, 2, "the new task opens a fresh budget");
  assert.ok(scheduler.snapshot().diagnostics.some((text) => text.includes("budget")));
}

{
  // Queued-ID clipping retains the highest-ranked items and records clips.
  const definitions = [];
  for (let index = 0; index < 5; index += 1) {
    definitions.push(definition({ id: `tool-${index}`, triggers: ["tool_turn"], priority: index }));
  }
  definitions.push(definition({ id: "z-comp", triggers: ["completion"] }));
  const { state, scheduler } = makeHarness({
    definitions,
    config: {
      enabled: true,
      defaults: {
        maxConcurrentRuns: 2,
        maxAutomaticStartsPerTask: 64,
        runTimeoutSeconds: 120,
        maxModelTurnsPerRun: 8,
        maxToolCallsPerRun: 16,
        completionGateWindowSeconds: 10,
        headlessDrainSeconds: 30,
        maxQueuedShadowIds: 3,
      },
    },
  });
  // Force every start busy so activations stay queued.
  const busyDefs = new Set(definitions.map((entry) => entry.id));
  const originalStart = [];
  const clipScheduler = createShadowScheduler({
    now: () => state.clock,
    config: () => state.config,
    definitions: () => state.definitions,
    start(input) {
      originalStart.push(input.definition.id);
      return busyDefs.has(input.definition.id) ? { outcome: "busy" } : { outcome: "started" };
    },
    preemptOldestAutomatic: () => ({ ok: false }),
    activeRun: () => undefined,
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  clipScheduler.handleInput("interactive");
  clipScheduler.handleRunStart(true);
  clipScheduler.observeToolStart("read", {});
  clipScheduler.handleTurnEnd({});
  const snapshot = clipScheduler.snapshot();
  assert.equal(snapshot.pending.length, 3, "the queue is clipped to the configured bound");
  assert.ok(snapshot.pending.every((entry) => entry.shadowPriority >= 2), "the highest-ranked items survive");
  assert.equal(snapshot.clippedIds.length, 2, "every clipped ID is recorded");
}

{
  // Live config/definition drift is applied before dispatch: removed
  // subscriptions drop pending work and a reduced queue limit clips by the
  // newly effective rank rather than the enqueue-time snapshot.
  const definitions = [
    definition({ id: "a", triggers: ["tool_turn"], priority: 1 }),
    definition({ id: "b", triggers: ["tool_turn"], priority: 2 }),
  ];
  const harness = makeHarness({ definitions });
  let busy = true;
  const scheduler = createShadowScheduler({
    now: () => harness.state.clock,
    config: () => harness.state.config,
    definitions: () => harness.state.definitions,
    activeRun: () => undefined,
    start: () => busy ? { outcome: "busy" } : { outcome: "started" },
    preemptOldestAutomatic: () => ({ ok: false }),
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  runRealUserTurn({ state: harness.state, scheduler }, [{ tool: "read", args: {} }]);
  assert.equal(scheduler.snapshot().pending.length, 2);
  definitions[0].triggers = [];
  harness.state.config.defaults.maxQueuedShadowIds = 1;
  busy = false;
  scheduler.handleRunSettled();
  assert.equal(scheduler.snapshot().pending.length, 0);
  assert.ok(scheduler.snapshot().diagnostics.some((line) => line.includes("a") && line.includes("subscribes")));
}

// ── AC6: new-task preemption; superseded handled by the runtime ──

{
  // Next task: slots full (busy), preemption frees the oldest older-epoch
  // automatic run and retries once.
  const preempting = makeHarness({ definitions: [definition({ triggers: ["tool_turn"] })] });
  let first = true;
  const preemptingScheduler = createShadowScheduler({
    now: () => preempting.state.clock,
    config: () => preempting.state.config,
    definitions: () => preempting.state.definitions,
    activeRun: () => undefined,
    start(input) {
      preempting.state.starts.push(input);
      if (first) {
        first = false;
        return { outcome: "started", runId: "run-old" };
      }
      return { outcome: "busy" };
    },
    preemptOldestAutomatic(currentEpoch) {
      preempting.state.preemptions.push(currentEpoch);
      return { ok: true, runId: "run-old" };
    },
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  preemptingScheduler.handleInput("interactive");
  preemptingScheduler.handleRunStart(true);
  preemptingScheduler.observeToolStart("read", {});
  preemptingScheduler.handleTurnEnd({});
  assert.equal(preempting.state.starts.length, 1, "first task started");
  preempting.state.clock += 50;
  runRealUserTurn({ state: preempting.state, scheduler: preemptingScheduler }, [{ tool: "read", args: {} }]);
  assert.deepEqual(preempting.state.preemptions, [3], "the busy new-task activation preempted an older automatic run");
  assert.equal(preempting.state.starts.length, 3, "start attempts: task 1, busy attempt, one preemption retry");
  const snapshot = preemptingScheduler.snapshot();
  assert.equal(snapshot.pending.length, 1, "the new activation was retried and stayed queued on repeated busy");
}

{
  // Same-epoch busy never preempts.
  const harness = makeHarness({ definitions: [definition({ triggers: ["tool_turn"] })] });
  const scheduler = createShadowScheduler({
    now: () => harness.state.clock,
    config: () => harness.state.config,
    definitions: () => harness.state.definitions,
    activeRun: () => undefined,
    start: () => ({ outcome: "busy" }),
    preemptOldestAutomatic(currentEpoch) {
      harness.state.preemptions.push(currentEpoch);
      // Same-epoch contention: no older-task automatic run exists to preempt.
      return { ok: false };
    },
    activeRun: () => undefined,
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  runRealUserTurn({ state: harness.state, scheduler }, [{ tool: "read", args: {} }]);
  // The scheduler may ask for a same-task preemption, but with no older-task
  // automatic run to supersede the runtime refuses and the activation waits.
  assert.equal(scheduler.snapshot().pending.length, 1, "the activation stays queued for a free slot");
}

// ── AC7: interruption cancels; old-task results forced to notify ──

{
  const { state, scheduler } = makeHarness({
    definitions: [definition({ triggers: ["tool_turn", "completion"] })],
    forcedNotifyCount: 2,
  });
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("read", {});
  scheduler.handleTurnEnd({});
  assert.equal(state.starts.length, 1);

  // User interruption (aborted agent_end) cancels current-task runs and
  // clears current-task pending activations.
  state.clock += 10;
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("read", {});
  scheduler.handleTurnEnd({});
  scheduler.handleAgentEnd({ interrupted: true, checkpoint: {} });
  assert.deepEqual(state.cancelledTaskRuns, [3], "current-task runs were cancelled");
  assert.equal(scheduler.snapshot().pending.length, 0, "pending current-task activations were cleared");
  assert.ok(scheduler.snapshot().diagnostics.length > 0);

  // Each real-user task open forces old results to notify.
  assert.deepEqual(state.forcedNotifyBefore, [2, 3]);
}

// ── AC8: pause semantics ──────────────────────────────────────────

{
  const { state, scheduler } = makeHarness({
    definitions: [definition({ triggers: ["tool_turn"] })],
    cancelledAutomaticCount: 1,
  });
  runRealUserTurn({ state, scheduler }, [{ tool: "read", args: {} }]);
  assert.equal(state.starts.length, 1);

  scheduler.pause();
  assert.equal(state.cancelledAutomatic, 1, "pause aborts automatic runs");
  assert.equal(scheduler.snapshot().paused, true);

  // Paused: new tool activity creates no opportunities and is not replayed.
  state.clock += 10;
  runRealUserTurn({ state, scheduler }, [{ tool: "write", args: { file_path: "z.ts" } }]);
  assert.equal(state.starts.length, 1, "paused sessions start nothing");
  scheduler.resume();
  assert.equal(scheduler.snapshot().paused, false);
  // The paused turn's events are gone: nothing dispatches on resume.
  scheduler.handleRunSettled();
  assert.equal(state.starts.length, 1, "paused events are not replayed on resume");

  // Manual trials remain available: pause never blocks direct runtime starts
  // (the runtime's startManualRun has no pause gate — asserted at runtime).
}

{
  // Master switch off: no activation is ever created.
  const { state, scheduler } = makeHarness({
    definitions: [definition({ triggers: ["tool_turn"] })],
    config: {
      enabled: false,
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
  });
  runRealUserTurn({ state, scheduler }, [{ tool: "write", args: { file_path: "a.ts" } }]);
  assert.equal(state.starts.length, 0);
}

{
  // Reset clears all session-scoped scheduling state.
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["tool_turn"] })] });
  runRealUserTurn({ state, scheduler }, [{ tool: "read", args: {} }]);
  scheduler.reset();
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.taskEpoch, 1);
  assert.equal(snapshot.pending.length, 0);
  assert.equal(snapshot.toolGeneration, 0);
}

// ── Spec review regressions ────────────────────────────────────────

{
  // An aborted turn drops its observations: no failure dispatch, no leak
  // into the next task.
  const { state, scheduler } = makeHarness({ definitions: [definition({ triggers: ["failure"] })] });
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("bash", { command: "npm test" });
  scheduler.observeToolEnd("bash", true, { command: "npm test" });
  scheduler.handleTurnAbort();
  scheduler.handleAgentEnd({ interrupted: true, checkpoint: {} });
  assert.equal(state.starts.length, 0, "an aborted quality command never dispatches");

  // Even a later non-interrupted turn in a new task sees nothing stale.
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("read", {});
  scheduler.handleTurnEnd({});
  assert.equal(state.starts.length, 0, "aborted-turn reasons never leak into the next task");
}

{
  // One activation per Shadow: while a run is active, new activity stays
  // queued with the latest checkpoint and dispatches only after settle.
  const { state, scheduler } = makeHarness({
    definitions: [definition({ id: "ground", triggers: ["tool_turn"] })],
    activeShadows: ["ground"],
  });
  runRealUserTurn({ state, scheduler }, [{ tool: "read", args: {} }]);
  assert.equal(state.starts.length, 0, "no duplicate concurrent run starts");
  assert.equal(scheduler.snapshot().pending.length, 1, "the activation stays pending");

  state.activeShadows.clear();
  scheduler.handleRunSettled();
  assert.equal(state.starts.length, 1, "the latest checkpoint dispatches after the run settles");
}

{
  // A pending activation never combines a newer task's trajectory with an
  // older task's epoch/authority. The newer task atomically replaces it.
  const harness = makeHarness({
    definitions: [definition({ id: "ground", triggers: ["tool_turn"] })],
  });
  const scheduler = createShadowScheduler({
    now: () => harness.state.clock,
    config: () => harness.state.config,
    definitions: () => harness.state.definitions,
    start: () => ({ outcome: "busy" }),
    activeRun: () => undefined,
    preemptOldestAutomatic: () => ({ ok: false }),
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  runRealUserTurn({ state: harness.state, scheduler }, [{ tool: "read", args: {} }]);
  harness.state.clock += 10;
  runRealUserTurn({ state: harness.state, scheduler }, [{ tool: "grep", args: {} }]);
  const [activation] = scheduler.snapshot().pending;
  assert.equal(activation.taskEpoch, 3, "the pending activation belongs wholly to the newer task");
  assert.deepEqual(activation.checkpoint, { marker: harness.state.clock });
  assert.equal(activation.reasons[0].firstObservedAt, harness.state.clock, "old-task reasons are not merged across authority boundaries");
}

{
  // A newer-task activation for the same Shadow stays queued while the older
  // run is active; per-Shadow serialization is stronger than slot preemption.
  const harness = makeHarness({ definitions: [definition({ id: "ground", triggers: ["tool_turn"] })] });
  const scheduler = createShadowScheduler({
    now: () => harness.state.clock,
    config: () => harness.state.config,
    definitions: () => harness.state.definitions,
    activeRun: () => ({ source: "automatic", taskEpoch: 1 }),
    start(input) { harness.state.starts.push(input); return { outcome: "started" }; },
    preemptOldestAutomatic(epoch) { harness.state.preemptions.push(epoch); return { ok: true, runId: "run-old" }; },
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });
  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolStart("read", {});
  scheduler.handleTurnEnd({ task: 2 });
  assert.deepEqual(harness.state.preemptions, [], "the same-Shadow active guard does not invoke slot preemption");
  assert.equal(harness.state.starts.length, 0);
  assert.equal(scheduler.snapshot().pending.length, 1);
}

{
  // Per-task budget accounting is session-bounded rather than growing once
  // for every user task in a long-lived parent session.
  const { state, scheduler } = makeHarness({ definitions: [definition({ id: "ground", triggers: ["tool_turn"] })] });
  for (let task = 0; task < 10; task += 1) {
    runRealUserTurn({ state, scheduler }, [{ tool: "read", args: {} }]);
    state.clock += 1;
  }
  const retained = scheduler.snapshot().automaticStartsByTask;
  assert.equal(retained.length, 4, "only the bounded task-epoch window is retained");
  assert.deepEqual(retained.map((entry) => entry.epoch), [11, 10, 9, 8]);
}

console.log("shadow-minds scheduler tests: OK");
