import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

initTheme();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  buildShadowConfigGuide,
  renderShadowConfigGuide,
  guideDefinitionMetadata,
} = await load(join(packageRoot, "src", "shadow-minds", "config-guide.ts"));

let registerShadowMinds;
let __testables;
const { discoverShadowDefinitions, shadowDefinitionContextFingerprint } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { ShadowManager } = await load(join(packageRoot, "src", "shadow-minds", "manager.ts"));
const { newShadowDefinitionDraft, serializeShadowDefinition } = await load(
  join(packageRoot, "src", "shadow-minds", "serialize.ts"),
);
const { DEFAULT_CONFIG, DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));
const { MISSING_OVERLAY_FINGERPRINT } = await load(join(packageRoot, "src", "shadow-minds", "overlays.ts"));

const PLAIN = /\x1b\[[0-9;]*m/g;
const theme = {
  fg(_token, text) { return String(text); },
  bold(text) { return String(text); },
};

function render(component, width = 100) {
  return component.render(width).map((line) => stripVTControlCharacters(String(line).replace(PLAIN, "")));
}

// ── Guide content contract ───────────────────────────────────────────

{
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: false });
  const guide = buildShadowConfigGuide(registry, packageRoot);
  assert.match(guide.content, /\[Shadow Config Guide\]/);
  assert.match(guide.content, /promptVersion: 1/);
  assert.match(guide.content, /disabled, priority 0, no automatic triggers, steer delivery/);
  assert.match(guide.content, /never write definition files directly/);
  assert.match(guide.content, /The next user message is the only authorized configuration request/);
  assert.ok(guide.content.includes(".pi/shadow-minds"), "the default project write path is documented");
  assert.ok(JSON.stringify(guide.content).length < 60_000, "the guide stays bounded");
  assert.equal(guide.details.version, 1);
  assert.equal(guide.details.definitionCount, registry.definitions.length);
  assert.equal(guide.details.includedDefinitionCount, registry.definitions.length);
  assert.deepEqual(guide.details.scopes, ["package"]);
  const metadata = guideDefinitionMetadata(registry);
  assert.ok(metadata.length > 0);
  assert.ok(metadata.every((entry) => !("body" in entry)), "responsibility bodies never enter the guide");
  assert.ok(metadata.every((entry) => entry.layers.length <= 3), "layer provenance is bounded");
}

// Registry-derived metadata uses the shared VT and credential sanitizer.
{
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: false });
  const poisoned = structuredClone(registry);
  poisoned.definitions[0].name = "safe\x1b]8;;https://evil.example\x07link\x1b]8;;\x07 Authorization: Bearer topsecret";
  poisoned.definitions[0].layers[0].filePath = "/tmp/api_key=topsecret/project-grounding.md";
  const guide = buildShadowConfigGuide(poisoned, packageRoot);
  assert.doesNotMatch(guide.content, /topsecret|evil\.example/);
  assert.match(guide.content, /\[REDACTED\]/);
}


// ── The guide budget trims large registries ─────────────────────────

{
  const many = Array.from({ length: 80 }, (_, index) => ({
    id: `shadow-${index}`,
    name: `Shadow ${index}`,
    enabled: false,
    hidden: false,
    priority: 0,
    triggers: [],
    triggerInstructions: {},
    delivery: "steer",
    completionGate: false,
    requiredTools: [],
    debug: false,
    outputSchema: { type: "object", additionalProperties: false },
    body: "Body.",
    fieldSources: {},
    layers: [{ scope: "agent", filePath: `/agent/shadow-minds/shadow-${index}.md`, contentHash: "0".repeat(64), fields: {} }],
  }));
  const registry = { definitions: many, invalid: [], diagnostics: [] };
  const guide = buildShadowConfigGuide(registry, packageRoot);
  assert.equal(guide.details.definitionCount, 80);
  assert.equal(guide.details.includedDefinitionCount, 50, "at most fifty definitions enter the guide");
  assert.match(guide.content, /30 omitted by the guide budget/);
  assert.deepEqual(guide.details.scopes, ["agent"]);
}

// ── Renderer collapsed and expanded ──────────────────────────────────

{
  const registry = discoverShadowDefinitions(packageRoot, { projectTrusted: false });
  const guide = buildShadowConfigGuide(registry, packageRoot);
  const collapsed = render(renderShadowConfigGuide(
    { content: guide.content, details: guide.details },
    { expanded: false },
    theme,
  ));
  assert.ok(collapsed.join("\n").includes("Shadow config guide"));
  assert.ok(collapsed.join("\n").includes("6 definitions"), "the collapsed row carries the count");
  const expanded = render(renderShadowConfigGuide(
    { content: guide.content, details: guide.details },
    { expanded: true },
    theme,
  ));
  const text = expanded.join("\n");
  assert.ok(text.includes("Configuration contract"), "the expanded view renders the contract");
  assert.ok(!text.includes("[Shadow Config Guide]"), "the bracket header is stripped for Markdown rendering");
}

// ── Parameterized command: guide before the unchanged request ───────

function fakePi() {
  const commands = new Map();
  const renderers = new Map();
  const events = [];
  const handlers = new Map();
  const entries = [];
  return {
    commands,
    renderers,
    events,
    handlers,
    entries,
    pi: {
      registerCommand(name, definition) { commands.set(name, definition); },
      registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
      sendMessage(message, options) { events.push(["guide", message, options]); },
      sendUserMessage(message, options) { events.push(["user", message, options]); },
      appendEntry(type, data) { entries.push({ type, data }); },
      on(event, handler) { handlers.set(event, handler); },
    },
  };
}

{
  const harness = fakePi();
  ({ default: registerShadowMinds } = await load(join(packageRoot, "src", "shadow-minds", "index.ts")));
  registerShadowMinds(harness.pi);
  const handler = harness.commands.get("shadow").handler;
  const request = "  create a grounding role for tests  ";
  await handler(request, { cwd: packageRoot, hasUI: false, isProjectTrusted: () => false });
  assert.equal(harness.renderers.has("pi-square.shadow-config-guide"), true, "the guide renderer is registered");
  assert.deepEqual(harness.events.map((event) => event[0]), ["guide", "user"], "guide first, user request second");
  assert.equal(harness.events[0][1].customType, "pi-square.shadow-config-guide");
  assert.match(harness.events[0][1].content, /Shadow Config Guide/);
  assert.doesNotMatch(harness.events[0][1].content, /create a grounding role for tests/, "the request is not embedded in the guide");
  assert.equal(harness.events[0][2].deliverAs, "followUp");
  assert.equal(harness.events[0][2].triggerTurn, undefined, "the guide itself does not trigger a turn");
  assert.equal(harness.events[1][1], request, "the native user request is forwarded byte-for-byte");
  assert.equal(harness.events[1][2].deliverAs, "followUp");
}

// ── The bare command opens the manager only with a UI ───────────────

{
  const harness = fakePi();
  ({ default: registerShadowMinds } = await load(join(packageRoot, "src", "shadow-minds", "index.ts")));
  registerShadowMinds(harness.pi);
  const handler = harness.commands.get("shadow").handler;
  let customCalls = 0;
  const ctx = {
    cwd: packageRoot,
    hasUI: false,
    isProjectTrusted: () => false,
    ui: {
      custom: async () => { customCalls += 1; },
      confirm: async () => false,
      notify() {},
    },
  };
  await handler("", ctx);
  assert.equal(customCalls, 0, "no manager without a UI");
  await handler(null, { ...ctx, hasUI: true });
  assert.equal(customCalls, 1, "the manager opens with a UI");
}

// ── End-to-end services write through the real safe writer ──────────

{
  const { ConfirmationCoordinator } = await load(join(packageRoot, "src", "core", "confirmation.ts"));
  const dir = mkdtempSync(join(tmpdir(), "pi-square-shadow-cmd-"));
  const project = join(dir, "project");
  mkdirSync(join(dir, "agent"), { recursive: true });
  mkdirSync(project, { recursive: true });
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    ({ default: registerShadowMinds, __testables } = await load(join(packageRoot, "src", "shadow-minds", "index.ts")));
    const state = registerShadowMinds(harness.pi);
    const confirmations = new ConfirmationCoordinator();
    const confirms = [];
    const notifications = [];
    const ctx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        custom: async () => {},
        confirm: async (title, message, opts) => {
          confirms.push({ title, message, signal: Boolean(opts?.signal) });
          return true;
        },
        notify(message, level) { notifications.push({ message, level }); },
      },
    };
    state.refresh(project, true);
    const services = __testables.makeServices(state, ctx, confirmations);

    // Preview composes the candidate against live package templates.
    const preview = services.preview("project", { id: "research-scout", enabled: true });
    assert.deepEqual(preview.errors, []);
    assert.ok(preview.definition.enabled);
    assert.ok(preview.filePath.endsWith("research-scout.md"));

    // The manager create flow drives approval, write, notify, and refresh.
    const done = [];
    const manager = new ShadowManager(
      state.managerSnapshot(),
      { requestRender() {}, terminal: { rows: 24, columns: 100 } },
      { fg: (_t, x) => x, bold: (x) => x },
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => done.push(1),
      services,
    );
    manager.handleInput("n");
    manager.handleInput("\r");
    for (const character of "e2e-role") manager.handleInput(character);
    manager.handleInput("\r");
    manager.handleInput("\r");
    for (const character of "E2E body.") manager.handleInput(character);
    manager.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const review = manager.render(100).join("\n");
    assert.ok(review.includes("LAYER MARKDOWN"), "the draft reaches the review");
    manager.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done.length, 1, "the manager closed itself for the approval");
    assert.equal(confirms.length, 1, "one coordinator-routed confirmation");
    assert.ok(confirms[0].signal, "the confirmation receives the coordinator abort signal");
    assert.ok(confirms[0].title.includes("project"), "the confirmation names the scope");
    const { readFileSync, existsSync } = await import("node:fs");
    const written = join(project, ".pi", "shadow-minds", "e2e-role.md");
    assert.ok(existsSync(written), "the approved draft landed on disk");
    const onDisk = readFileSync(written, "utf8");
    assert.match(onDisk, /enabled: false/);
    assert.match(onDisk, /delivery: "steer"/);
    assert.ok(notifications.some((entry) => entry.message.includes("saved e2e-role project overlay")), "the save outcome is notified");
    assert.ok(state.registry.definitions.some((definition) => definition.id === "e2e-role"), "the registry refreshed after the write");

    // A stale write is refused and reported for re-review.
    const currentReview = await services.overlaySnapshot("project", "e2e-role");
    const staleResult = await services.save(
      "project",
      { id: "e2e-role", enabled: true },
      currentReview.filePath,
      MISSING_OVERLAY_FINGERPRINT,
      currentReview.contextFingerprint,
      currentReview.identity,
    );
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.message, /changed since it was reviewed/);
    assert.ok(notifications.some((entry) => entry.message.includes("changed since it was reviewed")));

    // A decline routed through the manager approval writes nothing.
    confirms.length = 0;
    const declinedCtx = { ...ctx, ui: { ...ctx.ui, confirm: async (title, message, opts) => { confirms.push({ title, message, signal: Boolean(opts?.signal) }); return false; } } };
    const declinedServices = __testables.makeServices(state, declinedCtx, confirmations);
    state.refresh(project, true);
    const declinedManager = new ShadowManager(
      state.managerSnapshot(),
      { requestRender() {}, terminal: { rows: 24, columns: 100 } },
      { fg: (_t, x) => x, bold: (x) => x },
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => {},
      declinedServices,
    );
    // Run manually is the first action; the real TUI keybindings map the
    // down-arrow escape sequence, so navigate explicitly to Enable.
    declinedManager.handleInput("\r");
    declinedManager.handleInput("\x1b[B");
    declinedManager.handleInput("\r");
    declinedManager.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    declinedManager.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(confirms.length, 1, "the approval was requested");
    assert.ok(readFileSync(written, "utf8").includes("enabled: false"), "a declined approval changed nothing on disk");

    // AC4 regression: an external change during the review window is refused.
    const freshCtx = { ...ctx, ui: { ...ctx.ui, confirm: async () => true } };
    const freshServices = __testables.makeServices(state, freshCtx, new ConfirmationCoordinator());
    state.refresh(project, true);
    const racedManager = new ShadowManager(
      state.managerSnapshot(),
      { requestRender() {}, terminal: { rows: 24, columns: 100 } },
      { fg: (_t, x) => x, bold: (x) => x },
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => {},
      freshServices,
    );
    racedManager.handleInput("\r");
    racedManager.handleInput("\x1b[B");
    racedManager.handleInput("\r");
    racedManager.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const raceView = racedManager.render(100).join("\n");
    assert.ok(raceView.includes("LAYER MARKDOWN"), "the review opened (fingerprint captured at open)");
    const externalFingerprint = (await services.overlaySnapshot("project", "e2e-role")).fingerprint;
    const { writeFileSync: writeExternally } = await import("node:fs");
    writeExternally(written, readFileSync(written, "utf8").replace("enabled: false", "enabled: false\nname: \"Externally renamed\""), "utf8");
    racedManager.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(readFileSync(written, "utf8").includes("Externally renamed"), "the external version survives the raced approval");
    assert.ok(notifications.some((entry) => entry.message.includes("changed since it was reviewed")), "the raced write is refused with the stale-review outcome");
    assert.notEqual((await services.overlaySnapshot("project", "e2e-role")).fingerprint, externalFingerprint, "sanity: the file really changed externally");

    // Deletion through the reviewed fingerprint.
    const snapshot = await services.overlaySnapshot("project", "e2e-role");
    const deleted = await services.deleteOverlay(
      "project",
      "e2e-role",
      snapshot.filePath,
      snapshot.fingerprint,
      snapshot.contextFingerprint,
      snapshot.identity,
    );
    assert.equal(deleted.ok, true);
    assert.ok(!existsSync(written), "the reviewed overlay is deleted");

    // Coordinator serialization holds for concurrent approvals.
    const running = [];
    await Promise.all([
      confirmations.run(undefined, async () => { running.push("a-start"); await new Promise((r) => setTimeout(r, 10)); running.push("a-end"); return true; }),
      confirmations.run(undefined, async () => { running.push("b-start"); await new Promise((r) => setTimeout(r, 0)); running.push("b-end"); return true; }),
    ]);
    assert.deepEqual(running, ["a-start", "a-end", "b-start", "b-end"], "confirmations never interleave");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

const { ConfirmationCoordinator } = await load(join(packageRoot, "src", "core", "confirmation.ts"));

// ── Manual-run service wiring (#155) ────────────────────────────────

{
  const { DEFAULT_CONFIG: DEFAULT_CONFIG_TEMPLATE } = await load(join(packageRoot, "src", "core", "config.ts"));
  const { SHADOW_GOVERNANCE } = await load(join(packageRoot, "src", "shadow-minds", "prompt.ts"));
  const { DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));

  const dir = mkdtempSync(join(tmpdir(), "shadow-runtime-e2e-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(dir, "agent"), { recursive: true });
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const notifications = [];
    // A realistic post-compaction branch: the raw branch still carries the
    // replaced pre-compaction history, while the compaction-aware context
    // projection (what the parent model sees) keeps only the compaction
    // summary, the branch summary, and the post-compaction entries.
    const replacedHistory = { type: "message", message: { role: "user", content: "Ancient replaced request that must never reach the Shadow." } };
    const branchEntries = [
      replacedHistory,
      { type: "compaction", summary: "Earlier parser investigation was summarized." },
      { type: "branch_summary", summary: "An alternative tokenizer branch was explored." },
      { type: "message", message: { role: "user", content: "Investigate the flaky parser test." } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will inspect the tokenizer." }] } },
    ];
    // The session-start event context is a base Pi context: it carries no
    // getSystemPromptOptions. Only the command context exposes it, so the
    // capture path must go through the command context that opened the
    // manager — exactly as in production.
    const sessionCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        custom: async () => {},
        confirm: async () => true,
        notify(message, level) { notifications.push({ message, level }); },
      },
    };
    const ctx = {
      ...sessionCtx,
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
      sessionManager: {
        getLeafId: () => "leaf-1",
        getBranch: () => branchEntries,
        buildContextEntries: () => branchEntries.filter((entry) => entry !== replacedHistory),
      },
      getSystemPromptOptions: () => ({
        customPrompt: "Live core policy.",
        appendSystemPrompt: "Prefer tables.",
        contextFiles: [{ path: "/repo/AGENTS.md", content: "Live project rule." }],
      }),
    };

    const created = [];
    const ran = [];
    const runtimeDeps = {
      now: () => 1_000,
        async createSession(input) {
          created.push(input);
          return { session: { customTools: input.customTools } };
        },
        async runSession(input) {
          ran.push(input);
          const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
          if (submit) {
            await submit.execute(
              "c1",
              { payload: JSON.stringify({ decisions: [{ title: "Adopt the bounded parser", rationale: "It fits the contract." }], progress: "Parser trial passed.", open_questions: ["Which cache cohort?"] }) },
              undefined,
              undefined,
              ctx,
            );
          }
          return {
            status: "completed", prompted: true, timedOut: false,
            finalText: "", model: "acme/parent-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            streamingCompleted: true, messages: [],
          };
        },
    };
    const state = registerShadowMinds(
      harness.pi,
      undefined,
      () => ({ ...DEFAULT_CONFIG_TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );
    const confirmations = new ConfirmationCoordinator();

    // Open the parent session with the base context first; runtime
    // notifications have a UI surface, the capture cannot use this context,
    // and services bind to the session-scoped runtime replacement.
    await harness.handlers.get("session_start")({}, sessionCtx);
    assert.equal(harness.handlers.has("before_agent_start"), false, "prompt composition keeps its single-owner contract");
    const services = __testables.makeServices(state, ctx, confirmations);

    const refused = services.runtime.runManual({ shadowId: "missing-role" });
    assert.equal(refused.ok, false);
    assert.ok(refused.message.includes("no longer available"));

    // Agent-scope trial definitions for the #156 envelope contract.
    const agentShadowDir = join(dir, "agent", "shadow-minds");
    mkdirSync(agentShadowDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(agentShadowDir, "filtered-role.md"), [
      "---",
      "promptVersion: 1",
      "id: filtered-role",
      "name: Filtered role",
      "parentModels: [other/model-x]",
      "tools: [read]",
      "---",
      "Filtered body.",
      "",
    ].join("\n"));
    writeFileSync(join(agentShadowDir, "required-missing.md"), [
      "---",
      "promptVersion: 1",
      "id: required-missing",
      "name: Required missing",
      "tools: [read, bash]",
      "requiredTools: [bash]",
      "---",
      "Body.",
      "",
    ].join("\n"));
    writeFileSync(join(agentShadowDir, "warning-role.md"), [
      "---",
      "promptVersion: 1",
      "id: warning-role",
      "name: Warning role",
      "tools: [read, ssh]",
      "---",
      "Body.",
      "",
    ].join("\n"));

    // The parent-model filter refuses a mismatched parent model exactly.
    const filtered = services.runtime.runManual({ shadowId: "filtered-role" });
    assert.equal(filtered.ok, false, "a filtered parent model refuses the run");
    assert.ok(filtered.message.includes("other/model-x"), filtered.message);
    assert.ok(filtered.message.includes("acme/parent-model"), filtered.message);

    // A required excluded tool fails before the child session is created.
    const requiredMissing = services.runtime.runManual({ shadowId: "required-missing" });
    assert.equal(requiredMissing.ok, false, "missing required tools fail before prompting");
    assert.ok(requiredMissing.message.includes("Required Shadow tools are unavailable: bash"), requiredMissing.message);

    // Missing optional tools warn but the run still starts.
    notifications.length = 0;
    const warned = services.runtime.runManual({ shadowId: "warning-role" });
    assert.equal(warned.ok, true, warned.message);
    assert.ok(notifications.some((entry) => entry.message.includes("'ssh'") && entry.message.includes("excluded")));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // An evidence-grounded definition starts with its canonical envelope.
    const grounded = services.runtime.runManual({ shadowId: "project-grounding" });
    assert.equal(grounded.ok, true, grounded.message);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const started = services.runtime.runManual({ shadowId: "session-synthesizer", note: "Trial run." });
    assert.equal(started.ok, true, started.message);
    assert.ok(notifications.some((entry) => entry.message.includes("started manual run of session-synthesizer")));

    assert.equal(created.length, 3);
    // warning-role and project-grounding ran first; their tool envelopes
    // carry the canonical evidence names with the submit tool last.
    assert.deepEqual(created[0].tools, ["read", "submit_shadow_result"]);
    assert.deepEqual(created[1].tools, ["read", "grep", "find", "ls", "codegraph", "pdf_search", "submit_shadow_result"]);
    assert.deepEqual(created[1].customTools.map((tool) => tool.name), ["codegraph", "pdf_search", "submit_shadow_result"]);
    assert.ok(created[2].system.includes(SHADOW_GOVERNANCE.slice(0, 40)), "the versioned governance leads the child SYSTEM");
    assert.equal(created[2].thinkingLevel, undefined, "without a definition or config default the parent omission remains unset");
    assert.ok(created[2].system.includes("Live core policy."), "the parent core is captured at run start");
    assert.ok(created[2].system.includes("Prefer tables."), "append text joins the parent core");
    assert.ok(created[2].system.includes("Live project rule."), "trusted project rules are captured at run start");
    assert.deepEqual(created[2].tools, ["submit_shadow_result"], "the no-tool definition keeps its single-tool envelope");
    assert.equal(created[2].model.provider, "acme");
    assert.equal(created[2].model.id, "parent-model");

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ran[2].prompt.includes("Investigate the flaky parser test."), "the visible branch becomes the trajectory");
    assert.ok(ran[2].prompt.includes("Earlier parser investigation was summarized."), "compaction summaries are retained");
    assert.ok(ran[2].prompt.includes("An alternative tokenizer branch was explored."), "branch summaries are retained");
    assert.ok(!ran[2].prompt.includes("Ancient replaced request"), "compaction-replaced history never reaches the Shadow");
    assert.ok(ran[2].prompt.includes("I will inspect the tokenizer."), "assistant text is retained");
    assert.ok(ran[2].prompt.includes("Trial run."), "the manual note is embedded");
    assert.ok(!ran[2].prompt.includes("Live core policy."), "SYSTEM material stays out of the USER prompt");

    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = state.runtime.snapshot();
    assert.equal(snapshot.runs[0].phase, "submitted");
    assert.equal(snapshot.results.length, 1);
    assert.deepEqual(snapshot.results[0].payload, {
      decisions: [{ title: "Adopt the bounded parser", rationale: "It fits the contract." }],
      progress: "Parser trial passed.",
      open_questions: ["Which cache cohort?"],
    });
    assert.ok(
      snapshot.results[0].summary.startsWith('{"decisions":'),
      "a payload without summary/title/message falls back to the bounded canonical JSON prefix",
    );
    assert.ok(snapshot.results[0].summary.length <= 300);

    // Terminal notification for the UI session.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      notifications.some((entry) => entry.message.includes("result in the /shadow inbox")),
      "a submitted run announces its inbox result",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}




{
  // A manager review may outlive its guarded command context. Activation must
  // fail closed instead of throwing from Pi's stale-context getters.
  const harness = fakePi();
  const state = registerShadowMinds(harness.pi, undefined, () => ({
    ...DEFAULT_CONFIG,
    shadowMinds: { enabled: true, defaults: { ...DEFAULT_CONFIG.shadowMinds.defaults } },
  }), {
    now: () => 1,
    async createSession() { throw new Error("must not create"); },
    async runSession() { throw new Error("must not run"); },
  });
  const staleCtx = {
    cwd: packageRoot,
    hasUI: true,
    ui: { notify() {}, confirm: async () => true, custom: async () => {} },
    isProjectTrusted() { throw new Error("stale extension context"); },
  };
  const service = __testables.makeServices(state, staleCtx, new ConfirmationCoordinator());
  const refused = service.runtime.runManual({ shadowId: "session-synthesizer" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /no longer active/);
}


{
  // Manager-reviewed definitions and limits cannot drift before activation.
  let liveConfig = { ...DEFAULT_CONFIG, shadowMinds: { enabled: true, defaults: { ...DEFAULT_CONFIG.shadowMinds.defaults } } };
  let created = 0;
  const harness = fakePi();
  const state = registerShadowMinds(harness.pi, undefined, () => liveConfig, {
    now: () => 1,
    async createSession() { created += 1; return { session: {} }; },
    async runSession() { throw new Error("must not run"); },
  });
  const ctx = {
    cwd: packageRoot,
    hasUI: true,
    ui: { notify() {}, confirm: async () => true, custom: async () => {} },
    isProjectTrusted: () => true,
    model: { provider: "p", id: "m" },
    modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [], getLeafId: () => undefined },
    getSystemPromptOptions: () => ({ cwd: packageRoot }),
  };
  state.refresh(packageRoot, true);
  const definition = state.registry.definitions.find((entry) => entry.id === "session-synthesizer");
  const service = __testables.makeServices(state, ctx, new ConfirmationCoordinator());
  liveConfig = {
    ...liveConfig,
    shadowMinds: {
      ...liveConfig.shadowMinds,
      defaults: { ...liveConfig.shadowMinds.defaults, runTimeoutSeconds: liveConfig.shadowMinds.defaults.runTimeoutSeconds + 1 },
    },
  };
  const refused = service.runtime.runManual({
    shadowId: definition.id,
    definitionFingerprint: shadowDefinitionContextFingerprint(definition.layers),
    timeoutSeconds: DEFAULT_CONFIG.shadowMinds.defaults.runTimeoutSeconds,
    maxTurns: DEFAULT_CONFIG.shadowMinds.defaults.maxModelTurnsPerRun,
    maxToolCalls: DEFAULT_CONFIG.shadowMinds.defaults.maxToolCallsPerRun,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /changed since review/);
  assert.equal(created, 0);
}

// ── Manual authority uses canonical cwd, trust, and an explicit model ─

{
  const { DEFAULT_CONFIG: TEMPLATE, DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));
  const dir = mkdtempSync(join(tmpdir(), "shadow-authority-"));
  const realProject = join(dir, "real-project");
  const linkedProject = join(dir, "linked-project");
  mkdirSync(realProject, { recursive: true });
  symlinkSync(realProject, linkedProject, "dir");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  mkdirSync(join(dir, "agent"), { recursive: true });
  try {
    const harness = fakePi();
    const created = [];
    const runtimeDeps = {
      now: () => 1,
      async createSession(input) {
        created.push(input);
        return { session: { customTools: input.customTools } };
      },
      async runSession() {
        return {
          status: "completed", prompted: true, timedOut: false, finalText: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          streamingCompleted: true, messages: [],
        };
      },
    };
    const state = registerShadowMinds(
      harness.pi,
      undefined,
      () => ({ ...TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );
    const baseCtx = {
      cwd: linkedProject,
      hasUI: true,
      ui: { custom: async () => {}, notify() {}, confirm: async () => true },
      modelRegistry: { find: () => undefined },
      sessionManager: { getBranch: () => [], getLeafId: () => undefined },
      getSystemPromptOptions: () => ({
        customPrompt: "Parent core.",
        contextFiles: [{ path: join(realProject, "AGENTS.md"), content: "PROJECT-SECRET-RULE" }],
      }),
    };

    const untrustedCtx = { ...baseCtx, model: { provider: "p", id: "m" }, isProjectTrusted: () => false };
    state.refresh(linkedProject, false);
    const untrusted = __testables.makeServices(state, untrustedCtx, new ConfirmationCoordinator());
    const started = untrusted.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(created[0].cwd, realpathSync(linkedProject), "the child cwd is canonicalized");
    assert.doesNotMatch(created[0].system, /PROJECT-SECRET-RULE/, "untrusted project rules do not enter the Shadow SYSTEM");

    const noModelCtx = { ...baseCtx, model: undefined, isProjectTrusted: () => true };
    state.refresh(linkedProject, true);
    const noModel = __testables.makeServices(state, noModelCtx, new ConfirmationCoordinator());
    const refused = noModel.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /No parent model/);
    assert.equal(created.length, 1, "no child is created when no parent model is selected");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Persistent inbox wiring (#157) ─────────────────────────────────

{
  const { DEFAULT_CONFIG: DEFAULT_CONFIG_TEMPLATE } = await load(join(packageRoot, "src", "core", "config.ts"));
  const { DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));

  const { writeFileSync: writeDisk } = await import("node:fs");
  const { readFileSync: readDisk } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "shadow-persist-"));
  const project = join(dir, "project");
  // Pi 0.84.2 layout: one shared per-cwd directory of flat session files.
  const sessionDir = join(dir, "sessions");
  const sessionFile = join(sessionDir, "2026-08-24T00-00-00-000Z_alpha-1.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeDisk(sessionFile, "{}\n", "utf8");
  // A foreign orphan partition in the same shared directory.
  mkdirSync(join(sessionDir, ".pi-square-shadow", "other-session", "results"), { recursive: true });

  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(dir, "agent"), { recursive: true });
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const notifications = [];
    const sessionCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id }) },
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
        getSessionId: () => "alpha-1",
        getLeafId: () => "leaf-1",
        getBranch: () => [],
        buildContextEntries: () => [],
      },
      ui: { notify(message, level) { notifications.push({ message, level }); }, custom: async () => {} },
    };
    const created = [];
    const ran = [];
    const runtimeDeps = {
      now: () => 1_000,
      async createSession(input) {
        created.push(input);
        return { session: { customTools: input.customTools } };
      },
      async runSession(input) {
        ran.push(input);
        const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
        if (submit) await submit.execute(
          "c1",
          { payload: JSON.stringify({ decisions: [], progress: "persistent finding", open_questions: [] }) },
          undefined,
          undefined,
          sessionCtx,
        );
        return { status: "completed", prompted: true, timedOut: false, finalText: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, streamingCompleted: true, messages: [] };
      },
    };
    const state = registerShadowMinds(
      harness.pi,
      undefined,
      () => ({ ...DEFAULT_CONFIG_TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );
    await harness.handlers.get("session_start")({}, sessionCtx);
    assert.equal(state.partition?.sessionId, "alpha-1", "the session partition is bound");
    assert.ok(!existsSync(join(sessionDir, ".pi-square-shadow", "other-session")), "orphan partitions without session files reconcile");
    assert.ok(existsSync(join(sessionDir, ".pi-square-shadow", "alpha-1")), "the live session's partition survives reconciliation");
    const services = __testables.makeServices(state, sessionCtx, new (await load(join(packageRoot, "src", "core", "confirmation.ts"))).ConfirmationCoordinator());

    const started = services.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true, started.message);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(state.runtime.snapshot().results.length, 1);
    const resultId = state.runtime.snapshot().results[0].id;
    assert.equal(state.runtime.snapshot().results[0].configuredDelivery, "notify");
    const reference = harness.entries.find((entry) => entry.type === "pi-square.shadow-result");
    assert.ok(reference, "a bounded result reference lands in the parent session");
    assert.equal(reference.data.resultId, resultId);
    assert.ok(!("payload" in reference.data), "the reference never duplicates the payload");
    assert.ok(existsSync(join(sessionDir, ".pi-square-shadow", "alpha-1", "results", `${resultId}.json`)));

    // Reopening the same session keeps the result; the memory path warns.
    const referencesBefore = harness.entries.filter((entry) => entry.type === "pi-square.shadow-result").length;
    await harness.handlers.get("session_start")({}, sessionCtx);
    assert.equal(state.runtime.snapshot().results.length, 1, "results survive a session reopen");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      harness.entries.filter((entry) => entry.type === "pi-square.shadow-result").length,
      referencesBefore,
      "a reopen never re-appends reference entries for known results",
    );
    assert.equal(state.runtime.snapshot().results[0].id, resultId);

    // A non-persisted session falls back to memory visibly.
    const memoryCtx = { ...sessionCtx, sessionManager: { getSessionDir: () => "", getSessionFile: () => undefined, getSessionId: () => "beta" } };
    notifications.length = 0;
    await harness.handlers.get("session_start")({}, memoryCtx);
    assert.equal(state.partition, undefined);
    assert.equal(state.runtime.snapshot().results.length, 0, "the memory fallback starts empty");
    assert.ok(notifications.some((entry) => entry.message.includes("stay in memory")), "the fallback is visible");

    // The persistent partition content is validated on load.
    const index = JSON.parse(readDisk(join(sessionDir, ".pi-square-shadow", "alpha-1", "index.json"), "utf8"));
    assert.equal(index.version, 1);
    assert.ok(!("payload" in index.results[0]));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("shadow-minds config guide tests: OK");
