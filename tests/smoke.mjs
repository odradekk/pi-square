import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-square-smoke-agent-"));
const cwd = join(agentDir, "workspace");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "sample.txt"), "pi-square-smoke-needle\n", "utf8");
writeFileSync(join(cwd, "AGENTS.md"), "SMOKE PROJECT INSTRUCTIONS\n", "utf8");
writeFileSync(join(agentDir, "SYSTEM.md"), "SMOKE NATIVE SYSTEM\n", "utf8");
writeFileSync(join(agentDir, "auth.json"), "{}\n", "utf8");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  packages: [{ source: packageRoot }],
  quietStartup: true,
}, null, 2) + "\n");

const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();
const created = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.inMemory(),
});

try {
  const { session, extensionsResult } = created;
  const runner = session._extensionRunner;
  assert.ok(runner, "extension runner should exist");
  await runner.emit({ type: "session_start", reason: "startup" });

  const paths = runner.getExtensionPaths().map((path) => path.replaceAll("\\", "/"));
  const expectedExtensionPath = join(packageRoot, "src/index.ts").replaceAll("\\", "/");
  assert.equal(paths.length, 1, `expected one extension entry, got ${paths.join(", ")}`);
  assert.equal(paths[0], expectedExtensionPath);

  const expectedTools = [
    "ask", "codegraph", "docs", "fd", "fetch", "github_commit", "github_read",
    "github_search", "github_tree", "libs", "parse", "pdf_search", "rg", "search",
    "subagent_delegate", "subagent_resume", "time", "todo",
  ];
  const allToolNames = extensionsResult.runtime.getAllTools().map((tool) => tool.name).sort();
  const extensionTools = allToolNames.filter((name) => expectedTools.includes(name));
  assert.deepEqual(extensionTools, expectedTools);
  assert.ok(!allToolNames.includes("ask_user"));
  assert.ok(!allToolNames.includes("pwsh"), "pwsh must not be registered off Windows");
  assert.ok(allToolNames.includes("bash"), "bash must remain registered off Windows");

  const commands = extensionsResult.runtime.getCommands().map((command) => command.name).sort();
  const extensionCommands = commands.filter((name) => !name.startsWith("skill:"));
  assert.deepEqual(extensionCommands, ["context", "display", "prompt-manager", "subagent"]);
  assert.ok(!commands.includes("prompt-inspect"));

  const skills = resourceLoader.getSkills().skills;
  assert.equal(skills.length, 0, "the package must not contribute skills");

  assert.equal(resourceLoader.getSystemPrompt(), "SMOKE NATIVE SYSTEM\n");
  assert.ok(resourceLoader.getAgentsFiles().agentsFiles.some((file) => file.content.includes("SMOKE PROJECT INSTRUCTIONS")));

  const nativePrompt = "SMOKE NATIVE SYSTEM\n\nSMOKE PROJECT INSTRUCTIONS\n";
  const promptPatch = await runner.emitBeforeAgentStart(
    "smoke",
    undefined,
    nativePrompt,
    {
      customPrompt: "SMOKE NATIVE SYSTEM",
      contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
      cwd,
      skills,
      selectedTools: [...expectedTools, "bash"],
    },
  );
  const systemPrompt = promptPatch?.systemPrompt ?? "";
  assert.equal(systemPrompt.slice(0, nativePrompt.length), nativePrompt);
  assert.match(systemPrompt.slice(nativePrompt.length), /## Available YAML-defined subagents/);
  assert.equal(systemPrompt.includes("System environment:"), false);

  const toolByName = (name) => {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `tool not active: ${name}`);
    return tool;
  };
  const bashResult = await toolByName("bash").execute("smoke:bash", { command: "printf pi-square-bash" }, undefined, undefined);
  assert.equal(bashResult.content[0].text, "pi-square-bash");

  for (const toolName of [
    "read", "grep", "find", "ls", "edit", "write", "bash",
    ...expectedTools,
  ]) {
    const definition = session.getToolDefinition(toolName);
    assert.equal(typeof definition?.renderCall, "function", `${toolName} must render calls through pi-square`);
    assert.equal(typeof definition?.renderResult, "function", `${toolName} must render results through pi-square`);
    assert.equal(definition?.renderShell, "self", `${toolName} must own its display shell`);
  }

  const timeResult = await toolByName("time").execute("smoke:time", {}, undefined, undefined);
  assert.match(timeResult.content[0].text, /ISO 8601:/);

  const todoResult = await toolByName("todo").execute("smoke:todo", {
    action: "set",
    todos: [{ id: "smoke", text: "verify native state" }],
  }, undefined, undefined);
  assert.equal(todoResult.details.counts.total, 1);
  assert.equal(todoResult.details.currentId, "smoke");
  assert.equal(JSON.parse(todoResult.content[0].text).version, 1);

  const rgResult = await toolByName("rg").execute("smoke:rg", {
    pattern: "pi-square-smoke-needle",
    path: ".",
  }, undefined, undefined);
  assert.match(rgResult.content[0].text, /sample\.txt/);

  const codegraphResult = await toolByName("codegraph").execute("smoke:codegraph", {
    operation: "status",
  }, undefined, undefined);
  assert.equal(codegraphResult.details.code, "NOT_INDEXED");
  assert.equal(codegraphResult.details.phase, "recoverable");

  console.log("pi-square smoke: OK");
} finally {
  created.session.dispose?.();
  rmSync(agentDir, { recursive: true, force: true });
}
