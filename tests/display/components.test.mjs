import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { OperationalDisplayComponent, HangingText, ResponsiveRow, SectionRule, BoundedPreview } = await load("../../src/display/components.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

const description = {
  version: 1,
  tool: "rg",
  family: "search",
  status: "success",
  title: "Search",
  target: "src\x1b]0;owned\x07",
  metadata: [{ label: "matches", value: "3" }, { label: "token", value: "ghp_SECRET" }],
  durationMs: 1250,
  rows: [{ text: "3 matches in 2 files" }],
  preview: { text: "one\ntwo\nthree", omittedLines: 2 },
  progress: { current: 3, total: 3, label: "files" },
};

const summaryPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "summary" };
const summary = new OperationalDisplayComponent(description, summaryPolicy, plainTheme, { expanded: false });
const summaryText = summary.render(80).join("\n");
assert.match(summaryText, /✓ Search src/);
assert.match(summaryText, /1\.3s/);
assert.match(summaryText, /files 3\/3/);
assert.match(summaryText, /matches=3/);
assert.doesNotMatch(summaryText, /SECRET|owned|one/);
assert.match(summaryText, /3 matches/);

const previewPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", previewLines: 2 };
const preview = new OperationalDisplayComponent(description, previewPolicy, plainTheme, { expanded: false });
const previewText = preview.render(40).join("\n");
assert.match(previewText, /one/);
assert.match(previewText, /source lines hidden/);

const hiddenPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "hidden" };
const hidden = new OperationalDisplayComponent(description, hiddenPolicy, plainTheme, { expanded: false }).render(80).join("\n");
assert.doesNotMatch(hidden, /3 matches|one/);
const error = new OperationalDisplayComponent(
  { ...description, status: "error", rows: [{ text: "security warning" }], error: "Bearer abc-secret" },
  hiddenPolicy,
  plainTheme,
  { expanded: false },
).render(80).join("\n");
assert.match(error, /security warning/);
assert.match(error, /\[REDACTED\]/);
assert.doesNotMatch(error, /abc-secret/);

const noWrapDescription = {
  version: 1,
  tool: "rg",
  family: "search",
  status: "success",
  title: "Search",
  rows: [{ text: `row ${"long ".repeat(30)}ROW_TAIL` }],
  preview: { text: `preview ${"wide ".repeat(30)}PREVIEW_TAIL` },
};
const wrappedLines = new OperationalDisplayComponent(
  noWrapDescription,
  { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", wordWrap: true },
  plainTheme,
  { expanded: false },
).render(40);
const clippedLines = new OperationalDisplayComponent(
  noWrapDescription,
  { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", wordWrap: false },
  plainTheme,
  { expanded: false },
).render(40);
assert.ok(wrappedLines.length > clippedLines.length);
assert.equal(clippedLines.length, 3, "header, row, and preview remain one line each");
assert.ok(clippedLines.every((line) => visibleWidth(line) === 40));
assert.doesNotMatch(clippedLines.join("\n"), /ROW_TAIL|PREVIEW_TAIL/);

const hanging = new HangingText("key=", "value ".repeat(20));
const row = new ResponsiveRow("left ".repeat(10), "right");
const rule = new SectionRule("details", plainTheme);
const bounded = new BoundedPreview("a\nb\nc", 2, plainTheme);
for (const component of [hanging, row, rule, bounded]) {
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
  }
}

const structuredDescription = {
  version: 1,
  tool: "rg",
  family: "search",
  status: "success",
  title: "Search",
  target: "needle",
  sections: [
    {
      title: "Summary",
      blocks: [{ kind: "list", items: [{ label: "returned", value: "2" }, { label: "status", value: "ok", tone: "success" }] }],
      compact: true,
    },
    {
      title: "Matches",
      blocks: [{ kind: "matches", items: [{ path: "src/a.ts", line: 12, column: 4, excerpt: "const needle = true;" }] }],
      compact: false,
    },
    {
      title: "Output",
      blocks: [{ kind: "code", text: "const needle = true;\nconsole.log(needle);", language: "ts", lineNumbers: true }],
      compact: false,
    },
  ],
};
const structuredCollapsedDescription = {
  ...structuredDescription,
  sections: structuredDescription.sections.filter((section) => section.compact === true),
};
const structuredCollapsed = new OperationalDisplayComponent(structuredCollapsedDescription, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(80).join("\n");
assert.match(structuredCollapsed, /SUMMARY/);
assert.doesNotMatch(structuredCollapsed, /MATCHES|console\.log/);
const structuredExpanded = new OperationalDisplayComponent(structuredDescription, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: true }).render(80).join("\n");
assert.match(structuredExpanded, /SUMMARY/);
assert.match(structuredExpanded, /MATCHES/);
assert.match(structuredExpanded, /src\/a\.ts:12:4/);
assert.match(structuredExpanded, /OUTPUT/);
assert.match(structuredExpanded, /1\s+const needle/);
const structuredLines = structuredExpanded.split("\n");
assert.ok(structuredLines.find((line) => line.includes("MATCHES"))?.match(/^[│└]/));
assert.ok(structuredLines.find((line) => line.includes("src/a.ts:12:4"))?.match(/^[│└]/));
for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
  const lines = new OperationalDisplayComponent(structuredDescription, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: true }).render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
}

const packageRoot = join(import.meta.dirname, "..", "..");
const themeModulePath = pathToFileURL(join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);
const themes = [
  plainTheme,
  loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json")),
  loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-light.json")),
];
for (const theme of themes) {
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const component = new OperationalDisplayComponent(description, previewPolicy, theme, { expanded: true });
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `component exceeded ${width}`);
    assert.doesNotMatch(lines.join("\n"), /owned|SECRET/);
  }
}

console.log("display component tests: OK");
