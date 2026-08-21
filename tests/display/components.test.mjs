import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  lifecycle: "completed",
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
assert.match(summaryText, /✓ Search src/, "header shows marker, title, and target");
assert.match(summaryText, /1\.3s/);
assert.match(summaryText, /files 3\/3/);
assert.doesNotMatch(summaryText, /SECRET|owned|one/);
assert.match(summaryText, /3 matches/, "the inline summary states the outcome");
// C7: metadata renders only when expanded.
const summaryExpanded = new OperationalDisplayComponent(description, summaryPolicy, plainTheme, { expanded: true }).render(80).join("\n");
assert.match(summaryExpanded, /matches=3/, "expanded metadata shows the matches field");
assert.doesNotMatch(summaryExpanded, /SECRET/, "expanded metadata redacts secret-shaped values");

const previewPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", previewLines: 2 };
const preview = new OperationalDisplayComponent(description, previewPolicy, plainTheme, { expanded: true });
const previewText = preview.render(40).join("\n");
assert.match(previewText, /one/);
assert.match(previewText, /source lines hidden/);
// Collapsed: preview content is hidden; the row carries the inline summary.
const previewCollapsed = new OperationalDisplayComponent(description, previewPolicy, plainTheme, { expanded: false });
const previewCollapsedText = previewCollapsed.render(40).join("\n");
assert.doesNotMatch(previewCollapsedText, /one|source lines hidden/, "collapsed hides the preview payload");
assert.match(previewCollapsedText, /3 matches/, "collapsed shows the inline summary");

const hiddenPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "hidden" };
const hidden = new OperationalDisplayComponent(description, hiddenPolicy, plainTheme, { expanded: false }).render(80).join("\n");
assert.doesNotMatch(hidden, /3 matches|one/);
const error = new OperationalDisplayComponent(
  { ...description, lifecycle: "failed", rows: [], error: "security warning", errorRaw: "Bearer abc-secret" },
  hiddenPolicy,
  plainTheme,
  { expanded: false },
).render(80).join("\n");
assert.match(error, /security warning/);
assert.doesNotMatch(error, /abc-secret/);
const errorExpanded = new OperationalDisplayComponent(
  { ...description, lifecycle: "failed", rows: [], error: "security warning", errorRaw: "Bearer abc-secret" },
  hiddenPolicy,
  plainTheme,
  { expanded: true },
).render(80).join("\n");
assert.match(errorExpanded, /\[REDACTED\]/);
assert.doesNotMatch(errorExpanded, /abc-secret/);

const noWrapDescription = {
  version: 1,
  tool: "rg",
  family: "search",
  lifecycle: "completed",
  title: "Search",
  rows: [{ text: `row ${"long ".repeat(30)}ROW_TAIL` }],
  preview: { text: `preview ${"wide ".repeat(30)}PREVIEW_TAIL` },
};
const wrappedLines = new OperationalDisplayComponent(
  noWrapDescription,
  { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", wordWrap: true },
  plainTheme,
  { expanded: true },
).render(40);
const clippedLines = new OperationalDisplayComponent(
  noWrapDescription,
  { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", wordWrap: false },
  plainTheme,
  { expanded: true },
).render(40);
assert.ok(wrappedLines.length > clippedLines.length);
// Expanded: header + row + preview + closing summary row.
assert.equal(clippedLines.length, 4, "header, row, preview, and summary close the expanded body");
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
  lifecycle: "completed",
  title: "Search",
  target: "needle",
  sections: [
    {
      title: "Details",
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
// C4 revision: non-mutation tools collapse to exactly one row, so compact
// sections no longer render in the collapsed body.
assert.doesNotMatch(structuredCollapsed, /returned=2/);
assert.doesNotMatch(structuredCollapsed, /Matches|console\.log/);
const structuredExpanded = new OperationalDisplayComponent(structuredDescription, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: true }).render(80).join("\n");
assert.match(structuredExpanded, /Details/);
assert.match(structuredExpanded, /Matches/);
assert.match(structuredExpanded, /src\/a\.ts/);
assert.match(structuredExpanded, /12 {2}const needle = true;/);
assert.match(structuredExpanded, /Output/);
assert.match(structuredExpanded, /1\s+const needle/);
const structuredLines = structuredExpanded.split("\n");
assert.ok(structuredLines.find((line) => line.includes("Matches"))?.match(/^[│└├]/));
assert.ok(structuredLines.find((line) => line.includes("src/a.ts"))?.match(/^[│└]/));
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

// Each finished line is bounded exactly one time. A second bound of the
// rendered output must be a no-op for every content category, which is what
// lets the final render pass drop its redundant truncation.
const boundOnceDescription = {
  version: 1,
  tool: "bash",
  family: "execution",
  lifecycle: "completed",
  title: "Bash",
  target: `npm run build -- ${"--flag ".repeat(20)}`,
  sections: [
    { title: "Command", blocks: [{ kind: "code", text: "npm run build", language: "bash" }] },
    {
      title: "Output",
      blocks: [{
        kind: "code",
        // plain, CJK-wide, over-width plain, and over-width CJK-wide content.
        text: [
          "plain line",
          "\u691c\u7d22\u7d50\u679c \u30d5\u30a1\u30a4\u30eb\u540d",
          "wide output ".repeat(30),
          "\u691c\u7d22\u7d50\u679c".repeat(40),
        ].join("\n"),
        language: "text",
      }],
    },
  ],
  preview: { text: `plain\n\u691c\u7d22\u7d50\u679c\u306e\u884c\n${"over width ".repeat(30)}`, tailOnly: true },
  summary: "3 lines",
  durationMs: 4200,
};
for (const theme of themes) {
  for (const expanded of [false, true]) {
    for (const width of [1, 5, 39, 40, 63, 64, 80, 99, 100, 120]) {
      const lines = new OperationalDisplayComponent(
        boundOnceDescription,
        previewPolicy,
        theme,
        { expanded },
      ).render(width);
      for (const line of lines) {
        assert.equal(visibleWidth(line), width, `line width at ${width} (expanded=${expanded})`);
        assert.equal(
          truncateToWidth(line, width, "\u2026"),
          line,
          `rendered line changed under a second bound at width ${width} (expanded=${expanded})`,
        );
      }
    }
  }
}

// Cache contract: a repeated render with unchanged inputs and the same
// width returns the cached lines (reference identity). A width change, an
// update() call, and an invalidate() call each produce newly calculated
// lines. Proven deterministically without a clock.
const cacheComponent = new OperationalDisplayComponent(description, previewPolicy, plainTheme, { expanded: false });
const first = cacheComponent.render(80);
const second = cacheComponent.render(80);
assert.equal(second, first, "repeated render with unchanged inputs returns the cached lines");

// A width change recomputes the lines.
const atWidth60 = cacheComponent.render(60);
assert.notEqual(atWidth60, first, "a width change recomputes the lines");
assert.ok(atWidth60.every((line) => visibleWidth(line) <= 60), "recomputed lines respect the new width");
const atWidth60Again = cacheComponent.render(60);
assert.equal(atWidth60Again, atWidth60, "repeated render at the new width returns the cached lines");

// An update() call drops the cache.
cacheComponent.update(description, previewPolicy, plainTheme, { expanded: true });
const afterUpdate = cacheComponent.render(80);
assert.notEqual(afterUpdate, first, "an update() call recomputes the lines at the same width");

// An invalidate() call drops the cache.
const beforeInvalidate = cacheComponent.render(80);
cacheComponent.invalidate();
const afterInvalidate = cacheComponent.render(80);
assert.notEqual(afterInvalidate, beforeInvalidate, "an invalidate() call recomputes the lines");
assert.deepEqual(afterInvalidate, beforeInvalidate, "invalidate produces the same content after recompute");

console.log("display component tests: OK");
