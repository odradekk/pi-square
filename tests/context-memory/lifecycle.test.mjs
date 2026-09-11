import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_SUMMARY_WRAPPER } = await load("../../src/context-memory/format.ts");

/**
 * #322 mechanical acceptance: recorded Context Memory survives interruptions
 * and native Pi session branches, truthfully and branch-privately, through
 * real Pi `AgentSession`s over real persisted session files, native tree
 * operations (`navigateTree`, `createBranchedSession`, cross-directory
 * copies), and the faux-provider request exit as the observation seam.
 *
 * Lifecycle matrix proven here on top of the #319 append loop:
 *
 * - Recording mid-task on a persisted session, with a protected instruction
 *   retained inside the covered range; the retained exception survives new
 *   user input moving the protection zone.
 * - Restart/resume re-derives the same replacement set (byte-equal carrier
 *   parts, byte-equal source pages), never replays unrecorded candidates or
 *   advisories, and never fabricates a provider request before the next
 *   ordinary prompt.
 * - A cancellation after recording keeps the real record (the acknowledgement
 *   result stays truthful); a cancellation before the write records nothing
 *   and leaves no poisoned state, and the same session can still record.
 * - Same-batch competing and repeated submissions record once or not at all.
 * - Fork (parent future invisible), in-file sibling branches via tree
 *   navigation (isolated both directions, and a sibling append keeps the old
 *   prefix byte-stable), imported cross-directory copies, native compaction
 *   supersession (no stacking, no resurrection, bounded refusal), disabled
 *   configuration (raw history model-visible again, file untouched), and
 *   ephemeral in-memory sessions (same behavior, no files).
 *
 * Deterministic coordination only: aborts fire from session events (the
 * compact tool-result message_end, a counted turn_start), never from sleeps.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 500;
const MEMORY_BUDGET_PERCENT = 1;

/** Early user instruction: covered by the first block once later work lands. */
const EARLY_NEEDLE = "EARLY-ANCHOR-KILO-LIMA: brief me on the workspace before anything else.";
/** Protected instruction: the latest user instruction inside the covered range. */
const PROTECTED_NEEDLE = "PROTECTED-MIKE-NOVEMBER: keep this instruction verbatim in every request.";
/** A later user input that moves the protection zone after the recording. */
const QUEUED_NEEDLE = "QUEUED-OSCAR-PAPA: start the queued verification pass.";
/** A fact that exists only inside the recorded Memory block. */
const DIGEST_FACT = "DIGEST-FACT-SIERRA-TANGO: the vault code is LUNA-7.";

const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(14);
const WORK_FILES = {
  "file-a.txt": `FILE-A-NEEDLE: the build entry point registers every feature module.\n${FILLER}\n`,
  "file-b.txt": `FILE-B-NEEDLE: the login flow sets the session cookie after the redirect.\n${FILLER}\n`,
  "file-c.txt": `FILE-C-NEEDLE: the footer derives usage from read-only context each render.\n${FILLER}\n`,
  "file-d.txt": `FILE-D-NEEDLE: the theme pair ships two independently calibrated palettes.\n${FILLER}\n`,
  "file-e.txt": `FILE-E-NEEDLE: the sibling branch compresses its own new work.\n${FILLER}\n`,
};

const MAIN_MEMORY = [
  "# Workspace digest",
  "",
  "The early reads established the build entry points and the login flow.",
  `The digest also carries the one vault fact: ${DIGEST_FACT}`,
].join("\n");

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

/** The carrier is found by its fixed wrapper: provider conversion drops custom types. */
function carrierOf(messages) {
  return messages.find((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
}

function carrierParts(messages) {
  const carrier = carrierOf(messages);
  return carrier ? carrier.content.filter((part) => part?.type === "text").map((part) => part.text) : undefined;
}

function stateEntriesOf(manager) {
  return manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
}

function compactToolResultsOf(manager) {
  return manager.getBranch().filter((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "compact_to_memory_block");
}

function resultText(entry) {
  return messageText(entry.message);
}

/** Every file under `dir`, recursively. */
function walkFiles(dir) {
  const files = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files.sort();
}

const environments = [];

function prepareEnvironment({ name, enabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `pi-square-lifecycle-${name}-`));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const sessionsDir = join(root, "sessions");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: {
      enabled,
      compressionThreshold: { tokens: COMPRESSION_THRESHOLD_TOKENS },
      memoryBudgetPercent: MEMORY_BUDGET_PERCENT,
    },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [{ source: packageRoot }],
    quietStartup: true,
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  for (const [fileName, content] of Object.entries(WORK_FILES)) {
    writeFileSync(join(cwd, fileName), content);
  }
  environments.push(root);
  return { root, agentDir, cwd, sessionsDir };
}

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-lifecycle-runtime-"));
writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

/** One faux provider per environment so response scripts never interleave. */
let providerCounter = 0;
function createFaux() {
  const provider = `lifecycle-${providerCounter += 1}`;
  return { provider, faux: fauxProvider({ provider, api: provider, models: [{ id: provider, contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }] }) };
}

/** The active response script: driven only by request state, never time. */
let scriptNext = null;
function scriptResponse(context) {
  const last = context.messages.at(-1);
  const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;
  const lastText = last?.role === "toolResult" ? messageText(last) : "";
  const text = requestText(context.messages);
  const response = scriptNext?.({ lastToolName, lastText, text, messages: context.messages });
  return response ?? fauxAssistantMessage("standing by", { stopReason: "stop" });
}

function script(hook) {
  scriptNext = hook;
}

const opened = [];
let previousAgentDir = process.env.PI_CODING_AGENT_DIR;

/**
 * Open a real AgentSession over a live SessionManager. `startReason` becomes
 * the session_start reason the extensions observe, so resume and fork cells
 * exercise the real recovery path. Sequential callers only: Pi resolves the
 * agent configuration through a process-wide path.
 */
async function openSession({ runtime, faux, environment, manager, startReason = "startup", previousSessionFile }) {
  const requests = [];
  faux.setResponses(Array.from({ length: 120 }, () => (context) => {
    requests.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    });
    return scriptResponse(context);
  }));
  const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, noSkills: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    modelRuntime: runtime,
    model: faux.getModel(),
    thinkingLevel: "off",
    initialActiveToolNames: ["read"],
    sessionStartEvent: { type: "session_start", reason: startReason, ...(previousSessionFile ? { previousSessionFile } : {}) },
  });
  await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
  assert.equal(resourceLoader.getExtensions().errors.length, 0, "pi-square must load without extension errors");
  const handle = { session, requests };
  opened.push(handle);
  return handle;
}

async function prompt(session, text) {
  await session.prompt(text, { source: "interactive", expandPromptTemplates: false });
}

function lastAssistantText(session) {
  return session.messages.filter((message) => message.role === "assistant").map(messageText).findLast(() => true);
}

try {
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  // ════════════════════════════════════════════════════════════════════
  // §1 Record on a persisted session; retained exception; protection-zone
  //    move; source recovery; nothing but Pi session files anywhere.
  // ════════════════════════════════════════════════════════════════════

  const main = prepareEnvironment({ name: "main" });
  process.env.PI_CODING_AGENT_DIR = main.agentDir;
  const mainFaux = createFaux();
  runtime.registerNativeProvider(mainFaux.faux.provider);
  const mainManager = SessionManager.create(main.cwd, main.sessionsDir);
  const mainSession = await openSession({ runtime, faux: mainFaux.faux, environment: main, manager: mainManager });
  let phase = "briefing";
  script(({ lastToolName, lastText, text }) => {
    if (phase === "briefing") {
      if (lastToolName === "read" && lastText.includes("FILE-A-NEEDLE")) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && lastText.includes("FILE-B-NEEDLE")) {
        return fauxAssistantMessage("briefing complete, standing by", { stopReason: "stop" });
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
    }
    if (phase === "compress") {
      if (lastToolName === "read" && lastText.includes("FILE-C-NEEDLE")) {
        return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: MAIN_MEMORY }), { stopReason: "toolUse" });
      }
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-d.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && lastText.includes("FILE-D-NEEDLE")) {
        return fauxAssistantMessage(text.includes(DIGEST_FACT) && text.includes(PROTECTED_NEEDLE)
          ? `Task complete. ${DIGEST_FACT} The protected instruction stayed present.`
          : "Task incomplete: the digest fact or the protected instruction is missing from my context.",
          { stopReason: "stop" });
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-c.txt" }), { stopReason: "toolUse" });
    }
    if (phase === "queued") {
      return fauxAssistantMessage(text.includes(PROTECTED_NEEDLE)
        ? "Queued pass acknowledged; the protected instruction is still present."
        : "Queued pass broken: the protected instruction disappeared.",
        { stopReason: "stop" });
    }
    if (phase === "verify") {
      if (lastToolName === "read_memory_source") {
        return fauxAssistantMessage(lastText.includes("EARLY-ANCHOR-KILO-LIMA")
          ? `The original early instruction reads: ${EARLY_NEEDLE}`
          : "The original early instruction is missing from the recovered source.",
          { stopReason: "stop" });
      }
      return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 1, page: 1 }), { stopReason: "toolUse" });
    }
    return undefined;
  });

  await prompt(mainSession.session, `${EARLY_NEEDLE} Read file-a.txt and file-b.txt completely, then stand by. `);
  assert.ok(mainSession.requests.some((request) => requestText(request.messages).includes("FILE-B-NEEDLE")),
    "the briefing pass completed its ordinary reads");

  phase = "compress";
  await prompt(mainSession.session,
    `${PROTECTED_NEEDLE} Read file-c.txt, compress the older conversation into one Memory block that carries ${DIGEST_FACT}, then read file-d.txt and answer with the digest fact. `);
  const mainAnswer = lastAssistantText(mainSession.session);
  assert.match(mainAnswer, /LUNA-7/, "the digest fact reached the model through the carrier");
  assert.doesNotMatch(mainAnswer, /missing from my context/, "the compressed task finished whole");

  const mainStates = stateEntriesOf(mainManager);
  assert.equal(mainStates.length, 1, "exactly one Memory state entry is recorded");
  const protectedEntry = mainManager.getBranch().find((entry) =>
    entry.type === "message" && entry.message.role === "user" && messageText(entry.message).includes("PROTECTED-MIKE-NOVEMBER"));
  assert.ok(protectedEntry, "the protected instruction entry exists");
  assert.deepEqual(mainStates[0].data.blocks[0].retainedEntryIds, [protectedEntry.id],
    "the protected instruction is the recorded retained exception");
  assert.equal(mainManager.getBranch().filter((entry) => entry.type === "compaction").length, 0,
    "no compaction carries the Memory — the state entry is the only new durable carrier");

  const appliedRequest = mainSession.requests.find((request) => carrierOf(request.messages));
  assert.ok(appliedRequest, "a provider request carries the Memory carrier");
  const mainCarrierParts = carrierParts(appliedRequest.messages);
  assert.equal(mainCarrierParts[0], MEMORY_SUMMARY_WRAPPER);
  assert.equal(mainCarrierParts[1], `\n---\n\n${MAIN_MEMORY}`);
  const appliedText = requestText(appliedRequest.messages);
  assert.ok(!appliedText.includes("FILE-A-NEEDLE") && !appliedText.includes("FILE-B-NEEDLE"),
    "the covered reads left the applied request");
  assert.ok(!appliedText.includes(EARLY_NEEDLE), "the early user instruction was covered");
  assert.ok(appliedText.includes(PROTECTED_NEEDLE), "the protected instruction stays raw in the applied request");
  assert.ok(appliedRequest.toolNames.includes("read_memory_source"),
    "the reading surface is active on the recorded session");

  // A new user input moves the protection zone; the recorded retained
  // exception must not silently disappear.
  phase = "queued";
  await prompt(mainSession.session, `${QUEUED_NEEDLE} Just acknowledge. `);
  const queuedText = requestText(mainSession.requests.at(-1).messages);
  assert.ok(queuedText.includes(QUEUED_NEEDLE), "the new user input is present");
  assert.ok(queuedText.includes(PROTECTED_NEEDLE), "the retained instruction survives the protection-zone move");
  assert.ok(!queuedText.includes(EARLY_NEEDLE), "the covered early instruction stays covered");

  // Source recovery is captured through the real tool without appending a
  // transcript result to the branch, so the restart assertions below observe
  // a clean retained tail (a model-driven read would legitimately re-enter
  // the covered text into later requests as conversation content).
  const mainRead = await mainSession.session.getToolDefinition("read_memory_source").execute(
    "lifecycle:main-read", { block: 1, page: 1 }, undefined, undefined,
    mainSession.session.createReplacedSessionContext(),
  );
  const mainSourcePage = mainRead.content[1].text;
  assert.ok(mainSourcePage.includes("EARLY-ANCHOR-KILO-LIMA"),
    "the original source is recoverable right after the recording");

  // No Context Memory sidecar, lock, journal, or cache exists anywhere; the
  // only non-session files under the session directory belong to other
  // pi-square features (the anchored-edit store initializes its own subtree).
  assert.deepEqual(
    walkFiles(main.root).filter((path) => /context-memory/i.test(basename(path))), [],
    "Context Memory created no sidecar, lock, journal, or cache file");
  assert.deepEqual(
    walkFiles(main.sessionsDir).filter((path) => !path.endsWith(".jsonl") && !path.includes("/anchored-edit/")), [],
    "the sessions directory holds only Pi session files and other features' own stores");

  const mainFile = mainManager.getSessionFile();
  const mainFileBytesBefore = readFileSync(mainFile, "utf8");
  const stateEntryId = mainStates[0].id;
  const mainLeafId = mainManager.getLeafId();
  await mainSession.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §2 Restart/resume: no replay before the prompt, the same replacement
  //    set (byte-equal carrier parts and source pages), nothing re-recorded.
  // ════════════════════════════════════════════════════════════════════

  const resumedManager = SessionManager.open(mainFile, main.sessionsDir);
  const resumed = await openSession({
    runtime, faux: mainFaux.faux, environment: main, manager: resumedManager,
    startReason: "resume", previousSessionFile: mainFile,
  });
  assert.equal(resumed.requests.length, 0,
    "restart replays nothing: no provider request happens before the next ordinary prompt");
  assert.ok(resumed.requests.every((request) => request.toolNames.includes("compact_to_memory_block")),
    "the resident compression tool follows the resumed session from its first request");

  // The model-driven recovery read appends the page as ordinary conversation.
  phase = "verify";
  await prompt(resumed.session,
    "Second session: recover the original source of Memory block 1 (page 1) again and quote the early instruction verbatim. ");
  assert.match(lastAssistantText(resumed.session), /EARLY-ANCHOR-KILO-LIMA/,
    "the original source is recoverable after restart");
  const resumedFirst = resumed.requests[0];
  const resumedText = requestText(resumedFirst.messages);
  assert.deepEqual(carrierParts(resumedFirst.messages), mainCarrierParts,
    "the resumed request derives the byte-identical carrier from the same recorded state");
  assert.ok(!resumedText.includes(EARLY_NEEDLE), "the covered early instruction stays covered after restart");
  assert.ok(!resumedText.includes("FILE-A-NEEDLE"), "the covered reads stay covered after restart");
  assert.ok(resumedText.includes(PROTECTED_NEEDLE), "the retained exception is re-derived raw after restart");
  assert.ok(resumedFirst.toolNames.includes("read_memory_source"),
    "the reading surface is active again on the resumed branch");
  assert.equal(stateEntriesOf(resumedManager).length, 1, "restart records nothing new");
  const resumedSourceResult = resumedManager.getBranch().findLast((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read_memory_source");
  assert.equal(
    resumedSourceResult.message.content.find((part) => part.text.includes("EARLY-ANCHOR")).text,
    mainSourcePage,
    "source paging is byte-deterministic across restart");
  assert.ok(!mainFileBytesBefore.includes("pi-square.context-memory/advisory"),
    "the due advisory was never persisted to the session file");
  assert.ok(readFileSync(mainFile, "utf8").startsWith(mainFileBytesBefore),
    "restart appended to the session file without rewriting recorded history");

  // ════════════════════════════════════════════════════════════════════
  // §3 Sibling branches in one file: tree navigation isolates both ways,
  //    and a second recording on the sibling keeps the old prefix stable.
  // ════════════════════════════════════════════════════════════════════

  const siblingMemory = "# Sibling digest\n\n- the sibling branch compressed its own new work";
  await resumed.session.navigateTree(stateEntryId);
  assert.equal(resumedManager.getLeafId(), stateEntryId, "tree navigation moved the leaf onto the recorded state entry");
  script(({ lastToolName, lastText }) => {
    if (lastToolName === "read" && lastText.includes("FILE-E-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: siblingMemory }), { stopReason: "toolUse" });
    }
    if (lastToolName === "compact_to_memory_block") {
      return fauxAssistantMessage("sibling compression recorded", { stopReason: "stop" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-e.txt" }), { stopReason: "toolUse" });
  });
  await prompt(resumed.session,
    "SIBLING-UNIFORM: read file-e.txt, then compress this branch's new work into one additional Memory block. ");
  const siblingStates = stateEntriesOf(resumedManager);
  assert.equal(siblingStates.length, 2, "the sibling branch recorded its own second state entry");
  assert.deepEqual(siblingStates[1].data.blocks[0], siblingStates[0].data.blocks[0],
    "the append kept the earlier block byte-identical");
  const siblingRequest = resumed.requests.at(-1);
  const siblingParts = carrierParts(siblingRequest.messages);
  assert.deepEqual(siblingParts.slice(0, 2), mainCarrierParts,
    "the sibling carrier keeps the old prefix parts byte-stable");
  assert.equal(siblingParts[2], `\n---\n\n${siblingMemory}`);
  const siblingText = requestText(siblingRequest.messages);
  assert.ok(!siblingText.includes(QUEUED_NEEDLE),
    "the parent branch's later exchange is invisible on the sibling branch");
  assert.ok(!siblingText.includes("Recover the original source"),
    "the sibling branch never reads its sibling's source-verification exchange");

  // Navigate back onto the main line: the sibling's second record is invisible.
  await resumed.session.navigateTree(mainLeafId);
  script(() => fauxAssistantMessage("back on the main line", { stopReason: "stop" }));
  await prompt(resumed.session, "Back on the main line: acknowledge. ");
  const backRequest = resumed.requests.at(-1);
  assert.deepEqual(carrierParts(backRequest.messages), mainCarrierParts,
    "navigating back derives the main line's own Memory, never the sibling's");
  const backText = requestText(backRequest.messages);
  assert.ok(!backText.includes(siblingMemory), "the sibling branch's Memory never crosses into the main line");
  assert.ok(!backText.includes("FILE-E-NEEDLE"), "the sibling branch's work never crosses either");
  await resumed.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §4 Fork at the recorded leaf: the copy inherits exactly the recorded
  //    Memory and none of the parent session's later work.
  // ════════════════════════════════════════════════════════════════════

  const forkSource = SessionManager.open(mainFile, main.sessionsDir);
  const forkFile = forkSource.createBranchedSession(stateEntryId);
  assert.ok(forkFile, "the branched copy wrote its own session file");
  const forkManager = SessionManager.open(forkFile, main.sessionsDir);
  assert.equal(forkManager.getBranch().at(-1).id, stateEntryId,
    "the copied active path ends exactly at the recorded state entry");
  const fork = await openSession({
    runtime, faux: mainFaux.faux, environment: main, manager: forkManager,
    startReason: "fork", previousSessionFile: mainFile,
  });
  await prompt(fork.session, "Forked copy: acknowledge. ");
  const forkRequest = fork.requests[0];
  assert.deepEqual(carrierParts(forkRequest.messages), mainCarrierParts,
    "the fork derives its parent's recorded Memory self-contained");
  const forkText = requestText(forkRequest.messages);
  assert.ok(!forkText.includes(QUEUED_NEEDLE), "the fork does not inherit the parent session's later user input");
  assert.ok(!forkText.includes("Recover the original source"), "the fork does not inherit the parent's later exchange");
  assert.ok(forkRequest.toolNames.includes("read_memory_source"),
    "the fork's source reads resolve from its own copied tree");
  const forkRead = await fork.session.getToolDefinition("read_memory_source").execute(
    "lifecycle:fork-read", { block: 1, page: 1 }, undefined, undefined,
    fork.session.createReplacedSessionContext(),
  );
  assert.ok(forkRead.content[1].text.includes("EARLY-ANCHOR-KILO-LIMA"),
    "the forked copy recovers the original source from its own tree");
  await fork.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §5 Imported cross-directory copy under a different cwd.
  // ════════════════════════════════════════════════════════════════════

  const importDir = join(main.root, "imports");
  mkdirSync(importDir);
  const importedFile = join(importDir, "imported.jsonl");
  cpSync(mainFile, importedFile);
  const importedManager = SessionManager.open(importedFile, importDir, "/completely/elsewhere");
  assert.equal(importedManager.getCwd(), "/completely/elsewhere");
  const imported = await openSession({
    runtime, faux: mainFaux.faux, environment: main, manager: importedManager,
    startReason: "resume", previousSessionFile: mainFile,
  });
  await prompt(imported.session, "Imported copy: acknowledge. ");
  assert.deepEqual(carrierParts(imported.requests[0].messages), mainCarrierParts,
    "an imported copy derives the same Memory from its own tree alone");
  await imported.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §6 A native compaction after the record establishes the new baseline:
  //    no custom carrier stacks on top, no replaced history resurrects, and
  //    compressing over the baseline refuses with a bounded code.
  // ════════════════════════════════════════════════════════════════════

  const compactedFile = join(main.root, "compacted-copy.jsonl");
  cpSync(mainFile, compactedFile);
  const compactedManager = SessionManager.open(compactedFile, main.sessionsDir);
  const protectedOnCopy = compactedManager.getBranch().find((entry) =>
    entry.type === "message" && entry.message.role === "user" && messageText(entry.message).includes("PROTECTED-MIKE-NOVEMBER"));
  compactedManager.appendCompaction(
    "A plain native summary folded the covered history.",
    protectedOnCopy.id,
    4000,
    undefined,
    false,
  );
  const compacted = await openSession({
    runtime, faux: mainFaux.faux, environment: main, manager: compactedManager,
    startReason: "resume", previousSessionFile: mainFile,
  });
  let overBaselineSent = false;
  script(({ lastToolName }) => {
    if (!overBaselineSent) {
      overBaselineSent = true;
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "# Over baseline\n\n- must refuse" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("the native baseline owns the boundary now", { stopReason: "stop" });
  });
  await prompt(compacted.session, "Try to compress over the native baseline now. ");
  assert.match(resultText(compactToolResultsOf(compactedManager).at(-1)), /^MEMORY_CHANGED: /,
    "compressing over the superseded record refuses with a bounded code");
  const compactedRequest = compacted.requests.at(-1);
  assert.equal(carrierOf(compactedRequest.messages), undefined,
    "the superseded custom Memory never stacks its carrier on the native baseline");
  assert.equal(compactedRequest.messages.filter((message) => messageText(message).includes("A plain native summary folded")).length, 1,
    "the native summary message is the one summary in the request");
  const compactedText = requestText(compactedRequest.messages);
  assert.ok(!compactedText.includes(EARLY_NEEDLE), "the natively compacted history is not resurrected");
  assert.ok(compactedText.includes(PROTECTED_NEEDLE), "the native kept tail retains the protected instruction");
  assert.ok(!compactedRequest.toolNames.includes("read_memory_source"),
    "an opaque branch exposes no structured reading surface");
  assert.ok(compactedRequest.toolNames.includes("compact_to_memory_block"),
    "the resident compression tool stays available over the baseline");
  assert.equal(stateEntriesOf(compactedManager).length, 1,
    "the refused over-baseline attempt recorded nothing");
  await compacted.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §7 Disabled configuration: raw history becomes model-visible again,
  //    nothing is deleted, and no projection is promised.
  // ════════════════════════════════════════════════════════════════════

  const disabledEnv = prepareEnvironment({ name: "disabled", enabled: false });
  process.env.PI_CODING_AGENT_DIR = disabledEnv.agentDir;
  const disabledFile = join(disabledEnv.root, "disabled-copy.jsonl");
  cpSync(mainFile, disabledFile);
  const disabledManager = SessionManager.open(disabledFile, disabledEnv.sessionsDir);
  const disabledFaux = createFaux();
  runtime.registerNativeProvider(disabledFaux.faux.provider);
  const disabled = await openSession({
    runtime, faux: disabledFaux.faux, environment: disabledEnv, manager: disabledManager,
    startReason: "resume", previousSessionFile: mainFile,
  });
  const disabledEntriesBefore = disabledManager.getEntries().map((entry) => JSON.stringify(entry));
  script(() => fauxAssistantMessage("acknowledged without the extension active", { stopReason: "stop" }));
  await prompt(disabled.session, "Status check with the feature disabled. ");
  const disabledRequest = disabled.requests[0];
  const disabledText = requestText(disabledRequest.messages);
  assert.equal(carrierOf(disabledRequest.messages), undefined, "a disabled configuration installs no carrier");
  assert.ok(disabledText.includes(EARLY_NEEDLE),
    "covered original entries become model-visible again through Pi's native projection");
  assert.ok(JSON.stringify(disabledRequest.messages).includes("compact_to_memory_block"),
    "protocol artifacts stop filtering while the feature is disabled");
  assert.ok(!disabledRequest.toolNames.includes("compact_to_memory_block")
    && !disabledRequest.toolNames.includes("read_memory_source"),
    "both Memory tools stay inactive while disabled");
  assert.deepEqual(
    disabledManager.getEntries().slice(0, disabledEntriesBefore.length).map((entry) => JSON.stringify(entry)),
    disabledEntriesBefore,
    "disabling deletes and rewrites nothing in the session file");
  await disabled.session.dispose();
  opened.length = 0;
  process.env.PI_CODING_AGENT_DIR = main.agentDir;

  // ════════════════════════════════════════════════════════════════════
  // §8 Cancellation after recording keeps the real record; restart derives
  //    it. The abort fires from the compact tool-result message_end event.
  // ════════════════════════════════════════════════════════════════════

  const abortEnv = prepareEnvironment({ name: "abort" });
  process.env.PI_CODING_AGENT_DIR = abortEnv.agentDir;
  const abortFaux = createFaux();
  runtime.registerNativeProvider(abortFaux.faux.provider);
  const abortManager = SessionManager.create(abortEnv.cwd, abortEnv.sessionsDir);
  const abortSession = await openSession({ runtime, faux: abortFaux.faux, environment: abortEnv, manager: abortManager });
  let abortOnCompactResult = false;
  const abortUnsubscribe = abortSession.session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "toolResult"
      && event.message.toolName === "compact_to_memory_block" && !abortOnCompactResult) {
      abortOnCompactResult = true;
      void abortSession.session.abort();
    }
  });
  script(({ lastToolName, lastText }) => {
    if (lastToolName === "read" && lastText.includes("FILE-A-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read" && lastText.includes("FILE-B-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "# Abort digest\n\n- recorded before the abort" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
  });
  await prompt(abortSession.session,
    "Read file-a.txt and file-b.txt, then compress the older conversation into one Memory block, then keep working. ");
  abortUnsubscribe();
  assert.ok(abortOnCompactResult, "the abort fired from the compact tool-result event");
  assert.equal(stateEntriesOf(abortManager).length, 1, "the recording before the cancellation is real history");
  assert.match(resultText(compactToolResultsOf(abortManager).at(-1)), /Memory block recorded\./,
    "the interrupted tool result stays the truthful acknowledgement");
  await abortSession.session.dispose();
  opened.length = 0;

  const abortReopen = SessionManager.open(abortManager.getSessionFile(), abortEnv.sessionsDir);
  const abortResumed = await openSession({
    runtime, faux: abortFaux.faux, environment: abortEnv, manager: abortReopen,
    startReason: "resume", previousSessionFile: abortManager.getSessionFile(),
  });
  script(() => fauxAssistantMessage("resumed after the abort", { stopReason: "stop" }));
  await prompt(abortResumed.session, "Acknowledge after the interrupted run. ");
  assert.ok(carrierOf(abortResumed.requests[0].messages),
    "the record survived the cancellation and restart as real Memory");
  assert.equal(stateEntriesOf(abortReopen).length, 1, "the restart neither re-recorded nor rolled back");
  await abortResumed.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §9 Cancellation before the write records nothing and leaves no
  //    poisoned state; racing and duplicate submissions record once.
  // ════════════════════════════════════════════════════════════════════

  const raceEnv = prepareEnvironment({ name: "race" });
  process.env.PI_CODING_AGENT_DIR = raceEnv.agentDir;
  const raceFaux = createFaux();
  runtime.registerNativeProvider(raceFaux.faux.provider);
  const raceManager = SessionManager.create(raceEnv.cwd, raceEnv.sessionsDir);
  const raceSession = await openSession({ runtime, faux: raceFaux.faux, environment: raceEnv, manager: raceManager });
  let turnCount = 0;
  const raceUnsubscribe = raceSession.session.subscribe((event) => {
    if (event.type !== "turn_start") return;
    turnCount += 1;
    if (turnCount === 3) void raceSession.session.abort();
  });
  script(({ lastToolName, lastText }) => {
    if (lastToolName === "read" && lastText.includes("FILE-A-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read" && lastText.includes("FILE-B-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "# Cancelled digest\n\n- CANCELLED-NEEDLE never lands" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
  });
  try {
    await prompt(raceSession.session,
      "Read file-a.txt and file-b.txt, then compress the older conversation into one Memory block. ");
  } catch {
    // Pi may surface the abort as a prompt rejection; the tree assertions
    // below are the contract either way.
  }
  assert.equal(stateEntriesOf(raceManager).length, 0,
    "a cancellation before the write records no Memory");
  assert.equal(compactToolResultsOf(raceManager).length, 0,
    "the cancelled compression call never executed");
  assert.ok(!raceSession.requests.some((request) => request.toolNames.includes("read_memory_source")),
    "no Memory was fabricated from the unrecorded candidate");

  // The same session recovers: recording still works after the cancel.
  script(({ lastToolName, lastText }) => {
    if (lastToolName === "read" && lastText.includes("FILE-C-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "# Race digest\n\n- recorded after recovery" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "compact_to_memory_block") {
      return fauxAssistantMessage("recovered and recorded", { stopReason: "stop" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-c.txt" }), { stopReason: "toolUse" });
  });
  await prompt(raceSession.session,
    "Continue: read file-c.txt, then compress the older conversation into one Memory block. ");
  assert.equal(stateEntriesOf(raceManager).length, 1, "the recovered recording works in the same session");
  assert.ok(raceSession.requests.at(-1).toolNames.includes("read_memory_source"),
    "the reading surface opens after the recovered recording");

  // A same-batch competing submission: two compact calls in one assistant
  // message must both refuse and record nothing.
  let racingSent = false;
  script(() => {
    if (!racingSent) {
      racingSent = true;
      return fauxAssistantMessage([
        fauxToolCall("compact_to_memory_block", { markdown: "# Race one\n\n- first racing candidate" }),
        fauxToolCall("compact_to_memory_block", { markdown: "# Race two\n\n- second racing candidate" }),
      ], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("both racing calls were refused", { stopReason: "stop" });
  });
  await prompt(raceSession.session, "Submit the racing batch now. ");
  const raceResults = compactToolResultsOf(raceManager);
  assert.equal(raceResults.length, 3, "one accepted result plus the two refused racing results");
  for (const refused of raceResults.slice(-2)) {
    assert.match(resultText(refused), /^COMPACT_NOT_SOAL_TOOL: /,
      "a competing same-batch submission refuses with the bounded sole-call code");
    assert.ok(!resultText(refused).includes("Race one"),
      "the refusal never echoes the submitted Markdown");
  }
  assert.equal(stateEntriesOf(raceManager).length, 1, "the racing submissions recorded nothing");

  // An immediate duplicate of an accepted submission records nothing new.
  let duplicateSent = false;
  script(() => {
    if (!duplicateSent) {
      duplicateSent = true;
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "# Race digest\n\n- recorded after recovery" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("the duplicate was refused", { stopReason: "stop" });
  });
  await prompt(raceSession.session, "Submit the exact same compression again. ");
  assert.match(resultText(compactToolResultsOf(raceManager).at(-1)), /^COMPACT_NOT_DUE: /,
    "a repeated submission in the same state finds no uncovered source");
  assert.equal(stateEntriesOf(raceManager).length, 1, "no duplicate recording or overwrite happened");
  raceUnsubscribe();
  await raceSession.session.dispose();
  opened.length = 0;

  // ════════════════════════════════════════════════════════════════════
  // §10 Ephemeral in-memory AgentSession: the same behavior with no file.
  // ════════════════════════════════════════════════════════════════════

  const ephemeralEnv = prepareEnvironment({ name: "ephemeral" });
  process.env.PI_CODING_AGENT_DIR = ephemeralEnv.agentDir;
  const ephemeralFaux = createFaux();
  runtime.registerNativeProvider(ephemeralFaux.faux.provider);
  const ephemeralManager = SessionManager.inMemory(ephemeralEnv.cwd);
  const ephemeralSession = await openSession({ runtime, faux: ephemeralFaux.faux, environment: ephemeralEnv, manager: ephemeralManager });
  script(({ lastToolName, lastText }) => {
    if (lastToolName === "read" && lastText.includes("FILE-A-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read" && lastText.includes("FILE-B-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "# Ephemeral digest\n\n- recorded in memory only" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "compact_to_memory_block") {
      return fauxAssistantMessage("recorded without any file", { stopReason: "stop" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
  });
  await prompt(ephemeralSession.session,
    "Read file-a.txt and file-b.txt, then compress the older conversation into one Memory block. ");
  assert.equal(ephemeralManager.getSessionFile(), undefined, "the ephemeral session wrote no file");
  assert.equal(stateEntriesOf(ephemeralManager).length, 1, "the ephemeral session still records its state entry in memory");
  assert.ok(carrierOf(ephemeralSession.requests.at(-1).messages),
    "the ephemeral session applies the same request projection");
  assert.ok(!existsSync(ephemeralEnv.sessionsDir) || walkFiles(ephemeralEnv.sessionsDir).length === 0,
    "an ephemeral session creates no session directory content");
  await ephemeralSession.session.dispose();
  opened.length = 0;

  console.log("context-memory lifecycle native session: OK");

  // ════════════════════════════════════════════════════════════════════
  // §11 Registrar-level cells: write failures, recorded-versus-applied
  //    across a restart, and observation revalidation after a branch
  //    switch — deterministic through the real registrar seam.
  // ════════════════════════════════════════════════════════════════════

  const { default: registerContextMemoryForHarness } = await load("../../src/context-memory/index.ts");
  const READ_TOOL_RESULT_PADDING = "served evidence that makes the covered read substantial. ".repeat(40);

  function harnessRecording(config, session) {
    const tools = new Map();
    const events = new Map();
    let active = ["read"];
    let appendEntryImpl = (customType, data) => session.appendCustomEntry(customType, data);
    const pi = {
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
      },
      getAllTools() { return [...tools.values()]; },
      getActiveTools() { return [...active]; },
      setActiveTools(names) { active = [...names]; },
      registerMessageRenderer() {},
      appendEntry(customType, data) { appendEntryImpl(customType, data); },
    };
    const registration = registerContextMemoryForHarness(pi, {
      configProvider: () => ({ contextMemory: config }),
      displayRuntimeProvider: () => {
        throw new Error("display runtime is not needed for registrar-level lifecycle cells");
      },
      reserveTokens: () => 16384,
    });
    return {
      tools, registration, activeTools: () => [...active],
      failAppendEntry(message) { appendEntryImpl = () => { throw new Error(message); }; },
      restoreAppendEntry() { appendEntryImpl = (customType, data) => session.appendCustomEntry(customType, data); },
      async emit(name, event, ctx) {
        let last;
        for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
        return last;
      },
    };
  }

  function harnessContext(manager) {
    return {
      cwd: "/project",
      hasUI: false,
      mode: "rpc",
      sessionManager: manager,
      compact() {},
      getContextUsage: () => ({ tokens: 40000, contextWindow: 200000, percent: 20 }),
      getSystemPrompt: () => "",
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => true,
    };
  }

  function seedTwoReadExchanges(manager) {
    manager.appendMessage({ role: "user", content: "EARLY-ANCHOR: brief me on the workspace first.", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reading the entry points" }, { type: "toolCall", id: "h:read-1", name: "read", arguments: { path: "a.txt" } }],
      stopReason: "toolUse", timestamp: 2,
    });
    const firstEnd = manager.appendMessage({
      role: "toolResult", toolCallId: "h:read-1", toolName: "read",
      content: [{ type: "text", text: `EVIDENCE-A ${READ_TOOL_RESULT_PADDING}` }], isError: false, timestamp: 3,
    });
    const secondUser = manager.appendMessage({ role: "user", content: "PROTECTED-ANCHOR: keep this instruction verbatim.", timestamp: 4 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "checking the login flow too" }, { type: "toolCall", id: "h:read-2", name: "read", arguments: { path: "b.txt" } }],
      stopReason: "toolUse", timestamp: 5,
    });
    const anchor = manager.appendMessage({
      role: "toolResult", toolCallId: "h:read-2", toolName: "read",
      content: [{ type: "text", text: `EVIDENCE-B ${READ_TOOL_RESULT_PADDING}` }], isError: false, timestamp: 6,
    });
    return { firstEnd, secondUser, anchor };
  }

  async function serveAndNote(harness, manager, ctx, callId, markdown) {
    await harness.emit("context", { type: "context", messages: manager.buildSessionContext().messages }, ctx);
    await harness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "compact_to_memory_block", arguments: { markdown } }] },
    }, ctx);
  }

  const HARNESS_CONFIG = { enabled: true, compressionThreshold: { tokens: 2500 }, memoryBudgetPercent: 1 };
  const FIRST_BODY = "# First digest\n\n- the entry points and login flow";
  const SECOND_BODY = "# Second digest\n\n- the queued verification work";

  // (r1) A write failure before recording changes nothing; recovery records;
  //      a later failure over existing Memory keeps the previous state whole.
  {
    const manager = SessionManager.inMemory("/project");
    seedTwoReadExchanges(manager);
    const harness = harnessRecording(HARNESS_CONFIG, manager);
    const ctx = harnessContext(manager);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    harness.failAppendEntry("simulated session write failure");
    await serveAndNote(harness, manager, ctx, "h:compact-1", FIRST_BODY);
    await assert.rejects(
      () => harness.tools.get("compact_to_memory_block").execute("h:compact-1", { markdown: FIRST_BODY }, undefined, undefined, ctx),
      /simulated session write failure/,
      "a recording that cannot write fails the tool call");
    assert.equal(stateEntriesOf(manager).length, 0, "the failed write recorded no state entry");
    assert.equal(harness.registration.snapshot().state, "no-memory",
      "a write failure before recording changes the effective Memory");

    harness.restoreAppendEntry();
    await harness.tools.get("compact_to_memory_block").execute("h:compact-1", { markdown: FIRST_BODY }, undefined, undefined, ctx);
    assert.equal(stateEntriesOf(manager).length, 1, "the same source records once the write path works again");

    manager.appendMessage({ role: "user", content: "queued verification pass", timestamp: 7 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "h:read-3", name: "read", arguments: { path: "c.txt" } }],
      stopReason: "toolUse", timestamp: 8,
    });
    manager.appendMessage({
      role: "toolResult", toolCallId: "h:read-3", toolName: "read",
      content: [{ type: "text", text: `EVIDENCE-C ${READ_TOOL_RESULT_PADDING}` }], isError: false, timestamp: 9,
    });
    harness.failAppendEntry("second simulated write failure");
    await serveAndNote(harness, manager, ctx, "h:compact-2", SECOND_BODY);
    await assert.rejects(
      () => harness.tools.get("compact_to_memory_block").execute("h:compact-2", { markdown: SECOND_BODY }, undefined, undefined, ctx),
      /second simulated write failure/,
    );
    assert.equal(stateEntriesOf(manager).length, 1, "the later failure records nothing new");
    const kept = harness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
    assert.equal(kept.blocks, 1, "the previously recorded Memory survives the failure unchanged");
    const projected = await harness.emit("context", { type: "context", messages: manager.buildSessionContext().messages }, ctx);
    assert.ok(JSON.stringify(projected.messages).includes("First digest"),
      "the projection still applies the intact recorded Memory");
  }

  // (r2) A restart never claims the recorded Memory was already applied.
  {
    const manager = SessionManager.inMemory("/project");
    seedTwoReadExchanges(manager);
    const harness = harnessRecording(HARNESS_CONFIG, manager);
    const ctx = harnessContext(manager);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveAndNote(harness, manager, ctx, "h:compact-3", FIRST_BODY);
    await harness.tools.get("compact_to_memory_block").execute("h:compact-3", { markdown: FIRST_BODY }, undefined, undefined, ctx);
    assert.equal(harness.registration.snapshot({ tokens: 900, contextWindow: 200000 }).applied, false,
      "recording never claims an already-carried request");

    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const recovered = harness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
    assert.equal(recovered.state, "active", "the record survives as real Memory");
    assert.equal(recovered.applied, false,
      "recovery re-validates instead of treating history as applied to this session's requests");
    const applied = await harness.emit("context", { type: "context", messages: manager.buildSessionContext().messages }, ctx);
    assert.ok(JSON.stringify(applied.messages).includes("First digest"), "the first request applies the carrier");
    assert.equal(harness.registration.snapshot({ tokens: 900, contextWindow: 200000 }).applied, true,
      "only the actually-carried request marks the Memory applied");
  }

  // (r3) A branch switch invalidates the stale observation until a real
  //      request re-observes the new branch.
  {
    const manager = SessionManager.inMemory("/project");
    const seed = seedTwoReadExchanges(manager);
    manager.appendMessage({ role: "user", content: "queued verification pass", timestamp: 7 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "h:read-3", name: "read", arguments: { path: "c.txt" } }],
      stopReason: "toolUse", timestamp: 8,
    });
    manager.appendMessage({
      role: "toolResult", toolCallId: "h:read-3", toolName: "read",
      content: [{ type: "text", text: `EVIDENCE-C ${READ_TOOL_RESULT_PADDING}` }], isError: false, timestamp: 9,
    });
    const harness = harnessRecording(HARNESS_CONFIG, manager);
    const ctx = harnessContext(manager);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveAndNote(harness, manager, ctx, "h:compact-4", FIRST_BODY);
    await harness.tools.get("compact_to_memory_block").execute("h:compact-4", { markdown: FIRST_BODY }, undefined, undefined, ctx);
    assert.equal(stateEntriesOf(manager).length, 1);
    // The observation boundary now sits on the recorded leaf.
    await harness.emit("context", { type: "context", messages: manager.buildSessionContext().messages }, ctx);

    manager.branch(seed.anchor);
    await harness.emit("session_tree", { type: "session_tree", newLeafId: seed.anchor, oldLeafId: manager.getBranch().at(-1).id }, ctx);
    await harness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "h:compact-5", name: "compact_to_memory_block", arguments: { markdown: SECOND_BODY } }] },
    }, ctx);
    await assert.rejects(
      () => harness.tools.get("compact_to_memory_block").execute("h:compact-5", { markdown: SECOND_BODY }, undefined, undefined, ctx),
      /SOURCE_NOT_SERVED: /,
      "a compression after a branch switch refuses until a real request re-observes the new branch");
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE).length, 1,
      "the stale-observation refusal records nothing");

    await serveAndNote(harness, manager, ctx, "h:compact-6", SECOND_BODY);
    await harness.tools.get("compact_to_memory_block").execute("h:compact-6", { markdown: SECOND_BODY }, undefined, undefined, ctx);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE).length, 2,
      "acceptance works again after the new branch is served");
    assert.equal(harness.registration.snapshot({ tokens: 900, contextWindow: 200000 }).blocks, 1,
      "the switched branch derives its own Memory, not the abandoned branch's record");
  }
  // (r4) An unanswered protocol call from an interrupted or branch-cut batch
  //      never blocks a later append, while an unanswered ordinary call still
  //      refuses (the #319 orphan contract, contrasted in compact.test.mjs).
  {
    const protocolOrphan = SessionManager.inMemory("/project");
    const protocolSeed = seedTwoReadExchanges(protocolOrphan);
    // Simulate the branch cut at the recorded state entry: the compression
    // call is on the branch, its result is not.
    protocolOrphan.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "h:cut-compact", name: "compact_to_memory_block", arguments: { markdown: "# Cut digest" } }],
      stopReason: "toolUse", timestamp: 7,
    });
    protocolOrphan.appendMessage({ role: "user", content: "continue after the cut", timestamp: 8 });
    protocolOrphan.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "h:read-4", name: "read", arguments: { path: "d.txt" } }],
      stopReason: "toolUse", timestamp: 9,
    });
    protocolOrphan.appendMessage({
      role: "toolResult", toolCallId: "h:read-4", toolName: "read",
      content: [{ type: "text", text: `EVIDENCE-D ${READ_TOOL_RESULT_PADDING}` }], isError: false, timestamp: 10,
    });
    const protocolHarness = harnessRecording(HARNESS_CONFIG, protocolOrphan);
    const protocolCtx = harnessContext(protocolOrphan);
    await protocolHarness.emit("session_start", { type: "session_start", reason: "startup" }, protocolCtx);
    await serveAndNote(protocolHarness, protocolOrphan, protocolCtx, "h:compact-7", FIRST_BODY);
    const accepted = await protocolHarness.tools.get("compact_to_memory_block").execute(
      "h:compact-7", { markdown: FIRST_BODY }, undefined, undefined, protocolCtx,
    );
    assert.equal(accepted.details.recorded, true,
      "an unanswered protocol call inside the covered range no longer blocks the append");
    assert.equal(protocolOrphan.getBranch().at(-1).type, "custom",
      "the append recorded over the interrupted protocol batch");

    const ordinaryOrphan = SessionManager.inMemory("/project");
    const ordinarySeed = seedTwoReadExchanges(ordinaryOrphan);
    ordinaryOrphan.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "h:orphan-read", name: "read", arguments: { path: "e.txt" } }],
      stopReason: "toolUse", timestamp: 7,
    });
    ordinaryOrphan.appendMessage({ role: "user", content: "continue after the abort", timestamp: 8 });
    ordinaryOrphan.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "h:read-5", name: "read", arguments: { path: "f.txt" } }],
      stopReason: "toolUse", timestamp: 9,
    });
    ordinaryOrphan.appendMessage({
      role: "toolResult", toolCallId: "h:read-5", toolName: "read",
      content: [{ type: "text", text: `EVIDENCE-F ${READ_TOOL_RESULT_PADDING}` }], isError: false, timestamp: 10,
    });
    const ordinaryHarness = harnessRecording(HARNESS_CONFIG, ordinaryOrphan);
    const ordinaryCtx = harnessContext(ordinaryOrphan);
    await ordinaryHarness.emit("session_start", { type: "session_start", reason: "startup" }, ordinaryCtx);
    await serveAndNote(ordinaryHarness, ordinaryOrphan, ordinaryCtx, "h:compact-8", FIRST_BODY);
    await assert.rejects(
      () => ordinaryHarness.tools.get("compact_to_memory_block").execute("h:compact-8", { markdown: FIRST_BODY }, undefined, undefined, ordinaryCtx),
      /COMPACT_NOT_DUE: /,
      "an unanswered ordinary call inside the covered range still refuses");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const handle of opened) {
    try {
      handle.session.dispose();
    } catch {
      // disposal races are irrelevant to the contract under test
    }
  }
  scriptNext = null;
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const root of environments) rmSync(root, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
