import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_BLOCK_SEPARATOR, MEMORY_SUMMARY_WRAPPER } = await load("../../src/context-memory/format.ts");

/**
 * #339 native acceptance: one real Pi `AgentSession` with a deterministic
 * faux model drives the registered `search_memory_source` surface end to end,
 * observed only at the provider request exit. One research run records real
 * Memory blocks; then three follow-up prompts prove the vertical capability:
 * search locates a late-page fact and the referenced page is read without any
 * unrelated page, a sufficient snippet answers with no page read at all, and
 * an append changes the source view so a stale search reference is rejected
 * with VIEW_STALE before any page content is served — followed by a fresh
 * search that recovers the fact under the new view.
 *
 * Sizing note: the faux provider reports usage at roughly twice this
 * extension's estimate, and the #324 request-exit arbitration counts that
 * calibration residual against Pi's native compaction boundary, so every
 * request here stays well below the window with one compression per run.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 80_000;
const COMPRESSION_THRESHOLD_TOKENS = 1_200;
const MEMORY_BUDGET_PERCENT = 1;

const INITIAL_MARKER = "INITIAL-RESEARCH-RUN";
const SEARCH_MARKER = "SEARCH-AND-READ-RUN";
const SNIPPET_MARKER = "SNIPPET-SUFFICIENT-RUN";
const STALE_MARKER = "STALE-VIEW-RUN";
const INTERRUPTED_MARKER = "INTERRUPTED-SEARCH-RUN";
const CONTINUE_MARKER = "CONTINUE-AFTER-INTERRUPTION-RUN";
const REOPEN_MARKER = "REOPENED-VERIFICATION-RUN";

/** The codes exist only in the raw source files, never in any Memory body. */
const FACT_ONE = "The first archive code is MARS-ROVER-77.";
const FACT_TWO = "The second archive code is ORION-ECHO-31.";
const FACT_THREE = "The third archive code is LUNA-TANGO-42.";
const FACT_FOUR = "The fourth archive code is VEGA-SIGNAL-90.";

const MEMORY_ONE = "# Research digest one\n\n- the workspace archive round was surveyed";
const MEMORY_TWO = "# Follow-up digest\n\n- the later evidence round was surveyed";
const MEMORY_THREE = "# Post-interruption digest\n\n- the interrupted run and its continuation were surveyed";

const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(6);
/** Two deep rounds: the covered block spans three 16 KiB source pages. */
function deepFile(factLine) {
  const lines = [];
  for (let i = 0; i < 52; i++) lines.push(FILLER);
  if (factLine !== undefined) lines[factLine] = `${lines[factLine]}\n${factLine === 45 ? FACT_ONE : FACT_TWO}`;
  return `${lines.join("\n")}\n`;
}

const FILES = {
  "file-a.txt": deepFile(45),
  "file-e.txt": deepFile(51),
  "file-c.txt": `small closing round\n${FILLER}\n`,
  "file-d.txt": `${FILLER.repeat(3)}\n${FACT_THREE}\n`,
  "file-f.txt": `${FILLER}\n${FACT_FOUR}\n`,
};

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

function prepareEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "pi-square-source-search-native-"));
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

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-source-search-runtime-"));
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
    provider: "source-search-native-test",
    api: "source-search-native-test",
    models: [{ id: "source-search-native", contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }],
  });
  runtime.registerNativeProvider(faux.provider);

  /** Every real provider request, in order. */
  const requests = [];
  const compactionEvents = [];
  const abortedStops = [];

  // Scripted model state across the six runs.
  let initialReads = 0;
  let staleView = null;
  let staleTarget = { block: 1, page: 1 };
  let searchedAfterStale = false;
  let interruptArmed = false;
  let interruptFired = false;
  let continueSearches = 0;

  faux.setResponses(Array.from({ length: 80 }, () => (context) => {
    requests.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    });
    const text = requestText(context.messages);
    const last = context.messages.at(-1);
    const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;
    const lastText = messageText(last);
    // Phase detection keys on the LATEST user message: earlier runs' prompts
    // stay in context, so a plain includes() on the whole text would match
    // every phase at once.
    const markerOf = (candidate) => [
      INITIAL_MARKER, SEARCH_MARKER, SNIPPET_MARKER, STALE_MARKER, INTERRUPTED_MARKER, CONTINUE_MARKER,
      REOPEN_MARKER,
    ].find((marker) => candidate.includes(marker));
    const currentUser = [...context.messages].reverse().find((message) => message.role === "user"
      && markerOf(messageText(message)));
    const currentPrompt = messageText(currentUser);
    const parseRow = () => {
      const row = /block (\d+) · page (\d+) of (\d+)/.exec(lastText);
      const view = /view (sv1-[0-9a-f]+)/.exec(lastText);
      return row && view ? { block: Number(row[1]), page: Number(row[2]), view: view[1] } : undefined;
    };

    // ── Run one: two reads (one deep), one compression, then the answer.
    if (currentPrompt.includes(INITIAL_MARKER) && initialReads < 3) {
      if (lastToolName === "read") initialReads += 1;
      if (initialReads === 0) return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
      if (initialReads === 1) return fauxAssistantMessage(fauxToolCall("read", { path: "file-e.txt" }), { stopReason: "toolUse" });
      if (initialReads === 2) return fauxAssistantMessage(fauxToolCall("read", { path: "file-c.txt" }), { stopReason: "toolUse" });
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage("Research complete. Two archive codes are stored in Memory.", { stopReason: "stop" });
      }
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: MEMORY_ONE }), { stopReason: "toolUse" });
    }

    // ── Run two: search for the late-page code, read the referenced page,
    // then answer with the recovered fact.
    if (currentPrompt.includes(SEARCH_MARKER)) {
      if (lastToolName === "read_memory_source") {
        return fauxAssistantMessage(
          lastText.includes(FACT_TWO)
            ? `Recovery verified on the referenced page. ${FACT_TWO}`
            : "Recovery failed: the referenced page is missing the code.",
          { stopReason: "stop" },
        );
      }
      if (lastToolName === "search_memory_source") {
        const row = parseRow();
        if (!row) return fauxAssistantMessage("Search result was unreadable.", { stopReason: "stop" });
        staleView = row.view;
        staleTarget = { block: row.block, page: row.page };
        return fauxAssistantMessage(
          fauxToolCall("read_memory_source", { block: row.block, page: row.page, view: row.view }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: ["ORION"] }), { stopReason: "toolUse" });
    }

    // ── Run three: a sufficient snippet answers with no page read at all.
    if (currentPrompt.includes(SNIPPET_MARKER)) {
      if (lastToolName === "search_memory_source") {
        return fauxAssistantMessage(
          lastText.includes(FACT_ONE)
            ? `Snippet was sufficient evidence. ${FACT_ONE}`
            : "Snippet failed to carry the code.",
          { stopReason: "stop" },
        );
      }
      return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: ["MARS-ROVER"] }), { stopReason: "toolUse" });
    }

    // ── Run four: one more read and compression change the Memory view, the
    // stale reference is rejected, a fresh search recovers under the new view.
    if (currentPrompt.includes(STALE_MARKER)) {
      if (lastToolName === "read_memory_source") {
        if (/^VIEW_STALE: /.test(lastText)) {
          return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: ["ORION"] }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(
          lastText.includes(FACT_TWO)
            ? `Stale view rejected, fresh view verified. ${FACT_TWO}`
            : "Recovery under the fresh view failed.",
          { stopReason: "stop" },
        );
      }
      if (lastToolName === "search_memory_source") {
        searchedAfterStale = true;
        const row = parseRow();
        if (!row) return fauxAssistantMessage("Fresh search result was unreadable.", { stopReason: "stop" });
        return fauxAssistantMessage(
          fauxToolCall("read_memory_source", { block: row.block, page: row.page, view: row.view }),
          { stopReason: "toolUse" },
        );
      }
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage(
          fauxToolCall("read_memory_source", { block: staleTarget.block, page: staleTarget.page, view: staleView ?? "sv1-unknown" }),
          { stopReason: "toolUse" },
        );
      }
      if (lastToolName === "read") {
        return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: MEMORY_TWO }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-d.txt" }), { stopReason: "toolUse" });
    }

    // ── Run five: a narrated search batch is interrupted right after its
    // result lands; the run aborts before the next model request.
    if (currentPrompt.includes(INTERRUPTED_MARKER)) {
      return fauxAssistantMessage(
        [
          { type: "text", text: "narrating the interrupted source search before it answers" },
          fauxToolCall("search_memory_source", { terms: ["LUNA"] }),
        ],
        { stopReason: "toolUse" },
      );
    }

    // ── Run six: continue ordinary work and compress over the interrupted
    // exchange; the acknowledgement request proves same-session projection.
    if (currentPrompt.includes(CONTINUE_MARKER)) {
      if (lastToolName === "read") {
        return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: MEMORY_THREE }), { stopReason: "toolUse" });
      }
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage("Recorded the post-interruption compression.", { stopReason: "stop" });
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-f.txt" }), { stopReason: "toolUse" });
    }

    // ── Run seven (reopened session): verification searches under the
    // applied Memory carrier.
    if (currentPrompt.includes(REOPEN_MARKER)) {
      if (lastToolName === "search_memory_source") {
        continueSearches += 1;
        if (continueSearches === 1) {
          return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: ["Memory source search"] }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(
          lastText.includes("no matches")
            ? `Reopen verification complete: original facts recoverable, retrieval copies are not evidence. ${FACT_ONE}`
            : "Reopen verification failed: retrieval framing matched original sources.",
          { stopReason: "stop" },
        );
      }
      return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: ["MARS-ROVER"] }), { stopReason: "toolUse" });
    }

    return fauxAssistantMessage("Unexpected phase.", { stopReason: "stop" });
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
    initialActiveToolNames: ["read", "bash"],
  }));
  await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
  const loadedErrors = resourceLoader.getExtensions().errors;
  assert.equal(loadedErrors.length, 0, "pi-square must load without extension errors");

  unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") {
      abortedStops.push(event.message);
    }
    // Deterministic interruption (#339 review): the abort fires from the
    // interrupted search's tool-result message_end, so the completed pair is
    // real history and the continuation request is the next model request.
    if (interruptArmed && event.type === "message_end" && event.message.role === "toolResult"
      && event.message.toolName === "search_memory_source") {
      interruptArmed = false;
      interruptFired = true;
      void session.abort();
    }
  });

  // Run one: record real Memory over the deep evidence round.
  await session.prompt(
    `${INITIAL_MARKER}: read file-a.txt, file-e.txt, and file-c.txt in order, compress the covered history once the rounds complete, and finish the run.`,
    { source: "interactive", expandPromptTemplates: false },
  );

  // Run two: search locates the late-page code; only the referenced page is read.
  await session.prompt(
    `${SEARCH_MARKER}: recover the second archive code from Memory sources. Search first, then read only the referenced page, then answer with the exact code sentence.`,
    { source: "interactive", expandPromptTemplates: false },
  );

  // Run three: the snippet alone is sufficient evidence.
  await session.prompt(
    `${SNIPPET_MARKER}: recover the first archive code from Memory sources using only a search; do not read any page, then answer with the exact code sentence.`,
    { source: "interactive", expandPromptTemplates: false },
  );

  // Run four: compression changes the view; the stale reference must fail.
  await session.prompt(
    `${STALE_MARKER}: read file-d.txt, compress the covered history once, then try the earlier search-derived page reference, recover properly after any rejection, and answer with the second archive code sentence.`,
    { source: "interactive", expandPromptTemplates: false },
  );

  // Runs one through four are ordinary: no aborts before the intentional one.
  const abortsBeforeInterruption = abortedStops.length;
  assert.equal(abortsBeforeInterruption, 0, "no run before the interruption scenario aborts");

  // Run five: the interrupted search batch — the abort fires from the search
  // tool-result event, after the completed pair became real history.
  interruptArmed = true;
  await session.prompt(
    `${INTERRUPTED_MARKER}: search the Memory sources for the third archive code, then keep working.`,
    { source: "interactive", expandPromptTemplates: false },
  );
  assert.ok(interruptFired, "the deterministic abort fired from the interrupted search's result event");
  const interruptError = sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => entry.message)
    .find((message) => message.stopReason === "error");
  assert.ok(interruptError && /abort/i.test(interruptError.errorMessage ?? ""),
    "the interrupted run surfaces Pi's abort-flavored error assistant");
  assert.equal(abortedStops.length, 0, "no run ends through a user-interruption aborted stop");
  const interruptedSearchId = sessionManager.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .flatMap((entry) => (Array.isArray(entry.message.content) ? entry.message.content : []))
    .find((part) => part?.type === "toolCall" && part.name === "search_memory_source"
      && part.arguments?.terms?.[0] === "LUNA")?.id;
  assert.ok(interruptedSearchId, "run five recorded the interrupted search call before the abort");

  // Run six: ordinary work and compression continue over the interrupted
  // exchange, ending at the compression acknowledgement.
  await session.prompt(
    `${CONTINUE_MARKER}: read file-f.txt, then compress the covered history once and stop at the acknowledgement.`,
    { source: "interactive", expandPromptTemplates: false },
  );

  // The compression applies to its acknowledgement request in this same
  // session; reopening below independently proves persisted re-derivation.
  const sameSessionApplied = requests.filter((request) => requestText(request.messages).includes(CONTINUE_MARKER)
    && request.messages.some((message) => messageText(message).includes(MEMORY_THREE)));
  assert.equal(sameSessionApplied.length, 1,
    "run six has exactly one post-compression provider request carrying the third Memory block");
  {
    const request = sameSessionApplied[0];
    const serialized = JSON.stringify(request.messages);
    const carriers = request.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
    assert.equal(carriers.length, 1, "the same-session request applies exactly one Memory carrier");
    const carrierParts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.deepEqual(carrierParts, [
      MEMORY_SUMMARY_WRAPPER,
      `${MEMORY_BLOCK_SEPARATOR}${MEMORY_ONE}`,
      `${MEMORY_BLOCK_SEPARATOR}${MEMORY_TWO}`,
      `${MEMORY_BLOCK_SEPARATOR}${MEMORY_THREE}`,
    ], "the same-session carrier preserves every recorded block in order");
    assert.ok(!serialized.includes(interruptedSearchId),
      "the covered interrupted search call leaves the same-session projected request");
    assert.ok(!request.messages.some((message) =>
      message.role === "toolResult" && message.toolCallId === interruptedSearchId),
    "the covered interrupted search result leaves together with its call");
    assert.ok(!serialized.includes("narrating the interrupted source search"),
      "the covered interrupted narration leaves the same-session projected request");
    assert.ok(serialized.includes(CONTINUE_MARKER) && serialized.includes("file-f.txt"),
      "the retained working set remains in the same-session projected request");
  }

  // Reopen through Pi's public seam to independently prove persisted
  // re-derivation after the same-session assertion above.
  const sessionFile = sessionManager.getSessionFile();
  await session.dispose();
  unsubscribe();
  const reopenedManager = SessionManager.open(sessionFile, environment.root);
  // A fresh resource loader binds fresh extension instances to the reopened
  // session's pi context; reusing the first loader would emit through the
  // stale context of the disposed session.
  const reopenedSettings = SettingsManager.create(environment.cwd, environment.agentDir);
  const reopenedLoader = new DefaultResourceLoader({
    cwd: environment.cwd, agentDir: environment.agentDir, settingsManager: reopenedSettings, noSkills: true,
  });
  await reopenedLoader.reload();
  ({ session } = await createAgentSession({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    settingsManager: reopenedSettings,
    resourceLoader: reopenedLoader,
    sessionManager: reopenedManager,
    modelRuntime: runtime,
    model: faux.getModel(),
    thinkingLevel: "off",
    initialActiveToolNames: ["read", "bash"],
    sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: sessionFile },
  }));
  assert.equal(reopenedLoader.getExtensions().errors.length, 0, "pi-square reloads without extension errors");
  await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
  unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") {
      abortedStops.push(event.message);
    }
  });

  // Run seven: verification searches in the reopened session, observed under
  // the applied carrier.
  await session.prompt(
    `${REOPEN_MARKER}: verify the first archive code is still recoverable from the Memory sources, check that retrieval copies are not original evidence, and answer.`,
    { source: "interactive", expandPromptTemplates: false },
  );

  // ── No native compaction anywhere; no user-interruption aborted stops ──
  assert.equal(compactionEvents.length, 0, "no run triggers native compaction");
  assert.equal(abortedStops.length, 0,
    "the deterministic interruption surfaces as Pi's abort-flavored error, never as a user-interruption aborted stop");

  const branch = reopenedManager.getBranch();
  const userTexts = branch
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
    .map((entry) => (typeof entry.message.content === "string" ? entry.message.content : ""));
  assert.equal(userTexts.length, 7, "seven user prompts ran across the original and reopened sessions");
  const answers = branch
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => (Array.isArray(entry.message.content)
      ? entry.message.content.map((part) => (part?.type === "text" ? part.text : "")).join("")
      : ""));

  // ── Tool exposure follows valid Memory end to end ──
  assert.ok(requests.some((request) => request.toolNames.includes("search_memory_source")),
    "the registered search tool reaches the provider tool list");
  const firstSearchRequest = requests.findIndex((request) => request.toolNames.includes("search_memory_source"));
  assert.ok(firstSearchRequest > 0, "search joins only after the first recorded block");
  for (let i = 0; i < firstSearchRequest; i++) {
    assert.ok(!requests[i].toolNames.includes("search_memory_source"),
      "before valid Memory exists the search tool is not exposed");
    assert.ok(requests[i].toolNames.includes("compact_to_memory_block"),
      "the resident compression tool is exposed throughout");
  }

  // ── Ground truth from the branch: calls, results, and pairings ──
  const calls = [];
  const results = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "toolCall" && part.name === "search_memory_source") {
          calls.push({ id: part.id, arguments: part.arguments, result: undefined });
        }
        if (part?.type === "toolCall" && part.name === "read_memory_source") {
          calls.push({ id: part.id, arguments: part.arguments, result: undefined, reader: true });
        }
      }
    }
    if (message.role === "toolResult" && (message.toolName === "search_memory_source" || message.toolName === "read_memory_source")) {
      results.push({
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError === true,
        text: (Array.isArray(message.content) ? message.content : [])
          .map((part) => (part?.type === "text" ? part.text : "")).join("\n"),
      });
    }
  }
  for (const result of results) {
    const call = calls.find((candidate) => candidate.id === result.toolCallId);
    assert.ok(call, `every protocol result has its producing call (${result.toolName})`);
    call.result = result;
  }
  for (const call of calls) {
    assert.ok(call.result, `every protocol call has its result — native pairing is preserved (${call.id})`);
  }

  const searchCalls = calls.filter((call) => !call.reader);
  const readCalls = calls.filter((call) => call.reader);
  assert.equal(searchCalls.length, 6,
    "six searches ran: located, snippet-only, post-stale fresh, interrupted, and the two evidence-copy checks");

  // ── Native protocol pairing across every captured request, interrupted
  // batches included: no result without its producing call ever reaches the
  // provider, and the interrupted pair stays whole (#339 review).
  for (const [index, request] of requests.entries()) {
    const callIds = new Set();
    for (const message of request.messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "toolCall" && (part.name === "search_memory_source" || part.name === "read_memory_source")) {
            callIds.add(part.id);
          }
        }
      }
    }
    for (const message of request.messages) {
      if (message.role === "toolResult" && (message.toolName === "search_memory_source" || message.toolName === "read_memory_source")) {
        assert.ok(callIds.has(message.toolCallId),
          `request ${index}: every retrieval result rides with its producing call (no orphaned result)`);
      }
    }
  }

  // The interrupted search pair is real history: narration call plus result.
  const interruptedSearch = searchCalls.find((call) => call.arguments.terms
    && call.arguments.terms[0] === "LUNA");
  assert.ok(interruptedSearch, "run five issued the interrupted search");
  assert.equal(interruptedSearch.result.isError, false, "the interrupted search completed before the abort");
  const continuationRequests = requests.filter((request) =>
    requestText(request.messages).includes(CONTINUE_MARKER));
  assert.ok(continuationRequests.length > 0, "the continuation run reached the provider");
  {
    const callPresent = continuationRequests[0].messages.some((message) =>
      message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part) => part?.type === "toolCall" && part.id === interruptedSearch.id));
    const resultPresent = continuationRequests[0].messages.some((message) =>
      message.role === "toolResult" && message.toolCallId === interruptedSearch.id);
    assert.ok(callPresent && resultPresent,
      "the first continuation request carries the interrupted call and its result as a whole pair");
  }
  // ── Reopened-session proof: the recorded carrier re-derives and the
  // covered interrupted pair remains absent together after reopening.
  const reopenedRequests = requests.filter((request) =>
    requestText(request.messages).includes(REOPEN_MARKER));

  assert.ok(reopenedRequests.length > 0, "the reopened session reached the provider");
  {
    const first = reopenedRequests[0];
    const serialized = JSON.stringify(first.messages);
    // Provider-converted requests carry the carrier as its composed wrapper
    // text; the projection seam itself is covered by the deterministic suite.
    const carriers = first.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
    assert.equal(carriers.length, 1, "the reopened request applies exactly one Memory carrier");
    assert.equal(
      carriers[0].content.filter((part) => part?.type === "text").length,
      4,
      "the carrier carries the wrapper plus one part per recorded block",
    );
    assert.ok(!serialized.includes(interruptedSearch.id),
      "the covered interrupted search call left the projected request");
    assert.ok(!first.messages.some((message) =>
      message.role === "toolResult" && message.toolCallId === interruptedSearch.id),
      "the covered interrupted search result left the projected request together with its call");
    assert.ok(!serialized.includes("narrating the interrupted source search"),
      "the covered interrupted narration left with its exchange");
    for (const request of reopenedRequests) {
      const later = JSON.stringify(request.messages);
      assert.ok(!later.includes(interruptedSearch.id) || later.includes(`"toolCallId":"${interruptedSearch.id}"`),
        "no reopened request strands half of the interrupted pair");
    }
  }
  // Global safety net: the interrupted pair is never split across halves in
  // any captured request; a request either carries both or neither.
  for (const [index, request] of requests.entries()) {
    const serialized = JSON.stringify(request.messages);
    const callPresent = serialized.includes(interruptedSearch.id);
    const resultPresent = request.messages.some((message) =>
      message.role === "toolResult" && message.toolCallId === interruptedSearch.id);
    if (callPresent || resultPresent) {
      assert.ok(callPresent && resultPresent,
        `request ${index}: the interrupted search call and result stay a whole pair (never a stranded half)`);
    }
  }

  // ── Run two: exact snippets/pages reach the next model request ──
  const firstSearch = searchCalls[0];
  assert.deepEqual(firstSearch.arguments, { terms: ["ORION"] });
  const firstSearchResult = firstSearch.result;
  assert.equal(firstSearchResult.isError, false);
  const firstRow = /block 1 · page (\d+) of (\d+)/.exec(firstSearchResult.text);
  assert.ok(firstRow && Number(firstRow[1]) === Number(firstRow[2]) && Number(firstRow[2]) >= 3,
    "the late-position fact is located on the final page of a multi-page block");
  assert.ok(firstSearchResult.text.includes(FACT_TWO),
    "the search result carries the exact original snippet");

  const searchResultRequests = requests
    .filter((request) => requestText(request.messages).includes("Memory source search")
      && requestText(request.messages).includes(FACT_TWO));
  assert.ok(searchResultRequests.length > 0,
    "the search result with its exact source snippet enters the next model request");
  const runTwoRead = readCalls[0];
  assert.ok(runTwoRead, "run two reads the referenced page");
  assert.equal(runTwoRead.arguments.page, Number(firstRow[1]), "run two reads only the referenced page");
  assert.equal(runTwoRead.arguments.block, 1);
  assert.match(runTwoRead.arguments.view, /^sv1-[0-9a-f]+$/, "the read pins the search-derived view");
  assert.equal(runTwoRead.result.isError, false);
  assert.ok(runTwoRead.result.text.includes(FACT_TWO), "the referenced page serves the fact");
  assert.equal(readCalls.filter((call) => call.arguments.block === 1 && call.arguments.page !== Number(firstRow[1])).length, 0,
    "no unrelated page was read to locate the late-position fact");
  assert.ok(answers.some((answer) => answer.includes(FACT_TWO) && answer.includes("Recovery verified")),
    "run two answers with the code recovered through search plus the referenced page");

  // ── Run three: a sufficient snippet answers without any page read ──
  const snippetSearch = searchCalls[1];
  assert.deepEqual(snippetSearch.arguments, { terms: ["MARS-ROVER"] });
  const snippetRow = /block 1 · page (\d+) of (\d+)/.exec(snippetSearch.result.text);
  assert.ok(snippetRow && Number(snippetRow[1]) < Number(snippetRow[2]),
    "the mid-block fact is located on an earlier page than the closing fact");
  assert.ok(snippetSearch.result.text.includes(FACT_ONE),
    "the snippet carries the complete code sentence as original evidence");
  const runThreeBoundary = branch.findIndex((entry) => entry.type === "message"
    && typeof entry.message.content === "string" && entry.message.content.includes(SNIPPET_MARKER));
  const runFourBoundary = branch.findIndex((entry) => entry.type === "message"
    && typeof entry.message?.content === "string" && entry.message.content.includes(STALE_MARKER));
  const readsAfterRunThree = readCalls.filter((call) => {
    const entryPosition = branch.findIndex((entry) => entry.type === "message"
      && entry.message.role === "assistant"
      && Array.isArray(entry.message.content)
      && entry.message.content.some((part) => part?.type === "toolCall" && part.id === call.id));
    return entryPosition > runThreeBoundary && entryPosition < runFourBoundary;
  });
  assert.equal(readsAfterRunThree.length, 0,
    "a sufficient snippet needs no page read (no redundant full-page repeat)");
  assert.ok(answers.some((answer) => answer.includes(FACT_ONE) && answer.includes("Snippet was sufficient")),
    "run three answers from the snippet alone");

  // ── Run four: the stale reference is rejected before any page content ──
  assert.ok(staleView, "run two's view token was captured for the stale attempt");
  const staleRead = readCalls.find((call) => call.result?.isError === true);
  assert.ok(staleRead, "run four's stale-referenced read fails");
  assert.equal(staleRead.arguments.view, staleView, "the stale read used run two's outdated token");
  assert.match(staleRead.result.text, /^VIEW_STALE: /);
  assert.ok(!staleRead.result.text.includes(FACT_TWO),
    "the stale rejection never serves potentially unrelated page content");
  assert.ok(!staleRead.result.text.includes("context-memory source transcript"),
    "the stale rejection never serves any transcript page");

  const staleResultRequests = requests
    .filter((request) => requestText(request.messages).includes("VIEW_STALE: "));
  assert.ok(staleResultRequests.length > 0,
    "the stale rejection reaches the model in the next request (pair-safe, with its call)");
  for (const request of staleResultRequests) {
    const callIds = new Set();
    for (const message of request.messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "toolCall" && part.name === "read_memory_source") callIds.add(part.id);
        }
      }
    }
    assert.ok(callIds.has(staleRead.id), "the rejected call stays paired with its error result");
  }

  assert.ok(searchedAfterStale, "a fresh search runs after the rejection");
  const freshSearch = searchCalls[2];
  assert.deepEqual(freshSearch.arguments, { terms: ["ORION"] });
  const freshView = /view (sv1-[0-9a-f]+)/.exec(freshSearch.result.text)[1];
  assert.notEqual(freshView, staleView, "the fresh search runs under the changed Memory view");
  const freshRead = readCalls[readCalls.length - 1];
  assert.equal(freshRead.result.isError, false);
  assert.equal(freshRead.arguments.view, freshView);
  assert.ok(freshRead.result.text.includes(FACT_TWO), "the fresh view recovers the same fact");
  assert.ok(answers.some((answer) => answer.includes(FACT_TWO) && answer.includes("Stale view rejected")),
    "run four answers after honest stale rejection and fresh recovery");

  // ── Exactly two compressions, both model-authored, none search-invited ──
  const compactCalls = branch
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .flatMap((entry) => (Array.isArray(entry.message.content) ? entry.message.content : []))
    .filter((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block");
  assert.equal(compactCalls.length, 3, "exactly three compressions were recorded across the session");

  // ── The Memory derivation is intact and multi-block at the end ──
  const { MEMORY_STATE_CUSTOM_TYPE } = await load("../../src/context-memory/format.ts");
  const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
  assert.equal(stateEntries.length, 3, "three accepted Memory state entries were recorded through the public seam");
  const { deriveCurrentMemory } = await load("../../src/context-memory/derive.ts");
  const finalMemory = deriveCurrentMemory(reopenedManager);
  assert.equal(finalMemory.kind, "valid");
  assert.equal(finalMemory.blocks.length, 3, "each append preserved the existing blocks and added one");

  // ── Retrieval copies never become original evidence at the native seam:
  // after the continuation's compression, the retrieval framing that exists
  // only inside search result bodies finds nothing, while the original fact
  // stays recoverable from the Memory sources.
  {
    const evidenceCopySearch = searchCalls.find((call) => call.arguments.terms
      && call.arguments.terms[0] === "Memory source search");
    assert.ok(evidenceCopySearch, "the reopened run issued the evidence-copy search");
    assert.equal(evidenceCopySearch.result.isError, false);
    assert.equal(evidenceCopySearch.result.text.includes("no matches"), true,
      "the retrieval framing matches no original source");
    const marsControl = searchCalls.find((call) => call.arguments.terms
      && call.arguments.terms[0] === "MARS-ROVER");
    assert.ok(marsControl, "the reopened run issued the original-evidence control search");
    assert.equal(marsControl.result.isError, false);
    assert.ok(marsControl.result.text.includes(FACT_ONE),
      "the original fact stays recoverable from the Memory sources");
    assert.ok(answers.some((answer) => answer.includes(FACT_ONE) && answer.includes("Reopen verification complete")),
      "the reopened run answers with the original fact recovered under the applied carrier");
    assert.ok(answers.some((answer) => answer.includes("Recorded the post-interruption compression")),
      "run six ends at the compression acknowledgement");
  }

  console.log("context-memory source-search-native: all assertions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  unsubscribe?.();
  try { session?.dispose(); } catch { /* the session may already be gone */ }
  if (environment) rmSync(environment.root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
