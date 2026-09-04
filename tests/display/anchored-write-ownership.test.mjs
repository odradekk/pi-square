import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { default: registerDisplayBuiltins } = await load("../../src/display/builtins.ts");
const { createParentAnchoredWrite } = await load("../../src/anchored-edit/auto-read.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
const { loadAnchoredHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

const OWN = { path: "/package/src/index.ts", source: "@odradekk/pi-square", scope: "user", origin: "package" };
const BUILTIN = { path: "<builtin>", source: "built-in", scope: "temporary", origin: "top-level" };
const EXTERNAL = { path: "/other/extension.ts", source: "other", scope: "user", origin: "top-level" };
const BUILTINS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
// Extension tools registered by pi-square; ownSource() identifies our source
// through them.
const PROBES = ["pdf_search", "delegate_subagent", "todo"];

function createHarness(options = {}) {
  const events = new Map();
  const definitions = new Map();
  const statuses = [];
  let active = [...(options.active ?? ["read", "write"])];
  const earlier = new Set(options.earlier ?? []);
  let anchoredReadAvailable;
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
    setActiveTools(names) { active = [...names]; },
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
  // The controller's config is a getter on the real DisplayController; the
  // harness mirrors that shape (a plain function-valued property would read
  // as undefined through `controller.config`).
  const configValue = {
    ...DEFAULT_CONFIG,
    anchoredEditing: { enabled: true, autoRead: true },
  };
  const controller = {
    runtime,
    get config() { return configValue; },
    setDiagnostics(value) { diagnostics.splice(0, diagnostics.length, ...value); },
  };
  const parentAnchoredWrite = createParentAnchoredWrite(() => configValue);
  registerDisplayBuiltins(
    pi,
    controller,
    (available) => { anchoredReadAvailable = available; },
    [],
    parentAnchoredWrite,
  );
  return { pi, events, definitions, statuses, diagnostics, runtime, parentAnchoredWrite, get anchoredReadAvailable() { return anchoredReadAvailable; } };
}

async function emit(harness, name, ctx) {
  for (const handler of harness.events.get(name) ?? []) await handler({ reason: "test" }, ctx);
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const temp = mkdtempSync(join(tmpdir(), "pi-square-write-ownership-"));
const agentDir = join(temp, "agent");
const cwd = join(temp, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const sessionDir = join(cwd, ".test-session");
const storeDir = anchoredStoreDir(sessionDir, realpathSync(cwd));
const ctx = (statuses) => ({
  cwd,
  mode: "tui",
  hasUI: true,
  isProjectTrusted() { return false; },
  ui: { setStatus(key, value) { statuses.push({ key, value }); } },
  sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => "test-session", getSessionFile: () => undefined },
});

async function locksEntries() {
  try {
    return readdirSync(join(storeDir, "locks"));
  } catch {
    return [];
  }
}

try {
  {
    // Complete anchored surface: the write runs anchored — lock engaged and
    // released, state published, outcome recorded for the presentation.
    const harness = createHarness();
    const target = join(cwd, "anchored.txt");
    writeFileSync(target, "before\n");
    await emit(harness, "session_start", ctx(harness.statuses));
    assert.equal(harness.anchoredReadAvailable, true, "the anchored read is available without conflicts");
    const write = harness.definitions.get("write");
    const result = await write.execute("w1", { path: "anchored.txt", content: "after\n" }, undefined, undefined, ctx(harness.statuses));
    assert.match(result.content[0].text, /Successfully wrote/);
    assert.equal(await readFile(target, "utf8"), "after\n");
    const store = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
    try {
      const lookup = store.getServedState(realpathSync(target), "after\n");
      assert.ok(lookup !== undefined && "served" in lookup, "an available anchored write publishes served rows");
    } finally {
      store.release();
    }
    assert.equal((await locksEntries()).length, 0, "the lock was released");
    const outcome = harness.parentAnchoredWrite.current().takeOutcome("w1");
    assert.ok(outcome?.appendix?.includes("Auto-read"), "the anchored write recorded its outcome for presentation");
  }

  {
    // An external extension owns only `read`: the anchored surface is
    // incomplete, so the write must be entirely plain-native — no lock, no
    // store mutation, no outcome (#264). The reviewer's half-activation
    // scenario: previously the write still locked, store-wrote, and recorded
    // an outcome while its presentation was skipped.
    const harness = createHarness({ earlier: ["read"] });
    const target = join(cwd, "plain.txt");
    writeFileSync(target, "before\n");
    rmSync(join(storeDir, "locks"), { recursive: true, force: true });
    await emit(harness, "session_start", ctx(harness.statuses));
    assert.equal(harness.anchoredReadAvailable, false, "the read ownership conflict disables the anchored read");
    const write = harness.definitions.get("write");
    const result = await write.execute("w2", { path: "plain.txt", content: "after\n" }, undefined, undefined, ctx(harness.statuses));
    assert.match(result.content[0].text, /Successfully wrote/);
    assert.equal(await readFile(target, "utf8"), "after\n");
    assert.equal((await locksEntries()).length, 0, "no anchored lock was ever taken");
    const store = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
    try {
      assert.equal(
        store.getServedState(realpathSync(target), "after\n"),
        undefined,
        "no anchored state was written",
      );
    } finally {
      store.release();
    }
    assert.equal(
      harness.parentAnchoredWrite.current().takeOutcome("w2"),
      undefined,
      "no anchored outcome was recorded",
    );
    // tool_call/tool_result presentation handlers stay inert for this write.
    await emit(harness, "tool_call", { toolName: "write", toolCallId: "w2", input: { path: "plain.txt", content: "after\n" }, cwd });
    await emit(harness, "tool_result", { toolName: "write", toolCallId: "w2", input: { path: "plain.txt", content: "after\n" }, content: result.content, details: result.details, isError: false, cwd });
  }

  {
    // An external extension owns only `write`: same complete fallback.
    const harness = createHarness({ earlier: ["write"] });
    const target = join(cwd, "plain-two.txt");
    writeFileSync(target, "before\n");
    await emit(harness, "session_start", ctx(harness.statuses));
    assert.ok(harness.diagnostics.some((entry) => /write/.test(entry)), "the write conflict is diagnosed");
    const write = harness.definitions.get("write");
    const result = await write.execute("w3", { path: "plain-two.txt", content: "after\n" }, undefined, undefined, ctx(harness.statuses));
    assert.match(result.content[0].text, /Successfully wrote/);
    assert.equal((await locksEntries()).length, 0, "no anchored lock was ever taken");
    const store = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
    try {
      assert.equal(store.getServedState(realpathSync(target), "after\n"), undefined, "no anchored state was written");
    } finally {
      store.release();
    }
  }

  console.log("anchored write ownership gate tests: OK");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  shutdownHashStore();
  rmSync(temp, { recursive: true, force: true });
}
