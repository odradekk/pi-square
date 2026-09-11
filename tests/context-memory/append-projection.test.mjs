import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE } = await load("../../src/context-memory/format.ts");
const { MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR } = await load("../../src/context-memory/format.ts");

/**
 * #319 mechanical acceptance: one full user task through a real Pi
 * `AgentSession` and a deterministic faux provider. The model does ordinary
 * tool work first, records one Memory block through the resident
 * `compact_to_memory_block`, keeps working in the same run, and reads the
 * original source back — with the provider request as the acceptance seam:
 * the complete summary enters exactly once, the covered originals leave, the
 * tool arguments never duplicate the body, and the next request shrinks with
 * no settle, abort, or native compaction anywhere.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 500;
const MEMORY_BUDGET_PERCENT = 1;

/**
 * The block body exceeds 200 characters with the key fact at its very end,
 * while the rendered one-block Memory stays below half of the 1% budget —
 * this suite pins the append path; #321's suffix rebuild has its own suites.
 */
const KEY_FACT = "The access code for the vault is MARS-ROVER-77.";
const MEMORY_MARKDOWN = [
  "# Task research digest",
  "",
  "The repository tour covered the build entry points and the login flow.",
  "The first two reads established the workspace layout facts that later",
  "steps depend on, including the fixture filenames. Padding notes follow",
  "so the block clears the length bound that guarantees a complete",
  "carrier matters.",
  "",
  KEY_FACT,
].join("\n");

const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(14);
const WORK_FILES = {
  "file-a.txt": `FILE-A-NEEDLE: the build entry point is src/index.ts and it registers every feature module.\n${FILLER}\n`,
  "file-b.txt": `FILE-B-NEEDLE: the login flow sets the session cookie only after the redirect completes.\n${FILLER}\n`,
  "file-c.txt": `FILE-C-NEEDLE: the footer derives usage directly from the read-only context each render.\n${FILLER}\n`,
  "file-d.txt": `FILE-D-NEEDLE: the theme pair ships two independently calibrated palettes.\n${FILLER}\n`,
};

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function prepareEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "pi-square-append-projection-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: {
      enabled: true,
      compressionThreshold: { tokens: COMPRESSION_THRESHOLD_TOKENS },
      memoryBudgetPercent: MEMORY_BUDGET_PERCENT,
    },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [{ source: packageRoot }],
    quietStartup: true,
    // Native auto-compaction stays out of the way; the custom projection
    // owns the in-task boundary for this run.
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  for (const [name, content] of Object.entries(WORK_FILES)) {
    writeFileSync(join(cwd, name), content);
  }
  return { root, agentDir, cwd };
}

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-append-runtime-"));
writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

let environment;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let session;
let unsubscribe;
try {
  environment = prepareEnvironment();
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "append-projection-test",
    api: "append-projection-test",
    models: [{ id: "append-projection", contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }],
  });
  runtime.registerNativeProvider(faux.provider);

  /** Every real provider request, in order, after Pi's own conversion. */
  const requests = [];
  const compactionEvents = [];
  const abortedStops = [];
  let compacted = false;
  let ordinaryReads = 0;
  let sourceRead = false;

  faux.setResponses(Array.from({ length: 40 }, () => (context) => {
    requests.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    });
    const text = requestText(context.messages);
    const last = context.messages.at(-1);
    const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;

    // Post-compression: ordinary work continues, then the original source is
    // recovered through the reading tool, then the run answers the user with
    // the fact only the Memory carrier can carry.
    if (compacted) {
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-d.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && messageText(last).includes("FILE-D-NEEDLE")) {
        return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 1, page: 1 }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read_memory_source") {
        sourceRead = true;
        return fauxAssistantMessage(
          text.includes(KEY_FACT)
            ? `Task complete. ${KEY_FACT} The third read also confirmed the footer contract.`
            : "Task complete, but the key fact is MISSING from my context.",
          { stopReason: "stop" },
        );
      }
      return fauxAssistantMessage("idle continuation", { stopReason: "stop" });
    }

    // Ordinary work first: two reads before any compression (#319).
    if (lastToolName === "read" && messageText(last).includes("FILE-A-NEEDLE")) {
      ordinaryReads += 1;
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read" && messageText(last).includes("FILE-B-NEEDLE")) {
      ordinaryReads += 1;
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-c.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read" && messageText(last).includes("FILE-C-NEEDLE")) {
      ordinaryReads += 1;
      if (text.includes("compression is due")) {
        compacted = true;
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("waiting for the compression advisory", { stopReason: "stop" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
  }));

  const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, noSkills: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(environment.cwd, join(environment.root, "sessions"));
  ({ session } = await createAgentSession({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
    modelRuntime: runtime,
    model: faux.getModel(),
    thinkingLevel: "off",
    initialActiveToolNames: ["read", "bash", "edit", "write"],
  }));
  await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
  const loadedErrors = resourceLoader.getExtensions().errors;
  assert.equal(loadedErrors.length, 0, "pi-square must load without extension errors");

  unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") {
      abortedStops.push(event.message);
    }
  });

  const taskPrompt = [
    "Research this workspace and finish one task.",
    "First read file-a.txt and file-b.txt completely, then compress what you",
    "learned with compact_to_memory_block, then read file-d.txt, verify the",
    "first read's original conversation through read_memory_source, and answer",
    "with the vault access fact you placed in the Memory block. ",
    "Required planning context that must stay present throughout the task: ",
    "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet-kilo. ",
  ].join("\n").repeat(2);

  await session.prompt(taskPrompt, { source: "interactive", expandPromptTemplates: false });

  // ── The run finished as one ordinary task: no settle tricks, no aborts ──
  assert.equal(compactionEvents.length, 0, "the in-task compression never triggers native compaction");
  assert.equal(abortedStops.length, 0, "the run never aborts or restarts");
  assert.equal(ordinaryReads, 3, "the model completed both ordinary reads before compressing");
  assert.ok(compacted, "the model recorded a Memory block mid-task");
  assert.ok(sourceRead, "the model recovered the original source after compressing");
  const finalAnswer = sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => messageText(entry.message))
    .findLast(() => true);
  assert.match(finalAnswer, /MARS-ROVER-77/, "the final answer carries the key fact the carrier delivered");
  assert.doesNotMatch(finalAnswer, /MISSING/, "the key fact reached the provider request, not just the tool call");

  // ── Session tree: one versioned state entry, zero compactions ──
  const branch = sessionManager.getBranch();
  const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
  assert.equal(stateEntries.length, 1, "exactly one Memory state entry is recorded");
  assert.equal(branch.filter((entry) => entry.type === "compaction").length, 0,
    "SessionManager holds the only write path and no compaction carries the Memory");
  assert.equal(stateEntries[0].data.format, "pi-square.context-memory/2");
  assert.equal(stateEntries[0].data.blocks.length, 1);
  assert.equal(stateEntries[0].data.blocks[0].markdown, MEMORY_MARKDOWN);
  const compactResults = branch.filter((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "compact_to_memory_block");
  assert.equal(compactResults.length, 1, "one compression tool result exists");
  assert.match(compactResults[0].message.content[0].text, /Memory block recorded\./,
    "the tool result reports recorded, never claims an already-applied request");

  // ── Tool set regression: resident tool, no alias, others untouched ──
  assert.ok(requests.length >= 6, `the run produced several provider requests (got ${requests.length})`);
  const baselineTools = requests[0].toolNames.filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
  for (const [index, request] of requests.entries()) {
    assert.ok(request.toolNames.includes("compact_to_memory_block"),
      `the resident compression tool is exposed in request ${index}`);
    assert.ok(!request.toolNames.includes("submit_memory"), "the retired name never appears");
    const others = request.toolNames.filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
    assert.deepEqual(others, baselineTools,
      `no other tool is removed or added around the compression (request ${index})`);
  }

  // ── The advisory rides due requests once each and clears after relief ──
  const advisoryCounts = requests.map((request) =>
    request.messages.filter((message) => messageText(message).includes("compression is due")).length);
  assert.ok(advisoryCounts.every((count) => count <= 1),
    "no request ever carries more than one advisory instance");
  const compactCallIndex = requests.findIndex((request) =>
    request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block")));
  assert.ok(compactCallIndex > 0, "a provider request carries the compression call");
  assert.equal(advisoryCounts[compactCallIndex - 1], 1,
    "the request that prompted the block carries the advisory");
  assert.ok(advisoryCounts.slice(0, compactCallIndex).some((count) => count === 1),
    "the advisory persisted across earlier ordinary requests");
  assert.equal(advisoryCounts[compactCallIndex], 0,
    "the completed request's advisory clears once the recorded Memory relieves the pressure");
  assert.ok(advisoryCounts.slice(compactCallIndex + 1).every((count) => count <= 1),
    "later requests re-arm at most one sustained-maintenance advisory from real growth (#320)");

  // ── The acceptance seam: the request that follows the recorded block ──
  const appliedIndex = requests.findIndex((request) =>
    request.messages.some((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER)));
  assert.ok(appliedIndex > 0, "a provider request carries the Memory carrier");
  const applied = requests[appliedIndex];
  const appliedText = requestText(applied.messages);
  assert.equal(appliedText.split(KEY_FACT).length - 1, 1,
    "the complete summary body appears exactly once in the applied request");
  assert.ok(appliedText.includes(KEY_FACT), "the key fact at the body's end survives whole — no truncation");
  const carrierMessage = applied.messages.find((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
  const carrierParts = carrierMessage.content.filter((part) => part?.type === "text").map((part) => part.text);
  assert.equal(carrierParts[0], MEMORY_SUMMARY_WRAPPER, "the carrier opens with the fixed wrapper");
  assert.equal(carrierParts[1], `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN}`, "the block is one byte-exact part");
  assert.ok(!JSON.stringify(applied.messages).includes("cache_control"),
    "the carrier adds no provider cache field or breakpoint");
  assert.ok(!appliedText.includes("FILE-A-NEEDLE") && !appliedText.includes("FILE-B-NEEDLE"),
    "the covered original sources left the applied request");
  assert.ok(appliedText.includes("Research this workspace"),
    "the latest user instruction stays raw in the applied request");
  const compactCalls = applied.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content.filter((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block"));
  assert.equal(compactCalls.length, 1, "the trailing compact pair survives whole for the provider contract");
  assert.equal(compactCalls[0].arguments.markdown, "(this Memory block is carried in full above)",
    "the tool arguments no longer duplicate the carried body");

  // ── Source recovery: the reading tool restored the first block's original ──
  const sourceResults = branch.filter((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read_memory_source");
  assert.equal(sourceResults.length, 1);
  assert.match(messageText(sourceResults[0].message), /FILE-A-NEEDLE/,
    "the original first read is recoverable through the bounded source tool");
  assert.match(sourceResults[0].message.content[0].text, /^Memory source · block 1 of 1 · page 1 of \d+$/);

  // ── Net shrink at the request exit, without any settle ──
  const dueRequest = requests[appliedIndex - 1];
  assert.ok(requestText(dueRequest.messages).includes("FILE-A-NEEDLE"),
    "the request before acceptance still carried the original sources");
  assert.ok(estimateTokens(applied.messages) < estimateTokens(dueRequest.messages),
    "the applied request is smaller than the due request that preceded it");
  const afterWork = requests.at(-1);
  assert.ok(requestText(afterWork.messages).includes("FILE-D-NEEDLE"),
    "post-compression ordinary work proceeds and stays visible");
  assert.ok(requestText(afterWork.messages).includes(MEMORY_SUMMARY_WRAPPER),
    "the carrier stays in every later request of the run");
  console.log("context-memory append projection native session: OK");
} finally {
  unsubscribe?.();
  await session?.dispose();
  if (environment) rmSync(environment.root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
