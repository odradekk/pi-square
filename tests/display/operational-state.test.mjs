import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });

const {
  OPERATIONAL_LIFECYCLES,
  OPERATIONAL_QUALIFIERS,
  LIFECYCLE_FRAMES,
  QUEUED_FRAME,
  PENDING_MARKER,
  RUNNING_FRAMES,
  COMPLETED_FRAME,
  COMPLETED_WARNING_FRAME,
  FAILED_FRAME,
  ABORTED_MARKER,
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

// ─── 2. Lifecycle frames: single-cell, non-emoji ────────────────────

const allLifecycleChars = [
  QUEUED_FRAME, PENDING_MARKER, COMPLETED_FRAME,
  COMPLETED_WARNING_FRAME, FAILED_FRAME, ABORTED_MARKER,
  ...RUNNING_FRAMES,
];
for (const frame of allLifecycleChars) {
  const codePoints = Array.from(frame);
  assert.equal(codePoints.length, 1, `lifecycle frame '${frame}' must be a single code point`);
  assert.equal(visibleWidth(frame), 1, `lifecycle frame '${frame}' must occupy exactly one terminal cell`);
  assert.ok(!/^\p{Extended_Pictographic}$/u.test(codePoints[0]), `lifecycle frame '${frame}' must not be pictographic emoji`);
}

assert.ok(RUNNING_FRAMES.length >= 2, "running must have multiple frames for animation");
for (const f of RUNNING_FRAMES) {
  const cp = Array.from(f)[0].codePointAt(0);
  assert.ok(cp >= 0x2800 && cp <= 0x28ff, `running frame '${f}' must be a Braille pattern`);
}

// Approved marker vocabulary
assert.equal(QUEUED_FRAME, "–");
assert.equal(PENDING_MARKER, "○");
assert.equal(COMPLETED_FRAME, "✓");
assert.equal(COMPLETED_WARNING_FRAME, "!");
assert.equal(FAILED_FRAME, "✗");
assert.equal(ABORTED_MARKER, "×");

// Every lifecycle has frames
for (const lifecycle of OPERATIONAL_LIFECYCLES) {
  assert.ok(LIFECYCLE_FRAMES[lifecycle], `lifecycle '${lifecycle}' must have frames`);
  assert.ok(LIFECYCLE_FRAMES[lifecycle].length > 0, `lifecycle '${lifecycle}' must have at least one frame`);
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
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "running", title: "T" }), "⠋");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "completed", title: "T" }), "✓");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "failed", title: "T" }), "✗");
assert.equal(renderFirstChar({ version: 1, tool: "t", family: "workflow", lifecycle: "aborted", title: "T" }), "×");

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

// ─── 5. Time tool through the production decoration path ─────────────
// Exercises the full queued-to-settled tracer with explicit lifecycle.

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
}

const clock = new FakeClock();
const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
const rawTimeDefinition = {
  name: "time",
  label: "Time",
  description: "Return the current local date and time.",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: "text", text: "2026-01-15 12:00:00\nISO 8601: 2026-01-15T12:00:00+00:00\nTimezone: UTC (UTC+00:00)" }], details: {} };
  },
};
const decorated = decorateInternalTool(rawTimeDefinition, runtime);
assert.equal(decorated.renderShell, "self");

const tracerState = {};
function ctx(overrides = {}) {
  return {
    args: {},
    toolCallId: "call-time-1",
    invalidate() {},
    lastComponent: undefined,
    state: tracerState,
    cwd: process.cwd(),
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

// Queued: arguments incomplete
const queued = decorated.renderCall({}, plainTheme, ctx({ argsComplete: false, executionStarted: false }));
const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
assert.match(queuedText, /^–/, "queued lifecycle must render en-dash");
assert.match(queuedText, /Local time/, "title must be visible");
assert.equal(clock.callbacks.size, 0, "queued must not subscribe to motion");

// Pending: arguments complete, not yet executing
const pending = decorated.renderCall({}, plainTheme, ctx({ argsComplete: true, executionStarted: false, lastComponent: queued }));
const pendingText = stripVTControlCharacters(pending.render(80).join("\n"));
assert.match(pendingText, /^○/, "pending lifecycle must render white circle");
assert.equal(clock.callbacks.size, 0, "pending must not subscribe to motion");

// Running: execution started
const running = decorated.renderCall({}, plainTheme, ctx({ argsComplete: true, executionStarted: true, lastComponent: pending }));
const runningText = stripVTControlCharacters(running.render(80).join("\n"));
assert.match(runningText, /^⠋/, "running lifecycle must render braille");
assert.equal(clock.callbacks.size, 1, "running must subscribe to motion");

// Completed: result settled — replaces the pending entry, not appended
const result = decorated.renderCall({}, plainTheme, ctx({ argsComplete: true, executionStarted: true, lastComponent: running }));
const settled = decorated.renderResult(
  { content: [{ type: "text", text: "2026-01-15 12:00:00\nISO 8601: 2026-01-15T12:00:00+00:00\nTimezone: UTC (UTC+00:00)" }], details: {} },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: result, isError: false }),
);
const settledText = stripVTControlCharacters(settled.render(80).join("\n"));
assert.match(settledText, /^✓/, "completed lifecycle must render check mark");
assert.equal(clock.callbacks.size, 0, "completed must unsubscribe motion");

// One operational entry, not a duplicate
assert.deepEqual(running.render(80), [], "call slot empties when result arrives");
const composedEntry = [...running.render(80), ...settled.render(80)].join("\n");
const titleMatches = (composedEntry.match(/Local time/g) ?? []).length;
assert.equal(titleMatches, 1, "time tool must replace pending entry with one settled entry");

// Time content visible when expanded through the production path
const expandedSettled = decorated.renderResult(
  { content: [{ type: "text", text: "2026-01-15 12:00:00\nISO 8601: 2026-01-15T12:00:00+00:00\nTimezone: UTC (UTC+00:00)" }], details: {} },
  { expanded: true, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: settled, isError: false }),
);
const expandedText = stripVTControlCharacters(expandedSettled.render(80).join("\n"));
assert.match(expandedText, /2026-01-15/);
assert.match(expandedText, /UTC/);

runtime.dispose();

// ─── 6. Width checks for all lifecycle markers at boundary widths ───

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
