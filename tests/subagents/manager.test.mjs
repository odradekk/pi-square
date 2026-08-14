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
  assert.match(narrow, /^● Subagents/m);
  assert.match(narrow, /RUNNING.*SESSION.*DEFINITIONS/);
  assert.match(narrow, /ls src\/components/);
  assert.match(wide, /│/);
  assert.equal(managerPanelWidth(40), 40);
  assert.equal(managerPanelWidth(120), 100);
  assert.doesNotMatch(`${narrow}\n${wide}`, /SECRET SYSTEM|SECRET PROFILE|SECRET OUTPUT|SECRET TOOL OUTPUT/);
  for (const line of wide.split("\n")) assert.ok(Array.from(line).length <= 100);
  manager.dispose();
});

test("manager activity uses specialized GitHub summaries", () => {
  const github = runDetails({
    timeline: [{ kind: "tool", phase: "start", text: "github {\"operation\":\"read\",\"repo\":\"owner/name\",\"path\":\"README.md\",\"ref\":\"main\",\"token\":\"private\"}" }],
  });
  const githubManager = new SubagentManager(data({
    running: [{ id: github.id, status: "running", createdAt: 1, updatedAt: 2, details: github }],
  }), tui(), theme, keybindings, () => {});
  const githubRendered = render(githubManager, 100);
  assert.match(githubRendered, /Activity: github owner\/name:README.md @main/);
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
  assert.match(activeRendered, /is active and cannot/);
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

test("cancel review flow calls the cancel service and shows the success flash", () => {
  const job = { id: "subagent_22222222-2222-4222-8222-222222222222", status: "running", createdAt: 1, updatedAt: 2, details: runDetails() };
  const initial = data({ running: [job], session: [] });
  const fake = fakeServices(initial);
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.focused = true;
  manager.handleInput("\r");
  assert.match(render(manager, 80), /RUNNING \/ CANCEL/);
  assert.match(render(manager, 80), /Cancel/);
  assert.match(render(manager, 80), /cancel job/);
  manager.handleInput("\r");
  assert.deepEqual(fake.calls.find((call) => call[0] === "cancel"), ["cancel", job.id]);
  assert.match(render(manager, 80), /\u2713/);
  assert.match(render(manager, 80), /Cancellation requested/);
  assert.equal(closed, 0);
  manager.dispose();
});

test("delete history review flow requires its own confirmation and uses colon label grammar", () => {
  const finished = runDetails({ id: "subagent_33333333-3333-4333-8333-333333333333", phase: "done", finalText: "done" });
  const initial = data({ running: [], session: [finished] });
  const fake = fakeServices(initial);
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.focused = true;
  manager.handleInput("\x1b[C");
  manager.handleInput("d");
  assert.match(render(manager, 80), /SESSION \/ DELETE/);
  assert.match(render(manager, 80), /Delete history/);
  assert.match(render(manager, 80), /Agent:/);
  assert.match(render(manager, 80), /Task:/);
  assert.match(render(manager, 80), /delete history/);
  manager.handleInput("\r");
  assert.deepEqual(fake.calls.find((call) => call[0] === "delete-history"), ["delete-history", finished.id]);
  assert.match(render(manager, 80), /\u2713/);
  assert.match(render(manager, 80), /Deleted history/);
  assert.equal(closed, 0);
  manager.dispose();
});

test("fresh run review flow from session tab queues a new child", () => {
  const finished = runDetails({ id: "subagent_44444444-4444-4444-8444-444444444444", phase: "done", finalText: "done" });
  const initial = data({ running: [], session: [finished] });
  const fake = fakeServices(initial);
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.focused = true;
  manager.handleInput("\x1b[C");
  manager.handleInput("f");
  assert.match(render(manager, 80), /SESSION \/ FRESH/);
  for (const character of "New task") manager.handleInput(character);
  manager.handleInput("\r");
  assert.match(render(manager, 80), /SESSION \/ FRESH \/ REVIEW/);
  assert.match(render(manager, 80), /New task/);
  manager.handleInput("\r");
  assert.deepEqual(fake.calls.find((call) => call[0] === "fresh"), ["fresh", finished.id, "New task"]);
  assert.match(render(manager, 80), /\u2713/);
  assert.match(render(manager, 80), /Queued fresh/);
  assert.equal(closed, 0);
  manager.dispose();
});

test("declining a destructive review returns to browse without calling any service", () => {
  const job = { id: "subagent_55555555-5555-4555-8555-555555555555", status: "running", createdAt: 1, updatedAt: 2, details: runDetails() };
  const initial = data({ running: [job], session: [] });
  const fake = fakeServices(initial);
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.handleInput("\r");
  assert.match(render(manager, 80), /RUNNING \/ CANCEL/);
  manager.handleInput("\x1b");
  assert.match(render(manager, 80), /RUNNING.*SESSION.*DEFINITIONS/);
  assert.equal(fake.calls.some((call) => call[0] === "cancel"), false);
  assert.equal(closed, 0);
  manager.dispose();
});

test("declining delete-history review preserves the session entry", () => {
  const finished = runDetails({ id: "subagent_99999999-9999-4999-8999-999999999999", phase: "done", finalText: "done" });
  const initial = data({ running: [], session: [finished] });
  const fake = fakeServices(initial);
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.focused = true;
  manager.handleInput("\x1b[C");
  manager.handleInput("d");
  assert.match(render(manager, 80), /SESSION \/ DELETE/);
  manager.handleInput("\x1b");
  assert.match(render(manager, 80), /RUNNING.*SESSION.*DEFINITIONS/);
  assert.equal(fake.calls.some((call) => call[0] === "delete-history"), false);
  assert.equal(closed, 0);
  manager.dispose();
});

test("failed cancel operation shows error flash and preserves browse state on back", () => {
  const job = { id: "subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "running", createdAt: 1, updatedAt: 2, details: runDetails() };
  const initial = data({ running: [job], session: [] });
  const fake = fakeServices(initial, {
    cancel() { return { ok: false, message: "Job is no longer active." }; },
  });
  let closed = 0;
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => { closed += 1; }, fake.services);
  manager.handleInput("\r");
  assert.match(render(manager, 80), /RUNNING \/ CANCEL/);
  manager.handleInput("\r");
  const text = render(manager, 80);
  assert.match(text, /\u2717/);
  assert.match(text, /no longer active/);
  manager.handleInput("\x1b");
  assert.match(render(manager, 80), /RUNNING.*SESSION.*DEFINITIONS/);
  assert.equal(closed, 0);
  manager.dispose();
});

test("error flash from a failed operation shows the \u2717 marker", () => {
  const stale = runDetails({ phase: "running" });
  const activeData = data({ running: [], session: [stale], activeSessionIds: [stale.id] });
  const manager = new SubagentManager(activeData, tui(), theme, keybindings, () => {});
  manager.handleInput("\x1b[C");
  manager.handleInput("\r");
  assert.match(render(manager, 100), /\u2717/);
  manager.dispose();
});

test("list rows show operational lifecycle markers", () => {
  const queued = { id: "subagent_66666666-6666-4666-8666-666666666666", status: "queued", createdAt: 1, updatedAt: 2, details: runDetails() };
  const running = { id: "subagent_77777777-7777-4777-8777-777777777777", status: "running", createdAt: 1, updatedAt: 2, details: runDetails() };
  const cancelling = { id: "subagent_88888888-8888-4888-8888-888888888888", status: "cancelling", createdAt: 1, updatedAt: 2, details: runDetails() };
  const initial = data({ running: [queued, running, cancelling], session: [] });
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => {});
  const text = render(manager, 120);
  assert.match(text, /\u2013 queued/);
  assert.match(text, /\u2192 running/);
  assert.match(text, /\u00d7 cancelling/);
  manager.dispose();
});

test("session tab shows operational lifecycle markers for each phase", () => {
  const done = runDetails({ id: "subagent_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", phase: "done", finalText: "done" });
  const errored = runDetails({ id: "subagent_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", phase: "error", error: "failed" });
  const aborted = runDetails({ id: "subagent_cccccccc-3333-4333-8333-cccccccccccc", phase: "aborted" });
  const initial = data({ running: [], session: [done, errored, aborted], activeSessionIds: [] });
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => {});
  manager.handleInput("\x1b[C");
  const text = render(manager, 120);
  assert.match(text, /\u2713 done/);
  assert.match(text, /\u2717 error/);
  assert.match(text, /\u00d7 aborted/);
  manager.dispose();
});

test("inactive stale running session shows marker with inactive suffix", () => {
  const stale = runDetails({ id: "subagent_dddddddd-4444-4444-8444-dddddddddddd", phase: "running" });
  const initial = data({ running: [], session: [stale], activeSessionIds: [] });
  const manager = new SubagentManager(initial, tui(), theme, keybindings, () => {});
  manager.handleInput("\x1b[C");
  const text = render(manager, 120);
  assert.match(text, /\u2192 running \(inactive\)/);
  manager.dispose();
});

await run();
