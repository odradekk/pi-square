import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const {
  SHADOW_NOTIFICATION_TYPE,
  MAX_BATCH_RESULTS,
  MAX_PENDING_RESULTS,
  buildShadowDeliveryContent,
  shadowNotificationResultIds,
  resolveDeliveryDecision,
  createShadowDeliveryController,
} = await load(join(packageRoot, "src", "shadow-minds", "delivery.ts"));

// ── resolveDeliveryDecision ────────────────────────────────────────

{
  const timing = { currentRun: 3, currentTaskEpoch: 2, parentRunning: true };
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "steer", sourceRun: 3 }, timing),
    { action: "send", mode: "steer" },
    "steer sends while its source parent run is the active run",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "steer", sourceRun: 2 }, timing),
    { action: "degrade" },
    "a steer from an earlier parent run degrades",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "steer", sourceRun: 3 }, { ...timing, parentRunning: false }),
    { action: "degrade" },
    "late steer after the source run settled degrades",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "wake", sourceRun: 3 }, timing),
    { action: "send", mode: "steer" },
    "wake enters the active run while one runs",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "wake", sourceRun: 3 }, { ...timing, parentRunning: false }),
    { action: "send", mode: "follow-up" },
    "wake starts a follow-up while the parent is idle",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "wake", sourceRun: 3, taskEpoch: 1 }, timing),
    { action: "degrade" },
    "stale-task wake degrades",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "steer", sourceRun: 3, taskEpoch: 1 }, timing),
    { action: "degrade" },
    "stale-task steer degrades",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "explicit", sourceRun: 1, taskEpoch: 1 }, timing),
    { action: "send", mode: "steer" },
    "an explicit user send is never stale",
  );
  assert.deepEqual(
    resolveDeliveryDecision({ policy: "explicit", sourceRun: 1 }, { ...timing, parentRunning: false }),
    { action: "send", mode: "follow-up" },
    "an explicit send starts a follow-up while idle",
  );
}

// ── buildShadowDeliveryContent ─────────────────────────────────────

function makeResult(overrides = {}) {
  return {
    id: "shr-1",
    shadowId: "completion-check",
    shadowName: "Completion check",
    payload: { summary: "All tests pass locally." },
    delivery: "notified",
    source: "automatic",
    primaryTrigger: "completion",
    taskIdentity: { epoch: 2 },
    ...overrides,
  };
}

{
  const single = buildShadowDeliveryContent([{ id: "shr-1", value: { kind: "result", result: makeResult() } }], false);
  assert.match(single, /^\[Shadow advisory\]/, "delivery is framed as Shadow advisory evidence");
  assert.match(single, /id: shr-1/, "the result identity is preserved");
  assert.match(single, /shadow: Completion check \(completion-check\)/, "the source Shadow is attributed");
  assert.match(single, /source: automatic · completion/, "the source and trigger are attributed");
  assert.match(single, /task: 2/, "the task epoch is attributed");
  assert.match(single, /Advisory evidence/, "the advisory framing states its limits");
  assert.match(single, /never replaces/, "the framing denies authority over instructions");
  assert.match(single, /"summary":"All tests pass locally\."/, "the payload is preserved verbatim");
  assert.doesNotMatch(single, /\(resent\)/, "a first delivery is not marked resent");
}

{
  const resent = buildShadowDeliveryContent([{ id: "shr-1", value: { kind: "result", result: makeResult() } }], true);
  assert.match(resent, /\(resent\)/, "a resent delivery is marked");
}

{
  const entries = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `shr-${n}`,
    value: { kind: "result", result: makeResult({ id: `shr-${n}`, payload: { summary: `Finding ${n}.` } }) },
  }));
  const batch = buildShadowDeliveryContent(entries, false);
  assert.match(batch, /^\[Shadow advisory: 7 results\]/, "a batch names its size");
  assert.match(batch, /--- 1\/7 · id: shr-1/, "each entry is separated and numbered");
  for (let n = 1; n <= 7; n += 1) {
    assert.match(batch, new RegExp(`Finding ${n}\\.`), `payload ${n} is preserved without model summarization`);
  }
}

{
  const huge = "x".repeat(40_000);
  const bounded = buildShadowDeliveryContent(
    [{ id: "shr-big", value: { kind: "result", result: makeResult({ payload: { summary: huge } }) } }],
    false,
  );
  assert.ok(bounded.length < 60_000, "an oversized payload keeps a head/tail budget");
  assert.match(bounded, /\[omitted \d+ characters\]/, "the omission is visible");
}

{
  const secretPayload = buildShadowDeliveryContent(
    [{ id: "shr-secret", value: { kind: "result", result: makeResult({ payload: { summary: "Authorization: Bearer RESULTSECRET", api_key: "SECOND" } }) } }],
    false,
  );
  assert.doesNotMatch(secretPayload, /RESULTSECRET|SECOND/, "model-facing result payloads pass the shared credential cleaner");
  assert.match(secretPayload, /\[REDACTED\]/);
}
{
  const error = buildShadowDeliveryContent(
    [{ id: "shadow-err-run-1", value: { kind: "error-summary", shadowName: "Completion check", shadowId: "completion-check", runId: "run-1", phase: "error", message: "Model authentication failed after 2 attempts." } }],
    false,
  );
  assert.match(error, /^\[Shadow run failure summary\]/, "an error summary is framed as a failure notice");
  assert.match(error, /run: run-1 · phase: error/, "the failed run is attributed");
  assert.match(error, /Model authentication failed/, "the bounded message is preserved");
  assert.match(error, /stay in \/shadow/, "infrastructure diagnostics stay in the manager");
}

// ── shadowNotificationResultIds ────────────────────────────────────

{
  assert.deepEqual(
    shadowNotificationResultIds({
      customType: SHADOW_NOTIFICATION_TYPE,
      details: { version: 1, results: [{ id: "shr-1", kind: "result" }, { id: "shadow-err-run-1", kind: "error-summary" }] },
    }),
    ["shr-1", "shadow-err-run-1"],
    "notification ids parse from the v1 details",
  );
  assert.deepEqual(shadowNotificationResultIds({ customType: "other" }), [], "foreign messages confirm nothing");
  assert.deepEqual(shadowNotificationResultIds(undefined), [], "a missing message confirms nothing");
  assert.deepEqual(
    shadowNotificationResultIds({ customType: SHADOW_NOTIFICATION_TYPE, details: { version: 1, results: [{ id: "shr-2" }] } }),
    ["shr-2"],
  );
}

assert.equal(MAX_BATCH_RESULTS, 6, "batches coalesce at most six results");
assert.equal(MAX_PENDING_RESULTS, 50, "the pending set stays bounded at fifty");

// ── createShadowDeliveryController ─────────────────────────────────

function makeHarness(options = {}) {
  const sent = [];
  let sendAttempts = 0;
  const runtimeOps = {
    sendResultForDelivery: [],
    markDelivered: [],
    degraded: [],
    ...options.runtimeOps,
  };
  const controller = createShadowDeliveryController({
    pi: {
      sendMessage(message, sendOptions) {
        sendAttempts += 1;
        if (options.failSendOnce && sendAttempts === 1) throw new Error("send failed");
        sent.push({ message, sendOptions });
      },
    },
    getRuntime: () => ({
      sendResultForDelivery: (id) => {
        runtimeOps.sendResultForDelivery.push(id);
        return true;
      },
      markResultDelivered: (id) => {
        runtimeOps.markDelivered.push(id);
        return true;
      },
      degradeResultDelivery: (id) => {
        runtimeOps.degraded.push(id);
        return true;
      },
    }),
    timing: options.timing ?? (() => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: true })),
    onDegrade: (count) => runtimeOps.degradeNotices.push(count),
    onPendingChange: () => runtimeOps.changes.push(true),
  });
  runtimeOps.degradeNotices = [];
  runtimeOps.changes = [];
  return { controller, sent, runtimeOps };
}

{
  // Steer delivers at the turn boundary of its source run and confirms
  // through transcript observation.
  const { controller, sent, runtimeOps } = makeHarness();
  controller.enqueueResult(makeResult());
  assert.equal(sent.length, 0, "a busy parent does not receive the result at once");
  controller.handleTurnEnd({ stopReason: "tool_use" });
  assert.equal(sent.length, 1, "the result enters the model at the turn boundary");
  assert.equal(sent[0].sendOptions.deliverAs, "steer", "a running parent is steered");
  assert.equal(sent[0].sendOptions.triggerTurn, true);
  assert.equal(runtimeOps.sendResultForDelivery[0], "shr-1", "the inbox records the pending handoff");
  assert.deepEqual(runtimeOps.markDelivered, [], "delivery is not confirmed before observation");
  controller.observeMessage({
    customType: SHADOW_NOTIFICATION_TYPE,
    details: { version: 1, results: [{ id: "shr-1", kind: "result" }] },
  });
  assert.deepEqual(runtimeOps.markDelivered, ["shr-1"], "a transcript observation confirms the delivery");
  assert.equal(controller.pendingCount(), 0, "a confirmed result leaves the pending set");
}

{
  // Late steer: the run settles before the turn boundary, so the result
  // degrades to notify without ever reaching the model.
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false }),
  });
  controller.enqueueResult(makeResult());
  assert.equal(sent.length, 0, "an idle parent never receives a steer at enqueue time");
  assert.deepEqual(runtimeOps.degraded, ["shr-1"], "the late steer degrades in the inbox");
  assert.equal(controller.pendingCount(), 0, "a degraded result leaves the delivery machine");
}

{
  // Wake: idle parent, current task — the result starts a follow-up turn.
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 2, parentRunning: false }),
  });
  controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  assert.equal(sent.length, 1, "an idle parent receives the wake result at once");
  assert.equal(sent[0].sendOptions.triggerTurn, true, "the wake starts a follow-up turn");
  assert.equal(sent[0].sendOptions.deliverAs, undefined, "an idle parent needs no queue mode");
  assert.equal(runtimeOps.markDelivered.length, 0);
}

{
  // Wake with a stale task degrades instead of waking a new task.
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 3, currentTaskEpoch: 3, parentRunning: false }),
  });
  controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  assert.equal(sent.length, 0, "a stale task is never woken");
  assert.deepEqual(runtimeOps.degraded, ["shr-1"]);
}

{
  // Notify policy never auto-delivers.
  const { controller, sent } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false }),
  });
  controller.enqueueResult(makeResult({ configuredDelivery: "notify" }));
  controller.handleTurnEnd({});
  controller.handleAgentSettled();
  assert.equal(sent.length, 0, "a notify result stays in the inbox");
  assert.equal(controller.pendingCount(), 0);
}

{
  // Interruption suppresses delivery; the next run boundary retries.
  const { controller, sent } = makeHarness();
  controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  controller.handleTurnEnd({ stopReason: "tool_use" });
  assert.equal(sent.length, 1, "the running parent received the result first");
  controller.handleTurnEnd({ stopReason: "aborted" });
  controller.handleAgentEnd([{ stopReason: "aborted" }]);
  controller.handleAgentSettled();
  assert.equal(sent.length, 1, "an interrupted parent suppresses delivery");
  controller.handleAgentStart();
  controller.handleTurnEnd({});
  assert.equal(sent.length, 2, "the next run boundary delivers again");
  assert.match(sent[1].message.content, /\(resent\)/, "the repeat is marked as resent");
}

{
  // Send failure retains the result for the next safe moment.
  const { controller, sent, runtimeOps } = makeHarness({
    failSendOnce: true,
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false }),
  });
  controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  assert.equal(sent.length, 0, "the send failed before reaching the parent");
  assert.equal(controller.pendingCount(), 1, "the result stays pending after a send failure");
  controller.handleAgentSettled();
  assert.equal(sent.length, 1, "a natural settle retries the delivery");
  assert.deepEqual(runtimeOps.markDelivered, [], "nothing is confirmed yet");
}

{
  // Batching: compatible results coalesce up to six; the rest follow.
  const { controller, sent } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: true }),
  });
  for (let n = 1; n <= 8; n += 1) {
    controller.enqueueResult(makeResult({ id: `shr-${n}`, configuredDelivery: "wake", payload: { summary: `Finding ${n}.` } }));
  }
  assert.equal(sent.length, 0, "a busy parent holds every result for the boundary");
  controller.handleTurnEnd({});
  assert.equal(sent.length, 1, "the boundary delivers the first batch");
  controller.handleTurnEnd({});
  assert.equal(sent.length, 2, "eight results deliver in two batches");
  assert.match(sent[0].message.content, /\[Shadow advisory: 6 results\]/, "the first batch holds six");
  assert.match(sent[1].message.content, /\[Shadow advisory: 2 results\]/, "the remainder follows");
  for (const batch of sent) {
    assert.deepEqual(batch.sendOptions, sent[0].sendOptions, "one batch sends with one mode");
  }
}

{
  // Send to agent promotes a notified result through the same machine.
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 5, parentRunning: false }),
  });
  const notifyResult = makeResult({ configuredDelivery: "notify", taskIdentity: { epoch: 1 } });
  controller.enqueueResult(notifyResult);
  assert.equal(sent.length, 0, "notify never auto-delivers, even stale");
  assert.equal(controller.sendResultToAgent(notifyResult), true, "an explicit send promotes the result");
  assert.equal(sent.length, 1, "the explicit send reaches the model");
  assert.equal(sent[0].sendOptions.triggerTurn, true);
  assert.deepEqual(runtimeOps.sendResultForDelivery, ["shr-1"], "the explicit send transitions the inbox state");
}

{
  // Error summaries are explicit-only and bounded.
  const { controller, sent } = makeHarness();
  assert.equal(
    controller.sendErrorSummary({ id: "run-9", shadowId: "ground", shadowName: "Ground", phase: "error", message: "boom" }),
    true,
  );
  controller.handleTurnEnd({});
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /\[Shadow run failure summary\]/);
  assert.ok(sent[0].message.content.length < 4_000, "the failure summary stays bounded");
}

{
  // Removal and reset keep the pending set bounded and accurate.
  const { controller } = makeHarness();
  controller.enqueueResult(makeResult({ id: "shr-x" }));
  assert.equal(controller.isPending("shr-x"), true);
  controller.remove("shr-x");
  assert.equal(controller.isPending("shr-x"), false);
  controller.enqueueResult(makeResult({ id: "shr-y" }));
  controller.reset();
  assert.equal(controller.pendingCount(), 0, "reset clears the pending set");
}

// ── Review regressions: mixed batches, capacity, reconcile ─────────

{
  // A deferred result and an explicit failure summary never share one
  // message: the kinds batch separately, each with its own framing.
  const { controller, sent } = makeHarness();
  controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  controller.sendErrorSummary({ id: "run-9", shadowId: "ground", shadowName: "Ground", phase: "error", message: "boom" });
  assert.equal(sent.length, 0, "the busy parent defers both entries");
  controller.handleTurnEnd({});
  assert.equal(sent.length, 1, "the boundary delivers one kind");
  const first = sent[0].message.content;
  controller.handleTurnEnd({});
  assert.equal(sent.length, 2, "the next boundary delivers the other kind");
  const kinds = [first, sent[1].message.content].sort();
  assert.match(kinds[0], /^\[Shadow advisory\]/, "the result keeps advisory framing");
  assert.match(kinds[1], /^\[Shadow run failure summary\]/, "the failure keeps its own framing");
  for (const batch of [sent[0], sent[1]]) {
    assert.ok(batch.message.content.length < 60_000, "each message stays bounded");
  }
}

{
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 2, currentTaskEpoch: 1, parentRunning: true }),
  });
  controller.enqueueResult(makeResult({ taskIdentity: { epoch: 1, sourceRun: 1 } }));
  controller.handleTurnEnd({});
  assert.equal(sent.length, 0, "a steer is bound to the run that triggered its activation, not the run in which it completed");
  assert.deepEqual(runtimeOps.degraded, ["shr-1"]);
}

{
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false }),
  });
  controller.sendErrorSummary({ id: "run-cleanup", shadowId: "ground", shadowName: "Ground", phase: "error", message: "boom" });
  const notification = sent[0].message;
  controller.observeMessage(notification);
  controller.handleAgentSettled();
  assert.deepEqual(runtimeOps.degradeNotices, [], "a confirmed failure summary leaves no stale side record to reconcile");
}
{
  // Pending-cap guard: beyond fifty unconfirmed entries, the oldest
  // degrades visibly instead of being silently dropped with a stranded
  // "sending" inbox row.
  const { controller, sent, runtimeOps } = makeHarness();
  for (let n = 1; n <= 51; n += 1) {
    controller.enqueueResult(makeResult({ id: `shr-${n}`, configuredDelivery: "wake", payload: { summary: `F${n}.` } }));
  }
  assert.equal(controller.pendingCount(), 50, "the pending set holds at most fifty");
  assert.deepEqual(runtimeOps.degraded, ["shr-1"], "the oldest entry degrades visibly");
  const views = { shr1Degraded: runtimeOps.degraded.length };
  controller.handleTurnEnd({});
  assert.equal(sent.length, 1, "the capacity guard never blocks delivery");
  assert.match(sent[0].message.content, /\[Shadow advisory: 6 results\]/);
  assert.equal(views.shr1Degraded, 1);
}

// ── Quiet headless transcript confirmation (#160) ───────────────────

{
  // A quiet append never reaches extension handlers as message_start. The
  // drain confirms only IDs it subsequently observes in persisted session
  // entries; a fire-and-forget send call alone is not authoritative.
  const { controller, sent, runtimeOps } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false, quiet: true }),
  });
  controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  assert.equal(sent.length, 0, "a quiet drain defers the flush to its settle point");
  controller.handleAgentSettled();
  assert.equal(sent.length, 1, "the settle point flushes quietly");
  assert.equal(sent[0].sendOptions.triggerTurn, false, "a quiet send never starts a turn");
  assert.equal(runtimeOps.markDelivered.length, 0, "nothing is confirmed before transcript observation");
  assert.equal(controller.confirmQuietDeliveries([]), 0, "an unobserved fire-and-forget send is never confirmed");
  assert.equal(controller.pendingCount(), 1);
  assert.equal(controller.confirmQuietDeliveries(["shr-1"]), 1, "an observed persisted notification confirms the quiet send");
  assert.deepEqual(runtimeOps.markDelivered, ["shr-1"], "the inbox records the delivered state");
  assert.equal(controller.pendingCount(), 0);
  assert.equal(controller.confirmQuietDeliveries(["shr-1"]), 0, "the confirmation is single-shot");

  // A failed quiet send stays unconfirmed and pending for the retry path even
  // if an unrelated branch entry names the same ID.
  const failing = makeHarness({
    failSendOnce: true,
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false, quiet: true }),
  });
  failing.controller.enqueueResult(makeResult({ configuredDelivery: "wake" }));
  failing.controller.handleAgentSettled();
  assert.equal(failing.sent.length, 0, "the quiet send failed");
  assert.equal(failing.controller.confirmQuietDeliveries(["shr-1"]), 0, "a failed send is never confirmed");
  assert.equal(failing.controller.pendingCount(), 1, "the result stays pending for the next safe moment");
}

{
  const { controller, sent } = makeHarness({
    timing: () => ({ currentRun: 1, currentTaskEpoch: 1, parentRunning: false, quiet: true }),
  });
  for (let n = 1; n <= 8; n += 1) {
    controller.enqueueResult(makeResult({ id: `shr-${n}`, configuredDelivery: "wake", payload: { summary: `Finding ${n}` } }));
  }
  controller.handleAgentSettled();
  assert.equal(sent.length, 1);
  const firstIds = sent[0].message.details.results.map((entry) => entry.id);
  assert.equal(controller.confirmQuietDeliveries(firstIds), 6);
  controller.handleAgentSettled();
  assert.equal(sent.length, 2, "a second quiet settle drains the remainder beyond the six-result batch cap");
  const secondIds = sent[1].message.details.results.map((entry) => entry.id);
  assert.equal(controller.confirmQuietDeliveries(secondIds), 2);
  assert.equal(controller.pendingCount(), 0);
}
console.log("shadow-minds delivery tests: OK");
