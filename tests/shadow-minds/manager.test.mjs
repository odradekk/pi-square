import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { discoverShadowDefinitions, shadowDefinitionContextFingerprint } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { installShadowFixtures } = await import("./lib/fixtures.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-square-shadow-manager-fixture-"));
const fixtureProject = join(fixtureRoot, "project");
mkdirSync(fixtureProject, { recursive: true });
installShadowFixtures(join(fixtureRoot, "agent"));
process.env.PI_AGENT_DIR = join(fixtureRoot, "agent");
process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");
const { serializeShadowDefinition } = await load(join(packageRoot, "src", "shadow-minds", "serialize.ts"));
const { DEFAULT_CONFIG } = await load(join(packageRoot, "src", "core", "config.ts"));

const PLAIN = /\x1b\[[0-9;]*m/g;

function makeTheme() {
  return {
    fg(_token, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function makeTui() {
  return { requestRenderCount: 0, requestRender() { this.requestRenderCount += 1; }, terminal: { rows: 24, columns: 100 } };
}

function makeKeybindings() {
  const map = new Map([
    ["tui.select.down", "down"],
    ["tui.select.up", "up"],
    ["tui.select.cancel", "escape"],
    ["tui.select.confirm", "\r"],
  ]);
  return { matches: (data, action) => map.get(action) === data };
}

function render(manager, width = 100) {
  return manager.render(width).map((line) => line.replace(PLAIN, ""));
}

{
  assert.equal(DEFAULT_CONFIG.shadowMinds.enabled, false, "sanity: the feature ships disabled");
}

// ── The populated view over six user-owned agent fixtures ────────────

{
  const tui = makeTui();
  const manager = new ShadowManager(
    {
      definitions: discoverShadowDefinitions(fixtureProject).definitions,
      invalid: [],
      diagnostics: [],
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
  assert.ok(!detail.includes("untrusted"), "no trust concept renders in the manager view (#188)");
  assert.ok(!lines.some((line) => /[\u2190\u2192]/.test(line) && /tabs/.test(line)), "no tab row — one view");
  // Navigate to Project grounding and assert its merged view.
  manager.handleInput("down");
  manager.handleInput("down");
  manager.handleInput("down");
  const grounded = render(manager).join("\n");
  assert.ok(grounded.includes("TRIGGERS: tool_turn, completion"), "the selected definition shows its effective triggers");
  assert.ok(grounded.includes("LAYERS:"), "layer sources render");
  const wide = render(manager, 160).join("\n");
  assert.ok(
    /agent: [^\n]*project-grounding\.md \([0-9a-f]{8}\)/.test(wide),
    "layer sources render with scope, full path, and hash on a wide terminal",
  );
  assert.ok(
    wide.includes(join(fixtureRoot, "agent", "shadow-minds", "project-grounding.md")),
    "the full layer path stays copyable (#190)",
  );
  assert.ok(grounded.includes("PROVENANCE:"), "per-field provenance renders (#190)");
  assert.ok(grounded.includes("BODY:"), "the responsibility body has a bounded preview");
  for (const width of [39, 40, 60, 63, 64, 80, 100, 120]) {
    const narrowed = render(manager, width);
    assert.ok(narrowed.every((line) => line.replace(PLAIN, "").length <= width), `every line stays inside width ${width}`);
  }
}
// ── The effective configuration is inspectable in the view ───────────

{
  const tui = makeTui();
  const registry = discoverShadowDefinitions(fixtureProject);
  const manager = new ShadowManager(
    {
      definitions: registry.definitions,
      invalid: [],
      diagnostics: [],
      config: {
        enabled: true,
        defaults: {
          maxConcurrentRuns: 2,
          maxAutomaticStartsPerTask: 8,
          runTimeoutSeconds: 120,
          maxModelTurnsPerRun: 8,
          maxToolCallsPerRun: 16,
          completionGateWindowSeconds: 10,
          headlessDrainSeconds: 30,
          maxQueuedShadowIds: 32,
        },
      },
    },
    tui,
    makeTheme(),
    makeKeybindings(),
    () => {},
  );
  const lines = render(manager);
  assert.ok((lines[0] ?? "").includes("enabled"), "the master-switch state is visible");
  assert.ok(lines.some((line) => line.includes("CONFIG: runs 2")), "effective defaults render");
  const configLine = lines.find((line) => line.includes("CONFIG:"));
  assert.ok(configLine?.includes("gate 10s"), "the gate default renders");
  assert.ok(configLine?.includes("queue 32"), "the queued-ID default renders");
  assert.ok(/agent: [^\n]*\([0-9a-f]{8}\)/.test(render(manager, 160).join("\n")), "layer sources show a content-hash prefix");
}

// ── Invalid entries render with state and sources ────────────────────

{
  const registry = discoverShadowDefinitions(fixtureProject);
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
      definitions: discoverShadowDefinitions(fixtureProject).definitions,
      invalid: [],
      diagnostics: [],
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
  assert.equal(closed, 1, "closing is idempotent — later inputs cannot double-close");
}

// ── Read-only definitions window (#190) ───────────────────────────────

{
  const registry = discoverShadowDefinitions(fixtureProject);
  const tui = makeTui();
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    tui,
    makeTheme(),
    makeKeybindings(),
    () => {},
  );
  const browse = render(manager).join("\n");
  assert.ok(!browse.includes("n new"), "no create affordance remains in the browse footer");
  assert.ok(!browse.includes("Overlay writes"), "no write-services concept renders");

  // The detail view carries copyable layer paths, per-field provenance, and
  // the file-edit / /shadow <request> hint.
  manager.handleInput("down");
  manager.handleInput("down");
  manager.handleInput("down");
  const detail = render(manager, 160).join("\n");
  assert.ok(
    detail.includes(join(fixtureRoot, "agent", "shadow-minds", "project-grounding.md")),
    "layer sources render full copyable paths",
  );
  assert.ok(detail.includes("PROVENANCE:"), "per-field provenance renders");
  assert.ok(detail.includes("/shadow <request>"), "the edit hint names the request path");
  assert.ok(detail.includes("EDIT:"), "the copyable edit path is labeled");

  // The definition action sheet offers only the runtime action.
  manager.handleInput("\r");
  const actions = render(manager).join("\n");
  assert.ok(actions.includes("Run manually"), "the manual trial remains available");
  for (const absent of ["Edit fields", "Delete overlay", "Enable", "Disable", "Hide", "Unhide", "OVERLAYS / SCOPE"]) {
    assert.ok(!actions.includes(absent), `no ${absent} affordance remains`);
  }
  manager.handleInput("escape");
}

{
  // An invalid entry opens its diagnostics read-only instead of a delete flow.
  const registry = discoverShadowDefinitions(fixtureProject);
  const manager = new ShadowManager(
    {
      definitions: registry.definitions,
      invalid: [{ id: "broken", sources: ["/agent/shadow-minds/broken.md"], errors: ["broken.md: unknown field 'color'"] }],
      diagnostics: [],
    },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
  );
  for (let step = 0; step < registry.definitions.length; step += 1) manager.handleInput("down");
  manager.handleInput("\r");
  assert.equal(manager.view.kind, "review", "the invalid entry opens a read-only review");
  const text = render(manager).join("\n");
  assert.ok(text.includes("unknown field 'color'"), "the review shows the diagnostics");
  assert.ok(text.includes("/shadow <request>"), "repair is routed through the request path");
}

{
  // The open manager holds a stable snapshot; reopening rediscovers.
  const dir = mkdtempSync(join(tmpdir(), "pi-square-shadow-stable-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    installShadowFixtures(join(dir, "agent"));
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    const harness = { commands: new Map(), renderers: new Map(), handlers: new Map() };
    const pi = {
      registerCommand: (name, definition) => harness.commands.set(name, definition),
      registerMessageRenderer: (name, renderer) => harness.renderers.set(name, renderer),
      on: (event, handler) => harness.handlers.set(event, handler),
      sendMessage() {},
      sendUserMessage() {},
    };
    const register = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
    const state = register.default(pi);
    const opened = [];
    const ctx = (cwd) => ({
      hasUI: true,
      cwd,
      ui: { custom: async () => { opened.push(cwd); }, notify() {} },
    });
    await harness.commands.get("shadow").handler("", ctx(project));
    assert.equal(state.registry.definitions.length, 6, "the open discovered the fixture definitions");

    // Files change on disk while the manager conceptually stays open.
    writeFileSync(join(dir, "agent", "shadow-minds", "late-role.md"), [
      "---", "promptVersion: 1", "id: late-role", "name: Late role", "tools: [read]", "---", "Late body.", "",
    ].join("\n"), "utf8");

    // Reopening the no-argument command rediscovers before opening.
    await harness.commands.get("shadow").handler("", ctx(project));
    assert.equal(opened.length, 2, "each invocation opens the manager");
    assert.ok(
      state.registry.definitions.some((definition) => definition.id === "late-role"),
      "the no-argument command rediscovers files before opening (#190)",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Registration performs no model calls in any branch ───────────────

{
  const tmp = mkdtempSync(join(tmpdir(), "pi-square-shadow-manager-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(tmp, "agent");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  installShadowFixtures(join(tmp, "agent"));
  try {
    const sent = [];
    const registered = new Map();
    const handlers = new Map();
    const renderers = new Map();
    const pi = {
      registerCommand: (name, definition) => registered.set(name, definition),
      registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
      on: (event, handler) => handlers.set(event, handler),
      sendMessage: (message) => sent.push(message),
      sendUserMessage: (message) => sent.push(message),
    };
    const loadFeature = jiti(import.meta.url, { moduleCache: false });
    const registerShadowMinds = await loadFeature(join(packageRoot, "src", "shadow-minds", "index.ts")).default;
    const state = registerShadowMinds(pi);

    assert.deepEqual([...registered.keys()], ["shadow"]);
    assert.equal(registered.get("shadow").description.length > 0, true);
    assert.ok(renderers.has("pi-square.shadow-config-guide"), "the config guide renderer is registered");

    // No UI: the handler must not open anything nor send anything.
    let opened = 0;
    await registered.get("shadow").handler("", {
      hasUI: false,
      ui: { custom: async () => { opened += 1; } },
      cwd: tmp,
      isProjectTrusted: () => false,
    });
    assert.equal(opened, 0, "a headless session opens no view");
    assert.deepEqual(sent, [], "the command never sends messages");

    // With UI: the view opens; still zero messages.
    await registered.get("shadow").handler("", {
      hasUI: true,
      ui: { custom: async () => { opened += 1; } },
      cwd: tmp,
      isProjectTrusted: () => false,
    });
    assert.equal(opened, 1, "a TUI session opens the read-only view");
    assert.deepEqual(sent, [], "the read-only view creates no model calls");

    // Session start refreshes the registry from the canonical cwd.
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
    ], "session start discovers the agent fixture definitions");
    assert.deepEqual(notified, [], "a clean registry notifies nothing");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  }
}


// ── Manual-run and inbox flows with runtime services ───────────────

function makeRuntimeService(initial) {
  const state = {
    snapshotData: initial,
    runCalls: [],
    cancels: [],
    reads: [],
    dismissals: [],
    deletions: [],
    listeners: new Set(),
  };
  return {
    state,
    runtime: {
      snapshot: () => state.snapshotData,
      runManual(input) {
        state.runCalls.push(input);
        return { ok: true, message: "started" };
      },
      cancelRun(runId) {
        state.cancels.push(runId);
        return { ok: true };
      },
      markResultRead(id) {
        state.reads.push(id);
        return true;
      },
      dismissResult(id) {
        state.dismissals.push(id);
        return true;
      },
      deleteResult(id) {
        state.deletions.push(id);
        state.snapshotData = { ...state.snapshotData, results: state.snapshotData.results.filter((entry) => entry.id !== id) };
        return true;
      },
      subscribe(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    },
    emit() {
      for (const listener of state.listeners) listener();
    },
  };
}

{
  // Every definition offers a manual run; the label carries its tool declaration.
  const registry = discoverShadowDefinitions(fixtureProject);
  const synthesizer = registry.definitions.find((definition) => definition.id === "session-synthesizer");
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  assert.ok(synthesizer.tools?.length === 0, "sanity: session-synthesizer declares the empty tool list");
  assert.ok(grounding.tools && grounding.tools.length > 0, "sanity: project-grounding declares evidence tools");

  const service = makeRuntimeService({ runs: [], results: [] });
  const withRun = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );
  let index = registry.definitions.findIndex((definition) => definition.id === "session-synthesizer");
  for (let step = 0; step < index; step += 1) withRun.handleInput("down");
  withRun.handleInput("\r");
  const noToolLines = render(withRun);
  assert.ok(noToolLines.some((line) => line.includes("Run manually")), "the no-tool definition offers a manual run");
  assert.ok(noToolLines.some((line) => line.includes("none — submit_shadow_result only")), "the no-tool label names the single tool");

  const withoutRun = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );
  index = registry.definitions.findIndex((definition) => definition.id === "project-grounding");
  for (let step = 0; step < index; step += 1) withoutRun.handleInput("down");
  withoutRun.handleInput("\r");
  const evidenceLines = render(withoutRun);
  assert.ok(evidenceLines.some((line) => line.includes("Run manually")), "evidence-tool definitions offer a manual run too");
  assert.ok(evidenceLines.some((line) => line.includes("read, grep, find, ls, codegraph, pdf_search + submit")), "the evidence label names the declared catalog tools");
}

{
  // Full flow: note → review → confirm closes the manager and starts the run.
  const registry = discoverShadowDefinitions(fixtureProject);
  const synthesizer = registry.definitions.find((definition) => definition.id === "session-synthesizer");
  assert.ok(synthesizer);
  const service = makeRuntimeService({ runs: [], results: [] });
  const done = [];
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], config: { enabled: true, defaults: { ...DEFAULT_CONFIG.shadowMinds.defaults, thinking: "medium" } } },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => done.push(1),
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );
  const index = registry.definitions.findIndex((definition) => definition.id === "session-synthesizer");
  for (let step = 0; step < index; step += 1) manager.handleInput("down");
  manager.handleInput("\r");
  manager.handleInput("\r");
  for (const character of "Check open questions only.") manager.handleInput(character);
  manager.handleInput("\r");
  const review = render(manager).join("\n");
  assert.ok(review.includes("Start session-synthesizer manual run?"), "the run review opens");
  assert.ok(review.includes("Check open questions only."), "the note is reviewed");
  assert.ok(review.includes("submit_shadow_result only"), "the review names the single tool");
  assert.ok(review.includes("Thinking: medium"), "the effective configuration thinking default is reviewed");
  manager.handleInput("\r");
  assert.equal(done.length, 1, "confirming closes the manager first");
  assert.equal(service.state.runCalls.length, 1);
  assert.deepEqual(service.state.runCalls[0], {
    shadowId: "session-synthesizer",
    definitionFingerprint: shadowDefinitionContextFingerprint(synthesizer.layers),
    defaultThinking: "medium",
    timeoutSeconds: DEFAULT_CONFIG.shadowMinds.defaults.runTimeoutSeconds,
    maxTurns: DEFAULT_CONFIG.shadowMinds.defaults.maxModelTurnsPerRun,
    maxToolCalls: DEFAULT_CONFIG.shadowMinds.defaults.maxToolCallsPerRun,
    note: "Check open questions only.",
  }, "the run starts with the exact reviewed definition and bounds");
}

{
  // The master switch refuses the trial inside the manager.
  const registry = discoverShadowDefinitions(fixtureProject);
  const service = makeRuntimeService({ runs: [], results: [] });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], config: { enabled: false, defaults: DEFAULT_CONFIG.shadowMinds.defaults } },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );
  const index = registry.definitions.findIndex((definition) => definition.id === "session-synthesizer");
  for (let step = 0; step < index; step += 1) manager.handleInput("down");
  manager.handleInput("\r");
  manager.handleInput("\r");
  const lines = render(manager).join("\n");
  assert.ok(lines.includes("master switch"), "the refusal names the master switch");
  assert.equal(service.state.runCalls.length, 0);
}

{
  // Runs entry: live refresh, cancellation, result inspection, and actions.
  const registry = discoverShadowDefinitions(fixtureProject);
  const runningRun = {
    id: "run-1", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", phase: "running", startedAt: 1_000, note: "trial",
  };
  const settledRun = {
    id: "run-2", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", phase: "submitted", startedAt: 1_000, endedAt: 2_000, resultId: "shr-1",
    cohorts: {
      model: "dddddddddddddddd", thinking: "eeeeeeeeeeeeeeee", toolSchema: "bbbbbbbbbbbbbbbb",
      system: "aaaaaaaaaaaaaaaa", cwd: "ffffffffffffffff", trajectory: "cccccccccccccccc",
      trajectoryCheckpoint: "1111111111111111", truncation: "2222222222222222",
      parentCore: "3333333333333333", projectRules: "4444444444444444",
    },
    trajectoryTruncated: true,
    requests: [{ input: 700, output: 80, cacheRead: 12, cacheWrite: 4, cost: 0.02, turn: 1, toolCalls: 1, ttftMs: 120, cacheReported: true }],
  };
  const result = {
    id: "shr-1", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", source: "automatic", primaryTrigger: "failure", taskIdentity: { epoch: 3 },
    payload: { summary: "Two decisions remain open." }, summary: "Two decisions remain open.",
    delivery: "notified", attention: "unread", createdAt: 2_000,
  };
  const service = makeRuntimeService({
    runs: [runningRun, settledRun],
    results: [result],
    evictionEvents: [{ kind: "evicted", id: "shr-old", at: 1_500, reason: "count" }],
  });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );

  manager.handleInput("r");
  let lines = render(manager).join("\n");
  assert.ok(lines.includes("Runs") && lines.includes("Inbox"), "the runs entry lists both sections");
  assert.ok(lines.includes("1 running · 1 settled"), "run counts render");
  assert.ok(lines.includes("1 eviction events"), "retention events are visible from the inbox summary");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Session synthesizer (session-synthesizer)"), "runs list renders");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Cancel run"), "a running run offers cancellation");
  manager.handleInput("\r");
  assert.deepEqual(service.state.cancels, ["run-1"], "cancellation reaches the runtime");

  // Settled run: view result opens the inbox entry.
  manager.handleInput("escape");
  service.state.snapshotData = {
    runs: [{ ...runningRun, phase: "cancelled", endedAt: 1_500 }, settledRun],
    results: [result],
  };
  service.emit();
  manager.handleInput("down");
  manager.handleInput("\r");
  // Run facts: the frozen envelope, qualifiers, cohorts, and metrics render.
  manager.handleInput("down");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("run facts"), "the facts view opens from the run detail");
  assert.ok(lines.includes("system: aaaaaaaaaaaaaaaa"), "the system cohort hash renders");
  assert.ok(lines.includes("model: dddddddddddddddd"), "the model cohort hash renders");
  assert.ok(lines.includes("parent core: 3333333333333333"), "the authority cohort hashes render");
  assert.ok(lines.includes("checkpoint: 1111111111111111"), "the trajectory checkpoint hash renders");
  assert.ok(lines.includes("(truncated: dropped)"), "the truncation qualifier renders");
  assert.ok(lines.includes("turn 1. in 700 · out 80"), "per-request metrics render");
  assert.ok(lines.includes("cache r 12/w 4"), "reported cache values render");
  assert.ok(lines.includes("1 tool calls"), "per-request tool calls render");
  manager.handleInput("\r");
  manager.handleInput("up");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("View result"), "back returns to the run detail actions");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Two decisions remain open."), "the result summary renders");
  assert.ok(lines.includes("automatic:failure task 3"), "the inbox result exposes automatic trigger and task provenance");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Two decisions remain open."), "the payload view renders the submitted JSON");
  assert.ok(lines.includes('"summary": "Two decisions remain open."'), "canonical JSON payload is visible");
  manager.handleInput("\r");
  // Back on the result actions: mark read, dismiss, delete.
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Mark read") && lines.includes("Dismiss") && lines.includes("Delete"), "attention actions are offered");
  manager.handleInput("down");
  manager.handleInput("\r");
  assert.deepEqual(service.state.reads, ["shr-1"], "mark read reaches the runtime");
  manager.handleInput("down");
  manager.handleInput("down");
  manager.handleInput("\r");
  assert.deepEqual(service.state.deletions, ["shr-1"], "delete removes the result through the runtime");
}

{
  // Persisted retention events render in the inbox rather than remaining an
  // internal store-only audit surface.
  const registry = discoverShadowDefinitions(fixtureProject);
  const service = makeRuntimeService({
    runs: [], results: [],
    evictionEvents: [{ kind: "evicted", id: "shr-old", at: 1_500, reason: "bytes" }],
  });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(), makeTheme(), makeKeybindings(), () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );
  manager.handleInput("r");
  manager.handleInput("down");
  manager.handleInput("\r");
  const lines = render(manager).join("\n");
  assert.ok(lines.includes("Evicted result shr-old"));
  assert.ok(lines.includes("bytes retention"));
}

{
  // Scheduling controls: pause/resume from the runs list, queued
  // activations visible, and superseded automatic runs labeled.
  const registry = discoverShadowDefinitions(fixtureProject);
  const schedulerCalls = { pause: 0, resume: 0 };
  let paused = false;
  let pendingData = [];
  const service = makeRuntimeService({
    runs: [
      {
        id: "run-auto", shadowId: "architecture-lens", shadowName: "Architecture lens",
        source: "automatic", trigger: "mutation", taskEpoch: 3,
        triggerReasons: [{ trigger: "mutation", detail: "write a.ts", firstObservedAt: 1, lastObservedAt: 2 }],
        phase: "superseded", startedAt: 1_000, endedAt: 1_400,
      },
    ],
    results: [],
  });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(), makeTheme(), makeKeybindings(), () => {},
    {
      refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }),
      runtime: service.runtime,
      scheduler: {
        snapshot: () => ({ taskEpoch: 3, paused, toolGeneration: 5, automaticStartsByTask: [{ epoch: 3, starts: 1 }], pending: pendingData, clippedIds: [], diagnostics: [] }),
        pause() { schedulerCalls.pause += 1; paused = true; },
        resume() { schedulerCalls.resume += 1; paused = false; },
      },
    },
  );
  manager.handleInput("r");
  manager.handleInput("\r");
  let lines = render(manager).join("\n");
  assert.ok(lines.includes("Pause automatic Shadows"), "the runs list offers pause");
  assert.ok(lines.includes("superseded"), "the superseded outcome is visible");
  assert.ok(lines.includes("automatic · mutation"), "automatic runs carry source and trigger in the list detail");
  manager.handleInput("\r");
  assert.equal(schedulerCalls.pause, 1, "pause reaches the scheduler");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Resume automatic Shadows"), "the control flips to resume");

  // Queued activations render with their trigger and reasons.
  pendingData = [{
    shadowId: "project-grounding",
    taskEpoch: 3,
    shadowPriority: 0,
    bestTrigger: "failure",
    reasons: [{ trigger: "failure", detail: "test command failed", firstObservedAt: 1, lastObservedAt: 2 }],
    generation: 5,
    checkpoint: undefined,
    enqueuedAt: 1_200,
    lastObservedAt: 1_200,
  }];
  const queuedManager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(), makeTheme(), makeKeybindings(), () => {},
    {
      refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }),
      runtime: service.runtime,
      scheduler: {
        snapshot: () => ({ taskEpoch: 3, paused, toolGeneration: 5, automaticStartsByTask: [{ epoch: 3, starts: 1 }], pending: pendingData, clippedIds: [], diagnostics: [] }),
        pause() { paused = true; },
        resume() { paused = false; },
      },
    },
  );
  queuedManager.handleInput("r");
  queuedManager.handleInput("\r");
  lines = render(queuedManager).join("\n");
  assert.ok(lines.includes("Queued: project-grounding"), "queued activations are visible");
  assert.ok(lines.includes("failure"), "the pending trigger renders");

  // Facts view: the automatic source, task, and merged reasons render fully.
  const factsManager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(), makeTheme(), makeKeybindings(), () => {},
    {
      refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }),
      runtime: service.runtime,
    },
  );
  factsManager.handleInput("r");
  factsManager.handleInput("\r");
  factsManager.handleInput("down");
  factsManager.handleInput("\r");
  factsManager.handleInput("down");
  factsManager.handleInput("\r");
  lines = render(factsManager).join("\n");
  assert.ok(lines.includes("Source: automatic · mutation · task 3"), "facts carry the automatic source and task");
  assert.ok(lines.includes("Reason: write a.ts"), "facts carry the merged trigger reason");
}

// ── Confirmed-delivery actions (#159) ───────────────────────────────

{
  const registry = discoverShadowDefinitions(fixtureProject);
  const deliveryCalls = { results: [], failures: [] };
  const deliveryService = {
    sendResultToAgent(id) {
      deliveryCalls.results.push(id);
      return { ok: true, message: "Sent to the agent as advisory evidence." };
    },
    sendErrorSummary(runId) {
      deliveryCalls.failures.push(runId);
      return { ok: true, message: "Sent the failure summary to the agent." };
    },
  };
  const notifiedResult = {
    id: "shr-9", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", payload: { summary: "Advisory finding." }, summary: "Advisory finding.",
    delivery: "notified", attention: "unread", createdAt: 2_000, configuredDelivery: "notify",
  };
  const deliveredResult = { ...notifiedResult, id: "shr-10", delivery: "delivered" };
  const failedRun = {
    id: "run-7", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    source: "automatic", phase: "error", startedAt: 1_000, endedAt: 1_500,
    message: "Model authentication failed.",
  };
  const service = makeRuntimeService({ runs: [failedRun], results: [notifiedResult, deliveredResult] });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(), makeTheme(), makeKeybindings(), () => {},
    {
      refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }),
      runtime: service.runtime,
      delivery: deliveryService,
    },
  );

  // Inbox rows show the delivery marker: inbox-only versus delivered.
  manager.handleInput("r");
  manager.handleInput("down");
  manager.handleInput("\r");
  let lines = render(manager).join("\n");
  assert.ok(lines.includes("unread · inbox"), "the inbox row shows the inbox delivery marker");
  assert.ok(lines.includes("unread · delivered"), "the delivered marker renders");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Send to agent"), "a notified result offers Send to agent");
  manager.handleInput("\r");
  assert.deepEqual(deliveryCalls.results, ["shr-9"], "Send to agent reaches the delivery service");
  assert.ok(render(manager).join("\n").includes("Sent to the agent"), "the send confirms visibly");
  manager.handleInput("escape");
  manager.handleInput("escape");
  manager.handleInput("escape");

  // A delivered result offers no second send.
  manager.handleInput("r");
  manager.handleInput("down");
  manager.handleInput("\r");
  manager.handleInput("down");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(!lines.includes("Send to agent"), "a delivered result cannot resend");
  assert.ok(lines.includes("View payload"), "the delivered result still opens its payload");
  manager.handleInput("escape");
  manager.handleInput("escape");
  manager.handleInput("escape");

  // A failed run offers the bounded failure summary, an explicit send only.
  manager.handleInput("r");
  manager.handleInput("\r");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Send failure summary"), "a failed run offers the summary send");
  manager.handleInput("\r");
  assert.deepEqual(deliveryCalls.failures, ["run-7"], "the failure summary reaches the delivery service");
}

// ── Diagnostics view (#161) ────────────────────────────────────────

{
  const registry = discoverShadowDefinitions(fixtureProject);
  const cohorts = {
    model: "dddddddddddddddd", thinking: "eeeeeeeeeeeeeeee", toolSchema: "bbbbbbbbbbbbbbbb",
    system: "aaaaaaaaaaaaaaaa", cwd: "ffffffffffffffff", trajectory: "cccccccccccccccc",
    trajectoryCheckpoint: "1111111111111111", truncation: "2222222222222222",
  };
  const service = makeRuntimeService({
    runs: [
      {
        id: "run-1", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
        phase: "submitted", startedAt: 1_000, endedAt: 2_000, cohorts,
        usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 },
        requests: [
          { input: 100, output: 40, cacheRead: 500, cacheWrite: 0, cost: 0.02, turn: 1, toolCalls: 2, ttftMs: 120, cacheReported: true },
          { input: 60, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01, turn: 2, toolCalls: 0, ttftMs: 80 },
        ],
      },
      {
        id: "run-2", shadowId: "research-scout", shadowName: "Research scout",
        phase: "running", startedAt: 3_000, cohorts,
      },
    ],
    results: [],
  });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [] },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [] }), runtime: service.runtime },
  );
  manager.handleInput("r");
  // RUNS / INBOX -> Runs -> Diagnostics is the third entry.
  let lines = render(manager).join("\n");
  assert.ok(lines.includes("Diagnostics"), "the runs entry offers diagnostics");
  manager.handleInput("down");
  manager.handleInput("down");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Shadow usage and cache diagnostics"), "the diagnostics view opens");
  assert.ok(lines.includes("Runs: 2 (1 running · 1 settled) · requests 2 · turns 2 · tool calls 2"));
  assert.ok(lines.includes("Tokens: in 100 · out 40 · cost 0.0200"));
  assert.ok(lines.includes("min 80ms · avg 100ms · max 120ms"), "TTFT aggregates render");
  assert.ok(lines.includes("Provider-reported: 1 of 2 requests"), "unreported cache stays distinguishable");
  assert.ok(lines.includes("Measured read: 500 · write: 0"), "only reported cache totals render");
  assert.ok(lines.includes("Cache reuse is measured and best-effort"), "the best-effort caveat renders");
  assert.ok(lines.includes("2 runs · model dddddddddddddddd"), "cohort groups render with their hashes");
}

console.log("shadow-minds manager tests: OK");
