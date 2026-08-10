import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });

const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");
const { renderDisplayDiffLines } = await load("../../src/display/diff.ts");
const { OperationalDisplayComponent } = await load("../../src/display/components.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

// ─── 1. Default diffView is unified ──────────────────────────────────

assert.equal(DEFAULT_DISPLAY_POLICY.diffView, "unified", "default diffView must be unified");
assert.ok(!("diffIndicators" in DEFAULT_DISPLAY_POLICY), "diffIndicators removed from policy");

// ─── 2. Unified diff: line numbers, markers, change-count header ─────

const patch = [
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -1,3 +1,4 @@",
  " alpha",
  "-beta",
  "+BETA",
  " gamma",
  "+delta",
].join("\n");

const unified = renderDisplayDiffLines(
  { path: "src/file.ts", patch },
  DEFAULT_DISPLAY_POLICY,
  plainTheme,
  100,
  { expanded: true },
);
const unifiedText = unified.join("\n");

// No change-count header in the diff body (moved to the summary row)
assert.doesNotMatch(unifiedText, /\(\+2, -1\)/, "no (+N, -M) change-count header in diff body");

// Right-aligned dim line numbers (1-digit)
assert.match(unifiedText, /^\s*1/gm, "line numbers present");

// Markers: + for added, - for removed
assert.match(unifiedText, /-/, "removed marker present");
assert.match(unifiedText, /\+/, "added marker present");

// Content visible
assert.match(unifiedText, /alpha/, "context line visible");
assert.match(unifiedText, /beta/, "removed content visible");
assert.match(unifiedText, /BETA/, "added content visible");
assert.match(unifiedText, /delta/, "added content visible");

// No PROJECTED marker for authoritative diffs
assert.doesNotMatch(unifiedText, /PROJECTED/, "authoritative diff has no PROJECTED label");

// ─── 3. Collapsed diff protects metadata and reports omitted rows ───

const longPatch = [
  "--- a/big.ts",
  "+++ b/big.ts",
  "@@ -1,20 +1,20 @@",
  ...Array.from({ length: 20 }, (_, i) => ` line${i}`),
  ...Array.from({ length: 20 }, (_, i) => i % 2 === 0 ? `-old${i}` : `+new${i}`),
].join("\n");

const collapsed = renderDisplayDiffLines(
  { path: "big.ts", patch: longPatch },
  { ...DEFAULT_DISPLAY_POLICY, previewLines: 5 },
  plainTheme,
  80,
  { expanded: false },
);
const collapsedText = collapsed.join("\n");
assert.match(collapsedText, /\u2026 \+\d+ diff lines/, "collapsed must report omitted diff lines");
assert.ok(collapsed.length <= 6, "collapsed bounded by previewLines + omission marker");

// Expanded shows everything
const expandedDiff = renderDisplayDiffLines(
  { path: "big.ts", patch: longPatch },
  DEFAULT_DISPLAY_POLICY,
  plainTheme,
  80,
  { expanded: true },
);
assert.ok(expandedDiff.length > collapsed.length, "expanded shows more than collapsed");

// ─── 4. Split mode remains explicit non-default ──────────────────────

const split = renderDisplayDiffLines(
  { path: "src/file.ts", patch },
  { ...DEFAULT_DISPLAY_POLICY, diffView: "split" },
  plainTheme,
  120,
  { expanded: true },
);
const splitText = split.join("\n");
assert.match(splitText, /│/, "split mode uses divider");
assert.match(splitText, /beta/, "split shows removed content");
assert.match(splitText, /BETA/, "split shows added content");

// Auto mode resolves to width-dependent layout
const autoNarrow = renderDisplayDiffLines(
  { path: "src/file.ts", patch },
  { ...DEFAULT_DISPLAY_POLICY, diffView: "auto" },
  plainTheme,
  60,
  { expanded: true },
);
const autoWide = renderDisplayDiffLines(
  { path: "src/file.ts", patch },
  { ...DEFAULT_DISPLAY_POLICY, diffView: "auto", diffSplitMinWidth: 100 },
  plainTheme,
  120,
  { expanded: true },
);
assert.doesNotMatch(autoNarrow.join("\n"), /│/, "auto narrow uses unified (no divider)");
assert.match(autoWide.join("\n"), /│/, "auto wide uses split (has divider)");

// ─── 5. Bounded at all widths ────────────────────────────────────────

const widths = [39, 40, 63, 64, 80, 99, 100, 120];
for (const width of widths) {
  for (const diffView of ["unified", "split", "auto"]) {
    const policy = { ...DEFAULT_DISPLAY_POLICY, diffView };
    const lines = renderDisplayDiffLines(
      { path: "src/file.ts", patch },
      policy,
      plainTheme,
      width,
      { expanded: true },
    );
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `${diffView}/${width} exceeded width`,
    );
  }
}

// ─── 6. Edit through production decoration path ──────────────────────

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
}

const clock = new FakeClock();
const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });

const rawEditDefinition = {
  name: "edit",
  label: "Edit",
  description: "Edit a file.",
  parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: "text", text: "Applied" }], details: {} };
  },
};
const decorated = decorateBuiltinDefinition(rawEditDefinition, process.cwd(), runtime);
assert.equal(decorated.renderShell, "self", "edit uses self render shell");

const tracerState = {};
function ctx(overrides = {}) {
  return {
    args: { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
    toolCallId: "edit-call-1",
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

// Lifecycle: queued → pending → running → completed
const queued = decorated.renderCall(
  { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
  plainTheme,
  ctx({ argsComplete: false, executionStarted: false }),
);
assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");
assert.equal(clock.callbacks.size, 0, "queued no motion");

const pending = decorated.renderCall(
  { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: false, lastComponent: queued }),
);
assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

const running = decorated.renderCall(
  { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: pending }),
);
assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille");
assert.equal(clock.callbacks.size, 1, "running subscribes motion");

// Completed with authoritative diff
const editResult = decorated.renderResult(
  {
    content: [{ type: "text", text: "Applied edit" }],
    details: {
      patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-foo\n+bar\n",
      firstChangedLine: 1,
    },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
);
const editResultText = stripVTControlCharacters(editResult.render(80).join("\n"));
assert.match(editResultText, /^●/, "completed renders bullet");
assert.equal(clock.callbacks.size, 0, "completed unsubscribes motion");
assert.match(editResultText, /\+1 −1/, "change counts in summary row");
assert.doesNotMatch(editResultText, /@@/, "no @@ hunk header");
assert.match(editResultText, /foo/, "removed content visible");
assert.match(editResultText, /bar/, "added content visible");
assert.doesNotMatch(editResultText, /PROJECTED/, "edit diff is authoritative, not projected");

// Result replaces pending call
assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

// Error result renders failed marker
const errorResult = decorated.renderResult(
  {
    content: [{ type: "text", text: "File not found" }],
    isError: true,
    details: {},
  },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: editResult, isError: true }),
);
assert.match(stripVTControlCharacters(errorResult.render(80).join("\n")), /^●/, "error renders bullet");

runtime.dispose();

// ─── 7. Edit diff at all widths through production component ─────────

const editDesc = {
  version: 1,
  tool: "edit",
  family: "filesystem",
  lifecycle: "completed",
  title: "EDIT",
  target: "src/index.ts",
  diff: {
    path: "src/index.ts",
    patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,3 @@\n line1\n-old value\n+new value\n line3\n",
  },
};
for (const width of widths) {
  const lines = new OperationalDisplayComponent(editDesc, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `edit diff bounded at ${width}`);
}

// ─── 8. Model-facing execute unchanged ───────────────────────────────

const execResult = await decorated.execute("call-1", { path: "test.txt", edits: [] }, undefined, undefined);
assert.ok(Array.isArray(execResult.content), "execute returns content array");

console.log("edit diff tests: OK");
