import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const {
  MEMORY_BLOCK_SEPARATOR,
  MEMORY_FORMAT_TAG,
  MEMORY_STATE_CUSTOM_TYPE,
  MEMORY_STATE_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
  composeMemorySummary,
} = await load("../../src/context-memory/format.ts");

/**
 * #319 compact_to_memory_block contract: the resident compression tool, the
 * sole-call pairing, every refusal boundary, the recorded v2 state entry, and
 * the request projection — always against a real in-memory Pi SessionManager
 * tree, through the registrar's real event and tool wiring.
 */

const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
const BUDGET_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 1 };
const DISABLED_CONFIG = { enabled: false, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

const RECORDED_SENTENCE =
  "Memory block recorded. The next model request will carry it in place of the covered older conversation.";

const compactCallPart = (id, markdown = "# m") =>
  ({ type: "toolCall", id, name: "compact_to_memory_block", arguments: { markdown } });
const readCallPart = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const assistantWith = (parts, timestamp) =>
  ({ role: "assistant", content: parts, stopReason: "toolUse", timestamp });
const toolResult = (id, name, text, timestamp) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp });

function harness(config = ENABLED_CONFIG, sessionManager) {
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
    registerMessageRenderer() {},
    appendEntry(customType, data) { sessionManager.appendCustomEntry(customType, data); },
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => {
      throw new Error("display runtime is not needed for the compact contract");
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

/** Note the assistant batch exactly like the registrar's message_end handler. */
async function noteBatch(session, ctx, parts) {
  await session.emit("message_end", { type: "message_end", message: { role: "assistant", content: parts } }, ctx);
}

/** Execute one compact call and return its refusal message, failing if it accepted. */
async function refusalMessage(session, ctx, toolCallId, markdown) {
  try {
    await session.tools.get("compact_to_memory_block").execute(toolCallId, { markdown }, undefined, undefined, ctx);
  } catch (error) {
    return error.message;
  }
  assert.fail("the compact call was expected to refuse");
}

const compactTool = (session) => session.tools.get("compact_to_memory_block");
const stateEntriesOf = (sm) => sm.getBranch().filter((entry) => entry.type === "custom"
  && entry.customType === MEMORY_STATE_CUSTOM_TYPE);

try {

  // ── Registration and the resident active-tool contract ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "a fresh short session", timestamp: 1 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);

    assert.deepEqual([...session.tools.keys()].sort(), ["compact_to_memory_block", "read_memory_source"],
      "the registrar registers exactly the resident compression tool and the reading tool");
    assert.ok(!session.tools.has("submit_memory"), "the retired submission name has no alias");

    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.ok(session.activeTools().includes("compact_to_memory_block"),
      "the compression tool is resident from session_start, before any due threshold");
    assert.ok(!session.activeTools().includes("read_memory_source"),
      "no valid Memory yet keeps the reading tool inactive");

    // Acceptance keeps the resident tool and opens the reading surface. Two
    // completed exchanges: the newest anchors the working set, the first
    // becomes the covered source.
    sm.appendMessage({ role: "assistant", content: [readCallPart("r:a", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("r:a", "read", "EVIDENCE-A " + "a".repeat(900), 3));
    sm.appendMessage({ role: "assistant", content: [readCallPart("r:b", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    sm.appendMessage(toolResult("r:b", "read", "EVIDENCE-B " + "b".repeat(900), 5));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("r:c")], stopReason: "toolUse", timestamp: 6 });
    await noteBatch(session, ctx, [compactCallPart("r:c")]);
    const accepted = await compactTool(session).execute(
      "r:c", { markdown: "# Resident digest\n\n- one read complete" }, undefined, undefined, ctx,
    );
    assert.equal(accepted.content[0].text, RECORDED_SENTENCE);
    assert.ok(session.activeTools().includes("compact_to_memory_block"),
      "the compression tool stays resident after acceptance");
    assert.ok(session.activeTools().includes("read_memory_source"),
      "valid recorded Memory activates the reading tool");
  }

  // ── Sole-call rule: the recorded assistant batch must be the call alone ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("s:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("s:1", "read", "EVIDENCE-A " + "a".repeat(800), 3));
    sm.appendMessage({ role: "assistant", content: [readCallPart("s:2", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    sm.appendMessage(toolResult("s:2", "read", "EVIDENCE-B " + "b".repeat(800), 5));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("s:3")], stopReason: "toolUse", timestamp: 6 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    // No assistant batch observed at all.
    assert.match(
      await refusalMessage(session, ctx, "s:3", "# Never recorded"),
      /^COMPACT_NOT_SOAL_TOOL: /,
    );

    // A batch the compression call shares with an ordinary call.
    await noteBatch(session, ctx, [compactCallPart("s:3"), readCallPart("s:9", "c.txt")]);
    assert.match(await refusalMessage(session, ctx, "s:3", "# Shared batch"), /^COMPACT_NOT_SOAL_TOOL: /);

    // A sole batch that does not contain the executed call id.
    await noteBatch(session, ctx, [readCallPart("s:9", "c.txt")]);
    assert.match(await refusalMessage(session, ctx, "s:3", "# Foreign id"), /^COMPACT_NOT_SOAL_TOOL: /);

    assert.deepEqual(stateEntriesOf(sm), [], "no refusal path records a state entry");
  }

  // ── Block body bounds: empty, control characters, and the 16 KiB cap ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("b:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("b:1", "read", "EVIDENCE-A " + "a".repeat(800), 3));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("b:2")], stopReason: "toolUse", timestamp: 4 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("b:2")]);

    for (const [label, body] of [
      ["empty body", ""],
      ["NUL byte", "SECRET-NEEDLE before\u0000after"],
      ["control character", "SECRET-NEEDLE before\u0001after"],
      ["oversize body", "SECRET-NEEDLE " + "x".repeat(16 * 1024)],
    ]) {
      const message = await refusalMessage(session, ctx, "b:2", body);
      assert.match(message, /^BOUND_EXCEEDED: /, label);
      assert.ok(!message.includes("SECRET-NEEDLE"), `${label}: the refusal never echoes the Markdown body`);
    }
    assert.deepEqual(stateEntriesOf(sm), [], "no invalid body records a state entry");
  }

  // ── Working-set selection: what one accepted block covers and retains ──

  {
    const sm = SessionManager.inMemory("/project");
    const task = sm.appendMessage({ role: "user", content: "research task with SECRET-PLAN instructions", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("w:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    const firstResult = sm.appendMessage(toolResult("w:1", "read", "EVIDENCE-A " + "a".repeat(900), 3));
    sm.appendMessage({ role: "assistant", content: [readCallPart("w:2", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    sm.appendMessage(toolResult("w:2", "read", "EVIDENCE-B " + "b".repeat(900), 5));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("w:3")], stopReason: "toolUse", timestamp: 6 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("w:3")]);

    const body = "# Task digest\n\n- both workspace reads are summarized";
    const accepted = await compactTool(session).execute("w:3", { markdown: body }, undefined, undefined, ctx);
    assert.deepEqual(accepted, {
      content: [{ type: "text", text: RECORDED_SENTENCE }],
      details: { recorded: true },
    });

    const states = stateEntriesOf(sm);
    assert.equal(states.length, 1, "exactly one state entry is recorded");
    const leaf = sm.getBranch().at(-1);
    assert.equal(leaf.id, states[0].id, "the state entry lands as the session leaf");
    assert.equal(leaf.customType, MEMORY_STATE_CUSTOM_TYPE);
    assert.equal(leaf.data.format, MEMORY_STATE_FORMAT_TAG, "the v2 state format tag");
    assert.equal(leaf.data.blocks.length, 1);
    assert.equal(leaf.data.blocks[0].markdown, body, "the block body survives byte-exact");
    // The retained working set is anchored at the newest completed ordinary
    // batch (A2's assistant message), so the range ends at the last eligible
    // entry before it — A1's tool result.
    assert.equal(leaf.data.blocks[0].endEntryId, firstResult,
      "the source range ends at the last eligible entry before the working-set anchor");
    assert.deepEqual(leaf.data.blocks[0].retainedEntryIds, [task],
      "the latest user instruction inside the range stays raw in requests");
    assert.equal(session.registration.snapshot().rows[0].sources, 3,
      "the block covers the user task, the first read call, and its result");

    // A second competing call with no new completed work refuses and records nothing.
    await noteBatch(session, ctx, [compactCallPart("w:4")]);
    assert.match(
      await refusalMessage(session, ctx, "w:4", "# Competing digest\n\n- same sources"),
      /^COMPACT_NOT_DUE: /,
    );
    assert.equal(stateEntriesOf(sm).length, 1, "the competing call records no second state entry");
  }

  // ── Source-selection refusals: no work, anchor first, orphan, nothing evictable ──

  {
    // No completed ordinary tool work at all: nothing precedes the latest user
    // instruction, so no source range exists.
    const bare = SessionManager.inMemory("/project");
    bare.appendMessage({ role: "user", content: "only a request, no work yet", timestamp: 1 });
    bare.appendMessage({ role: "assistant", content: [compactCallPart("n:1")], stopReason: "toolUse", timestamp: 2 });
    const bareSession = harness(ENABLED_CONFIG, bare);
    const bareCtx = commandContext(bare);
    await bareSession.emit("session_start", { type: "session_start", reason: "startup" }, bareCtx);
    await noteBatch(bareSession, bareCtx, [compactCallPart("n:1")]);
    assert.match(await refusalMessage(bareSession, bareCtx, "n:1", "# Nothing to compress"), /^COMPACT_NOT_DUE: /);

    // One completed ordinary batch that is itself the anchor and sits at the
    // branch start: there is no eligible source before it.
    const anchored = SessionManager.inMemory("/project");
    anchored.appendMessage({ role: "assistant", content: [readCallPart("n:2", "a.txt")], stopReason: "toolUse", timestamp: 1 });
    anchored.appendMessage(toolResult("n:2", "read", "EVIDENCE-A " + "a".repeat(900), 2));
    anchored.appendMessage({ role: "assistant", content: [compactCallPart("n:3")], stopReason: "toolUse", timestamp: 3 });
    const anchorSession = harness(ENABLED_CONFIG, anchored);
    const anchorCtx = commandContext(anchored);
    await anchorSession.emit("session_start", { type: "session_start", reason: "startup" }, anchorCtx);
    await noteBatch(anchorSession, anchorCtx, [compactCallPart("n:3")]);
    assert.match(await refusalMessage(anchorSession, anchorCtx, "n:3", "# Anchor only"), /^COMPACT_NOT_DUE: /);

    // An orphan tool call inside the would-be range refuses rather than
    // dropping messages to force a fit.
    const orphan = SessionManager.inMemory("/project");
    orphan.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    orphan.appendMessage({ role: "assistant", content: [readCallPart("n:4", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    orphan.appendMessage(toolResult("n:4", "read", "EVIDENCE-A " + "a".repeat(900), 3));
    orphan.appendMessage({ role: "assistant", content: [readCallPart("n:orphan", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    orphan.appendMessage({ role: "assistant", content: [readCallPart("n:5", "c.txt")], stopReason: "toolUse", timestamp: 5 });
    orphan.appendMessage(toolResult("n:5", "read", "EVIDENCE-C " + "c".repeat(900), 6));
    orphan.appendMessage({ role: "assistant", content: [compactCallPart("n:6")], stopReason: "toolUse", timestamp: 7 });
    const orphanSession = harness(ENABLED_CONFIG, orphan);
    const orphanCtx = commandContext(orphan);
    await orphanSession.emit("session_start", { type: "session_start", reason: "startup" }, orphanCtx);
    await noteBatch(orphanSession, orphanCtx, [compactCallPart("n:6")]);
    assert.match(await refusalMessage(orphanSession, orphanCtx, "n:6", "# Split batch"), /^COMPACT_NOT_DUE: /);
    assert.deepEqual(stateEntriesOf(orphan), [], "the orphan refusal records nothing");

    // A protected user instruction as the only in-range content leaves nothing
    // evictable: a source range exists, but it cannot save tokens.
    const protectedOnly = SessionManager.inMemory("/project");
    protectedOnly.appendMessage({ role: "user", content: "protected instruction: keep me raw", timestamp: 1 });
    protectedOnly.appendMessage({ role: "assistant", content: [readCallPart("n:7", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    protectedOnly.appendMessage(toolResult("n:7", "read", "EVIDENCE-A " + "a".repeat(400), 3));
    protectedOnly.appendMessage({ role: "assistant", content: [compactCallPart("n:8")], stopReason: "toolUse", timestamp: 4 });
    const protectedSession = harness(ENABLED_CONFIG, protectedOnly);
    const protectedCtx = commandContext(protectedOnly);
    await protectedSession.emit("session_start", { type: "session_start", reason: "startup" }, protectedCtx);
    await noteBatch(protectedSession, protectedCtx, [compactCallPart("n:8")]);
    assert.match(
      await refusalMessage(protectedSession, protectedCtx, "n:8", "# Instruction only\n\n- nothing evictable"),
      /^NO_NET_BENEFIT: /,
    );
    assert.deepEqual(stateEntriesOf(protectedOnly), []);
  }

  // ── Memory-state refusals: opaque Memory, half budget, total budget, net benefit ──

  // Current Memory opaque: a native compaction without the structured details.
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "explore the parser", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("o:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("o:1", "read", "EVIDENCE-A " + "a".repeat(400), 3));
    const kept = sm.appendMessage({ role: "user", content: "ship it", timestamp: 4 });
    sm.appendCompaction("A plain native summary.", kept, 9000, undefined, false);
    sm.appendMessage({ role: "user", content: "one more round", timestamp: 5 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("o:2", "b.txt")], stopReason: "toolUse", timestamp: 6 });
    sm.appendMessage(toolResult("o:2", "read", "EVIDENCE-B " + "b".repeat(400), 7));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("o:3")], stopReason: "toolUse", timestamp: 8 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    assert.equal(session.registration.snapshot().state, "opaque");
    await noteBatch(session, ctx, [compactCallPart("o:3")]);
    assert.match(await refusalMessage(session, ctx, "o:3", "# Over opaque Memory"), /^MEMORY_CHANGED: /);
    assert.deepEqual(stateEntriesOf(sm), []);
  }

  // Rendered Memory above half its budget: the append is refused pending the
  // (unavailable) suffix rebuild.
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "explore the parser", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("h:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    const end = sm.appendMessage(toolResult("h:1", "read", "EVIDENCE-A " + "a".repeat(400), 3));
    const kept = sm.appendMessage({ role: "user", content: "ship it", timestamp: 4 });
    const blockOne = "# Heavy block\n\n" + "h".repeat(8000);
    sm.appendCompaction(composeMemorySummary([blockOne]), kept, 9000, {
      format: MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: end, markdownBytes: Buffer.byteLength(blockOne, "utf8") }],
    }, true);
    sm.appendMessage({ role: "user", content: "one more round", timestamp: 5 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("h:2", "b.txt")], stopReason: "toolUse", timestamp: 6 });
    sm.appendMessage(toolResult("h:2", "read", "EVIDENCE-B " + "b".repeat(400), 7));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("h:3")], stopReason: "toolUse", timestamp: 8 });
    const session = harness(BUDGET_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("h:3")]);
    assert.match(await refusalMessage(session, ctx, "h:3", "# Small append"), /^MAINTENANCE_PENDING: /);
    assert.deepEqual(stateEntriesOf(sm), []);
  }

  // Total rendered Memory over budget: a small existing base plus one huge new
  // block refuses on the budget before anything is recorded.
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "explore the parser", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("t:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    const end = sm.appendMessage(toolResult("t:1", "read", "EVIDENCE-A " + "a".repeat(400), 3));
    const kept = sm.appendMessage({ role: "user", content: "ship it", timestamp: 4 });
    const blockOne = "# Small base\n\n- tiny";
    sm.appendCompaction(composeMemorySummary([blockOne]), kept, 9000, {
      format: MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: end, markdownBytes: Buffer.byteLength(blockOne, "utf8") }],
    }, true);
    sm.appendMessage({ role: "user", content: "one more round of accumulating verification work", timestamp: 5 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("t:2", "b.txt")], stopReason: "toolUse", timestamp: 6 });
    sm.appendMessage(toolResult("t:2", "read", "EVIDENCE-B " + "b".repeat(900), 7));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("t:3")], stopReason: "toolUse", timestamp: 8 });
    const session = harness(BUDGET_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("t:3")]);
    const message = await refusalMessage(session, ctx, "t:3", "y".repeat(15000));
    assert.match(message, /^BOUND_EXCEEDED: /);
    assert.ok(!message.includes("yyyy"), "the budget refusal never echoes the body");
    assert.deepEqual(stateEntriesOf(sm), []);
  }

  // Tiny sources and a large block: no net benefit on the next request.
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    sm.appendMessage(assistantWith([{ type: "text", text: "ok" }, readCallPart("g:1", "a.txt")], 2));
    sm.appendMessage(toolResult("g:1", "read", "A", 3));
    sm.appendMessage({ role: "assistant", content: [readCallPart("g:2", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    sm.appendMessage(toolResult("g:2", "read", "B", 5));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("g:3")], stopReason: "toolUse", timestamp: 6 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("g:3")]);
    const body = "# Heavy digest\n\n" + "- padding line that keeps the block large\n".repeat(28);
    const message = await refusalMessage(session, ctx, "g:3", body);
    assert.match(message, /^NO_NET_BENEFIT: /);
    assert.ok(!message.includes("padding line"), "the net-benefit refusal never echoes the body");
    assert.deepEqual(stateEntriesOf(sm), []);
  }

  // ── Request projection: eviction, carrier, trailing pair, reading artifacts ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("p:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("p:1", "read", "EVIDENCE-A " + "a".repeat(900), 3));
    sm.appendMessage({ role: "assistant", content: [readCallPart("p:2", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    sm.appendMessage(toolResult("p:2", "read", "EVIDENCE-B " + "b".repeat(900), 5));
    // A read_memory_source round trip stays inside the retained working set.
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "p:src", name: "read_memory_source", arguments: { block: 1, page: 1 } }],
      stopReason: "toolUse", timestamp: 6,
    });
    sm.appendMessage(toolResult("p:src", "read_memory_source", "SOURCE-PAGE-NEEDLE the original conversation", 7));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("p:3")], stopReason: "toolUse", timestamp: 8 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("p:3")]);
    const body = "# Task digest\n\n- KEY-FACT-NEEDLE both reads are summarized";
    await compactTool(session).execute("p:3", { markdown: body }, undefined, undefined, ctx);
    sm.appendMessage(toolResult("p:3", "compact_to_memory_block", RECORDED_SENTENCE, 9));

    const native = sm.buildSessionContext().messages;
    const transformed = await session.emit("context", { type: "context", messages: native }, ctx);
    assert.ok(transformed && Array.isArray(transformed.messages), "the projection transforms the native request");

    const carriers = transformed.messages.filter((message) => message?.customType === "pi-square.context-memory/blocks");
    assert.equal(carriers.length, 1, "exactly one Memory carrier enters the request");
    const carrier = carriers[0];
    assert.equal(carrier.role, "custom");
    assert.equal(carrier.display, false);
    const parts = carrier.content.map((part) => part.text);
    assert.deepEqual(parts, [MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR + body],
      "the carrier parts are the wrapper then one byte-exact part per block");

    const text = JSON.stringify(transformed.messages);
    assert.ok(!text.includes("EVIDENCE-A"), "the covered first read left the request");
    assert.ok(text.includes("EVIDENCE-B"), "the working set's own read stays raw");
    assert.ok(text.includes("research task"), "the retained user instruction stays present");
    assert.equal((text.match(/KEY-FACT-NEEDLE/g) ?? []).length, 1,
      "the block body appears exactly once — inside the carrier");
    assert.ok(text.includes("SOURCE-PAGE-NEEDLE"), "read_memory_source artifacts stay visible");

    // The trailing compact pair survives whole with stubbed arguments.
    const trailingCall = transformed.messages.at(-2);
    assert.equal(trailingCall.role, "assistant");
    const callPart = trailingCall.content.find((part) => part.type === "toolCall");
    assert.equal(callPart.name, "compact_to_memory_block");
    assert.deepEqual(callPart.arguments, { markdown: "(this Memory block is carried in full above)" });
    assert.equal(transformed.messages.at(-1).role, "toolResult");

    // An upstream modification inside the evicted range refuses the
    // application: no carrier appears and the request passes through unchanged.
    const tampered = structuredClone(native);
    tampered[1] = { ...tampered[1], content: [{ type: "text", text: "TAMPERED upstream edit" }, ...tampered[1].content.slice(1)] };
    const refused = await session.emit("context", { type: "context", messages: tampered }, ctx);
    assert.ok(!refused.messages.some((message) => message?.customType === "pi-square.context-memory/blocks"),
      "no carrier appears for an upstream-modified request");
    assert.deepEqual(refused.messages, tampered, "the modified messages pass through unchanged");

    // A foreign insertion elsewhere in the request does not block the
    // application and is kept in place.
    const foreign = { role: "custom", customType: "foreign/notice", content: "a foreign injected notice", display: true, timestamp: 10 };
    const withForeign = [...structuredClone(native)];
    withForeign.splice(4, 0, foreign);
    const tolerated = await session.emit("context", { type: "context", messages: withForeign }, ctx);
    assert.equal(
      tolerated.messages.filter((message) => message?.customType === "pi-square.context-memory/blocks").length,
      1,
      "the application still succeeds beside a foreign insertion",
    );
    const toleratedText = JSON.stringify(tolerated.messages);
    assert.ok(toleratedText.includes("a foreign injected notice"), "the foreign message is kept in place");
    assert.ok(!toleratedText.includes("EVIDENCE-A"), "the eviction still applies");
  }

  // ── Second append after new work: byte-stable prefix, two carrier parts ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("d:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("d:1", "read", "EVIDENCE-A " + "a".repeat(900), 3));
    sm.appendMessage({ role: "assistant", content: [readCallPart("d:2", "b.txt")], stopReason: "toolUse", timestamp: 4 });
    sm.appendMessage(toolResult("d:2", "read", "EVIDENCE-B " + "b".repeat(900), 5));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("d:3")], stopReason: "toolUse", timestamp: 6 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("d:3")]);
    const bodyOne = "# First digest\n\n- workspace reads complete";
    const first = await compactTool(session).execute("d:3", { markdown: bodyOne }, undefined, undefined, ctx);
    const stateOne = sm.getBranch().at(-1);
    sm.appendMessage(toolResult("d:3", "compact_to_memory_block", first.content[0].text, 7));

    // New completed ordinary work accumulates after the recording.
    sm.appendMessage({ role: "user", content: "round two", timestamp: 8 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("d:4", "c.txt")], stopReason: "toolUse", timestamp: 9 });
    sm.appendMessage(toolResult("d:4", "read", "EVIDENCE-C " + "c".repeat(900), 10));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("d:5")], stopReason: "toolUse", timestamp: 11 });
    await noteBatch(session, ctx, [compactCallPart("d:5")]);
    const bodyTwo = "# Second digest\n\n- round two verified";
    const second = await compactTool(session).execute("d:5", { markdown: bodyTwo }, undefined, undefined, ctx);
    assert.equal(second.content[0].text, RECORDED_SENTENCE);
    sm.appendMessage(toolResult("d:5", "compact_to_memory_block", second.content[0].text, 12));

    assert.equal(stateEntriesOf(sm).length, 2, "two state entries exist after two recordings");
    const stateTwo = stateEntriesOf(sm).at(-1);
    assert.equal(stateTwo.data.blocks.length, 2);
    assert.deepEqual(stateTwo.data.blocks[0], stateOne.data.blocks[0],
      "the first recording survives as the byte-exact stable prefix");
    assert.equal(stateTwo.data.blocks[1].markdown, bodyTwo);
    assert.equal(stateTwo.data.baseCompactionId, undefined, "no v1 base exists on this branch");

    const transformed = await session.emit("context", { type: "context", messages: sm.buildSessionContext().messages }, ctx);
    const carriers = transformed.messages.filter((message) => message?.customType === "pi-square.context-memory/blocks");
    assert.equal(carriers.length, 1);
    const parts = carriers[0].content.map((part) => part.text);
    assert.deepEqual(parts, [MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR + bodyOne, MEMORY_BLOCK_SEPARATOR + bodyTwo],
      "the carrier carries one byte-exact part per block, prefix first");
    const text = JSON.stringify(transformed.messages);
    assert.ok(!text.includes("EVIDENCE-A") && !text.includes("EVIDENCE-B"),
      "both recordings' covered sources left the request");
    assert.ok(text.includes("round two") && text.includes("EVIDENCE-C"),
      "the retained working set stays raw");
  }

  // ── Append over a v1 compaction-carried Memory ──
  // The state entry records baseCompactionId and both blocks. Note: the
  // recorded entry does not itself derive as a valid state carrier — the v1
  // prefix block's end predates the base compaction, which deriveStateBlocks
  // rejects — so the observable derivation degrades to the read-only v1
  // baseline and the projection is the #297 v1 blocks projection. The asserts
  // below pin that actual behavior; see the reported src discrepancy.
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "explore the deployment flow", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("v:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    const firstEnd = sm.appendMessage(toolResult("v:1", "read", "EVIDENCE-A " + "a".repeat(300), 3));
    const kept = sm.appendMessage({ role: "user", content: "now summarize the flow", timestamp: 4 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "V1-TAIL-NEEDLE " + "t".repeat(800) }],
      stopReason: "stop", timestamp: 5,
    });
    const blockOne = "# Deploy tour\n\n- the deploy script pushes then verifies";
    const compactionId = sm.appendCompaction(composeMemorySummary([blockOne]), kept, 9000, {
      format: MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: firstEnd, markdownBytes: Buffer.byteLength(blockOne, "utf8") }],
    }, true);
    const tailUser = sm.appendMessage({ role: "user", content: "one more round please", timestamp: 6 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("v:2", "b.txt")], stopReason: "toolUse", timestamp: 7 });
    sm.appendMessage(toolResult("v:2", "read", "EVIDENCE-B " + "b".repeat(300), 8));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("v:3")], stopReason: "toolUse", timestamp: 9 });
    const session = harness(ENABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await noteBatch(session, ctx, [compactCallPart("v:3")]);
    const bodyTwo = "# Round two\n\n- ship the verified summary";
    const accepted = await compactTool(session).execute("v:3", { markdown: bodyTwo }, undefined, undefined, ctx);
    assert.equal(accepted.content[0].text, RECORDED_SENTENCE);

    const state = sm.getBranch().at(-1);
    assert.equal(state.customType, MEMORY_STATE_CUSTOM_TYPE);
    assert.equal(state.data.baseCompactionId, compactionId,
      "the state entry records the v1 base compaction");
    assert.equal(state.data.blocks.length, 2);
    assert.equal(state.data.blocks[0].markdown, blockOne, "the v1 prefix block survives byte-exact");
    assert.deepEqual(state.data.blocks[0].retainedEntryIds, []);
    assert.equal(state.data.blocks[1].markdown, bodyTwo);
    assert.deepEqual(state.data.blocks[1].retainedEntryIds, [tailUser],
      "the newest in-range user instruction stays raw in requests");

    // Observable derivation: the inherited v1 prefix reproduces the base's
    // own block list exactly, so the state entry derives with both blocks.
    const snapshot = session.registration.snapshot();
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.carrier, "state");
    assert.equal(snapshot.blocks, 2);

    sm.appendMessage(toolResult("v:3", "compact_to_memory_block", accepted.content[0].text, 10));
    const transformed = await session.emit("context", { type: "context", messages: sm.buildSessionContext().messages }, ctx);
    assert.ok(!transformed.messages.some((message) => message.role === "compactionSummary"),
      "the base compaction's summary message is replaced, never duplicated");
    const carriers = transformed.messages.filter((message) => message?.customType === "pi-square.context-memory/blocks");
    assert.equal(carriers.length, 1, "one complete carrier holds the whole Memory");
    const parts = carriers[0].content.map((part) => part.text);
    assert.equal(parts[0], MEMORY_SUMMARY_WRAPPER, "the leading part carries the fixed wrapper");
    assert.ok(parts.includes(MEMORY_BLOCK_SEPARATOR + blockOne),
      "the inherited v1 block body is one byte-exact part");
    assert.ok(parts.includes(MEMORY_BLOCK_SEPARATOR + bodyTwo),
      "the appended block body is one byte-exact part");
    assert.ok(!JSON.stringify(transformed.messages).includes("V1-TAIL-NEEDLE"),
      "the appended block covers the v1 kept tail that now falls inside its range");
    assert.ok(JSON.stringify(transformed.messages).includes("one more round please"),
      "the newest retained user instruction stays present");
  }

  // ── A tampered inherited prefix never derives: the base stays the baseline ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "explore the deployment flow", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("t:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    const firstEnd = sm.appendMessage(toolResult("t:1", "read", "EVIDENCE-A " + "a".repeat(300), 3));
    const kept = sm.appendMessage({ role: "user", content: "now summarize the flow", timestamp: 4 });
    const blockOne = "# Deploy tour\n\n- the deploy script pushes then verifies";
    const compactionId = sm.appendCompaction(composeMemorySummary([blockOne]), kept, 9000, {
      format: MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: firstEnd, markdownBytes: Buffer.byteLength(blockOne, "utf8") }],
    }, true);
    const tamperedEnd = sm.appendMessage({ role: "user", content: "later round", timestamp: 5 });
    const recordState = (markdown) => sm.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, {
      format: MEMORY_STATE_FORMAT_TAG,
      baseCompactionId: compactionId,
      blocks: [
        { endEntryId: firstEnd, markdown, retainedEntryIds: [] },
        { endEntryId: tamperedEnd, markdown: "# Later\n\n- round two", retainedEntryIds: [] },
      ],
    });
    recordState(blockOne + " rewritten");
    const session = harness(ENABLED_CONFIG, sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(sm));
    let snapshot = session.registration.snapshot();
    assert.equal(snapshot.carrier, "compaction",
      "a rewritten inherited prefix block invalidates the whole state entry");
    assert.equal(snapshot.blocks, 1, "derivation degrades to the v1 baseline, strictly less coverage");
  }

  // ── Default-off: no projection and no compression ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "research task", timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [readCallPart("f:1", "a.txt")], stopReason: "toolUse", timestamp: 2 });
    sm.appendMessage(toolResult("f:1", "read", "EVIDENCE-A " + "a".repeat(900), 3));
    sm.appendMessage({ role: "assistant", content: [compactCallPart("f:2")], stopReason: "toolUse", timestamp: 4 });
    const session = harness(DISABLED_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.ok(!session.activeTools().includes("compact_to_memory_block"),
      "a disabled configuration keeps the compression tool inactive");
    assert.equal(
      await session.emit("context", { type: "context", messages: sm.buildSessionContext().messages }, ctx),
      undefined,
      "a disabled configuration installs no request projection",
    );
    await noteBatch(session, ctx, [compactCallPart("f:2")]);
    assert.match(await refusalMessage(session, ctx, "f:2", "# Disabled"), /^COMPACT_NOT_AVAILABLE: /);
    assert.deepEqual(stateEntriesOf(sm), []);
  }

  console.log("context-memory compact tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
