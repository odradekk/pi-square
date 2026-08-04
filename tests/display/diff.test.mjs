import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { renderDisplayDiffLines, DisplayDiffComponent } = await load("../../src/display/diff.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  inverse(text) { return String(text); },
};
const description = {
  path: "src/file.ts",
  before: "alpha\r\nbeta\r\ngamma\r\n",
  after: "alpha\r\nBETA\r\ngamma\r\ndelta\r\n",
  projected: true,
};

for (const width of [39, 40, 63, 64, 80, 99, 100, 119, 120, 121]) {
  const lines = renderDisplayDiffLines(description, DEFAULT_DISPLAY_POLICY, plainTheme, width, { expanded: false });
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `diff exceeded width ${width}`);
  assert.match(lines.join("\n"), /PROJECTED PREVIEW/);
  assert.match(lines.join("\n"), /BETA|delta/);
}

const unified = renderDisplayDiffLines(
  description,
  { ...DEFAULT_DISPLAY_POLICY, diffView: "unified", diffIndicators: "classic" },
  plainTheme,
  120,
  { expanded: true },
).join("\n");
assert.match(unified, /- beta|\+ BETA/);

const split = renderDisplayDiffLines(
  description,
  { ...DEFAULT_DISPLAY_POLICY, diffView: "split" },
  plainTheme,
  80,
  { expanded: true },
).join("\n");
assert.match(split, /│/);
assert.match(split, /beta/);
assert.match(split, /BETA/);

const authoritativePatch = [
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -1,2 +1,2 @@",
  "-old value",
  "+new value",
  " context",
].join("\n");
for (const diffView of ["unified", "split"]) {
  const lines = renderDisplayDiffLines(
    { path: "src/file.ts", patch: authoritativePatch },
    { ...DEFAULT_DISPLAY_POLICY, diffView },
    plainTheme,
    120,
    { expanded: true },
  );
  assert.match(lines.join("\n"), /old value/);
  assert.match(lines.join("\n"), /new value/);
  assert.doesNotMatch(lines.join("\n"), /PROJECTED/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
}

const bounded = renderDisplayDiffLines(
  { path: "many", before: Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n"), after: "new" },
  { ...DEFAULT_DISPLAY_POLICY, diffView: "unified", diffCollapsedLines: 4 },
  plainTheme,
  80,
  { expanded: false },
);
assert.ok(bounded.length <= 5);
assert.match(bounded.at(-1), /omitted/);

const oversized = renderDisplayDiffLines(
  { path: "large", before: "x".repeat(1_000_001), after: "y" },
  DEFAULT_DISPLAY_POLICY,
  plainTheme,
  80,
  { expanded: true },
);
assert.match(oversized.join("\n"), /exceeds 1 MB/);
assert.ok(oversized.every((line) => visibleWidth(line) <= 80));

function markerTheme(marker) {
  return {
    fg(token, text) { return `<${marker}:${token}>${text}</${marker}>`; },
    inverse(text) { return `<${marker}:inverse>${text}</${marker}>`; },
  };
}
const themedA = renderDisplayDiffLines(description, DEFAULT_DISPLAY_POLICY, markerTheme("A"), 120, { expanded: true }).join("\n");
const themedB = renderDisplayDiffLines(description, DEFAULT_DISPLAY_POLICY, markerTheme("B"), 120, { expanded: true }).join("\n");
assert.match(themedA, /<A:toolDiff/);
assert.doesNotMatch(themedA, /<B:/);
assert.match(themedB, /<B:toolDiff/);
assert.doesNotMatch(themedB, /<A:/);

const component = new DisplayDiffComponent(description, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false });
assert.ok(component.render(80).length > 0);
component.update({ ...description, projected: false }, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: true });
assert.doesNotMatch(component.render(80).join("\n"), /PROJECTED/);

console.log("display diff tests: OK");
