import assert from "node:assert/strict";
import { SessionManager, buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const {
  MEMORY_BLOCK_SEPARATOR,
  MEMORY_STATE_CUSTOM_TYPE,
  MEMORY_STATE_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
} = await load("../../src/context-memory/format.ts");
const { selectRebuildSuffix, firstFullyServableBlockIndex } = await load("../../src/context-memory/controller.ts");
const { renderedMemoryTokens } = await load("../../src/context-memory/controller.ts");

/**
 * #321 suffix rebuild: the deterministic contract through the registrar
 * harness over a real in-memory Pi SessionManager — suffix selection, the
 * rebuild-serving projection (complete originals raw, summaries absent,
 * prefix byte-stable), deferred and re-scoped requests, acceptance with the
 * fixed retained union, the next-request replacement, the empty-prefix
 * rebuild, and the honest scale limit with window recovery.
 */

const RECORDED_SENTENCE =
  "Memory block recorded. The next model request will carry it in place of the covered older conversation.";
const REBUILD_ADVISORY_NEEDLE = "rebuilds the newest Memory suffix";
const APPEND_ADVISORY_NEEDLE = "compression is due";

const CONTEXT_WINDOW = 40_000;
const SMALL_WINDOW = 24_000;
const CONFIG = { enabled: true, compressionThreshold: { tokens: 500 }, memoryBudgetPercent: 1 };

const compactCallPart = (id, markdown = "# m") =>
  ({ type: "toolCall", id, name: "compact_to_memory_block", arguments: { markdown } });
const readCallPart = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const assistantWith = (parts, timestamp) =>
  ({ role: "assistant", content: parts, stopReason: "toolUse", timestamp });
const toolResult = (id, name, text, timestamp) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp });

function harness(config = CONFIG, sessionManager) {
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
      throw new Error("display runtime is not needed for the suffix-rebuild contract");
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

function commandContext(sessionManager, contextWindow = CONTEXT_WINDOW) {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager,
    compact() {},
    getContextUsage: () => ({ tokens: Math.round(contextWindow / 2), contextWindow, percent: 50 }),
    getSystemPrompt: () => "",
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
  };
}

async function noteBatch(session, ctx, parts) {
  await session.emit("message_end", { type: "message_end", message: { role: "assistant", content: parts } }, ctx);
}

async function serveContext(session, sm, ctx, transform) {
  const native = structuredClone(buildContextEntries(sm.getBranch(), sm.getLeafId()).flatMap(sessionEntryToContextMessages));
  const messages = transform ? transform(native) : native;
  const result = await session.emit("context", { type: "context", messages }, ctx);
  return result === undefined ? messages : result.messages;
}

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

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

function carrierMessages(messages) {
  return messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
}

/** One completed ordinary read round; returns the result entry id. */
function appendReadRound(sm, id, path, text, timestamp) {
  sm.appendMessage(assistantWith([readCallPart(id, path)], timestamp));
  return sm.appendMessage(toolResult(id, "read", text, timestamp + 1));
}

try {
  // ── Pure suffix selection: shortest newest suffix, prefix within half ──
  {
    const bodies = ["a".repeat(150), "b".repeat(150), "c".repeat(150), "d".repeat(150)];
    const half = Math.round((CONTEXT_WINDOW * 1) / 100) / 2; // 200 tokens
    // Whole list renders above half; the three-block prefix also does; the
    // two-block prefix fits: the shortest suffix that fits is 2 blocks.
    assert.ok(renderedMemoryTokens(bodies) > half);
    assert.ok(renderedMemoryTokens(bodies.slice(0, 3)) > half);
    assert.ok(renderedMemoryTokens(bodies.slice(0, 2)) <= half);
    assert.deepEqual(selectRebuildSuffix(bodies, half, 0), { prefixCount: 2, suffixCount: 2 });
    // A single block above half rebuilds everything: the empty prefix is
    // just the wrapper and always fits.
    assert.deepEqual(selectRebuildSuffix(["x".repeat(700)], half, 0), { prefixCount: 0, suffixCount: 1 });
    // The recordable floor: no prefix within the minimum still returns it —
    // the invariant prefix is never rewritten to force a fit.
    assert.deepEqual(selectRebuildSuffix(bodies, half, 3), { prefixCount: 3, suffixCount: 1 });
    // Nothing is rebuildable when every block must stay in the prefix.
    assert.equal(selectRebuildSuffix(bodies, half, 4), null);
  }

  // ── Servability floor: blocks below a compaction's kept boundary ──
  {
    const sm = SessionManager.inMemory("/project");
    const early = appendReadRound(sm, "s:1", "a.txt", "early", 1);
    const kept = sm.appendMessage({ role: "user", content: "kept boundary", timestamp: 3 });
    sm.appendCompaction("summary", kept, 9000, undefined, true);
    const late = appendReadRound(sm, "s:2", "b.txt", "late", 5);
    const later = appendReadRound(sm, "s:3", "c.txt", "later", 7);
    const branch = [...sm.getBranch()];
    assert.equal(firstFullyServableBlockIndex(branch, [{ endEntryId: early }, { endEntryId: late }]), 1,
      "a block whose range starts below the kept boundary can never be served");
    assert.equal(firstFullyServableBlockIndex(branch, [{ endEntryId: early }, { endEntryId: late }, { endEntryId: later }]), 1,
      "every block from the first fully-servable index on is servable");
    const plain = SessionManager.inMemory("/project");
    appendReadRound(plain, "p:1", "a.txt", "no compaction", 1);
    assert.equal(firstFullyServableBlockIndex([...plain.getBranch()], [{ endEntryId: "missing" }]), 0,
      "without a compaction every block is servable");
  }

  // ── The rebuild-serving projection and acceptance over two seeded blocks ──
  {
    const sm = SessionManager.inMemory("/project");
    const userOne = sm.appendMessage({ role: "user", content: "task instruction one", timestamp: 1 });
    const endA = appendReadRound(sm, "r:1", "a.txt", "EVIDENCE-A " + "a".repeat(400), 2);
    const userTwo = sm.appendMessage({ role: "user", content: "protected follow-up instruction", timestamp: 4 });
    const endB = appendReadRound(sm, "r:2", "b.txt", "EVIDENCE-B " + "b".repeat(400), 5);
    const endC = appendReadRound(sm, "r:3", "c.txt", "EVIDENCE-C " + "c".repeat(400), 7);
    const blockOne = "# Block one\n\n" + "one".repeat(60);
    const blockTwo = "# Block two\n\nSUFFIX-TWO-NEEDLE " + "two".repeat(160);
    sm.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, {
      format: MEMORY_STATE_FORMAT_TAG,
      blocks: [
        { endEntryId: endA, markdown: blockOne, retainedEntryIds: [userOne] },
        { endEntryId: endC, markdown: blockTwo, retainedEntryIds: [userTwo] },
      ],
    });
    // New eligible history after the blocks, then the working set.
    const endD = appendReadRound(sm, "r:4", "d.txt", "EVIDENCE-D " + "d".repeat(400), 9);
    const endE = appendReadRound(sm, "r:5", "e.txt", "EVIDENCE-E " + "e".repeat(400), 11);
    const userThree = sm.appendMessage({ role: "user", content: "later instruction that moves the protection zone", timestamp: 13 });
    const endF = appendReadRound(sm, "r:6", "f.txt", "EVIDENCE-F working set", 14);

    const session = harness(CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

    // The first due request opens the rebuild: the suffix (block two) leaves
    // the carrier, its complete originals return raw, the prefix carrier
    // stays byte-exact, and the rebuild advisory rides exactly once.
    const servedOne = await serveContext(session, sm, ctx);
    let servedText = requestText(servedOne);
    assert.ok(servedText.includes(REBUILD_ADVISORY_NEEDLE), "the rebuild advisory rides the due request");
    assert.ok(!servedText.includes("SUFFIX-TWO-NEEDLE"), "the selected suffix's summary is absent while its sources are raw");
    for (const needle of ["EVIDENCE-B", "EVIDENCE-C", "EVIDENCE-D", "EVIDENCE-E"]) {
      assert.ok(servedText.includes(needle), `the suffix originals stay raw in the served request (${needle})`);
    }
    assert.ok(!servedText.includes("EVIDENCE-A"), "the prefix's covered original stays evicted");
    assert.ok(servedText.includes("task instruction one") && servedText.includes("protected follow-up instruction"),
      "retained instructions stay raw");
    let carriers = carrierMessages(servedOne);
    assert.equal(carriers.length, 1, "exactly one carrier message");
    let parts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.equal(parts[0], MEMORY_SUMMARY_WRAPPER);
    assert.equal(parts[1], `${MEMORY_BLOCK_SEPARATOR}${blockOne}`, "the prefix carrier part is byte-exact");
    assert.equal(parts.length, 2, "the carrier carries only the unselected prefix");
    const advisoryCount = (messages) => messages.filter((m) => messageText(m).includes(APPEND_ADVISORY_NEEDLE)).length;
    assert.equal(advisoryCount(servedOne), 1, "one advisory instance, not a growing tail");
    const snapshotPending = session.registration.snapshot();
    assert.equal(snapshotPending.state, "active");
    assert.equal(snapshotPending.maintenance.operation, "rebuild");
    assert.equal(snapshotPending.maintenance.suffixBlocks, 1);
    assert.ok(snapshotPending.maintenance.sources >= 4, "the pinned rebuild range spans suffix originals plus new history");
    assert.notEqual(snapshotPending.scaleLimit, true);

    // Deferred submission across further requests: the serving is identical
    // in content and never accumulates.
    for (let i = 0; i < 3; i++) {
      const again = await serveContext(session, sm, ctx);
      const text = requestText(again);
      assert.ok(text.includes(REBUILD_ADVISORY_NEEDLE) && !text.includes("SUFFIX-TWO-NEEDLE"));
      assert.ok(text.includes("EVIDENCE-B") && text.includes("EVIDENCE-C"));
      assert.equal(advisoryCount(again), 1);
      assert.equal(carrierMessages(again).length, 1);
      const againParts = carrierMessages(again)[0].content.filter((p) => p?.type === "text").map((p) => p.text);
      assert.equal(againParts[1], `${MEMORY_BLOCK_SEPARATOR}${blockOne}`);
    }

    // Real growth re-scopes the request only at the served boundary: the
    // just-completed round stays the working set, and the round before it
    // joins the invited range in that very request — never silently before.
    const sourcesBefore = session.registration.snapshot().maintenance.sources;
    appendReadRound(sm, "r:7", "g.txt", "EVIDENCE-G growth round", 17);
    const servedRescope = await serveContext(session, sm, ctx);
    const rescopeText = requestText(servedRescope);
    assert.ok(rescopeText.includes("EVIDENCE-F"),
      "the completed f round joins the invited range through the served re-scope");
    assert.ok(rescopeText.includes("EVIDENCE-G"), "the newest round stays the uncompressed working set");
    assert.ok(session.registration.snapshot().maintenance.sources > sourcesBefore,
      "the pinned range re-scoped onto the growth");
    assert.equal(advisoryCount(servedRescope), 1);

    // Acceptance: the sole call replaces the suffix with one block spanning
    // its originals plus the new history. The retained union keeps every
    // earlier acceptance's protection — user two stays retained even though
    // the later user three moved the recent zone — and the kept prefix is
    // byte-identical.
    const rebuilt = "# Rebuilt block\n\nREBUILT-NEEDLE " + "rb".repeat(40);
    await noteBatch(session, ctx, [compactCallPart("rb:1", rebuilt)]);
    const accepted = await compactTool(session).execute("rb:1", { markdown: rebuilt }, undefined, undefined, ctx);
    assert.equal(accepted.details.recorded, true);
    const states = stateEntriesOf(sm);
    assert.equal(states.length, 2, "the rebuild records exactly one new state entry");
    const rebuiltState = states.at(-1).data;
    assert.equal(rebuiltState.blocks.length, 2);
    assert.equal(rebuiltState.blocks[0].markdown, blockOne, "the kept prefix block stays byte-identical");
    assert.equal(rebuiltState.blocks[0].endEntryId, endA);
    assert.deepEqual(rebuiltState.blocks[0].retainedEntryIds, [userOne]);
    assert.equal(rebuiltState.blocks[1].markdown, rebuilt);
    assert.equal(rebuiltState.blocks[1].endEntryId, endF,
      "the rebuilt block spans the suffix originals through the re-scoped new history");
    assert.deepEqual(rebuiltState.blocks[1].retainedEntryIds, [userTwo, userThree],
      "the replaced suffix's retained instruction stays protected even though a newer instruction moved the recent zone");

    // The next ordinary request applies the replacement: the covered
    // originals leave together, the prefix part is untouched, the retained
    // instructions stay raw, and the request shrank against the serving.
    const applied = await serveContext(session, sm, ctx);
    const appliedText = requestText(applied);
    for (const needle of ["EVIDENCE-B", "EVIDENCE-C", "EVIDENCE-D", "EVIDENCE-E", "EVIDENCE-F", "SUFFIX-TWO-NEEDLE"]) {
      assert.ok(!appliedText.includes(needle), `the covered original left the applied request (${needle})`);
    }
    assert.ok(appliedText.includes("EVIDENCE-G"), "the working set round stays uncompressed");
    assert.ok(appliedText.includes("REBUILT-NEEDLE"), "the rebuilt block enters complete, exactly once");
    assert.ok(appliedText.includes("protected follow-up instruction")
      && appliedText.includes("later instruction that moves the protection zone"),
      "every retained instruction inside the covered range stays raw");
    assert.ok(appliedText.includes("task instruction one"));
    carriers = carrierMessages(applied);
    assert.equal(carriers.length, 1);
    parts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.equal(parts[0], MEMORY_SUMMARY_WRAPPER);
    assert.equal(parts[1], `${MEMORY_BLOCK_SEPARATOR}${blockOne}`, "the prefix part is byte-identical across the rebuild");
    assert.equal(parts[2], `${MEMORY_BLOCK_SEPARATOR}${rebuilt}`);
    assert.ok(appliedText.split("REBUILT-NEEDLE").length - 1 === 1, "the rebuilt body appears exactly once");
    const estimate = (messages) => Math.ceil(JSON.stringify(messages).length / 4);
    assert.ok(estimate(applied) < estimate(servedRescope),
      "the applied request is smaller than the served pending request it replaces");
    assert.equal(requestText(applied).includes(REBUILD_ADVISORY_NEEDLE), false,
      "the completed request's advisory is gone once the projection relieves the pressure");

    // A repeated submission records nothing: the acceptance consumed every
    // covered source, so below half budget the next operation would be an
    // append with no uncovered conversation left.
    await noteBatch(session, ctx, [compactCallPart("rb:2", "# again")]);
    assert.match(await refusalMessage(session, ctx, "rb:2", "# again"), /^COMPACT_NOT_DUE: /);
    assert.equal(stateEntriesOf(sm).length, 2);
    void userThree;
    void endB;
    void servedText;
  }

  // ── A single block above half rebuilds with an empty prefix: no carrier ──
  {
    const sm = SessionManager.inMemory("/project");
    const userOne = sm.appendMessage({ role: "user", content: "single block task", timestamp: 1 });
    const endA = appendReadRound(sm, "k:1", "a.txt", "EVIDENCE-K " + "k".repeat(500), 2);
    const blockOne = "# Only block\n\nONLY-NEEDLE " + "one".repeat(180);
    sm.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, {
      format: MEMORY_STATE_FORMAT_TAG,
      blocks: [{ endEntryId: endA, markdown: blockOne, retainedEntryIds: [userOne] }],
    });
    appendReadRound(sm, "k:2", "b.txt", "EVIDENCE-L new history", 5);
    appendReadRound(sm, "k:3", "c.txt", "EVIDENCE-M working set", 7);

    const session = harness(CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const served = await serveContext(session, sm, ctx);
    const servedText = requestText(served);
    assert.equal(carrierMessages(served).length, 0,
      "an empty prefix carries no carrier at all — the request is the raw conversation");
    assert.ok(servedText.includes(REBUILD_ADVISORY_NEEDLE));
    assert.ok(!servedText.includes("ONLY-NEEDLE"), "the replaced summary is absent");
    for (const needle of ["EVIDENCE-K", "EVIDENCE-L", "single block task"]) {
      assert.ok(servedText.includes(needle), `every original returns raw (${needle})`);
    }
    const rebuilt = "# Rebuilt whole\n\nREBUILT-WHOLE-NEEDLE " + "w".repeat(60);
    await noteBatch(session, ctx, [compactCallPart("kw:1", rebuilt)]);
    const accepted = await compactTool(session).execute("kw:1", { markdown: rebuilt }, undefined, undefined, ctx);
    assert.equal(accepted.details.recorded, true);
    const state = stateEntriesOf(sm).at(-1).data;
    assert.equal(state.blocks.length, 1);
    assert.equal(state.blocks[0].markdown, rebuilt);
    assert.deepEqual(state.blocks[0].retainedEntryIds, [userOne], "the protected instruction survives the whole rebuild");
    const applied = await serveContext(session, sm, ctx);
    const appliedText = requestText(applied);
    assert.ok(!appliedText.includes("EVIDENCE-K") && !appliedText.includes("EVIDENCE-L"));
    assert.ok(appliedText.includes("REBUILT-WHOLE-NEEDLE") && appliedText.includes("single block task"));
    const carriers = carrierMessages(applied);
    assert.equal(carriers.length, 1);
    const parts = carriers[0].content.filter((part) => part?.type === "text").map((part) => part.text);
    assert.deepEqual(parts, [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${rebuilt}`]);
  }

  // ── The honest scale limit and model-window recovery ──
  {
    const sm = SessionManager.inMemory("/project");
    const userOne = sm.appendMessage({ role: "user", content: "scale limit task", timestamp: 1 });
    const endA = appendReadRound(sm, "x:1", "a.txt", "EVIDENCE-X " + "x".repeat(300), 2);
    const endB = appendReadRound(sm, "x:2", "b.txt", "EVIDENCE-Y " + "y".repeat(300), 4);
    const blockOne = "# Scale one\n\n" + "s".repeat(90);
    const blockTwo = "# Scale two\n\nSCALE-TWO-NEEDLE " + "t".repeat(160);
    sm.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, {
      format: MEMORY_STATE_FORMAT_TAG,
      blocks: [
        { endEntryId: endA, markdown: blockOne, retainedEntryIds: [userOne] },
        { endEntryId: endB, markdown: blockTwo, retainedEntryIds: [] },
      ],
    });
    // Sources so large that the complete rebuild serving cannot fit the
    // small window's safety clamp.
    appendReadRound(sm, "x:3", "c.txt", "EVIDENCE-Z " + "z".repeat(24_000), 6);
    appendReadRound(sm, "x:4", "d.txt", "working set", 8);

    const session = harness(CONFIG, sm);
    const smallCtx = commandContext(sm, SMALL_WINDOW);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, smallCtx);
    const limited = await serveContext(session, sm, smallCtx);
    const limitedText = requestText(limited);
    assert.ok(!limitedText.includes(REBUILD_ADVISORY_NEEDLE),
      "no rebuild invitation rides a request that cannot carry its own sources");
    const carriers = carrierMessages(limited);
    assert.equal(carriers.length, 1, "the full recorded Memory keeps applying");
    assert.ok(limitedText.includes("SCALE-TWO-NEEDLE"), "the summaries stay in the carrier");
    assert.ok(!limitedText.includes("EVIDENCE-Y"), "and the covered originals stay evicted");
    const snapshot = session.registration.snapshot();
    assert.equal(snapshot.scaleLimit, true, "/context reports the honest scale limit");
    assert.equal(snapshot.maintenance, undefined, "nothing is pinned at the scale limit");
    await noteBatch(session, smallCtx, [compactCallPart("sl:1")]);
    assert.match(await refusalMessage(session, smallCtx, "sl:1", "# Scale attempt"),
      /^SOURCE_NOT_SERVED: /,
      "an un-served request never authorizes a rebuild");
    assert.equal(stateEntriesOf(sm).length, 1, "nothing is truncated, paged, or deleted to force a fit");

    // A larger window recovers the maintenance path on the very next request.
    const wideCtx = commandContext(sm, CONTEXT_WINDOW);
    const recovered = await serveContext(session, sm, wideCtx);
    const recoveredText = requestText(recovered);
    assert.ok(recoveredText.includes(REBUILD_ADVISORY_NEEDLE), "the rebuild request opens once the sources fit");
    assert.ok(recoveredText.includes("EVIDENCE-Y") && !recoveredText.includes("SCALE-TWO-NEEDLE"));
    const recoveredSnapshot = session.registration.snapshot();
    assert.notEqual(recoveredSnapshot.scaleLimit, true);
    assert.equal(recoveredSnapshot.maintenance?.operation, "rebuild");
  }

  console.log("context-memory suffix rebuild tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
