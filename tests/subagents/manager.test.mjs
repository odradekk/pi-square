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
import { run, test } from "./lib/test-helpers.mjs";

initTheme();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { discoverSubagents } = await load(join(packageRoot, "src", "subagents", "definitions.ts"));
const { registerSubagentManager, __testables } = await load(join(packageRoot, "src", "subagents", "manager.ts"));
const { SubagentManager, buildConfigurationRequest } = __testables;
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

const theme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};

function promptSnapshot() {
  return {
    version: 2,
    system: "SECRET SYSTEM",
    instructions: "SECRET PROFILE",
    output: "SECRET OUTPUT",
    manifest: {
      contractVersion: 2,
      governanceVersion: 1,
      inheritParentSystem: true,
      effectiveSystemHash: "0123456789abcdef0123456789abcdef",
      governanceHash: "governance",
      contextCount: 0,
      fieldSources: {},
      sourceFiles: [],
      definitionHash: "definition-hash",
    },
  };
}

function runDetails(overrides = {}) {
  const id = "subagent_11111111-1111-4111-8111-111111111111";
  return {
    version: 3,
    id,
    mode: "bg",
    artifactsDir: `/tmp/${id}`,
    sessionFile: `/tmp/${id}/session.jsonl`,
    sessionId: "child-session",
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: promptSnapshot(),
    phase: "running",
    agent: { promptVersion: 2, name: "worker", inheritParentSystem: true },
    task: "Inspect files",
    cwd: packageRoot,
    startedAt: Date.now() - 1000,
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    timeline: [
      { kind: "tool", phase: "start", text: "ls src/components" },
      { kind: "tool", phase: "end", text: "ls: SECRET TOOL OUTPUT" },
    ],
    ...overrides,
  };
}

function render(component, width) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

test("manager renders responsive tabs and never exposes prompt or tool result payloads", () => {
  const details = runDetails();
  const data = {
    running: [{ id: details.id, status: "running", createdAt: 1, updatedAt: 2, details }],
    session: [{ ...details, phase: "done", finalText: "done" }],
    definitions: discoverSubagents(packageRoot).definitions,
    errors: [],
  };
  const tui = { requestRender() {}, terminal: { rows: 30 } };
  const manager = new SubagentManager(data, tui, theme, keybindings, () => {});
  const narrow = render(manager, 40);
  const wide = render(manager, 110);
  assert.match(narrow, /SUBAGENTS.*RUNNING.*SESSION/);
  assert.match(narrow, /ls src\/components/);
  assert.match(wide, /│/);
  assert.doesNotMatch(`${narrow}\n${wide}`, /SECRET SYSTEM|SECRET PROFILE|SECRET OUTPUT|SECRET TOOL OUTPUT/);
  for (const line of wide.split("\n")) assert.ok(Array.from(line).length <= 110);
});

test("manager keyboard navigation reaches definitions and emits edit action", () => {
  const actions = [];
  const data = { running: [], session: [], definitions: discoverSubagents(packageRoot).definitions.filter((item) => item.visible), errors: [] };
  const manager = new SubagentManager(data, { requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, (action) => actions.push(action));
  manager.handleInput("\x1b[C");
  manager.handleInput("\x1b[C");
  assert.match(render(manager, 80), /DEFINITIONS/);
  manager.handleInput("\r");
  assert.equal(actions[0].kind, "edit-definition");
  assert.ok(actions[0].name);
});

test("real dark and light themes stay bounded at 40, 80, and 120 columns", () => {
  const details = runDetails();
  const data = {
    running: [{ id: details.id, status: "running", createdAt: 1, updatedAt: 2, details }],
    session: [{ ...details, phase: "done", finalText: "done" }],
    definitions: discoverSubagents(packageRoot).definitions,
    errors: [],
  };
  for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const realTheme = loadThemeFromPath(join(packageRoot, "themes", file));
    for (const width of [40, 80, 120]) {
      const manager = new SubagentManager(data, { requestRender() {}, terminal: { rows: 30 } }, realTheme, keybindings, () => {});
      const lines = manager.render(width);
      assert.ok(lines.length > 5);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width}`);
      assert.doesNotMatch(lines.join("\n"), /[⌛⏳◐◌\uFE0F]/u);
    }
  }
});

test("parameterized command sends a bounded V2 guideline to the parent agent", async () => {
  const commands = new Map();
  const sent = [];
  const registry = discoverSubagents(packageRoot);
  const state = {
    registry,
    background: { jobs: new Map(), listeners: new Set() },
    refresh() {},
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage(message) { sent.push(message); },
    sendMessage() {},
    getThinkingLevel() { return "off"; },
  };
  registerSubagentManager(pi, state);
  await commands.get("subagent").handler("hide worker in this project", { cwd: packageRoot, hasUI: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Subagent V2 configuration request/);
  assert.match(sent[0], /promptVersion: 2/);
  assert.match(sent[0], /hide worker in this project$/);
  assert.doesNotMatch(sent[0], /SECRET|PROFILE INSTRUCTIONS|OUTPUT CONTRACT/);
});

test("no-argument command opens the native manager for a stable parent session", async () => {
  const commands = new Map();
  let customCalls = 0;
  const state = {
    registry: discoverSubagents(packageRoot),
    background: { jobs: new Map(), listeners: new Set() },
    refresh() {},
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage() { throw new Error("must not send a user message"); },
    sendMessage() {},
    getThinkingLevel() { return "off"; },
  };
  registerSubagentManager(pi, state);
  await commands.get("subagent").handler("", {
    cwd: packageRoot,
    hasUI: true,
    sessionManager: { getSessionId() { return "parent-manager-session"; } },
    ui: {
      async custom() { customCalls += 1; return { kind: "close" }; },
      notify() {},
    },
  });
  assert.equal(customCalls, 1);
});

test("configuration request reports effective scopes without embedding prompt bodies", () => {
  const request = buildConfigurationRequest(discoverSubagents(packageRoot), packageRoot, "edit explorer");
  assert.match(request, /Current effective definitions/);
  assert.match(request, /resources\/subagents\/explorer\.yaml/);
  assert.doesNotMatch(request, /Operate as a read-only workspace explorer/);
});

await run();
