import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-square-contract-agent-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const load = jiti(import.meta.url, { moduleCache: false });
  const register = (await load("../src/index.ts")).default;
  const { childToolNames, createChildTools } = await load("../src/tool-catalog.ts");
  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const renderers = new Map();
  const events = new Map();
  const entries = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerShortcut(name, definition) { shortcuts.set(name, definition); },
    registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getThinkingLevel() { return "high"; },
    getAllTools() { return [...tools.values()]; },
  };
  register(pi);

  assert.deepEqual([...tools.keys()].sort(), [
    "ask", "docs", "fd", "fetch", "libs", "pwsh",
    "rg", "scheme", "search", "subagent", "time", "todo",
  ]);
  assert.ok(childToolNames.includes("scheme"));
  assert.ok(!childToolNames.includes("scheme_eval"));
  const askTool = tools.get("ask");
  assert.equal(typeof askTool?.renderCall, "function");
  assert.equal(typeof askTool?.renderResult, "function");
  assert.equal(askTool?.parameters?.properties?.questions?.maxItems, 10);
  assert.equal(askTool?.parameters?.properties?.questions?.items?.properties?.allowComment?.default, false);
  assert.equal(askTool?.parameters?.properties?.questions?.items?.properties?.required?.default, true);
  assert.deepEqual(createChildTools(["scheme"]).definitions.map((definition) => definition.name), ["scheme"]);
  assert.equal(createChildTools(["scheme_eval"]).definitions.length, 0);
  assert.deepEqual([...commands.keys()].sort(), ["context", "prompt-manager", "statusline"]);
  assert.equal(commands.has("prompt-inspect"), false);
  assert.deepEqual([...shortcuts.keys()], ["alt+i"]);
  assert.deepEqual([...renderers.keys()], ["pi-square.subagent-notification"]);
  assert.equal(events.get("before_agent_start")?.length, 1, "prompt composition must use one handler");
  assert.deepEqual(
    readdirSync(join(packageRoot, "src", "notifications", "sounds")).sort(),
    ["question_bell.wav", "stop_bell.wav"],
    "used notification sounds must ship with the package",
  );

  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "test", id: "test" },
    sessionManager: { getBranch: () => entries },
    getSystemPrompt: () => "",
    getContextUsage: () => null,
  };
  for (const handler of events.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }
  assert.ok(shortcuts.has("alt+s"), "statusline shortcut should register from effective config");

  const promptHandler = events.get("before_agent_start")[0];
  const nativePrompt = "NATIVE SYSTEM\n\nNATIVE CONTEXT\n";
  const result = await promptHandler({
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt: nativePrompt,
    systemPromptOptions: {
      customPrompt: "NATIVE SYSTEM",
      appendSystemPrompt: "NATIVE APPEND",
      contextFiles: [{ path: "/project/AGENTS.md", content: "NATIVE CONTEXT" }],
      cwd: ctx.cwd,
      skills: [],
    },
  }, ctx);
  assert.equal(result.systemPrompt.slice(0, nativePrompt.length), nativePrompt);
  assert.match(result.systemPrompt.slice(nativePrompt.length), /Available YAML-defined subagents/);
  console.log("extension contract tests: OK");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
}
