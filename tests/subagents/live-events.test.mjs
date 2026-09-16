import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

// Focused unit coverage for the transcript module's live-events
// implementation file (#371): native-event derivation and the bounded feed
// mechanics ADR-0016 records. The wiring that publishes through this file —
// the background lifecycle, the child execution seam, and the registry's
// forwarding — is covered at their own seams (background, session-view-events,
// live-view, and roster suites).
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const liveEventsModule = await load(join(packageRoot, "src", "subagents", "live-events.ts"));
const {
  LIVE_FLUSH_BUDGET_MS,
  LIVE_LISTENER_BUDGET_MS,
  LIVE_REPAINT_COALESCE_MS,
  MAX_PENDING_EVENTS,
  createChildViewFeed,
  deriveChildViewEvent,
  isStructuralViewEvent,
} = liveEventsModule;
const childHistoryModule = await load(join(packageRoot, "src", "subagents", "child-history.ts"));
const {
  assistantContentKey,
  boundedAssistantTextParts,
  callKeyOf,
  MAX_ASSISTANT_PARTS,
  projectSessionEntries,
} = childHistoryModule;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const ID = "subagent_00000000-0000-4000-8000-000000000301";

function messageEntry(id, message, timestamp = "2025-01-01T00:00:00Z") {
  return { type: "message", id, parentId: null, timestamp, message };
}

const busyWait = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* deliberate slow viewer work */ }
};

/** A feed with a manually driven scheduler; structural prefixes may drain together. */
function manualFeed(scheduleOverride, now) {
  const steps = [];
  const feed = createChildViewFeed({
    schedule: scheduleOverride ?? ((callback) => steps.push(callback)),
    ...(now !== undefined ? { now } : {}),
  });
  return {
    feed,
    deliver: () => {
      const callback = steps.shift();
      if (callback !== undefined) callback();
    },
    deliverAll: () => {
      while (steps.length > 0) {
        const callback = steps.shift();
        if (callback !== undefined) callback();
      }
    },
    pending: () => steps.length,
  };
}

// ---------------------------------------------------------------------------
// Event derivation

test("derivation maps one native run into the ordered view-event sequence", () => {
  const sequence = [
    { type: "agent_start" },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Wor" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "needle", path: "." } }] } },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "grep", args: { pattern: "needle", path: "." } },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "grep", partialResult: { content: [] } },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "SECRET RESULT" }] } },
    { type: "message_end", message: { role: "toolResult", toolCallId: "call-1", content: [] } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } },
    { type: "agent_end" },
    { type: "auto_retry_start", attempt: 1 },
  ].map(deriveChildViewEvent);

  assert.deepEqual(sequence.map((event) => event && event.kind), [
    "run_started",
    "message_delta",
    "message_completed",
    "tool_started",
    "tool_updated",
    "tool_finished",
    "tool_result_completed",
    "message_delta",
    "message_completed",
    "run_finished",
    undefined,
  ]);
});

test("a completion carries the native message timestamp as publish-time identity", () => {
  const event = deriveChildViewEvent({
    type: "message_end",
    message: { role: "assistant", timestamp: 1_735_689_600_123, content: [{ type: "text", text: "Done" }] },
  });
  assert.equal(event.timestamp, 1_735_689_600_123);
  const without = deriveChildViewEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  });
  assert.equal(without.timestamp, undefined);
});

test("deltas keep native text/thinking interleaving order and stay sanitized and bounded", () => {
  const interleaved = deriveChildViewEvent({
    type: "message_update",
    message: { role: "assistant", content: [
      { type: "text", text: "first" },
      { type: "thinking", thinking: "plan the work" },
      { type: "text", text: "second" },
    ] },
  });
  assert.equal(interleaved.kind, "message_delta");
  assert.deepEqual(interleaved.parts, [
    { type: "text", text: "first" },
    { type: "thinking", thinking: "plan the work" },
    { type: "text", text: "second" },
  ]);

  const long = `api_key=SK-1234567890abcdef ${"x".repeat(20_000)} tail-marker`;
  const grown = deriveChildViewEvent({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: long }] },
  });
  const text = grown.parts.map((part) => part.type === "text" ? part.text : "").join("");
  assert.ok(text.length < long.length, "streaming text stays bounded through the shared clipper");
  assert.match(text, /tail-marker/);
  assert.ok(!text.includes("SK-1234567890abcdef"), "credentials never cross into a live event");

  assert.equal(deriveChildViewEvent({ type: "message_update", message: { role: "user", content: [] } }), undefined);
});

test("tool events use the roster-grade projection and never raw arguments or results", () => {
  const started = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: "call-9",
    toolName: "grep",
    args: { pattern: "SECRET-PATTERN", path: "/deep/path" },
  });
  assert.equal(started.kind, "tool_started");
  assert.equal(started.name, "grep");
  assert.equal(started.summary, "called");
  assert.equal(started.callKey, callKeyOf("call-9"));
  assert.ok(Number.isFinite(started.startedAt), "tool start carries a clock for the live duration");

  const unknown = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: "call-x",
    toolName: "totally_custom",
    args: { anything: "raw" },
  });
  assert.deepEqual(
    { ...unknown, startedAt: 0 },
    { kind: "tool_started", callKey: callKeyOf("call-x"), name: "tool", summary: "called", startedAt: 0 },
  );

  const updated = deriveChildViewEvent({
    type: "tool_execution_update",
    toolCallId: "call-9",
    toolName: "grep",
    partialResult: { content: [{ type: "text", text: "partial SECRET" }] },
  });
  assert.deepEqual(updated, { kind: "tool_updated", callKey: callKeyOf("call-9"), name: "grep" });

  const finished = deriveChildViewEvent({
    type: "tool_execution_end",
    toolCallId: "call-9",
    toolName: "grep",
    isError: true,
    result: { content: [{ type: "text", text: "SECRET FAILURE BODY" }] },
  });
  assert.deepEqual(finished, { kind: "tool_finished", callKey: callKeyOf("call-9"), name: "grep", summary: "called", isError: true });
});

test("live and persisted tools share one exact non-reversible call identity", () => {
  const nativeCallId = `${"a".repeat(100)}${"b".repeat(100)}`;
  const started = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: nativeCallId,
    toolName: "grep",
    args: { pattern: "x" },
  });
  const persisted = projectSessionEntries([
    messageEntry("e1", {
      role: "assistant",
      content: [{ type: "toolCall", id: nativeCallId, name: "grep", arguments: { pattern: "x" } }],
    }),
  ]).items.find((item) => item.kind === "toolCall");
  assert.equal(started.callKey, persisted.callKey,
    "long native IDs are hashed identically instead of passing through incompatible truncation");
  assert.ok(!JSON.stringify(started).includes(nativeCallId), "the raw native ID never enters the event");
});

test("both projections share one bounded projection, beyond any live-only cap", () => {
  // Regression (review round 2): the live and persisted projections must be
  // the same bounded function, so part counts at or beyond the shared bound
  // still reconcile exactly.
  const build = (count) => {
    const content = [];
    for (let index = 0; index < count; index += 1) {
      content.push(index % 2 === 0 ? { type: "text", text: `part ${index}` } : { type: "thinking", thinking: `t ${index}` });
    }
    return content;
  };

  const within = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content: build(200) } });
  assert.equal(within.content.length, 200);
  const persistedWithin = projectSessionEntries([
    messageEntry("e1", { role: "assistant", content: build(200) }),
  ]).items.find((item) => item.kind === "assistant");
  assert.equal(JSON.stringify(within.content), JSON.stringify(persistedWithin.message.content));

  const over = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content: build(MAX_ASSISTANT_PARTS + 100) } });
  assert.equal(over.content.length, MAX_ASSISTANT_PARTS, "the shared part bound applies to both sides identically");
  const persistedOver = projectSessionEntries([
    messageEntry("e2", { role: "assistant", content: build(MAX_ASSISTANT_PARTS + 100) }),
  ]).items.find((item) => item.kind === "assistant");
  assert.equal(JSON.stringify(over.content), JSON.stringify(persistedOver.message.content));
});

test("derivation ignores malformed events without throwing", () => {
  assert.equal(deriveChildViewEvent(undefined), undefined);
  assert.equal(deriveChildViewEvent(null), undefined);
  assert.equal(deriveChildViewEvent("agent_start"), undefined);
  assert.equal(deriveChildViewEvent({}), undefined);
  assert.equal(deriveChildViewEvent({ type: "message_end", message: 5 }), undefined);
  assert.deepEqual(
    deriveChildViewEvent({ type: "tool_execution_start", toolName: null, args: null }),
    { kind: "live_events_dropped", droppedUnknown: true },
    "a tool event without its native call identity becomes a visible fail-closed omission",
  );
});

test("structural classification separates completion from streaming deltas", () => {
  for (const kind of ["message_delta", "tool_updated"]) {
    assert.equal(isStructuralViewEvent({ kind, parts: [], callKey: "", name: "" }), false, kind);
  }
  for (const kind of ["run_started", "message_completed", "tool_started", "tool_finished", "tool_result_completed", "run_finished", "live_events_dropped"]) {
    assert.equal(isStructuralViewEvent({ kind }), true, kind);
  }
  assert.ok(LIVE_FLUSH_BUDGET_MS > 0 && LIVE_REPAINT_COALESCE_MS > 0, "the published budgets stay positive");
});

// ---------------------------------------------------------------------------
// Publication decoupling: the child never runs subscriber work

test("a slow live subscriber never runs inside the child's native event dispatch", async () => {
  const feed = createChildViewFeed();
  const observed = { dispatching: false, runDone: false, invocations: 0, illegal: 0 };
  feed.subscribe(ID, () => {
    if (observed.dispatching || !observed.runDone) observed.illegal += 1;
    observed.invocations += 1;
    busyWait(10);
  });

  // A child run publishes its events synchronously inside its own dispatch.
  observed.dispatching = true;
  feed.publish(ID, { kind: "run_started" });
  for (let index = 0; index < 5; index += 1) {
    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: `chunk ${index}` }] });
  }
  feed.publish(ID, { kind: "message_completed", content: [] });
  feed.publish(ID, { kind: "run_finished" });
  observed.dispatching = false;
  observed.runDone = true;

  for (let tick = 0; tick < 10 && observed.invocations < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(observed.illegal, 0, "no subscriber work ran during dispatch or before the run resolved");
  assert.ok(observed.invocations >= 4, "the decoupled flush still delivers every coalesced event");
});

test("scheduled viewer work cannot materially delay the child's next continuation", async () => {
  // A scheduled callback still shares Node's event-loop thread. Give the
  // child one continuation turn before viewer delivery and enforce a real
  // watchdog when the callback eventually runs.
  const feed = createChildViewFeed();
  let invoked = 0;
  feed.subscribe(ID, () => {
    invoked += 1;
    busyWait(300);
  });
  feed.publish(ID, { kind: "run_started" });
  const startedAt = Date.now();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Date.now() - startedAt < 100, "the child continuation runs before viewer work");
  for (let turn = 0; turn < 4 && invoked === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(invoked, 1, "the isolated delivery still attempts the subscriber once");
  feed.clear();
});

test("a child that yields between events is never blocked behind a batch of deliveries", async () => {
  // Regression (review round 2): each scheduler tick delivers exactly one
  // event, so a child continuation that yields between its events never waits
  // behind more than one delivered event's subscriber work.
  const feed = createChildViewFeed();
  const trace = [];
  feed.subscribe(ID, () => {
    trace.push("delivery");
    busyWait(5);
  });

  // The child yields between event batches exactly like a real run does.
  for (let step = 0; step < 3; step += 1) {
    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: `s${step}a` }] });
    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: `s${step}b` }] });
    trace.push(`child-step-${step}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  feed.publish(ID, { kind: "message_completed", content: [{ type: "text", text: "Done" }] });
  feed.publish(ID, { kind: "run_finished" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Between two child continuations, at most one delivery may run; the
  // child's final emits have no following continuation to delay.
  const lastStep = trace.map((entry) => entry.startsWith("child")).lastIndexOf(true);
  let longestRun = 0;
  let run = 0;
  for (const entry of trace.slice(0, lastStep + 1)) {
    if (entry === "delivery") run += 1;
    else {
      longestRun = Math.max(longestRun, run);
      run = 0;
    }
  }
  assert.ok(longestRun <= 1, `one delivery per child yield, saw a run of ${longestRun}: ${trace.join(",")}`);
  assert.ok(trace.includes("child-step-2"), "the child run progressed through every yield");
});

// ---------------------------------------------------------------------------
// Feed

test("the feed is ephemeral: no subscribers means no work and no buffering", () => {
  const { feed, deliverAll, pending } = manualFeed();
  feed.publish("child-1", { kind: "run_started" });
  assert.equal(pending(), 0, "an unobserved child creates no scheduled work or retained event");
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(seen, ["run_finished"]);
});

test("delivery is ordered, isolated, asynchronous, and structural-boundary aware", () => {
  const { feed, deliver } = manualFeed();
  const healthy = [];
  let syncPublish = true;
  feed.subscribe("child-1", () => { throw new Error("broken subscriber"); });
  feed.subscribe("child-1", (event) => {
    healthy.push(event.kind);
    assert.ok(!syncPublish, "subscribers never run inside publish");
  });
  feed.publish("child-1", { kind: "run_started" });
  assert.deepEqual(healthy, [], "nothing is delivered synchronously");
  syncPublish = false;
  feed.publish("child-1", { kind: "message_completed", content: [] });
  deliver();
  assert.deepEqual(healthy, ["run_started", "message_completed"],
    "one scheduled tick drains through the newest queued structural boundary");
  deliver();
  assert.deepEqual(healthy, ["run_started", "message_completed"]);
  deliver();
  assert.deepEqual(healthy, ["run_started", "message_completed"], "an empty queue schedules nothing");
});

test("a delta never reorders across a structural boundary of its child", () => {
  // Regression (review round 2): the minimal FIFO race — delta A, completion
  // A, delta B must deliver in exactly that order; the old backward scan
  // replaced delta A in place with B's payload ahead of the completion.
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event));
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "A" }] });
  feed.publish("child-1", { kind: "message_completed", content: [{ type: "text", text: "A done" }], timestamp: 1 });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "B" }] });
  deliverAll();
  assert.deepEqual(seen.map((event) => event.kind), ["message_delta", "message_completed", "message_delta"]);
  assert.deepEqual(seen[0].parts, [{ type: "text", text: "A" }], "delta A keeps its own payload and position");
  assert.deepEqual(seen[2].parts, [{ type: "text", text: "B" }], "delta B stays behind the completion boundary");
});

test("adjacent cumulative deltas still coalesce in place without disturbing order", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event));
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "a" }] });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "ab" }] });
  feed.publish("child-1", { kind: "tool_started", callKey: callKeyOf("c1"), name: "grep", summary: "called", startedAt: 1 });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "abc" }] });
  deliverAll();
  assert.deepEqual(seen.map((event) => event.kind), ["message_delta", "tool_started", "message_delta"]);
  assert.deepEqual(seen[0].parts, [{ type: "text", text: "ab" }], "adjacent deltas coalesce to the newest payload");
  assert.deepEqual(seen[2].parts, [{ type: "text", text: "abc" }], "the post-boundary delta keeps its own position");
});

test("a listener that overruns the time budget is evicted after one overrun", () => {
  // Regression (review round 2): the feed stays on this thread, so a listener
  // is time-budgeted; an overrunning listener is evicted after one delivery
  // instead of repeatedly preempting everything else.
  const feed = createChildViewFeed();
  const healthy = [];
  let slowInvocations = 0;
  feed.subscribe(ID, () => {
    slowInvocations += 1;
    busyWait(LIVE_LISTENER_BUDGET_MS + 60);
  });
  feed.subscribe(ID, (event) => healthy.push(event.kind));
  feed.publish(ID, { kind: "run_started" });
  feed.publish(ID, { kind: "tool_result_completed" });
  feed.publish(ID, { kind: "run_finished" });
  return new Promise((resolve, reject) => {
    const settle = setInterval(() => {
      if (healthy.length >= 3) {
        clearInterval(settle);
        try {
          assert.equal(slowInvocations, 1, "the overrunning listener delivered at most once");
          assert.deepEqual(healthy, ["run_started", "tool_result_completed", "run_finished"],
            "the healthy listener keeps receiving every event");
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    }, 10);
    setTimeout(() => {
      clearInterval(settle);
      reject(new Error(`eviction did not settle: slow=${slowInvocations} healthy=${healthy.length}`));
    }, 5_000).unref?.();
  });
});

test("the listener watchdog interrupts one blocking callback within a bounded turn", () => {
  const { feed, deliver } = manualFeed();
  let healthy = 0;
  feed.subscribe(ID, () => busyWait(LIVE_LISTENER_BUDGET_MS * 4));
  feed.subscribe(ID, () => { healthy += 1; });
  feed.publish(ID, { kind: "run_started" });
  const startedAt = Date.now();
  deliver();
  assert.ok(Date.now() - startedAt < LIVE_LISTENER_BUDGET_MS * 3,
    "the callback is interrupted rather than merely measured after returning");
  assert.equal(healthy, 0, "the exhausted total budget yields before the healthy sibling");
  deliver();
  assert.equal(healthy, 1, "a blocked sibling cannot prevent healthy delivery on the next tick");
});

test("a scheduler that throws never flushes inline and the queue stays bounded", () => {
  // Regression (review round 2): the old inline fallback re-ran subscriber
  // work inside the publishing stack. A broken scheduler must drop nothing
  // synchronously; a later working scheduler drains the retained queue.
  const steps = [];
  let broken = true;
  const feed = createChildViewFeed({
    schedule: (callback) => {
      if (broken) throw new Error("scheduler unavailable");
      steps.push(callback);
    },
  });
  const seen = [];
  let syncDelivery = 0;
  let inPublish = false;
  feed.subscribe(ID, (event) => {
    if (inPublish) syncDelivery += 1;
    seen.push(event.kind);
  });
  inPublish = true;
  feed.publish(ID, { kind: "run_started" });
  feed.publish(ID, { kind: "message_completed", content: [] });
  inPublish = false;
  assert.deepEqual(seen, [], "a throwing scheduler delivers nothing, inline or otherwise");

  broken = false;
  feed.publish(ID, { kind: "run_finished" });
  for (let tick = 0; tick < 5 && steps.length > 0; tick += 1) {
    const callback = steps.shift();
    if (callback !== undefined) callback();
  }
  assert.deepEqual(seen, ["run_started", "message_completed", "run_finished"],
    "a recovered scheduler drains the retained queue in order");
  assert.equal(syncDelivery, 0);
});

test("a recovered scheduler retries when the only later publication coalesces a delta", () => {
  const steps = [];
  let broken = true;
  const feed = createChildViewFeed({
    schedule: (callback) => {
      if (broken) throw new Error("scheduler unavailable");
      steps.push(callback);
    },
  });
  const seen = [];
  feed.subscribe(ID, (event) => seen.push(event));
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "old" }] });
  broken = false;
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "new" }] });
  assert.equal(steps.length, 1, "the coalesced publication retries scheduling");
  steps.shift()?.();
  assert.deepEqual(seen, [{ kind: "message_delta", parts: [{ type: "text", text: "new" }] }]);
});

test("a bounded pending queue drops the oldest with one visible omission marker", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event.kind));
  for (let index = 0; index < MAX_PENDING_EVENTS + 5; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  deliverAll();
  assert.ok(seen.length <= MAX_PENDING_EVENTS, "the delivered stream stays within the hard queue bound");
  assert.equal(seen[0], "live_events_dropped", "the drop is explicit, never silent");
});

test("overflow across many observed children never exceeds the total feed bound", () => {
  const { feed, deliverAll } = manualFeed();
  let delivered = 0;
  for (let child = 0; child < MAX_PENDING_EVENTS + 44; child += 1) {
    feed.subscribe(`child-${child}`, () => { delivered += 1; });
  }
  for (let index = 0; index < MAX_PENDING_EVENTS + 44; index += 1) {
    feed.publish(`child-${index}`, { kind: "tool_result_completed" });
  }
  deliverAll();
  assert.ok(delivered <= MAX_PENDING_EVENTS, `delivered ${delivered} entries past the hard bound`);
});

test("a structural event is delivered in the first flush despite an ordinary-update backlog", () => {
  let clock = 0;
  const { feed, deliver } = manualFeed(undefined, () => clock);
  const seen = [];
  feed.subscribe(ID, (event) => {
    seen.push(event.kind);
    clock += 20;
  });
  for (let index = 0; index < 80; index += 1) {
    feed.publish(ID, { kind: "tool_updated", callKey: callKeyOf(`call-${index}`), name: "grep" });
  }
  feed.publish(ID, { kind: "tool_finished", callKey: callKeyOf("call-final"), name: "grep", isError: false });
  deliver();
  assert.deepEqual(seen, ["tool_finished"], "superseded ordinary updates cannot strand the boundary");
});

test("a slow subscriber cannot monopolize one structural flush", () => {
  let clock = 0;
  const { feed, deliver, pending } = manualFeed(undefined, () => clock);
  const seen = [];
  feed.subscribe(ID, (event) => {
    seen.push(event.kind);
    clock += 20;
  });
  feed.publish(ID, { kind: "tool_started", callKey: callKeyOf("slow"), name: "grep", summary: "called", startedAt: 1 });
  feed.publish(ID, { kind: "run_finished" });

  deliver();
  assert.equal(clock, 20, "one flush spends only its deterministic total budget");
  assert.deepEqual(seen, ["tool_started"], "the remaining structural boundary yields to another scheduler turn");
  assert.equal(pending(), 1, "the remainder is scheduled rather than dropped");
});

test("run completion keeps only the newest cumulative assistant partial", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe(ID, (event) => seen.push(event));
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "old" }] });
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "final partial" }] });
  feed.publish(ID, { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(seen, [
    { kind: "message_delta", parts: [{ type: "text", text: "final partial" }] },
    { kind: "run_finished" },
  ]);
});

test("the total flush budget applies across distinct subscribers", () => {
  let clock = 0;
  const { feed, deliver, pending } = manualFeed(undefined, () => clock);
  let delivered = 0;
  for (let index = 0; index < 8; index += 1) {
    feed.subscribe(ID, () => {
      delivered += 1;
      clock += 20;
    });
  }
  feed.publish(ID, { kind: "run_finished" });

  deliver();
  assert.equal(clock, 20, "subscriber fan-out stays inside one deterministic total turn budget");
  assert.equal(delivered, 1, "later subscribers yield rather than accumulating their budgets");
  assert.equal(pending(), 1, "fan-out resumes at the next subscriber position");
});

test("overflow markers carry the dropped completions' fingerprints for recovery", () => {
  const { feed, deliverAll } = manualFeed();
  const markers = [];
  feed.subscribe("child-1", (event) => {
    if (event.kind === "live_events_dropped") markers.push(event);
  });
  for (let index = 0; index < MAX_PENDING_EVENTS + 2; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  feed.publish("child-1", { kind: "message_completed", content: [{ type: "text", text: "final" }], timestamp: 42 });
  for (let index = 0; index < MAX_PENDING_EVENTS + 2; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  deliverAll();
  assert.ok(markers.length > 0, "overflow produced at least one marker");
  assert.ok(markers.some((marker) => marker.droppedUnknown === true),
    "unfingerprintable dropped lifecycle events remain explicitly unknown");
  assert.ok(markers.some((marker) => (marker.dropped ?? []).some(
    (entry) => entry.kind === "message" && entry.timestamp === 42,
  )), "the dropped completion's fingerprint travels with the marker");
});

test("unsubscribe, clear, and the subscriber bound hold", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  const unsubscribe = feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_started" });
  deliverAll();
  unsubscribe();
  feed.publish("child-1", { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(seen, ["run_started"]);

  for (let index = 0; index < 8; index += 1) feed.subscribe("child-2", () => {});
  const late = [];
  feed.subscribe("child-2", (event) => late.push(event.kind));
  feed.publish("child-2", { kind: "run_started" });
  deliverAll();
  assert.deepEqual(late, [], "the global subscriber bound rejects the ninth subscription");

  feed.clear();
  const before = [];
  feed.subscribe("child-3", (event) => before.push(event.kind));
  feed.publish("child-3", { kind: "run_started" });
  deliverAll();
  assert.deepEqual(before, ["run_started"], "clear releases the global subscriber capacity");
  feed.clear();
  feed.publish("child-3", { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(before, ["run_started"], "clear drops subscribers and later unobserved events");
});

// ---------------------------------------------------------------------------
// Runner

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error?.stack ?? error}`);
  }
}
if (failed > 0) {
  console.error(`${tests.length} tests, ${failed} failed`);
  process.exit(1);
}
console.log(`live feed tests: ${tests.length} tests, 0 failed`);
