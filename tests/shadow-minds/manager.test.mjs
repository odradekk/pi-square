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
const { discoverShadowDefinitions, shadowDefinitionContextFingerprint } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
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
  assert.ok(
    grounded.includes("LAYERS:") && /package: project-grounding\.md \([0-9a-f]{8}\)/.test(grounded),
    "layer sources render with scope, file name, and hash",
  );
  assert.ok(grounded.includes("BODY:"), "the responsibility body has a bounded preview");
  for (const width of [39, 40, 60, 63, 64, 80, 100, 120]) {
    const narrowed = render(manager, width);
    assert.ok(narrowed.every((line) => line.replace(PLAIN, "").length <= width), `every line stays inside width ${width}`);
  }
}
// ── The effective configuration is inspectable in the view ───────────

{
  const tui = makeTui();
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: false });
  const manager = new ShadowManager(
    {
      definitions: registry.definitions,
      invalid: [],
      diagnostics: [],
      projectTrusted: true,
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
  assert.ok(lines.some((line) => line.includes("CONFIG: concurrency 2")), "effective defaults render");
  assert.ok(lines.some((line) => line.includes("gate window 10s")), "the gate window default renders");
  assert.ok(/package: [^\n]*\([0-9a-f]{8}\)/.test(lines.join("\n")), "layer sources show a content-hash prefix");
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
  assert.equal(closed, 1, "closing is idempotent — later inputs cannot double-close");
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


// ── Write flows with mock services ───────────────────────────────────

{
  const { newShadowDefinitionDraft, serializeShadowDefinition } = await load(
    join(packageRoot, "src", "shadow-minds", "serialize.ts"),
  );
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const definitions = registry.definitions;
  const grounding = definitions.find((definition) => definition.id === "project-grounding");

  const calls = { approve: [], save: [], deleteOverlay: [] };
  let approveResult = true;
  let previewErrors = [];
  const services = {
    refresh: () => ({ definitions, invalid: [], diagnostics: [], projectTrusted: true }),
    scopeOf: (filePath) => (filePath.includes("agent") ? "agent" : "project"),
    overlaySnapshot: async (scope, id) => ({
      filePath: `/scope/${scope}/${id}.md`,
      fingerprint: `fp-${scope}-${id}`,
      contextFingerprint: shadowDefinitionContextFingerprint(definitions.find((definition) => definition.id === id)?.layers ?? []),
      content: serializeShadowDefinition({ id, enabled: false }),
    }),
    preview: (scope, fields, contextFingerprint) => {
      const content = serializeShadowDefinition(fields);
      if (previewErrors.length > 0) return { content, filePath: `/scope/${scope}/${fields.id}.md`, errors: previewErrors };
      return {
        content,
        filePath: `/scope/${scope}/${fields.id}.md`,
        definition: {
          ...grounding,
          id: fields.id,
          enabled: fields.enabled ?? grounding.enabled,
          name: fields.name ?? grounding.name,
          body: fields.body ?? grounding.body,
          layers: [],
        },
        errors: [],
        contextFingerprint,
      };
    },
    previewDelete: (_scope, _id, _filePath, contextFingerprint) => ({ definition: grounding, errors: [], contextFingerprint }),
    approve: async (request) => {
      calls.approve.push(request);
      return approveResult;
    },
    save: async (scope, fields, filePath, fingerprint, contextFingerprint) => {
      calls.save.push({ scope, fields, filePath, fingerprint, contextFingerprint });
      return { ok: true, message: "saved" };
    },
    deleteOverlay: async (scope, id, fingerprint) => {
      calls.deleteOverlay.push({ scope, id, fingerprint });
      return { ok: true, message: "deleted" };
    },
  };

  const done = [];
  const manager = new ShadowManager(
    { definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => done.push(1),
    services,
  );

  // Enable flow: actions → Enable → project scope → review → confirm.
  manager.handleInput("\r");
  let lines = render(manager);
  assert.ok(lines.some((line) => line.includes("Enable")), "the actions menu offers enable for a disabled definition");
  assert.ok(lines.some((line) => line.includes("Run manually")), "every definition offers a manual run");
  // Run manually is the first action; Enable is the second.
  manager.handleInput("down");
  manager.handleInput("\r");
  lines = render(manager);
  assert.ok(lines.join("\n").includes("OVERLAYS / SCOPE"), "scope selection follows");
  manager.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  lines = render(manager);
  assert.ok(lines.join("\n").includes("LAYER MARKDOWN"), "the review shows the candidate layer");
  assert.ok(lines.join("\n").includes("EFFECTIVE CHANGE"), "the review shows the effective change");
  assert.ok(lines.join("\n").includes("enabled: false → true"), "the enabled flip renders as an effective change");
  assert.ok(lines.join("\n").includes("save overlay"), "the confirm label renders");
  assert.equal(calls.approve.length, 0, "no approval before the confirm key");
  manager.handleInput("\r");
  assert.equal(done.length, 1, "confirming closes the manager first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.approve.length, 1, "the approval runs through the coordinator service");
  assert.equal(calls.approve[0].title.includes("project"), true, "the approval names the scope");
  assert.equal(calls.save.length, 1, "an approved review saves exactly once");
  assert.equal(calls.save[0].scope, "project");
  assert.equal(calls.save[0].fields.enabled, true);
  assert.equal(calls.save[0].filePath, "/scope/project/alternative-explorer.md");
  assert.equal(calls.save[0].fingerprint, "fp-project-alternative-explorer");
  assert.equal(calls.save[0].contextFingerprint, shadowDefinitionContextFingerprint(definitions[0].layers));
  assert.equal(calls.deleteOverlay.length, 0);

  // Declined approval writes nothing.
  const declined = new ShadowManager(
    { definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    services,
  );
  approveResult = false;
  declined.handleInput("\r");
  declined.handleInput("down");
  declined.handleInput("\r");
  declined.handleInput("\r");
  declined.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.save.length, 1, "a declined approval saves nothing");

  // An invalid candidate flashes instead of opening a review.
  const invalidCandidate = new ShadowManager(
    { definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    services,
  );
  previewErrors = ["project-grounding: required tool 'shell' is outside the final tool set"];
  invalidCandidate.handleInput("\r");
  // Run manually is the first action; Enable (which previews) is the second.
  invalidCandidate.handleInput("down");
  invalidCandidate.handleInput("\r");
  invalidCandidate.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  lines = render(invalidCandidate);
  assert.ok(lines.join("\n").includes("outside the final tool set"), "preview errors surface in the flash row");
  assert.ok(!lines.join("\n").includes("LAYER MARKDOWN"), "no review opens for an invalid candidate");
  previewErrors = [];

  // Without services, writes are unavailable.
  const readonlyManager = new ShadowManager(
    { definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
  );
  readonlyManager.handleInput("n");
  lines = render(readonlyManager);
  assert.ok(lines.join("\n").includes("unavailable"), "create without services flashes unavailability");

  // Untrusted projects only offer the agent scope.
  const untrusted = new ShadowManager(
    { definitions, invalid: [], diagnostics: [], projectTrusted: false },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    services,
  );
  untrusted.handleInput("\r");
  untrusted.handleInput("down");
  untrusted.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  lines = render(untrusted);
  assert.ok(!lines.join("\n").includes("Project"), "the project scope is hidden when untrusted");
  assert.ok(lines.join("\n").includes("Agent"), "the agent scope remains");
}

// ── Create flow walks id → name → body and reviews the draft ─────────

{
  const { newShadowDefinitionDraft, serializeShadowDefinition } = await load(
    join(packageRoot, "src", "shadow-minds", "serialize.ts"),
  );
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const calls = { approve: [], save: [] };
  const { MISSING_OVERLAY_FINGERPRINT: missing } = await load(
    join(packageRoot, "src", "shadow-minds", "overlays.ts"),
  );
  const services = {
    refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }),
    scopeOf: () => "project",
    overlaySnapshot: async () => ({ filePath: "/scope/project/new-role.md", fingerprint: missing }),
    preview: (scope, fields) => ({
      content: serializeShadowDefinition(fields),
      filePath: `/scope/${scope}/${fields.id}.md`,
      definition: { ...registry.definitions[0], id: fields.id, name: fields.name, body: fields.body, layers: [] },
      errors: [],
    }),
    approve: async (request) => {
      calls.approve.push(request);
      return true;
    },
    save: async (scope, fields) => {
      calls.save.push({ scope, fields });
      return { ok: true, message: "saved" };
    },
    deleteOverlay: async () => ({ ok: true, message: "deleted" }),
  };
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    services,
  );
  manager.handleInput("n");
  let lines = render(manager);
  assert.ok(lines.join("\n").includes("SCOPE"), "create starts at the scope choice");
  manager.handleInput("\r");
  lines = render(manager);
  assert.ok(lines.some((line) => line.includes("Definition id")), "the id editor opens");
  for (const character of "my 7 role") manager.handleInput(character);
  manager.handleInput("\r");
  lines = render(manager);
  assert.ok(lines.join("\n").includes("must match"), "an invalid id is refused");
  manager.handleInput("escape");
  manager.handleInput("\r");
  for (const character of "my-role") manager.handleInput(character);
  manager.handleInput("\r");
  lines = render(manager);
  assert.ok(lines.some((line) => line.includes("name")), "the name editor follows");
  for (const character of "My role") manager.handleInput(character);
  manager.handleInput("\r");
  lines = render(manager);
  assert.ok(lines.some((line) => line.includes("responsibility body")), "the body editor follows");
  for (const character of "Own this responsibility.") manager.handleInput(character);
  manager.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  lines = render(manager);
  assert.ok(lines.join("\n").includes("LAYER MARKDOWN"), "the draft reaches the review");
  manager.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.save.length, 1, "the draft saves after approval");
  const saved = calls.save[0].fields;
  assert.equal(saved.id, "my-role");
  assert.equal(saved.name, "My role");
  assert.equal(saved.enabled, false, "new definitions default to disabled");
  assert.deepEqual(saved.triggers, []);
  assert.equal(saved.delivery, "steer");
  assert.equal(saved.debug, false);
  assert.equal(saved.outputSchema, undefined, "the default summary schema stays inherited");
}


// ── Reviews expose complete content, delete fallback, and schema editing ─

{
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  const contextFingerprint = shadowDefinitionContextFingerprint(grounding.layers);
  const longBody = `${"x".repeat(5000)}TAIL-SENTINEL`;
  let saves = 0;
  const longServices = {
    refresh: () => ({ definitions: [grounding], invalid: [], diagnostics: [], projectTrusted: true }),
    scopeOf: () => "project",
    overlaySnapshot: async (_scope, id) => ({
      filePath: `/scope/project/${id}.md`,
      fingerprint: "fp",
      contextFingerprint,
      content: serializeShadowDefinition({ id, enabled: false }),
    }),
    preview: (_scope, fields, expected) => ({
      content: serializeShadowDefinition(fields),
      filePath: `/scope/project/${fields.id}.md`,
      definition: { ...grounding, body: fields.body ?? grounding.body },
      errors: [],
      contextFingerprint: expected,
    }),
    previewDelete: (_scope, _id, _path, expected) => ({ definition: grounding, errors: [], contextFingerprint: expected }),
    approve: async () => { throw new Error("session changed"); },
    save: async () => { saves += 1; return { ok: true, message: "saved" }; },
    deleteOverlay: async () => ({ ok: true, message: "deleted" }),
  };
  const manager = new ShadowManager(
    { definitions: [grounding], invalid: [], diagnostics: [], projectTrusted: true },
    { requestRender() {}, terminal: { rows: 20, columns: 80 } },
    makeTheme(),
    makeKeybindings(),
    () => {},
    longServices,
  );
  await manager.reviewSave(grounding, "project", { id: grounding.id, body: longBody });
  assert.equal(manager.view.kind, "review");
  assert.ok(manager.view.lines.join("\n").includes("TAIL-SENTINEL"), "the complete candidate is retained in review state");
  for (let index = 0; index < 100; index += 1) manager.handleInput("down");
  assert.ok(render(manager, 80).join("\n").includes("TAIL-SENTINEL"), "the wrapped review can scroll to a long line's tail");
  manager.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saves, 0, "an aborted or failed confirmation performs no write");

  // The outputSchema field offers a custom bounded JSON editor.
  const schemaManager = new ShadowManager(
    { definitions: [grounding], invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(), makeTheme(), makeKeybindings(), () => {}, longServices,
  );
  schemaManager.handleInput("\r"); // actions
  schemaManager.handleInput("down");
  schemaManager.handleInput("down");
  schemaManager.handleInput("down");
  schemaManager.handleInput("\r"); // edit
  schemaManager.handleInput("\r"); // project
  for (let index = 0; index < 18; index += 1) schemaManager.handleInput("down");
  schemaManager.handleInput("\r"); // outputSchema field
  schemaManager.handleInput("down");
  schemaManager.handleInput("\r"); // set
  assert.ok(render(schemaManager).join("\n").includes("Set custom schema"));
  schemaManager.handleInput("down");
  schemaManager.handleInput("down");
  schemaManager.handleInput("\r");
  assert.ok(render(schemaManager).join("\n").includes("outputSchema JSON"), "custom schema editing is reachable");

  // Delete review includes the exact layer Markdown and effective fallback.
  const projectLayer = {
    scope: "project",
    filePath: "/scope/project/project-grounding.md",
    contentHash: "a".repeat(64),
    fields: { id: grounding.id, enabled: true },
  };
  const layered = { ...grounding, enabled: true, layers: [...grounding.layers, projectLayer] };
  const layeredContext = shadowDefinitionContextFingerprint(layered.layers);
  const deleteServices = {
    ...longServices,
    scopeOf: () => "project",
    overlaySnapshot: async () => ({
      filePath: projectLayer.filePath,
      fingerprint: "delete-fp",
      contextFingerprint: layeredContext,
      content: serializeShadowDefinition(projectLayer.fields),
    }),
    previewDelete: (_scope, _id, _path, expected) => ({ definition: grounding, errors: [], contextFingerprint: expected }),
  };
  const deleteManager = new ShadowManager(
    { definitions: [layered], invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(), makeTheme(), makeKeybindings(), () => {}, deleteServices,
  );
  deleteManager.handleInput("\r");
  deleteManager.handleInput("down");
  deleteManager.handleInput("down");
  deleteManager.handleInput("down");
  deleteManager.handleInput("down");
  deleteManager.handleInput("\r");
  deleteManager.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const deletionReview = deleteManager.view.lines.join("\n");
  assert.match(deletionReview, /LAYER MARKDOWN[\s\S]*enabled: true/);
  assert.match(deletionReview, /EFFECTIVE CHANGE[\s\S]*enabled: true → false/);
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
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const synthesizer = registry.definitions.find((definition) => definition.id === "session-synthesizer");
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  assert.ok(synthesizer.tools?.length === 0, "sanity: session-synthesizer declares the empty tool list");
  assert.ok(grounding.tools && grounding.tools.length > 0, "sanity: project-grounding declares evidence tools");

  const service = makeRuntimeService({ runs: [], results: [] });
  const withRun = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }), runtime: service.runtime },
  );
  let index = registry.definitions.findIndex((definition) => definition.id === "session-synthesizer");
  for (let step = 0; step < index; step += 1) withRun.handleInput("down");
  withRun.handleInput("\r");
  const noToolLines = render(withRun);
  assert.ok(noToolLines.some((line) => line.includes("Run manually")), "the no-tool definition offers a manual run");
  assert.ok(noToolLines.some((line) => line.includes("none — submit_shadow_result only")), "the no-tool label names the single tool");

  const withoutRun = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }), runtime: service.runtime },
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
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const synthesizer = registry.definitions.find((definition) => definition.id === "session-synthesizer");
  assert.ok(synthesizer);
  const service = makeRuntimeService({ runs: [], results: [] });
  const done = [];
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true, config: { enabled: true, defaults: { ...DEFAULT_CONFIG.shadowMinds.defaults, thinking: "medium" } } },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => done.push(1),
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }), runtime: service.runtime },
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
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const service = makeRuntimeService({ runs: [], results: [] });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true, config: { enabled: false, defaults: DEFAULT_CONFIG.shadowMinds.defaults } },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }), runtime: service.runtime },
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
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const runningRun = {
    id: "run-1", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", phase: "running", startedAt: 1_000, note: "trial",
  };
  const settledRun = {
    id: "run-2", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", phase: "submitted", startedAt: 1_000, endedAt: 2_000, resultId: "shr-1",
    systemHash: "aaaaaaaaaaaaaaaa", toolSchemaHash: "bbbbbbbbbbbbbbbb", trajectoryHash: "cccccccccccccccc",
    trajectoryTruncated: true,
    requests: [{ input: 700, output: 80, cacheRead: 12, cacheWrite: 4, cost: 0.02, ttftMs: 120 }],
  };
  const result = {
    id: "shr-1", shadowId: "session-synthesizer", shadowName: "Session synthesizer",
    trigger: "manual", payload: { summary: "Two decisions remain open." }, summary: "Two decisions remain open.",
    delivery: "notified", attention: "unread", createdAt: 2_000,
  };
  const service = makeRuntimeService({
    runs: [runningRun, settledRun],
    results: [result],
    evictionEvents: [{ kind: "evicted", id: "shr-old", at: 1_500, reason: "count" }],
  });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(),
    makeTheme(),
    makeKeybindings(),
    () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }), runtime: service.runtime },
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
  assert.ok(lines.includes("(truncated: dropped)"), "the truncation qualifier renders");
  assert.ok(lines.includes("1. in 700 · out 80"), "per-request metrics render");
  manager.handleInput("\r");
  manager.handleInput("up");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("View result"), "back returns to the run detail actions");
  manager.handleInput("\r");
  lines = render(manager).join("\n");
  assert.ok(lines.includes("Two decisions remain open."), "the result summary renders");
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
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: true });
  const service = makeRuntimeService({
    runs: [], results: [],
    evictionEvents: [{ kind: "evicted", id: "shr-old", at: 1_500, reason: "bytes" }],
  });
  const manager = new ShadowManager(
    { definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true },
    makeTui(), makeTheme(), makeKeybindings(), () => {},
    { refresh: () => ({ definitions: registry.definitions, invalid: [], diagnostics: [], projectTrusted: true }), runtime: service.runtime },
  );
  manager.handleInput("r");
  manager.handleInput("down");
  manager.handleInput("\r");
  const lines = render(manager).join("\n");
  assert.ok(lines.includes("Evicted result shr-old"));
  assert.ok(lines.includes("bytes retention"));
}

console.log("shadow-minds manager tests: OK");
