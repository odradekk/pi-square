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
const {
  renderSubagentCall,
  renderSubagentNotification,
  renderSubagentResult,
} = await load(join(packageRoot, "src", "subagents", "render.ts"));
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

function context(overrides = {}) {
  return {
    state: {},
    lastComponent: undefined,
    executionStarted: false,
    isError: false,
    invalidate() {},
    ...overrides,
  };
}

function plain(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function plainLines(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function assertNoEmojiPresentation(text) {
  assert.doesNotMatch(text, /[⌛⏳◐◌\uFE0F]/u);
}

function details(overrides = {}) {
  return {
    version: 3,
    id: "subagent_12345678-abcd-4abc-8abc-123456789abc",
    mode: "fg",
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
    timeline: [],
    ...overrides,
  };
}

function result(runDetails, text = `ID: ${runDetails.id}\n\n${runDetails.finalText}`) {
  return { content: [{ type: "text", text }], details: runDetails };
}

{
  const task = Array.from({ length: 8 }, (_, index) => `task-line-${index + 1} ${"x".repeat(30)}`).join("\n");
  const rendered = plain(renderSubagentCall({
    mode: "fg",
    agent: "explorer",
    task: `${task}\x1b]0;owned\x07`,
    context: 3,
    cwd: "/tmp/project",
    model: "provider/model",
    thinkingLevel: "high",
    systemPrompt: "TOP SECRET INSTRUCTIONS",
  }, plainTheme, context({ executionStarted: true })), 80);

  assert.match(rendered, /^subagent \/ explorer \/ foreground/m);
  assert.match(rendered, /task-line-1/);
  assert.doesNotMatch(rendered, /task-line-8|owned|TOP SECRET/);
  assert.match(rendered, /context=3[\s\S]*model=provider\/model[\s\S]*effort=high[\s\S]*cwd=\/tmp\/project[\s\S]*custom[\s\S]*instructions/);
}

{
  const state = {};
  const run = details({
    phase: "running",
    durationMs: undefined,
    endedAt: undefined,
    liveText: Array.from({ length: 10 }, (_, index) => `- live markdown ${index + 1}`).join("\n"),
    timeline: [
      { kind: "tool", phase: "start", text: "read old-file.ts" },
      { kind: "tool", phase: "start", text: "rg {\"pattern\":\"needle\",\"path\":\"src\"}" },
      { kind: "tool", phase: "end", text: "rg: SECRET TOOL OUTPUT", isError: false },
    ],
  });
  const ctx = context({ state });
  const component = renderSubagentResult(result(run, run.liveText), { expanded: false, isPartial: true }, plainTheme, ctx);
  const rendered = plain(component, 80);

  assert.match(rendered, /^explorer \/ foreground\s+→ running/m);
  assert.doesNotMatch(rendered, /12345678/);
  assert.match(rendered, /rg  \/needle\/ in src\s+✓ done/);
  assert.doesNotMatch(rendered, /SECRET TOOL OUTPUT|read old-file/);
  assert.match(rendered, /live markdown 10/);
  assert.doesNotMatch(rendered, /live markdown 1(?:\s|$)/);
  assert.match(rendered, /earlier visual lines/);
  assert.match(rendered, /2 turns.*↑1\.2k.*↓340/);

  const expanded = plain(renderSubagentResult(
    result(run, run.liveText),
    { expanded: true, isPartial: true },
    plainTheme,
    { ...ctx, lastComponent: component },
  ), 80);
  assert.match(expanded, /Inspect the parser and report concrete evidence/);
  assert.match(expanded, /LIVE ─+/);
  assert.match(expanded, /live markdown 1(?:\s|$)/);
  assert.match(expanded, /live markdown 10/);
  assert.match(expanded, /read  old-file/);
  assert.match(expanded, /rg  \/needle\/ in src/);
  assert.doesNotMatch(expanded, /SECRET TOOL OUTPUT/);
  assert.match(expanded, /ACTIVITY ─+/);

  renderSubagentResult(result({ ...run, phase: "done", liveText: "", finalText: "done", durationMs: 20 }), { expanded: false, isPartial: false }, plainTheme, { ...ctx, lastComponent: component });
}

{
  const known = details({
    phase: "running",
    finalText: "",
    liveText: "",
    timeline: [{ kind: "tool", phase: "start", text: "rg {\"pattern\":\"needle\",\"path\":\"src\"}" }],
  });
  const knownRendered = plain(renderSubagentResult(result(known, "running"), { expanded: false, isPartial: true }, plainTheme, context({ isError: true })));
  assert.match(knownRendered, /rg  \/needle\/ in src\s+→ running/);

  const unknown = details({
    phase: "running",
    finalText: "",
    liveText: "",
    timeline: [{ kind: "tool", phase: "start", text: "mystery {\"password\":\"s3cr3t\",\"payload\":\"private\"}" }],
  });
  const unknownRendered = plain(renderSubagentResult(result(unknown, "running"), { expanded: false, isPartial: true }, plainTheme, context({ isError: true })));
  assert.match(unknownRendered, /mystery  called\s+→ running/);
  assert.doesNotMatch(unknownRendered, /s3cr3t|private|password/);

  const completedLs = details({
    phase: "running",
    finalText: "",
    liveText: "",
    timeline: [
      { kind: "tool", phase: "start", text: "ls src/components" },
      { kind: "tool", phase: "end", text: "ls: Button.tsx\nEditor.tsx", isError: false },
    ],
  });
  const lsRendered = plain(renderSubagentResult(result(completedLs, "running"), { expanded: false, isPartial: true }, plainTheme, context({ isError: true })));
  assert.match(lsRendered, /ls  src\/components\s+✓ done/);
  assert.doesNotMatch(lsRendered, /Button\.tsx|Editor\.tsx/);
}

{
  const run = details({ toolErrors: [{ tool: "rg", message: "recoverable failure" }] });
  const rendered = plain(renderSubagentResult(result(run), { expanded: false, isPartial: false }, plainTheme, context()), 80);
  assert.match(rendered, /^explorer \/ foreground\s+✓ done/m);
  assert.doesNotMatch(rendered, /12345678/);
  assert.match(rendered, /Finding/);
  assert.doesNotMatch(rendered, /Unique expanded tail/);
  assert.match(rendered, /1 tool error/);
  assert.match(rendered, /expand/);
}

{
  const timeline = Array.from({ length: 11 }, (_, index) => ({
    kind: index === 10 ? "assistant" : index % 2 === 0 ? "tool" : "status",
    phase: index % 2 === 0 ? "end" : undefined,
    text: index === 10 ? "DUPLICATE FINAL ANSWER" : `event-${index + 1}`,
  }));
  const run = details({
    task: "Full task text remains visible in expanded output.",
    timeline,
    toolErrors: [
      { tool: "read", message: "first failure" },
      { tool: "bash", message: "second failure" },
    ],
  });
  const rendered = plain(renderSubagentResult(result(run), { expanded: true, isPartial: false }, plainTheme, context()), 80);

  assert.match(rendered, /Full task text remains visible/);
  assert.match(rendered, /The parser preserves quoted input/);
  assert.match(rendered, /Unique expanded tail/);
  assert.doesNotMatch(rendered, /DUPLICATE FINAL ANSWER|private-artifacts|native-private-id/);
  assert.doesNotMatch(rendered, /event-[12](?:\s|$)/);
  assert.match(rendered, /event-10/);
  assert.match(rendered, /ISSUES ─+/);
  assert.match(rendered, /first failure/);
  assert.match(rendered, /second failure/);
  assert.match(rendered, /ID  subagent_12345678/);
  assert.match(rendered, /TASK ─+/);
  assert.match(rendered, /RESULT ─+/);
  assert.match(rendered, /ACTIVITY ─+/);
}

{
  const run = details({
    phase: "error",
    finalText: "",
    error: "Subagent failed: AUTH_FAILED",
    errorInfo: {
      code: "AUTH_FAILED",
      message: "Subagent authentication failed.",
      operation: "fg",
      retryable: false,
      retries: 0,
      cause: "credential rejected",
      suggestedAction: "Configure the child model.",
    },
    rawSessionOutput: "safe raw excerpt",
  });
  const collapsed = plain(renderSubagentResult(result(run, "failure"), { expanded: false, isPartial: false }, plainTheme, context()));
  assert.match(collapsed, /explorer \/ foreground\s+✗ error/);
  assert.match(collapsed, /Subagent authentication failed/);
  assert.match(collapsed, /Next  Configure the child model/);

  const expanded = plain(renderSubagentResult(result(run, "failure"), { expanded: true, isPartial: false }, plainTheme, context()));
  assert.match(expanded, /ERROR ─+/);
  assert.match(expanded, /Cause  credential rejected/);
  assert.match(expanded, /Next   Configure the child model/);
  assert.match(expanded, /safe raw excerpt/);
}

{
  const queued = details({ mode: "bg", phase: "running", finalText: "", durationMs: undefined, endedAt: undefined });
  const rendered = plain(renderSubagentResult(result(queued, "Queued background subagent"), { expanded: false, isPartial: false }, plainTheme, context()));
  assert.match(rendered, /explorer \/ background\s+— queued/);
  assert.match(rendered, new RegExp(`ID  ${queued.id}`));
}

{
  const rendered = plain(renderSubagentResult({
    content: [{ type: "text", text: "already running" }],
    details: { status: "already_running", id: "subagent_existing" },
  }, { expanded: false, isPartial: false }, plainTheme, context()));
  assert.match(rendered, /subagent \/ resumed\s+→ active/);
  assert.match(rendered, /subagent_existing/);
}

{
  const failure = plain(renderSubagentResult({
    content: [{ type: "text", text: "unsafe\x1b]0;owned\x07" }],
    details: {
      status: "error",
      error: {
        code: "UNKNOWN_AGENT",
        message: "Unknown agent api_key=s3cr3t\x1b]8;;https:\/\/evil.example\x07bad\x1b]8;;\x07",
        operation: "fg",
        retryable: false,
        retries: 0,
        suggestedAction: "Choose a configured agent.",
      },
    },
  }, { expanded: true, isPartial: false }, plainTheme, context()));
  assert.match(failure, /UNKNOWN_AGENT|Unknown agent/);
  assert.match(failure, /Choose a configured agent/);
  assert.match(failure, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(failure, /evil\.example|owned|s3cr3t|\x1b|\x07/);
}

{
  const run = details({ mode: "bg" });
  const message = {
    content: "background content",
    details: { id: run.id, status: "done", result: run },
  };
  const collapsed = plain(renderSubagentNotification(message, { expanded: false }, plainTheme), 80);
  assert.match(collapsed, /explorer \/ background \/ 12345678\s+✓ done/);
  assert.match(collapsed, /Task  Inspect the parser/);
  assert.match(collapsed, /Finding/);
  assert.doesNotMatch(collapsed, /Unique expanded tail/);

  const expandedComponent = renderSubagentNotification(message, { expanded: true }, plainTheme);
  const expandedLines = plainLines(expandedComponent, 80);
  const expanded = expandedLines.join("\n");
  assert.doesNotMatch(expandedLines[0], /12345678/);
  assert.match(expanded, /ID  subagent_12345678/);
  assert.match(expanded, /Unique expanded tail/);
  assert.match(expanded, /Inspect the parser/);
}

{
  const finished = details({
    timeline: [
      { kind: "tool", phase: "start", text: "read package.json" },
      { kind: "tool", phase: "end", text: "read: INTERNAL FILE CONTENT", isError: false },
    ],
  });
  const collapsed = renderSubagentResult(result(finished), { expanded: false, isPartial: false }, plainTheme, context());
  const collapsedLines = plainLines(collapsed, 80);
  assert.equal(visibleWidth(collapsedLines[0]), 80);
  assert.ok(collapsedLines[0].startsWith("explorer / foreground"));
  assert.ok(collapsedLines[0].endsWith("✓ done"));
  const collapsedFooter = collapsedLines.find((line) => line.includes("2 turns"));
  assert.ok(collapsedFooter);
  assert.equal(visibleWidth(collapsedFooter), 80);
  assert.ok(collapsedFooter.endsWith("expand"));

  const expanded = renderSubagentResult(result(finished), { expanded: true, isPartial: false }, plainTheme, context());
  const expandedLines = plainLines(expanded, 80);
  for (const label of ["TASK ", "RESULT ", "ACTIVITY "]) {
    const line = expandedLines.find((candidate) => candidate.startsWith(label));
    assert.ok(line, `${label.trim()} section should be present`);
    assert.equal(visibleWidth(line), 80);
    assert.match(line, /─+$/);
  }
  const ledger = expandedLines.find((line) => line.startsWith("read  package.json"));
  assert.ok(ledger);
  assert.equal(visibleWidth(ledger), 80);
  assert.ok(ledger.endsWith("✓ done"));
  assert.doesNotMatch(expandedLines.join("\n"), /INTERNAL FILE CONTENT/);
  assert.ok(expandedLines.some((line) => line.startsWith("ID  subagent_12345678")));
  assert.equal(expandedLines.filter((line) => /^─+$/.test(line)).length, 1);

  const runningNarrow = details({
    phase: "running",
    durationMs: undefined,
    endedAt: undefined,
    liveText: "",
    timeline: [{ kind: "tool", phase: "start", text: `bash ${"long-command ".repeat(8)}` }],
  });
  const narrowLines = plainLines(renderSubagentResult(
    result(runningNarrow, "running"),
    { expanded: false, isPartial: true },
    plainTheme,
    context({ isError: true }),
  ), 40);
  const toolStart = narrowLines.findIndex((line) => line.startsWith("bash  long-command"));
  assert.ok(toolStart >= 0);
  assert.ok(narrowLines.slice(toolStart + 1).some((line) => line.trim() === "→ running"));

  assertNoEmojiPresentation([...collapsedLines, ...expandedLines, ...narrowLines].join("\n"));
}

{
  const pressure = details({
    task: `Inspect ${"very-long-task-token ".repeat(30)}`,
    liveText: `# Live\n\n${"very-long-markdown-token ".repeat(60)}`,
    phase: "running",
    durationMs: undefined,
    endedAt: undefined,
    timeline: [{ kind: "tool", phase: "start", text: `bash ${"very-long-command ".repeat(20)}` }],
  });

  for (const themeName of ["pi-square-theme-dark", "pi-square-theme-light"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", `${themeName}.json`));
    for (const width of [40, 80, 120]) {
      const components = [
        renderSubagentCall({ mode: "fg", agent: "explorer", task: pressure.task, model: "provider/model" }, theme, context()),
        renderSubagentResult(result(pressure, pressure.liveText), { expanded: false, isPartial: true }, theme, context()),
        renderSubagentResult(result({ ...pressure, phase: "done", finalText: details().finalText, durationMs: 5 }), { expanded: true, isPartial: false }, theme, context()),
      ];
      for (const component of components) {
        for (const line of component.render(width)) {
          assert.ok(visibleWidth(line) <= width, `${themeName}: ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
        }
      }
    }
  }
}

console.log("subagent native rendering: all scenarios passed");
