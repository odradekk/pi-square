import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  layoutTier,
  padVisible,
  wrapHanging,
  rightPriorityRows,
  boundedVisualLines,
  assertBoundedLines,
} = await load("../../src/display/layout.ts");

assert.equal(layoutTier(39), "compact");
assert.equal(layoutTier(63), "compact");
assert.equal(layoutTier(64), "regular");
assert.equal(layoutTier(99), "regular");
assert.equal(layoutTier(100), "wide");

for (const width of [1, 39, 40, 63, 64, 80, 99, 100, 120]) {
  const padded = padVisible("alpha", width);
  assert.equal(visibleWidth(padded), width);
  const hanging = wrapHanging("  key=", "a long value ".repeat(20), width);
  assert.ok(assertBoundedLines(hanging, width));
  assert.ok(hanging.length >= 1);
  const row = rightPriorityRows("left value ".repeat(8), "right", width);
  assert.ok(assertBoundedLines(row, width));
  assert.ok(row.some((line) => line.includes("right")) || width < 5);
}

const inline = rightPriorityRows("left", "right", 20);
assert.equal(inline.length, 1);
assert.equal(visibleWidth(inline[0]), 20);
const stacked = rightPriorityRows("left side that does not fit", "right", 16);
assert.ok(stacked.length > 1);
assert.match(stacked.at(-1), /right/);

const bounded = boundedVisualLines("one\ntwo\nthree\nfour", 20, 2);
assert.equal(bounded.lines.length, 2);
assert.equal(bounded.omitted, 2);
const tail = boundedVisualLines("one\ntwo\nthree\nfour", 20, 2, "tail");
assert.match(tail.lines[0], /three/);
assert.equal(tail.omitted, 2);

console.log("display layout tests: OK");
