import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { DEFAULT_CONFIG, DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));

// File-scope agent base with the six fixture definitions (#188): the former
// package templates live on as test data so discovery is fully controlled by
// temp directories instead of shipped assets.
const { installShadowFixtures } = await import("./lib/fixtures.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-square-shadow-guide-fixture-"));
const fixtureProject = join(fixtureRoot, "project");
mkdirSync(fixtureProject, { recursive: true });
installShadowFixtures(join(fixtureRoot, "agent"));
process.env.PI_AGENT_DIR = join(fixtureRoot, "agent");
process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");

const PLAIN = /\x1b\[[0-9;]*m/g;
const theme = {
  fg(_token, text) { return String(text); },
  bold(text) { return String(text); },
};

function render(component, width = 100) {
  return component.render(width).map((line) => stripVTControlCharacters(String(line).replace(PLAIN, "")));
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

// ── Guide content contract ───────────────────────────────────────────

{
  const registry = discoverShadowDefinitions(fixtureProject);
  const guide = buildShadowConfigGuide(registry, packageRoot);
  assert.match(guide.content, /\[Shadow Config Guide\]/);
  assert.match(guide.content, /promptVersion: 1/);
  assert.match(guide.content, /disabled, priority 0, no automatic triggers, steer delivery/);
  assert.match(guide.content, /The next user message is the only authorized configuration request/);
  // #189: the Guide is the natural-language configuration path.
  assert.match(guide.content, /Consultations?[^.]*without changing any file/, "consultations answer without file changes");
  assert.match(guide.content, /ordinary (?:read, write, and replace|file)/, "create/modify work is ordinary file work");
  assert.match(guide.content, /delete[^.]*platform shell/, "deletion names the platform shell");
  assert.match(guide.content, /minimal clarification question/, "ambiguous scope or deletion asks one clarification");
  assert.match(guide.content, /deleting a project overlay reveals the agent base/, "overlay deletion consequence is explicit");
  assert.match(guide.content, /deleting an agent base can strand a minimal project overlay/, "base deletion warning is explicit");
  assert.match(guide.content, /omitted or empty body inherits/, "body inheritance matches production parsing");
  assert.match(guide.content, /omitting model inherits/, "model inheritance uses omission rather than an invalid empty scalar");
  assert.match(guide.content, /definition's own enabled field arms only that definition/, "definition enablement is distinct from the master switch");
  assert.ok(guide.content.includes(".pi/shadow-minds"), "the default project write path is documented");
  assert.ok(
    guide.content.includes(join(fixtureRoot, "agent", "shadow-minds")),
    "the runtime-resolved agent base path is documented",
  );
  assert.ok(guide.content.includes(join(packageRoot, ".pi", "shadow-minds")), "the runtime-resolved project overlay path is documented");
  assert.ok(guide.content.includes("pi-square.json"), "the agent config path is documented");
  assert.match(guide.content, /never (?:turns the master switch on|enables the master switch)/, "drafts never enable the master switch");
  assert.match(guide.content, /explicitly asks to enable/, "only explicit requests may enable");
  assert.match(guide.content, /preserve every unrelated setting/, "agent config edits preserve unrelated settings");
  assert.match(guide.content, /Re-read every file/, "mutations end with a disk re-read");
  assert.match(guide.content, /reopen \/shadow/, "the report points back at production diagnostics");
  assert.match(guide.content, /never run as definitions/, "packaged references are non-running");
  assert.match(guide.content, /upgrades may overwrite/, "package reference edits are upgrade-fragile");
  assert.match(guide.content, /tool_turn/, "the trigger decision tree names tool_turn");
  assert.match(guide.content, /completionGate/, "the gate decision is documented");
  assert.match(guide.content, /maxToolCalls/, "budgets are documented");
  assert.doesNotMatch(guide.content, /never write definition files directly/, "the manager-only write instruction is gone");
  assert.doesNotMatch(guide.content, /review and confirmation/, "no Shadow-specific confirmation remains");
  assert.ok(guide.content.includes("read, grep, find, ls, codegraph, pdf_search, search, fetch, libs, docs"), "the read-only catalog is documented");
  assert.ok(JSON.stringify(guide.content).length < 60_000, "the guide stays bounded");
  assert.equal(guide.details.version, 1);
  assert.equal(guide.details.definitionCount, registry.definitions.length);
  assert.equal(guide.details.includedDefinitionCount, registry.definitions.length);
  assert.deepEqual(guide.details.scopes, ["agent"], "the agent fixture layer is the only scope");
  const metadata = guideDefinitionMetadata(registry);
  assert.ok(metadata.length > 0);
  assert.ok(metadata.every((entry) => !("body" in entry)), "responsibility bodies never enter the guide");
  assert.ok(metadata.every((entry) => entry.layers.length <= 3), "layer provenance is bounded");
}

// A project scope rejected by discovery must not make consultations fail or
// redirect ordinary writes to a fallback path (#189).
{
  const root = mkdtempSync(join(tmpdir(), "pi-square-shadow-guide-unsafe-project-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  try {
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(project, ".pi", "shadow-minds"), "dir");
    const registry = discoverShadowDefinitions(project);
    assert.ok(registry.diagnostics.some((entry) => /outside the project workspace/.test(entry.message)));
    const guide = buildShadowConfigGuide(registry, project);
    assert.match(guide.content, /Project overlay unavailable/);
    assert.match(guide.content, /Do not create, modify, or delete project-scope definitions/);
    assert.match(guide.content, /consultations and agent-scope work remain available/);
    assert.ok(
      !guide.content.includes(`${join(project, ".pi", "shadow-minds")}. Writes follow discovery`),
      "the rejected project path is never presented as a writable target",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Registry-derived metadata uses the shared VT and credential sanitizer.
{
  const registry = discoverShadowDefinitions(fixtureProject);
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
  const registry = discoverShadowDefinitions(fixtureProject);
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
  assert.ok(text.includes("How to treat the next user message"), "the expanded view renders the request-handling section");
  assert.ok(!text.includes("[Shadow Config Guide]"), "the bracket header is stripped for Markdown rendering");
}

// ── Parameterized command: guide before the unchanged request ───────

function DEFAULT_SHADOW_MINDS_BASE() {
  return {
    version: 2,
    banner: { enabled: false },
    ssh: { maxSessions: 1, profiles: [] },
    anchoredEditing: { enabled: false, autoRead: true },
    display: {},
  };
}

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

{
  const root = mkdtempSync(join(tmpdir(), "pi-square-shadow-command-unsafe-project-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  try {
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(project, ".pi", "shadow-minds"), "dir");
    const harness = fakePi();
    ({ default: registerShadowMinds } = await load(join(packageRoot, "src", "shadow-minds", "index.ts")));
    registerShadowMinds(harness.pi);
    const handler = harness.commands.get("shadow").handler;
    const request = "explain why project Shadow configuration is unavailable";
    await handler(request, { cwd: project, hasUI: false, isProjectTrusted: () => false });
    assert.deepEqual(harness.events.map((event) => event[0]), ["guide", "user"]);
    assert.match(harness.events[0][1].content, /Project overlay unavailable/);
    assert.equal(harness.events[1][1], request);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  installShadowFixtures(join(dir, "agent"));
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
    ({ default: registerShadowMinds, __testables } = await load(join(packageRoot, "src", "shadow-minds", "index.ts")));
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_CONFIG_TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );

    // Open the parent session with the base context first; runtime
    // notifications have a UI surface, the capture cannot use this context,
    // and services bind to the session-scoped runtime replacement.
    await harness.handlers.get("session_start")({}, sessionCtx);
    // Prompt-manager keeps sole ownership of system-prompt replacement:
    // shadow-minds' before_agent_start observer freezes the task snapshot
    // and never returns a prompt-modifying result.
    const observer = harness.handlers.get("before_agent_start");
    assert.equal(typeof observer, "function", "the task-snapshot observer is registered");
    const observed = await observer(
      { type: "before_agent_start", prompt: "task", systemPromptOptions: { cwd: "/repo", contextFiles: [] } },
      sessionCtx,
    );
    assert.equal(observed, undefined, "the observer never modifies prompt composition");
    const services = __testables.makeServices(state, ctx);

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
  const state = registerShadowMinds(harness.pi, () => ({
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
    // #188 removed the trust read; the model getter is the stale-context
    // surface manual activation still reads.
    get model() { throw new Error("stale extension context"); },
  };
  const service = __testables.makeServices(state, staleCtx);
  const refused = service.runtime.runManual({ shadowId: "session-synthesizer" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /no longer active/);
}


{
  // Manager-reviewed definitions and limits cannot drift before activation.
  let liveConfig = { ...DEFAULT_CONFIG, shadowMinds: { enabled: true, defaults: { ...DEFAULT_CONFIG.shadowMinds.defaults } } };
  let created = 0;
  const harness = fakePi();
  const state = registerShadowMinds(harness.pi, () => liveConfig, {
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
  state.refresh(fixtureProject);
  const definition = state.registry.definitions.find((entry) => entry.id === "session-synthesizer");
  const service = __testables.makeServices(state, ctx);
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

// ── Manual authority uses canonical cwd, project rules, and an explicit model ─

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
  installShadowFixtures(join(dir, "agent"));
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

    // #188: project rules participate regardless of project approval — the
    // fixed read-only catalog, not trust, is the capability boundary.
    const rulesCtx = { ...baseCtx, model: { provider: "p", id: "m" }, isProjectTrusted: () => false };
    state.refresh(linkedProject);
    const withRules = __testables.makeServices(state, rulesCtx);
    const started = withRules.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(created[0].cwd, realpathSync(linkedProject), "the child cwd is canonicalized");
    assert.match(created[0].system, /PROJECT-SECRET-RULE/, "project rules enter the Shadow SYSTEM regardless of approval");

    const noModelCtx = { ...baseCtx, model: undefined, isProjectTrusted: () => true };
    state.refresh(linkedProject);
    const noModel = __testables.makeServices(state, noModelCtx);
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
  installShadowFixtures(join(dir, "agent"));
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
      () => ({ ...DEFAULT_CONFIG_TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );
    await harness.handlers.get("session_start")({}, sessionCtx);
    assert.equal(state.partition?.sessionId, "alpha-1", "the session partition is bound");
    assert.ok(!existsSync(join(sessionDir, ".pi-square-shadow", "other-session")), "orphan partitions without session files reconcile");
    assert.ok(existsSync(join(sessionDir, ".pi-square-shadow", "alpha-1")), "the live session's partition survives reconciliation");
    const services = __testables.makeServices(state, sessionCtx);

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

    // Reopening the same session keeps the result and never re-appends its
    // transcript reference: the persisted `referenced` mark survives.
    const referencesBefore = harness.entries.filter((entry) => entry.type === "pi-square.shadow-result").length;
    assert.equal(referencesBefore, 1, "exactly one reference entry was appended");
    await harness.handlers.get("session_start")({}, sessionCtx);
    assert.equal(state.runtime.snapshot().results.length, 1, "results survive a session reopen");
    assert.equal(state.runtime.snapshot().results[0].referenced, true, "the reference mark reloads");
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

// ── Deterministic automatic scheduling end to end (#158) ────────────

{
  const dir = mkdtempSync(join(tmpdir(), "shadow-schedule-e2e-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const agentShadowDir = join(dir, "agent", "shadow-minds");
  mkdirSync(agentShadowDir, { recursive: true });
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(agentShadowDir, "auto-lens.md"), [
      "---",
      "promptVersion: 1",
      "id: auto-lens",
      "name: Auto lens",
      "enabled: true",
      "priority: 5",
      "triggers: [mutation, tool_turn]",
      "triggerInstructions:",
      "  mutation: Focus on structural impact.",
      "tools: [read]",
      "---",
      "Watch the architecture.",
      "",
    ].join("\n"));

    const harness = fakePi();
    const notifications = [];
    const statusCalls = [];
    const branch = [{ type: "message", message: { role: "user", content: "Refactor the parser." } }];
    const eventCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        custom: async () => {},
        confirm: async () => true,
        notify(message, level) { notifications.push({ message, level }); },
        setStatus(key, text) { statusCalls.push({ key, text }); },
      },
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
      sessionManager: {
        getSessionDir: () => "",
        getSessionFile: () => undefined,
        getSessionId: () => "sched-1",
        getLeafId: () => "leaf-1",
        getBranch: () => branch,
        buildContextEntries: () => branch,
      },
    };
    const created = [];
    const prompts = [];
    const runtimeDeps = {
      now: () => 1_000,
      async createSession(input) {
        created.push(input);
        return { session: { customTools: input.customTools } };
      },
      async runSession(input) {
        prompts.push(input.prompt);
        const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
        if (submit) {
          await submit.execute("c1", { payload: JSON.stringify({ summary: "Structure is stable." }) }, undefined, undefined, eventCtx);
        }
        return {
          status: "completed", prompted: true, timedOut: false, finalText: "",
          model: "acme/parent-model",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          streamingCompleted: true, messages: [],
        };
      },
    };
    const state = registerShadowMinds(
      harness.pi,
      () => ({
        ...DEFAULT_SHADOW_MINDS_BASE(),
        shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } },
      }),
      runtimeDeps,
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    assert.equal(state.registry.definitions.some((entry) => entry.id === "auto-lens"), true, "the enabled definition is discovered");

    // A real-user task opens: input → frozen snapshot → tool activity →
    // turn end → one automatic run with merged reasons.
    harness.handlers.get("input")({ type: "input", text: "refactor", source: "interactive" });
    await harness.handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "refactor", systemPromptOptions: { cwd: project, customPrompt: "Core.", contextFiles: [{ path: "/p/R.md", content: "Rule." }] } },
      eventCtx,
    );
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { file_path: "src/a.ts" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: {}, isError: false });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: {}, isError: true });
    // t2 has no paired start args: the failure cannot classify, so only the
    // mutation reason should appear.
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(created.length, 1, "one automatic run started from the mutation trigger");
    const run = state.runtime.snapshot().runs.find((entry) => entry.source === "automatic");
    assert.ok(run, "the run view records its automatic source");
    assert.equal(run.trigger, "mutation");
    assert.equal(run.taskEpoch, 2);
    assert.deepEqual(run.triggerReasons.map((reason) => reason.trigger), ["mutation", "tool_turn"], "same-turn reasons coalesce, priority-ordered");
    assert.ok(prompts[0].includes("[Trigger task — mutation]"), "the prompt carries the trigger task");
    assert.ok(prompts[0].includes("Focus on structural impact."), "the trigger instruction renders");
    assert.ok(created[0].system.includes("Core."), "the frozen task snapshot's parent core is used");
    assert.ok(created[0].system.includes("Rule."), "frozen trusted project rules are used");
    const result = state.runtime.snapshot().results[0];
    assert.ok(result, "the automatic submission landed in the inbox");
    assert.deepEqual(result.triggers, ["mutation", "tool_turn"]);
    assert.equal(result.taskIdentity.epoch, 2);
    assert.ok(harness.entries.some((entry) => entry.type === "pi-square.shadow-result"), "the transcript reference was appended");
    assert.ok(statusCalls.some((call) => call.key === "pi-square.shadow-minds" && /1 unread/.test(call.text ?? "")), "the footer status shows the unread count");

    // Extension continuations never create trigger opportunities.
    harness.handlers.get("input")({ type: "input", text: "continue", source: "extension" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "continue", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t3", toolName: "edit", args: { file_path: "b.ts" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t3", toolName: "edit", result: {}, isError: false });
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 1, "extension continuations trigger nothing");

    // Session pause blocks automatic work and is visible.
    state.scheduler.pause();
    harness.handlers.get("input")({ type: "input", text: "next", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "next", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t4", toolName: "write", args: { file_path: "c.ts" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t4", toolName: "write", result: {}, isError: false });
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 1, "paused sessions start no automatic runs");
    assert.ok(state.scheduler.snapshot().paused);
    state.scheduler.resume();

    // User interruption cancels current-task work and clears pending.
    harness.handlers.get("input")({ type: "input", text: "again", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "again", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t5", toolName: "read", args: { path: "x" } });
    await harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    harness.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 2, "the tool-turn activation started before the interruption");
    assert.equal(state.scheduler.snapshot().pending.length, 0);

    // A classified quality failure triggers a failure-subscribed Shadow.
    writeFileSync(join(agentShadowDir, "auto-guard.md"), [
      "---",
      "promptVersion: 1",
      "id: auto-guard",
      "name: Auto guard",
      "enabled: true",
      "triggers: [failure]",
      "tools: []",
      "---",
      "Watch quality gates.",
      "",
    ].join("\n"));
    state.refresh(project);
    harness.handlers.get("input")({ type: "input", text: "fix", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "fix", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t6", toolName: "bash", args: { command: "npm run typecheck" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t6", toolName: "bash", result: {}, isError: true });
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const guardRun = state.runtime.snapshot().runs.find((entry) => entry.shadowId === "auto-guard");
    assert.ok(guardRun, "the classified typecheck failure started the guard Shadow");
    assert.equal(guardRun.triggerReasons[0].detail, "typecheck command failed");

    // Shutdown clears the footer status.
    await harness.handlers.get("session_shutdown")({ type: "session_shutdown" });
    assert.ok(statusCalls.some((call) => call.key === "pi-square.shadow-minds" && call.text === undefined), "shutdown clears the status");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Spec-review regressions: abort, per-Shadow guard, memory downgrade ──

{
  // Task-snapshot store: per-epoch authority, bounded retention.
  const { __testables: exported } = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
  const store = exported.createTaskSnapshotStore();
  const a = { projectRules: [], cwd: "/a" };
  const b = { projectRules: [], cwd: "/b" };
  store.record(2, a);
  store.record(3, b);
  assert.equal(store.get(2), a);
  assert.equal(store.get(3), b);
  assert.equal(store.get(4), undefined);
  for (let epoch = 4; epoch <= 9; epoch += 1) store.record(epoch, { projectRules: [], cwd: `/e${epoch}` });
  assert.equal(store.get(2), undefined, "the oldest epochs are evicted");
  assert.notEqual(store.get(9), undefined);
}

{
  // Full e2e through the real wiring: an aborted turn dispatches nothing and
  // leaks nothing; a same-Shadow second activation stays pending while its
  // run is active; the in-memory inbox downgrades old-task results; a paused
  // idle session still shows the footer status.
  const dir = mkdtempSync(join(tmpdir(), "shadow-spec-e2e-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const agentShadowDir = join(dir, "agent", "shadow-minds");
  mkdirSync(agentShadowDir, { recursive: true });
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(agentShadowDir, "guard-role.md"), [
      "---",
      "promptVersion: 1",
      "id: guard-role",
      "name: Guard role",
      "enabled: true",
      "triggers: [failure, tool_turn]",
      "tools: []",
      "---",
      "Watch quality.",
      "",
    ].join("\n"));

    const harness = fakePi();
    const statusCalls = [];
    const branch = [];
    const eventCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        custom: async () => {},
        confirm: async () => true,
        notify() {},
        setStatus(key, text) { statusCalls.push({ key, text }); },
      },
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
      sessionManager: {
        getSessionDir: () => "",
        getSessionFile: () => undefined,
        getSessionId: () => "spec-1",
        getLeafId: () => "leaf-1",
        getBranch: () => branch,
        buildContextEntries: () => branch,
      },
    };
    const created = [];
    const holdRun = { active: false };
    const runtimeDeps = {
      now: () => 1_000,
      async createSession(input) {
        created.push(input);
        return { session: { customTools: input.customTools } };
      },
      async runSession(input) {
        if (holdRun.active) {
          await new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
          return { status: "aborted", prompted: true, timedOut: false, finalText: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, streamingCompleted: false, messages: [] };
        }
        const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
        if (submit) {
          await submit.execute("c1", { payload: JSON.stringify({ summary: "done" }) }, undefined, undefined, eventCtx);
        }
        return { status: "completed", prompted: true, timedOut: false, finalText: "", model: "acme/parent-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, streamingCompleted: true, messages: [] };
      },
    };
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );
    await harness.handlers.get("session_start")({}, eventCtx);

    // Aborted turn: the classified failure is dropped at turn_end and the
    // interruption at agent_end cancels nothing extra.
    harness.handlers.get("input")({ type: "input", text: "run tests", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "run tests", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true });
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, eventCtx);
    harness.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 0, "an aborted quality command dispatches nothing");

    // One activation per Shadow: a held run keeps the next activation queued.
    holdRun.active = true;
    harness.handlers.get("input")({ type: "input", text: "work", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "work", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "x" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", result: {}, isError: false });
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 1, "the first tool-turn activation started");
    assert.equal(state.runtime.snapshot().runs.filter((run) => run.phase === "running").length, 1);
    assert.equal(state.scheduler.snapshot().pending.length, 0, "no duplicate run of the active Shadow");

    // A second dirty generation during the run stays pending, then
    // dispatches with its latest checkpoint once the held run settles.
    harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "t3", toolName: "grep", args: { pattern: "y" } });
    harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "t3", toolName: "grep", result: {}, isError: false });
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 1, "the running Shadow never starts a duplicate concurrent run");
    assert.equal(state.scheduler.snapshot().pending.length, 1, "the newer generation stays queued");

    holdRun.active = false;
    const running = state.runtime.snapshot().runs.find((run) => run.phase === "running");
    state.runtime.cancelRun(running.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(created.length, 2, "the queued activation dispatches after the run settles");

    // In-memory downgrade: a result from an old task flips to notify when a
    // new task opens (the in-memory inbox is the fallback here).
    const result = state.runtime.snapshot().results.at(-1);
    assert.ok(result, "the settled run produced a result");
    assert.notEqual(result.configuredDelivery, "notify");
    harness.handlers.get("input")({ type: "input", text: "next task", source: "interactive" });
    assert.notEqual(
      state.runtime.snapshot().results.find((entry) => entry.id === result.id).configuredDelivery,
      "notify",
      "input alone does not advance a task before Pi starts its agent run",
    );
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "next task", systemPromptOptions: { cwd: project } }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      state.runtime.snapshot().results.find((entry) => entry.id === result.id).configuredDelivery,
      "notify",
      "old-task undelivered results downgrade in the in-memory inbox too",
    );

    // Streaming user input has no before_agent_start boundary in Pi. It opens
    // its task only when the queued user message is consumed by the agent loop.
    // Consume the initial user message emitted by the preceding idle run.
    harness.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "next task" }] } });
    const beforeQueuedEpoch = state.scheduler.snapshot().taskEpoch;
    harness.handlers.get("input")({
      type: "input",
      text: "queued task",
      source: "interactive",
      streamingBehavior: "followUp",
    });
    assert.equal(state.scheduler.snapshot().taskEpoch, beforeQueuedEpoch);
    harness.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "queued task" }] } });
    assert.equal(state.scheduler.snapshot().taskEpoch, beforeQueuedEpoch + 1, "the consumed queued user message opens the task epoch");

    // Paused session: the paused marker renders alongside any counts.
    state.scheduler.pause();
    const last = statusCalls.filter((call) => call.key === "pi-square.shadow-minds").at(-1);
    assert.ok(/paused/.test(last?.text ?? ""), `the paused marker renders with the status: ${last?.text}`);
    state.scheduler.resume();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Confirmed delivery wiring (#159) ───────────────────────────────

function writeShadowDefinition(dir, id, name, delivery, triggers) {
  writeFileSync(join(dir, `${id}.md`), [
    "---",
    "promptVersion: 1",
    `id: ${id}`,
    `name: ${name}`,
    "enabled: true",
    `triggers: [${triggers.join(", ")}]`,
    `delivery: ${delivery}`,
    "tools: []",
    "---",
    "Observe and report.",
    "",
  ].join("\n"));
}

async function deliveryE2eSetup(dirname, definitions) {
  const dir = mkdtempSync(join(tmpdir(), dirname));
  const project = join(dir, "project");
  const agentShadowDir = join(dir, "agent", "shadow-minds");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentShadowDir, { recursive: true });
  for (const definition of definitions) writeShadowDefinition(agentShadowDir, ...definition);
  return { dir, project, agentShadowDir };
}

function deliveryEventCtx(project, sinks) {
  return {
    cwd: project,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      custom: async () => {},
      confirm: async () => true,
      notify(message, level) { sinks.notifications.push({ message, level }); },
      setStatus(key, text) { sinks.statusCalls.push({ key, text }); },
    },
    model: { provider: "acme", id: "parent-model" },
    modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
    sessionManager: {
      getSessionDir: () => "",
      getSessionFile: () => undefined,
      getSessionId: () => "sess-delivery",
      getLeafId: () => "leaf-1",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
  };
}

function deliveryRuntimeDeps(sinks, options = {}) {
  return {
    now: () => 1_000,
    async createSession(input) {
      return { session: { customTools: input.customTools } };
    },
    async runSession(input) {
      if (options.fail) {
        return { status: "error", prompted: true, timedOut: false, error: new Error("model auth failed"), finalText: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, streamingCompleted: false, messages: [] };
      }
      const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
      if (submit) {
        await submit.execute("c1", { payload: JSON.stringify({ summary: options.summary ?? "advisory finding" }) }, undefined, undefined, sinks.eventCtx);
      }
      return { status: "completed", prompted: true, timedOut: false, finalText: "", model: "acme/parent-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, streamingCompleted: true, messages: [] };
    },
  };
}

function shadowDeliveries(harness) {
  return harness.events.filter((event) => event[0] === "guide" && event[1].customType === "pi-square.shadow-notification");
}

const previousAgentDir159 = process.env.PI_AGENT_DIR;
const previousCodingAgentDir159 = process.env.PI_CODING_AGENT_DIR;

{
  // Wake: the completion run settles, its result starts a follow-up turn,
  // and transcript observation confirms the delivery.
  const { dir } = await deliveryE2eSetup("shadow-wake-", [["wake-sentinel", "Wake sentinel", "wake", ["completion"]]]);
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = deliveryEventCtx(dir.includes("x") ? dir : join(dir, "project"), sinks);
    sinks.eventCtx = eventCtx;
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      deliveryRuntimeDeps(sinks),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    harness.handlers.get("input")({ type: "input", text: "finish the feature", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "finish the feature", systemPromptOptions: { cwd: join(dir, "project") } }, eventCtx);
    harness.handlers.get("agent_start")({ type: "agent_start" }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: { stopReason: "tool_use" }, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.runtime.snapshot().results.length, 1, "the completion run produced a result");
    assert.equal(shadowDeliveries(harness).length, 0, "a busy parent holds the wake result");
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    const deliveries = shadowDeliveries(harness);
    assert.equal(deliveries.length, 1, "the settled parent receives the wake result");
    assert.equal(deliveries[0][2].triggerTurn, true, "the wake starts a follow-up turn");
    // Pi's triggerTurn path emits agent_start without input/before_agent_start.
    harness.handlers.get("agent_start")({ type: "agent_start" }, eventCtx);
    assert.equal(state.currentParentRun(), 2, "the wake follow-up is tracked as an active parent run");
    assert.match(deliveries[0][1].content, /\[Shadow advisory\]/, "the delivery is advisory-framed");
    assert.match(deliveries[0][1].content, /shadow: Wake sentinel \(wake-sentinel\)/, "the source is attributed");
    const resultId = state.runtime.snapshot().results[0].id;
    assert.equal(state.runtime.snapshot().results[0].delivery, "pending", "the handoff is recorded");
    await harness.handlers.get("message_start")({ type: "message_start", message: deliveries[0][1] }, eventCtx);
    assert.equal(state.runtime.snapshot().results[0].delivery, "delivered", "transcript observation confirms the delivery");
    assert.equal(resultId.length > 0, true);
  } finally {
    if (previousAgentDir159 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir159;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Steer: the result lands while its source run is still active and enters
  // the model at the turn boundary as steering.
  const { dir } = await deliveryE2eSetup("shadow-steer-", [["steer-sentinel", "Steer sentinel", "steer", ["completion"]]]);
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = deliveryEventCtx(join(dir, "project"), sinks);
    sinks.eventCtx = eventCtx;
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      deliveryRuntimeDeps(sinks),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    harness.handlers.get("input")({ type: "input", text: "work", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "work", systemPromptOptions: { cwd: join(dir, "project") } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.runtime.snapshot().results.length, 1);
    assert.equal(shadowDeliveries(harness).length, 0, "the running parent holds the steer result");
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, eventCtx);
    const deliveries = shadowDeliveries(harness);
    assert.equal(deliveries.length, 1, "the steer enters the model at the turn boundary");
    assert.equal(deliveries[0][2].deliverAs, "steer", "an active run is steered, not followed up");
    assert.equal(state.runtime.snapshot().results[0].delivery, "pending");
  } finally {
    if (previousAgentDir159 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir159;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Late steer: the run settles before any turn boundary, so the result
  // degrades to notify and never reaches the model.
  const { dir } = await deliveryE2eSetup("shadow-late-steer-", [["late-sentinel", "Late sentinel", "steer", ["completion"]]]);
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = deliveryEventCtx(join(dir, "project"), sinks);
    sinks.eventCtx = eventCtx;
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      deliveryRuntimeDeps(sinks),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    harness.handlers.get("input")({ type: "input", text: "work", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "work", systemPromptOptions: { cwd: join(dir, "project") } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shadowDeliveries(harness).length, 0, "a late steer never reaches the model");
    const result = state.runtime.snapshot().results[0];
    assert.equal(result.delivery, "notified", "the degraded result returns inbox-only");
    assert.equal(result.configuredDelivery, "notify", "the degraded result adopts notify policy");
    assert.ok(sinks.notifications.some((entry) => entry.message.includes("stayed in the inbox")), "the degrade is visible");
  } finally {
    if (previousAgentDir159 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir159;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Notify: results stay inbox-only until an explicit Send to agent, which
  // goes through the same confirmed machine; a failed run can only send a
  // bounded failure summary explicitly.
  const { dir } = await deliveryE2eSetup("shadow-notify-", [
    ["quiet-sentinel", "Quiet sentinel", "notify", ["completion"]],
    ["failing-sentinel", "Failing sentinel", "notify", ["completion"]],
  ]);
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = deliveryEventCtx(join(dir, "project"), sinks);
    sinks.eventCtx = eventCtx;
    let failNext = false;
    const deps = deliveryRuntimeDeps(sinks);
    const originalRun = deps.runSession;
    deps.runSession = async (input) => {
      if (failNext) return deliveryRuntimeDeps(sinks, { fail: true }).runSession(input);
      return originalRun(input);
    };
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      deps,
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    harness.handlers.get("input")({ type: "input", text: "work", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "work", systemPromptOptions: { cwd: join(dir, "project") } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shadowDeliveries(harness).length, 0, "notify never auto-delivers");
    const result = state.runtime.snapshot().results[0];
    assert.equal(result.delivery, "notified");

    const services = __testables.makeServices(state, eventCtx);
    const sent = services.delivery?.sendResultToAgent(result.id);
    assert.equal(sent?.ok, true, sent?.message);
    const deliveries = shadowDeliveries(harness);
    assert.equal(deliveries.length, 1, "the explicit send reaches the model");
    assert.equal(deliveries[0][2].triggerTurn, true);
    await harness.handlers.get("message_start")({ type: "message_start", message: deliveries[0][1] }, eventCtx);
    assert.equal(state.runtime.snapshot().results[0].delivery, "delivered", "the explicit send confirms through the transcript");

    // A failed run stays a diagnostic until the user sends its summary.
    failNext = true;
    harness.handlers.get("input")({ type: "input", text: "again", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "again", systemPromptOptions: { cwd: join(dir, "project") } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const failedRun = state.runtime.snapshot().runs.find((run) => run.phase === "error");
    assert.ok(failedRun, "the infrastructure failure is observable");
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    assert.equal(services.delivery?.sendErrorSummary(failedRun.id)?.ok, true);
    const summary = shadowDeliveries(harness).at(-1);
    assert.match(summary[1].content, /\[Shadow run failure summary\]/, "the failure summary is bounded and explicit");
    assert.ok(summary[1].content.length < 4_000);
  } finally {
    if (previousAgentDir159 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir159;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Reopen recovery: a result left pending by a lost session returns
  // inbox-only with notify policy.
  const { dir, project } = await deliveryE2eSetup("shadow-recover-", [["wake-sentinel", "Wake sentinel", "wake", ["completion"]]]);
  const sessionDir = join(dir, "sessions");
  const sessionFile = join(sessionDir, "2026-08-25T00-00-00-000Z_sess-recover.jsonl");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, "{}\n", "utf8");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = {
      ...deliveryEventCtx(project, sinks),
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
        getSessionId: () => "sess-recover",
        getLeafId: () => "leaf-1",
        getBranch: () => [],
        buildContextEntries: () => [],
      },
    };
    sinks.eventCtx = eventCtx;
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      deliveryRuntimeDeps(sinks),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    harness.handlers.get("input")({ type: "input", text: "work", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "work", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    const resultId = state.runtime.snapshot().results[0].id;
    assert.equal(state.runtime.snapshot().results[0].delivery, "pending", "the delivery is in flight before the loss");
    // The session is lost before confirmation: no message_start fires.
    await harness.handlers.get("session_start")({}, eventCtx);
    const recovered = state.runtime.snapshot().results[0];
    assert.equal(recovered.id, resultId);
    assert.equal(recovered.delivery, "notified", "the lost delivery returns inbox-only");
    assert.equal(recovered.configuredDelivery, "notify", "the recovered result adopts notify policy");
    assert.equal(shadowDeliveries(harness).length, 1, "no second delivery happens after recovery");
    // A runtime notification after reopen (for example a read marker) must
    // not re-enqueue the restored result into the delivery machine.
    state.runtime.markResultRead(resultId);
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    assert.equal(shadowDeliveries(harness).length, 1, "a restored result never auto-delivers after reopen");
    assert.equal(state.runtime.snapshot().results[0].delivery, "notified");
    // But an explicit send from the reopened inbox still works.
    const services = __testables.makeServices(state, eventCtx);
    assert.equal(services.delivery?.sendResultToAgent(resultId)?.ok, true);
    assert.equal(shadowDeliveries(harness).length, 2, "an explicit send still delivers after reopen");
    await harness.handlers.get("message_start")({ type: "message_start", message: shadowDeliveries(harness).at(-1)[1] }, eventCtx);
    assert.equal(state.runtime.snapshot().results[0].delivery, "delivered", "the explicit send confirms after reopen");
  } finally {
    if (previousAgentDir159 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir159;
    if (previousCodingAgentDir159 === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir159;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Completion gate wiring (#160) ──────────────────────────────────

function writeGateDefinition(dir, id, name, extra = []) {
  writeFileSync(join(dir, `${id}.md`), [
    "---",
    "promptVersion: 1",
    `id: ${id}`,
    `name: ${name}`,
    "enabled: true",
    "triggers: [completion]",
    "delivery: wake",
    "completionGate: true",
    "tools: []",
    ...extra,
    "---",
    "Review the finished answer.",
    "",
  ].join("\n"));
}

/** Resolvable release for held completion runs: `control.release.resolve()`. */
function makeGateControl(holds) {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { clock: 1_000, holds, release: { promise, resolve } };
}

function gateEventCtx(project, sinks, mode = "tui") {
  return {
    cwd: project,
    hasUI: true,
    mode,
    isProjectTrusted: () => true,
    ui: {
      custom: async () => {},
      confirm: async () => true,
      notify(message, level) { sinks.notifications.push({ message, level }); },
      setStatus(key, text) { sinks.statusCalls.push({ key, text }); },
    },
    model: { provider: "acme", id: "parent-model" },
    modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
    sessionManager: {
      getSessionDir: () => "",
      getSessionFile: () => undefined,
      getSessionId: () => "sess-gate",
      getLeafId: () => "leaf-1",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
  };
}

function gateRuntimeDeps(sinks, control) {
  return {
    now: () => control.clock,
    async createSession(input) {
      return { session: { customTools: input.customTools } };
    },
    async runSession(input) {
      if (control.holds > 0) {
        control.holds -= 1;
        // Held runs wait for an explicit release or a cancellation abort.
        await Promise.race([
          control.release.promise,
          new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        if (input.signal.aborted) {
          return { status: "aborted", prompted: true, timedOut: false, finalText: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, streamingCompleted: false, messages: [] };
        }
      }
      const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
      if (submit) {
        await submit.execute("c1", { payload: JSON.stringify({ summary: "answer review finding" }) }, undefined, undefined, sinks.eventCtx);
      }
      return { status: "completed", prompted: true, timedOut: false, finalText: "", model: "acme/parent-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, streamingCompleted: true, messages: [] };
    },
  };
}

function driveRealUserRun(harness, eventCtx, project, text = "finish it") {
  harness.handlers.get("input")({ type: "input", text, source: "interactive" });
  return harness.handlers.get("before_agent_start")(
    { type: "before_agent_start", prompt: text, systemPromptOptions: { cwd: project } },
    eventCtx,
  );
}

const previousAgentDir160 = process.env.PI_AGENT_DIR;
const previousCodingAgentDir160 = process.env.PI_CODING_AGENT_DIR;

{
  // Answer-after-review: the gate holds the subsystem settle after the
  // answer rendered; the completion run finishes inside the window; the
  // close forwards the settle and the result delivers with its normal
  // wake policy — framing and delivery untouched by the gate.
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-review-"));
  const project = join(dir, "project");
  const agentShadowDir = join(dir, "agent", "shadow-minds");
  mkdirSync(join(dir, "agent", "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeGateDefinition(agentShadowDir, "gate-lens", "Gate lens");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = gateEventCtx(project, sinks);
    sinks.eventCtx = eventCtx;
    const control = makeGateControl(1);
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      gateRuntimeDeps(sinks, control),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    // Text-only real-user run: no tool events at all.
    await driveRealUserRun(harness, eventCtx, project);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: { stopReason: "end_turn" }, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    assert.equal(state.gate?.open, true, "the completion run holds the gate open");
    assert.equal(state.runtime.snapshot().results.length, 0, "no result yet: the run is held");
    // The answer has rendered (turn_end, agent_end fired); the settle is held.
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    assert.equal(shadowDeliveries(harness).length, 0, "the held settle delivers nothing");
    // Release the completion run inside the window: it submits, the gate
    // closes completed, and the forwarded settle delivers the wake result.
    const held = state.runtime.snapshot().runs.find((run) => run.phase === "running");
    assert.ok(held, "the completion run is running inside the window");
    control.release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.gate?.open, false, "the gate closed once the completion work drained");
    const deliveries = shadowDeliveries(harness);
    assert.equal(deliveries.length, 1, "the close forwards the settle and delivers");
    assert.equal(deliveries[0][2].triggerTurn, true, "delivery policy is untouched by the gate");
    assert.match(deliveries[0][1].content, /\[Shadow advisory\]/, "the framing is unchanged");
    await harness.handlers.get("message_start")({ type: "message_start", message: deliveries[0][1] }, eventCtx);
    assert.equal(state.runtime.snapshot().results[0].delivery, "delivered");
    assert.equal(state.runtime.snapshot().results[0].configuredDelivery, "wake", "the gate never changes delivery implicitly");
  } finally {
    if (previousAgentDir160 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir160;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Deadline: unstarted completion pending items cancel at the window end,
  // started runs continue, and the settle forwards for the normal path.
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-deadline-"));
  const project = join(dir, "project");
  mkdirSync(join(dir, "agent", "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeGateDefinition(join(dir, "agent", "shadow-minds"), "gate-a", "Gate A");
  writeGateDefinition(join(dir, "agent", "shadow-minds"), "gate-b", "Gate B");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = gateEventCtx(project, sinks);
    sinks.eventCtx = eventCtx;
    const control = makeGateControl(1);
    const state = registerShadowMinds(
      harness.pi,
      () => ({
        ...DEFAULT_SHADOW_MINDS_BASE(),
        shadowMinds: {
          enabled: true,
          defaults: { ...DEFAULT_SHADOW_MINDS, maxConcurrentRuns: 1, completionGateWindowSeconds: 1 },
        },
      }),
      gateRuntimeDeps(sinks, control),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    await driveRealUserRun(harness, eventCtx, project);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    assert.equal(state.gate?.open, true);
    assert.equal(state.scheduler.pendingCompletions().length, 1, "the busy slot leaves one completion unstarted");
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    // The one-second window elapses: the unstarted item cancels.
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    assert.equal(state.gate?.open, false, "the deadline closed the gate");
    assert.equal(state.scheduler.pendingCompletions().length, 0, "the unstarted completion was cancelled");
    assert.ok(sinks.notifications.some((entry) => /completion gate closed \(deadline\)/.test(entry.message)), "the cancellation is visible");
    // The started run continues past the deadline and delivers normally.
    const held = state.runtime.snapshot().runs.find((run) => run.phase === "running");
    assert.ok(held, "the started completion run continues");
    control.release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.runtime.snapshot().results.length, 1, "the started run still produced its result");
  } finally {
    if (previousAgentDir160 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir160;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // User abort: the gate closes aborted, pending completions cancel with
  // the current-task runs, and nothing delivers.
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-abort-"));
  const project = join(dir, "project");
  mkdirSync(join(dir, "agent", "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeGateDefinition(join(dir, "agent", "shadow-minds"), "gate-x", "Gate X");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = gateEventCtx(project, sinks);
    sinks.eventCtx = eventCtx;
    const control = makeGateControl(1);
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      gateRuntimeDeps(sinks, control),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    await driveRealUserRun(harness, eventCtx, project);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    assert.equal(state.gate?.open, true);
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    // The next run is aborted by the user: the gate and its work cancel.
    harness.handlers.get("input")({ type: "input", text: "more", source: "interactive" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "more", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: { stopReason: "aborted" }, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.gate?.open, false, "the gate closed at the new task boundary");
    assert.equal(shadowDeliveries(harness).length, 0, "an aborted task delivers nothing");
    // The old task's started completion run continues (only current-task runs
    // cancel on abort); its late result lands inbox-only through the stale
    // notify downgrade — never an automatic delivery.
    control.release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const late = state.runtime.snapshot().results[0];
    assert.ok(late, "the continued run still produced its result");
    assert.equal(late.configuredDelivery, "notify", "a stale-task result downgrades to notify");
    assert.equal(late.delivery, "notified", "the late result stays inbox-only");
    assert.equal(shadowDeliveries(harness).length, 0, "nothing delivers after the abort");
  } finally {
    if (previousAgentDir160 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir160;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Extension-origin continuations never trigger completions.
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-ext-"));
  const project = join(dir, "project");
  mkdirSync(join(dir, "agent", "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeGateDefinition(join(dir, "agent", "shadow-minds"), "gate-ext", "Gate Ext");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = gateEventCtx(project, sinks);
    sinks.eventCtx = eventCtx;
    const control = makeGateControl(0);
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...DEFAULT_SHADOW_MINDS_BASE(), shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      gateRuntimeDeps(sinks, control),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    harness.handlers.get("input")({ type: "input", text: "extension continuation", source: "extension" });
    await harness.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "extension continuation", systemPromptOptions: { cwd: project } }, eventCtx);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    assert.equal(state.gate?.open, false, "an extension continuation never opens the gate");
    assert.equal(state.runtime.snapshot().results.length, 0, "no completion run started");
    assert.equal(state.runtime.snapshot().runs.length, 0, "no activation was dispatched");
  } finally {
    if (previousAgentDir160 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir160;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Print/JSON quit: the bounded headless drain waits for the started
  // completion run, persists, and delivers quietly — no turn is started.
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-drain-"));
  const project = join(dir, "project");
  mkdirSync(join(dir, "agent", "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeGateDefinition(join(dir, "agent", "shadow-minds"), "gate-drain", "Gate Drain");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const sessionDir = join(dir, "sessions");
    const sessionFile = join(sessionDir, "2026-08-25T00-00-00-000Z_sess-drain.jsonl");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionFile, "{}\n", "utf8");
    const eventCtx = {
      ...gateEventCtx(project, sinks, "print"),
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
        getSessionId: () => "sess-drain",
        getLeafId: () => "leaf-1",
        getBranch: () => harness.events
          .filter((entry) => entry[0] === "guide" && entry[2]?.triggerTurn === false)
          .map((entry) => ({ type: "custom_message", ...entry[1] })),
        buildContextEntries: () => [],
      },
    };
    sinks.eventCtx = eventCtx;
    const control = makeGateControl(1);
    const state = registerShadowMinds(
      harness.pi,
      () => ({
        ...DEFAULT_SHADOW_MINDS_BASE(),
        shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS, headlessDrainSeconds: 1 } },
      }),
      gateRuntimeDeps(sinks, control),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    await driveRealUserRun(harness, eventCtx, project);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    assert.equal(state.gate?.open, true);
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    // The quit begins while the completion run is still held: the drain
    // waits, the run finishes and persists inside the window, and the
    // delivery flush is quiet.
    const shutdown = harness.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, eventCtx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    control.release.resolve();
    await shutdown;
    const deliveries = shadowDeliveries(harness);
    assert.equal(deliveries.length, 1, "the drain delivered the persisted result");
    assert.equal(deliveries[0][2].triggerTurn, false, "a headless drain never starts a turn");
    assert.match(deliveries[0][1].content, /\[Shadow advisory\]/);
    // The result persisted to the partition, and the drain confirms its own
    // quiet sends: a quiet append never reaches extension handlers as
    // message_start (Pi routes extension events through the agent stream),
    // so the drain marks the delivered state itself after the flush.
    assert.ok(existsSync(join(sessionDir, ".pi-square-shadow", "sess-drain")), "the drain persisted the partition");
    assert.equal(state.runtime.snapshot().results[0].delivery, "delivered", "the drain confirms its quiet sends");
  } finally {
    if (previousAgentDir160 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir160;
    if (previousCodingAgentDir160 === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir160;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Headless session replacement cancels instead of draining ────────

{
  const dir = mkdtempSync(join(tmpdir(), "shadow-gate-replace-"));
  const project = join(dir, "project");
  mkdirSync(join(dir, "agent", "shadow-minds"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeGateDefinition(join(dir, "agent", "shadow-minds"), "gate-repl", "Gate Repl");
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sinks = { notifications: [], statusCalls: [] };
    const eventCtx = gateEventCtx(project, sinks, "print");
    sinks.eventCtx = eventCtx;
    const control = makeGateControl(1);
    const state = registerShadowMinds(
      harness.pi,
      () => ({
        ...DEFAULT_SHADOW_MINDS_BASE(),
        shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS, headlessDrainSeconds: 5 } },
      }),
      gateRuntimeDeps(sinks, control),
    );
    await harness.handlers.get("session_start")({}, eventCtx);
    await driveRealUserRun(harness, eventCtx, project);
    harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
    await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
    await harness.handlers.get("agent_settled")({ type: "agent_settled" }, eventCtx);
    // A print-mode session replacement (reason "new") must not drain: the
    // outgoing session is replaced, so the held run aborts promptly and
    // nothing delivers across the replacement.
    const startedAt = Date.now();
    await harness.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, eventCtx);
    assert.ok(Date.now() - startedAt < 1_000, "a replacement reason skips the headless drain");
    assert.equal(shadowDeliveries(harness).length, 0, "no delivery crosses the session replacement");
    assert.equal(state.gate?.open, false, "the gate closed at the replacement");
  } finally {
    if (previousAgentDir160 === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir160;
    if (previousCodingAgentDir160 === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir160;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Each result appends exactly one transcript reference (#178) ────

{
  const { DEFAULT_CONFIG: TEMPLATE, DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));

  const { writeFileSync: writeDisk } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "shadow-ref-append-"));
  const project = join(dir, "project");
  const sessionDir = join(dir, "sessions");
  const sessionFile = join(sessionDir, "2026-08-26T00-00-00-000Z_gamma-1.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeDisk(sessionFile, "{}\n", "utf8");

  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(dir, "agent"), { recursive: true });
  installShadowFixtures(join(dir, "agent"));
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const harness = fakePi();
    const sessionCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id }) },
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
        getSessionId: () => "gamma-1",
        getLeafId: () => "leaf-1",
        getBranch: () => [],
        buildContextEntries: () => [],
      },
      ui: { notify() {}, custom: async () => {} },
    };
    const runtimeDeps = {
      now: () => 1_000,
      async createSession(input) {
        return { session: { customTools: input.customTools } };
      },
      async runSession(input) {
        const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
        if (submit) {
          await submit.execute(
            "c1",
            { payload: JSON.stringify({ decisions: [], progress: "one reference only", open_questions: [] }) },
            undefined,
            undefined,
            sessionCtx,
          );
        }
        return {
          status: "completed", prompted: true, timedOut: false, finalText: "",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          streamingCompleted: true, messages: [],
        };
      },
    };
    const state = registerShadowMinds(
      harness.pi,
      () => ({ ...TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
      runtimeDeps,
    );
    await harness.handlers.get("session_start")({}, sessionCtx);
    const services = __testables.makeServices(state, sessionCtx);
    const referenceCount = (id) => harness.entries.filter((entry) => entry.type === "pi-square.shadow-result" && entry.data.resultId === id).length;

    // Scenario 1 — the observed re-entry race: a runtime subscriber fires
    // again while the first transcript append is still on the stack. The
    // re-entered callback must observe an in-flight claim and append
    // nothing, so the result lands exactly one reference (#178).
    let reentryTrigger = null;
    harness.pi.appendEntry = (type, data) => {
      if (type !== "pi-square.shadow-result") return;
      if (reentryTrigger) {
        const trigger = reentryTrigger;
        reentryTrigger = null;
        // Synchronous re-entry: markResultRead notifies every subscriber
        // before this append returns.
        trigger();
      }
      harness.entries.push({ type, data });
    };
    reentryTrigger = () => {
      const result = state.runtime.snapshot().results[0];
      if (result) state.runtime.markResultRead(result.id);
    };
    let started = services.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true, started.message);
    await waitFor(
      () => state.runtime.snapshot().results[0]?.referenced === true,
      "the first result was not referenced",
    );
    const firstId = state.runtime.snapshot().results[0].id;
    assert.equal(referenceCount(firstId), 1, "a synchronous re-entry during the append never produces a second reference");
    assert.equal(state.runtime.snapshot().results[0].referenced, true, "the successful append marks the result referenced");

    // Scenario 2 — retry after failure: an append that throws releases its
    // in-flight claim, the result stays safely in the inbox, and a later
    // runtime update retries and appends exactly one reference.
    let failNextAppend = true;
    harness.pi.appendEntry = (type, data) => {
      if (type !== "pi-square.shadow-result") return;
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error("session append failed");
      }
      harness.entries.push({ type, data });
    };
    started = services.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true, started.message);
    await waitFor(
      () => state.runtime.snapshot().results.length === 2,
      "the second result was not created",
    );
    const secondId = state.runtime.snapshot().results.at(-1).id;
    assert.notEqual(secondId, firstId, "distinct results are never coalesced");
    assert.equal(referenceCount(secondId), 0, "the failed append leaves no transcript reference");
    assert.ok(state.runtime.snapshot().results.some((result) => result.id === secondId), "the result stays safely available in the inbox");
    state.runtime.markResultRead(secondId);
    assert.equal(referenceCount(secondId), 1, "a later runtime update retries the append exactly once");
    assert.equal(state.runtime.snapshot().results.find((result) => result.id === secondId).referenced, true, "the retried append marks the result referenced");

    // Every result holds exactly one reference and references stay per-result.
    for (const result of state.runtime.snapshot().results) {
      assert.equal(referenceCount(result.id), 1, `result ${result.id} holds exactly one transcript reference`);
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Transcript references deduplicate across runtime instances (#181) ──

{
  const { DEFAULT_CONFIG: TEMPLATE, DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));

  const { writeFileSync: writeDisk } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "shadow-ref-cross-"));
  const project = join(dir, "project");
  const sessionDir = join(dir, "sessions");
  const sessionFile = join(sessionDir, "2026-08-27T00-00-00-000Z_delta-1.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeDisk(sessionFile, "{}\n", "utf8");

  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(dir, "agent"), { recursive: true });
  installShadowFixtures(join(dir, "agent"));
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    const sessionCtx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "acme", id: "parent-model" },
      modelRegistry: { find: (provider, id) => ({ provider, id }) },
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
        getSessionId: () => "delta-1",
        getLeafId: () => "leaf-1",
        getBranch: () => [],
        buildContextEntries: () => [],
      },
      ui: { notify() {}, custom: async () => {} },
    };
    const makeRuntimeDeps = () => ({
      now: () => 1_000,
      async createSession(input) {
        return { session: { customTools: input.customTools } };
      },
      async runSession(input) {
        const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
        if (submit) {
          await submit.execute(
            "c1",
            { payload: JSON.stringify({ decisions: [], progress: "cross-instance probe", open_questions: [] }) },
            undefined,
            undefined,
            sessionCtx,
          );
        }
        return {
          status: "completed", prompted: true, timedOut: false, finalText: "",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          streamingCompleted: true, messages: [],
        };
      },
    });
    const makeState = () => {
      const harness = fakePi();
      const state = registerShadowMinds(
        harness.pi,
        () => ({ ...TEMPLATE, shadowMinds: { enabled: true, defaults: { ...DEFAULT_SHADOW_MINDS } } }),
        makeRuntimeDeps(),
      );
      return { harness, state };
    };

    // One shared transcript across both instances: every append lands here.
    const appends = [];
    const referenceCount = (id) => appends.filter((appended) => appended === id).length;

    // Instance A appends fail at first (a failing session append path).
    const a = makeState();
    let failA = true;
    a.harness.pi.appendEntry = (type, data) => {
      if (type !== "pi-square.shadow-result") return;
      if (failA) throw new Error("session append failed");
      appends.push(data.resultId);
    };
    await a.harness.handlers.get("session_start")({}, sessionCtx);
    const servicesA = __testables.makeServices(a.state, sessionCtx);

    let started = servicesA.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true, started.message);
    await waitFor(
      () => a.state.runtime.snapshot().results.length > 0,
      "instance A did not retain the first result after append failure",
    );
    const firstId = a.state.runtime.snapshot().results[0].id;
    assert.equal(referenceCount(firstId), 0, "the failed append leaves no transcript reference");
    assert.ok(a.state.runtime.snapshot().results.some((result) => result.id === firstId), "the result stays in the inbox");

    // Instance B opens the same session: its snapshot seeds the unreferenced
    // result from the shared partition while A's append never landed.
    const b = makeState();
    b.harness.pi.appendEntry = (type, data) => {
      if (type !== "pi-square.shadow-result") return;
      appends.push(data.resultId);
    };
    await b.harness.handlers.get("session_start")({}, sessionCtx);
    const servicesB = __testables.makeServices(b.state, sessionCtx);
    assert.ok(
      b.state.runtime.snapshot().results.some((result) => result.id === firstId),
      "instance B observes the shared authoritative result unreferenced",
    );

    // B's own run retries the failed reference and appends its new result:
    // both land exactly one reference.
    started = servicesB.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true, started.message);
    await waitFor(
      () => b.state.runtime.snapshot().results.length >= 2
        && referenceCount(firstId) === 1,
      "instance B did not retry the failed reference and persist its new result",
    );
    const secondId = b.state.runtime.snapshot().results.find((result) => result.id !== firstId)?.id;
    assert.notEqual(secondId, firstId, "distinct results are never coalesced");
    assert.equal(referenceCount(firstId), 1, "the retried reference lands exactly once");
    assert.equal(referenceCount(secondId), 1, "the new result lands exactly one reference");

    // A's later notification still sees its stale unreferenced in-memory copy;
    // the inbox-backed claim must refuse a second append of the same result.
    failA = false;
    started = servicesA.runtime.runManual({ shadowId: "session-synthesizer" });
    assert.equal(started.ok, true, started.message);
    await waitFor(
      () => a.state.runtime.snapshot().results.length >= 2,
      "instance A did not persist its later distinct result",
    );
    const thirdId = a.state.runtime.snapshot().results.find((result) => result.id !== firstId && result.id !== secondId)?.id;
    assert.equal(referenceCount(firstId), 1, "a stale runtime instance never appends a second reference for the same result");
    assert.equal(referenceCount(secondId), 1, "results referenced by another instance stay single");
    assert.equal(referenceCount(thirdId), 1, "the third result lands exactly one reference");
    assert.equal(
      new Set([firstId, secondId, thirdId]).size,
      3,
      "three distinct authoritative results exist",
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
