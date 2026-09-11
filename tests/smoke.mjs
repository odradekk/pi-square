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
const { MEMORY_FORMAT_TAG, MEMORY_SUMMARY_WRAPPER, composeMemorySummary } = await smokeLoad("../src/context-memory/format.ts");

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

  // ── Context Memory shell (#215, #216, #319): default-off, registered but inactive ──
  const allToolsAfterStart = extensionsResult.runtime.getAllTools().map((tool) => tool.name);
  assert.ok(allToolsAfterStart.includes("compact_to_memory_block"), "compact_to_memory_block is registered");
  assert.ok(allToolsAfterStart.includes("read_memory_source"), "read_memory_source is registered");
  assert.ok(!allToolsAfterStart.includes("submit_memory"), "the retired submit_memory name is not registered");
  for (const definition of ["compact_to_memory_block", "read_memory_source"]) {
    assert.equal(typeof session.getToolDefinition(definition)?.renderCall, "function", `${definition} renders calls through pi-square`);
    assert.equal(session.getToolDefinition(definition)?.renderShell, "self", `${definition} owns its display shell`);
  }
  const inactiveMemoryTools = (name) => name === "compact_to_memory_block" || name === "read_memory_source";
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
    session.agent.state.tools.some((tool) => tool.name === "compact_to_memory_block"),
    "the resident compression tool is active from the first enabled request (#319)",
  );
  assert.ok(
    !session.agent.state.tools.some((tool) => tool.name === "read_memory_source"),
    "the reading surface stays inactive without valid Memory",
  );
  const enabledContextView = await runContextCommand();
  assert.match(enabledContextView, /enabled · no Memory blocks yet/,
    "the enabled/no-Memory state renders through /context");
  assert.match(enabledContextView, /ephemeral session/,
    "the in-memory smoke session is reported as ephemeral (#221)");

  // ── #319: the due advisory rides the projected request; the tool records
  // through Pi's public custom-entry seam and the next request applies the
  // carrier without any settle or compaction ──

  // A large real conversation pushes the deterministic projection estimate
  // past the due point.
  for (let i = 0; i < 40; i++) {
    smokeSession.appendMessage({
      role: "user", content: `smoke bulk request ${i} ` + "context filler ".repeat(24), timestamp: 100 + i * 2,
    });
    smokeSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `smoke bulk answer ${i} ` + "deterministic filler ".repeat(24) }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      stopReason: "stop", timestamp: 101 + i * 2,
    });
  }
  session.agent.state.model = { provider: "smoke", id: "smoke-model", contextWindow: 200000 };
  session.agent.state.messages = smokeSession.buildSessionContext().messages;
  await runner.emit({ type: "agent_settled" });
  const dueContextView = await runContextCommand();
  assert.match(dueContextView, /due · threshold reached · compression advisory rides the next request/,
    "/context renders the due state");
  assert.ok(
    session.agent.state.tools.some((tool) => tool.name === "compact_to_memory_block"),
    "the compression tool stays resident while due (#319)",
  );

  const smokeRequestEntry = smokeSession.appendMessage({
    role: "user", content: "smoke: ship the first Memory block", timestamp: 400,
  });
  const nativeRequest = () => smokeSession.buildSessionContext().messages;
  const advisoryCount = (messages) =>
    messages.filter((message) => message?.customType === "pi-square.context-memory/advisory").length;
  const transformedRequest = await runner.emitContext(nativeRequest());
  assert.equal(advisoryCount(transformedRequest), 1, "the due request carries exactly one advisory");
  assert.equal(transformedRequest.at(-2)?.role, "user");
  assert.equal(transformedRequest.at(-2)?.content, "smoke: ship the first Memory block",
    "the advisory sits directly after the current user message");
  const secondTransformed = await runner.emitContext(nativeRequest());
  assert.equal(advisoryCount(secondTransformed), 1,
    "a fresh request from the same branch still carries exactly one advisory — never accumulated");

  const smokeBlock = "# Smoke first block\n\n- the bulk exchange explored deterministic filler content";
  smokeSession.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "done — recording the first Memory block" },
      { type: "toolCall", id: "smoke:compact-first", name: "compact_to_memory_block", arguments: { markdown: smokeBlock } },
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
        { type: "text", text: "done — recording the first Memory block" },
        { type: "toolCall", id: "smoke:compact-first", name: "compact_to_memory_block", arguments: { markdown: smokeBlock } },
      ],
    },
  });
  const compactCtx = runner.createCommandContext();
  const compactResult = await toolByName("compact_to_memory_block").execute(
    "smoke:compact-first",
    { markdown: smokeBlock },
    undefined,
    undefined,
    compactCtx,
  );
  assert.equal(
    compactResult.content[0].text,
    "Memory block recorded. The next model request will carry it in place of the covered older conversation.",
  );
  assert.deepEqual(compactResult.details, { recorded: true });
  assert.equal(smokeSession.getBranch().filter((entry) => entry.type === "compaction").length, 0,
    "recording never writes a compaction entry (#319)");
  const smokeStateEntries = smokeSession.getBranch().filter(
    (entry) => entry.type === "custom" && entry.customType === "pi-square.context-memory/memory",
  );
  assert.equal(smokeStateEntries.length, 1, "exactly one Memory state entry is recorded");
  assert.equal(smokeStateEntries[0].data.format, "pi-square.context-memory/2");
  assert.equal(smokeStateEntries[0].data.blocks.length, 1);
  assert.equal(smokeStateEntries[0].data.blocks[0].markdown, smokeBlock);
  assert.equal(smokeStateEntries[0].data.blocks[0].retainedEntryIds.length, 0,
    "no protected instruction fell inside the covered range");
  assert.ok(
    session.agent.state.tools.some((tool) => tool.name === "compact_to_memory_block"),
    "the resident compression tool stays active after recording (#319)",
  );

  const recordedView = await runContextCommand();
  assert.match(recordedView, /memory\[\]\s+active/, "/context shows the recorded Memory");
  assert.match(recordedView, /1 block/, "/context counts the recorded block");
  assert.match(recordedView, /recorded · not yet applied/, "/context distinguishes recorded from applied (#319)");

  smokeSession.appendMessage({
    role: "toolResult", toolCallId: "smoke:compact-first", toolName: "compact_to_memory_block",
    content: [{ type: "text", text: "Memory block recorded. The next model request will carry it in place of the covered older conversation." }],
    isError: false, timestamp: 402,
  });
  session.agent.state.messages = nativeRequest();

  // The next ordinary request applies the carrier without any settle.
  const appliedRequest = await runner.emitContext(nativeRequest());
  const carriers = appliedRequest.filter((message) => message?.customType === "pi-square.context-memory/blocks");
  assert.equal(carriers.length, 1, "exactly one Memory carrier enters the request");
  assert.equal(carriers[0].display, false);
  const carrierParts = carriers[0].content.map((part) => part.text);
  assert.equal(carrierParts.length, 2, "one block plus the wrapper part");
  assert.equal(carrierParts[0], MEMORY_SUMMARY_WRAPPER, "the leading part carries the fixed wrapper");
  assert.equal(carrierParts[1], `\n---\n\n${smokeBlock}`, "the block is one distinct part, byte-exact");
  assert.ok(!JSON.stringify(carriers[0]).includes("cache_control"), "the carrier adds no provider cache field");
  const rawAfterApply = JSON.stringify(appliedRequest.filter((m) => m?.customType !== "pi-square.context-memory/blocks"));
  assert.ok(!rawAfterApply.includes("smoke bulk request 0"), "covered original sources left the request");
  assert.ok(!rawAfterApply.includes("deterministic filler"), "covered assistant answers left the request");
  assert.ok(appliedRequest.some((m) => m?.role === "user" && m.content === "smoke: ship the first Memory block"),
    "the latest user instruction stays raw in the request");
  const appliedCompactCalls = appliedRequest
    .filter((m) => m?.role === "assistant")
    .flatMap((m) => m.content.filter((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block"));
  assert.equal(appliedCompactCalls.length, 1, "the trailing compact pair survives whole for the provider contract");
  assert.equal(appliedCompactCalls[0].arguments.markdown, "(this Memory block is carried in full above)",
    "the tool arguments no longer duplicate the carried summary (#319)");
  assert.ok(!rawAfterApply.includes("deterministic filler".repeat(24)),
    "no covered source body remains anywhere in the request");
  const estimateTokens = (messages) => Math.ceil(JSON.stringify(messages).length / 4);
  assert.ok(estimateTokens(appliedRequest) < estimateTokens(transformedRequest),
    "the applied request is smaller than the pre-recording due request");
  assert.ok(
    session.agent.state.tools.some((tool) => tool.name === "read_memory_source"),
    "the recorded block activates read_memory_source end to end",
  );
  const appliedView = await runContextCommand();
  assert.match(appliedView, /applied to requests/, "/context reports the applied carrier (#319)");
  assert.ok(
    !appliedRequest.some((message) => message?.customType === "pi-square.context-memory/advisory"),
    "the advisory cleared once the projection relieved the pressure",
  );

  // ── #217 reading surface over the state-carried block ──

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

  // ── #319: a second append extends the recorded Memory byte-stably ──

  // More bulk conversation accumulates after the first recording.
  let smokeSecondSourceEnd;
  for (let i = 0; i < 24; i++) {
    smokeSession.appendMessage({
      role: "user", content: `smoke second-round request ${i} ` + "later filler ".repeat(24), timestamp: 500 + i * 2,
    });
    smokeSecondSourceEnd = smokeSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `smoke second-round answer ${i} ` + "later response filler ".repeat(20) }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      stopReason: "stop", timestamp: 501 + i * 2,
    });
  }
  session.agent.state.messages = nativeRequest();
  smokeSession.appendMessage({
    role: "user", content: "smoke: ship the second Memory block", timestamp: 600,
  });
  // Serve the request the second compression answers: the newly accumulated
  // round must reach the model before it can become a source (#319).
  const secondServed = await runner.emitContext(nativeRequest());
  assert.equal(secondServed.filter((message) => message?.customType === "pi-square.context-memory/advisory").length, 1,
    "the second due request carries exactly one advisory");
  const smokeSecondBlock = "# Smoke second block\n\n- the second-round exchange covered later filler work";
  smokeSession.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "done — appending the second Memory block" },
      { type: "toolCall", id: "smoke:compact-second", name: "compact_to_memory_block", arguments: { markdown: smokeSecondBlock } },
    ],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 601,
  });
  await runner.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "done — appending the second Memory block" },
        { type: "toolCall", id: "smoke:compact-second", name: "compact_to_memory_block", arguments: { markdown: smokeSecondBlock } },
      ],
    },
  });
  const secondSubmitCtx = runner.createCommandContext();
  const secondSubmitResult = await toolByName("compact_to_memory_block").execute(
    "smoke:compact-second",
    { markdown: smokeSecondBlock },
    undefined,
    undefined,
    secondSubmitCtx,
  );
  assert.deepEqual(secondSubmitResult.details, { recorded: true });
  smokeSession.appendMessage({
    role: "toolResult", toolCallId: "smoke:compact-second", toolName: "compact_to_memory_block",
    content: [{ type: "text", text: "Memory block recorded. The next model request will carry it in place of the covered older conversation." }],
    isError: false, timestamp: 602,
  });
  session.agent.state.messages = nativeRequest();

  const stateEntriesAfter = smokeSession.getBranch().filter(
    (entry) => entry.type === "custom" && entry.customType === "pi-square.context-memory/memory",
  );
  assert.equal(stateEntriesAfter.length, 2, "the second append records exactly one more state entry");
  assert.equal(stateEntriesAfter[1].data.blocks.length, 2, "the new state carries both blocks");
  assert.equal(stateEntriesAfter[1].data.blocks[0].markdown, smokeBlock,
    "the existing block keeps its bytes and position");
  assert.equal(smokeSession.getBranch().filter((entry) => entry.type === "compaction").length, 0,
    "appending still never writes a compaction entry");

  const twoBlockRequest = await runner.emitContext(nativeRequest());
  const twoBlockCarriers = twoBlockRequest.filter((message) => message?.customType === "pi-square.context-memory/blocks");
  assert.equal(twoBlockCarriers.length, 1, "one carrier still carries the complete Memory");
  const twoBlockParts = twoBlockCarriers[0].content.map((part) => part.text);
  assert.equal(twoBlockParts.length, 3, "two blocks plus the wrapper part");
  assert.equal(twoBlockParts[1], `\n---\n\n${smokeBlock}`, "the first block's part is byte-identical");
  assert.equal(twoBlockParts[2], `\n---\n\n${smokeSecondBlock}`, "the second block appends one new part");

  const twoBlockView = await runContextCommand();
  assert.match(twoBlockView, /2 blocks/, "/context counts both recorded blocks");
  assert.match(twoBlockView, /# Smoke second block/, "/context previews the appended block chronologically");
  const secondDetailView = await runContextCommand("memory 2");
  assert.match(secondDetailView, /# Smoke second block/, "/context memory shows the appended block Markdown");
  assert.match(secondDetailView, /smoke second-round request 0/, "/context memory shows the appended block's sources");
  const secondMemorySource = await toolByName("read_memory_source").execute(
    "smoke:memory-source-2",
    { block: 2, page: 1 },
    undefined,
    undefined,
    runner.createCommandContext(),
  );
  assert.match(secondMemorySource.content[0].text, /^Memory source · block 2 of 2 · page 1 of \d+$/);
  assert.match(secondMemorySource.content[1].text, /smoke second-round request 0/);
  assert.ok(!secondMemorySource.content[1].text.includes("smoke bulk request 0"),
    "the appended block covers only the newly accumulated sources");
  assert.ok(smokeSecondSourceEnd, "the second round accumulated real sources");

  // ── #319: above half the Memory budget the append refuses; the rebuild
  // operation is owned by a later ticket and must not be faked ──
  session.agent.state.model = { provider: "smoke", id: "smoke-model", contextWindow: 26000 };
  await runner.emit({ type: "agent_settled" });
  smokeSession.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "trying one more append above half budget" },
      { type: "toolCall", id: "smoke:compact-refused", name: "compact_to_memory_block", arguments: { markdown: "# Refused\n\n- above half budget" } },
    ],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 700,
  });
  await runner.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "trying one more append above half budget" },
        { type: "toolCall", id: "smoke:compact-refused", name: "compact_to_memory_block", arguments: { markdown: "# Refused\n\n- above half budget" } },
      ],
    },
  });
  await assert.rejects(
    () => toolByName("compact_to_memory_block").execute(
      "smoke:compact-refused",
      { markdown: "# Refused\n\n- above half budget" },
      undefined,
      undefined,
      runner.createCommandContext(),
    ),
    /MAINTENANCE_PENDING/,
    "an append above half the Memory budget refuses instead of degrading",
  );
  assert.equal(
    smokeSession.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-square.context-memory/memory").length,
    2,
    "the refused append records nothing",
  );

  // The model stub existed only for the Context Memory budget checks; the
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
