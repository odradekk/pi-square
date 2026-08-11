import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

// padVisible truncates only when the line does not fit. The fast path must
// stay byte-identical to the former unconditional truncation for every
// content category the operational component renders.
const padVisibleUnconditional = (line, width) => {
  const safe = Math.max(1, Math.floor(width));
  const truncated = truncateToWidth(line, safe, "\u2026");
  return truncated + " ".repeat(Math.max(0, safe - visibleWidth(truncated)));
};

const padCategories = [
  ["plain", "40 lines \u00b7 3.2 KB"],
  ["ansi", "\u001b[38;2;222;225;227mexit 0 \u00b7 40 lines\u001b[39m"],
  ["tree-rail", "\u2502  \u001b[38;2;152;160;164mnpm warn deprecated\u001b[39m"],
  ["tree-rail-last", "\u2514\u2500 \u001b[38;2;152;160;164m40 lines\u001b[39m"],
  ["cjk-wide", "\u691c\u7d22\u7d50\u679c \u30d5\u30a1\u30a4\u30eb\u540d"],
  ["cjk-wide-ansi", "\u2502  \u001b[38;2;222;225;227m\u691c\u7d22\u7d50\u679c\u001b[39m"],
  ["empty", ""],
  ["over-width-plain", "long output line ".repeat(20)],
  ["over-width-ansi", `\u001b[38;2;222;225;227m${"long output line ".repeat(20)}\u001b[39m`],
  ["over-width-tree-rail", `\u2502  \u001b[38;2;152;160;164m${"deprecated package ".repeat(20)}\u001b[39m`],
  ["over-width-cjk", "\u691c\u7d22\u7d50\u679c".repeat(40)],
];

for (const [label, line] of padCategories) {
  const own = visibleWidth(line);
  // The exact-fit boundary (own width, one cell below, one cell above) is the
  // interesting case for a conditional truncation.
  const widths = new Set([1, 2, 5, 39, 40, 63, 64, 80, 99, 100, 120, own - 1, own, own + 1]);
  for (const width of [...widths].filter((value) => value >= 1)) {
    const padded = padVisible(line, width);
    assert.equal(
      padded,
      padVisibleUnconditional(line, width),
      `padVisible fast path differs from unconditional truncation: ${label} at width ${width}`,
    );
    assert.equal(visibleWidth(padded), width, `padded width for ${label} at width ${width}`);
  }
}

// A line that fits is returned unchanged apart from the padding, so the
// helper never rewrites the ANSI codes of content that already fits.
assert.equal(padVisible("\u001b[31mred\u001b[39m", 10), "\u001b[31mred\u001b[39m       ");

const bounded = boundedVisualLines("one\ntwo\nthree\nfour", 20, 2);
assert.equal(bounded.lines.length, 2);
assert.equal(bounded.omitted, 2);
const tail = boundedVisualLines("one\ntwo\nthree\nfour", 20, 2, "tail");
assert.match(tail.lines[0], /three/);
assert.equal(tail.omitted, 2);

console.log("display layout tests: OK");
