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
const { CONTEXT_MEMORY_ADVISORY_TYPE, CONTEXT_MEMORY_BLOCKS_TYPE } = await load("../../src/context-memory/view.ts");

/**
 * #320 mechanical acceptance: one long task through a real Pi `AgentSession`
 * and a deterministic faux provider, with exactly one real user input. The
 * model does ordinary tool work while the maintenance advisory rides requests
 * without accumulating, defers its first compression, keeps working, submits
 * a second compression later in the same run, and both net reductions appear
 * at their own next model request — no settle, no abort, no restart, no extra
 * wake. The pinned sources stay fixed: work completed after the advisory
 * appears stays uncompressed until the next maintenance request, the latest
 * user instruction stays raw throughout, and the completed old tool rounds
 * leave through their own accepted blocks.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 1_200;
const MEMORY_BUDGET_PERCENT = 2;

const KEY_FACT_ONE = "The vault access code for the first archive is MARS-ROVER-77.";
const KEY_FACT_TWO = "The second archive unlocks with the tide table ORION-ECHO-31.";
const MEMORY_MARKDOWN_ONE = [
  "# Research digest one",
  "",
  "The first three workspace reads established the build entry point, the",
  "login flow, and the footer contract. The vault access code recorded from",
  `that phase is: ${KEY_FACT_ONE}`,
  "Ordinary padding detail keeps this body a realistic single block.",
].join("\n");
const MEMORY_MARKDOWN_TWO = [
  "# Research digest two",
  "",
  "The post-compression read established the theme pair calibration. The",
  `second archive fact recorded from that phase is: ${KEY_FACT_TWO}`,
  "Ordinary padding detail keeps this body a realistic single block too.",
].join("\n");

const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(20);
const WORK_FILES = {
  "file-a.txt": `FILE-A-NEEDLE: the build entry point is src/index.ts and it registers every feature module.\n${FILLER}\n`,
  "file-b.txt": `FILE-B-NEEDLE: the login flow sets the session cookie only after the redirect completes.\n${FILLER}\n`,
  "file-c.txt": `FILE-C-NEEDLE: the footer derives usage directly from the read-only context each render.\n${FILLER}\n`,
  "file-d.txt": `FILE-D-NEEDLE: the theme pair ships two independently calibrated palettes.\n${FILLER}\n`,
  "file-e.txt": `FILE-E-NEEDLE: the settings loader merges agent layers over package defaults.\n${FILLER}\n`,
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
  const root = mkdtempSync(join(tmpdir(), "pi-square-sustained-maintenance-"));
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
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  for (const [name, content] of Object.entries(WORK_FILES)) {
    writeFileSync(join(cwd, name), content);
  }
  return { root, agentDir, cwd };
}

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-sustained-runtime-"));
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
    provider: "sustained-maintenance-test",
    api: "sustained-maintenance-test",
    models: [{ id: "sustained-maintenance", contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }],
  });
  runtime.registerNativeProvider(faux.provider);

  /** Every real provider request, in order, after Pi's own conversion. */
  const requests = [];
  const compactionEvents = [];
  const abortedStops = [];
  let stage = "start"; // start → due-seen → compacted-one → compacted-two

  faux.setResponses(Array.from({ length: 40 }, () => (context) => {
    requests.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    });
    const text = requestText(context.messages);
    const advisoryDue = text.includes("compression is due");
    const last = context.messages.at(-1);
    const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;
    const lastText = messageText(last);

    if (stage === "start") {
      // Ordinary work first: reads a, b, c, d — the advisory must ride these
      // requests without the model compressing yet (deferred submission).
      if (lastToolName === "read" && lastText.includes("FILE-A-NEEDLE")) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && lastText.includes("FILE-B-NEEDLE")) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-c.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && lastText.includes("FILE-C-NEEDLE")) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-d.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && lastText.includes("FILE-D-NEEDLE") && advisoryDue) {
        stage = "compacted-one";
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN_ONE }),
          { stopReason: "toolUse" },
        );
      }
      // Before the advisory appears the model keeps working but must not be
      // prompted to compress by anything other than the advisory itself.
      if (lastToolName === "read" && lastText.includes("FILE-D-NEEDLE")) {
        return fauxAssistantMessage("waiting for the compression advisory", { stopReason: "stop" });
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
    }

    if (stage === "compacted-one") {
      // Post-compression ordinary work continues; the second compression is
      // deferred again until real growth re-triggers the advisory.
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-e.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && lastText.includes("FILE-E-NEEDLE") && advisoryDue) {
        stage = "compacted-two";
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN_TWO }),
          { stopReason: "toolUse" },
        );
      }
      if (lastToolName === "read" && lastText.includes("FILE-E-NEEDLE")) {
        return fauxAssistantMessage("waiting for the second compression advisory", { stopReason: "stop" });
      }
      return fauxAssistantMessage("idle continuation", { stopReason: "stop" });
    }

    // Both compressions recorded: answer with one fact only the first block
    // carries and one fact only the second block's sources carried.
    return fauxAssistantMessage(
      text.includes(KEY_FACT_ONE) && text.includes(KEY_FACT_TWO)
        ? `Task complete. ${KEY_FACT_ONE} ${KEY_FACT_TWO}`
        : "Task complete, but a key fact is MISSING from my context.",
      { stopReason: "stop" },
    );
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
    "Research this workspace and finish one long task.",
    "Read file-a.txt, file-b.txt, file-c.txt, and file-d.txt completely, then",
    "compress what you learned when the maintenance advisory appears, keep",
    "working through file-e.txt, compress again when invited, and answer with",
    "both archive access facts you recorded. Required planning context that",
    "must stay present throughout the task:",
    "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet-kilo.",
  ].join("\n");

  await session.prompt(taskPrompt, { source: "interactive", expandPromptTemplates: false });

  // ── One ordinary task: no settle tricks, no aborts, one user input ──
  assert.equal(compactionEvents.length, 0, "neither in-task compression triggers native compaction");
  assert.equal(abortedStops.length, 0, "the run never aborts or restarts");
  const branch = sessionManager.getBranch();
  const userEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(userEntries.length, 1, "exactly one real user input drives the whole task");
  const finalAnswer = branch
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => messageText(entry.message))
    .findLast(() => true);
  assert.match(finalAnswer, /MARS-ROVER-77/, "the final answer carries the first block's key fact");
  assert.match(finalAnswer, /ORION-ECHO-31/, "the final answer carries the second block's key fact");
  assert.doesNotMatch(finalAnswer, /MISSING/, "both facts reached the provider requests through the carriers");

  // ── Two recorded state entries, byte-stable first block, fixed sources ──
  const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
  assert.equal(stateEntries.length, 2, "two Memory state entries record the two in-task compressions");
  const entryIdByNeedle = (needle) => branch.find((entry) =>
    entry.type === "message" && entry.message.role === "toolResult"
    && messageText(entry.message).includes(needle))?.id;
  const readCResult = entryIdByNeedle("FILE-C-NEEDLE");
  const readDResult = entryIdByNeedle("FILE-D-NEEDLE");
  const first = stateEntries[0].data;
  const second = stateEntries[1].data;
  assert.equal(first.blocks.length, 1);
  assert.equal(first.blocks[0].markdown, MEMORY_MARKDOWN_ONE, "block one records byte-exact");
  // Source fixity (#320): the advisory appeared before the file-d read was
  // answered, so the pinned range ends at the read-c result — post-advisory
  // work never silently expands the first request's coverage.
  assert.equal(first.blocks[0].endEntryId, readCResult,
    "block one's range ends before the post-advisory read-d work");
  assert.deepEqual(first.blocks[0].retainedEntryIds, [userEntries[0].id],
    "the latest user instruction stays a retained exception");
  assert.equal(second.blocks.length, 2, "the second compression appends, not rewrites");
  assert.equal(second.blocks[0].markdown, MEMORY_MARKDOWN_ONE, "the unchanged prefix stays byte-identical");
  assert.equal(second.blocks[0].endEntryId, first.blocks[0].endEntryId, "the prefix keeps its end");
  assert.equal(second.blocks[1].markdown, MEMORY_MARKDOWN_TWO, "block two records byte-exact");
  assert.equal(second.blocks[1].endEntryId, readDResult,
    "block two covers the post-advisory read-d work that block one left raw");
  assert.deepEqual(second.blocks[1].retainedEntryIds, [], "no user instruction falls inside block two's range");

  // ── Advisory discipline: one instance per due request, no accumulation ──
  assert.ok(requests.length >= 8, `the run produced several provider requests (got ${requests.length})`);
  const advisoryCounts = requests.map((request) =>
    request.messages.filter((message) => messageText(message).includes("compression is due")).length);
  assert.ok(advisoryCounts.every((count) => count <= 1), "no request ever carries more than one advisory instance");
  const firstCompactCall = requests.findIndex((request) =>
    request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block")));
  assert.ok(firstCompactCall > 0, "a provider request carries the first compression call");
  const advisoryBeforeFirst = advisoryCounts.slice(0, firstCompactCall);
  const lastThree = advisoryBeforeFirst.slice(-3);
  assert.deepEqual(lastThree, [1, 1, 1],
    "the advisory stays visible across at least three consecutive ordinary tool requests");
  assert.ok(advisoryBeforeFirst.slice(0, -3).every((count) => count === 0),
    "the advisory starts only when the projected request reaches the threshold");
  const advisoryTexts = requests.flatMap((request) =>
    request.messages
      .filter((message) => messageText(message).includes("compression is due"))
      .map((message) => messageText(message)));
  assert.ok(advisoryTexts.length > 0 && advisoryTexts.every((text) => text === advisoryTexts[0]),
    "the advisory content stays fixed across requests");
  assert.equal(advisoryCounts[firstCompactCall], 0,
    "the completed request's advisory is removed once the recorded Memory relieves the pressure");
  const secondCompactCall = requests.findIndex((request, index) => index > firstCompactCall
    && request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block")));
  assert.ok(secondCompactCall > firstCompactCall, "a later request carries the second compression call");
  assert.equal(advisoryCounts[secondCompactCall - 1], 1,
    "real growth in the same task re-triggers the advisory without any user input");
  assert.equal(branch.filter((entry) => entry.type === "custom_message"
    && entry.customType === CONTEXT_MEMORY_ADVISORY_TYPE).length, 0,
    "the advisory never accumulates into the session transcript");

  // ── Tool set stability across the whole sustained cycle ──
  const baselineTools = requests[0].toolNames
    .filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
  for (const [index, request] of requests.entries()) {
    assert.ok(request.toolNames.includes("compact_to_memory_block"),
      `the resident compression tool is exposed in request ${index}`);
    assert.ok(!request.toolNames.includes("submit_memory"), "the retired name never appears");
    const others = request.toolNames
      .filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
    assert.deepEqual(others, baselineTools, `no other tool changes around either compression (request ${index})`);
  }

  // ── Both net reductions land at their own next request ──
  const carrierRequests = requests
    .map((request, index) => ({ request, index }))
    .filter(({ request }) => request.messages.some((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER)));
  assert.equal(carrierRequests.length, requests.length - carrierRequests[0].index,
    "every request from the first application on carries the Memory carrier");
  const firstApplied = carrierRequests[0];
  const secondApplied = carrierRequests.find(({ index }) => index >= secondCompactCall);
  assert.ok(firstApplied && secondApplied, "the carrier enters after each accepted compression");
  assert.ok(estimateTokens(firstApplied.request.messages) < estimateTokens(requests[firstApplied.index - 1].messages),
    "the first applied request is smaller than the due request that preceded it");
  assert.ok(estimateTokens(secondApplied.request.messages) < estimateTokens(requests[secondApplied.index - 1].messages),
    "the second applied request is smaller than its due request");
  const firstAppliedText = requestText(firstApplied.request.messages);
  for (const needle of ["FILE-A-NEEDLE", "FILE-B-NEEDLE", "FILE-C-NEEDLE"]) {
    assert.ok(!firstAppliedText.includes(needle), `the completed old tool round left the applied request (${needle})`);
  }
  assert.ok(firstAppliedText.includes("FILE-D-NEEDLE"),
    "post-advisory work stays uncompressed in the first applied request — the pinned range did not silently grow");
  assert.ok(firstAppliedText.includes("Research this workspace"),
    "the latest user instruction stays raw in the applied request");
  assert.ok(firstAppliedText.includes(KEY_FACT_ONE), "the first block's key fact enters the request whole");
  const secondAppliedText = requestText(secondApplied.request.messages);
  assert.ok(!secondAppliedText.includes("FILE-D-NEEDLE"),
    "the read-d round leaves only through the second accepted block");
  assert.ok(secondAppliedText.includes(KEY_FACT_ONE) && secondAppliedText.includes(KEY_FACT_TWO),
    "both block bodies are carried complete after the second compression");
  const carrier = secondApplied.request.messages
    .find((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
  const carrierParts = carrier.content.filter((part) => part?.type === "text").map((part) => part.text);
  assert.equal(carrierParts[0], MEMORY_SUMMARY_WRAPPER, "the carrier opens with the fixed wrapper");
  assert.equal(carrierParts[1], `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`, "block one's part is byte-exact");
  assert.equal(carrierParts[2], `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_TWO}`, "block two's part is byte-exact");
  assert.ok(!JSON.stringify(secondApplied.request.messages).includes("cache_control"),
    "the carrier adds no provider cache field or breakpoint");
  console.log("context-memory sustained maintenance native session: OK");
} finally {
  unsubscribe?.();
  await session?.dispose();
  if (environment) rmSync(environment.root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
