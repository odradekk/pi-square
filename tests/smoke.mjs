import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const smokeLoad = jiti(import.meta.url, { moduleCache: false });

// The /context command handler reads ctx.ui.theme; initialize the theme
// registry the way an interactive session would.
initTheme();

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-square-smoke-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = join(agentDir, "workspace");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "sample.txt"), "pi-square-smoke-needle\n", "utf8");
writeFileSync(join(agentDir, "external-smoke.txt"), "pi-square-smoke-external\n", "utf8");
writeFileSync(join(cwd, "AGENTS.md"), "SMOKE PROJECT INSTRUCTIONS\n", "utf8");
writeFileSync(join(agentDir, "SYSTEM.md"), "SMOKE NATIVE SYSTEM\n", "utf8");
writeFileSync(join(agentDir, "auth.json"), "{}\n", "utf8");
mkdirSync(join(agentDir, "config"), { recursive: true });
writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
  version: 2,
}, null, 2) + "\n");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  packages: [{ source: packageRoot }],
  quietStartup: true,
  // #218: a small keep-recent window lets Pi's own prepareCompaction find a
  // cut point on the smoke-sized conversation so the real seam reaches the
  // extension takeover.
  compaction: { keepRecentTokens: 200 },
}, null, 2) + "\n");

const settingsManager = SettingsManager.create(cwd, agentDir);
// noSkills suppresses the host's default skill discovery (Pi 0.84.2 always
// auto-loads ~/.agents/skills); a package-contributed skill path still loads
// and trips the zero-skills assertion below.
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true });
await resourceLoader.reload();
// The shared in-memory session the smoke run drives.
const smokeSession = SessionManager.inMemory();
const created = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader,
  settingsManager,
  sessionManager: smokeSession,
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
    "ask", "codegraph", "delegate", "docs", "fetch", "github",
    "libs", "parse", "pdf_search", "replace", "resume", "search",
    "todo",
  ];
  const allToolNames = extensionsResult.runtime.getAllTools().map((tool) => tool.name).sort();
  const extensionTools = allToolNames.filter((name) => expectedTools.includes(name));
  assert.deepEqual(extensionTools, expectedTools);
  assert.ok(!allToolNames.includes("ask_user"));
  assert.ok(!allToolNames.includes("pwsh"), "pwsh must not be registered off Windows");
  assert.ok(allToolNames.includes("bash"), "bash must remain registered off Windows");

  const commands = extensionsResult.runtime.getCommands().map((command) => command.name).sort();
  const extensionCommands = commands.filter((name) => !name.startsWith("skill:"));
  assert.deepEqual(extensionCommands, ["context", "display", "prompt-manager", "shadow", "subagent"]);
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
  assert.ok(session.agent.state.tools.some((tool) => tool.name === "replace"), "anchored replace must be active by default");
  assert.ok(!session.agent.state.tools.some((tool) => tool.name === "revert"), "anchored revert must be gone (#187 replace-only surface)");
  assert.ok(!session.agent.state.tools.some((tool) => tool.name === "edit"), "Pi edit must be inactive when anchored editing is enabled by default");

  const bashResult = await toolByName("bash").execute("smoke:bash", { command: "printf pi-square-bash" }, undefined, undefined);
  assert.equal(bashResult.content[0].text, "pi-square-bash");

  for (const toolName of [
    "read", "grep", "find", "ls", "replace", "write", "bash",
    ...expectedTools,
  ]) {
    const definition = session.getToolDefinition(toolName);
    assert.equal(typeof definition?.renderCall, "function", `${toolName} must render calls through pi-square`);
    assert.equal(typeof definition?.renderResult, "function", `${toolName} must render results through pi-square`);
    assert.equal(definition?.renderShell, "self", `${toolName} must own its display shell`);
  }

  const anchoredRead = await toolByName("read").execute("smoke:anchored-read", { path: "sample.txt" }, undefined, undefined);
  const anchor = /^([A-Za-z0-9]{3})│pi-square-smoke-needle$/m.exec(anchoredRead.content[0].text)?.[1];
  assert.ok(anchor, "enabled read must return an anchor");
  const anchoredReplace = await toolByName("replace").execute("smoke:anchored-replace", {
    path: "sample.txt",
    remove_from: anchor,
    remove_to: anchor,
    replacement_text: "pi-square-smoke-replaced",
  }, undefined, undefined);
  assert.equal(anchoredReplace.details.metrics?.classification, "applied");
  assert.match(anchoredReplace.content[0].text, /pi-square-smoke-replaced/);

  const writeInput = { path: "sample.txt", content: "pi-square-smoke-written\n" };
  await runner.emitToolCall({ toolName: "write", toolCallId: "smoke:anchored-write", input: writeInput });
  const writeResult = await toolByName("write").execute(
    "smoke:anchored-write",
    writeInput,
    undefined,
    undefined,
  );
  const refreshedWrite = await runner.emitToolResult({
    toolName: "write",
    toolCallId: "smoke:anchored-write",
    input: writeInput,
    content: writeResult.content,
    details: writeResult.details,
    isError: writeResult.isError ?? false,
  });
  assert.match(refreshedWrite?.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n") ?? "", /Auto-read \(hashline anchors\)/);
  // A successful write refreshes the served state through auto-read, so the
  // write's fresh anchors support an immediate follow-up replace without
  // another read (#187: served rows replaced the revert record as the
  // post-edit recovery surface).
  const writtenAnchor = /^([A-Za-z0-9]{3})│pi-square-smoke-written$/m.exec(
    refreshedWrite?.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n") ?? "",
  )?.[1];
  assert.ok(writtenAnchor, "the write's auto-read appendix carries a fresh anchor");
  const writeFollowUp = await toolByName("replace").execute(
    "smoke:write-follow-up-replace",
    { path: "sample.txt", remove_from: writtenAnchor, remove_to: writtenAnchor, replacement_text: "pi-square-smoke-after-write" },
    undefined,
    undefined,
  );
  assert.equal(writeFollowUp.details.metrics?.classification, "applied");
  assert.match(writeFollowUp.content[0].text, /pi-square-smoke-after-write/, "the write's fresh anchors support an immediate follow-up replace");

  await runner.emitToolCall({ toolName: "write", toolCallId: "smoke:failed-write", input: writeInput });
  const failedWrite = await runner.emitToolResult({
    toolName: "write",
    toolCallId: "smoke:failed-write",
    input: writeInput,
    content: [{ type: "text", text: "Write failed" }],
    details: {},
    isError: true,
  });
  assert.equal(failedWrite, undefined, "failed writes leave their original result unchanged");
  const pendingAnchor = /\+([A-Za-z0-9]{3})│pi-square-smoke-after-write/.exec(writeFollowUp.details.diff ?? "")?.[1];
  assert.ok(pendingAnchor, "the applied replace carries a fresh anchor for the failed-write check");
  const preservedServed = await toolByName("replace").execute(
    "smoke:preserved-served-replace",
    { path: "sample.txt", remove_from: pendingAnchor, remove_to: pendingAnchor, replacement_text: "pi-square-smoke-pending" },
    undefined,
    undefined,
  );
  assert.equal(preservedServed.details.metrics?.classification, "applied");
  assert.match(preservedServed.content[0].text, /pi-square-smoke-pending/, "a failed Pi write preserves the served state for the next replace");

  // ── #187: an external read → replace → write flow through native path
  // authority, with replace as the only range-editing path. ──
  const externalRead = await toolByName("read").execute("smoke:external-read", { path: "../external-smoke.txt" }, undefined, undefined);
  const externalAnchor = /^([A-Za-z0-9]{3})│pi-square-smoke-external$/m.exec(externalRead.content[0].text)?.[1];
  assert.ok(externalAnchor, "an external read through the parent override serves anchored rows");
  const externalReplace = await toolByName("replace").execute(
    "smoke:external-replace",
    { path: "../external-smoke.txt", remove_from: externalAnchor, remove_to: externalAnchor, replacement_text: "pi-square-smoke-external-edited" },
    undefined,
    undefined,
  );
  assert.equal(externalReplace.details.metrics?.classification, "applied");
  assert.match(externalReplace.content[0].text, /pi-square-smoke-external/, "an external replace applies through the same authority");
  const externalWriteInput = { path: "../external-smoke.txt", content: "pi-square-smoke-external-written\n" };
  await runner.emitToolCall({ toolName: "write", toolCallId: "smoke:external-write", input: externalWriteInput });
  const externalWriteResult = await toolByName("write").execute(
    "smoke:external-write",
    externalWriteInput,
    undefined,
    undefined,
  );
  const refreshedExternalWrite = await runner.emitToolResult({
    toolName: "write",
    toolCallId: "smoke:external-write",
    input: externalWriteInput,
    content: externalWriteResult.content,
    details: externalWriteResult.details,
    isError: false,
  });
  assert.match(
    refreshedExternalWrite?.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n") ?? "",
    /Auto-read \(hashline anchors\)/,
    "an external write refreshes its anchors through auto-read",
  );

  const todoResult = await toolByName("todo").execute("smoke:todo", {
    action: "set",
    todos: [{ id: "smoke", text: "verify native state" }],
  }, undefined, undefined);
  assert.equal(todoResult.details.counts.total, 1);
  assert.equal(todoResult.details.currentId, "smoke");
  assert.equal(JSON.parse(todoResult.content[0].text).version, 1);

  const codegraphResult = await toolByName("codegraph").execute("smoke:codegraph", {
    operation: "status",
  }, undefined, undefined);
  assert.equal(codegraphResult.details.code, "NOT_INDEXED");
  assert.equal(codegraphResult.details.phase, "recoverable");

  // The fake model and stream stub existed only for the compaction seams; the
  // remaining sections run model-agnostic like the rest of the smoke.
  session.agent.state.model = undefined;

  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    anchoredEditing: { enabled: false },
  }, null, 2) + "\n");
  await runner.emit({ type: "session_start", reason: "config-change" });
  assert.ok(session.agent.state.tools.some((tool) => tool.name === "read"), "disabled anchored editing restores Pi read");
  assert.ok(session.agent.state.tools.some((tool) => tool.name === "edit"), "disabled anchored editing restores Pi edit");
  assert.ok(!session.agent.state.tools.some((tool) => tool.name === "replace"), "disabled anchored editing removes replace");
  const disabledRead = await toolByName("read").execute("smoke:disabled-read", { path: "sample.txt" }, undefined, undefined);
  assert.doesNotMatch(disabledRead.content[0].text, /^[A-Za-z0-9]{3}│/m, "disabled read returns Pi content without anchors");

  console.log("pi-square smoke: OK");
} finally {
  created.session.dispose?.();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
}
