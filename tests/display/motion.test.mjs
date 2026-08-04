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
assert.deepEqual(clock.intervals, [200], "full motion is capped at 5 FPS");
clock.tick();
assert.equal(first, 1);
assert.equal(second, 1);

scheduler.setMode("reduced");
assert.equal(clock.handles.size, 1);
assert.equal(clock.intervals.at(-1), 1000, "reduced motion is 1 FPS");
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

console.log("display motion tests: OK");
