import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayController } = await load("../../src/display/index.ts");
const { default: registerDisplayBuiltins } = await load("../../src/display/builtins.ts");
const { default: registerAnchoredReplace } = await load("../../src/anchored-edit/workspace-replace.ts");
const { default: registerAnchoredInsert } = await load("../../src/anchored-edit/workspace-insert.ts");

const KNOWN_PI_TOOL_DISPLAY = Symbol.for("pi-tool-display.api.v1");

const ctxFor = (cwd) => ({
  cwd,
  sessionManager: {
    getSessionDir: () => join(cwd, ".test-session"),
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
  hasUI: false,
  isProjectTrusted() { return false; },
  ui: { setStatus() {} },
});

const BUILTIN = { path: "<builtin>", source: "built-in", scope: "temporary", origin: "top-level" };
const BUILTINS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
// The ownership check identifies this extension through its own probe tools.
const PROBES = ["pdf_search", "delegate_subagent", "todo"];

/**
 * The production wiring of `src/index.ts`: both anchored mutation registrars
 * receive the one availability flag the builtins registration computes, so
 * their registration gates are identical by construction.
 */
function createHarness(config) {
  const events = new Map();
  const definitions = new Map();
  let active = ["read", "edit", "write"];
  const pi = {
    registerTool(definition) {
      definitions.set(definition.name, definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
    getAllTools() {
      return [
        ...PROBES.map((name) => ({ name, description: "", parameters: {}, sourceInfo: OWN })),
        ...BUILTINS.map((name) => ({ name, description: "", parameters: {}, sourceInfo: definitions.has(name) ? OWN : BUILTIN })),
      ];
    },
  };
  const controller = new DisplayController(config);
  let anchoredReadAvailable = false;
  registerDisplayBuiltins(pi, controller, (available) => { anchoredReadAvailable = available; });
  registerAnchoredReplace(pi, () => controller.config, () => controller.runtime, () => anchoredReadAvailable);
  registerAnchoredInsert(pi, () => controller.config, () => controller.runtime, () => anchoredReadAvailable);
  return { events, definitions, controller, availability: () => anchoredReadAvailable };
}

const OWN = { path: "/package/src/index.ts", source: "@odradekk/pi-square", scope: "user", origin: "package" };

async function start(harness, cwd) {
  for (const handler of harness.events.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctxFor(cwd));
  }
}

/** Both registrars expose the same session_start gate; this harness drives
 * them directly through the availability seam `src/index.ts` wires. */
function createRegistrarHarness(config, available) {
  const events = new Map();
  const definitions = new Map();
  const pi = {
    registerTool(definition) { definitions.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
  };
  registerAnchoredReplace(pi, () => config, undefined, available);
  registerAnchoredInsert(pi, () => config, undefined, available);
  return { events, definitions };
}

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-insert-gates-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

try {
  // ── Anchored editing explicitly disabled: neither mutation registers. ──
  {
    const disabledConfig = { ...DEFAULT_CONFIG, anchoredEditing: { enabled: false, autoRead: true } };
    const off = createHarness(disabledConfig);
    await start(off, workspace);
    assert.equal(off.definitions.get("insert"), undefined, "disabled anchored editing registers no insert tool");
    assert.equal(off.definitions.get("replace"), undefined, "disabled anchored editing registers no replace tool");
    off.controller.dispose();
  }

  // ── Anchored-read ownership conflict: the shared availability flag closes
  //    the gate for insert exactly as it does for replace. ──
  {
    Object.defineProperty(globalThis, KNOWN_PI_TOOL_DISPLAY, { value: {}, configurable: true });
    try {
      const conflicted = createHarness({ ...DEFAULT_CONFIG, anchoredEditing: { enabled: true, autoRead: true } });
      await start(conflicted, workspace);
      assert.equal(conflicted.definitions.get("insert"), undefined, "insert is unavailable when the anchored read override is blocked");
      assert.equal(conflicted.definitions.get("replace"), undefined, "replace is unavailable when the anchored read override is blocked");
      conflicted.controller.dispose();
    } finally {
      delete globalThis[KNOWN_PI_TOOL_DISPLAY];
    }
  }

  // ── Default configuration: both register and render through the shared
  //    production display path. ──
  {
    const on = createHarness({ ...DEFAULT_CONFIG, anchoredEditing: { enabled: true, autoRead: true } });
    await start(on, workspace);
    const insert = on.definitions.get("insert");
    assert.ok(insert, "default anchored editing registers insert");
    assert.equal(insert.renderShell, "self", "insert uses the shared operational display shell");
    assert.equal(typeof insert.renderCall, "function", "insert renders calls through the production decoration path");
    assert.equal(typeof insert.renderResult, "function", "insert renders results through the production decoration path");
    assert.equal(on.definitions.has("replace"), true, "replace registers alongside insert under the same gate");
    on.controller.dispose();
  }

  // ── The availability seam alone (store/readiness unavailable through the
  //    shared flag): the registrar skips registration, and replace and insert
  //    agree in every combination — the same gate. ──
  for (const enabled of [true, false]) {
    for (const available of [true, false]) {
      const config = { ...DEFAULT_CONFIG, anchoredEditing: { enabled, autoRead: true } };
      const harness = createRegistrarHarness(config, () => available);
      for (const handler of harness.events.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, ctxFor(workspace));
      }
      const insertRegistered = harness.definitions.has("insert");
      const replaceRegistered = harness.definitions.has("replace");
      assert.equal(
        insertRegistered,
        enabled && available,
        `insert registration must be enabled=${enabled} AND available=${available}`,
      );
      assert.equal(
        insertRegistered,
        replaceRegistered,
        `insert and replace share one gate (enabled=${enabled}, available=${available})`,
      );
      if (enabled && !available) {
        assert.equal(insertRegistered, false, "insert stays unregistered when the store/readiness availability flag is closed");
      }
    }
  }

  console.log("anchored insert registration gate tests: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
