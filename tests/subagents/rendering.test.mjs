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
const { describeSubagentRun } = await load(join(packageRoot, "src", "subagents", "display-adapter.ts"));
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
  inverse(text) { return String(text); },
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

// ─── 1. Completion content uses the canonical transcript description ──

{
  const shared = describeSubagentRun("subagent_delegate", run, { expanded: false, isPartial: false, isError: false }, "background content");
  assert.equal(shared.tool, "subagent_delegate", "notification reuses the transcript tool identity");
  assert.equal(shared.family, "agent", "notification reuses the agent family");
  assert.equal(shared.lifecycle, "completed", "done phase resolves to the completed lifecycle");
  assert.equal(shared.title, "Subagent");
  assert.equal(shared.target, "explorer");
}

// ─── 2. Native shell remains the documented exception ────────────────

const collapsedBackgrounds = [];
const collapsed = plainLines(renderSubagentNotification(message, { expanded: false }, {
  ...plainTheme,
  bg(color, text) { collapsedBackgrounds.push(color); return String(text); },
}), 80).join("\n");
assert.ok(collapsedBackgrounds.includes("toolSuccessBg"), "done result keeps Pi's native success shell");

// ─── 3. Collapsed entry uses the operational grammar ─────────────────

assert.match(collapsed, /✓ Subagent explorer/, "marker, title, and target");
assert.match(collapsed, /id=12345678/, "bounded short run identity");
assert.match(collapsed, /mode=bg/, "delivery mode metadata");
assert.match(collapsed, /phase=done/, "terminal phase metadata");
assert.match(collapsed, /# Finding/, "bounded result summary");
assert.doesNotMatch(collapsed, /Unique expanded tail/, "collapsed output stays bounded");

// ─── 4. Privacy: no prompts, artifacts, raw sessions, or payloads ────

const expanded = plainLines(renderSubagentNotification(message, { expanded: true }, plainTheme), 80).join("\n");
for (const text of [collapsed, expanded]) {
  assert.doesNotMatch(text, /SECRET TOOL OUTPUT/, "tool result payloads never render");
  assert.doesNotMatch(text, /private-artifacts/, "artifact paths never render");
  assert.doesNotMatch(text, /native-private-id|parent-private-id/, "raw session identity never renders");
  assert.doesNotMatch(text, /private system/, "prompt snapshots never render");
}
assert.doesNotMatch(collapsed, /subagent_12345678-abcd/, "the full run ID stays out of the collapsed entry");

// ─── 5. Expanded entry reveals task, result, and activity ────────────

assert.match(expanded, /Unique expanded tail/, "expanded reveals the bounded full result");
assert.match(expanded, /Inspect the parser/, "expanded reveals the delegated task");
assert.match(expanded, /TASK/, "expanded uses the shared label-led section rule");
assert.match(expanded, /RESULT/, "result section uses the shared section rule");
assert.match(expanded, /ACTIVITY/, "activity section uses the shared section rule");
assert.match(expanded, /needle/, "allowlisted tool-call summary remains visible");

// ─── 6. Error and aborted deliveries ─────────────────────────────────

const failed = details({ phase: "error", finalText: "", error: "failed" });
const errorBackgrounds = [];
const errorText = plainLines(renderSubagentNotification({
  content: "failed",
  details: { id: failed.id, status: "error", result: failed },
}, { expanded: false }, {
  ...plainTheme,
  bg(color, text) { errorBackgrounds.push(color); return String(text); },
}), 80).join("\n");
assert.ok(errorBackgrounds.includes("toolErrorBg"), "error result keeps Pi's native error shell");
assert.match(errorText, /× Subagent/, "error renders the failed marker");

const abortedDetails = details({ phase: "aborted", finalText: "", error: "cancelled" });
const abortedBackgrounds = [];
const abortedText = plainLines(renderSubagentNotification(
  { content: "aborted", details: { id: abortedDetails.id, status: "aborted", result: abortedDetails } },
  { expanded: false },
  { ...plainTheme, bg(color, text) { abortedBackgrounds.push(color); return String(text); } },
), 80).join("\n");
assert.match(abortedText, /· Subagent/, "aborted renders the aborted marker, not the failed marker");
assert.doesNotMatch(abortedText, /× Subagent/, "aborted does not render the failed marker");
assert.ok(abortedBackgrounds.includes("toolErrorBg"), "aborted notification uses the error shell");

// ─── 7. Unknown payloads fall back without breaking the shell ────────

{
  const fallback = renderSubagentNotification(
    { content: "Background subagent finished", details: undefined },
    { expanded: false },
    plainTheme,
  );
  assert.match(plainLines(fallback, 80).join("\n"), /Background subagent finished/);
}

// ─── 8. Bounded in bundled themes at every boundary width ────────────

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

assert.doesNotMatch(`${collapsed}\n${expanded}`, /[⌛⏳◐◌\uFE0F]/u, "no emoji presentation characters");

console.log("subagent notification rendering: shared description, privacy, shells, and width contracts passed");
