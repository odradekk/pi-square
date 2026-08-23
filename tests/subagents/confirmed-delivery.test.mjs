import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";

import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  createConfirmedDeliveryCore,
  DEFAULT_MAX_BATCH_RESULTS,
  DEFAULT_MAX_PENDING_RESULTS,
} = await load(join(packageRoot, "src", "subagents", "confirmed-delivery.ts"));

/**
 * Consumer-agnostic contract tests for the reliable-delivery core: the payload
 * is a plain string, confirmation is a synthetic marker message, and batching
 * is verified through identity and caller hooks alone. No Subagent type
 * appears anywhere.
 */
function harness(options = {}) {
  const sent = [];
  const confirmed = [];
  let changes = 0;
  let idle = options.idle ?? true;
  let failing = false;
  const core = createConfirmedDeliveryCore({
    send(batch, resent) {
      if (failing) throw new Error("send refused");
      sent.push({
        ids: batch.map((entry) => entry.id),
        values: batch.map((entry) => entry.value),
        resent,
      });
    },
    confirmIds(message) {
      const candidate = message;
      if (!candidate || candidate.kind !== "delivery-marker") return [];
      const ids = candidate.ids;
      confirmed.push([...ids]);
      return [...ids];
    },
    ...(options.batchKey ? { batchKey: options.batchKey } : {}),
    ...(options.maxBatch ? { maxBatch: options.maxBatch } : {}),
    ...(options.maxPending ? { maxPending: options.maxPending } : {}),
    isIdle: () => idle,
    onPendingChange: () => { changes += 1; },
  });
  return {
    core,
    sent,
    confirmed: () => confirmed,
    changes: () => changes,
    setIdle(value) { idle = value; },
    failSend(value) { failing = value; },
    last() { return sent[sent.length - 1]; },
    confirm(ids) {
      core.observeMessage({ kind: "delivery-marker", ids });
    },
  };
}

test("delivers a generic result to an idle consumer and confirms it by identity", () => {
  const probe = harness();
  probe.core.enqueue({ id: "r1", value: "payload-one" });

  assert.equal(probe.sent.length, 1, "an idle consumer receives the result at once");
  assert.deepEqual(probe.last().ids, ["r1"]);
  assert.deepEqual(probe.last().values, ["payload-one"]);
  assert.equal(probe.last().resent, false);
  assert.equal(probe.core.pendingCount(), 1);

  probe.confirm(["r1"]);
  assert.equal(probe.core.pendingCount(), 0, "a matching confirmation removes only the confirmed result");
  assert.deepEqual(probe.confirmed(), [["r1"]]);
  assert.ok(probe.changes() >= 2, "every pending-set change reaches the persistence hook");
});

test("confirmation ignores messages the caller hook does not recognize", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "r1", value: "v" });
  probe.core.observeMessage({ kind: "foreign", ids: ["r1"] });
  probe.core.observeMessage(undefined);
  assert.equal(probe.core.pendingCount(), 1, "foreign messages never confirm anything");
});

test("a busy consumer receives results at the turn boundary, coalesced up to the batch bound", () => {
  const probe = harness({ idle: false });
  for (let index = 0; index < DEFAULT_MAX_BATCH_RESULTS + 1; index += 1) {
    probe.core.enqueue({ id: `r${index}`, value: `v${index}` });
  }
  assert.equal(probe.sent.length, 0, "nothing is pushed into a running turn");

  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.equal(probe.last().ids.length, DEFAULT_MAX_BATCH_RESULTS);
  assert.deepEqual(probe.last().ids, ["r0", "r1", "r2", "r3", "r4", "r5"]);

  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 2, "the surplus follows at the next safe moment");
  assert.deepEqual(probe.last().ids, ["r6"]);
});

test("custom batch and pending bounds are honored", () => {
  const probe = harness({ idle: false, maxBatch: 2, maxPending: 3 });
  for (let index = 0; index < 5; index += 1) probe.core.enqueue({ id: `r${index}`, value: `v${index}` });
  assert.equal(probe.core.pendingCount(), 3, "the oldest results leave first beyond the pending bound");
  assert.equal(probe.core.isPending("r0"), false);
  assert.equal(probe.core.isPending("r4"), true);
  assert.deepEqual(probe.core.pendingIds(), ["r2", "r3", "r4"]);

  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["r2", "r3"], "the custom batch bound limits one message");
});

test("incompatible results never share a message and are drained group by group", () => {
  const probe = harness({ idle: false, batchKey: (value) => value.split(":")[0] });
  probe.core.enqueue({ id: "wake-1", value: "wake:report-a" });
  probe.core.enqueue({ id: "notify-1", value: "notify:note-b" });
  probe.core.enqueue({ id: "wake-2", value: "wake:report-c" });

  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1, "one flush delivers exactly one compatibility group");
  assert.deepEqual(probe.last().ids, ["wake-1", "wake-2"], "same-key results coalesce");

  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["notify-1"]);
});

test("an unconfirmed result is resent after a natural settle and marked as repeated", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "lost", value: "v" });
  probe.core.handleTurnEnd();
  assert.equal(probe.last().resent, false);

  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 2, "the discarded result is delivered again");
  assert.equal(probe.last().resent, true);

  probe.confirm(["lost"]);
  probe.core.handleAgentSettled();
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 2, "confirmation stops re-delivery");
});

test("an interrupted run suppresses delivery until the next agent start", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "held", value: "v" });
  probe.core.handleAgentEnd([{ stopReason: "aborted" }]);
  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 0, "an interruption never starts a new turn");

  probe.setIdle(true);
  probe.core.enqueue({ id: "after", value: "v2" });
  assert.equal(probe.sent.length, 0, "silence holds across further completions");

  probe.core.handleAgentStart();
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.deepEqual(probe.last().ids, ["held", "after"]);
});

test("a natural (non-interrupted) settle flushes at once", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "natural", value: "v" });
  probe.core.handleAgentEnd([{ stopReason: "endTurn" }]);
  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 1);
});

test("a failed send retains the batch for the next safe moment and states the repeat", () => {
  const probe = harness({ idle: false });
  probe.failSend(true);
  probe.core.enqueue({ id: "kept", value: "v" });

  probe.core.handleTurnEnd();
  assert.equal(probe.core.pendingCount(), 1, "a failed send never discards the result");
  assert.equal(probe.sent.length, 0);

  probe.failSend(false);
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.equal(probe.last().resent, true, "the retry states that it repeats");
});

test("remove and reset drop results without delivering them", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "dropped", value: "v" });
  probe.core.remove("dropped");
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 0);

  probe.core.enqueue({ id: "reset-1", value: "v" });
  probe.core.reset();
  assert.equal(probe.core.pendingCount(), 0);
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 0);
});

test("re-enqueueing an identity keeps its original completion position", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "a", value: "first" });
  probe.core.enqueue({ id: "b", value: "second" });
  probe.core.enqueue({ id: "a", value: "updated" });

  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["a", "b"], "the updated result keeps its original slot");
  assert.deepEqual(probe.last().values, ["updated", "second"]);
});

test("default bounds match the documented delivery contract", () => {
  assert.equal(DEFAULT_MAX_BATCH_RESULTS, 6);
  assert.equal(DEFAULT_MAX_PENDING_RESULTS, 50);
});

await run();
