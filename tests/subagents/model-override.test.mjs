import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const root = join(tmpdir(), `pi-square-model-override-state-${process.pid}-${Date.now()}`);
const mockSdkPath = join(tmpdir(), `pi-square-subagents-model-sdk-${process.pid}.mjs`);
let idSequence = 40;

const sdkState = {
  calls: [],
  sessionFactory: undefined,
  agentsFiles: [{ path: "/tmp/subagents/AGENTS.md", content: "child project instructions" }],
};
globalThis.__pi_square_subagents_model_sdk__ = sdkState;

writeFileSync(mockSdkPath, `
import { join } from "node:path";
let sequence = 0;
export async function createAgentSession(input) {
  globalThis.__pi_square_subagents_model_sdk__.calls.push(input);
  const factory = globalThis.__pi_square_subagents_model_sdk__.sessionFactory;
  return { session: factory ? factory(input) : createSession(input) };
}
function createSession(input) {
  const listeners = [];
  const state = { messages: [] };
  return {
    agent: { state: { systemPrompt: input.resourceLoader.getSystemPrompt() }, abort() {} },
    state,
    subscribe(listener) { listeners.push(listener); return () => {}; },
    async prompt() {
      const message = { role: "assistant", content: [{ type: "text", text: "ACK" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, model: input.model };
      state.messages = [message];
      for (const listener of listeners) listener({ type: "agent_start" });
      for (const listener of listeners) listener({ type: "message_end", message });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    dispose() {},
  };
}
export function createExtensionRuntime() { return {}; }
export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }
export class DefaultResourceLoader {
  constructor(options = {}) { this.options = options; }
  async reload() {}
  getExtensions() { return { extensions: [], errors: [], runtime: createExtensionRuntime() }; }
  getSkills() { return { skills: [{ name: "one" }, { name: "two" }] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: globalThis.__pi_square_subagents_model_sdk__.agentsFiles }; }
  getSystemPrompt() { return this.options.systemPrompt ?? ""; }
  getAppendSystemPrompt() { return []; }
  extendResources() {}
}
export const SessionManager = {
  create(cwd, artifactsDir) {
    sequence += 1;
    const id = \`native-\${sequence}\`;
    const file = join(artifactsDir, \`session-\${sequence}.jsonl\`);
    const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
    return { getSessionFile() { return file; }, getSessionId() { return id; }, getHeader() { return header; } };
  },
};
export const SettingsManager = { inMemory(value) { return value; } };
`, "utf8");

const load = jiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": mockSdkPath } });
const { runSubagentTask } = await load(join(packageRoot, "src", "subagents", "session.ts"));
process.env.PI_AGENT_DIR = root;
mkdirSync(root, { recursive: true });

const knownModels = new Map([
  ["provider-x/model-y", { provider: "provider-x", id: "model-y", contextWindow: 100000 }],
  ["cpa/deepseek-v4-flash", { provider: "cpa", id: "deepseek-v4-flash", api: "openai-completions", reasoning: true, contextWindow: 100000, compat: { supportsDeveloperRole: false } }],
  ["cpa/mimo-v2.5-pro", { provider: "cpa", id: "mimo-v2.5-pro", api: "openai-completions", reasoning: true, contextWindow: 100000, compat: { supportsDeveloperRole: false } }],
]);

function nextId() {
  idSequence += 1;
  return `subagent_00000000-0000-4000-8000-${String(idSequence).padStart(12, "0")}`;
}

function ctx() {
  return {
    cwd: "/tmp/subagents",
    model: { provider: "inherited", id: "main-model", contextWindow: 100000 },
    sessionManager: { getSessionId() { return "parent-model-override-session"; } },
    modelRegistry: { find(provider, id) { return knownModels.get(`${provider}/${id}`); } },
  };
}

function definition(overrides = {}) {
  return {
    promptVersion: 2,
    name: "explorer",
    model: "cpa/deepseek-v4-flash",
    effort: "low",
    description: "test subagent",
    instructions: "PROFILE INSTRUCTIONS",
    output: "OUTPUT CONTRACT",
    inheritParentSystem: true,
    visible: true,
    source: "agent",
    filePath: "explorer.yaml",
    fieldSources: {},
    layers: [],
    tools: [],
    skills: [],
    ...overrides,
  };
}

function freshInput(overrides = {}) {
  return { ctx: ctx(), id: nextId(), task: "task", thinkingLevel: "medium", definition: definition(), ...overrides };
}

function lastCall() {
  assert.ok(sdkState.calls.length > 0);
  return sdkState.calls.at(-1);
}

function reset() {
  sdkState.calls = [];
  sdkState.sessionFactory = undefined;
}

test("model and effort overrides reach the child and persisted details", async () => {
  reset();
  const result = await runSubagentTask(freshInput({ modelOverride: "provider-x/model-y", effortOverride: "xhigh" }));
  assert.deepEqual(lastCall().model, { provider: "provider-x", id: "model-y", contextWindow: 100000 });
  assert.equal(lastCall().thinkingLevel, "xhigh");
  assert.equal(result.details.agent.model, "provider-x/model-y");
  assert.equal(result.details.id.startsWith("subagent_"), true);
});

test("fresh execution refuses to reuse an existing public ID", async () => {
  reset();
  const input = freshInput();
  await runSubagentTask(input);
  await assert.rejects(() => runSubagentTask({ ...input, task: "different" }), /PERSISTENCE_FAILED/);
});

test("child settings enable compaction and one observable retry layer", async () => {
  reset();
  await runSubagentTask(freshInput());
  assert.deepEqual(lastCall().settingsManager, {
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { maxRetries: 0 } },
  });
});

test("child layers immutable governance before the parent SYSTEM core and exposes native child context files", async () => {
  reset();
  await runSubagentTask(freshInput({
    definition: undefined,
    inheritedSystemCore: "PARENT SYSTEM\n\nPARENT APPEND",
  }));
  const system = lastCall().resourceLoader.getSystemPrompt();
  assert.match(system, /^You are a delegated Pi subagent/);
  assert.match(system, /<parent_system_core>\nPARENT SYSTEM\n\nPARENT APPEND\n<\/parent_system_core>/);
  assert.deepEqual(lastCall().resourceLoader.getAgentsFiles().agentsFiles, sdkState.agentsFiles);
});

test("fresh sessions resolve and persist the portable shell capability", async () => {
  reset();
  const result = await runSubagentTask(freshInput({ definition: definition({ tools: ["read", "edit", "shell"] }) }));
  assert.ok(lastCall().tools.includes("read"));
  assert.ok(lastCall().tools.includes("edit"));
  assert.ok(lastCall().tools.includes("bash"));
  assert.ok(!lastCall().tools.includes("shell"));
  assert.deepEqual(result.details.agent.tools, ["read", "edit", "shell"]);
  assert.equal(lastCall().customTools, undefined);
});

test("none starts a child with only the requested custom tools", async () => {
  reset();
  const result = await runSubagentTask(freshInput({
    definition: definition({ tools: ["none"], extensionTools: ["docs"], skills: ["none"] }),
  }));
  assert.deepEqual(lastCall().tools, ["docs"]);
  assert.deepEqual(lastCall().customTools.map((tool) => tool.name), ["docs"]);
  assert.deepEqual(result.details.agent.tools, ["none"]);
  assert.deepEqual(result.details.agent.extensionTools, ["docs"]);
  assert.deepEqual(result.details.agent.skills, ["none"]);
});

test("built-in names under extensionTools fail before child creation", async () => {
  reset();
  const result = await runSubagentTask(freshInput({ definition: definition({ tools: ["read"], extensionTools: ["read"] }) }));
  assert.equal(result.details.phase, "failed");
  assert.equal(result.details.errorInfo.code, "INVALID_ARGUMENT");
  assert.equal(sdkState.calls.length, 0);
});

test("YAML defaults, inherited model and effort, and model registry compat remain intact", async () => {
  reset();
  await runSubagentTask(freshInput({ definition: definition({ effort: "low" }) }));
  assert.equal(lastCall().thinkingLevel, "low");
  assert.equal(lastCall().model.compat.supportsDeveloperRole, false);

  const inherited = await runSubagentTask(freshInput({ definition: definition({ model: undefined, effort: undefined }) }));
  assert.equal(lastCall().thinkingLevel, "medium");
  assert.equal(inherited.details.agent.model, "inherited/main-model");
  assert.equal(inherited.details.agent.effort, "medium");
});

test("Pi-native max effort works for profile defaults and parent inheritance", async () => {
  reset();
  const configured = await runSubagentTask(freshInput({ definition: definition({ effort: "max" }) }));
  assert.equal(configured.details.phase, "completed");
  assert.equal(lastCall().thinkingLevel, "max");
  assert.equal(configured.details.agent.effort, "max");

  const inherited = await runSubagentTask(freshInput({
    thinkingLevel: "max",
    definition: definition({ model: undefined, effort: undefined }),
  }));
  assert.equal(inherited.details.phase, "completed");
  assert.equal(lastCall().thinkingLevel, "max");
  assert.equal(inherited.details.agent.effort, "max");
});

test("a bare provider response cannot downgrade the qualified model frozen for resume", async () => {
  reset();
  sdkState.sessionFactory = (input) => {
    const listeners = [];
    const message = { role: "assistant", content: [{ type: "text", text: "ACK" }], usage: {}, model: input.model.id };
    return {
      agent: { state: { systemPrompt: "system" }, abort() {} },
      state: { messages: [message] },
      subscribe(listener) { listeners.push(listener); return () => {}; },
      async prompt() {
        for (const listener of listeners) listener({ type: "agent_start" });
        for (const listener of listeners) listener({ type: "message_end", message });
        for (const listener of listeners) listener({ type: "agent_end" });
      },
      dispose() {},
    };
  };
  const result = await runSubagentTask(freshInput({ definition: definition({ model: undefined, effort: undefined }) }));
  assert.equal(result.details.agent.model, "inherited/main-model");
  assert.equal(result.details.model, "inherited/main-model");
});

test("non-DeepSeek overrides retain model registry compatibility", async () => {
  reset();
  await runSubagentTask(freshInput({ modelOverride: "cpa/mimo-v2.5-pro" }));
  assert.equal(lastCall().model.compat.supportsDeveloperRole, false);
});

test("retry events are counted while a recovered tool error remains non-terminal", async () => {
  reset();
  sdkState.sessionFactory = (input) => {
    const listeners = [];
    const finalMessage = { role: "assistant", content: [{ type: "text", text: "Recovered." }], usage: {}, model: input.model };
    return {
      agent: { state: { systemPrompt: "system" }, abort() {} },
      state: { messages: [finalMessage] },
      subscribe(listener) { listeners.push(listener); return () => {}; },
      async prompt() {
        for (const listener of listeners) listener({ type: "agent_start" });
        for (const listener of listeners) listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429" });
        for (const listener of listeners) listener({ type: "auto_retry_end", success: true, attempt: 1 });
        for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "rg", isError: true, result: { content: [{ type: "text", text: "bad limit" }] } });
        for (const listener of listeners) listener({ type: "message_end", message: finalMessage });
        for (const listener of listeners) listener({ type: "agent_end" });
      },
      dispose() {},
    };
  };
  const result = await runSubagentTask(freshInput());
  assert.equal(result.details.phase, "completed");
  assert.equal(result.details.retries, 1);
  assert.equal(result.details.toolErrors.length, 1);
});

test("non-retryable model errors preserve the provider message", async () => {
  reset();
  sdkState.sessionFactory = () => {
    const listeners = [];
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid API key", usage: {} };
    return {
      agent: { state: { systemPrompt: "system" }, abort() {} },
      state: { messages: [message] },
      subscribe(listener) { listeners.push(listener); return () => {}; },
      async prompt() {
        for (const listener of listeners) listener({ type: "agent_start" });
        for (const listener of listeners) listener({ type: "message_end", message });
        for (const listener of listeners) listener({ type: "agent_end" });
      },
      dispose() {},
    };
  };
  const result = await runSubagentTask(freshInput());
  assert.equal(result.details.errorInfo.code, "AUTH_FAILED");
  assert.match(result.details.errorInfo.cause, /401 invalid API key/);
  assert.equal(result.details.errorInfo.retries, 0);
});

test("retry exhaustion returns a structured retryable error", async () => {
  reset();
  sdkState.sessionFactory = () => {
    const listeners = [];
    return {
      agent: { state: { systemPrompt: "system" }, abort() {} },
      state: { messages: [] },
      subscribe(listener) { listeners.push(listener); return () => {}; },
      async prompt() {
        for (const listener of listeners) listener({ type: "agent_start" });
        for (const listener of listeners) listener({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "503" });
        for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 3, finalError: "503 unavailable" });
        for (const listener of listeners) listener({ type: "agent_end" });
      },
      dispose() {},
    };
  };
  const result = await runSubagentTask(freshInput());
  assert.equal(result.details.phase, "failed");
  assert.equal(result.details.errorInfo.code, "RETRY_EXHAUSTED");
  assert.equal(result.details.errorInfo.retryable, true);
  assert.equal(result.details.errorInfo.retries, 3);
});

await run();
rmSync(root, { recursive: true, force: true });
