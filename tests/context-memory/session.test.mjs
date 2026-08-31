import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";
import { SessionManager, buildContextEntries } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { MEMORY_FORMAT_TAG, composeMemorySummary } = await load("../../src/context-memory/format.ts");
const { MEMORY_TRANSCRIPT_HEADER } = await load("../../src/context-memory/transcript.ts");

const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

/**
 * #217/#218/#221 Pi SessionManager integration: derivation, source recovery,
 * active-tool synchronization, and the first-block handshake against Pi's real
 * in-memory SessionManager tree; #221 adds the branch-private lifecycle over
 * real persisted files — resume leaf derivation, `/tree` navigation, fork,
 * clone, import-like copies, cross-directory duplicates, session replacement,
 * and ephemeral sessions — always with real uuids, real append semantics, and
 * no Context Memory filesystem write anywhere.
 */

/** The two-block carrying-compaction fixture shared by every lifecycle section. */
function seedValidMemorySession(sm) {
  sm.appendMessage({ role: "user", content: "walk me through the repo structure", timestamp: 1 });
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "one entry point registers each feature module" },
      { type: "toolCall", id: "call-seed-read", name: "read", arguments: { path: "src/index.ts" } },
    ],
    stopReason: "toolUse", timestamp: 2,
  });
  const firstResult = sm.appendMessage({
    role: "toolResult", toolCallId: "call-seed-read", toolName: "read",
    content: [{ type: "text", text: "export default register()" }], isError: false, timestamp: 3,
  });
  const secondUser = sm.appendMessage({ role: "user", content: "now fix the login flow", timestamp: 4 });
  const secondAssistant = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "the session cookie was set after the redirect" }],
    stopReason: "stop", timestamp: 5,
  });
  const keptUser = sm.appendMessage({ role: "user", content: "ship it", timestamp: 6 });
  const blockBodies = [
    "# Repo tour\n\n- index.ts registers each feature module",
    "# Login fix\n\n- session cookie set before the redirect",
  ];
  const compactionId = sm.appendCompaction(
    composeMemorySummary(blockBodies),
    keptUser,
    9000,
    {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: firstResult, markdownBytes: Buffer.byteLength(blockBodies[0], "utf8") },
        { endEntryId: secondAssistant, markdownBytes: Buffer.byteLength(blockBodies[1], "utf8") },
      ],
    },
    true,
  );
  return { secondUser, keptUser, compactionId };
}

/** Rewrite a session JSONL file the way an external in-place edit would. */
function rewriteSessionFile(file, mutate) {
  const entries = readFileSync(file, "utf8").split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  mutate(entries);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
function harness(config = ENABLED_CONFIG) {
  const tools = new Map();
  const events = new Map();
  let active = ["read", "bash"];
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
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => {
      throw new Error("display runtime is not needed for in-memory session derivation");
    },
    reserveTokens: () => 16384,
  });
  return {
    tools, events, registration, activeTools: () => [...active],
    async emit(name, event, ctx) {
      let last;
      for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
      return last;
    },
  };
}

function commandContext(sessionManager) {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager,
    compact() {},
    getContextUsage: () => ({ tokens: 40000, contextWindow: 200000, percent: 20 }),
    getSystemPrompt: () => "",
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
  };
}

try {
  // A real tree: two Memory blocks behind one carrying compaction, then a
  // kept tail with the current request.
  const sm = SessionManager.inMemory("/project");
  assert.equal(sm.isPersisted(), false, "the fixture session is ephemeral");
  assert.equal(sm.getSessionFile(), undefined, "no session file exists");

  const firstUser = sm.appendMessage({ role: "user", content: "walk me through the repo structure", timestamp: 1 });
  const firstAssistant = sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "one entry point registers each feature module" },
      { type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "src/index.ts" } },
    ],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 2,
  });
  const firstResult = sm.appendMessage({
    role: "toolResult", toolCallId: "call-read-1", toolName: "read",
    content: [{ type: "text", text: "export default register()" }], isError: false, timestamp: 3,
  });
  const secondUser = sm.appendMessage({ role: "user", content: "now fix the login flow", timestamp: 4 });
  const secondAssistant = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "the session cookie was set after the redirect" }],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 5,
  });
  const keptUser = sm.appendMessage({ role: "user", content: "ship it", timestamp: 6 });

  const blockBodies = [
    "# Repo tour\n\n- index.ts registers each feature module",
    "# Login fix\n\n- session cookie set before the redirect",
  ];
  const branchBefore = sm.getBranch();
  const byOriginal = new Map(branchBefore.map((entry) => [entry.id, entry]));
  const compactionId = sm.appendCompaction(
    composeMemorySummary(blockBodies),
    byOriginal.get(keptUser).id,
    9000,
    {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: byOriginal.get(firstResult).id, markdownBytes: Buffer.byteLength(blockBodies[0], "utf8") },
        { endEntryId: byOriginal.get(secondAssistant).id, markdownBytes: Buffer.byteLength(blockBodies[1], "utf8") },
      ],
    },
    true,
  );
  assert.ok(compactionId, "the compaction entry received a real id");

  // Pi projects the compaction plus the kept tail — the fixture is realistic.
  const projected = buildContextEntries(sm.getEntries(), sm.getLeafId());
  assert.equal(projected[0].type, "compaction");
  assert.equal(projected[0].id, compactionId);
  assert.equal(projected[1].id, keptUser);

  // ── Derivation and tool activation through the real tree ──

  const session = harness();
  const ctx = commandContext(sm);
  await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.ok(session.activeTools().includes("read_memory_source"),
    "valid Memory on the resumed leaf activates the read tool");

  const snapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
  assert.equal(snapshot.state, "active");
  assert.equal(snapshot.blocks, 2);
  assert.equal(snapshot.rows[0].sources, 3, "block 1 covers the first user/assistant/result trio");
  assert.equal(snapshot.rows[1].sources, 2, "block 2 covers the second user/assistant pair");

  // ── Source recovery through the real tree ──

  const read = session.tools.get("read_memory_source");
  const pages = [];
  let page = 1;
  for (;;) {
    const result = await read.execute(`s:${page}`, { block: 2, page }, undefined, undefined, ctx);
    pages.push(result.content[1].text);
    if (!result.details.hasMore) break;
    assert.match(result.content.at(-1).text, new RegExp(`"block": 2, "page": ${page + 1}`));
    page += 1;
  }
  const transcript = pages.join("");
  assert.ok(transcript.startsWith(MEMORY_TRANSCRIPT_HEADER));
  assert.ok(transcript.includes("now fix the login flow"), "block 2 starts after block 1's end");
  assert.ok(transcript.includes("the session cookie was set after the redirect"));
  assert.ok(!transcript.includes("walk me through the repo structure"), "block 1 sources stay out of block 2");
  assert.ok(!transcript.includes(firstUser), "entry ids never appear");
  assert.ok(!transcript.includes(compactionId));

  const inspected = session.registration.inspect({ block: 1, page: 1 }, sm);
  assert.equal(inspected.ok, true);
  assert.ok(inspected.text.includes("# Repo tour"));
  assert.ok(inspected.text.includes("export default register()"), "block 1 recovers its tool result");

  // ── Tree navigation re-derives from the leaf Pi opens ──

  sm.branch(byOriginal.get(secondUser).id);
  await session.emit("session_tree", { type: "session_tree", newLeafId: secondUser, oldLeafId: sm.getLeafId() }, ctx);
  assert.ok(!session.activeTools().includes("read_memory_source"),
    "navigating before the compaction leaves no current Memory");
  assert.deepEqual(session.registration.snapshot(), { state: "no-memory", ephemeral: true });
  await assert.rejects(
    () => read.execute("s:gone", { block: 1, page: 1 }, undefined, undefined, ctx),
    (error) => {
      assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /);
      return true;
    },
  );

  // Navigating back onto the carrying leaf restores Memory.
  sm.branch(compactionId);
  await session.emit("session_tree", { type: "session_tree", newLeafId: compactionId, oldLeafId: secondUser }, ctx);
  assert.ok(session.activeTools().includes("read_memory_source"));
  assert.equal(session.registration.snapshot({ tokens: 1, contextWindow: 1000 }).state, "active");

  // ── A native compaction appended by Pi degrades Memory to opaque ──

  sm.appendMessage({ role: "user", content: "one more thing", timestamp: 7 });
  sm.appendCompaction("A plain native summary.", keptUser, 4000, undefined, false);
  await session.emit("session_compact", {
    type: "session_compact",
    compactionEntry: sm.getBranch().at(-1),
    fromExtension: false,
    reason: "manual",
    willRetry: false,
  }, ctx);
  assert.deepEqual(session.registration.snapshot(), { state: "opaque", ephemeral: true });
  assert.ok(!session.activeTools().includes("read_memory_source"));

  // The ephemeral session wrote nothing to disk.
  assert.equal(sm.isPersisted(), false);
  assert.equal(sm.getSessionFile(), undefined);

  // ── #218: the first Memory block through the full handshake on a real tree ──

  {
    const dueSession = SessionManager.inMemory("/project");
    const oldUser = dueSession.appendMessage({ role: "user", content: "explore the parser internals", timestamp: 1 });
    const oldAssistant = dueSession.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "the parser walks three bounded phases" },
        { type: "toolCall", id: "call-old", name: "read", arguments: { path: "src/parser.ts" } },
      ],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 2,
    });
    dueSession.appendMessage({
      role: "toolResult", toolCallId: "call-old", toolName: "read",
      content: [{ type: "text", text: "export function parse() {}" }], isError: false, timestamp: 3,
    });
    // A stale submit artifact from an earlier failed handshake stays on the
    // branch but never enters the provider-bound estimate or block sources.
    dueSession.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-stale", name: "submit_memory", arguments: { markdown: "# stale" } }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 4,
    });
    dueSession.appendMessage({
      role: "toolResult", toolCallId: "call-stale", toolName: "submit_memory",
      content: [{ type: "text", text: "SUBMIT_NOT_DUE: no Context Memory compression is due in this run" }], isError: true, timestamp: 5,
    });

    const dueHarness = harness({
      enabled: true,
      compressionThreshold: { tokens: 2500 },
      memoryBudgetPercent: 1,
    });
    const dueCtx = {
      ...commandContext(dueSession),
      getContextUsage: () => ({ tokens: 30000, contextWindow: 200000, percent: 15 }),
    };
    await dueHarness.emit("session_start", { type: "session_start", reason: "startup" }, dueCtx);
    assert.deepEqual(dueHarness.registration.snapshot(), { state: "due", ephemeral: true });

    await dueHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, dueCtx);
    assert.ok(dueHarness.activeTools().includes("submit_memory"),
      "the real-user input activates submit_memory on the real session");

    const requestEntry = dueSession.appendMessage({ role: "user", content: "ship it", timestamp: 6 });
    const submitAssistant = dueSession.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "done — submitting the first Memory block" },
        { type: "toolCall", id: "call-first", name: "submit_memory", arguments: { markdown: "# Parser tour" } },
      ],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 7,
    });
    await dueHarness.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "done — submitting the first Memory block" },
          { type: "toolCall", id: "call-first", name: "submit_memory", arguments: { markdown: "# Parser tour" } },
        ],
      },
    }, dueCtx);

    const body = "# Parser tour\n\n- the parser walks three bounded phases\n- sources recover through read_memory_source";
    const acceptedResult = await dueHarness.tools.get("submit_memory").execute(
      "call-first",
      { markdown: body },
      undefined,
      undefined,
      dueCtx,
    );
    assert.equal(acceptedResult.content[0].text, "Memory candidate accepted; compaction pending.");
    assert.equal(acceptedResult.terminate, true);
    dueSession.appendMessage({
      role: "toolResult", toolCallId: "call-first", toolName: "submit_memory",
      content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], isError: false, timestamp: 8,
    });
    assert.deepEqual(dueHarness.registration.snapshot(), { state: "pending", ephemeral: true });

    const compactCalls = [];
    const settleCtx = { ...dueCtx, compact: () => compactCalls.push(true) };
    await dueHarness.emit("agent_settled", { type: "agent_settled" }, settleCtx);
    assert.equal(compactCalls.length, 1, "settle hands the candidate to Pi's compaction seam once");

    // Drive the takeover exactly like Pi's AgentSession does: a real
    // preparation from the real branch, the returned compaction appended
    // through the real SessionManager, and the saved entry observed.
    const branchBefore = dueSession.getBranch();
    const byId = new Map(branchBefore.map((entry) => [entry.id, entry]));
    const projectedBefore = buildContextEntries(branchBefore, dueSession.getLeafId());
    const tokensBefore = projectedBefore.reduce((sum, entry) => sum + Math.max(1, Math.round(JSON.stringify(entry).length / 4)), 0);
    const takeover = await dueHarness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: requestEntry,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: branchBefore,
      reason: "manual",
      willRetry: false,
      signal: undefined,
    }, dueCtx);
    assert.ok(takeover?.compaction, "the real branch snapshot matches the candidate");
    assert.equal(takeover.compaction.firstKeptEntryId, requestEntry,
      "the current real user entry becomes firstKeptEntryId");
    assert.equal(takeover.compaction.tokensBefore, tokensBefore,
      "the takeover carries Pi's preparation token accounting");

    const savedId = dueSession.appendCompaction(
      takeover.compaction.summary,
      takeover.compaction.firstKeptEntryId,
      takeover.compaction.tokensBefore,
      takeover.compaction.details,
      true,
    );
    const savedEntry = byId.has(savedId) ? undefined : dueSession.getBranch().find((entry) => entry.id === savedId);
    assert.ok(savedEntry, "the real SessionManager saved the compaction entry");
    await dueHarness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: savedEntry,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, dueCtx);

    const committed = dueHarness.registration.snapshot({ tokens: 800, contextWindow: 200000 });
    assert.equal(committed.state, "active");
    assert.equal(committed.blocks, 1);
    assert.ok(dueHarness.activeTools().includes("read_memory_source"),
      "the committed block opens the reading surface");
    assert.ok(!dueHarness.activeTools().includes("submit_memory"));

    // Pi projects the saved compaction plus the kept tail — the run stays recent.
    const projected = buildContextEntries(dueSession.getEntries(), dueSession.getLeafId());
    assert.equal(projected[0].type, "compaction");
    assert.equal(projected[0].id, savedId);
    assert.equal(projected[1].id, requestEntry);
    assert.deepEqual(
      projected.slice(1).map((entry) => entry.type),
      ["message", "message", "message"],
      "the whole current run stays uncompressed after the compaction",
    );

    // The block covers every eligible old entry before the request; the two
    // stale submit artifacts never become source evidence.
    const inspected = dueHarness.registration.inspect({ block: 1, page: 1 }, dueSession);
    assert.equal(inspected.ok, true);
    assert.ok(inspected.text.includes(body), "the block body survives byte-exact");
    assert.ok(inspected.text.includes("explore the parser internals"), "the first eligible entry opens block 1");
    assert.ok(inspected.text.includes("export function parse() {}"), "the tool result recovers");
    assert.ok(!inspected.text.includes("# stale"), "stale submit artifacts stay out of the sources");
    assert.ok(!inspected.text.includes("call-stale"), "protocol call ids never surface");
    assert.ok(!inspected.text.includes(oldUser) && !inspected.text.includes(oldAssistant) && !inspected.text.includes(submitAssistant),
      "entry ids never surface");
    assert.equal(dueSession.isPersisted(), false, "the handshake wrote no sidecar");
    assert.equal(dueSession.getSessionFile(), undefined);
  }

  // ── #219: appending a second block with a byte-stable prefix on a real tree ──

  {
    const sm = SessionManager.inMemory("/project");

    // The old prefix block 1 covers, then round one's request and submit run.
    const oldUser = sm.appendMessage({ role: "user", content: "explore the parser internals", timestamp: 1 });
    const oldAssistant = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "the parser walks three bounded phases" }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 2,
    });
    const firstRequest = sm.appendMessage({ role: "user", content: "ship it", timestamp: 3 });
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "done — submitting the first Memory block" },
        { type: "toolCall", id: "call-first", name: "submit_memory", arguments: { markdown: "# Parser tour" } },
      ],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 4,
    });
    sm.appendMessage({
      role: "toolResult", toolCallId: "call-first", toolName: "submit_memory",
      content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], isError: false, timestamp: 5,
    });
    const blockOne = "# Parser tour\n\n- the parser walks three bounded phases";
    const firstCompaction = sm.appendCompaction(
      composeMemorySummary([blockOne]),
      firstRequest,
      4321,
      {
        format: MEMORY_FORMAT_TAG,
        blocks: [{ endEntryId: oldAssistant, markdownBytes: Buffer.byteLength(blockOne, "utf8") }],
      },
      true,
    );

    // Exact provider-prefix snapshot after the first block: Pi's own
    // projection of the compacted tree renders byte-identically every time.
    const providerPrefixOne = JSON.stringify(sm.buildSessionContext().messages);
    assert.equal(JSON.stringify(sm.buildSessionContext().messages), providerPrefixOne,
      "repeated rendering of the same Memory state is byte-identical");
    const summaryOne = JSON.parse(providerPrefixOne)[0];
    assert.equal(summaryOne.role, "compactionSummary");
    assert.equal(summaryOne.summary, composeMemorySummary([blockOne]));

    // The newly accumulated tail: an ordinary exchange plus a
    // read_memory_source round trip that stays usable now but never enters a
    // later block-source stream.
    sm.appendMessage({ role: "user", content: "now verify the lexer details", timestamp: 6 });
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "checking the first block's exact sources" },
        { type: "toolCall", id: "call-read-src", name: "read_memory_source", arguments: { block: 1, page: 1 } },
      ],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 7,
    });
    sm.appendMessage({
      role: "toolResult", toolCallId: "call-read-src", toolName: "read_memory_source",
      content: [{ type: "text", text: "LEXER-PAGE-NEEDLE" }], isError: false, timestamp: 8,
    });
    const tailAssistant = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "the lexer details are confirmed against the sources" }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 9,
    });

    let usageTokens = 500;
    const appendHarness = harness({
      enabled: true,
      compressionThreshold: { tokens: 2500 },
      memoryBudgetPercent: 1,
    });
    const usageOf = () => ({ tokens: usageTokens, contextWindow: 200000, percent: 5 });
    const appendCtx = { ...commandContext(sm), getContextUsage: usageOf };
    await appendHarness.emit("session_start", { type: "session_start", reason: "resume" }, appendCtx);
    const afterFirst = appendHarness.registration.snapshot({ tokens: 500, contextWindow: 200000 });
    assert.equal(afterFirst.state, "active");
    assert.equal(afterFirst.blocks, 1);
    assert.equal(afterFirst.nextOperation, "append", "one small block appends next");
    assert.ok(!appendHarness.activeTools().includes("submit_memory"),
      "below the threshold no due run opens onto existing Memory");

    usageTokens = 30000;
    await appendHarness.emit("agent_settled", { type: "agent_settled" }, appendCtx);
    await appendHarness.emit("input", { type: "input", text: "ship the lexer block", source: "interactive" }, appendCtx);
    assert.ok(appendHarness.activeTools().includes("submit_memory"),
      "the second due real-user run opens onto existing Memory");
    assert.ok(appendHarness.activeTools().includes("read_memory_source"),
      "the reading surface stays active through the append boundary");

    const secondRequest = sm.appendMessage({ role: "user", content: "ship the lexer block", timestamp: 10 });
    const projectedRequest = sm.buildSessionContext().messages;
    const transformed = await appendHarness.emit("context", { type: "context", messages: projectedRequest }, appendCtx);
    assert.ok(transformed?.messages, "the append run's first provider request is transformed");
    const nonAdvisory = JSON.stringify(
      transformed.messages.filter((message) => message?.customType !== "pi-square.context-memory/advisory"),
    );
    assert.ok(!nonAdvisory.includes("submit_memory"),
      "the round-one submit artifacts leave the append run's provider request");
    assert.ok(nonAdvisory.includes("done — submitting the first Memory block"),
      "ordinary assistant text in the same message survives");
    const advisories = transformed.messages.filter((message) => message?.customType === "pi-square.context-memory/advisory");
    assert.equal(advisories.length, 1, "exactly one advisory");
    assert.ok(advisories[0].content.includes("since the existing Memory blocks"),
      "the append advisory names the accumulated source scope");
    assert.equal(transformed.messages.at(-2).role, "user");
    assert.equal(transformed.messages.at(-2).content, "ship the lexer block",
      "the advisory sits directly after the current user message");

    const blockTwo = "# Lexer verification\n\n- the lexer details were recovered from the first block's sources";
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "done — appending the lexer Memory block" },
        { type: "toolCall", id: "call-second", name: "submit_memory", arguments: { markdown: blockTwo } },
      ],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 11,
    });
    await appendHarness.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "done — appending the lexer Memory block" },
          { type: "toolCall", id: "call-second", name: "submit_memory", arguments: { markdown: blockTwo } },
        ],
      },
    }, appendCtx);
    const acceptedSecond = await appendHarness.tools.get("submit_memory").execute(
      "call-second",
      { markdown: blockTwo },
      undefined,
      undefined,
      appendCtx,
    );
    assert.equal(acceptedSecond.content[0].text, "Memory candidate accepted; compaction pending.");
    sm.appendMessage({
      role: "toolResult", toolCallId: "call-second", toolName: "submit_memory",
      content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], isError: false, timestamp: 12,
    });
    assert.deepEqual(appendHarness.registration.snapshot(), { state: "pending", ephemeral: true });

    const compactCalls = [];
    const settleCtx = { ...appendCtx, compact: () => compactCalls.push(true) };
    await appendHarness.emit("agent_settled", { type: "agent_settled" }, settleCtx);
    assert.equal(compactCalls.length, 1, "the append candidate reaches Pi's seam once");

    const branchBefore = sm.getBranch();
    const projectedBefore = buildContextEntries(branchBefore, sm.getLeafId());
    const tokensBefore = projectedBefore.reduce((sum, entry) => sum + Math.max(1, Math.round(JSON.stringify(entry).length / 4)), 0);
    const takeover = await appendHarness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: secondRequest,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: branchBefore,
      reason: "manual",
      willRetry: false,
      signal: undefined,
    }, appendCtx);
    assert.ok(takeover?.compaction, "the real branch snapshot matches the append candidate");
    assert.equal(takeover.compaction.firstKeptEntryId, secondRequest,
      "the second run's real user entry becomes the retained-tail boundary");
    assert.equal(takeover.compaction.summary, composeMemorySummary([blockOne, blockTwo]));
    assert.ok(takeover.compaction.summary.startsWith(composeMemorySummary([blockOne])),
      "the complete first rendering stays the byte-identical prefix");
    assert.deepEqual(takeover.compaction.details, {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: oldAssistant, markdownBytes: Buffer.byteLength(blockOne, "utf8") },
        { endEntryId: tailAssistant, markdownBytes: Buffer.byteLength(blockTwo, "utf8") },
      ],
    }, "the directory keeps the existing end and appends one new ordered end");

    const secondCompaction = sm.appendCompaction(
      takeover.compaction.summary,
      takeover.compaction.firstKeptEntryId,
      takeover.compaction.tokensBefore,
      takeover.compaction.details,
      true,
    );
    await appendHarness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: sm.getBranch().find((entry) => entry.id === secondCompaction),
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, appendCtx);

    // The complete latest compaction carries all current blocks; the older
    // compaction stays history and never projects simultaneously.
    const branchCompactions = sm.getBranch().filter((entry) => entry.type === "compaction");
    assert.equal(branchCompactions.length, 2);
    const projected = buildContextEntries(sm.getEntries(), sm.getLeafId());
    assert.equal(projected[0].type, "compaction");
    assert.equal(projected[0].id, secondCompaction, "Pi projects the latest carrying compaction");
    assert.ok(!projected.some((entry) => entry.id === firstCompaction),
      "the older Memory compaction is not simultaneously active context");

    // Exact provider-prefix snapshot after the append: repeated rendering is
    // byte-identical, and the new rendering diverges from the old prefix
    // exactly after block one's bytes.
    const providerPrefixTwo = JSON.stringify(sm.buildSessionContext().messages);
    assert.equal(JSON.stringify(sm.buildSessionContext().messages), providerPrefixTwo,
      "repeated rendering after the append is byte-identical");
    const summaryTwo = JSON.parse(providerPrefixTwo)[0];
    assert.equal(summaryTwo.role, "compactionSummary");
    assert.equal(summaryTwo.summary, summaryOne.summary + "\n---\n\n" + blockTwo,
      "append-only divergence begins exactly after the old block prefix");
    assert.equal(summaryTwo.tokensBefore, tokensBefore, "Pi's preparation accounting is carried");

    const committed = appendHarness.registration.snapshot({ tokens: 700, contextWindow: 200000 });
    assert.equal(committed.state, "active");
    assert.equal(committed.blocks, 2);
    assert.equal(committed.stablePrefix, 2);
    assert.equal(committed.nextOperation, "append");
    assert.equal(committed.rows[1].sources, 5,
      "block 2 covers exactly the accumulated eligible entries between the boundaries");

    // Source recovery for the appended block keeps ordinary text and drops
    // every protocol artifact from the accumulated range.
    const read = appendHarness.tools.get("read_memory_source");
    const pages = [];
    let page = 1;
    for (;;) {
      const result = await read.execute(`a:${page}`, { block: 2, page }, undefined, undefined, appendCtx);
      pages.push(result.content[1].text);
      if (!result.details.hasMore) break;
      page += 1;
    }
    const blockTwoTranscript = pages.join("");
    for (const needle of [
      "now verify the lexer details",
      "checking the first block's exact sources",
      "the lexer details are confirmed against the sources",
    ]) {
      assert.ok(blockTwoTranscript.includes(needle), `block 2 sources preserve ${JSON.stringify(needle)}`);
    }
    for (const forbidden of [
      "read_memory_source",
      "LEXER-PAGE-NEEDLE",
      "Memory candidate accepted",
      "explore the parser internals",
      "three bounded phases",
    ]) {
      assert.ok(!blockTwoTranscript.includes(forbidden),
        `block 2 sources never expose ${JSON.stringify(forbidden)}`);
    }
    assert.ok(!blockTwoTranscript.includes(oldUser) && !blockTwoTranscript.includes(tailAssistant),
      "entry ids never surface");

    // Navigating back onto the older compaction re-derives that branch's own
    // one-block Memory; both compactions are never active together.
    sm.branch(firstCompaction);
    await appendHarness.emit("session_tree", {
      type: "session_tree", newLeafId: firstCompaction, oldLeafId: secondCompaction,
    }, appendCtx);
    const olderView = appendHarness.registration.snapshot({ tokens: 100, contextWindow: 200000 });
    assert.equal(olderView.state, "active");
    assert.equal(olderView.blocks, 1, "the older compaction alone carries its own block list");
    sm.branch(secondCompaction);
    await appendHarness.emit("session_tree", {
      type: "session_tree", newLeafId: secondCompaction, oldLeafId: firstCompaction,
    }, appendCtx);
    assert.equal(appendHarness.registration.snapshot({ tokens: 100, contextWindow: 200000 }).blocks, 2);
    assert.equal(sm.isPersisted(), false, "the append handshake wrote no sidecar");
  }

  // ── #221: the registrar never subscribes a cancellable session event ──

  {
    const subscribed = [...session.events.keys()];
    for (const cancellable of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
      assert.ok(!subscribed.includes(cancellable),
        `${cancellable} stays unsubscribed so Context Memory can never block it`);
    }
  }

  // ── #221: real persisted files — resume, fork, clone, import, replacement ──

  const lifecycleRoot = mkdtempSync(join(tmpdir(), "pi-square-memory-lifecycle-"));
  try {
    const dirA = join(lifecycleRoot, "project-a");
    const dirB = join(lifecycleRoot, "project-b");
    const dirD = join(lifecycleRoot, "imports");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirD, { recursive: true });

    // Resume derives from the leaf Pi opens, never from a remembered leaf.
    {
      const source = SessionManager.create("/proj-a", dirA);
      const seed = seedValidMemorySession(source);
      source.branch(seed.secondUser);
      await session.emit("session_tree", {
        type: "session_tree", newLeafId: seed.secondUser, oldLeafId: source.getLeafId(),
      }, commandContext(source));
      assert.equal(session.registration.snapshot().state, "no-memory",
        "the persisted branch before the compaction carries no Memory");

      await session.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, commandContext(source));
      assert.deepEqual(session.registration.snapshot(), { state: "disabled" },
        "shutdown clears the controller entirely");

      const sourceFile = source.getSessionFile();
      const resumed = SessionManager.open(sourceFile, dirA);
      assert.equal(resumed.getLeafId(), seed.compactionId,
        "Pi reopens the file at its last entry, on the carrying path");
      await session.emit("session_start", {
        type: "session_start", reason: "resume", previousSessionFile: sourceFile,
      }, commandContext(resumed));
      const resumedSnapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
      assert.equal(resumedSnapshot.state, "active",
        "resume follows Pi's reopened leaf instead of restoring the navigated (no-Memory) leaf");
      assert.equal(resumedSnapshot.blocks, 2);
      assert.equal(resumedSnapshot.ephemeral, undefined, "a persisted session is not marked ephemeral");
      assert.ok(session.activeTools().includes("read_memory_source"));
      const resumedRead = await session.tools.get("read_memory_source").execute(
        "s:resumed", { block: 1, page: 1 }, undefined, undefined, commandContext(resumed),
      );
      assert.match(resumedRead.content[1].text, /walk me through the repo structure/);
    }

    // Parent and forked copy evolve independently despite identical entry ids.
    {
      const sourceFile = join(dirA, readdirSync(dirA).find((name) => name.endsWith(".jsonl")));
      assert.ok(sourceFile, "the seeded source file exists");
      const forked = SessionManager.forkFrom(sourceFile, "/proj-b", dirB);
      assert.equal(forked.getHeader().parentSession, sourceFile,
        "Pi records the origin path in the copied header");
      assert.equal(forked.getHeader().cwd, "/proj-b");
      assert.deepEqual(
        forked.getBranch().map((entry) => entry.id),
        SessionManager.open(sourceFile, dirA).getBranch().map((entry) => entry.id),
        "the fork carries the copied active path with duplicate entry ids",
      );

      // The copy diverges on its own: a native compaction appended only to it.
      forked.appendMessage({ role: "user", content: "diverge", timestamp: 9 });
      const divergence = SessionManager.open(sourceFile, dirA);
      const keptFromSource = divergence.getBranch().find((entry) => entry.type === "message"
        && entry.message.role === "user" && entry.message.content === "ship it");
      forked.appendCompaction("A plain native summary on the copy.", keptFromSource.id, 4000, undefined, false);
      const forkHarness = harness();
      await forkHarness.emit("session_start", {
        type: "session_start", reason: "fork", previousSessionFile: sourceFile,
      }, commandContext(forked));
      assert.deepEqual(forkHarness.registration.snapshot(), { state: "opaque" },
        "the diverged copy degrades to opaque through its own latest compaction");
      assert.ok(!forkHarness.activeTools().includes("read_memory_source"));

      // The parent, reopened with the same duplicate ids, still derives its own Memory.
      const parentHarness = harness();
      await parentHarness.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(divergence));
      const parentSnapshot = parentHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
      assert.equal(parentSnapshot.state, "active");
      assert.equal(parentSnapshot.blocks, 2);
    }

    // A fork stays self-contained: derivation and source reads survive losing the origin.
    {
      const sourceFile = join(dirA, readdirSync(dirA).find((name) => name.endsWith(".jsonl")));
      const fork1 = SessionManager.forkFrom(sourceFile, "/proj-b", dirB);
      assert.equal(fork1.getHeader().parentSession, sourceFile);
      rmSync(sourceFile, { force: true });
      const fork1Harness = harness();
      await fork1Harness.emit("session_start", {
        type: "session_start", reason: "fork", previousSessionFile: sourceFile,
      }, commandContext(fork1));
      const fork1Snapshot = fork1Harness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
      assert.equal(fork1Snapshot.state, "active");
      assert.equal(fork1Snapshot.blocks, 2);
      assert.ok(fork1Harness.activeTools().includes("read_memory_source"));
      const fork1Read = await fork1Harness.tools.get("read_memory_source").execute(
        "s:fork1", { block: 2, page: 1 }, undefined, undefined, commandContext(fork1),
      );
      assert.match(fork1Read.content[1].text, /now fix the login flow/,
        "source recovery resolves inside the copied tree without the origin file");
    }

    // A clone (createBranchedSession) copies exactly the chosen active path.
    {
      const cloneSrc = SessionManager.create("/proj-clone", dirA);
      const cloneSeed = seedValidMemorySession(cloneSrc);
      const cloneSrcFile = cloneSrc.getSessionFile();

      const carryingClone = SessionManager.open(cloneSrcFile, dirA);
      const cloneFile = carryingClone.createBranchedSession(cloneSeed.compactionId);
      assert.ok(cloneFile, "the persisted clone wrote its own session file");
      assert.equal(carryingClone.getLeafId(), cloneSeed.compactionId);
      const cloneHarness = harness();
      await cloneHarness.emit("session_start", { type: "session_start", reason: "fork" }, commandContext(carryingClone));
      const cloneSnapshot = cloneHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
      assert.equal(cloneSnapshot.state, "active", "the cloned active path carries its Memory self-contained");
      assert.equal(cloneSnapshot.blocks, 2);
      assert.ok(cloneHarness.activeTools().includes("read_memory_source"));

      const earlyClone = SessionManager.open(cloneSrcFile, dirA);
      earlyClone.createBranchedSession(cloneSeed.secondUser);
      assert.equal(earlyClone.getLeafId(), cloneSeed.secondUser);
      const earlyHarness = harness();
      await earlyHarness.emit("session_start", { type: "session_start", reason: "fork" }, commandContext(earlyClone));
      assert.deepEqual(earlyHarness.registration.snapshot(), { state: "no-memory" },
        "a clone taken before the compaction inherits nothing");
      assert.ok(!earlyHarness.activeTools().includes("read_memory_source"));
    }

    // A fork from a source whose active path predates the compaction inherits nothing.
    {
      const preSource = SessionManager.create("/proj-pre", dirA);
      const preSeed = seedValidMemorySession(preSource);
      preSource.branch(preSeed.secondUser);
      preSource.appendMessage({ role: "user", content: "parallel work without Memory", timestamp: 9 });
      preSource.appendMessage({
        role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 10,
      });
      const preFork = SessionManager.forkFrom(preSource.getSessionFile(), "/proj-b", dirB);
      const preHarness = harness();
      await preHarness.emit("session_start", { type: "session_start", reason: "fork" }, commandContext(preFork));
      assert.deepEqual(preHarness.registration.snapshot(), { state: "no-memory" },
        "the forked copy of a pre-compaction path carries no Memory");
      assert.ok(!preHarness.activeTools().includes("read_memory_source"));
      const preSourceHarness = harness();
      await preSourceHarness.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(preSource));
      assert.equal(preSourceHarness.registration.snapshot().state, "no-memory",
        "the source itself derives from its actual pre-compaction leaf");
    }

    // Imported and cross-directory copies validate only their own tree.
    {
      const copySrc = SessionManager.create("/proj-copy", dirA);
      seedValidMemorySession(copySrc);
      const copyFile = copySrc.getSessionFile();

      const importedFile = join(dirD, "imported.jsonl");
      cpSync(copyFile, importedFile);
      const imported = SessionManager.open(importedFile, dirD, "/changed-cwd");
      assert.equal(imported.getCwd(), "/changed-cwd", "an imported copy may run under a different cwd");

      const reheadedFile = join(dirD, "reheaded.jsonl");
      cpSync(copyFile, reheadedFile);
      rewriteSessionFile(reheadedFile, (entries) => {
        const header = entries.find((entry) => entry.type === "session");
        header.id = "reheaded-session-id";
        header.cwd = "/moved-elsewhere";
      });
      const reheaded = SessionManager.open(reheadedFile, dirD);

      // Duplicate entry ids live in three open files at once; each derivation
      // resolves only its own tree.
      const originalReopened = SessionManager.open(copyFile, dirA);
      for (const [label, manager] of [["imported", imported], ["reheaded", reheaded], ["original", originalReopened]]) {
        const localHarness = harness();
        await localHarness.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(manager));
        const localSnapshot = localHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
        assert.equal(localSnapshot.state, "active", `the ${label} copy derives its own valid Memory`);
        assert.equal(localSnapshot.blocks, 2);
        assert.ok(localHarness.activeTools().includes("read_memory_source"), `the ${label} copy opens the read tool`);
      }

      // An in-place corrupted compaction on a copy degrades only the feature.
      const corruptedFile = join(dirD, "corrupted.jsonl");
      cpSync(copyFile, corruptedFile);
      rewriteSessionFile(corruptedFile, (entries) => {
        const compaction = entries.find((entry) => entry.type === "compaction");
        compaction.summary = composeMemorySummary(["# Tampered\n\n- the byte directory no longer matches"]);
      });
      const corrupted = SessionManager.open(corruptedFile, dirD);
      const corruptedHarness = harness();
      await corruptedHarness.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(corrupted));
      assert.deepEqual(corruptedHarness.registration.snapshot(), { state: "opaque" },
        "a corrupted compaction degrades Context Memory only");
      assert.ok(!corruptedHarness.activeTools().includes("read_memory_source"));
      const usable = buildContextEntries(corrupted.getEntries(), corrupted.getLeafId());
      assert.equal(usable[0].type, "compaction",
        "the corrupted copy remains usable as ordinary Pi context");
    }

    // Ephemeral sessions: the same behavior in memory, reported as ephemeral.
    {
      const ephemeral = SessionManager.inMemory("/project");
      const ephSeed = seedValidMemorySession(ephemeral);
      const ephHarness = harness();
      await ephHarness.emit("session_start", { type: "session_start", reason: "startup" }, commandContext(ephemeral));
      const ephSnapshot = ephHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
      assert.equal(ephSnapshot.state, "active");
      assert.equal(ephSnapshot.ephemeral, true, "an ephemeral session is clearly reported");

      ephemeral.branch(ephSeed.secondUser);
      await ephHarness.emit("session_tree", {
        type: "session_tree", newLeafId: ephSeed.secondUser, oldLeafId: ephemeral.getLeafId(),
      }, commandContext(ephemeral));
      assert.deepEqual(ephHarness.registration.snapshot(), { state: "no-memory", ephemeral: true });
      ephemeral.branch(ephSeed.compactionId);
      await ephHarness.emit("session_tree", {
        type: "session_tree", newLeafId: ephSeed.compactionId, oldLeafId: ephemeral.getLeafId(),
      }, commandContext(ephemeral));
      assert.equal(ephHarness.registration.snapshot().state, "active");

      // The in-memory clone follows the same path-copying semantics.
      const ephCarry = SessionManager.inMemory("/project");
      const carrySeed = seedValidMemorySession(ephCarry);
      ephCarry.createBranchedSession(carrySeed.compactionId);
      const carryHarness = harness();
      await carryHarness.emit("session_start", { type: "session_start", reason: "fork" }, commandContext(ephCarry));
      assert.equal(carryHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 }).state, "active");

      const ephEarly = SessionManager.inMemory("/project");
      const earlySeed = seedValidMemorySession(ephEarly);
      ephEarly.createBranchedSession(earlySeed.secondUser);
      const ephEarlyHarness = harness();
      await ephEarlyHarness.emit("session_start", { type: "session_start", reason: "fork" }, commandContext(ephEarly));
      assert.deepEqual(ephEarlyHarness.registration.snapshot(), { state: "no-memory", ephemeral: true });

      assert.equal(ephemeral.getSessionFile(), undefined, "the ephemeral session created no file");
    }

    // Session replacement: transient state never survives into the next session.
    {
      const repSource = SessionManager.inMemory("/project");
      repSource.appendMessage({ role: "user", content: "explore the lifecycle", timestamp: 1 });
      repSource.appendMessage({
        role: "assistant", content: [{ type: "text", text: "the lifecycle follows the leaf" }],
        stopReason: "stop", timestamp: 2,
      });
      const repHarness = harness({
        enabled: true,
        compressionThreshold: { tokens: 2500 },
        memoryBudgetPercent: 1,
      });
      const repCtx = {
        ...commandContext(repSource),
        getContextUsage: () => ({ tokens: 30000, contextWindow: 200000, percent: 15 }),
      };
      await repHarness.emit("session_start", { type: "session_start", reason: "startup" }, repCtx);
      assert.deepEqual(repHarness.registration.snapshot(), { state: "due", ephemeral: true });
      await repHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, repCtx);
      assert.ok(repHarness.activeTools().includes("submit_memory"));
      repSource.appendMessage({ role: "user", content: "ship it", timestamp: 3 });
      await repHarness.emit("message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-rep", name: "submit_memory", arguments: { markdown: "# Replacement" } }],
        },
      }, repCtx);
      await repHarness.tools.get("submit_memory").execute(
        "call-rep", { markdown: "# Replacement\n\n- transient state dies with the session" },
        undefined, undefined, repCtx,
      );
      assert.equal(repHarness.registration.snapshot().state, "pending");

      await repHarness.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, repCtx);
      const replacement = SessionManager.inMemory("/project");
      await repHarness.emit("session_start", { type: "session_start", reason: "new" }, commandContext(replacement));
      assert.deepEqual(repHarness.registration.snapshot(), { state: "due", ephemeral: true },
        "replacement discards the pending candidate and re-derives the new session");
      assert.ok(!repHarness.activeTools().includes("submit_memory"),
        "submit_memory stays inactive until the new session opens its own due run");
      const compacts = [];
      await repHarness.emit("agent_settled", { type: "agent_settled" }, {
        ...commandContext(replacement),
        compact: () => compacts.push(true),
      });
      assert.equal(compacts.length, 0, "a replaced session never compacts the discarded candidate");
    }

    // Context Memory created no sidecar, lock, journal, or cache anywhere.
    {
      const stray = [];
      const walk = (dir) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, item.name);
          if (item.isDirectory()) walk(path);
          else if (!item.name.endsWith(".jsonl")) stray.push(path);
        }
      };
      walk(lifecycleRoot);
      assert.deepEqual(stray, [],
        "only ordinary Pi session files exist; Context Memory wrote no sidecar");
    }
  } finally {
    rmSync(lifecycleRoot, { recursive: true, force: true });
  }

  console.log("context-memory session tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
