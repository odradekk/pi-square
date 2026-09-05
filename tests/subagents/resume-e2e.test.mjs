import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-resume-e2e-sdk-${process.pid}.mjs`);
const state = {
  createCalls: [],
  effectiveSystems: [],
  openedPaths: [],
  prompts: [],
  messageSequence: 0,
  agentsFiles: [{ path: "/child/AGENTS.md", content: "CHILD CONTEXT" }],
};
globalThis.__pi_square_resume_e2e_state__ = state;

writeFileSync(mockSdkPath, `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
let sessionSequence = 0;
function appendConversation(manager, prompt, reply) {
  const state = globalThis.__pi_square_resume_e2e_state__;
  const lines = readFileSync(manager.getSessionFile(), "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
  const entries = lines.slice(1);
  const parentId = entries.at(-1)?.id ?? null;
  const userId = \`entry-\${++state.messageSequence}\`;
  const assistantId = \`entry-\${++state.messageSequence}\`;
  appendFileSync(manager.getSessionFile(), JSON.stringify({ type: "message", id: userId, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } }) + "\\n");
  appendFileSync(manager.getSessionFile(), JSON.stringify({ type: "message", id: assistantId, parentId: userId, timestamp: new Date().toISOString(), message: reply }) + "\\n");
}
// Mirrors Pi 0.84.2 buildSystemPrompt's custom-prompt branch: agent context
// files are baked into the custom prompt, then exactly one volatile
// working-directory suffix (forward slashes, trailing newline) is appended.
function buildSystemPrompt(input) {
  let prompt = input.resourceLoader.getSystemPrompt();
  const agentsFiles = input.resourceLoader.getAgentsFiles().agentsFiles;
  if (agentsFiles.length > 0) {
    prompt += "\\n\\n<project_context>\\n\\nProject-specific instructions and guidelines:\\n\\n";
    for (const { path, content } of agentsFiles) {
      prompt += \`<project_instructions path="\${path}">\\n\${content}\\n</project_instructions>\\n\\n\`;
    }
    prompt += "</project_context>\\n";
  }
  prompt += \`\\nCurrent working directory: \${(input.cwd ?? "").replace(/\\\\/g, "/")}\\n\`;
  return prompt;
}
function createSession(input, systemPrompt) {
  const listeners = [];
  const sessionState = { messages: [] };
  return {
    agent: { state: { systemPrompt }, abort() {} },
    state: sessionState,
    subscribe(listener) { listeners.push(listener); return () => {}; },
    async prompt(prompt) {
      globalThis.__pi_square_resume_e2e_state__.prompts.push(prompt);
      const message = { role: "assistant", content: [{ type: "text", text: "ACK-" + globalThis.__pi_square_resume_e2e_state__.prompts.length }], model: input.model, provider: "fake-provider", api: "fake-api", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, timestamp: Date.now() };
      sessionState.messages.push({ role: "user", content: [{ type: "text", text: prompt }] }, message);
      appendConversation(input.sessionManager, prompt, message);
      for (const listener of listeners) listener({ type: "agent_start" });
      for (const listener of listeners) listener({ type: "message_end", message });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    dispose() {},
  };
}
export async function createAgentSession(input) {
  const state = globalThis.__pi_square_resume_e2e_state__;
  const systemPrompt = buildSystemPrompt(input);
  state.createCalls.push(input);
  state.effectiveSystems.push(systemPrompt);
  return { session: createSession(input, systemPrompt) };
}
export function createExtensionRuntime() { return {}; }
export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }
export class DefaultResourceLoader {
  constructor(options = {}) { this.options = options; }
  async reload() {}
  getExtensions() { return { extensions: [], errors: [], runtime: createExtensionRuntime() }; }
  getSkills() { return { skills: [{ name: "child-skill" }], diagnostics: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: globalThis.__pi_square_resume_e2e_state__.agentsFiles }; }
  getSystemPrompt() { return this.options.systemPrompt ?? ""; }
  getAppendSystemPrompt() { return []; }
  extendResources() {}
}
function manager(cwd, file, id) { return { getSessionFile() { return file; }, getSessionId() { return id; }, getHeader() { return { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }; } }; }
export const SessionManager = {
  create(cwd, artifactsDir) { sessionSequence += 1; return manager(cwd, join(artifactsDir, "session-" + sessionSequence + ".jsonl"), "native-" + sessionSequence); },
  open(path) { globalThis.__pi_square_resume_e2e_state__.openedPaths.push(path); const header = JSON.parse(readFileSync(path, "utf8").split("\\n")[0]); return manager(header.cwd, path, header.id); },
};
export const SettingsManager = { inMemory(value) { return value; } };
`, "utf8");

const load = jiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": mockSdkPath } });
const {
  runSubagentTask,
  resumeSubagentTask,
  __testables,
} = await load(join(packageRoot, "src", "subagents", "session.ts"));
const ID = "subagent_00000000-0000-4000-8000-000000000081";

function root() {
  return join(tmpdir(), `pi-square-resume-e2e-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function ctx(cwd) {
  return {
    cwd,
    model: { id: "fake-model", provider: "fake-provider", api: "fake-api", contextWindow: 100000 },
    sessionManager: { getSessionId() { return "parent-resume-e2e-session"; } },
    modelRegistry: { find(provider, id) { return provider === "fake-provider" && id === "fake-model" ? { id, provider, api: "fake-api", contextWindow: 100000 } : undefined; } },
  };
}

function definition(overrides = {}) {
  return {
    promptVersion: 2,
    name: "worker",
    description: "worker",
    instructions: "PROFILE INSTRUCTIONS",
    output: "OUTPUT CONTRACT",
    inheritParentSystem: true,
    visible: true,
    source: "agent",
    filePath: "worker.yaml",
    fieldSources: {},
    layers: [],
    skills: [],
    ...overrides,
  };
}

function countCwdLines(system) {
  return String(system ?? "").split("\nCurrent working directory: ").length - 1;
}

function hashPromptValue(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("done subagents resume with the same public and native session IDs", async () => {
  const cwd = root();
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  state.messageSequence = 0;
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({ ctx: ctx(cwd), id: ID, task: "initial task" });
    assert.equal(first.details.phase, "completed");
    const { sessionFile, sessionId } = first.details;
    assert.deepEqual(state.openedPaths, [sessionFile], "fresh setup should reopen its initialized header through the native manager");
    state.openedPaths = [];

    const resumed = await resumeSubagentTask({
      ctx: ctx(cwd),
      id: ID,
      task: "continue with a new instruction",
      contextMessages: [{ role: "user", text: "parent decision" }],
    });

    assert.equal(resumed.details.id, ID);
    assert.equal(resumed.details.sessionFile, sessionFile);
    assert.equal(resumed.details.sessionId, sessionId);
    assert.equal(resumed.details.phase, "completed");
    assert.deepEqual(state.openedPaths, [sessionFile]);
    assert.match(state.prompts.at(-1), /Parent conversation history — reference only/);
    assert.ok(state.prompts.at(-1).endsWith("[Current delegated task]\ncontinue with a new instruction"));

    const persisted = JSON.parse(readFileSync(join(resumed.details.artifactsDir, "run.json"), "utf8"));
    assert.equal(persisted.id, ID);
    assert.equal(persisted.sessionId, sessionId);
    assert.equal(persisted.operation, "resume");
    assert.equal(persisted.task, "continue with a new instruction");
    assert.equal(persisted.initialTask, "initial task");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume restores original model, tools, effort, and system prompt", async () => {
  const cwd = root();
  const id = "subagent_00000000-0000-4000-8000-000000000082";
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  state.agentsFiles = [];
  try {
    mkdirSync(cwd, { recursive: true });
    await runSubagentTask({
      ctx: ctx(cwd),
      id,
      task: "initial",
      modelOverride: "fake-provider/fake-model",
      effortOverride: "max",
      definition: definition({ tools: ["read", "edit"] }),
    });
    const original = state.createCalls.at(-1);
    await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    const resumed = state.createCalls.at(-1);
    assert.equal(original.thinkingLevel, "max");
    assert.deepEqual(resumed.model, original.model);
    assert.equal(resumed.thinkingLevel, original.thinkingLevel);
    assert.deepEqual(resumed.tools, original.tools);
    assert.equal(resumed.resourceLoader.getSystemPrompt(), original.resourceLoader.getSystemPrompt());
    assert.deepEqual(original.resourceLoader.getAgentsFiles().agentsFiles, state.agentsFiles);
    assert.deepEqual(resumed.resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.equal(original.resourceLoader.getSkills().skills.length, 1);
    assert.deepEqual(resumed.resourceLoader.getSkills().skills, []);
    assert.equal(resumed.customTools, undefined);
    assert.match(state.prompts.at(-1), /\[Subagent profile instructions\]\nPROFILE INSTRUCTIONS/);
    assert.match(state.prompts.at(-1), /\[Output contract\]\nOUTPUT CONTRACT$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume migrates the former dual-shell declaration to a portable shell intent", async () => {
  const cwd = root();
  const id = "subagent_00000000-0000-4000-8000-000000000083";
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({
      ctx: ctx(cwd),
      id,
      task: "initial",
      definition: definition({ tools: ["read", "shell"] }),
    });
    const runPath = join(first.details.artifactsDir, "run.json");
    const legacy = JSON.parse(readFileSync(runPath, "utf8"));
    legacy.agent.tools = ["read", "bash"];
    legacy.agent.extensionTools = ["pwsh"];
    writeFileSync(runPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const resumed = await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    assert.ok(state.createCalls.at(-1).tools.includes("bash"));
    assert.ok(!state.createCalls.at(-1).tools.includes("pwsh"));
    assert.deepEqual(resumed.details.agent.tools, ["read", "shell"]);
    assert.equal(resumed.details.agent.extensionTools, undefined);
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.deepEqual(persisted.agent.tools, ["read", "shell"]);
    assert.equal(persisted.agent.extensionTools, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fresh runs compile exactly one working-directory suffix and freeze it out of the snapshot", async () => {
  const cwd = root();
  const id = "subagent_00000000-0000-4000-8000-000000000084";
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  state.messageSequence = 0;
  state.agentsFiles = [{ path: "/child/AGENTS.md", content: "CHILD CONTEXT" }];
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({ ctx: ctx(cwd), id, task: "initial" });
    const freshEffective = state.effectiveSystems.at(-1);
    assert.equal(first.details.phase, "completed");
    assert.equal(countCwdLines(freshEffective), 1, "Pi must append exactly one working-directory suffix");
    assert.match(freshEffective, /<project_instructions path="\/child\/AGENTS\.md">/);

    const runPath = join(first.details.artifactsDir, "run.json");
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(countCwdLines(persisted.promptSnapshot.system), 0, "the frozen snapshot must not keep Pi's volatile suffix");
    assert.match(persisted.promptSnapshot.system, /<project_instructions path="\/child\/AGENTS\.md">/);

    await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    assert.equal(state.createCalls.at(-1).resourceLoader.getSystemPrompt(), persisted.promptSnapshot.system,
      "resume must reuse the frozen system, not a re-suffixed copy");
    assert.equal(state.effectiveSystems.at(-1), freshEffective,
      "resume must not append another working-directory suffix");
    const resumedPersisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(countCwdLines(resumedPersisted.promptSnapshot.system), 0);
    assert.equal(resumedPersisted.promptSnapshot.manifest.effectiveSystemHash, persisted.promptSnapshot.manifest.effectiveSystemHash,
      "the effective SYSTEM hash must stay stable across equivalent fresh and resume operations");
    assert.equal(resumedPersisted.promptSnapshot.system, persisted.promptSnapshot.system);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume strips the historical date-plus-cwd suffix from persisted snapshots", async () => {
  const cwd = root();
  const id = "subagent_00000000-0000-4000-8000-000000000085";
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  state.messageSequence = 0;
  state.agentsFiles = [];
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({ ctx: ctx(cwd), id, task: "initial" });
    const runPath = join(first.details.artifactsDir, "run.json");
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    const frozenSystem = persisted.promptSnapshot.system;
    const frozenHash = persisted.promptSnapshot.manifest.effectiveSystemHash;

    persisted.promptSnapshot.system = `${frozenSystem}\nCurrent date: 2026-07-13\nCurrent working directory: /old-work`;
    writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    const effective = state.effectiveSystems.at(-1);
    assert.equal(countCwdLines(effective), 1, "the historical suffix must be replaced by exactly one current suffix");
    assert.ok(effective.endsWith(`\nCurrent working directory: ${cwd}\n`));
    assert.ok(!effective.includes("/old-work"));
    const resumedPersisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(resumedPersisted.promptSnapshot.system, frozenSystem,
      "the historical suffix must be frozen out without changing the effective SYSTEM");
    assert.equal(resumedPersisted.promptSnapshot.manifest.effectiveSystemHash, frozenHash);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("early resume failures persist the frozen SYSTEM with its matching hash", async () => {
  const cwd = root();
  const id = "subagent_00000000-0000-4000-8000-000000000087";
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  state.messageSequence = 0;
  state.agentsFiles = [];
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({ ctx: ctx(cwd), id, task: "initial" });
    const runPath = join(first.details.artifactsDir, "run.json");
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    const frozenSystem = persisted.promptSnapshot.system;
    const legacySystem = `${frozenSystem}\nCurrent working directory: /old-work`;

    persisted.promptSnapshot.system = legacySystem;
    persisted.promptSnapshot.manifest.effectiveSystemHash = hashPromptValue(legacySystem);
    persisted.agent.model = "missing-provider/missing-model";
    writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const resumed = await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    assert.equal(resumed.details.phase, "failed");
    assert.equal(state.createCalls.length, 1, "unknown model must fail before creating a resumed child session");

    const failedPersisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(failedPersisted.promptSnapshot.system, frozenSystem,
      "an early failure must still persist the suffix-free frozen SYSTEM");
    assert.equal(
      failedPersisted.promptSnapshot.manifest.effectiveSystemHash,
      hashPromptValue(failedPersisted.promptSnapshot.system),
      "an early failure must persist a hash matching the frozen SYSTEM",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume collapses duplicated working-directory suffixes persisted by earlier versions", async () => {
  const cwd = root();
  const id = "subagent_00000000-0000-4000-8000-000000000086";
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.effectiveSystems = [];
  state.openedPaths = [];
  state.prompts = [];
  state.messageSequence = 0;
  state.agentsFiles = [];
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({ ctx: ctx(cwd), id, task: "initial" });
    const runPath = join(first.details.artifactsDir, "run.json");
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    const frozenSystem = persisted.promptSnapshot.system;

    persisted.promptSnapshot.system = `${frozenSystem}\nCurrent working directory: ${cwd}\nCurrent working directory: ${cwd}`;
    writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    assert.equal(countCwdLines(state.effectiveSystems.at(-1)), 1,
      "a corrupted snapshot must not leak its duplicated suffixes into the effective SYSTEM");
    const resumedPersisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(resumedPersisted.promptSnapshot.system, frozenSystem,
      "resume must collapse duplicated suffixes back to the frozen effective SYSTEM");
    assert.equal(resumedPersisted.promptSnapshot.manifest.effectiveSystemHash, first.details.promptSnapshot.manifest.effectiveSystemHash);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("frozen prompt snapshots remove every supported Pi runtime suffix", () => {
  const frozen = __testables.freezeSystemPrompt(
    "CORE\n\nCONTEXT\nCurrent date: 2026-07-13\nCurrent working directory: /work",
  );
  assert.equal(frozen, "CORE\n\nCONTEXT");
  assert.equal(__testables.freezeSystemPrompt("CORE\nCurrent date: not-a-date"), "CORE\nCurrent date: not-a-date");
  assert.equal(__testables.freezeSystemPrompt("CORE\nCurrent working directory: /work\n"), "CORE");
  assert.equal(__testables.freezeSystemPrompt("CORE\nCurrent working directory: /work"), "CORE");
  assert.equal(__testables.freezeSystemPrompt("CORE\nCurrent working directory: C:/work spaced/a b"), "CORE");
  assert.equal(
    __testables.freezeSystemPrompt("CORE\nCurrent working directory: /a\nCurrent working directory: /b"),
    "CORE",
    "repeated suffixes from earlier resumes must collapse in one freeze",
  );
  assert.equal(
    __testables.freezeSystemPrompt("CORE\nCurrent date: 2026-07-13\nCurrent working directory: /a\nCurrent working directory: /b"),
    "CORE",
  );
  assert.equal(__testables.freezeSystemPrompt(undefined), undefined);
});

await run();
