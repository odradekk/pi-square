import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test, waitFor } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const root = join(tmpdir(), `pi-square-error-propagation-${process.pid}-${Date.now()}`);
const mockSdkPath = join(tmpdir(), `pi-square-error-sdk-${process.pid}.mjs`);
writeFileSync(mockSdkPath, `
import { join } from "node:path";
let sequence = 0;
export async function createAgentSession(input) {
  const listeners = [];
  return { session: {
    agent: { state: { systemPrompt: "system" }, abort() {} },
    state: { messages: [] },
    subscribe(listener) { listeners.push(listener); return () => {}; },
    async prompt() {
      for (const listener of listeners) listener({ type: "agent_start" });
      for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "grep", isError: true, result: { content: [{ type: "text", text: "grep failed" }] } });
      for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "exit status 2" }] } });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    dispose() {},
  } };
}
export function createExtensionRuntime() { return {}; }
export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }
export class DefaultResourceLoader {
  constructor(options = {}) { this.options = options; }
  async reload() {}
  getExtensions() { return { extensions: [], errors: [], runtime: createExtensionRuntime() }; }
  getSkills() { return { skills: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: [] }; }
  getSystemPrompt() { return this.options.systemPrompt ?? ""; }
  getAppendSystemPrompt() { return []; }
  extendResources() {}
}
export const SessionManager = { create(cwd, artifactsDir) { sequence += 1; const id = \`native-\${sequence}\`; const file = join(artifactsDir, \`session-\${sequence}.jsonl\`); const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }; return { getSessionFile() { return file; }, getSessionId() { return id; }, getHeader() { return header; } }; } };
export const SettingsManager = { inMemory(value) { return value; } };
`, "utf8");

// One loader resolves the whole subagent graph — tool, background lifecycle,
// and the session seam — against the mocked SDK, so the delegated tool call
// exercises the real background path end to end.
const load = jiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": mockSdkPath },
});
const { registerSubagentTool } = await load(join(packageRoot, "src", "subagents", "tool.ts"));
const { createBackgroundState } = await load(join(packageRoot, "src", "subagents", "background.ts"));
process.env.PI_AGENT_DIR = root;
mkdirSync(root, { recursive: true });

test("background envelope exposes silent child tool failures as a structured error", async () => {
  const sent = [];
  const state = {
    registry: { definitions: [], errors: [], projectDir: null },
    background: createBackgroundState(),
  };
  const tools = new Map();
  registerSubagentTool({
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage(message, options) { sent.push({ message, options }); },
    getThinkingLevel() { return "off"; },
  }, state);
  const result = await tools.get("delegate_subagent").execute(
    "tool:error",
    { task: "trigger failures" },
    undefined,
    undefined,
    {
      cwd: root,
      model: { provider: "test", id: "model", contextWindow: 100000 },
      modelRegistry: { find() { return undefined; } },
      sessionManager: { getSessionId: () => "parent-error-session", getBranch: () => [] },
    },
  );
  assert.equal(result.isError, undefined, "queueing is a successful tool call");

  const job = [...state.background.jobs.values()].find((item) => item.details.task === "trigger failures");
  assert.ok(job, "the queued job is registered in the background state");
  await waitFor(() => job.status === "error", "background job to fail");
  assert.equal(job.details.phase, "error");
  assert.equal(job.details.errorInfo.code, "SUBAGENT_FAILED");
  assert.deepEqual(job.details.toolErrors, [
    { tool: "grep", message: "grep failed" },
    { tool: "bash", message: "exit status 2" },
  ]);
  await waitFor(() => sent.length === 1, "the failure to enter the delivery set");
  assert.match(sent[0].message.content, /Subagent failed/);
});

await run();
rmSync(root, { recursive: true, force: true });
