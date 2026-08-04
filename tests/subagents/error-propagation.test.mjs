import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { loadToolModule, run, setRunSubagentTaskMock, test } from "./lib/test-helpers.mjs";

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

const loadSession = jiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": mockSdkPath } });
const { runSubagentTask } = await loadSession(join(packageRoot, "src", "subagents", "session.ts"));
const { registerSubagentTool } = await loadToolModule();
process.env.PI_AGENT_DIR = root;
mkdirSync(root, { recursive: true });

function tool() {
  const tools = new Map();
  registerSubagentTool({
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    registerCommand() {},
    getThinkingLevel() { return "off"; },
  }, {
    registry: { definitions: [], errors: [], projectDir: null },
    background: { jobs: new Map() },
  });
  return tools.get("subagent_delegate");
}

test("foreground envelope exposes silent child tool failures as a structured error", async () => {
  setRunSubagentTaskMock((input) => runSubagentTask(input));
  const result = await tool().execute(
    "tool:error",
    { mode: "fg", task: "trigger failures" },
    undefined,
    undefined,
    {
      cwd: "/tmp/subagents",
      model: { provider: "test", id: "model", contextWindow: 100000 },
      modelRegistry: { find() { return undefined; } },
      sessionManager: { getSessionId: () => "parent-error-session", getBranch: () => [] },
    },
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.phase, "error");
  assert.equal(result.details.errorInfo.code, "SUBAGENT_FAILED");
  assert.deepEqual(result.details.toolErrors, [
    { tool: "grep", message: "grep failed" },
    { tool: "bash", message: "exit status 2" },
  ]);
  assert.match(result.content[0].text, /Subagent failed/);
});

await run();
rmSync(root, { recursive: true, force: true });
