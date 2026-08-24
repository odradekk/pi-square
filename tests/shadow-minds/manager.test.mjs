import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

initTheme();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { ShadowManager } = await load(join(packageRoot, "src", "shadow-minds", "manager.ts"));
const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { DEFAULT_CONFIG } = await load(join(packageRoot, "src", "core", "config.ts"));

const PLAIN = /\x1b\[[0-9;]*m/g;

function makeTheme() {
  return {
    fg(_token, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function makeTui() {
  return { requestRenderCount: 0, requestRender() { this.requestRenderCount += 1; } };
}

function makeKeybindings() {
  const map = new Map([
    ["tui.select.down", "down"],
    ["tui.select.up", "up"],
    ["tui.select.cancel", "escape"],
  ]);
  return { matches: (data, action) => map.get(action) === data };
}

function render(manager, width = 100) {
  return manager.render(width).map((line) => line.replace(PLAIN, ""));
}

{
  assert.equal(DEFAULT_CONFIG.shadowMinds.enabled, false, "sanity: the feature ships disabled");
}

// ── The clean-install view over the six package templates ────────────

{
  const tui = makeTui();
  const manager = new ShadowManager(
    {
      definitions: discoverShadowDefinitions(packageRoot, { projectTrusted: false }).definitions,
      invalid: [],
      diagnostics: [],
      projectTrusted: false,
    },
    tui,
    makeTheme(),
    makeKeybindings(),
    () => {},
  );
  const lines = render(manager);
  assert.ok((lines[0] ?? "").includes("● Shadows"), "one-cell status rail with the plain title token");
  assert.ok(lines.some((line) => line.includes("disabled by default")), "the disabled default state is visible");
  assert.ok(lines.some((line) => /Project grounding/.test(line)), "definitions appear in the list");
  const detail = lines.join("\n");
  assert.ok(detail.includes("TRIGGERS: tool_turn"), "effective trigger fields render for the selection");
  assert.ok(detail.includes("untrusted"), "the untrusted-project diagnostic section renders");
  assert.ok(!lines.some((line) => /[\u2190\u2192]/.test(line) && /tabs/.test(line)), "no tab row — one view");
  // Navigate to Project grounding and assert its merged view.
  manager.handleInput("down");
  manager.handleInput("down");
  manager.handleInput("down");
  const grounded = render(manager).join("\n");
  assert.ok(grounded.includes("TRIGGERS: tool_turn, completion"), "the selected definition shows its effective triggers");
  assert.ok(grounded.includes("LAYERS:") && grounded.includes("package: /"), "layer sources render with scope and file path");
  assert.ok(grounded.includes("BODY:"), "the responsibility body has a bounded preview");
  const narrowed = render(manager, 60);
  assert.ok(narrowed.every((line) => line.replace(PLAIN, "").length <= 60), "every line stays inside the terminal width");
}

// ── Invalid entries render with state and sources ────────────────────

{
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: false });
  const tui = makeTui();
  const manager = new ShadowManager(
    {
      definitions: registry.definitions,
      invalid: [{
        id: "broken",
        sources: ["/agent/shadow-minds/broken.md"],
        errors: ["broken.md: unknown field 'color'"],
      }],
      diagnostics: registry.diagnostics,
      projectTrusted: true,
    },
    tui,
    makeTheme(),
    makeKeybindings(),
    () => {},
  );
  let lines = render(manager);
  assert.ok(lines.some((line) => line.includes("broken")), "invalid IDs are listed");
  for (let step = 0; step < 6; step += 1) manager.handleInput("down");
  lines = render(manager);
  const detail = lines.join("\n");
  assert.ok(detail.includes("STATE: invalid"), "invalid state is explicit");
  assert.ok(detail.includes("/agent/shadow-minds/broken.md"), "invalid sources render");
  assert.ok(detail.includes("unknown field"), "invalid errors render");
}

// ── Navigation and close are the only interactions ───────────────────

{
  const tui = makeTui();
  let closed = 0;
  const manager = new ShadowManager(
    {
      definitions: discoverShadowDefinitions(packageRoot, { projectTrusted: false }).definitions,
      invalid: [],
      diagnostics: [],
      projectTrusted: true,
    },
    tui,
    makeTheme(),
    makeKeybindings(),
    () => { closed += 1; },
  );
  manager.handleInput("down");
  assert.ok(tui.requestRenderCount >= 1, "navigation requests a render");
  manager.handleInput("up");
  manager.handleInput("escape");
  assert.equal(closed, 1, "cancel closes the view exactly once");
  manager.handleInput("q");
  assert.equal(closed, 2, "q closes the view too");
}

// ── Registration performs no model calls in any branch ───────────────

{
  const tmp = mkdtempSync(join(tmpdir(), "pi-square-shadow-manager-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(tmp, "agent");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  try {
    const sent = [];
    const registered = new Map();
    const handlers = new Map();
    const pi = {
      registerCommand: (name, definition) => registered.set(name, definition),
      on: (event, handler) => handlers.set(event, handler),
      sendMessage: (message) => sent.push(message),
      sendUserMessage: (message) => sent.push(message),
    };
    const loadFeature = jiti(import.meta.url, { moduleCache: false });
    const registerShadowMinds = await loadFeature(join(packageRoot, "src", "shadow-minds", "index.ts")).default;
    const state = registerShadowMinds(pi);

    assert.deepEqual([...registered.keys()], ["shadow"]);
    assert.equal(registered.get("shadow").description.length > 0, true);

    // No UI: the handler must not open anything nor send anything.
    let opened = 0;
    await registered.get("shadow").handler("", {
      hasUI: false,
      ui: { custom: async () => { opened += 1; } },
      cwd: tmp,
    });
    assert.equal(opened, 0, "a headless session opens no view");
    assert.deepEqual(sent, [], "the command never sends messages");

    // With UI: the view opens; still zero messages.
    await registered.get("shadow").handler("", {
      hasUI: true,
      ui: { custom: async () => { opened += 1; } },
      cwd: tmp,
    });
    assert.equal(opened, 1, "a TUI session opens the read-only view");
    assert.deepEqual(sent, [], "the read-only view creates no model calls");

    // Session start refreshes the registry from the canonical cwd and trust.
    let notified = [];
    await handlers.get("session_start")(undefined, {
      cwd: tmp,
      isProjectTrusted: () => false,
      hasUI: true,
      ui: { notify: (text, level) => notified.push({ text, level }) },
    });
    assert.deepEqual(state.registry.definitions.map((definition) => definition.id).sort(), [
      "alternative-explorer",
      "architecture-lens",
      "completion-check",
      "project-grounding",
      "research-scout",
      "session-synthesizer",
    ], "session start discovers the package templates");
    assert.equal(state.projectTrusted, false);
    assert.deepEqual(notified, [], "a clean registry notifies nothing");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("shadow-minds manager tests: OK");
