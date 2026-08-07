import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  DISPLAY_CATALOG,
  validateCatalog,
  getCatalogEntry,
  catalogFamilyFor,
  catalogToolNames,
  catalogNamesByFamily,
} = await load("../../src/display/catalog.ts");
const {
  DISPLAY_FAMILIES,
  DISPLAY_STATUSES,
  STATUS_FRAMES,
  PENDING_FRAMES,
  PARTIAL_FRAMES,
  SUCCESS_FRAME,
  WARNING_FRAME,
  ERROR_FRAME,
  ABORTED_FRAME,
  DISPLAY_POLICY_FIELDS,
  DEFAULT_DISPLAY_POLICY,
  DEFAULT_DISPLAY_MOTION,
  DISPLAY_PREVIEW_LINES_MIN,
  DISPLAY_PREVIEW_LINES_MAX,
  DISPLAY_EXPANDED_MAX_LINES_MIN,
  DISPLAY_EXPANDED_MAX_LINES_MAX,
  DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN,
  DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX,
  DISPLAY_DIFF_COLLAPSED_LINES_MIN,
  DISPLAY_DIFF_COLLAPSED_LINES_MAX,
  DISPLAY_TOOLS_MAX,
  DISPLAY_TOOL_NAME_REGEX,
  LAYOUT_COMPACT_MAX_COLUMNS,
  LAYOUT_REGULAR_MAX_COLUMNS,
  MOTION_FULL_INTERVAL_MS,
  MOTION_REDUCED_INTERVAL_MS,
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

// ── Catalog validation ───────────────────────────────────────────────

const catalogErrors = validateCatalog();
assert.equal(catalogErrors.length, 0, `catalog validation errors:\n${catalogErrors.join("\n")}`);

// ── Unique names ─────────────────────────────────────────────────────

const allNames = catalogToolNames();
assert.equal(new Set(allNames).size, allNames.length, "catalog tool names must be unique");

// ── Exactly one family per tool ──────────────────────────────────────

for (const name of allNames) {
  const entry = getCatalogEntry(name);
  assert.ok(entry, `getCatalogEntry('${name}') must return its entry`);
  assert.ok(DISPLAY_FAMILIES.includes(entry.family), `family '${entry.family}' for '${name}' must be a known family`);
}

// ── Every family is populated ────────────────────────────────────────

const byFamily = catalogNamesByFamily();
for (const family of DISPLAY_FAMILIES) {
  const names = byFamily.get(family);
  assert.ok(names && names.length > 0, `family '${family}' must have at least one tool`);
}

// ── Exhaustive: all pi-square extension tools + Pi built-ins ────────

const expectedTools = [
  // Pi built-in
  "read", "ls", "edit", "write", "find", "grep",
  // Platform shell
  "bash", "pwsh",
  // pi-square search
  "rg", "fd", "sg", "codegraph", "pdf_search",
  // pi-square remote
  "search", "fetch", "libs", "docs", "parse",
  "github_search", "github_read", "github_tree", "github_commit", "ssh",
  // pi-square execution
  "scheme",
  // pi-square workflow
  "todo", "ask", "time",
  // pi-square agent
  "subagent_delegate", "subagent_resume",
];
for (const name of expectedTools) {
  assert.ok(getCatalogEntry(name), `expected tool '${name}' must be in catalog`);
}
assert.equal(allNames.length, expectedTools.length, `catalog has ${allNames.length} tools, expected ${expectedTools.length}`);

// ── Parent/child availability ────────────────────────────────────────

const parentOnly = allNames.filter((n) => {
  const e = getCatalogEntry(n);
  return e.parent && !e.child;
});
// parse, ssh, todo, ask, time, subagent_delegate, subagent_resume are parent-only
assert.ok(parentOnly.includes("parse"), "parse must be parent-only");
assert.ok(parentOnly.includes("ssh"), "ssh must be parent-only");
assert.ok(parentOnly.includes("todo"), "todo must be parent-only");
assert.ok(parentOnly.includes("ask"), "ask must be parent-only");
assert.ok(parentOnly.includes("time"), "time must be parent-only");
assert.ok(parentOnly.includes("subagent_delegate"), "subagent_delegate must be parent-only");
assert.ok(parentOnly.includes("subagent_resume"), "subagent_resume must be parent-only");
assert.equal(parentOnly.length, 7, `expected 7 parent-only tools, got ${parentOnly.length}`);

// ── Platform shell ownership ─────────────────────────────────────────

const bash = getCatalogEntry("bash");
assert.equal(bash.platformShell, "non-windows", "bash must be non-windows platform shell");
const pwsh = getCatalogEntry("pwsh");
assert.equal(pwsh.platformShell, "windows", "pwsh must be windows platform shell");
const nonShell = allNames.filter((n) => {
  const e = getCatalogEntry(n);
  return e.platformShell !== undefined;
});
assert.deepEqual(nonShell.sort(), ["bash", "pwsh"], "only bash and pwsh have platformShell");

// ── All names match the tool-name pattern ────────────────────────────

for (const name of allNames) {
  assert.ok(DISPLAY_TOOL_NAME_REGEX.test(name), `catalog name '${name}' must match tool-name pattern`);
}

// ── Status frames: exhaustive statuses ───────────────────────────────

assert.equal(DISPLAY_STATUSES.length, 6, "must have exactly 6 statuses");
for (const status of DISPLAY_STATUSES) {
  assert.ok(STATUS_FRAMES[status], `status '${status}' must have frames`);
  assert.ok(STATUS_FRAMES[status].length > 0, `status '${status}' must have at least one frame`);
}

// ── Status frames: non-emoji, single code point, fixed width ────────

const allFrameChars = [
  ...PENDING_FRAMES,
  ...PARTIAL_FRAMES,
  SUCCESS_FRAME,
  WARNING_FRAME,
  ERROR_FRAME,
  ABORTED_FRAME,
];
for (const frame of allFrameChars) {
  const codePoints = Array.from(frame);
  assert.equal(codePoints.length, 1, `frame '${frame}' must be a single code point`);
  assert.equal(visibleWidth(frame), 1, `frame '${frame}' must occupy exactly one terminal cell`);
  // Reject emoji: characters with Emoji property or variation selectors
  assert.ok(!/^\p{Extended_Pictographic}$/u.test(codePoints[0]), `frame '${frame}' must not be pictographic emoji`);
}

// Pending/partial frames have equal length and all are Braille
assert.ok(PENDING_FRAMES.length >= 2, "pending must have multiple frames for animation");
assert.equal(PENDING_FRAMES.length, PARTIAL_FRAMES.length, "pending and partial must have equal frame counts");
for (const f of [...PENDING_FRAMES, ...PARTIAL_FRAMES]) {
  const cp = Array.from(f)[0].codePointAt(0);
  assert.ok(cp >= 0x2800 && cp <= 0x28ff, `spinner frame '${f}' must be a Braille pattern`);
}

// Terminal frames are static single glyphs
assert.equal(SUCCESS_FRAME, "✓");
assert.equal(WARNING_FRAME, "!");
assert.equal(ERROR_FRAME, "×");
assert.equal(ABORTED_FRAME, "–");

// ── Lifecycle frames: exhaustive lifecycles + qualifiers ─────────────

assert.equal(OPERATIONAL_LIFECYCLES.length, 6, "must have exactly 6 lifecycles");
assert.equal(OPERATIONAL_QUALIFIERS.length, 7, "must have exactly 7 qualifiers");
for (const lifecycle of OPERATIONAL_LIFECYCLES) {
  assert.ok(LIFECYCLE_FRAMES[lifecycle], `lifecycle '${lifecycle}' must have frames`);
  assert.ok(LIFECYCLE_FRAMES[lifecycle].length > 0, `lifecycle '${lifecycle}' must have at least one frame`);
}

// Lifecycle markers: non-emoji, single code point, fixed width
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

// Approved marker vocabulary
assert.equal(QUEUED_FRAME, "–");
assert.equal(PENDING_MARKER, "○");
assert.equal(COMPLETED_FRAME, "✓");
assert.equal(COMPLETED_WARNING_FRAME, "!");
assert.equal(FAILED_FRAME, "✗");
assert.equal(ABORTED_MARKER, "×");

// Running frames are animated braille
assert.ok(RUNNING_FRAMES.length >= 2, "running must have multiple frames for animation");
for (const f of RUNNING_FRAMES) {
  const cp = Array.from(f)[0].codePointAt(0);
  assert.ok(cp >= 0x2800 && cp <= 0x28ff, `running frame '${f}' must be a Braille pattern`);
}

// ── Default policy within bounds ─────────────────────────────────────

assert.ok(
  DEFAULT_DISPLAY_POLICY.previewLines >= DISPLAY_PREVIEW_LINES_MIN &&
  DEFAULT_DISPLAY_POLICY.previewLines <= DISPLAY_PREVIEW_LINES_MAX,
  "default previewLines within bounds",
);
assert.ok(
  DEFAULT_DISPLAY_POLICY.expandedMaxLines >= DISPLAY_EXPANDED_MAX_LINES_MIN &&
  DEFAULT_DISPLAY_POLICY.expandedMaxLines <= DISPLAY_EXPANDED_MAX_LINES_MAX,
  "default expandedMaxLines within bounds",
);
assert.ok(
  DEFAULT_DISPLAY_POLICY.diffSplitMinWidth >= DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN &&
  DEFAULT_DISPLAY_POLICY.diffSplitMinWidth <= DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX,
  "default diffSplitMinWidth within bounds",
);
assert.ok(
  DEFAULT_DISPLAY_POLICY.diffCollapsedLines >= DISPLAY_DIFF_COLLAPSED_LINES_MIN &&
  DEFAULT_DISPLAY_POLICY.diffCollapsedLines <= DISPLAY_DIFF_COLLAPSED_LINES_MAX,
  "default diffCollapsedLines within bounds",
);

// ── Default values match plan ────────────────────────────────────────

assert.equal(DEFAULT_DISPLAY_POLICY.resultMode, "preview");
assert.equal(DEFAULT_DISPLAY_POLICY.previewLines, 9);
assert.equal(DEFAULT_DISPLAY_POLICY.expandedMaxLines, 4_000);
assert.equal(DEFAULT_DISPLAY_POLICY.showMetadata, true);
assert.equal(DEFAULT_DISPLAY_POLICY.showDuration, true);
assert.equal(DEFAULT_DISPLAY_POLICY.wordWrap, true);
assert.equal(DEFAULT_DISPLAY_POLICY.diffView, "auto");
assert.equal(DEFAULT_DISPLAY_POLICY.diffSplitMinWidth, 120);
assert.equal(DEFAULT_DISPLAY_POLICY.diffCollapsedLines, 24);
assert.equal(DEFAULT_DISPLAY_POLICY.diffIndicators, "bars");
assert.equal(DEFAULT_DISPLAY_MOTION, "full");

// ── Policy fields exhaustive ─────────────────────────────────────────

assert.equal(DISPLAY_POLICY_FIELDS.length, 10, "must have exactly 10 policy fields");

// ── Constants match plan ─────────────────────────────────────────────

assert.equal(DISPLAY_TOOLS_MAX, 128);
assert.equal(DISPLAY_PREVIEW_LINES_MIN, 1);
assert.equal(DISPLAY_PREVIEW_LINES_MAX, 80);
assert.equal(DISPLAY_EXPANDED_MAX_LINES_MIN, 0);
assert.equal(DISPLAY_EXPANDED_MAX_LINES_MAX, 20_000);
assert.equal(DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN, 70);
assert.equal(DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX, 240);
assert.equal(DISPLAY_DIFF_COLLAPSED_LINES_MIN, 4);
assert.equal(DISPLAY_DIFF_COLLAPSED_LINES_MAX, 240);
assert.equal(LAYOUT_COMPACT_MAX_COLUMNS, 63);
assert.equal(LAYOUT_REGULAR_MAX_COLUMNS, 99);
assert.equal(MOTION_FULL_INTERVAL_MS, 34);
assert.equal(MOTION_REDUCED_INTERVAL_MS, 120);

// ── Six families ─────────────────────────────────────────────────────

assert.equal(DISPLAY_FAMILIES.length, 6);
assert.deepEqual([...DISPLAY_FAMILIES], ["filesystem", "search", "execution", "remote", "workflow", "agent"]);

// ── catalogFamilyFor helper ──────────────────────────────────────────

assert.equal(catalogFamilyFor("rg"), "search");
assert.equal(catalogFamilyFor("bash"), "execution");
assert.equal(catalogFamilyFor("nonexistent"), undefined);

console.log("display catalog tests: OK");
