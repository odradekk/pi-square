import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const { createCompletionGate, GATE_WINDOW_HARD_MAX_SECONDS } = await load(join(packageRoot, "src", "shadow-minds", "gate.ts"));

function definition(overrides = {}) {
  return {
    id: "completion-check",
    name: "Completion check",
    enabled: true,
    hidden: false,
    priority: 0,
    triggers: ["completion"],
    triggerInstructions: {},
    delivery: "wake",
    completionGate: true,
    requiredTools: [],
    debug: false,
    ...overrides,
  };
}

function config(overrides = {}) {
  return { enabled: true, defaults: { completionGateWindowSeconds: 10, ...overrides } };
}

function makeHarness(options = {}) {
  const state = {
    now: 1_000,
    cancelledCompletions: 0,
    settled: [],
    opened: [],
    closed: [],
    timer: undefined,
  };
  const pendingCompletions = options.pendingCompletions ?? ["completion-check"];
  const gate = createCompletionGate({
    now: () => state.now,
    config: () => config(options.configDefaults),
    definitions: () => options.definitions ?? [definition()],
    scheduler: {
      pendingCompletions: () => pendingCompletions.slice(0),
      cancelPendingCompletions: () => {
        state.cancelledCompletions += pendingCompletions.length;
        pendingCompletions.length = 0;
        return state.cancelledCompletions;
      },
    },
    hasRunningCompletionRuns: (gateIds) => (options.runningCompletions ?? false) && gateIds.size > 0,
    forwardSettle: (at) => state.settled.push(at),
    onOpen: (windowSeconds) => state.opened.push(windowSeconds),
    onClose: (reason, cancelled) => state.closed.push({ reason, cancelled }),
    scheduleDeadline: (ms, fire) => {
      state.timer = { ms, fire };
      return () => {
        state.timer = undefined;
      };
    },
  });
  return { gate, state, pendingCompletions };
}

const RUN_ENDED = { kind: "parent-run-end", interrupted: false };

{
  // The gate opens only at a natural parent run end, and only when a
  // gate-subscribed definition has a pending completion activation; a non-gate
  // completion stays on the #159 path.
  const nonGate = makeHarness({ definitions: [definition({ completionGate: false })] });
  nonGate.gate.handleRunTransition(RUN_ENDED);
  assert.equal(nonGate.gate.open, false, "a non-gate completion never opens the gate");

  const disabled = makeHarness({ definitions: [definition({ enabled: false })] });
  disabled.gate.handleRunTransition(RUN_ENDED);
  assert.equal(disabled.gate.open, false, "a disabled definition never opens the gate");

  const noSubscription = makeHarness({ definitions: [definition({ triggers: ["tool_turn"] })] });
  noSubscription.gate.handleRunTransition(RUN_ENDED);
  assert.equal(noSubscription.gate.open, false, "the gate requires the completion trigger");

  // An already-started completion run of a gate definition opens the gate
  // even with nothing pending (the instant-dispatch case).
  const startedOnly = makeHarness({ pendingCompletions: [], runningCompletions: true });
  startedOnly.gate.handleRunTransition(RUN_ENDED);
  assert.equal(startedOnly.gate.open, true, "a started gate completion run opens the gate");

  const foreignPending = makeHarness({ pendingCompletions: ["other-shadow"] });
  foreignPending.gate.handleRunTransition(RUN_ENDED);
  assert.equal(foreignPending.gate.open, false, "a pending completion of a non-gate Shadow never opens the gate");

  const plain = makeHarness({});
  plain.gate.handleRunTransition(RUN_ENDED);
  assert.equal(plain.gate.open, true, "a pending gate completion opens the gate at the run end");
  assert.deepEqual(plain.state.opened, [10], "the configured window is announced");
  assert.ok(plain.state.timer, "the deadline timer is scheduled");
  assert.equal(plain.state.timer.ms, 10_000);
}

{
  // The window is clamped to the package hard cap.
  const clamped = makeHarness({ configDefaults: { completionGateWindowSeconds: 120 } });
  clamped.gate.handleRunTransition(RUN_ENDED);
  assert.equal(clamped.gate.open, true);
  assert.ok(clamped.state.timer, "the deadline timer is scheduled");
  assert.equal(
    clamped.state.timer.ms,
    GATE_WINDOW_HARD_MAX_SECONDS * 1_000,
    "a configured window above the cap clamps to the hard cap",
  );
  assert.equal(GATE_WINDOW_HARD_MAX_SECONDS, 60, "the hard cap is sixty seconds");
}

{
  // Early close: once every completion run settled and nothing is pending,
  // run activity closes the gate before the deadline and forwards the settle.
  const { gate, state, pendingCompletions } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  pendingCompletions.length = 0;
  gate.handleRunTransition({ kind: "shadow-activity" });
  assert.equal(gate.open, false, "the gate closes when the completion work is done");
  assert.deepEqual(state.closed, [{ reason: "completed", cancelled: 0 }]);
  assert.deepEqual(state.settled, [], "no settle forwards when none was parked");
  assert.equal(state.timer, undefined, "the deadline timer is cleared");
  assert.equal(state.cancelledCompletions, 0, "an early close cancels nothing");
}

{
  // A settle parked before the drain forwards at the early close.
  const { gate, state, pendingCompletions } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  gate.holdSettle();
  pendingCompletions.length = 0;
  gate.handleRunTransition({ kind: "shadow-activity" });
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "completed", cancelled: 0 }]);
  assert.deepEqual(state.settled, [1_000], "the early close forwards the parked settle");
}

{
  // Activity keeps the gate open until completions drain.
  const { gate } = makeHarness({ runningCompletions: true });
  gate.handleRunTransition(RUN_ENDED);
  gate.handleRunTransition({ kind: "shadow-activity" });
  assert.equal(gate.open, true, "a running completion run holds the gate open");
}

{
  // Automatic continuation: the parent settles while the gate is open, the
  // settle parks, and the forwarding close releases it exactly once.
  const { gate, state } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  assert.equal(gate.holdSettle(), true, "an open gate parks the subsystem settle");
  state.now = 11_000;
  state.timer.fire();
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "deadline", cancelled: 1 }], "the pending completion cancelled at the deadline");
  assert.deepEqual(state.settled, [11_000], "the parked settle forwards at the deadline");
  assert.equal(gate.holdSettle(), false, "a closed gate never parks the settle");
}

{
  // Deadline without a parked settle still cancels and closes, but has no
  // settle to forward: the caller already ran its own settle handling.
  const { gate, state, pendingCompletions } = makeHarness({ runningCompletions: true });
  gate.handleRunTransition(RUN_ENDED);
  pendingCompletions.length = 0;
  state.now = 11_000;
  state.timer.fire();
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "deadline", cancelled: 0 }]);
  assert.deepEqual(state.settled, [], "no settle forwards when none was parked");
}

{
  // Deadline: unstarted completion pending items cancel, started runs are
  // left alone, and the parked settle forwards.
  const { gate, state, pendingCompletions } = makeHarness({ runningCompletions: true });
  gate.handleRunTransition(RUN_ENDED);
  gate.holdSettle();
  state.now = 11_000;
  state.timer.fire();
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "deadline", cancelled: 1 }], "the pending completion cancelled at the deadline");
  assert.equal(pendingCompletions.length, 0);
  assert.deepEqual(state.settled, [11_000], "the deadline forwards the parked settle");
}

{
  // A new real-user task closes the gate without forwarding the settle:
  // old-task entries resolve through the normal stale downgrade instead.
  const { gate, state, pendingCompletions } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  gate.handleRunTransition({ kind: "parent-run-start", realUserTask: true });
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "new-task", cancelled: 1 }]);
  assert.deepEqual(state.settled, [], "a stale-context close never forwards the settle");
  assert.equal(pendingCompletions.length, 0);
}

{
  // An extension continuation is still a parent run start, but it never
  // closes the held window: only real-user tasks do.
  const { gate } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  gate.handleRunTransition({ kind: "parent-run-start", realUserTask: false });
  assert.equal(gate.open, true, "an extension continuation leaves the gate open");
}

{
  // A parked settle is dropped without a forward when a real-user task
  // closes the gate before the deadline.
  const { gate, state } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  gate.holdSettle();
  gate.handleRunTransition({ kind: "parent-run-start", realUserTask: true });
  assert.deepEqual(state.settled, [], "a new-task close drops the parked settle without forwarding");
}

{
  // Pause and abort cancel the pending completions without a settle forward;
  // both observations of an abort map to the same close.
  const pausing = makeHarness();
  pausing.gate.handleRunTransition(RUN_ENDED);
  pausing.gate.handleRunTransition({ kind: "scheduler-paused" });
  assert.equal(pausing.gate.open, false);
  assert.deepEqual(pausing.state.closed, [{ reason: "paused", cancelled: 1 }], "pause cancels the unstarted completions");
  assert.deepEqual(pausing.state.settled, [], "pause never forwards the settle");

  for (const abort of [{ kind: "parent-run-interrupted" }, { kind: "parent-run-end", interrupted: true }]) {
    const harness = makeHarness();
    harness.gate.handleRunTransition(RUN_ENDED);
    harness.gate.handleRunTransition(abort);
    assert.equal(harness.gate.open, false);
    assert.deepEqual(harness.state.closed, [{ reason: "aborted", cancelled: 1 }], `${abort.kind} cancels the unstarted completions`);
    assert.deepEqual(harness.state.settled, [], `${abort.kind} never forwards the settle`);
  }

  // Pi emits turn_end before agent_end on abort; the second observation is inert.
  const doubleAbort = makeHarness();
  doubleAbort.gate.handleRunTransition(RUN_ENDED);
  doubleAbort.gate.handleRunTransition({ kind: "parent-run-interrupted" });
  doubleAbort.gate.handleRunTransition({ kind: "parent-run-end", interrupted: true });
  assert.deepEqual(doubleAbort.state.closed.length, 1, "a second abort observation is refused");
}

{
  // Session replacement resets without side effects.
  const { gate, state } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  gate.reset();
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [], "a reset is silent");
  assert.deepEqual(state.settled, []);
  assert.equal(state.timer, undefined);
}

{
  // A closed gate is inert: further transitions produce no gate actions.
  const { gate, state, pendingCompletions } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  state.now = 11_000;
  state.timer.fire();
  state.closed.length = 0;
  state.settled.length = 0;
  pendingCompletions.push("completion-check");
  gate.handleRunTransition({ kind: "shadow-activity" });
  gate.handleRunTransition({ kind: "parent-run-start", realUserTask: true });
  gate.handleRunTransition({ kind: "scheduler-paused" });
  gate.handleRunTransition({ kind: "session-ending" });
  assert.deepEqual(state.closed, [], "a closed gate closes nothing again");
  assert.deepEqual(state.settled, [], "a closed gate forwards nothing");
  gate.handleRunTransition(RUN_ENDED);
  assert.equal(gate.open, true, "a later natural run end reopens the gate");
}

{
  // Session ending closes the gate without a settle forward.
  const { gate, state } = makeHarness({});
  gate.handleRunTransition(RUN_ENDED);
  gate.handleRunTransition({ kind: "session-ending" });
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "session", cancelled: 1 }]);
  assert.deepEqual(state.settled, [], "a session close never forwards the settle");
}

{
  const { __testables } = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
  const runs = [
    { phase: "running", trigger: "completion", shadowId: "ordinary" },
    { phase: "submitted", trigger: "completion", shadowId: "gate" },
  ];
  assert.equal(
    __testables.hasRunningGateCompletion(runs, new Set(["gate"])),
    false,
    "a non-gate completion run cannot hold another definition's gate open",
  );
  runs[1] = { phase: "running", trigger: "completion", shadowId: "gate" };
  assert.equal(__testables.hasRunningGateCompletion(runs, new Set(["gate"])), true);

  assert.deepEqual(
    __testables.quietDeliveryIdsFromBranch({
      getBranch: () => [
        { type: "custom_message", customType: "other", details: { results: [{ id: "foreign" }] } },
        { type: "custom_message", customType: "pi-square.shadow-notification", details: { results: [{ id: "shr-1" }, { id: "shr-2" }] } },
      ],
    }),
    ["shr-1", "shr-2"],
    "quiet confirmation reads only actual Shadow notification entries from the session branch",
  );
  assert.deepEqual(__testables.quietDeliveryIdsFromBranch(undefined), []);
}
console.log("shadow-minds gate tests: OK");
