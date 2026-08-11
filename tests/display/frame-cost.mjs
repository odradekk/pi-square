#!/usr/bin/env node
/**
 * Frame-cost measurement for pi-square TUI surfaces.
 *
 * Reports the render cost of one operational display entry and the frame
 * cost of a synthetic history at 10, 50, and 100 entries, in both bundled
 * themes at width 120.
 *
 * This is a development report, not a required CI gate. Wall-clock timings
 * are not deterministic across environments and are never asserted in CI.
 *
 * Usage: npm run bench:frames
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import jiti from "jiti";

const packageRoot = join(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const { OperationalDisplayComponent } = await load(join(packageRoot, "src", "display", "components.ts"));
const { DEFAULT_DISPLAY_POLICY } = await load(join(packageRoot, "src", "display", "types.ts"));
const { FooterSnapshotProvider } = await load(join(packageRoot, "src", "footer", "data.ts"));
const { renderEnhancedFooter } = await load(join(packageRoot, "src", "footer", "render.ts"));

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

const themes = {
  dark: loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json")),
  light: loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-light.json")),
};

const WIDTH = 120;
const ITERATIONS = 200;

// --- Synthetic descriptions covering the main tool categories ----------

function readDescription() {
  return {
    version: 1,
    tool: "read",
    family: "filesystem",
    lifecycle: "completed",
    phase: "result",
    title: "Read",
    target: "src/display/components.ts:1-200",
    targetKind: "path",
    durationMs: 42,
    sections: [
      {
        title: "Content",
        blocks: [{
          kind: "code",
          text: Array.from({ length: 40 }, (_, i) => `// line ${i + 1}\nconst value${i} = ${i * 100};`).join("\n"),
          language: "ts",
          lineNumbers: true,
        }],
        compact: false,
      },
    ],
    summary: "200 lines · 8.4 KB",
    truncated: true,
  };
}

function bashDescription() {
  const output = Array.from({ length: 50 }, (_, i) => `[${new Date(Date.now() - i * 1000).toISOString()}] processing item ${i}: status=${i % 3 === 0 ? "ok" : "retry"}`).join("\n");
  return {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: "completed",
    phase: "result",
    title: "Bash",
    target: "npm run build && npm test",
    durationMs: 12_500,
    sections: [
      { title: "Command", blocks: [{ kind: "code", text: "npm run build && npm test", language: "bash" }] },
      { title: "Output", blocks: [{ kind: "code", text: output, language: "text" }] },
    ],
    preview: { text: output, tailOnly: true },
    summary: "50 lines",
    truncated: true,
  };
}

function grepDescription() {
  return {
    version: 1,
    tool: "rg",
    family: "search",
    lifecycle: "completed",
    phase: "result",
    title: "Search",
    target: "OperationalDisplayComponent",
    durationMs: 310,
    qualifiers: [],
    sections: [
      {
        title: "Matches",
        blocks: [{
          kind: "matches",
          items: Array.from({ length: 15 }, (_, i) => ({
            path: `src/module-${i % 4}.ts`,
            line: 10 + i * 7,
            column: 3,
            excerpt: `const component = new OperationalDisplayComponent(desc, policy, theme, opts);`,
          })),
        }],
        compact: false,
      },
    ],
    summary: "15 matches in 4 files",
  };
}

function editDescription() {
  return {
    version: 1,
    tool: "edit",
    family: "filesystem",
    lifecycle: "completed",
    phase: "result",
    title: "Edit",
    target: "src/display/components.ts",
    targetKind: "path",
    durationMs: 8,
    diff: {
      path: "src/display/components.ts",
      patch: Array.from({ length: 30 }, (_, i) => {
        const sign = i % 3 === 0 ? "+" : i % 3 === 1 ? "-" : " ";
        return `${sign}modified line ${i} with content that wraps at narrow widths`;
      }).join("\n"),
    },
    summary: "10 replacements · +15 −5",
  };
}

const descriptions = [readDescription(), bashDescription(), grepDescription(), editDescription()];

function buildEntries(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push(descriptions[i % descriptions.length]);
  }
  return entries;
}

// --- Measurement helpers ------------------------------------------------

function measure(fn, iterations) {
  // Warm up
  fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / iterations / 1_000_000; // ms per call
}

function buildComponents(entries, theme, expanded) {
  return entries.map(
    (desc) => new OperationalDisplayComponent(desc, DEFAULT_DISPLAY_POLICY, theme, { expanded }),
  );
}

function renderAll(components, width) {
  for (const component of components) component.render(width);
}

// --- Footer measurement -------------------------------------------------

function buildFooterCtx(entries) {
  const assistantEntries = entries.map((_, i) => ({
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 100 + i, output: 20 + i, cacheRead: 800, cacheWrite: 50, cost: { total: 0.001 * i } },
    },
  }));
  return {
    model: { id: "test-model", name: "Test Model", provider: "test", reasoning: true, contextWindow: 200_000 },
    modelRegistry: { isUsingOAuth() { return false; } },
    sessionManager: {
      getEntries() { return assistantEntries; },
      getCwd() { return "/workspace/project"; },
      getSessionName() { return "bench-session"; },
    },
    getContextUsage() { return { percent: 65, contextWindow: 200_000 }; },
  };
}

const footerData = {
  getGitBranch() { return "main"; },
  getExtensionStatuses() { return new Map([["pi-square.subagents", "explorer running"]]); },
  getAvailableProviderCount() { return 2; },
  onBranchChange() { return () => {}; },
};
const footerPi = { getThinkingLevel() { return "high"; } };

// --- Report -------------------------------------------------------------

console.log("pi-square frame-cost report");
console.log("===========================\n");

for (const [themeName, theme] of Object.entries(themes)) {
  console.log(`Theme: ${themeName} (width ${WIDTH})`);
  console.log("-".repeat(48));

  // One entry cost (collapsed + expanded)
  for (const expanded of [false, true]) {
    const label = expanded ? "expanded" : "collapsed";
    const component = new OperationalDisplayComponent(descriptions[0], DEFAULT_DISPLAY_POLICY, theme, { expanded });
    const cost = measure(() => component.render(WIDTH), ITERATIONS);
    console.log(`  1 entry (${label}):     ${cost.toFixed(4)} ms`);
  }

  // Frame cost for N entries (simulates Pi re-rendering all history)
  for (const count of [10, 50, 100]) {
    const entries = buildEntries(count);

    // Cold: fresh components, first render (no cache)
    const coldComponents = buildComponents(entries, theme, false);
    const cold = measure(() => renderAll(coldComponents, WIDTH), Math.max(20, Math.floor(ITERATIONS / count)));

    // Warm: repeated render on same components (cache hit)
    const warmComponents = buildComponents(entries, theme, false);
    warmComponents.forEach((c) => c.render(WIDTH)); // prime cache
    const warm = measure(() => renderAll(warmComponents, WIDTH), Math.max(20, Math.floor(ITERATIONS / count)));

    console.log(`  ${String(count).padStart(3)} entries (cold):   ${cold.toFixed(3)} ms/frame`);
    console.log(`  ${String(count).padStart(3)} entries (cached): ${warm.toFixed(3)} ms/frame`);
  }

  // Footer cost
  const footerCtx = buildFooterCtx(buildEntries(50));
  const footerProvider = new FooterSnapshotProvider();
  const footerSnapshot = () => footerProvider.snapshot(footerCtx, footerPi, footerData);
  const footerCost = measure(() => renderEnhancedFooter(theme, WIDTH, footerSnapshot()), ITERATIONS);
  console.log(`  footer (50 entries):   ${footerCost.toFixed(4)} ms`);

  console.log();
}

console.log("Note: timings are indicative, not deterministic. Do not assert on them in CI.");
