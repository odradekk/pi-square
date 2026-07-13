import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-resume-e2e-sdk-${process.pid}.mjs`);
const state = {
  createCalls: [],
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
function createSession(input) {
  const listeners = [];
  const sessionState = { messages: [] };
  return {
    agent: { state: { systemPrompt: input.resourceLoader.getSystemPrompt() }, abort() {} },
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
export async function createAgentSession(input) { globalThis.__pi_square_resume_e2e_state__.createCalls.push(input); return { session: createSession(input) }; }
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
    modelRegistry: { find(provider, id) { return provider === "fake-provider" && id === "fake-model" ? { id, provider, api: "fake-api", contextWindow: 100000 } : undefined; } },
  };
}

test("done subagents resume with the same public and native session IDs", async () => {
  const cwd = root();
  process.env.PI_AGENT_DIR = cwd;
  state.createCalls = [];
  state.openedPaths = [];
  state.prompts = [];
  state.messageSequence = 0;
  try {
    mkdirSync(cwd, { recursive: true });
    const first = await runSubagentTask({ ctx: ctx(cwd), id: ID, mode: "fg", task: "initial task" });
    assert.equal(first.details.phase, "done");
    const { sessionFile, sessionId } = first.details;
    assert.deepEqual(state.openedPaths, [sessionFile], "fresh setup should reopen its initialized header through the native manager");
    state.openedPaths = [];

    const resumed = await resumeSubagentTask({
      ctx: ctx(cwd),
      id: ID,
      task: "continue with a new instruction",
      contextMessages: [{ role: "user", text: "parent decision" }],
    });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.details.id, ID);
    assert.equal(resumed.details.sessionFile, sessionFile);
    assert.equal(resumed.details.sessionId, sessionId);
    assert.equal(resumed.details.phase, "done");
    assert.deepEqual(state.openedPaths, [sessionFile]);
    assert.match(state.prompts.at(-1), /historical messages come from the parent session/);
    assert.ok(state.prompts.at(-1).endsWith("[Current delegated task]\ncontinue with a new instruction"));

    const persisted = JSON.parse(readFileSync(join(resumed.details.artifactsDir, "run.json"), "utf8"));
    assert.equal(persisted.id, ID);
    assert.equal(persisted.sessionId, sessionId);
    assert.equal(persisted.mode, "resume");
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
  state.openedPaths = [];
  state.prompts = [];
  try {
    mkdirSync(cwd, { recursive: true });
    await runSubagentTask({
      ctx: ctx(cwd),
      id,
      mode: "fg",
      task: "initial",
      modelOverride: "fake-provider/fake-model",
      effortOverride: "high",
      systemPrompt: "extra system",
      definition: { name: "worker", description: "worker", source: "agent", filePath: "worker.yaml", tools: ["read", "edit"], skills: [] },
    });
    const original = state.createCalls.at(-1);
    await resumeSubagentTask({ ctx: ctx(cwd), id, task: "next" });
    const resumed = state.createCalls.at(-1);
    assert.deepEqual(resumed.model, original.model);
    assert.equal(resumed.thinkingLevel, original.thinkingLevel);
    assert.deepEqual(resumed.tools, original.tools);
    assert.equal(resumed.resourceLoader.getSystemPrompt(), original.resourceLoader.getSystemPrompt());
    assert.deepEqual(original.resourceLoader.getAgentsFiles().agentsFiles, state.agentsFiles);
    assert.deepEqual(resumed.resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.equal(original.resourceLoader.getSkills().skills.length, 1);
    assert.deepEqual(resumed.resourceLoader.getSkills().skills, []);
    assert.equal(resumed.customTools, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("frozen prompt snapshots remove only Pi's runtime date and cwd suffix", () => {
  const frozen = __testables.freezeSystemPrompt(
    "CORE\n\nCONTEXT\nCurrent date: 2026-07-13\nCurrent working directory: /work",
  );
  assert.equal(frozen, "CORE\n\nCONTEXT");
  assert.equal(__testables.freezeSystemPrompt("CORE\nCurrent date: not-a-date"), "CORE\nCurrent date: not-a-date");
});

await run();
