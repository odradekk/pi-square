import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";

import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  createConfirmedDeliveryCore,
  DEFAULT_MAX_BATCH_RESULTS,
  DEFAULT_MAX_CLAIM_RESERVATIONS,
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
    ...(options.maxReservations ? { maxReservations: options.maxReservations } : {}),
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

test("an interrupted run suppresses delivery in Pi's turn-end-before-agent-end order", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "held", value: "v" });

  // Pi 0.84.2 emits the aborted assistant turn before agent_end. Delivery must
  // be suppressed at this boundary, after the UI has already cleared queues.
  probe.core.handleTurnEnd({ stopReason: "aborted" });
  probe.core.handleAgentEnd([{ stopReason: "aborted" }]);
  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 0, "an aborted turn never re-queues a steering message");

  probe.setIdle(true);
  probe.core.enqueue({ id: "after", value: "v2" });
  assert.equal(probe.sent.length, 0, "silence holds across further completions");

  probe.core.handleAgentStart();
  probe.core.handleTurnEnd({ stopReason: "endTurn" });
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


// ─── Atomic claim, take, and release (odradekk/pi-square#277) ────────

test("a claim reserves an identity before its result exists and the result is never auto-delivered", () => {
  const probe = harness();
  const result = probe.core.claim(["r1"]);
  assert.equal(result.ok, true);
  assert.equal(probe.core.isClaimed("r1"), true);

  probe.core.enqueue({ id: "r1", value: "payload" });
  assert.equal(probe.core.isPending("r1"), true, "the claimed result stays in the store");
  assert.equal(result.claim.result("r1"), "payload");
  probe.core.handleTurnEnd();
  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 0, "a claimed result is excluded from every automatic delivery");
  assert.equal(probe.core.pendingCount(), 1);
});

test("a claim of an unsent pending result excludes it from flush and batch selection", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "free", value: "a" });
  probe.core.enqueue({ id: "held", value: "b" });
  const result = probe.core.claim(["held"]);
  assert.equal(result.ok, true);

  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["free"], "the flush skips the claimed entry");
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1, "nothing retries the claimed entry");
});

test("an already-claimed identity rejects the complete request atomically", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "kept", value: "v" });
  probe.core.enqueue({ id: "later", value: "v" });

  const first = probe.core.claim(["kept", "later"]);
  assert.equal(first.ok, true, "one claim may reserve several identities");
  assert.deepEqual([...first.claim.ids], ["kept", "later"]);

  const second = probe.core.claim(["later"]);
  assert.equal(second.ok, false);
  assert.equal(second.failure.kind, "already-claimed");
  assert.equal(second.failure.id, "later");

  const third = probe.core.claim(["unrelated"]);
  assert.equal(third.ok, true, "a rejected claim leaves other identities claimable");

  first.claim.release(() => true);
  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["kept", "later"], "released unsent entries rejoin the schedule");
});

test("a sent-but-unconfirmed identity cannot be claimed because the send cannot be withdrawn", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "in-flight", value: "v" });
  probe.core.enqueue({ id: "stored", value: "v" });
  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["in-flight", "stored"]);
  assert.equal(probe.core.isSent("in-flight"), true);

  const result = probe.core.claim(["in-flight"]);
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "sent");
  assert.equal(probe.core.isClaimed("in-flight"), false, "the sent entry stays with the automatic path");
});

test("the reservation bound rejects a claim atomically and claimed entries are never evicted", () => {
  const probe = harness({ idle: false, maxPending: 3, maxReservations: 4 });
  for (let index = 0; index < 6; index += 1) probe.core.enqueue({ id: `r${index}`, value: `v${index}` });
  assert.deepEqual(probe.core.pendingIds(), ["r3", "r4", "r5"], "the unclaimed bound still evicts oldest-first");

  const held = probe.core.claim(["r3"]);
  assert.equal(held.ok, true);
  for (let index = 6; index < 10; index += 1) probe.core.enqueue({ id: `r${index}`, value: `v${index}` });
  assert.ok(probe.core.pendingIds().includes("r3"), "a claimed entry survives pending-set eviction");

  const over = probe.core.claim(["extra-1", "extra-2", "extra-3", "extra-4"]);
  assert.equal(over.ok, false);
  assert.equal(over.failure.kind, "capacity");
  assert.equal(over.failure.limit, 4);
  assert.equal(probe.core.isClaimed("extra-1"), false, "the rejected claim reserved nothing");
  const within = probe.core.claim(["extra-1", "extra-2", "extra-3"]);
  assert.equal(within.ok, true, "a claim within the bound still succeeds");
});

test("take consumes the claimed set in request order and removes it from the store", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "a", value: "first" });
  probe.core.enqueue({ id: "b", value: "second" });
  const result = probe.core.claim(["b", "a"]);
  assert.equal(result.ok, true);

  probe.core.enqueue({ id: "b", value: "second-updated" });
  assert.deepEqual(result.claim.take(), ["second-updated", "first"], "request order, not completion order");
  assert.equal(probe.core.pendingCount(), 0, "taken results leave the store");
  assert.equal(result.claim.active, false);
  assert.deepEqual(result.claim.take(), [undefined, undefined], "a claim is single-use");

  probe.core.handleTurnEnd();
  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 0, "a taken result is never delivered again");
});

test("release routes by the caller's keep policy and drops the rest", () => {
  const probe = harness({ idle: false });
  probe.core.enqueue({ id: "done", value: "keep:done" });
  probe.core.enqueue({ id: "stopped", value: "drop:stopped" });
  const active = probe.core.claim(["running", "done", "stopped"]);
  assert.equal(active.ok, true);

  active.claim.release((value) => String(value).startsWith("keep:"));
  assert.equal(probe.core.isClaimed("running"), false, "an unstored reservation is dropped");
  assert.equal(probe.core.isPending("done"), true, "a kept result stays in the store");
  assert.equal(probe.core.isPending("stopped"), false, "a dropped result leaves delivery storage");
  assert.equal(active.claim.active, false);

  probe.core.handleTurnEnd();
  assert.deepEqual(probe.last().ids, ["done"], "the kept result rejoins the automatic schedule");
});

test("remove and reset clear outstanding claims with the pending set", () => {
  const probe = harness();
  const result = probe.core.claim(["r1", "r2"]);
  assert.equal(result.ok, true);
  probe.core.enqueue({ id: "r2", value: "v" });

  probe.core.remove("r1");
  assert.equal(probe.core.isClaimed("r1"), false, "deleting a run's history ends its reservation");

  probe.core.reset();
  assert.equal(probe.core.isClaimed("r2"), false);
  assert.equal(result.claim.active, false);
  assert.equal(probe.core.pendingCount(), 0);
});

test("a removed identity can be re-claimed and the previous holder cannot touch the new owner's result", () => {
  const probe = harness();
  const first = probe.core.claim(["shared"]);
  assert.equal(first.ok, true);
  probe.core.enqueue({ id: "shared", value: "first-owner" });

  // The manager delete-history path: the pending entry and the reservation
  // end together, and the holder is notified so it never hangs.
  let notified = 0;
  const before = probe.changes();
  probe.core.remove("shared");
  notified = probe.changes() - before;
  assert.ok(notified >= 1, "a reservation removal wakes its holder");
  assert.equal(first.claim.holds("shared"), false);
  assert.equal(first.claim.result("shared"), undefined);

  // A later waiter may claim the freed identity.
  const second = probe.core.claim(["shared"]);
  assert.equal(second.ok, true);
  probe.core.enqueue({ id: "shared", value: "second-owner" });
  assert.equal(second.claim.holds("shared"), true);

  // The stale handle can neither take nor release the new owner's result.
  assert.deepEqual(first.claim.take(), [undefined]);
  assert.equal(probe.core.isPending("shared"), true, "the take left the new owner's entry alone");
  first.claim.release(() => true);
  assert.equal(second.claim.holds("shared"), true, "the release left the new owner's claim alone");

  assert.deepEqual(second.claim.take(), ["second-owner"], "only the current owner consumes the result");
});

test("the pending bound is total: claimed entries count toward it but are never evicted", () => {
  const probe = harness({ idle: false, maxPending: 3, maxReservations: 8 });
  const held = probe.core.claim(["kept-a", "kept-b"]);
  assert.equal(held.ok, true);
  probe.core.enqueue({ id: "kept-a", value: "a" });
  probe.core.enqueue({ id: "kept-b", value: "b" });
  assert.equal(probe.core.pendingCount(), 2);

  // One unclaimed result fits; the next evicts the oldest unclaimed entry.
  probe.core.enqueue({ id: "free-1", value: "f1" });
  assert.deepEqual(probe.core.pendingIds(), ["kept-a", "kept-b", "free-1"]);
  probe.core.enqueue({ id: "free-2", value: "f2" });
  assert.deepEqual(probe.core.pendingIds(), ["kept-a", "kept-b", "free-2"], "the total stays within the bound");
  assert.equal(probe.core.isPending("free-1"), false, "the oldest unclaimed entry leaves first");

  // When every stored entry is claimed, the incoming unclaimed result is the
  // one dropped: the total bound holds and no waiter-owned copy is destroyed.
  probe.core.remove("free-2");
  probe.core.enqueue({ id: "kept-c", value: "c" });
  const third = probe.core.claim(["kept-c"]);
  assert.equal(third.ok, true);
  assert.equal(probe.core.pendingCount(), 3);
  probe.core.enqueue({ id: "overflow", value: "o" });
  assert.equal(probe.core.pendingCount(), 3, "the bound is never exceeded");
  assert.equal(probe.core.isPending("overflow"), false, "the incoming unclaimed result is dropped");
  assert.deepEqual(held.claim.take(), ["a", "b"], "the claimed copies survive untouched");
});

test("the reservation bound default matches the documented wait contract", () => {
  assert.equal(DEFAULT_MAX_CLAIM_RESERVATIONS, 50);
});

await run();
