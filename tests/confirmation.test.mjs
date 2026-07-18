import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { ConfirmationCoordinator } = await load("../src/core/confirmation.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

{
  const coordinator = new ConfirmationCoordinator();
  const firstResult = deferred();
  const order = [];
  let active = 0;
  let maximumActive = 0;
  const run = (name, result) => coordinator.run(undefined, async () => {
    order.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      return await result;
    } finally {
      active -= 1;
    }
  });

  const first = run("first", firstResult.promise);
  const second = run("second", Promise.resolve(true));
  assert.deepEqual(order, ["first"]);
  firstResult.resolve(false);
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(maximumActive, 1);
}

{
  const coordinator = new ConfirmationCoordinator();
  const firstResult = deferred();
  const queuedAbort = new AbortController();
  let queuedRan = false;
  const first = coordinator.run(undefined, async () => await firstResult.promise);
  const queued = coordinator.run(queuedAbort.signal, async () => {
    queuedRan = true;
    return true;
  });
  queuedAbort.abort("cancel queued confirmation");
  assert.equal(await queued, false);
  assert.equal(queuedRan, false);
  firstResult.resolve(true);
  assert.equal(await first, true);
}

{
  const coordinator = new ConfirmationCoordinator();
  let queuedRan = false;
  const active = coordinator.run(undefined, async (signal) => await new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  }));
  const queued = coordinator.run(undefined, async () => {
    queuedRan = true;
    return true;
  });
  coordinator.reset("session changed");
  assert.deepEqual(await Promise.all([active, queued]), [false, false]);
  assert.equal(queuedRan, false);
}

{
  const coordinator = new ConfirmationCoordinator();
  const failed = coordinator.run(undefined, () => {
    throw new Error("confirmation failed");
  });
  const next = coordinator.run(undefined, async () => true);
  await assert.rejects(failed, /confirmation failed/);
  assert.equal(await next, true);
  await nextTurn();
}

console.log("confirmation coordinator tests: OK");
