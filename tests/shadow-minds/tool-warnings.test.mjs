import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

// #344: a run that drops unavailable optional tools warns the user on both
// start paths. The manual trial always notifies; the scheduler's automatic
// runs notify once per shadow and warning set, so a repeated trigger never
// refills the session with the same line. The run record keeps its warnings
// either way.

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { default: registerShadowMinds, __testables } = await load(join(packageRoot, "src", "shadow-minds", "index.ts"));
const { loadConfig } = await load(join(packageRoot, "src", "core", "config.ts"));

const dir = mkdtempSync(join(tmpdir(), "pi-square-shadow-tool-warnings-"));
const agentDir = join(dir, "agent");
const project = join(dir, "project");
mkdirSync(join(agentDir, "shadow-minds"), { recursive: true });
mkdirSync(join(agentDir, "config"), { recursive: true });
mkdirSync(project, { recursive: true });
const previousAgentDir = process.env.PI_AGENT_DIR;
const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

/** Drives one parent task whose mutation activates the automatic run. */
async function runMutationTask(harness, eventCtx, text) {
  harness.handlers.get("input")({ type: "input", text, source: "interactive" });
  await harness.handlers.get("before_agent_start")(
    { type: "before_agent_start", prompt: text, systemPromptOptions: { cwd: project, customPrompt: "Core.", contextFiles: [] } },
    eventCtx,
  );
  harness.handlers.get("agent_start")({ type: "agent_start" }, eventCtx);
  harness.handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: text, toolName: "write", args: { file_path: `src/${text}.ts` } });
  harness.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: text, toolName: "write", result: {}, isError: false });
  await harness.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, eventCtx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, eventCtx);
  await new Promise((tick) => setTimeout(tick, 10));
}

try {
  // `shell` is outside the Shadow-safe catalog: it drops with a warning
  // while `read` still resolves, so the run starts with a shrunken set.
  writeFileSync(join(agentDir, "shadow-minds", "warn-lens.md"), [
    "---", "promptVersion: 1", "id: warn-lens", "name: Warn lens", "enabled: true",
    "triggers: [mutation]", "delivery: notify", "tools: [read, shell]", "---", "Watch the tools.", "",
  ].join("\n"), "utf8");
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({ shadowMinds: { enabled: true } }), "utf8");
  const loaded = loadConfig(project);

  const harness = { commands: new Map(), handlers: new Map(), events: [], notifications: [] };
  const pi = {
    registerCommand: (name, definition) => harness.commands.set(name, definition),
    registerMessageRenderer: () => {},
    on: (event, handler) => harness.handlers.set(event, handler),
    sendMessage: (message, options) => harness.events.push(["guide", message, options]),
    sendUserMessage: (message, options) => harness.events.push(["user", message, options]),
    appendEntry: () => {},
  };
  const eventCtx = {
    cwd: project,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      custom: async () => {},
      confirm: async () => true,
      notify: (message, level) => harness.notifications.push({ message, level }),
      setStatus: () => {},
    },
    model: { provider: "acme", id: "parent-model" },
    modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 200_000 }) },
    sessionManager: {
      getSessionDir: () => "",
      getSessionFile: () => undefined,
      getSessionId: () => "warnings-1",
      getLeafId: () => "leaf-1",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
  };
  const runtimeDeps = {
    now: () => 1_000,
    async createSession(input) {
      return { session: { customTools: input.customTools } };
    },
    async runSession(input) {
      const submit = input.session.customTools.find((tool) => tool.name === "submit_shadow_result");
      if (submit) await submit.execute("c1", { payload: JSON.stringify({ summary: "finding" }) }, undefined, undefined, eventCtx);
      return {
        status: "completed", prompted: true, timedOut: false, finalText: "", model: "acme/parent-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, streamingCompleted: true, messages: [],
      };
    },
  };

  const state = registerShadowMinds(pi, () => loaded.config, runtimeDeps);
  await harness.handlers.get("session_start")({}, eventCtx);
  await harness.commands.get("shadow").handler("", eventCtx);
  assert.ok(state.registry.definitions.some((definition) => definition.id === "warn-lens"), "sanity: the definition is discovered");

  const toolNotices = () => harness.notifications.filter((entry) => entry.message.includes("tool warning"));

  await runMutationTask(harness, eventCtx, "first");
  const automatic = state.runtime.snapshot().runs.filter((run) => run.source === "automatic");
  assert.equal(automatic.length, 1, "the mutation trigger started the automatic run");
  assert.deepEqual(
    automatic[0].toolWarnings,
    ["Tool 'shell' is not in the Shadow-safe catalog and was excluded."],
    "the run record keeps the warning for the manager run details",
  );
  assert.deepEqual(automatic[0].toolNames, ["read"], "the unavailable tool dropped instead of failing the run");
  assert.equal(toolNotices().length, 1, "the automatic tool downgrade reaches the user once");
  assert.equal(toolNotices()[0].level, "warning");
  assert.ok(toolNotices()[0].message.includes("warn-lens"), "the notification names the shadow");
  assert.ok(toolNotices()[0].message.includes("shell"), "the notification names the dropped tool");

  await runMutationTask(harness, eventCtx, "second");
  assert.equal(
    state.runtime.snapshot().runs.filter((run) => run.source === "automatic").length,
    2,
    "sanity: the second trigger started another automatic run",
  );
  assert.equal(toolNotices().length, 1, "a repeated automatic trigger never repeats the same downgrade line");

  // The manual trial keeps its own notification: the user asked for that run.
  const services = __testables.makeServices(state, eventCtx);
  assert.equal(services.runtime.runManual({ shadowId: "warn-lens" }).ok, true);
  await new Promise((tick) => setTimeout(tick, 10));
  assert.equal(toolNotices().length, 2, "the manual trial reports the downgrade on its own start path");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousAgentDir;
  if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
  rmSync(dir, { recursive: true, force: true });
}

console.log("shadow-minds tool warning notification tests: OK");
