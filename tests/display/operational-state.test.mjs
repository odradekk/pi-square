import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });

const {
  OPERATIONAL_LIFECYCLES,
  OPERATIONAL_QUALIFIERS,
  BULLET_MARKER,
  FALLBACK_MARKERS,
  FALLBACK_WARNING_MARKER,
} = await load("../../src/display/types.ts");
const { OperationalDisplayComponent } = await load("../../src/display/components.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateToolDefinition } = await load("../../src/display/tool-renderer.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

// ─── 1. Lifecycle and qualifier type constants ──────────────────────

assert.deepEqual([...OPERATIONAL_LIFECYCLES], [
  "queued", "pending", "running", "completed", "failed", "aborted",
]);
assert.equal(OPERATIONAL_LIFECYCLES.length, 6);

assert.deepEqual([...OPERATIONAL_QUALIFIERS], [
  "warning", "partial", "retrying", "cancelling", "truncated", "projected", "needs-input",
]);
assert.equal(OPERATIONAL_QUALIFIERS.length, 7);

// ─── 2. Single-bullet visual vocabulary: single-cell, non-emoji ────

// Bullet marker
assert.equal(BULLET_MARKER, "●");
assert.equal(visibleWidth(BULLET_MARKER), 1, "BULLET_MARKER must occupy exactly one terminal cell");
assert.ok(!/^\p{Extended_Pictographic}$/u.test(Array.from(BULLET_MARKER)[0]), "BULLET_MARKER must not be pictographic emoji");

// Every fallback marker is one cell and non-pictographic
for (const [lifecycle, marker] of Object.entries(FALLBACK_MARKERS)) {
  const codePoints = Array.from(marker);
  assert.equal(codePoints.length, 1, `fallback marker '${marker}' for '${lifecycle}' must be a single code point`);
  assert.equal(visibleWidth(marker), 1, `fallback marker '${marker}' for '${lifecycle}' must occupy exactly one terminal cell`);
  assert.ok(!/^\p{Extended_Pictographic}$/u.test(codePoints[0]), `fallback marker '${marker}' for '${lifecycle}' must not be pictographic emoji`);
}

// Fallback warning marker
assert.equal(FALLBACK_WARNING_MARKER, "!");
assert.equal(visibleWidth(FALLBACK_WARNING_MARKER), 1, "FALLBACK_WARNING_MARKER must occupy exactly one terminal cell");
assert.ok(!/^\p{Extended_Pictographic}$/u.test(Array.from(FALLBACK_WARNING_MARKER)[0]), "FALLBACK_WARNING_MARKER must not be pictographic emoji");

// Approved fallback marker vocabulary
assert.equal(FALLBACK_MARKERS.queued, "–");
assert.equal(FALLBACK_MARKERS.pending, "○");
assert.equal(FALLBACK_MARKERS.running, "●");
assert.equal(FALLBACK_MARKERS.completed, "✓");
assert.equal(FALLBACK_MARKERS.failed, "×");
assert.equal(FALLBACK_MARKERS.aborted, "·");

// Every lifecycle has a fallback marker
for (const lifecycle of OPERATIONAL_LIFECYCLES) {
  assert.ok(FALLBACK_MARKERS[lifecycle], `lifecycle '${lifecycle}' must have a fallback marker`);
}

// ─── 3. Component renders lifecycle markers ─────────────────────────

function renderFirstChar(description) {
  return stripVTControlCharacters(
    new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(80)[0],
  )[0];
}

// Lifecycle markers
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "queued", title: "T" }), "–");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "pending", title: "T" }), "○");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "running", title: "T" }), "●");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "completed", title: "T" }), "✓");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "failed", title: "T" }), "×");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "aborted", title: "T" }), "·");

// Completed + warning qualifier → "!" override
assert.equal(
  renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "completed", qualifiers: ["warning"], title: "T" }),
  "!",
);

// ─── 4. Qualifier coexistence (not flattened to free text) ───────────

// Completed + warning qualifier renders the distinct "!" marker,
// proving the qualifier is preserved as structured data.
const warningDescription = {
  version: 1,
  tool: "t",
  family: "workflow",
  lifecycle: "completed",
  qualifiers: ["warning"],
  title: "T",
};
assert.equal(renderFirstChar(warningDescription), "!",
  "completed+warning must render ! marker — qualifier preserved as structured data");

// Completed without warning renders the normal ✓ marker.
const cleanDescription = {
  version: 1,
  tool: "t",
  family: "workflow",
  lifecycle: "completed",
  title: "T",
};
assert.equal(renderFirstChar(cleanDescription), "✓",
  "completed without warning must render ✓ marker");

// ─── 5. Width checks for all lifecycle markers at boundary widths ───

const lifecycleDescriptions = OPERATIONAL_LIFECYCLES.map((lifecycle) => ({
  version: 1,
  tool: "t",
  family: "workflow",
  lifecycle,
  title: "Test Tool",
  target: "src/path/to/target.ts",
  metadata: [{ label: "count", value: "42" }],
  rows: [{ text: "summary row text" }],
}));
for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
  for (const description of lifecycleDescriptions) {
    const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(width);
    assert.ok(lines.length > 0, `${description.lifecycle}/${width} rendered empty`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${description.lifecycle}/${width} exceeded width`);
  }
}

console.log("operational state lifecycle tests: OK");
