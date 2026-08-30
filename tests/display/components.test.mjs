import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { OperationalDisplayComponent, HangingText, ResponsiveRow, SectionRule, BoundedPreview } = await load("../../src/display/components.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
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
assert.match(summaryText, /✓ Search src/, "header shows marker, title, and target with natural single-space spacing");
assert.match(summaryText, /1\.3s/);
assert.match(summaryText, /files 3\/3/);
assert.doesNotMatch(summaryText, /SECRET|owned|one/);
assert.match(summaryText, /3 matches/, "the inline summary states the outcome");
// Metadata is opt-in: the default policy renders no key=value row.
assert.doesNotMatch(summaryText, /matches=3/, "metadata stays off by default");
const summaryExpanded = new OperationalDisplayComponent(description, summaryPolicy, plainTheme, { expanded: true }).render(80).join("\n");
assert.doesNotMatch(summaryExpanded, /matches=3/, "metadata stays off by default when expanded");
const metadataOn = { ...summaryPolicy, showMetadata: true };
const metadataExpanded = new OperationalDisplayComponent(description, metadataOn, plainTheme, { expanded: true }).render(80);
const metadataRows = metadataExpanded.slice(1).filter((line) => line.includes("matches=3"));
assert.equal(metadataRows.length, 1, "explicitly enabled metadata renders exactly one row");
assert.match(stripVTControlCharacters(metadataRows[0] ?? ""), /^ {2}matches=3 · token=\[REDACTED\]/, "the metadata row lists key=value fields");
// The metadata row uses the muted tone, verified through a tagging theme.
const tagTheme = {
  fg(token, text) { return `<${token}>${text}</${token}>`; },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const taggedMetadata = new OperationalDisplayComponent(description, metadataOn, tagTheme, { expanded: true }).render(80);
assert.ok(
  taggedMetadata.slice(1).some((line) => line.includes("<muted>matches=3")),
  "the metadata row renders in the muted tone",
);
assert.doesNotMatch(metadataExpanded.join("\n"), /SECRET/, "expanded metadata redacts secret-shaped values");

const previewPolicy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", previewLines: 2 };
const preview = new OperationalDisplayComponent(description, previewPolicy, plainTheme, { expanded: true });
const previewText = preview.render(40).join("\n");
assert.match(previewText, /one/);
assert.match(previewText, /⋯ \+2 lines/, "the render-layer clip states the omitted count");
// Collapsed: preview content is hidden; the row carries the inline summary.
const previewCollapsed = new OperationalDisplayComponent(description, previewPolicy, plainTheme, { expanded: false });
const previewCollapsedText = previewCollapsed.render(40).join("\n");
assert.doesNotMatch(previewCollapsedText, /one|⋯ \+2 lines/, "collapsed hides the preview payload");
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
// Expanded: header + row + preview. The closing summary row is gone; the
// outcome lives in the header row.
assert.equal(clippedLines.length, 3, "header, row, and preview close the expanded body");
assert.ok(clippedLines.every((line) => visibleWidth(line) === 40));
// The header carries the inline outcome summary (middle-elided, tail kept),
// while every body line clips its own tail.
assert.match(stripVTControlCharacters(clippedLines[0]), /ROW_TAIL/, "the header summary keeps the row tail through elision");
assert.doesNotMatch(clippedLines.slice(1).join("\n"), /ROW_TAIL|PREVIEW_TAIL/, "body lines clip their tails");
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
assert.match(structuredExpanded, /Output/);
assert.match(structuredExpanded, /1\s+const needle/);
const structuredLines = structuredExpanded.split("\n");
// Quiet indentation: section titles and content carry the two-cell evidence
// indent (plus their own deeper content indentation); no tree rails render.
assert.match(structuredLines.find((line) => line.includes("Matches")) ?? "", /^ {2}Matches/);
assert.match(structuredLines.find((line) => line.includes("src/a.ts")) ?? "", /^ {4}src\/a\.ts/);
assert.ok(structuredLines.every((line) => !/^[│└├]/.test(line)), "no tree rails on any body line");
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

// C4 revision: a running collapsed entry carries its live progress message in
// the inline summary slot. The right element then keeps only the duration, so
// the one row never renders the same progress text twice.
{
  const running = {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: "running",
    phase: "call",
    title: "Bash",
    target: "npm test",
    progress: { label: "partial output", current: 3 },
    durationMs: 1200,
  };
  const collapsedHeader = new OperationalDisplayComponent(running, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(120)[0];
  assert.equal(collapsedHeader.split("partial output").length - 1, 1, "the progress message renders exactly once in the collapsed row");
  assert.match(collapsedHeader, /1\.2s/, "the duration stays on the row");
  const expandedHeader = new OperationalDisplayComponent(running, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: true }).render(120)[0];
  assert.match(expandedHeader, /partial output/, "an expanded running entry keeps the progress message in the right element");
}

// ─── Running marker pulse: full-motion, color-only brightness wave ──
{
  const running = {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: "running",
    title: "Bash",
    target: "npm test",
    durationMs: 1200,
  };
  const darkTheme = loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json"));
  const DIM = "\u001b[2m";
  const BOLD = "\u001b[1m";
  const pulseAt = (theme, pulseNowMs, overrides = {}) => new OperationalDisplayComponent(
    running,
    DEFAULT_DISPLAY_POLICY,
    theme,
    { expanded: false, colorAvailable: true, motion: "full", pulseNowMs, ...overrides },
  ).render(120)[0];

  // Deterministic phases over the 1600 ms period: 0 ms is the wave floor
  // (dim), 800 ms the crest (bold), and 400 ms the plain mid level.
  assert.ok(pulseAt(darkTheme, 0).includes(`${DIM}●`), "the pulse floor dims the running marker");
  assert.ok(pulseAt(darkTheme, 800).includes(`${BOLD}●`), "the pulse crest bolds the running marker");
  const mid = pulseAt(darkTheme, 400);
  assert.ok(!mid.includes(`${DIM}●`) && !mid.includes(`${BOLD}●`), "the mid phase carries neither dim nor bold");
  assert.match(mid, /\u001b\[[0-9;]*m●/, "the mid phase keeps the accent color on the marker");

  // The pulse is full-motion only: reduced and off stay static at every phase.
  for (const motion of ["reduced", "off"]) {
    for (const pulseNowMs of [0, 400, 800]) {
      const line = pulseAt(darkTheme, pulseNowMs, { motion });
      assert.ok(
        !line.includes(`${DIM}●`) && !line.includes(`${BOLD}●`),
        `${motion} motion keeps the running marker static`,
      );
    }
  }

  // Colorless sessions never pulse, even in full motion.
  for (const pulseNowMs of [0, 800]) {
    const line = pulseAt(darkTheme, pulseNowMs, { colorAvailable: false });
    assert.ok(
      !line.includes(`${DIM}●`) && !line.includes(`${BOLD}●`),
      "a colorless session keeps the running marker static",
    );
  }

  // A minimal theme double without getFgAnsi falls back to the static accent
  // marker instead of raw ANSI pulse codes.
  for (const pulseNowMs of [0, 800]) {
    const line = pulseAt(plainTheme, pulseNowMs);
    assert.match(stripVTControlCharacters(line), /^●/, "the fake-theme fallback keeps the running marker");
    assert.ok(!line.includes(DIM) && !line.includes(BOLD), "the fake-theme fallback emits no pulse codes");
  }

  // Only the running lifecycle pulses.
  const completed = new OperationalDisplayComponent(
    { ...running, lifecycle: "completed" },
    DEFAULT_DISPLAY_POLICY,
    darkTheme,
    { expanded: false, colorAvailable: true, motion: "full", pulseNowMs: 0 },
  ).render(120)[0];
  assert.ok(
    !completed.includes(`${DIM}✓`) && !completed.includes(`${BOLD}✓`),
    "a completed marker never pulses",
  );

  // Through the runtime seam: a TTY runtime runs full motion and passes the
  // pulse phase through, while a fake theme still gets the static fallback.
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });
  assert.equal(runtime.motion, "full", "a TTY runtime runs full motion");
  const runtimeDark = runtime.createComponent(running, darkTheme, { expanded: false, pulseNowMs: 0 });
  assert.ok(runtimeDark.render(120)[0].includes(`${DIM}●`), "the runtime threads the pulse phase to the component");
  const runtimeFake = runtime.createComponent(running, plainTheme, { expanded: false, pulseNowMs: 0 });
  assert.ok(
    !runtimeFake.render(120)[0].includes(DIM),
    "a fake theme through the runtime keeps the static running marker",
  );
  runtime.dispose();
}

console.log("display component tests: OK");
