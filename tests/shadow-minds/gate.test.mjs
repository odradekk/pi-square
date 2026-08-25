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

{
  // The gate opens only when a gate-subscribed definition has a pending
  // completion activation; a non-gate completion stays on the #159 path.
  const nonGate = makeHarness({ definitions: [definition({ completionGate: false })] });
  assert.equal(nonGate.gate.maybeOpen(), false, "a non-gate completion never opens the gate");
  assert.equal(nonGate.gate.open, false);

  const disabled = makeHarness({ definitions: [definition({ enabled: false })] });
  assert.equal(disabled.gate.maybeOpen(), false, "a disabled definition never opens the gate");

  const noSubscription = makeHarness({ definitions: [definition({ triggers: ["tool_turn"] })] });
  assert.equal(noSubscription.gate.maybeOpen(), false, "the gate requires the completion trigger");

  // An already-started completion run of a gate definition opens the gate
  // even with nothing pending (the instant-dispatch case).
  const startedOnly = makeHarness({ pendingCompletions: [], runningCompletions: true });
  assert.equal(startedOnly.gate.maybeOpen(), true, "a started gate completion run opens the gate");

  const foreignPending = makeHarness({ pendingCompletions: ["other-shadow"] });
  assert.equal(foreignPending.gate.maybeOpen(), false, "a pending completion of a non-gate Shadow never opens the gate");

  const plain = makeHarness({});
  assert.equal(plain.gate.maybeOpen(), true, "a pending gate completion opens the gate");
  assert.equal(plain.gate.open, true);
  assert.deepEqual(plain.state.opened, [10], "the configured window is announced");
  assert.ok(plain.state.timer, "the deadline timer is scheduled");
  assert.equal(plain.state.timer.ms, 10_000);
}

{
  // The window is clamped to the package hard cap.
  const clamped = makeHarness({ configDefaults: { completionGateWindowSeconds: 120 } });
  assert.equal(clamped.gate.maybeOpen(), true);
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
  // the gate closes before the deadline and forwards the settle.
  const { gate, state, pendingCompletions } = makeHarness({});
  gate.maybeOpen();
  pendingCompletions.length = 0;
  gate.notifyActivity();
  assert.equal(gate.open, false, "the gate closes when the completion work is done");
  assert.deepEqual(state.closed, [{ reason: "completed", cancelled: 0 }]);
  assert.deepEqual(state.settled, [1_000], "the early close forwards the settle");
  assert.equal(state.timer, undefined, "the deadline timer is cleared");
  assert.equal(state.cancelledCompletions, 0, "an early close cancels nothing");
}

{
  // Activity keeps the gate open until completions drain.
  const { gate } = makeHarness({ runningCompletions: true });
  gate.maybeOpen();
  gate.notifyActivity();
  assert.equal(gate.open, true, "a running completion run holds the gate open");
}

{
  // Deadline: unstarted completion pending items cancel, started runs are
  // left alone, and the settle forwards.
  const { gate, state, pendingCompletions } = makeHarness({ runningCompletions: true });
  gate.maybeOpen();
  state.now = 11_000;
  state.timer.fire();
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "deadline", cancelled: 1 }], "the pending completion cancelled at the deadline");
  assert.equal(pendingCompletions.length, 0);
  assert.deepEqual(state.settled, [11_000], "the deadline forwards the settle");
}

{
  // A new real-user task closes the gate without forwarding the settle:
  // old-task entries resolve through the normal stale downgrade instead.
  const { gate, state, pendingCompletions } = makeHarness({});
  gate.maybeOpen();
  gate.close("new-task");
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "new-task", cancelled: 1 }]);
  assert.deepEqual(state.settled, [], "a stale-context close never forwards the settle");
  assert.equal(pendingCompletions.length, 0);
}

{
  // Pause and abort cancel the pending completions without a settle forward.
  for (const reason of ["paused", "aborted"]) {
    const harness = makeHarness();
    harness.gate.maybeOpen();
    harness.gate.close(reason);
    assert.equal(harness.gate.open, false);
    assert.deepEqual(harness.state.closed, [{ reason, cancelled: 1 }], `${reason} cancels the unstarted completions`);
    assert.deepEqual(harness.state.settled, [], `${reason} never forwards the settle`);
  }
}

{
  // Session replacement resets without side effects.
  const { gate, state } = makeHarness({});
  gate.maybeOpen();
  gate.reset();
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [], "a reset is silent");
  assert.deepEqual(state.settled, []);
  assert.equal(state.timer, undefined);
}

{
  // A closed gate is inert: repeated closes and opens are idempotent.
  const { gate, state } = makeHarness({});
  gate.maybeOpen();
  gate.close("deadline");
  gate.close("deadline");
  assert.deepEqual(state.closed.length, 1, "a second close is refused");
  gate.notifyActivity();
  assert.deepEqual(state.settled.length, 1);
}

{
  // A drain close behaves like the deadline: cancel, settle forward.
  const { gate, state } = makeHarness({});
  gate.maybeOpen();
  gate.close("drained");
  assert.equal(gate.open, false);
  assert.deepEqual(state.closed, [{ reason: "drained", cancelled: 1 }]);
  assert.deepEqual(state.settled, [1_000], "the drain forwards the settle for a final delivery attempt");
}

console.log("shadow-minds gate tests: OK");
