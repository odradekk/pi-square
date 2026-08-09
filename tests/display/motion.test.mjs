import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MotionScheduler, effectiveMotion } = await load("../../src/display/motion.ts");

class FakeClock {
  handles = new Map();
  next = 1;
  intervals = [];
  setInterval = (callback, milliseconds) => {
    const id = this.next++;
    this.handles.set(id, callback);
    this.intervals.push(milliseconds);
    return id;
  };
  clearInterval = (handle) => { this.handles.delete(handle); };
  unref = () => {};
  tick() { for (const callback of [...this.handles.values()]) callback(); }
}

assert.equal(effectiveMotion("full", { isTTY: true }), "full");
assert.equal(effectiveMotion("reduced", { isTTY: true }), "reduced");
assert.equal(effectiveMotion("full", { isTTY: false }), "off");
assert.equal(effectiveMotion("full", { isTTY: true, term: "dumb" }), "off");
assert.equal(effectiveMotion("full", { isTTY: true, ci: true }), "off");
assert.equal(effectiveMotion("reduced", { isTTY: true, test: true }), "off");

const clock = new FakeClock();
const scheduler = new MotionScheduler("full", clock);
let first = 0;
let second = 0;
const stopFirst = scheduler.subscribe(() => { first += 1; });
const stopSecond = scheduler.subscribe(() => { second += 1; });
assert.equal(clock.handles.size, 1, "all subscribers share one timer");
assert.deepEqual(clock.intervals, [120], "full motion uses 120 ms interval");
clock.tick();
assert.equal(first, 1);
assert.equal(second, 1);

scheduler.setMode("reduced");
assert.equal(clock.handles.size, 1);
assert.equal(clock.intervals.at(-1), 1000, "reduced motion uses 1000 ms interval");
clock.tick();
assert.equal(first, 2);

stopFirst();
assert.equal(scheduler.subscriberCount, 1);
stopSecond();
assert.equal(clock.handles.size, 0, "last unsubscribe removes timer");

const stopThird = scheduler.subscribe(() => { first += 1; });
scheduler.setMode("off");
assert.equal(clock.handles.size, 0);
clock.tick();
assert.equal(first, 2);
stopThird();
scheduler.dispose();
assert.equal(scheduler.subscriberCount, 0);

const failureClock = new FakeClock();
const failureScheduler = new MotionScheduler("full", failureClock);
let healthy = 0;
failureScheduler.subscribe(() => { throw new Error("broken invalidator"); });
failureScheduler.subscribe(() => { healthy += 1; });
failureClock.tick();
assert.equal(healthy, 1, "a failed subscriber cannot block healthy invalidators");
assert.equal(failureScheduler.subscriberCount, 1, "failed subscriber is removed");
failureClock.tick();
assert.equal(healthy, 2);
failureScheduler.dispose();

// Idempotent disposal: calling dispose multiple times is safe.
const idempotentClock = new FakeClock();
const idempotentScheduler = new MotionScheduler("full", idempotentClock);
let idempotentCount = 0;
const stopIdempotent = idempotentScheduler.subscribe(() => { idempotentCount += 1; });
assert.equal(idempotentClock.handles.size, 1, "timer created on first subscriber");
idempotentScheduler.dispose();
idempotentScheduler.dispose();
assert.equal(idempotentScheduler.subscriberCount, 0, "no subscribers after disposal");
assert.equal(idempotentClock.handles.size, 0, "timer removed after disposal");
stopIdempotent();
idempotentClock.tick();
assert.equal(idempotentCount, 0, "no updates after disposal");

// No updates after shutdown: disposed scheduler has no active timer.
const shutdownClock = new FakeClock();
const shutdownScheduler = new MotionScheduler("full", shutdownClock);
let shutdownCount = 0;
shutdownScheduler.subscribe(() => { shutdownCount += 1; });
assert.equal(shutdownClock.handles.size, 1);
shutdownScheduler.dispose();
assert.equal(shutdownClock.handles.size, 0, "timer removed after disposal");
shutdownClock.tick();
assert.equal(shutdownCount, 0, "no callbacks fired after disposal");

console.log("display motion tests: OK");
