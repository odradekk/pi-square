import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { ShadowManager } = await load(join(packageRoot, "src", "shadow-minds", "manager.ts"));
const { newShadowDefinitionDraft, serializeShadowDefinition } = await load(
  join(packageRoot, "src", "shadow-minds", "serialize.ts"),
);
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
  return {
    commands,
    renderers,
    events,
    handlers,
    pi: {
      registerCommand(name, definition) { commands.set(name, definition); },
      registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
      sendMessage(message, options) { events.push(["guide", message, options]); },
      sendUserMessage(message, options) { events.push(["user", message, options]); },
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
    declinedManager.handleInput("\r");
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

// ── Manual-run service wiring (#155) ────────────────────────────────

{
  const { DEFAULT_CONFIG: DEFAULT_CONFIG_TEMPLATE } = await load(join(packageRoot, "src", "core", "config.ts"));
  const { SHADOW_GOVERNANCE } = await load(join(packageRoot, "src", "shadow-minds", "prompt.ts"));
  const { ConfirmationCoordinator } = await load(join(packageRoot, "src", "core", "confirmation.ts"));
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
    const branchEntries = [
      { type: "message", message: { role: "user", content: "Investigate the flaky parser test." } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will inspect the tokenizer." }] } },
    ];
    const ctx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
      sessionManager: {
        getLeafId: () => "leaf-1",
        getBranch: () => branchEntries,
      },
      getSystemPromptOptions: () => ({
        customPrompt: "Answer concisely.",
        appendSystemPrompt: "Prefer examples.",
        contextFiles: [{ path: "/repo/AGENTS.md", content: "Run npm test before claiming done." }],
      }),
      ui: {
        custom: async () => {},
        confirm: async () => true,
        notify(message, level) { notifications.push({ message, level }); },
      },
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
          await input.session.customTools[0].execute(
            "c1",
            { payload: JSON.stringify({ decisions: [{ title: "Adopt the bounded parser", rationale: "It fits the contract." }], progress: "Parser trial passed.", open_questions: ["Which cache cohort?"] }) },
            undefined,
            undefined,
            ctx,
          );
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
    const services = __testables.makeServices(state, ctx, confirmations);

    // Open the parent session so runtime notifications have a UI context.
    await harness.handlers.get("session_start")({}, ctx);

    // Freeze the task snapshot from before_agent_start, then drift the live
    // options: the run must compose from the frozen authority.
    await harness.handlers.get("before_agent_start")({
      systemPromptOptions: {
        customPrompt: "Frozen core policy.",
        contextFiles: [{ path: "/repo/AGENTS.md", content: "Frozen project rule." }],
      },
    }, { cwd: project });
    ctx.getSystemPromptOptions = () => ({ customPrompt: "Drifted policy." });

    const refused = services.runtime.runManual({ shadowId: "missing-role" });
    assert.equal(refused.ok, false);
    assert.ok(refused.message.includes("no longer available"));

    const toolRefused = services.runtime.runManual({ shadowId: "project-grounding" });
    assert.equal(toolRefused.ok, false, "omitted-tools definitions are outside the #155 manual-trial scope");
    assert.ok(toolRefused.message.includes("tools: []"));

    const started = services.runtime.runManual({ shadowId: "session-synthesizer", note: "Trial run." });
    assert.equal(started.ok, true, started.message);
    assert.ok(notifications.some((entry) => entry.message.includes("started manual run of session-synthesizer")));

    assert.equal(created.length, 1);
    assert.ok(created[0].system.includes(SHADOW_GOVERNANCE.slice(0, 40)), "the versioned governance leads the child SYSTEM");
    assert.ok(created[0].system.includes("Frozen core policy."), "the frozen parent core is used, not the drifted one");
    assert.ok(created[0].system.includes("Frozen project rule."), "the frozen project rules are used");
    assert.ok(!created[0].system.includes("Drifted policy."), "live drift never enters the run");
    assert.deepEqual(created[0].tools, ["submit_shadow_result"]);
    assert.equal(created[0].model.provider, "acme");
    assert.equal(created[0].model.id, "parent-model");

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ran[0].prompt.includes("Investigate the flaky parser test."), "the visible branch becomes the trajectory");
    assert.ok(ran[0].prompt.includes("I will inspect the tokenizer."), "assistant text is retained");
    assert.ok(ran[0].prompt.includes("Trial run."), "the manual note is embedded");
    assert.ok(!ran[0].prompt.includes("Frozen core policy."), "SYSTEM material stays out of the USER prompt");

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

console.log("shadow-minds config guide tests: OK");
