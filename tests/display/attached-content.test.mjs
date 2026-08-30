import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });

const {
  DEFAULT_DISPLAY_POLICY,
} = await load("../../src/display/types.ts");
const {
  OperationalDisplayComponent,
} = await load("../../src/display/components.ts");
const {
  boundedHeadTailLines,
} = await load("../../src/display/layout.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

// ─── 1. Default policy: preview with 5 body rows ─────────────────────

assert.equal(DEFAULT_DISPLAY_POLICY.resultMode, "preview", "default resultMode must be preview");
assert.equal(DEFAULT_DISPLAY_POLICY.previewLines, 5, "default previewLines must be 5");

// ─── 2. Head/tail preservation: source-line-accurate omission ────────

// Short content: everything fits, no omission.
const short = boundedHeadTailLines("a\nb\nc", 80, 9, true);
assert.equal(short.hiddenSourceLines, 0, "short content has no hidden lines");
assert.equal(short.headLines.length, 3, "short content shows all head lines");
assert.equal(short.tailLines.length, 0, "short content has no tail");

// Long content: head + tail + hidden middle.
const longText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
const long = boundedHeadTailLines(longText, 80, 9, true);
// Budget for content: 9 - 1 (omission) = 8; head = 4, tail = 4
assert.equal(long.hiddenSourceLines, 22, "must hide 22 source lines (30 - 4 head - 4 tail)");
assert.ok(long.headLines.length >= 1, "must have head lines");
assert.ok(long.tailLines.length >= 1, "must have tail lines");
// Head shows first lines, tail shows last lines
assert.match(long.headLines[0], /line 1/, "head starts from beginning");
assert.match(long.tailLines[long.tailLines.length - 1], /line 30/, "tail ends at last line");

// No-wrap mode: truncates each line with …
const wide = boundedHeadTailLines("short line\nanother line", 10, 9, false);
assert.equal(wide.hiddenSourceLines, 0, "no hidden lines when content fits");
assert.equal(wide.headLines.length, 2, "both lines shown");
assert.ok(
  wide.headLines.some((l) => l.includes("\u2026")),
  "no-wrap mode must truncate with ellipsis character",
);

// No-wrap mode with long content: head + tail
const longNoWrap = boundedHeadTailLines(
  Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n"),
  80,
  5,
  false,
);
assert.equal(longNoWrap.hiddenSourceLines, 16, "must hide 16 source lines (20 - 2 head - 2 tail)");
assert.equal(longNoWrap.headLines.length, 2, "head gets ceil(4/2)=2");
assert.equal(longNoWrap.tailLines.length, 2, "tail gets floor(4/2)=2");

// ─── 3. BoundedPreview renders head + tail with omission text ────────

const { BoundedPreview } = await load("../../src/display/components.ts");
const previewText = Array.from({ length: 30 }, (_, i) => `content line ${i + 1}`).join("\n");
const preview = new BoundedPreview(previewText, 9, plainTheme, 0, true);
const previewLines = preview.render(80);
// Should produce head lines + omission + tail lines
const plain = previewLines.map((l) => stripVTControlCharacters(l));
assert.ok(plain.some((l) => /⋯ \+\d+ lines/.test(l)), "must show the ⋯ +N lines omission count row");
assert.ok(plain.some((l) => /content line 1/.test(l)), "head must include first line");
assert.ok(plain.some((l) => /content line 30/.test(l)), "tail must include last line");

// ─── 4. Quiet body indentation ──────────────────────────────────────

const description = {
  version: 1,
  tool: "read",
  family: "filesystem",
  lifecycle: "completed",
  title: "READ",
  target: "src/index.ts",
  summary: "3 lines",
  preview: { text: "line one\nline two\nline three" },
};
const component = new OperationalDisplayComponent(
  description,
  DEFAULT_DISPLAY_POLICY,
  plainTheme,
  { expanded: true },
);
const rendered = component.render(80);
assert.ok(rendered.length > 1, "must render header + body when expanded");
const plainRendered = rendered.map((l) => stripVTControlCharacters(l));

// First line is the header (starts with marker)
assert.match(plainRendered[0], /^✓/);

// Body lines carry the quiet two-cell indent; no tree rails render.
const bodyLines = plainRendered.slice(1);
assert.ok(bodyLines.length > 0, "must have body lines");
for (const line of bodyLines) {
  assert.match(line, /^ {2}/, "every body line carries the quiet two-cell indent");
  assert.doesNotMatch(line, /^[│└├]/, "no tree rail prefixes render");
}

// No body content → no tree rails
const noBody = new OperationalDisplayComponent(
  { version: 1, tool: "read", family: "filesystem", lifecycle: "completed", title: "READ" },
  DEFAULT_DISPLAY_POLICY,
  plainTheme,
  { expanded: false },
);
const noBodyLines = noBody.render(80);
assert.equal(noBodyLines.length, 1, "no body content means header only");
assert.doesNotMatch(stripVTControlCharacters(noBodyLines[0]), /[│└├]/, "header line carries no rail glyphs");

// ─── 5. Width bounds at all breakpoints ─────────────────────────────

const widths = [39, 40, 63, 64, 80, 99, 100, 120];
const states = ["pending", "partial", "success", "warning", "error", "aborted"];
const stateMap = {
  pending: { lifecycle: "running" },
  partial: { lifecycle: "running", qualifiers: ["partial"] },
  success: { lifecycle: "completed" },
  warning: { lifecycle: "completed", qualifiers: ["warning"] },
  error: { lifecycle: "failed" },
  aborted: { lifecycle: "aborted" },
};
for (const status of states) {
  const desc = {
    version: 1,
    tool: "read",
    family: "filesystem",
    ...stateMap[status],
    title: "READ",
    target: "src/index.ts",
    metadata: [{ label: "offset", value: "1" }, { label: "limit", value: "50" }],
    preview: { text: "preview content line one\npreview content line two" },
    error: status === "error" ? "File not found" : undefined,
  };
  for (const width of widths) {
    for (const wordWrap of [true, false]) {
      const policy = { ...DEFAULT_DISPLAY_POLICY, wordWrap };
      const lines = new OperationalDisplayComponent(desc, policy, plainTheme, { expanded: false }).render(width);
      assert.ok(lines.every((l) => visibleWidth(l) <= width), `${status}/${width}/wrap=${wordWrap} exceeded width`);
    }
  }
}

// ─── 6. Hidden policy never suppresses errors ────────────────────────

const hiddenPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "hidden" };
const errorDesc = {
  version: 1,
  tool: "read",
  family: "filesystem",
  lifecycle: "failed",
  title: "READ",
  error: "Permission denied",
};
const hiddenRender = new OperationalDisplayComponent(errorDesc, hiddenPolicy, plainTheme, { expanded: false }).render(80);
const hiddenPlain = stripVTControlCharacters(hiddenRender.join("\n"));
assert.match(hiddenPlain, /Permission denied/, "errors must remain visible under hidden policy");
assert.match(hiddenPlain, /^×/, "failed lifecycle must show × marker");

// ─── 7. Read tool through the production decoration path ─────────────

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
}

const clock = new FakeClock();
const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });

// Create a Read definition similar to what Pi provides.
const rawReadDefinition = {
  name: "read",
  label: "Read",
  description: "Read the contents of a file.",
  parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
  async execute() {
    return {
      content: [{ type: "text", text: "file content here\nsecond line\nthird line" }],
      details: {},
    };
  },
};
const decorated = decorateBuiltinDefinition(rawReadDefinition, process.cwd(), runtime);
assert.equal(decorated.renderShell, "self");

const tracerState = {};
function ctx(overrides = {}) {
  return {
    args: { path: "src/index.ts" },
    toolCallId: "call-read-1",
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
const queued = decorated.renderCall({ path: "src/index.ts" }, plainTheme, ctx({ argsComplete: false, executionStarted: false }));
const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
assert.match(queuedText, /^●/, "queued must render en-dash");
assert.equal(clock.callbacks.size, 0, "queued must not subscribe to motion");

// Pending: arguments complete
const pending = decorated.renderCall({ path: "src/index.ts" }, plainTheme, ctx({ argsComplete: true, executionStarted: false, lastComponent: queued }));
assert.match(
  stripVTControlCharacters(pending.render(80).join("\n")),
  /^●/,
  "pending must render circle",
);

// Running: execution started
const running = decorated.renderCall({ path: "src/index.ts" }, plainTheme, ctx({ argsComplete: true, executionStarted: true, lastComponent: pending }));
assert.match(
  stripVTControlCharacters(running.render(80).join("\n")),
  /^●/,
  "running must render braille",
);
assert.equal(clock.callbacks.size, 1, "running subscribes motion");

// Completed: result settled — replaces pending entry
const callForResult = decorated.renderCall({ path: "src/index.ts" }, plainTheme, ctx({ argsComplete: true, executionStarted: true, lastComponent: running }));
const settled = decorated.renderResult(
  { content: [{ type: "text", text: "file content here\nsecond line\nthird line" }], details: {} },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: callForResult, isError: false }),
);
const settledText = stripVTControlCharacters(settled.render(80).join("\n"));
assert.match(settledText, /^●/, "completed must render bullet");
assert.equal(clock.callbacks.size, 0, "completed unsubscribes motion");

// Content reachable in expanded mode (collapsed shows a summary row per C4)
const settledExpanded = decorated.renderResult(
  { content: [{ type: "text", text: "file content here\nsecond line\nthird line" }], details: {} },
  { expanded: true, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: callForResult, isError: false, expanded: true }),
);
const settledExpandedText = stripVTControlCharacters(settledExpanded.render(80).join("\n"));
assert.match(settledExpandedText, /file content here/, "read content must be visible in expanded mode");

// Partial result keeps running lifecycle (not completed)
const partial = decorated.renderResult(
  { content: [{ type: "text", text: "partial content" }], details: {} },
  { expanded: false, isPartial: true },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: settled, isPartial: true }),
);
const partialText = stripVTControlCharacters(partial.render(80).join("\n"));
assert.match(partialText, /^●/, "partial result must render running braille, not completed checkmark");
assert.equal(clock.callbacks.size, 1, "partial result must keep motion subscription");

// Result replaces pending entry
assert.deepEqual(running.render(80), [], "call slot empties when result arrives");
const composed = [...running.render(80), ...settled.render(80)].join("\n");
assert.equal((composed.match(/Read/g) ?? []).length, 1, "must have exactly one operational entry");

// Expanded result shows structured sections
const expanded = decorated.renderResult(
  { content: [{ type: "text", text: "expanded content\nmore content" }], details: {} },
  { expanded: true, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: settled, isError: false }),
);
const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
assert.match(expandedText, /expanded content/, "expanded must show content");
assert.ok(visibleWidth(expandedText.split("\n")[0]) <= 80, "expanded header within width");

// Error result
const errored = decorated.renderResult(
  { content: [{ type: "text", text: "File not found" }], details: {} },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, lastComponent: expanded, isError: true }),
);
const errorText = stripVTControlCharacters(errored.render(80).join("\n"));
assert.match(errorText, /^●/, "error must render bullet");

runtime.dispose();

// ─── 8. Image reads: no text preview, no attached body ───────────────

const imageRuntime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
const decoratedImage = decorateBuiltinDefinition(rawReadDefinition, process.cwd(), imageRuntime);
const imageResult = decoratedImage.renderResult(
  { content: [{ type: "image", data: "base64data", mediaType: "image/png" }], details: {} },
  { expanded: false, isPartial: false },
  plainTheme,
  ctx({ argsComplete: true, executionStarted: true, isError: false }),
);
const imageText = stripVTControlCharacters(imageResult.render(80).join("\n"));
assert.match(imageText, /^●/, "image read must still render completed marker");
// No text content to preview — header only
assert.ok(!imageText.includes("base64data"), "must not leak image data as text");
imageRuntime.dispose();

// ─── 9. No-wrap mode truncates with … ────────────────────────────────

const noWrapPolicy = { ...DEFAULT_DISPLAY_POLICY, wordWrap: false };
const wideText = "this is a very long line that exceeds the available width for sure definitely";
const noWrapDesc = {
  version: 1,
  tool: "read",
  family: "filesystem",
  lifecycle: "completed",
  title: "READ",
  preview: { text: wideText },
};
const noWrapLines = new OperationalDisplayComponent(noWrapDesc, noWrapPolicy, plainTheme, { expanded: true }).render(40);
const noWrapPlain = noWrapLines.map((l) => stripVTControlCharacters(l));
assert.ok(
  noWrapPlain.slice(1).some((l) => l.includes("\u2026")),
  "no-wrap mode must truncate long lines with ellipsis character",
);
assert.ok(
  noWrapLines.every((l) => visibleWidth(l) <= 40),
  "all lines must be within width bounds",
);

console.log("attached content (Read) tests: OK");
