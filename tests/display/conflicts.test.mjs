import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { default: registerDisplayBuiltins } = await load("../../src/display/builtins.ts");
const KNOWN_MARKER = Symbol.for("pi-tool-display.api.v1");
const OWN = { path: "/package/src/index.ts", source: "@odradekk/pi-square", scope: "user", origin: "package" };
const BUILTIN = { path: "<builtin>", source: "built-in", scope: "temporary", origin: "top-level" };
const EXTERNAL = { path: "/other/extension.ts", source: "other", scope: "user", origin: "top-level" };
const BUILTINS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const PROBES = ["pdf_search", "codegraph", "delegate", "todo"];

function createHarness(options = {}) {
  const events = new Map();
  const definitions = new Map();
  const statuses = [];
  const activeSnapshots = [];
  let active = [...(options.active ?? ["read", "edit", "bash", "todo"])];
  const earlier = new Set(options.earlier ?? []);
  const pi = {
    registerTool(definition) {
      definitions.set(definition.name, definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    on(name, handler) {
      const list = events.get(name) ?? [];
      list.push(handler);
      events.set(name, list);
    },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; activeSnapshots.push([...names]); },
    getAllTools() {
      const tools = PROBES.map((name) => ({ name, description: "", parameters: {}, sourceInfo: OWN }));
      for (const name of BUILTINS) {
        const sourceInfo = earlier.has(name) ? EXTERNAL : definitions.has(name) ? OWN : BUILTIN;
        tools.push({ name, description: "", parameters: {}, sourceInfo });
      }
      return tools;
    },
  };
  const diagnostics = [];
  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const controller = {
    runtime,
    setDiagnostics(value) { diagnostics.splice(0, diagnostics.length, ...value); },
  };
  registerDisplayBuiltins(pi, controller);
  return { pi, events, definitions, statuses, activeSnapshots, diagnostics, runtime, get active() { return active; } };
}

async function emit(harness, name, ctx) {
  for (const handler of harness.events.get(name) ?? []) await handler({ reason: "test" }, ctx);
}

function context(cwd, statuses, hasUI = true) {
  return {
    cwd,
    mode: "tui",
    hasUI,
    isProjectTrusted() { return false; },
    ui: { setStatus(key, value) { statuses.push({ key, value }); } },
  };
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const temp = mkdtempSync(join(tmpdir(), "pi-square-conflicts-"));
const agentDir = join(temp, "agent");
const cwd = join(temp, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  {
    const harness = createHarness();
    const originalActive = [...harness.active];
    await emit(harness, "session_start", context(cwd, harness.statuses));
    assert.deepEqual([...harness.definitions.keys()].sort(), BUILTINS.slice().sort());
    assert.deepEqual(harness.active, originalActive, "active tools were not restored exactly");
    assert.deepEqual(harness.diagnostics, []);
    assert.deepEqual(harness.statuses.at(-1), { key: "pi-square.display", value: undefined });
    assert.ok(harness.activeSnapshots.length > 0, "test harness did not exercise active-tool restoration");
    harness.runtime.dispose();
  }

  {
    const harness = createHarness({ earlier: ["edit", "write"] });
    await emit(harness, "session_start", context(cwd, harness.statuses));
    assert.equal(harness.diagnostics.length, 1);
    assert.match(harness.diagnostics[0], /edit, write/);
    assert.doesNotMatch(harness.diagnostics[0], /read|grep|find|ls|bash/);
    assert.match(harness.statuses.at(-1).value, /ownership conflict/);
    await emit(harness, "session_shutdown", context(cwd, harness.statuses));
    assert.deepEqual(harness.diagnostics, []);
    assert.deepEqual(harness.statuses.at(-1), { key: "pi-square.display", value: undefined });
    harness.runtime.dispose();
  }

  {
    globalThis[KNOWN_MARKER] = { version: 1 };
    const harness = createHarness();
    await emit(harness, "session_start", context(cwd, harness.statuses));
    assert.equal(harness.definitions.size, 0);
    assert.match(harness.diagnostics[0], /all Pi built-in display overrides are blocked/);
    delete globalThis[KNOWN_MARKER];
    harness.runtime.dispose();
  }

  {
    writeFileSync(join(agentDir, "settings.json"), "{ invalid-json", { mode: 0o600 });
    const harness = createHarness();
    await emit(harness, "session_start", context(cwd, harness.statuses));
    assert.equal(harness.definitions.has("read"), false);
    assert.equal(harness.definitions.has("bash"), false);
    assert.deepEqual([...harness.definitions.keys()].sort(), ["edit", "find", "grep", "ls", "write"]);
    assert.match(harness.diagnostics[0], /settings invalid; read\/bash display overrides blocked/);
    harness.runtime.dispose();
    rmSync(join(agentDir, "settings.json"), { force: true });
  }

  console.log("display built-in conflict and settings tests: OK");
} finally {
  delete globalThis[KNOWN_MARKER];
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(temp, { recursive: true, force: true });
}
