import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";

initTheme();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { renderSubagentNotification } = await load(join(packageRoot, "src", "subagents", "render.ts"));
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

const plainTheme = {
  fg(_color, text) { return String(text); },
  bg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};

function plainLines(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function details(overrides = {}) {
  return {
    version: 3,
    id: "subagent_12345678-abcd-4abc-8abc-123456789abc",
    mode: "bg",
    artifactsDir: "/tmp/private-artifacts",
    sessionFile: "/tmp/private-artifacts/session.jsonl",
    sessionId: "native-private-id",
    originParentSessionId: "parent-private-id",
    lastParentSessionId: "parent-private-id",
    promptSnapshot: {
      version: 2,
      system: "private system",
      manifest: {
        contractVersion: 2,
        governanceVersion: 1,
        inheritParentSystem: true,
        effectiveSystemHash: "hash",
        governanceHash: "hash",
        contextCount: 0,
        fieldSources: {},
        sourceFiles: [],
      },
    },
    phase: "done",
    agent: { promptVersion: 2, name: "explorer", effort: "high", inheritParentSystem: true },
    task: "Inspect the parser and report concrete evidence.",
    cwd: "/tmp/project",
    model: "provider/model",
    startedAt: Date.now() - 1500,
    endedAt: Date.now(),
    durationMs: 1500,
    finalText: "# Finding\n\nThe parser preserves quoted input.\n\nUnique expanded tail.",
    retries: 0,
    toolErrors: [],
    usage: { input: 1200, output: 340, cacheRead: 20, cacheWrite: 0, cost: 0.0012, turns: 2 },
    timeline: [
      { kind: "tool", phase: "start", text: "rg {\"pattern\":\"needle\",\"path\":\"src\"}" },
      { kind: "tool", phase: "end", text: "rg: SECRET TOOL OUTPUT", isError: false },
    ],
    ...overrides,
  };
}

const run = details();
const message = {
  content: "background content",
  details: { id: run.id, status: "done", result: run },
};
const collapsedBackgrounds = [];
const collapsed = plainLines(renderSubagentNotification(message, { expanded: false }, {
  ...plainTheme,
  bg(color, text) { collapsedBackgrounds.push(color); return String(text); },
}), 80).join("\n");
assert.match(collapsed, /explorer \/ background \/ 12345678\s+✓ done/);
assert.match(collapsed, /Task: Inspect the parser/);
assert.match(collapsed, /Finding/);
assert.doesNotMatch(collapsed, /Unique expanded tail|SECRET TOOL OUTPUT|private-artifacts|native-private-id/);
assert.ok(collapsedBackgrounds.includes("toolSuccessBg"));

const expanded = plainLines(renderSubagentNotification(message, { expanded: true }, plainTheme), 80).join("\n");
assert.match(expanded, /ID: subagent_12345678/);
assert.match(expanded, /Unique expanded tail/);
assert.match(expanded, /Inspect the parser/);
assert.match(expanded, /rg  \/needle\/ in src/);
assert.doesNotMatch(expanded, /SECRET TOOL OUTPUT|private-artifacts|native-private-id|private system/);

const failed = details({ phase: "error", finalText: "", error: "failed" });
const errorBackgrounds = [];
renderSubagentNotification({
  content: "failed",
  details: { id: failed.id, status: "error", result: failed },
}, { expanded: false }, {
  ...plainTheme,
  bg(color, text) { errorBackgrounds.push(color); return String(text); },
}).render(80);
assert.ok(errorBackgrounds.includes("toolErrorBg"));

for (const themeName of ["pi-square-theme-dark", "pi-square-theme-light"]) {
  const theme = loadThemeFromPath(join(packageRoot, "themes", `${themeName}.json`));
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    for (const expandedMode of [false, true]) {
      const component = renderSubagentNotification(message, { expanded: expandedMode }, theme);
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${themeName}: ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
}

assert.doesNotMatch(`${collapsed}\n${expanded}`, /[⌛⏳◐◌\uFE0F]/u);

// ─── Operational interface: agent icon, lifecycle markers, title-case sections ─
assert.match(collapsed, /◇/, "notification header uses ◇ agent-family icon");
assert.doesNotMatch(collapsed, /subagent/, "notification header no longer uses 'subagent' text identity");
assert.match(collapsed, /✓ done/, "done status uses ✓ marker");

const errorNotification = renderSubagentNotification(
  { content: "failed", details: { id: failed.id, status: "error", result: failed } },
  { expanded: false },
  plainTheme,
);
const errorText = plainLines(errorNotification, 80).join("\n");
assert.match(errorText, /✗ error/, "error status uses ✗ marker");

// Section headings use title-case, not all-caps
const expandedPlain = plainLines(renderSubagentNotification(message, { expanded: true }, plainTheme), 120).join("\n");
assert.match(expandedPlain, /Task/, "section heading uses title-case Task");
assert.doesNotMatch(expandedPlain, /TASK/, "section heading is not all-caps TASK");
assert.match(expandedPlain, /Result/, "section heading uses title-case Result");
assert.doesNotMatch(expandedPlain, /RESULT/, "section heading is not all-caps RESULT");
assert.match(expandedPlain, /Activity/, "section heading uses title-case Activity");
assert.doesNotMatch(expandedPlain, /ACTIVITY/, "section heading is not all-caps ACTIVITY");

// ─── Aborted notification uses muted tone, × marker, and error shell ──
const abortedDetails = details({ phase: "aborted", finalText: "", error: "cancelled" });
const abortedBackgrounds = [];
const abortedComponent = renderSubagentNotification(
  { content: "aborted", details: { id: abortedDetails.id, status: "aborted", result: abortedDetails } },
  { expanded: false },
  { ...plainTheme, bg(color, text) { abortedBackgrounds.push(color); return String(text); } },
);
const abortedText = plainLines(abortedComponent, 80).join("\n");
assert.match(abortedText, /× aborted/, "aborted status uses × marker");
assert.ok(abortedBackgrounds.includes("toolErrorBg"), "aborted notification uses error shell");

console.log("subagent notification rendering: success/error, privacy, activity, and width contracts passed");
