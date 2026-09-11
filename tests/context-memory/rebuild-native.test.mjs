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
 * #321 mechanical acceptance: one real Pi `AgentSession` and a deterministic
 * faux provider drive ONE user input through append → deferred suffix
 * rebuild → ordinary tool continuation (no second prompt, no new user
 * message, no extension-generated wake) → append → second deferred rebuild →
 * the task's final answer, observed only at the provider request exit. Two
 * further prompts keep the adjacent guarantees without being counted as the
 * single-input evidence: a follow-up user instruction that crosses into a
 * third rebuild's covered range (the protection zone moves; the instruction
 * stays a retained exception, raw throughout), and post-completion source
 * recovery through `read_memory_source`. For every pending phase the
 * complete suffix originals stay visible while their summaries are absent,
 * the unselected prefix is byte-stable across all rebuilds, the covered
 * originals leave exactly at the next request, and each acceptance's next
 * request is a net reduction.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 1_200;
const MEMORY_BUDGET_PERCENT = 2;

const REBUILD_ADVISORY_NEEDLE = "rebuilds the newest Memory suffix";
const PLANNING_MARKER = "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet-kilo";
const FOLLOWUP_MARKER = "FOLLOW-UP-INSTRUCTION";
const VERIFY_MARKER = "VERIFY-INSTRUCTION";

/** Key facts sit at the very end of each block body: a complete carrier matters. */
const FACT_ONE = "The first archive code is MARS-ROVER-77.";
const FACT_TWO = "The second archive code is ORION-ECHO-31.";
const FACT_THREE = "The third archive code is LUNA-TANGO-42.";
const FACT_FOUR = "The fourth archive code is VEGA-SIGNAL-90.";

/**
 * Sized so the single user task alternates exactly as the ticket describes:
 * within one run — two appends cross half the 2% budget, the first rebuild
 * lands below half so its acceptance applies as a plain carrier request,
 * ordinary work appends across half again, and the second rebuild closes
 * below half for the final answer. The follow-up run repeats the crossing
 * once more with a protected instruction inside the covered range.
 */
const blockBody = (title, fact, pad) => `# ${title}\n\n${"n".repeat(pad)}\n\n${fact}`;

const MEMORY_MARKDOWN_ONE = blockBody("Research digest one", FACT_ONE, 630);
const MEMORY_MARKDOWN_TWO = blockBody("Research digest two", FACT_TWO, 500);
const REBUILT_MARKDOWN_ONE = blockBody("Rebuilt digest", FACT_THREE, 150);
const APPEND_MARKDOWN_THREE = blockBody("Research digest three", FACT_TWO, 300);
const REBUILT_MARKDOWN_TWO = blockBody("Second rebuilt digest", FACT_FOUR, 60);
const APPEND_MARKDOWN_FOUR = blockBody("Follow-up digest", FACT_TWO, 120);
const REBUILT_MARKDOWN_THREE = blockBody("Third rebuilt digest", FACT_THREE, 80);
const BLOCK_TWO_NEEDLE = MEMORY_MARKDOWN_TWO.slice(0, 24);

// Deliberately compact evidence bodies: the faux provider accounts a
// request at roughly 1.7x this extension's estimate, so the whole serving
// (sources, system prompt, tools, calibration residual) must stay under the
// scale-limit clamp for the rebuild path to stay open through phase two.
const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(6);
const FILES = {};
for (const letter of "abcdefghijklmnopqrst") {
  FILES[`file-${letter}.txt`] = `FILE-${letter.toUpperCase()}-NEEDLE: workspace fact ${letter} — the ${letter} round evidence body.\n${FILLER}\n`;
}

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
  const root = mkdtempSync(join(tmpdir(), "pi-square-rebuild-native-"));
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
  for (const [name, content] of Object.entries(FILES)) {
    writeFileSync(join(cwd, name), content);
  }
  return { root, agentDir, cwd };
}

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-rebuild-runtime-"));
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
    provider: "rebuild-native-test",
    api: "rebuild-native-test",
    models: [{ id: "rebuild-native", contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }],
  });
  runtime.registerNativeProvider(faux.provider);

  /** Every real provider request, in order, after Pi's own conversion. */
  const requests = [];
  const compactionEvents = [];
  const abortedStops = [];
  let compactCount = 0;
  let phaseTwoCompacts = 0;
  let readLetter = null;

  let runOneCompacts = 0;
  let runTwoCompacts = 0;

  faux.setResponses(Array.from({ length: 60 }, () => (context) => {
    requests.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    });
    const text = requestText(context.messages);
    const rebuildDue = text.includes(REBUILD_ADVISORY_NEEDLE);
    const appendDue = text.includes("compression is due") && !rebuildDue;
    const last = context.messages.at(-1);
    const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;
    const lastText = messageText(last);
    const readOf = (letter) =>
      lastToolName === "read" && lastText.includes(`FILE-${letter.toUpperCase()}-NEEDLE`) ? letter : null;
    readLetter = readOf("a") ?? readOf("b") ?? readOf("c") ?? readOf("d") ?? readOf("e")
      ?? readOf("f") ?? readOf("g") ?? readOf("h") ?? readOf("i") ?? readOf("j")
      ?? readOf("k") ?? readOf("l") ?? readOf("m") ?? readOf("n") ?? readOf("o")
      ?? readOf("p") ?? readOf("q") ?? readOf("r") ?? readOf("s") ?? readLetter;

    // Phase three: source recovery through the reading tool, then answer.
    if (text.includes(VERIFY_MARKER)) {
      if (lastToolName === "read_memory_source") {
        return fauxAssistantMessage(
          lastText.includes("FILE-C-NEEDLE")
            ? `Recovery verified: the merged block's first source page carries FILE-C-NEEDLE. ${FACT_ONE}`
            : "Recovery failed: the original source page is missing.",
          { stopReason: "stop" },
        );
      }
      return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: 2, page: 1 }), { stopReason: "toolUse" });
    }

    // Phase two: the follow-up instruction crosses into the covered range of
    // a third rebuild in its own run.
    if (text.includes(FOLLOWUP_MARKER)) {
      if (lastToolName === "compact_to_memory_block") {
        runTwoCompacts += 1;
        if (runTwoCompacts === 1) {
          return fauxAssistantMessage(fauxToolCall("read", { path: "file-q.txt" }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(
          text.includes(FACT_ONE) && text.includes(FACT_FOUR)
            ? `Follow-up complete. ${FACT_ONE} ${FACT_FOUR}`
            : "Follow-up complete, but a block fact is MISSING from my context.",
          { stopReason: "stop" },
        );
      }
      if (readLetter === "p" && appendDue) {
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", { markdown: APPEND_MARKDOWN_FOUR }),
          { stopReason: "toolUse" },
        );
      }
      if (readLetter === "s" && rebuildDue) {
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", { markdown: REBUILT_MARKDOWN_THREE }),
          { stopReason: "toolUse" },
        );
      }
      const next = { p: "q", q: "r", r: "s" }[readLetter] ?? "p";
      return fauxAssistantMessage(fauxToolCall("read", { path: `file-${next}.txt` }), { stopReason: "toolUse" });
    }

    // Phase one: ONE user input through append, append, deferred rebuild,
    // ordinary continuation, append, second deferred rebuild, final answer.
    if (lastToolName === "compact_to_memory_block") {
      runOneCompacts += 1;
      if (runOneCompacts === 1) return fauxAssistantMessage(fauxToolCall("read", { path: "file-d.txt" }), { stopReason: "toolUse" });
      if (runOneCompacts === 2) return fauxAssistantMessage(fauxToolCall("read", { path: "file-f.txt" }), { stopReason: "toolUse" });
      if (runOneCompacts === 3) return fauxAssistantMessage(fauxToolCall("read", { path: "file-j.txt" }), { stopReason: "toolUse" });
      if (runOneCompacts === 4) return fauxAssistantMessage(fauxToolCall("read", { path: "file-l.txt" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(
        text.includes(FACT_ONE) && text.includes(FACT_THREE) && text.includes(FACT_FOUR)
          ? `Task complete. ${FACT_ONE} ${FACT_THREE} ${FACT_FOUR}`
          : "Task complete, but a digest fact is MISSING from my context.",
        { stopReason: "stop" },
      );
    }
    const chain = {
      a: "b", b: "c",
      d: "e",
      f: "g", g: "h", h: "i",
      j: "k",
      l: "m", m: "n",
    }[readLetter];
    if (chain) return fauxAssistantMessage(fauxToolCall("read", { path: `file-${chain}.txt` }), { stopReason: "toolUse" });
    if (readLetter === "c" && appendDue) {
      return fauxAssistantMessage(
        fauxToolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN_ONE }),
        { stopReason: "toolUse" },
      );
    }
    if (readLetter === "e" && appendDue) {
      return fauxAssistantMessage(
        fauxToolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN_TWO }),
        { stopReason: "toolUse" },
      );
    }
    if (readLetter === "i" && rebuildDue) {
      return fauxAssistantMessage(
        fauxToolCall("compact_to_memory_block", { markdown: REBUILT_MARKDOWN_ONE }),
        { stopReason: "toolUse" },
      );
    }
    if (readLetter === "k" && appendDue) {
      return fauxAssistantMessage(
        fauxToolCall("compact_to_memory_block", { markdown: APPEND_MARKDOWN_THREE }),
        { stopReason: "toolUse" },
      );
    }
    if (readLetter === "n" && rebuildDue) {
      return fauxAssistantMessage(
        fauxToolCall("compact_to_memory_block", { markdown: REBUILT_MARKDOWN_TWO }),
        { stopReason: "toolUse" },
      );
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

  // One user input drives append → deferred rebuild → ordinary tool work →
  // append → second deferred rebuild → final answer, with no second prompt
  // until the task has naturally answered.
  const taskPrompt = [
    "Research this workspace and finish one long task in this single run.",
    "Read the files in order, compressing what you learned whenever the",
    "maintenance advisory appears. When the advisory describes a suffix",
    "rebuild, first finish the next three ordinary reads it follows, then",
    "rebuild from the complete original conversation, and keep working.",
    "Answer only after the second suffix rebuild of this run.",
    `Required planning context that must stay present throughout: ${PLANNING_MARKER}.`,
  ].join("\n");
  await session.prompt(taskPrompt, { source: "interactive", expandPromptTemplates: false });

  const followUpPrompt = [
    `${FOLLOWUP_MARKER}: continue the same research with file-p.txt through file-s.txt,`,
    "crossing half the Memory budget once more, and answer with the first and",
    "fourth archive codes after the next suffix rebuild.",
  ].join("\n");
  await session.prompt(followUpPrompt, { source: "interactive", expandPromptTemplates: false });

  const verifyPrompt = [
    `${VERIFY_MARKER}: recover the merged Memory block's original conversation through`,
    "read_memory_source (block 2, page 1) and confirm the earliest evidence",
    "round is still recoverable, then answer with the first archive code.",
  ].join("\n");
  await session.prompt(verifyPrompt, { source: "interactive", expandPromptTemplates: false });

  // ── Three ordinary runs: no settle tricks, no aborts, no compaction ──
  assert.equal(compactionEvents.length, 0, "no in-task maintenance ever triggers native compaction");
  assert.equal(abortedStops.length, 0, "no run aborts or restarts");
  const branch = sessionManager.getBranch();
  const userEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(userEntries.length, 3, "three real user inputs drive the task, follow-up, and verification");
  const assistantAnswers = branch
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => messageText(entry.message))
    .filter((body) => body.length > 0);
  const runOneAnswer = assistantAnswers.find((body) => body.startsWith("Task complete"));
  assert.ok(runOneAnswer, "the single-input task answers after its second rebuild");
  assert.match(runOneAnswer, /MARS-ROVER-77/);
  assert.match(runOneAnswer, /LUNA-TANGO-42/);
  assert.match(runOneAnswer, /VEGA-SIGNAL-90/);
  assert.doesNotMatch(runOneAnswer, /MISSING/, "all three tail facts reached the provider through the carriers");
  const finalAnswer = assistantAnswers.findLast(() => true);
  assert.match(finalAnswer, /MARS-ROVER-77/, "the final answer carries the first block's tail fact");
  assert.match(finalAnswer, /FILE-C-NEEDLE/, "the final answer confirms the recovered original source");

  // ── Seven recordings; the first five belong to the ONE user task ──
  const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
  assert.equal(stateEntries.length, 7, "each accepted operation records exactly one state entry");
  const [appendOne, appendTwo, rebuildOne, appendThree, rebuildTwo, appendFour, rebuildThree] = stateEntries.map((entry) => entry.data);
  assert.equal(appendOne.blocks.length, 1);
  assert.equal(appendOne.blocks[0].markdown, MEMORY_MARKDOWN_ONE);
  assert.equal(appendTwo.blocks.length, 2, "the second operation still appends while below half budget");
  assert.equal(appendTwo.blocks[0].markdown, MEMORY_MARKDOWN_ONE);
  assert.equal(appendTwo.blocks[1].markdown, MEMORY_MARKDOWN_TWO);
  assert.equal(rebuildOne.blocks.length, 2, "the first rebuild replaces the suffix with one block");
  assert.equal(rebuildOne.blocks[0].markdown, MEMORY_MARKDOWN_ONE, "the kept prefix is byte-stable");
  assert.equal(rebuildOne.blocks[0].endEntryId, appendTwo.blocks[0].endEntryId, "the prefix keeps its end");
  assert.equal(rebuildOne.blocks[1].markdown, REBUILT_MARKDOWN_ONE);
  assert.deepEqual(rebuildOne.blocks[1].retainedEntryIds, [],
    "no user instruction falls inside the first rebuild's range");
  assert.equal(appendThree.blocks.length, 3, "ordinary work inside the same run appends again");
  assert.equal(appendThree.blocks[0].markdown, MEMORY_MARKDOWN_ONE);
  assert.equal(appendThree.blocks[1].markdown, REBUILT_MARKDOWN_ONE);
  assert.equal(appendThree.blocks[2].markdown, APPEND_MARKDOWN_THREE);
  assert.equal(rebuildTwo.blocks.length, 3, "the second rebuild replaces only its suffix");
  assert.equal(rebuildTwo.blocks[0].markdown, MEMORY_MARKDOWN_ONE, "the first prefix block is byte-stable across both rebuilds");
  assert.equal(rebuildTwo.blocks[1].markdown, REBUILT_MARKDOWN_ONE, "the first rebuilt block is byte-stable through the second rebuild");
  assert.equal(rebuildTwo.blocks[2].markdown, REBUILT_MARKDOWN_TWO);
  assert.deepEqual(rebuildTwo.blocks[2].retainedEntryIds, [],
    "the single-input task keeps no user instruction inside the second rebuild's range");
  assert.equal(appendFour.blocks.length, 4, "the follow-up run appends across half budget again");
  assert.equal(appendFour.blocks[3].markdown, APPEND_MARKDOWN_FOUR);
  assert.equal(rebuildThree.blocks.length, 4, "the third rebuild replaces only the follow-up suffix");
  assert.equal(rebuildThree.blocks[0].markdown, MEMORY_MARKDOWN_ONE, "the prefix blocks stay byte-stable through every rebuild");
  assert.equal(rebuildThree.blocks[1].markdown, REBUILT_MARKDOWN_ONE);
  assert.equal(rebuildThree.blocks[2].markdown, REBUILT_MARKDOWN_TWO);
  assert.equal(rebuildThree.blocks[3].markdown, REBUILT_MARKDOWN_THREE);
  assert.deepEqual(rebuildThree.blocks[3].retainedEntryIds, [userEntries[1].id],
    "the follow-up instruction inside the covered range stays a retained exception");
  // The single-input proof: both rebuilds of the long task record before the
  // follow-up prompt exists — one user input, no settle between them.
  const followUpPosition = branch.findIndex((entry) => entry.id === userEntries[1].id);
  for (const [index, entry] of stateEntries.slice(0, 5).entries()) {
    const position = branch.findIndex((candidate) => candidate.id === entry.id);
    assert.ok(position !== -1 && position < followUpPosition,
      `recording ${index + 1} of the single-input task precedes the follow-up input`);
  }

  // ── The pending phases at the request exit ──
  const compactCallRequests = requests
    .map((request, index) => ({
      index,
      call: request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
        && message.content.some((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block")),
    }))
    .filter(({ call }) => call)
    .map(({ index }) => index);
  assert.equal(compactCallRequests.length, 7, "seven provider requests carry compression calls");
  const [firstAppendAt, secondAppendAt, firstRebuildAt, thirdAppendAt, secondRebuildAt, fourthAppendAt, thirdRebuildAt] = compactCallRequests;

  // First pending phase: the suffix's complete originals raw, its summary
  // nowhere, the prefix-only carrier byte-exact, one advisory.
  const pendingOne = requests.slice(secondAppendAt, firstRebuildAt);
  assert.ok(pendingOne.length >= 4, `the first rebuild submission is deferred across ordinary requests (${pendingOne.length})`);
  for (const [offset, request] of pendingOne.entries()) {
    const text = requestText(request.messages);
    assert.ok(text.includes("FILE-C-NEEDLE") && text.includes("FILE-D-NEEDLE"),
      `the suffix originals stay raw in pending request ${offset}`);
    assert.ok(!text.includes(BLOCK_TWO_NEEDLE),
      `the replaced summary never appears beside its own sources (pending ${offset})`);
    const carriers = request.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
    assert.equal(carriers.length, 1, `exactly one carrier (pending ${offset})`);
    const parts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.equal(parts[0], MEMORY_SUMMARY_WRAPPER);
    assert.equal(parts[1], `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`,
      `the prefix part stays byte-exact (pending ${offset})`);
    assert.equal(parts.length, 2, `the carrier carries only the unselected prefix (pending ${offset})`);
    const advisory = request.messages.filter((message) => messageText(message).includes(REBUILD_ADVISORY_NEEDLE));
    assert.equal(advisory.length, 1, `one rebuild advisory, never a growing tail (pending ${offset})`);
  }
  const advisoryTexts = pendingOne
    .flatMap((request) => request.messages.filter((m) => messageText(m).includes(REBUILD_ADVISORY_NEEDLE)).map(messageText));
  assert.ok(advisoryTexts.length > 0 && advisoryTexts.every((text) => text === advisoryTexts[0]),
    "the rebuild advisory content stays fixed across the pending requests");

  // The first rebuild's acceptance applies at the very next request.
  const appliedOne = requests[firstRebuildAt + 1];
  assert.ok(appliedOne, "a request follows the rebuild call");
  const appliedOneText = requestText(appliedOne.messages);
  for (const needle of ["FILE-C-NEEDLE", "FILE-D-NEEDLE", "FILE-E-NEEDLE", "FILE-F-NEEDLE",
    "FILE-G-NEEDLE", "FILE-H-NEEDLE", BLOCK_TWO_NEEDLE]) {
    assert.ok(!appliedOneText.includes(needle), `the covered original left at once (${needle})`);
  }
  assert.ok(appliedOneText.includes("FILE-I-NEEDLE"), "the working-set round stays uncompressed");
  assert.ok(appliedOneText.includes(PLANNING_MARKER), "the protected task instruction stays raw");
  assert.ok(appliedOneText.includes(FACT_ONE) && appliedOneText.includes(FACT_THREE),
    "both tail facts of the applied carrier reach the provider");
  const appliedOneCarriers = appliedOne.messages.filter((m) => messageText(m).includes(MEMORY_SUMMARY_WRAPPER));
  assert.equal(appliedOneCarriers.length, 1, "no duplicate carrier after the rebuild");
  const appliedOneParts = appliedOneCarriers[0].content.filter((p) => p?.type === "text").map((p) => p.text);
  assert.deepEqual(appliedOneParts,
    [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`, `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_ONE}`],
    "the rebuilt carrier is prefix plus one new part, byte-exact");
  assert.ok(appliedOneText.split(FACT_THREE).length - 1 === 1, "the rebuilt summary appears exactly once");
  assert.ok(estimateTokens(appliedOne.messages) < estimateTokens(pendingOne.at(-1).messages),
    "the applied request is smaller than the served pending request it replaces");
  assert.ok(!JSON.stringify(appliedOne.messages).includes("cache_control"),
    "the rebuilt carrier adds no provider cache field or breakpoint");

  // Between the two rebuilds of the single task: ordinary tool work only —
  // no new user input, no extension-generated turn, no second run.
  for (const [offset, request] of requests.slice(firstRebuildAt, secondRebuildAt).entries()) {
    // The Memory carrier and advisory are pi-square's own custom messages;
    // Pi's provider conversion renders custom messages with the user role, so
    // they are excluded here — only a real user input would add another.
    const userMessages = request.messages.filter((message) => message?.role === "user"
      && !messageText(message).includes(MEMORY_SUMMARY_WRAPPER)
      && !messageText(message).includes("compression is due"));
    assert.equal(userMessages.length, 1,
      `no new user input between the two rebuilds of the single task (${offset})`);
    const foreignCustom = request.messages.filter((message) => message?.role === "custom"
      && messageText(message) !== ""
      && !messageText(message).includes(MEMORY_SUMMARY_WRAPPER)
      && !messageText(message).includes("compression is due"));
    assert.equal(foreignCustom.length, 0,
      `no extension-generated wake between the two rebuilds (${offset})`);
  }

  // Second pending phase inside the same run: the third block's originals
  // return raw while its summary is absent and the kept prefix stays carried.
  const pendingTwo = requests.slice(thirdAppendAt, secondRebuildAt);
  assert.ok(pendingTwo.length >= 3, `the second rebuild is deferred across ordinary requests (${pendingTwo.length})`);
  for (const [offset, request] of pendingTwo.entries()) {
    const text = requestText(request.messages);
    assert.ok(text.includes("FILE-I-NEEDLE") && text.includes("FILE-K-NEEDLE"),
      `the second suffix's originals stay raw in the same run (pending two ${offset})`);
    assert.ok(!text.includes(APPEND_MARKDOWN_THREE.slice(0, 24)),
      `the replaced third-block summary never appears beside its sources (pending two ${offset})`);
    const carriers = request.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
    assert.equal(carriers.length, 1);
    const parts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.equal(parts[1], `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`);
    assert.equal(parts[2], `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_ONE}`,
      `the whole kept prefix stays carried byte-exact (pending two ${offset})`);
    assert.equal(parts.length, 3);
  }

  // The second rebuild's acceptance closes the single task: the full prefix
  // is byte-identical across both rebuilds, the covered originals leave
  // together, and the final answer's facts ride the carrier exactly once.
  const appliedTwo = requests[secondRebuildAt + 1];
  const appliedTwoText = requestText(appliedTwo.messages);
  for (const needle of ["FILE-I-NEEDLE", "FILE-J-NEEDLE", "FILE-K-NEEDLE", "FILE-L-NEEDLE",
    "FILE-M-NEEDLE", APPEND_MARKDOWN_THREE.slice(0, 24)]) {
    assert.ok(!appliedTwoText.includes(needle), `the second rebuild evicts its covered originals (${needle})`);
  }
  assert.ok(appliedTwoText.includes("FILE-N-NEEDLE"), "the newest round stays uncompressed");
  assert.ok(appliedTwoText.includes(PLANNING_MARKER), "the original task instruction is still raw");
  assert.ok(appliedTwoText.includes(FACT_ONE) && appliedTwoText.includes(FACT_THREE)
    && appliedTwoText.includes(FACT_FOUR),
    "every tail fact reaches the provider exactly through the carriers");
  const appliedTwoCarriers = appliedTwo.messages.filter((m) => messageText(m).includes(MEMORY_SUMMARY_WRAPPER));
  assert.equal(appliedTwoCarriers.length, 1);
  const appliedTwoParts = appliedTwoCarriers[0].content.filter((p) => p?.type === "text").map((p) => p.text);
  assert.deepEqual(appliedTwoParts,
    [MEMORY_SUMMARY_WRAPPER,
      `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`,
      `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_ONE}`,
      `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_TWO}`],
    "the closing carrier keeps the whole prefix byte-identical across both rebuilds");
  assert.equal(appliedTwoParts[1], appliedOneParts[1], "the first prefix part is byte-identical across both rebuilds");
  assert.equal(appliedTwoParts[2], appliedOneParts[2], "the first rebuilt part is byte-identical across both rebuilds");
  const trailingRebuildCall = requests[secondRebuildAt].messages
    .filter((message) => message?.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content)
    .find((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block");
  assert.equal(trailingRebuildCall?.arguments?.markdown, "(this Memory block is carried in full above)",
    "the trailing rebuild call's arguments never duplicate the carried body");
  assert.ok(estimateTokens(appliedTwo.messages) < estimateTokens(pendingTwo.at(-1).messages),
    "the second applied request is smaller than its served pending request");

  // Follow-up run: the third rebuild's sources cross the protected
  // instruction until the next submission.
  const pendingThree = requests.slice(fourthAppendAt, thirdRebuildAt)
    .filter((request) => requestText(request.messages).includes(FOLLOWUP_MARKER));
  assert.ok(pendingThree.length >= 3, `the third rebuild is deferred across the follow-up requests (${pendingThree.length})`);
  for (const [offset, request] of pendingThree.entries()) {
    const text = requestText(request.messages);
    assert.ok(text.includes("FILE-N-NEEDLE"),
      `the third suffix's originals stay raw across the follow-up (pending three ${offset})`);
    if (offset > 0) {
      assert.ok(text.includes("FILE-Q-NEEDLE"),
        `growth joins the pinned range through the served re-scope (pending three ${offset})`);
    }
    assert.ok(text.includes(FOLLOWUP_MARKER), "the protected follow-up instruction stays raw inside its covered range");
    assert.ok(!text.includes(APPEND_MARKDOWN_FOUR.slice(0, 24)),
      `the replaced follow-up summary never appears beside its sources (pending three ${offset})`);
    const carriers = request.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
    assert.equal(carriers.length, 1);
    const parts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.equal(parts[1], `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`);
    assert.equal(parts[2], `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_ONE}`);
    assert.equal(parts[3], `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_TWO}`);
    assert.equal(parts.length, 4);
  }

  // The third rebuild's acceptance keeps the protected instruction raw and
  // the whole earlier prefix byte-stable.
  const appliedThree = requests[thirdRebuildAt + 1];
  const appliedThreeText = requestText(appliedThree.messages);
  for (const needle of ["FILE-N-NEEDLE", "FILE-P-NEEDLE", "FILE-Q-NEEDLE", "FILE-R-NEEDLE",
    APPEND_MARKDOWN_FOUR.slice(0, 24)]) {
    assert.ok(!appliedThreeText.includes(needle), `the third rebuild evicts its covered originals (${needle})`);
  }
  assert.ok(appliedThreeText.includes("FILE-S-NEEDLE"), "the newest follow-up round stays uncompressed");
  assert.ok(appliedThreeText.includes(FOLLOWUP_MARKER),
    "the protected follow-up instruction survives its covering rebuild raw");
  assert.ok(appliedThreeText.includes(PLANNING_MARKER), "the original task instruction is still raw");
  const appliedThreeCarriers = appliedThree.messages.filter((m) => messageText(m).includes(MEMORY_SUMMARY_WRAPPER));
  assert.equal(appliedThreeCarriers.length, 1);
  const appliedThreeParts = appliedThreeCarriers[0].content.filter((p) => p?.type === "text").map((p) => p.text);
  assert.deepEqual(appliedThreeParts,
    [MEMORY_SUMMARY_WRAPPER,
      `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`,
      `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_ONE}`,
      `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_TWO}`,
      `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN_THREE}`],
    "the follow-up carrier keeps every earlier prefix part byte-identical");
  assert.equal(appliedThreeParts[1], appliedOneParts[1], "the first prefix part is byte-identical through all three rebuilds");
  assert.equal(appliedThreeParts[3], appliedTwoParts[3], "the second rebuilt part is byte-identical through the third rebuild");
  assert.ok(estimateTokens(appliedThree.messages) < estimateTokens(pendingThree.at(-1).messages),
    "the third applied request is smaller than its served pending request");

  // ── Advisory discipline and tool stability over the whole task ──
  assert.ok(requests.length >= 24, `the task produced a substantial request sequence (${requests.length})`);
  for (const [index, request] of requests.entries()) {
    const advisoryCount = request.messages
      .filter((message) => messageText(message).includes("compression is due")).length;
    assert.ok(advisoryCount <= 1, `no request ever carries more than one advisory (${index})`);
    const carriers = request.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
    assert.ok(carriers.length <= 1, `no request ever carries more than one carrier (${index})`);
  }
  const baselineTools = requests[0].toolNames
    .filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
  for (const [index, request] of requests.entries()) {
    assert.ok(request.toolNames.includes("compact_to_memory_block"),
      `the resident compression tool stays exposed (${index})`);
    assert.ok(!request.toolNames.includes("submit_memory"), "the retired name never appears");
    const others = request.toolNames
      .filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
    assert.deepEqual(others, baselineTools, `no other tool changes around any maintenance (${index})`);
  }

  // ── Source recovery after completion: the merged block stays checkable ──
  const sourceResults = branch.filter((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read_memory_source");
  assert.equal(sourceResults.length, 1, "one bounded source page was recovered");
  assert.match(messageText(sourceResults[0].message), /FILE-C-NEEDLE/,
    "the rebuilt block's first source page carries the merged earliest original");
  assert.match(sourceResults[0].message.content[0].text, /^Memory source · block 2 of 4 · page 1 of \d+$/);

  console.log("context-memory suffix rebuild native session: OK");
} finally {
  unsubscribe?.();
  await session?.dispose();
  if (environment) rmSync(environment.root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
