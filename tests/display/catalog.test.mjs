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
  RUNNING_PULSE_PERIOD_MS,
  OPERATIONAL_LIFECYCLES,
  OPERATIONAL_QUALIFIERS,
  BULLET_MARKER,
  FALLBACK_MARKERS,
  FALLBACK_WARNING_MARKER,
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
  "read", "ls", "edit", "replace", "write", "find", "grep",
  // Platform shell
  "bash", "pwsh",
  // pi-square search
  "pdf_search",
  // pi-square remote
  "search", "fetch", "libs", "docs", "parse",
  "ssh",
  // pi-square workflow
  "todo", "ask",
  // pi-square agent
  "delegate_subagent", "resume_subagent", "wait_subagent",
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
// parse, replace, ssh, todo, ask, delegate_subagent, resume_subagent, wait_subagent are parent-only
assert.ok(parentOnly.includes("replace"), "replace must be parent-only");
assert.ok(parentOnly.includes("parse"), "parse must be parent-only");
assert.ok(parentOnly.includes("ssh"), "ssh must be parent-only");
assert.ok(parentOnly.includes("todo"), "todo must be parent-only");
assert.ok(parentOnly.includes("ask"), "ask must be parent-only");
assert.ok(parentOnly.includes("delegate_subagent"), "delegate_subagent must be parent-only");
assert.ok(parentOnly.includes("resume_subagent"), "resume_subagent must be parent-only");
assert.ok(parentOnly.includes("wait_subagent"), "wait_subagent must be parent-only");
assert.equal(parentOnly.length, 8, `expected 8 parent-only tools, got ${parentOnly.length}`);

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

// ── Single-bullet visual vocabulary ─────────────────────────────────

assert.equal(OPERATIONAL_LIFECYCLES.length, 6, "must have exactly 6 lifecycles");
assert.equal(OPERATIONAL_QUALIFIERS.length, 7, "must have exactly 7 qualifiers");

// Bullet marker is one cell, non-pictographic
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
assert.equal(DEFAULT_DISPLAY_POLICY.previewLines, 5);
assert.equal(DEFAULT_DISPLAY_POLICY.expandedMaxLines, 4_000);
assert.equal(DEFAULT_DISPLAY_POLICY.showMetadata, false);
assert.equal(DEFAULT_DISPLAY_POLICY.showDuration, true);
assert.equal(DEFAULT_DISPLAY_POLICY.wordWrap, true);
assert.equal(DEFAULT_DISPLAY_POLICY.diffView, "unified");
assert.equal(DEFAULT_DISPLAY_POLICY.diffSplitMinWidth, 120);
assert.equal(DEFAULT_DISPLAY_POLICY.diffCollapsedLines, 12);
assert.equal(DEFAULT_DISPLAY_MOTION, "full");

// ── Policy fields exhaustive ─────────────────────────────────────────

assert.equal(DISPLAY_POLICY_FIELDS.length, 9, "must have exactly 9 policy fields");

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
assert.equal(MOTION_FULL_INTERVAL_MS, 120);
assert.equal(MOTION_REDUCED_INTERVAL_MS, 1_000);
assert.equal(RUNNING_PULSE_PERIOD_MS, 1_600);

// ── Six families ─────────────────────────────────────────────────────

assert.equal(DISPLAY_FAMILIES.length, 6);
assert.deepEqual([...DISPLAY_FAMILIES], ["filesystem", "search", "execution", "remote", "workflow", "agent"]);

// ── catalogFamilyFor helper ──────────────────────────────────────────

assert.equal(catalogFamilyFor("pdf_search"), "search");
assert.equal(catalogFamilyFor("bash"), "execution");
assert.equal(catalogFamilyFor("nonexistent"), undefined);

console.log("display catalog tests: OK");
