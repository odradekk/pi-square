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
const {
  SubagentManager,
  managerPanelWidth,
  managerRowBudget,
} = __testables;
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

function data(overrides = {}) {
  const details = runDetails();
  return {
    running: [{ id: details.id, status: "running", createdAt: 1, updatedAt: 2, details }],
    session: [{ ...details, phase: "done", finalText: "done" }],
    activeSessionIds: [],
    definitions: discoverSubagents(packageRoot).definitions,
    errors: [],
    ...overrides,
  };
}

function tui(rows = 30) {
  return { requestRender() {}, terminal: { rows } };
}

function render(component, width) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function fakeServices(initialData, overrides = {}) {
  let current = initialData;
  const calls = [];
  const services = {
    refresh() { return current; },
    subscribe() { return () => {}; },
    cancel(id) { calls.push(["cancel", id]); return { ok: true, message: "Cancellation requested." }; },
    queueResume(id, task) {
      calls.push(["resume", id, task]);
      const source = current.session.find((item) => item.id === id);
      const details = { ...source, phase: "running", mode: "resume", task };
      current = { ...current, running: [{ id, status: "queued", createdAt: 1, updatedAt: 1, details }] };
      return { ok: true, message: "Queued resume.", selectedId: id };
    },
    queueFresh(id, task) { calls.push(["fresh", id, task]); return { ok: true, message: "Queued fresh.", selectedId: id }; },
    deleteHistory(id) { calls.push(["delete-history", id]); return { ok: true, message: "Deleted history." }; },
    preview(scope, patch) {
      calls.push(["preview", scope, patch]);
      const before = current.definitions.find((definition) => definition.name === patch.name);
      return {
        content: `promptVersion: 2\nname: ${patch.name}\ndescription: ${patch.description ?? before?.description ?? ""}\n`,
        filePath: `${packageRoot}/.pi/subagents/${patch.name}.yaml`,
        definition: { ...before, ...patch, source: scope },
        errors: [],
      };
    },
    save(scope, patch, filePath) { calls.push(["save", scope, patch, filePath]); return { ok: true, message: "Saved overlay." }; },
    deleteOverlay(definition, scope, filePath) { calls.push(["delete-overlay", definition.name, scope, filePath]); return { ok: true, message: "Deleted overlay." }; },
    ...overrides,
  };
  return { services, calls, getData: () => current };
}

test("manager is an adaptive non-card workbench and never exposes prompt or tool result payloads", () => {
  const manager = new SubagentManager(data(), tui(), theme, keybindings, () => {});
  const narrow = render(manager, 40);
  const wide = render(manager, 120);
  assert.match(narrow, /^◆ SUBAGENTS/m);
  assert.match(narrow, /RUNNING.*SESSION.*DEFINITIONS/);
  assert.match(narrow, /ls src\/components/);
  assert.match(wide, /│/);
  assert.equal(managerPanelWidth(40), 40);
  assert.equal(managerPanelWidth(120), 100);
  assert.doesNotMatch(`${narrow}\n${wide}`, /SECRET SYSTEM|SECRET PROFILE|SECRET OUTPUT|SECRET TOOL OUTPUT/);
  for (const line of wide.split("\n")) assert.ok(Array.from(line).length <= 100);
  manager.dispose();
});

test("manager activity uses specialized sg and GitHub summaries", () => {
  const sg = runDetails({
    timeline: [{ kind: "tool", phase: "start", text: "sg {\"kind\":\"identifier\",\"path\":\"src\",\"password\":\"private\"}" }],
  });
  const manager = new SubagentManager(data({
    running: [{ id: sg.id, status: "running", createdAt: 1, updatedAt: 2, details: sg }],
  }), tui(), theme, keybindings, () => {});
  const rendered = render(manager, 100);
  assert.match(rendered, /ACTIVITY  sg kind:identifier in src/);
  assert.doesNotMatch(rendered, /password|private/);
  manager.dispose();

  const github = runDetails({
    timeline: [{ kind: "tool", phase: "start", text: "github_read {\"repo\":\"owner/name\",\"path\":\"README.md\",\"ref\":\"main\",\"token\":\"private\"}" }],
  });
  const githubManager = new SubagentManager(data({
    running: [{ id: github.id, status: "running", createdAt: 1, updatedAt: 2, details: github }],
  }), tui(), theme, keybindings, () => {});
  const githubRendered = render(githubManager, 100);
  assert.match(githubRendered, /ACTIVITY  github_read owner\/name:README.md @main/);
  assert.doesNotMatch(githubRendered, /token|private/);
  githubManager.dispose();
});

test("manager keeps resume task, review, and queueing inside one focused component", () => {
  const finished = runDetails({ phase: "done", finalText: "done" });
  const initial = data({ running: [], session: [finished] });
  const fake = fakeServices(initial);
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.focused = true;
  manager.handleInput("\x1b[C");
  manager.handleInput("\r");
  assert.match(render(manager, 80), /SESSION \/ RESUME/);
  for (const character of "Continue with evidence") manager.handleInput(character);
  manager.handleInput("\r");
  assert.match(render(manager, 80), /SESSION \/ RESUME \/ REVIEW/);
  assert.match(render(manager, 80), /Continue with evidence/);
  manager.handleInput("\r");
  assert.deepEqual(fake.calls.find((call) => call[0] === "resume"), ["resume", finished.id, "Continue with evidence"]);
  assert.match(render(manager, 80), /RUNNING/);
  assert.match(render(manager, 80), /Queued resume/);
  assert.equal(closed, 0);
  manager.dispose();
});

test("manager blocks active leases but permits inactive stale running sessions", () => {
  const stale = runDetails({ phase: "running" });
  const staleData = data({ running: [], session: [stale], activeSessionIds: [] });
  const staleManager = new SubagentManager(staleData, tui(), theme, keybindings, () => {}, fakeServices(staleData).services);
  staleManager.handleInput("\x1b[C");
  staleManager.handleInput("\r");
  assert.match(render(staleManager, 80), /SESSION \/ RESUME/);
  staleManager.dispose();

  const activeData = data({ running: [], session: [stale], activeSessionIds: [stale.id] });
  const activeFake = fakeServices(activeData);
  const activeManager = new SubagentManager(activeData, tui(), theme, keybindings, () => {}, activeFake.services);
  activeManager.handleInput("\x1b[C");
  assert.match(render(activeManager, 100), /resume unavailable while active/);
  activeManager.handleInput("\r");
  const activeRendered = render(activeManager, 100);
  assert.match(activeRendered, /is active and cannot b/);
  assert.match(activeRendered, /resume unavailable while active/);
  assert.doesNotMatch(activeRendered, /SESSION \/ RESUME/);
  assert.equal(activeFake.calls.some((call) => call[0] === "resume"), false);
  activeManager.dispose();
});

test("definition overlay editing stays in manager through scope, field, mode, editor, and review", () => {
  const initial = data({ running: [], session: [] });
  const fake = fakeServices(initial);
  const manager = new SubagentManager(initial, tui(36), theme, keybindings, () => {}, fake.services);
  manager.focused = true;
  manager.handleInput("\x1b[C");
  manager.handleInput("\x1b[C");
  manager.handleInput("\r");
  assert.match(render(manager, 100), /DEFINITIONS \/ SCOPE/);
  manager.handleInput("\r");
  assert.match(render(manager, 100), /DEFINITIONS \/ FIELD/);
  manager.handleInput("\r");
  assert.match(render(manager, 100), /DEFINITIONS \/ OVERLAY/);
  manager.handleInput("\x1b[B");
  manager.handleInput("\r");
  assert.match(render(manager, 100), /DEFINITIONS \/ VALUE/);
  manager.handleInput("\r");
  assert.match(render(manager, 100), /DEFINITIONS \/ REVIEW/);
  manager.handleInput("\r");
  assert.ok(fake.calls.some((call) => call[0] === "save"));
  assert.match(render(manager, 100), /Saved overlay/);
  manager.dispose();
});

test("escape walks back through manager history before restoring the editor", () => {
  let closed = 0;
  const initial = data({ running: [], session: [] });
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fakeServices(initial).services);
  manager.handleInput("\x1b[C");
  manager.handleInput("\x1b[C");
  manager.handleInput("\r");
  assert.match(render(manager, 80), /DEFINITIONS \/ SCOPE/);
  manager.handleInput("\x1b");
  assert.match(render(manager, 80), /RUNNING.*SESSION.*DEFINITIONS/);
  assert.equal(closed, 0);
  manager.handleInput("\x1b");
  assert.equal(closed, 1);
  manager.dispose();
});

test("real dark and light themes stay bounded across widths and low terminal heights", () => {
  const initial = data();
  for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const realTheme = loadThemeFromPath(join(packageRoot, "themes", file));
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      for (const rows of [18, 30]) {
        const manager = new SubagentManager(initial, tui(rows), realTheme, keybindings, () => {});
        const lines = manager.render(width);
        assert.ok(lines.length <= managerRowBudget(rows));
        assert.ok(lines.length >= 5);
        for (const line of lines) assert.ok(visibleWidth(line) <= managerPanelWidth(width), `${file} exceeded ${width}`);
        assert.doesNotMatch(lines.join("\n"), /[⌛⏳◐◌\uFE0F]/u);
        manager.dispose();
      }
    }
  }
});

test("parameterized command emits a custom guide then the raw user request as one follow-up turn", async () => {
  const commands = new Map();
  const renderers = new Map();
  const events = [];
  const state = {
    registry: discoverSubagents(packageRoot),
    background: { jobs: new Map(), listeners: new Set() },
    refresh() {},
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
    sendMessage(message, options) { events.push(["guide", message, options]); },
    sendUserMessage(message, options) { events.push(["user", message, options]); },
    getThinkingLevel() { return "off"; },
  };
  registerSubagentManager(pi, state);
  await commands.get("subagent").handler("hide worker in this project", { cwd: packageRoot, hasUI: true });
  assert.equal(renderers.has("pi-square.subagent-config-guide"), true);
  assert.deepEqual(events.map((event) => event[0]), ["guide", "user"]);
  assert.equal(events[0][1].customType, "pi-square.subagent-config-guide");
  assert.match(events[0][1].content, /Subagent Config Guide/);
  assert.match(events[0][1].content, /promptVersion: 2/);
  assert.doesNotMatch(events[0][1].content, /hide worker in this project|Operate as a read-only workspace explorer/);
  assert.equal(events[0][2].deliverAs, "followUp");
  assert.equal(events[0][2].triggerTurn, undefined);
  assert.equal(events[1][1], "hide worker in this project");
  assert.equal(events[1][2].deliverAs, "followUp");
});

test("no-argument command opens one non-overlay manager for a stable parent session", async () => {
  const commands = new Map();
  let customCalls = 0;
  let customOptions = "unset";
  const state = {
    registry: discoverSubagents(packageRoot),
    background: { jobs: new Map(), listeners: new Set() },
    refresh() {},
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer() {},
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
      async custom(_factory, options) { customCalls += 1; customOptions = options; },
      notify() {},
    },
  });
  assert.equal(customCalls, 1);
  assert.equal(customOptions, undefined);
});

await run();
