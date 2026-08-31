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
const { MEMORY_FORMAT_TAG } = await smokeLoad("../src/context-memory/format.ts");

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
// The shared in-memory session the smoke run drives; #217 appends a real
// compaction entry to it for the Context Memory reading surface.
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
  assert.match(anchoredReplace.content[0].text, /Successfully replaced/);

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
  assert.match(writeFollowUp.content[0].text, /Successfully replaced/, "the write's fresh anchors support an immediate follow-up replace");

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
  assert.match(preservedServed.content[0].text, /Successfully replaced/, "a failed Pi write preserves the served state for the next replace");

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
  assert.match(externalReplace.content[0].text, /Successfully replaced/, "an external replace applies through the same authority");
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

  // ── Context Memory shell (#215, #216): default-off, registered but inactive ──
  const allToolsAfterStart = extensionsResult.runtime.getAllTools().map((tool) => tool.name);
  assert.ok(allToolsAfterStart.includes("submit_memory"), "submit_memory is registered");
  assert.ok(allToolsAfterStart.includes("read_memory_source"), "read_memory_source is registered");
  for (const definition of ["submit_memory", "read_memory_source"]) {
    assert.equal(typeof session.getToolDefinition(definition)?.renderCall, "function", `${definition} renders calls through pi-square`);
    assert.equal(session.getToolDefinition(definition)?.renderShell, "self", `${definition} owns its display shell`);
  }
  const inactiveMemoryTools = (name) => name === "submit_memory" || name === "read_memory_source";
  assert.ok(
    !session.agent.state.tools.some((tool) => inactiveMemoryTools(tool.name)),
    "default-off configuration leaves both Context Memory tools inactive",
  );

  const contextCommand = runner.getCommand("context");
  assert.ok(contextCommand, "/context remains the sole Context Memory surface owner");
  async function runContextCommand(args = "") {
    const notified = [];
    const commandCtx = runner.createCommandContext();
    await contextCommand.handler(args, {
      ...commandCtx,
      hasUI: true,
      ui: { ...commandCtx.ui, notify: (text) => notified.push(text) },
    });
    return stripVTControlCharacters(notified.join("\n"));
  }
  const defaultContextView = await runContextCommand();
  assert.match(defaultContextView, /memory\[\]/, "/context renders the memory[] section");
  assert.match(defaultContextView, /disabled · enable through agent-level contextMemory configuration/,
    "the default state explains disabled");
  assert.match(defaultContextView, /Prompt Manager/, "/context still renders the Prompt Manager snapshot");

  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: { enabled: true, compressionThreshold: { tokens: 2500 }, memoryBudgetPercent: 1 },
  }, null, 2) + "\n");
  await runner.emit({ type: "session_start", reason: "config-change" });
  assert.ok(
    !session.agent.state.tools.some((tool) => inactiveMemoryTools(tool.name)),
    "an enabled configuration still leaves both tools inactive without Memory or a due run",
  );
  const enabledContextView = await runContextCommand();
  assert.match(enabledContextView, /enabled · no Memory blocks yet/,
    "the enabled/no-Memory state renders through /context");

  // ── #218: the first Memory block through the full handshake, with Pi's own
  // compaction seam consuming the candidate end to end ──

  // A large real conversation pushes the deterministic estimate past the due
  // point; the fake model carries the window and would fail loudly if the
  // takeover ever tried a summarization call.
  let smokeSourceEndEntry;
  for (let i = 0; i < 40; i++) {
    smokeSession.appendMessage({
      role: "user", content: `smoke bulk request ${i} ` + "context filler ".repeat(24), timestamp: 100 + i * 2,
    });
    smokeSourceEndEntry = smokeSession.appendMessage({
      role: "assistant",
      // No usage payload: Pi's estimator then measures the whole projected
      // conversation instead of trusting a fabricated last-assistant count.
      content: [{ type: "text", text: `smoke bulk answer ${i} ` + "deterministic filler ".repeat(24) }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      stopReason: "stop", timestamp: 101 + i * 2,
    });
  }
  session.agent.state.model = { provider: "smoke", id: "smoke-model", contextWindow: 200000 };
  session.agent.streamFunction = async () => {
    throw new Error("the Context Memory takeover must not call the model");
  };
  session.agent.state.messages = smokeSession.buildSessionContext().messages;
  await runner.emit({ type: "agent_settled" });
  const dueContextView = await runContextCommand();
  assert.match(dueContextView, /due · threshold reached · the next run authors the first Memory block/,
    "/context renders the due state");

  const inputResult = await runner.emitInput("smoke: ship the first Memory block", undefined, "interactive");
  assert.equal(inputResult.action, "continue", "the input boundary passes the prompt through unchanged");
  assert.ok(
    session.agent.state.tools.some((tool) => tool.name === "submit_memory"),
    "the due real-user run activates submit_memory before request construction",
  );

  const smokeRequestEntry = smokeSession.appendMessage({
    role: "user", content: "smoke: ship the first Memory block", timestamp: 400,
  });
  const projectedRequest = smokeSession.buildSessionContext().messages;
  const transformedRequest = await runner.emitContext(projectedRequest);
  const advisoryMessages = transformedRequest.filter(
    (message) => message?.customType === "pi-square.context-memory/advisory",
  );
  assert.equal(advisoryMessages.length, 1, "the first provider request carries exactly one advisory");
  assert.equal(advisoryMessages[0].display, false);
  assert.equal(transformedRequest.at(-2)?.role, "user");
  assert.equal(transformedRequest.at(-2)?.content, "smoke: ship the first Memory block",
    "the advisory sits directly after the current user message");
  const repeatedRequest = await runner.emitContext(transformedRequest);
  assert.equal(
    repeatedRequest.filter((message) => message?.customType === "pi-square.context-memory/advisory").length,
    1,
    "later requests never repeat the advisory",
  );

  const smokeBlock = "# Smoke first block\n\n- the bulk exchange explored deterministic filler content";
  smokeSession.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "done — submitting the first Memory block" },
      { type: "toolCall", id: "smoke:submit-first", name: "submit_memory", arguments: { markdown: smokeBlock } },
    ],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 401,
  });
  await runner.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "done — submitting the first Memory block" },
        { type: "toolCall", id: "smoke:submit-first", name: "submit_memory", arguments: { markdown: smokeBlock } },
      ],
    },
  });
  const submitCtx = runner.createCommandContext();
  const submitResult = await toolByName("submit_memory").execute(
    "smoke:submit-first",
    { markdown: smokeBlock },
    undefined,
    undefined,
    submitCtx,
  );
  assert.equal(submitResult.content[0].text, "Memory candidate accepted; compaction pending.");
  assert.deepEqual(submitResult.details, { accepted: true });
  assert.equal(submitResult.terminate, true);
  smokeSession.appendMessage({
    role: "toolResult", toolCallId: "smoke:submit-first", toolName: "submit_memory",
    content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], isError: false, timestamp: 402,
  });

  await runner.emit({ type: "agent_settled" });
  for (let i = 0; i < 500 && session.isCompacting; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(!session.isCompacting, "the settle-triggered compaction finished");

  const smokeCompactions = smokeSession.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(smokeCompactions.length, 1, "Pi's own seam saved exactly one compaction entry");
  assert.equal(smokeCompactions[0].fromHook, true, "the saved entry carries extension origin");
  assert.equal(smokeCompactions[0].firstKeptEntryId, smokeRequestEntry,
    "the current real-user request is the retained-tail boundary");
  assert.equal(smokeCompactions[0].summary.endsWith(smokeBlock), true, "the saved summary carries the block byte-exact");
  // The byte directory is the fourth field confirmation compares; without this
  // a details round-trip failure would only surface as a silent conflict.
  assert.deepEqual(smokeCompactions[0].details, {
    format: MEMORY_FORMAT_TAG,
    blocks: [{ endEntryId: smokeSourceEndEntry, markdownBytes: Buffer.byteLength(smokeBlock, "utf8") }],
  }, "Pi round-trips the byte directory the compaction confirmation compares");

  const committedContextView = await runContextCommand();
  assert.match(committedContextView, /memory\[\]\s+active/, "/context shows the committed Memory");
  assert.match(committedContextView, /1 block/, "/context counts the committed block");
  assert.ok(
    session.agent.state.tools.some((tool) => tool.name === "read_memory_source"),
    "the committed block activates read_memory_source end to end",
  );
  assert.ok(
    !session.agent.state.tools.some((tool) => tool.name === "submit_memory"),
    "submit_memory deactivates after the handshake",
  );

  // The fake model and stream stub existed only for the compaction seam; the
  // remaining sections run model-agnostic like the rest of the smoke.
  session.agent.state.model = undefined;

  // ── #217 reading surface over the genuinely committed block (#218 commit) ──

  const activeContextView = await runContextCommand();
  assert.match(activeContextView, /memory\[\]\s+active/, "/context shows the active Memory state");
  assert.match(activeContextView, /1 block/, "/context counts the Memory blocks");
  assert.match(activeContextView, /# Smoke first block/, "/context previews the block chronologically");
  assert.match(activeContextView, /\d+ sources/, "/context shows the safe source count");

  const memoryDetailView = await runContextCommand("memory 1");
  assert.match(memoryDetailView, /# Smoke first block/, "/context memory shows the full block Markdown");
  assert.match(memoryDetailView, /smoke bulk request 0/, "/context memory shows a source page");
  assert.match(memoryDetailView, /read-only · current session only · visible in terminal scrollback/,
    "/context memory states the inspection boundary");

  const invalidDetailView = await runContextCommand("memory banana");
  assert.match(invalidDetailView, /Usage: \/context \[memory <block> \[page\]\]/,
    "invalid /context memory syntax shows one usage line");

  const commandCtx = runner.createCommandContext();
  const memorySourceResult = await toolByName("read_memory_source").execute(
    "smoke:memory-source",
    { block: 1, page: 1 },
    undefined,
    undefined,
    commandCtx,
  );
  assert.match(memorySourceResult.content[0].text, /^Memory source · block 1 of 1 · page 1 of \d+$/);
  assert.match(memorySourceResult.content[1].text, /smoke bulk request 0/);
  assert.ok(!memorySourceResult.content[1].text.includes(smokeRequestEntry),
    "the real tool page never exposes entry ids");
  assert.deepEqual(
    Object.keys(memorySourceResult.details).sort(),
    ["block", "hasMore", "page", "totalBlocks", "totalPages"],
  );

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
