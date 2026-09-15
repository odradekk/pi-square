import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const packageRoot = resolve(import.meta.dirname, "..", "..");

const { createShadowResultStore } = await load(join(packageRoot, "src", "shadow-minds", "result-store.ts"));
const { createPersistentShadowResultStore } = await load(join(packageRoot, "src", "shadow-minds", "inbox-store.ts"));

const roots = [];

/** Pi 0.84.2 layout: one shared per-cwd directory of flat session files. */
function makeSessionRoot(sessionId = "sess-1") {
  const root = mkdtempSync(join(tmpdir(), `shadow-store-${process.pid}-`));
  roots.push(root);
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), "{}\n", "utf8");
  return { root, sessionDir };
}

const CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    nested: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  required: ["summary"],
  additionalProperties: false,
};

function addResult(store, index, overrides = {}) {
  return store.add({
    shadowId: "session-synthesizer",
    shadowName: "Session synthesizer",
    payload: { summary: `finding ${index}` },
    validationSchema: CONTRACT_SCHEMA,
    createdAt: 1_000 + index,
    ...overrides,
  });
}

/**
 * The single result-store contract (#363): every lifecycle transition —
 * creation, listing, attention, the delivery transitions, degradation,
 * forced downgrade, reopen recovery, and the transcript-reference
 * declarations — behaves identically on the in-memory store and on the
 * persistent partition store, because both implement the one
 * `ShadowResultStore` interface in full.
 */
function runResultStoreContract(name, makeStore) {
  {
    // Creation and listing: newest first, unread + notified by default, and
    // every attention transition refuses unknown IDs.
    const store = makeStore();
    const a = addResult(store, 1);
    const b = addResult(store, 2);
    assert.equal(a.attention, "unread", `${name}: results start unread`);
    assert.equal(a.delivery, "notified", `${name}: results start notified`);
    assert.deepEqual(store.list().map((entry) => entry.id), [b.id, a.id], `${name}: newest first`);

    assert.equal(store.markRead(a.id), true);
    assert.equal(store.list().find((entry) => entry.id === a.id).attention, "read");
    assert.equal(store.markRead("missing"), false, `${name}: unknown IDs are refused`);
    assert.equal(store.dismiss(a.id), true);
    assert.equal(store.list().find((entry) => entry.id === a.id).attention, "dismissed");

    const c = addResult(store, 3);
    assert.equal(store.delete(c.id), true);
    assert.equal(store.list().some((entry) => entry.id === c.id), false);
    assert.equal(store.delete(c.id), false, `${name}: a deleted result is gone`);
  }

  {
    // Payloads and listed entries are immutable across both boundaries.
    const store = makeStore();
    const payload = { summary: "finding", nested: { value: "original" } };
    store.add({ shadowId: "s", shadowName: "S", payload, validationSchema: CONTRACT_SCHEMA, createdAt: 1 });
    payload.nested.value = "mutated input";
    const listed = store.list();
    listed[0].payload.nested.value = "mutated output";
    assert.equal(store.list()[0].payload.nested.value, "original", `${name}: payloads are immutable across input and list boundaries`);
  }

  {
    // The count hard cap cannot be raised by callers.
    const store = makeStore({ maxResults: 1_000 });
    for (let index = 0; index < 150; index += 1) addResult(store, index);
    assert.equal(store.list().length, 100, `${name}: the 100-result hard cap holds`);
  }

  {
    // Retention evicts the oldest resolved (read, dismissed, or delivered)
    // entries before unread notified ones.
    const store = makeStore({ maxResults: 3 });
    const old1 = addResult(store, 1);
    addResult(store, 2);
    const old3 = addResult(store, 3);
    store.markRead(old1.id);
    store.dismiss(old3.id);
    const newest = addResult(store, 4);
    const ids = store.list().map((entry) => entry.id);
    assert.ok(ids.includes(newest.id), `${name}: the newest result survives`);
    assert.ok(!ids.includes(old1.id), `${name}: the oldest read result is evicted first`);
    assert.ok(ids.includes(old3.id), `${name}: a newer dismissed result survives over an older read one`);
    assert.equal(store.list().length, 3);
  }

  {
    // Delivery transitions (#159): the confirmed-delivery slice drives
    // `notified → pending → delivered`; degradation returns a pending
    // result inbox-only and never touches a delivered one.
    const store = makeStore();
    const entity = addResult(store, 1, { configuredDelivery: "steer" });
    assert.equal(store.markDelivered(entity.id), false, `${name}: a notified result cannot be confirmed delivered`);
    assert.equal(store.send(entity.id), true);
    assert.equal(store.markDelivered(entity.id), true, `${name}: a pending result confirms delivered`);
    assert.equal(store.markDelivered(entity.id), false, `${name}: confirmation is idempotent-refused`);
    assert.equal(store.list()[0].delivery, "delivered");

    const degraded = addResult(store, 2, { configuredDelivery: "steer" });
    assert.equal(store.send(degraded.id), true);
    assert.equal(store.degradeToNotify(degraded.id), true, `${name}: a never-confirmed pending result returns inbox-only`);
    const view = store.list().find((entry) => entry.id === degraded.id);
    assert.equal(view.delivery, "notified");
    assert.equal(view.configuredDelivery, "notify", `${name}: a degraded result adopts notify policy`);
    assert.equal(store.degradeToNotify(entity.id), false, `${name}: a delivered result never degrades`);
    assert.equal(store.send("missing"), false, `${name}: unknown IDs are refused`);
    assert.equal(store.markDelivered("missing"), false);
    assert.equal(store.degradeToNotify("missing"), false);
  }

  {
    // Reopen recovery: only pending results return inbox-only with notify
    // policy; delivered results stay delivered.
    const store = makeStore();
    const first = addResult(store, 1, { configuredDelivery: "wake" });
    const second = addResult(store, 2, { configuredDelivery: "wake" });
    const third = addResult(store, 3, { configuredDelivery: "wake" });
    assert.equal(store.send(first.id), true);
    assert.equal(store.send(second.id), true);
    assert.equal(store.markDelivered(second.id), true);
    assert.equal(store.recoverPendingDelivery(), 1, `${name}: only the pending result recovers`);
    assert.equal(store.recoverPendingDelivery(), 0, `${name}: recovery is idempotent`);
    const pendingView = store.list().find((entry) => entry.id === first.id);
    assert.equal(pendingView.delivery, "notified");
    assert.equal(pendingView.configuredDelivery, "notify");
    const deliveredView = store.list().find((entry) => entry.id === second.id);
    assert.equal(deliveredView.delivery, "delivered", `${name}: a delivered result stays delivered across recovery`);
    const untouchedView = store.list().find((entry) => entry.id === third.id);
    assert.equal(untouchedView.configuredDelivery, "wake", `${name}: a never-sent result keeps its configured policy`);
  }

  {
    // Forced downgrade of stale-task results: only a still-notified result
    // with a non-notify policy downgrades, and the downgrade is idempotent.
    const store = makeStore();
    const steer = addResult(store, 1, { configuredDelivery: "steer" });
    assert.equal(store.forceNotify(steer.id), true, `${name}: the undelivered result downgrades to notify`);
    assert.equal(store.forceNotify(steer.id), false, `${name}: the downgrade is idempotent`);
    const notify = addResult(store, 2, { configuredDelivery: "notify" });
    assert.equal(store.forceNotify(notify.id), false, `${name}: a notify-configured result needs no downgrade`);
    const delivered = addResult(store, 3, { configuredDelivery: "steer" });
    assert.equal(store.send(delivered.id), true);
    assert.equal(store.markDelivered(delivered.id), true);
    assert.equal(store.forceNotify(delivered.id), false, `${name}: a delivered result never downgrades`);
    assert.equal(store.forceNotify("missing"), false);
  }

  {
    // Transcript-reference declarations (#181): one claim per result, a
    // released claim can be retried, and a referenced result never claims.
    const store = makeStore();
    const entity = addResult(store, 1);
    assert.equal(store.claimReference(entity.id), true, `${name}: the first claim wins`);
    assert.equal(store.claimReference(entity.id), false, `${name}: a held claim blocks a second claim`);
    assert.equal(store.claimReference("shr-unknown"), false, `${name}: an unknown result never claims`);
    store.releaseReferenceClaim(entity.id);
    assert.equal(store.claimReference(entity.id), true, `${name}: a released claim can be retried`);
    assert.equal(store.markReferenced(entity.id), true, `${name}: the successful append persists the referenced mark`);
    assert.equal(store.claimReference(entity.id), false, `${name}: a referenced result is never claimable again`);
    assert.equal(store.markReferenced(entity.id), false, `${name}: the referenced mark is idempotent-refused`);
    assert.equal(store.markReferenced("shr-unknown"), false);
    store.releaseReferenceClaim("shr-unknown");
  }

  {
    // Subscription: single-result delivery/attention transitions fan out;
    // creation, claim bookkeeping, forced downgrades, bulk recovery, and
    // clearing stay silent (their drivers refresh observers around the call).
    const store = makeStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const entity = addResult(store, 1, { configuredDelivery: "steer" });
    assert.equal(notifications, 0, `${name}: creation does not emit`);

    assert.equal(store.claimReference(entity.id), true);
    store.releaseReferenceClaim(entity.id);
    assert.equal(store.markReferenced(entity.id), true);
    assert.equal(store.forceNotify(entity.id), true);
    assert.equal(notifications, 0, `${name}: claim bookkeeping and forced downgrades stay silent`);

    assert.equal(store.markRead(entity.id), true);
    assert.equal(notifications, 1, `${name}: markRead emits`);
    assert.equal(store.dismiss(entity.id), true);
    assert.equal(notifications, 2, `${name}: dismiss emits`);
    assert.equal(store.send(entity.id), true);
    assert.equal(notifications, 3, `${name}: send emits`);
    assert.equal(store.degradeToNotify(entity.id), true);
    assert.equal(notifications, 4, `${name}: degradeToNotify emits`);
    assert.equal(store.send(entity.id), true);
    assert.equal(store.markDelivered(entity.id), true);
    assert.equal(notifications, 6, `${name}: markDelivered emits`);
    assert.equal(store.delete(entity.id), true);
    assert.equal(notifications, 7, `${name}: delete emits`);

    const recovered = addResult(store, 2);
    assert.equal(store.send(recovered.id), true);
    const beforeRecovery = notifications;
    assert.equal(store.recoverPendingDelivery(), 1);
    assert.equal(notifications, beforeRecovery, `${name}: bulk recovery stays silent`);

    unsubscribe();
    const silent = addResult(store, 3);
    assert.equal(store.markRead(silent.id), true);
    assert.equal(notifications, beforeRecovery, `${name}: unsubscribed listeners receive nothing`);

    assert.ok(Array.isArray(store.events()), `${name}: events() always returns an array`);
  }
}

runResultStoreContract("in-memory result store", (options) => createShadowResultStore(options));
runResultStoreContract("persistent result store", (options) => {
  const { sessionDir } = makeSessionRoot();
  return createPersistentShadowResultStore({ sessionDir, sessionId: "sess-1", ...options });
});

// ── Implementation-specific strategy: clearing ──────────────────────

{
  // The in-memory store is session-scoped state: clearing wipes it.
  const store = createShadowResultStore();
  addResult(store, 1);
  store.clear();
  assert.deepEqual(store.list(), [], "the in-memory store wipes on clear");
}

{
  // The persistent partition is the authoritative record: clearing removes
  // nothing and the entities survive to a reopened store.
  const { sessionDir } = makeSessionRoot();
  const store = createPersistentShadowResultStore({ sessionDir, sessionId: "sess-1" });
  const entity = addResult(store, 1);
  store.clear();
  assert.equal(store.list().length, 1, "the persistent store survives clearing");
  const reopened = createPersistentShadowResultStore({ sessionDir, sessionId: "sess-1" });
  assert.equal(reopened.list()[0].id, entity.id, "cleared results still reopen from the partition");
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log("shadow-minds result-store tests: OK");
