import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-square-contract-agent-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const load = jiti(import.meta.url, { moduleCache: false });
  const register = (await load("../src/index.ts")).default;
  const { childToolNames, createChildTools } = await load("../src/tool-catalog.ts");
  const { createAnchoredReplaceToolDefinition } = await load("../src/anchored-edit/workspace-replace.ts");
  const { createChildAnchoredReplaceTool } = await load("../src/anchored-edit/child-edit.ts");
  const replaceTool = createAnchoredReplaceToolDefinition(process.cwd());
  assert.equal(replaceTool.parameters.type, "object");
  assert.equal(replaceTool.parameters.anyOf, undefined);
  assert.equal(replaceTool.parameters.additionalProperties, false);
  assert.deepEqual(replaceTool.parameters.required, ["remove_from", "remove_to", "replacement_text"]);
  assert.equal(replaceTool.renderCall, undefined, "replace definitions stay renderer-free before parent decoration");
  assert.equal(replaceTool.renderResult, undefined, "replace definitions stay renderer-free before parent decoration");
  assert.ok(!childToolNames.includes("replace"), "replace stays out of the extension catalog; the capability mapping grants it to children");
  const childReplace = createChildAnchoredReplaceTool(process.cwd(), "subagent-child");
  assert.deepEqual(childReplace.parameters, replaceTool.parameters, "the child replace schema matches the parent's exactly");
  assert.equal(childReplace.renderCall, undefined, "child replace definitions stay renderer-free");
  assert.equal(childReplace.renderResult, undefined, "child replace definitions stay renderer-free");

  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const renderers = new Map();
  const events = new Map();
  const entries = [];
  let activeTools = ["read", "bash"];
  const ownSourceInfo = { path: packageRoot, source: "@odradekk/pi-square", scope: "project", origin: "package" };
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
    getAllTools() { return [...tools.values()].map((definition) => ({ ...definition, sourceInfo: ownSourceInfo })); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names) { activeTools = [...names]; },
  };
  register(pi);

  assert.deepEqual([...tools.keys()].sort(), [
    "ask", "delegate_subagent", "docs", "fetch",
    "libs", "parse", "pdf_search", "resume_subagent", "search",
    "ssh", "todo", "wait_subagent",
  ]);
  assert.ok(childToolNames.includes("pdf_search"), "pdf_search must be available through explicit child opt-in");
  assert.deepEqual(createChildTools(["pdf_search"]).definitions.map((definition) => definition.name), ["pdf_search"]);
  assert.ok(!childToolNames.includes("scheme_eval"));
  assert.ok(!childToolNames.includes("parse"), "parse requires parent-session confirmation");
  assert.equal(createChildTools(["parse"]).definitions.length, 0);
  assert.ok(!childToolNames.includes("ssh"), "ssh must remain parent-only");
  assert.equal(createChildTools(["ssh"]).definitions.length, 0);
  const sshTool = tools.get("ssh");
  assert.equal(sshTool.parameters.type, "object");
  assert.equal(sshTool.parameters.anyOf, undefined);
  assert.deepEqual(sshTool.parameters.required, ["operation"]);
  assert.deepEqual(sshTool.parameters.properties.operation.enum, [
    "connect", "command", "read", "input", "secret_input", "interrupt", "close", "list",
  ]);
  assert.ok(!childToolNames.includes("pwsh"));
  assert.deepEqual(createChildTools(["pwsh"]).definitions, []);
  assert.deepEqual(createChildTools(["pwsh"], "win32").definitions.map((tool) => tool.name), ["pwsh"]);
  const askTool = tools.get("ask");
  assert.equal(typeof askTool?.renderCall, "function");
  assert.equal(typeof askTool?.renderResult, "function");
  assert.equal(askTool?.parameters?.properties?.questions?.maxItems, 10);
  assert.equal(askTool?.parameters?.properties?.questions?.items?.properties?.allowComment?.default, false);
  assert.equal(askTool?.parameters?.properties?.questions?.items?.properties?.required?.default, true);
  const delegateTool = tools.get("delegate_subagent");
  const resumeTool = tools.get("resume_subagent");
  const waitTool = tools.get("wait_subagent");
  for (const subagentTool of [delegateTool, resumeTool, waitTool]) {
    assert.equal(typeof subagentTool?.renderCall, "function");
    assert.equal(typeof subagentTool?.renderResult, "function");
    assert.equal(subagentTool?.renderShell, "self");
  }
  // Provider-compatibility contract: both subagent schemas are strict top-level
  // objects without unions; delegate_subagent must not declare id (GPT models
  // populate every declared property, which the validation would reject).
  for (const schema of [delegateTool?.parameters, resumeTool?.parameters, waitTool?.parameters]) {
    assert.equal(schema?.type, "object");
    assert.equal(schema?.anyOf, undefined);
    assert.equal(schema?.additionalProperties, false);
  }
  assert.deepEqual(delegateTool?.parameters?.required, ["task"]);
  assert.equal(delegateTool?.parameters?.properties?.id, undefined);
  assert.deepEqual(resumeTool?.parameters?.required, ["id", "task"]);
  assert.deepEqual(waitTool?.parameters?.required, ["ids"]);
  assert.equal(waitTool?.parameters?.properties?.ids?.maxItems, 6);
  assert.equal(typeof renderers.get("pi-square.subagent-notification"), "function");
  assert.equal(typeof renderers.get("pi-square.subagent-config-guide"), "function");
  const todoTool = tools.get("todo");
  assert.equal(typeof todoTool?.renderCall, "function");
  assert.equal(typeof todoTool?.renderResult, "function");
  assert.equal(todoTool?.parameters?.type, "object");
  assert.equal(todoTool?.parameters?.anyOf, undefined);
  assert.deepEqual(todoTool?.parameters?.required, ["action"]);
  assert.equal(todoTool?.parameters?.properties?.action?.enum?.length, 9);
  assert.ok(!childToolNames.includes("todo"));
  assert.equal(createChildTools(["scheme_eval"]).definitions.length, 0);
  assert.deepEqual([...commands.keys()].sort(), ["context", "display", "prompt-manager", "shadow", "subagent"]);
  assert.equal(commands.has("prompt-inspect"), false);
  assert.deepEqual([...shortcuts.keys()], ["alt+i"]);
  assert.deepEqual([...renderers.keys()], [
    "pi-square.subagent-notification",
    "pi-square.subagent-config-guide",
    "pi-square.shadow-config-guide",
  ]);
  // Prompt-manager keeps sole ownership of system-prompt replacement;
  // shadow-minds' second handler only freezes the per-task snapshot and
  // never returns a prompt-modifying result (covered by the shadow e2e).
  assert.equal(events.get("before_agent_start")?.length, 2, "prompt composition has one replacing owner plus one observing owner");
  assert.deepEqual(
    readdirSync(join(packageRoot, "src", "notifications", "sounds")).sort(),
    ["question_bell.wav", "stop_bell.wav"],
    "used notification sounds must ship with the package",
  );

  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "rpc",
    isProjectTrusted: () => false,
    model: { provider: "test", id: "test" },
    sessionManager: { getBranch: () => entries },
    getSystemPrompt: () => "",
    getContextUsage: () => null,
  };
  for (const handler of events.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }
  assert.equal(shortcuts.has("alt+s"), false, "native footer must not register the former statusline shortcut");
  assert.equal(typeof tools.get("bash")?.renderCall, "function", "bash should use the shared display renderer after session start");
  assert.equal(typeof tools.get("bash")?.renderResult, "function", "bash should use the shared result renderer");
  const factoryRead = createReadToolDefinition(ctx.cwd);
  assert.deepEqual(tools.get("read")?.parameters, factoryRead.parameters, "anchored read must retain Pi's exact read schema");
  assert.equal(tools.get("anchored-edit"), undefined, "anchored editing must not register a second tool");

  for (const name of [
    "pdf_search", "ssh", "bash",
    "read", "grep", "find", "ls", "edit", "write",
    "search", "fetch", "parse", "libs", "docs",
    "ask", "todo", "delegate_subagent", "resume_subagent", "wait_subagent",
  ]) {
    const tool = tools.get(name);
    assert.equal(tool?.renderShell, "self", `${name} parent tool must use the shared display shell`);
    assert.equal(typeof tool?.renderCall, "function", `${name} parent tool must render calls`);
    assert.equal(typeof tool?.renderResult, "function", `${name} parent tool must render results`);
  }
  assert.deepEqual(activeTools, ["read", "bash"]);

  // shadow-minds registers its snapshot observer before prompt-manager's
  // replacing handler: the observer returns nothing, the replacer owns the
  // composed prompt.
  const [observer, promptHandler] = events.get("before_agent_start");
  const nativePrompt = "NATIVE SYSTEM\n\nNATIVE CONTEXT\n";
  const observed = await observer({
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt: nativePrompt,
    systemPromptOptions: { cwd: ctx.cwd },
  }, ctx);
  assert.equal(observed, undefined, "the shadow observer never modifies prompt composition");
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
