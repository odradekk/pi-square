import assert from "node:assert/strict";
import jiti from "jiti";
import { SessionManager, buildContextEntries } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { MEMORY_FORMAT_TAG, composeMemorySummary } = await load("../../src/context-memory/format.ts");
const { MEMORY_TRANSCRIPT_HEADER } = await load("../../src/context-memory/transcript.ts");

const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

/**
 * #217 Pi in-memory session integration: derivation, source recovery, and
 * active-tool synchronization against Pi's real SessionManager tree — real
 * uuids, real append semantics, no filesystem writes.
 */

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
    tools, registration, activeTools: () => [...active],
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
  assert.deepEqual(session.registration.snapshot(), { state: "no-memory" });
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
  assert.deepEqual(session.registration.snapshot(), { state: "opaque" });
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
    assert.deepEqual(dueHarness.registration.snapshot(), { state: "due" });

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
    assert.deepEqual(dueHarness.registration.snapshot(), { state: "pending" });

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

  console.log("context-memory session tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
