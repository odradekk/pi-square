import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";
import { SessionManager, buildContextEntries } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const {
  MEMORY_FORMAT_TAG,
  MEMORY_STATE_CUSTOM_TYPE,
  MEMORY_STATE_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
  MEMORY_BLOCK_SEPARATOR,
  composeMemorySummary,
} = await load("../../src/context-memory/format.ts");
const { CONTEXT_MEMORY_ADVISORY_TYPE, CONTEXT_MEMORY_BLOCKS_TYPE } = await load("../../src/context-memory/view.ts");
const { MEMORY_TRANSCRIPT_HEADER } = await load("../../src/context-memory/transcript.ts");

const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
/** Small due point so padded real trees cross it by projection alone (#319). */
const DUE_CONFIG = { enabled: true, compressionThreshold: { tokens: 2500 }, memoryBudgetPercent: 1 };
/** ~8.7 KB per covered entry — enough that two entries project well past the due point. */
const PADDING = "operational history and module boundary notes that make the covered conversation large. ".repeat(100);

/**
 * #217/#221/#319 Pi SessionManager integration: derivation, source recovery,
 * active-tool synchronization, and the request projection against Pi's real
 * in-memory SessionManager tree. The v1 compaction-carried derivation keeps
 * its coverage unchanged; #319 replaces the removed settle/takeover handshake
 * with the recorded state entry — derivation, reading, projection, due
 * advisory, native-compaction supersession, and the resident compression tool.
 * #221 keeps the branch-private lifecycle over real persisted files — resume
 * leaf derivation, `/tree` navigation, fork, clone, import-like copies,
 * cross-directory duplicates, session replacement, and ephemeral sessions —
 * always with real uuids, real append semantics, and no Context Memory
 * filesystem write anywhere.
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

/** Append one #319 state entry through Pi's public custom-entry seam. */
function seedMemoryState(sm, blocks) {
  sm.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, { format: MEMORY_STATE_FORMAT_TAG, blocks });
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
  // The registrar records accepted Memory through `pi.appendEntry`; route it to
  // the SessionManager the harness most recently observed in an event context.
  let recordingSession = null;
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
    appendEntry(customType, data) { recordingSession.appendCustomEntry(customType, data); },
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
    recordInto(sm) { recordingSession = sm; },
    async emit(name, event, ctx) {
      if (ctx?.sessionManager?.appendCustomEntry) recordingSession = ctx.sessionManager;
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

/** Read every page of one Memory block through the real tool. */
async function readAllPages(readTool, ctx, block) {
  const pages = [];
  let page = 1;
  for (;;) {
    const result = await readTool.execute(`p:${block}:${page}`, { block, page }, undefined, undefined, ctx);
    pages.push(result.content[1].text);
    if (!result.details.hasMore) break;
    page += 1;
  }
  return pages.join("");
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
  assert.ok(session.activeTools().includes("compact_to_memory_block"),
    "the compression tool is resident while the feature is enabled (#319)");

  const snapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
  assert.equal(snapshot.state, "active");
  assert.equal(snapshot.carrier, "compaction", "the v1 baseline reports its carrier");
  assert.equal(snapshot.applied, false, "a compaction carrier is never marked applied by the state projection");
  assert.equal(snapshot.blocks, 2);
  assert.equal(snapshot.rows[0].sources, 3, "block 1 covers the first user/assistant/result trio");
  assert.equal(snapshot.rows[1].sources, 2, "block 2 covers the second user/assistant pair");

  // ── Source recovery through the real tree ──

  const read = session.tools.get("read_memory_source");
  const transcript = await readAllPages(read, ctx, 2);
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
  assert.ok(session.activeTools().includes("compact_to_memory_block"),
    "the compression tool stays resident through the opaque boundary");

  // The ephemeral session wrote nothing to disk.
  assert.equal(sm.isPersisted(), false);
  assert.equal(sm.getSessionFile(), undefined);

  // ── #319: a recorded state entry carries Memory over a real tree ──

  {
    const stateSm = SessionManager.inMemory("/project");
    const coveredUser = stateSm.appendMessage({ role: "user", content: "explore the parser internals", timestamp: 1 });
    const coveredAssistant = stateSm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "the parser walks three bounded phases" },
        { type: "toolCall", id: "call-state-1", name: "read", arguments: { path: "src/parser.ts" } },
      ],
      stopReason: "toolUse", timestamp: 2,
    });
    const coveredResult = stateSm.appendMessage({
      role: "toolResult", toolCallId: "call-state-1", toolName: "read",
      content: [{ type: "text", text: "export function parse() {}" }], isError: false, timestamp: 3,
    });
    const retainedUser = stateSm.appendMessage({
      role: "user", content: "keep the alpha-bravo planning instruction verbatim", timestamp: 4,
    });
    const coveredEnd = stateSm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "the planning instruction is preserved" }],
      stopReason: "stop", timestamp: 5,
    });
    const digest = "# Repo digest\n\n- the parser tour and the retained planning instruction";
    seedMemoryState(stateSm, [{ endEntryId: coveredEnd, markdown: digest, retainedEntryIds: [retainedUser] }]);
    const stateEntry = stateSm.getBranch().at(-1);
    assert.equal(stateEntry.type, "custom");
    assert.equal(stateEntry.customType, MEMORY_STATE_CUSTOM_TYPE);
    const requestUser = stateSm.appendMessage({ role: "user", content: "ship the current task", timestamp: 6 });

    const stateHarness = harness();
    const stateCtx = commandContext(stateSm);
    await stateHarness.emit("session_start", { type: "session_start", reason: "resume" }, stateCtx);
    assert.ok(stateHarness.activeTools().includes("read_memory_source"),
      "a recorded state entry activates the reading surface");
    const stateSnapshot = stateHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(stateSnapshot.state, "active");
    assert.equal(stateSnapshot.ephemeral, true, "an ephemeral session reports itself");
    assert.equal(stateSnapshot.carrier, "state", "the state entry is the current carrier");
    assert.equal(stateSnapshot.applied, false, "recorded Memory starts unapplied");
    assert.equal(stateSnapshot.blocks, 1);
    assert.equal(stateSnapshot.rows[0].sources, 5,
      "the block covers the eligible range including the retained instruction");

    // Source recovery over the state-carried block.
    const stateRead = stateHarness.tools.get("read_memory_source");
    const stateTranscript = await readAllPages(stateRead, stateCtx, 1);
    for (const needle of [
      "explore the parser internals",
      "the parser walks three bounded phases",
      "export function parse() {}",
      "keep the alpha-bravo planning instruction verbatim",
      "the planning instruction is preserved",
    ]) {
      assert.ok(stateTranscript.includes(needle), `the state block recovers ${JSON.stringify(needle)}`);
    }
    for (const forbidden of [coveredUser, coveredAssistant, coveredResult, retainedUser, coveredEnd, "call-state-1"]) {
      assert.ok(!stateTranscript.includes(forbidden), "entry ids and call ids never surface");
    }

    const stateInspected = stateHarness.registration.inspect({ block: 1, page: 1 }, stateSm);
    assert.equal(stateInspected.ok, true);
    assert.ok(stateInspected.text.includes(digest), "inspection shows the recorded Markdown");

    // The request projection applies the recorded state entry exactly.
    const rawRequest = stateSm.buildSessionContext().messages;
    assert.equal(rawRequest.length, 6, "the raw request carries every entry's message");
    const applied = await stateHarness.emit("context", { type: "context", messages: rawRequest }, stateCtx);
    assert.ok(applied?.messages, "the projection returns a transformed request");
    assert.equal(applied.messages.length, 3,
      "covered originals leave, the carrier enters once, the retained tail stays");
    const carrier = applied.messages[0];
    assert.equal(carrier.role, "custom");
    assert.equal(carrier.customType, CONTEXT_MEMORY_BLOCKS_TYPE);
    assert.deepEqual(
      carrier.content.map((part) => part.text),
      [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${digest}`],
      "the carrier is the fixed wrapper plus one byte-exact part per block",
    );
    assert.equal(applied.messages[1].role, "user");
    assert.equal(applied.messages[1].content, "keep the alpha-bravo planning instruction verbatim",
      "the retained instruction stays raw");
    assert.equal(applied.messages[2].role, "user");
    assert.equal(applied.messages[2].content, "ship the current task", "the current request stays uncompressed");
    const appliedSerialized = JSON.stringify(applied.messages);
    assert.ok(!appliedSerialized.includes("explore the parser internals"), "covered history leaves the request");
    assert.ok(!appliedSerialized.includes(MEMORY_STATE_FORMAT_TAG), "the state record itself never enters the request");
    const projectedAgain = await stateHarness.emit("context", { type: "context", messages: rawRequest }, stateCtx);
    assert.equal(appliedSerialized, JSON.stringify(projectedAgain.messages), "the projection is deterministic");

    const appliedSnapshot = stateHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(appliedSnapshot.applied, true, "the applied flag reports the carried request");

    // Branch-private lifecycle: each branch derives its own latest state entry.
    stateSm.branch(retainedUser);
    await stateHarness.emit("session_tree", {
      type: "session_tree", newLeafId: retainedUser, oldLeafId: stateSm.getLeafId(),
    }, stateCtx);
    assert.deepEqual(stateHarness.registration.snapshot(), { state: "no-memory", ephemeral: true },
      "a path before every state entry carries no Memory");
    const altEnd = stateSm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "alternate branch work" }], stopReason: "stop", timestamp: 7,
    });
    seedMemoryState(stateSm, [{ endEntryId: altEnd, markdown: "# Branch B digest\n\n- the sibling recording", retainedEntryIds: [] }]);
    const altState = stateSm.getBranch().at(-1);
    await stateHarness.emit("session_tree", {
      type: "session_tree", newLeafId: altState, oldLeafId: retainedUser,
    }, stateCtx);
    assert.equal(stateHarness.registration.snapshot({ tokens: 1, contextWindow: 1000 }).state, "active");
    const altInspected = stateHarness.registration.inspect({ block: 1, page: 1 }, stateSm);
    assert.ok(altInspected.text.includes("# Branch B digest"), "the branch derives its own latest state entry");

    stateSm.branch(stateEntry.id);
    await stateHarness.emit("session_tree", {
      type: "session_tree", newLeafId: stateEntry.id, oldLeafId: altState,
    }, stateCtx);
    assert.ok(stateHarness.registration.inspect({ block: 1, page: 1 }, stateSm).text.includes(digest),
      "navigating back restores the original branch's own recording");
    assert.ok(!stateSm.getBranch().some((entry) => entry.id === altState),
      "the sibling state entry is not on this path");
  }

  // ── #319: due detection, the request advisory, and recorded relief ──

  {
    const dueSm = SessionManager.inMemory("/project");
    dueSm.appendMessage({ role: "user", content: `explore the parser internals ${PADDING}`, timestamp: 1 });
    const coveredEnd = dueSm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `the parser walks three bounded phases ${PADDING}` }],
      stopReason: "stop", timestamp: 2,
    });
    dueSm.appendMessage({ role: "user", content: "ship it", timestamp: 3 });

    const dueHarness = harness(DUE_CONFIG);
    const dueCtx = commandContext(dueSm);
    await dueHarness.emit("session_start", { type: "session_start", reason: "startup" }, dueCtx);
    assert.deepEqual(dueHarness.registration.snapshot(), { state: "due", ephemeral: true },
      "the projected request sits at or above the due point");

    const dueRequest = dueSm.buildSessionContext().messages;
    const transformed = await dueHarness.emit("context", { type: "context", messages: dueRequest }, dueCtx);
    assert.ok(transformed?.messages, "the due request is transformed");
    const advisories = transformed.messages.filter((message) => message?.customType === CONTEXT_MEMORY_ADVISORY_TYPE);
    assert.equal(advisories.length, 1, "exactly one advisory rides the due request");
    assert.ok(advisories[0].content.includes("compression is due"));
    assert.equal(transformed.messages.length, dueRequest.length + 1, "the advisory is the only insertion");
    assert.equal(transformed.messages.at(-2).role, "user");
    assert.equal(transformed.messages.at(-2).content, "ship it",
      "the advisory sits directly after the current user message");

    // Recording the covered history relieves the pressure immediately (#319).
    seedMemoryState(dueSm, [{ endEntryId: coveredEnd, markdown: "# Relief digest\n\n- the covered parser phases", retainedEntryIds: [] }]);
    await dueHarness.emit("agent_settled", { type: "agent_settled" }, dueCtx);
    const relieved = dueHarness.registration.snapshot({ tokens: 500, contextWindow: 200000 });
    assert.equal(relieved.state, "active", "the recorded state entry opens the reading surface");
    assert.equal(relieved.carrier, "state");
    assert.ok(dueHarness.activeTools().includes("read_memory_source"));

    const relievedRequest = await dueHarness.emit("context", { type: "context", messages: dueSm.buildSessionContext().messages }, dueCtx);
    const relievedSerialized = JSON.stringify(relievedRequest.messages);
    assert.ok(!relievedSerialized.includes(CONTEXT_MEMORY_ADVISORY_TYPE),
      "the advisory clears once the recorded Memory relieves the pressure");
    assert.ok(!relievedSerialized.includes("explore the parser internals"), "the covered originals leave the request");
    assert.ok(relievedSerialized.includes("ship it"), "the current request stays uncompressed");
    const carrier = relievedRequest.messages.find((message) => message?.customType === CONTEXT_MEMORY_BLOCKS_TYPE);
    assert.ok(carrier, "the complete Memory carrier enters the request");
    assert.ok(relievedSerialized.length < JSON.stringify(transformed.messages).length,
      "the relieved request is smaller than the due request that preceded it");
    assert.equal(dueSm.getBranch().filter((entry) => entry.type === "custom_message").length, 0,
      "the advisory never persists anywhere");
  }

  // ── #319: a native compaction after a state entry supersedes it ──

  {
    // A plain native compaction becomes the new baseline: Memory degrades to
    // opaque rather than resurrecting the superseded state's coverage.
    const plainSm = SessionManager.inMemory("/project");
    plainSm.appendMessage({ role: "user", content: "explore the deployment flow", timestamp: 1 });
    const plainEnd = plainSm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "the deploy script pushes then verifies" }], stopReason: "stop", timestamp: 2,
    });
    seedMemoryState(plainSm, [{ endEntryId: plainEnd, markdown: "# Superseded digest\n\n- never applied again", retainedEntryIds: [] }]);
    const plainKept = plainSm.appendMessage({ role: "user", content: "one more thing", timestamp: 3 });
    plainSm.appendCompaction("A plain native summary.", plainKept, 4000, undefined, false);
    const plainHarness = harness();
    await plainHarness.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(plainSm));
    assert.deepEqual(plainHarness.registration.snapshot(), { state: "opaque", ephemeral: true },
      "a native compaction without details supersedes the state entry opaquely");
    assert.ok(!plainHarness.activeTools().includes("read_memory_source"));

    // A native compaction carrying valid v1 details supersedes it visibly:
    // derivation follows the compaction's own Memory.
    const v1Sm = SessionManager.inMemory("/project");
    v1Sm.appendMessage({ role: "user", content: "explore the deployment flow", timestamp: 1 });
    v1Sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "the deploy script pushes then verifies" }], stopReason: "stop", timestamp: 2,
    });
    const v1End = v1Sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "the verification step tails the log" }], stopReason: "stop", timestamp: 3,
    });
    seedMemoryState(v1Sm, [{ endEntryId: v1End, markdown: "# Superseded digest\n\n- never applied again", retainedEntryIds: [] }]);
    const v1Kept = v1Sm.appendMessage({ role: "user", content: "ship it", timestamp: 4 });
    const v1Body = "# Native baseline\n\n- the v1 compaction carries the current Memory";
    v1Sm.appendCompaction(
      composeMemorySummary([v1Body]),
      v1Kept,
      5000,
      { format: MEMORY_FORMAT_TAG, blocks: [{ endEntryId: v1End, markdownBytes: Buffer.byteLength(v1Body, "utf8") }] },
      true,
    );
    const v1Harness = harness();
    await v1Harness.emit("session_start", { type: "session_start", reason: "resume" }, commandContext(v1Sm));
    const v1Snapshot = v1Harness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(v1Snapshot.state, "active", "a v1-carrying compaction supersedes the state entry as valid Memory");
    assert.equal(v1Snapshot.carrier, "compaction");
    assert.equal(v1Snapshot.blocks, 1);
    assert.ok(v1Harness.activeTools().includes("read_memory_source"));
    const v1Inspected = v1Harness.registration.inspect({ block: 1, page: 1 }, v1Sm);
    assert.ok(v1Inspected.text.includes(v1Body), "the compaction's own block is current");
    assert.ok(!v1Inspected.text.includes("# Superseded digest"), "the superseded state's Markdown is not Memory");
  }

  // ── #319: the resident compression tool records through the real registrar ──
  // (#222: the whole recording path performs no direct filesystem write —
  // Pi's SessionManager stays the only session writer.)

  {
    const fs = (await import("node:fs")).default;
    const violations = [];
    const restores = [];
    const guard = (object, label, names) => {
      for (const name of names) {
        const original = object[name];
        if (typeof original !== "function") continue;
        restores.push(() => { object[name] = original; });
        object[name] = (...args) => { violations.push(`${label}${String(name)}(${String(args[0])})`); };
      }
    };
    try {
      guard(fs, "fs:", [
        "writeFileSync", "appendFileSync", "openSync", "createWriteStream",
        "renameSync", "copyFileSync", "truncateSync", "rmSync", "mkdirSync",
      ]);
      guard(fs.promises, "fs/promises:", [
        "writeFile", "appendFile", "open", "rename", "truncate", "rm", "mkdir", "cp",
      ]);

      const ioSession = SessionManager.inMemory("/project");
      ioSession.appendMessage({ role: "user", content: `explore the storage boundary ${PADDING}`, timestamp: 1 });
      ioSession.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "pi owns every session write" },
          { type: "toolCall", id: "call-io-read", name: "read", arguments: { path: "src/index.ts" } },
        ],
        stopReason: "toolUse", timestamp: 2,
      });
      ioSession.appendMessage({
        role: "toolResult", toolCallId: "call-io-read", toolName: "read",
        content: [{ type: "text", text: `export default register() ${PADDING}` }], isError: false, timestamp: 3,
      });
      const retainedInstruction = ioSession.appendMessage({
        role: "user", content: "keep the alpha-bravo planning instruction verbatim", timestamp: 4,
      });
      ioSession.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "checking the lexer too" },
          { type: "toolCall", id: "call-io-lex", name: "read", arguments: { path: "src/lexer.ts" } },
        ],
        stopReason: "toolUse", timestamp: 5,
      });
      ioSession.appendMessage({
        role: "toolResult", toolCallId: "call-io-lex", toolName: "read",
        content: [{ type: "text", text: "LEXER-NEEDLE confirmed" }], isError: false, timestamp: 6,
      });

      const ioHarness = harness(DUE_CONFIG);
      ioHarness.recordInto(ioSession);
      const ioCtx = commandContext(ioSession);
      await ioHarness.emit("session_start", { type: "session_start", reason: "startup" }, ioCtx);
      assert.ok(ioHarness.activeTools().includes("compact_to_memory_block"),
        "the compression tool is resident from session start");

      const body = "# Storage digest\n\n- pi owns every session write";
      // Serve the request that precedes the compression call: acceptance
      // requires every eviction target to have reached the model (#319).
      await ioHarness.emit("context", {
        type: "context",
        messages: ioSession.buildSessionContext().messages,
      }, ioCtx);
      await ioHarness.emit("message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "compressing now" },
            { type: "toolCall", id: "call-io", name: "compact_to_memory_block", arguments: { markdown: body } },
          ],
        },
      }, ioCtx);
      const accepted = await ioHarness.tools.get("compact_to_memory_block").execute(
        "call-io", { markdown: body }, undefined, undefined, ioCtx,
      );
      assert.equal(
        accepted.content[0].text,
        "Memory block recorded. The next model request will carry it in place of the covered older conversation.",
      );
      assert.deepEqual(accepted.details, { recorded: true });

      const leaf = ioSession.getBranch().at(-1);
      assert.equal(leaf.type, "custom", "the accepted call recorded one state entry");
      assert.equal(leaf.customType, MEMORY_STATE_CUSTOM_TYPE);
      assert.equal(leaf.data.format, MEMORY_STATE_FORMAT_TAG);
      assert.equal(leaf.data.blocks.length, 1);
      assert.equal(leaf.data.blocks[0].markdown, body);
      assert.deepEqual(leaf.data.blocks[0].retainedEntryIds, [retainedInstruction],
        "the protected instruction is recorded as the retained exception");

      assert.ok(ioHarness.activeTools().includes("read_memory_source"),
        "recording opens the reading surface within the same run");
      assert.ok(ioHarness.activeTools().includes("compact_to_memory_block"),
        "the compression tool stays resident after acceptance");
      const ioSnapshot = ioHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
      assert.equal(ioSnapshot.state, "active");
      assert.equal(ioSnapshot.carrier, "state");
      assert.equal(ioSnapshot.applied, false, "the acknowledgement never claims an already-carried request");
      assert.equal(ioSnapshot.rows[0].sources, 4);

      // The run continues: Pi appends the assistant call and its tool result.
      ioSession.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "compressing now" },
          { type: "toolCall", id: "call-io", name: "compact_to_memory_block", arguments: { markdown: body } },
        ],
        stopReason: "toolUse", timestamp: 7,
      });
      ioSession.appendMessage({
        role: "toolResult", toolCallId: "call-io", toolName: "compact_to_memory_block",
        content: [{ type: "text", text: accepted.content[0].text }], isError: false, timestamp: 8,
      });

      const rawRequest = ioSession.buildSessionContext().messages;
      const transformed = await ioHarness.emit("context", { type: "context", messages: rawRequest }, ioCtx);
      assert.ok(transformed?.messages, "the projection ran under the write guard");
      const serialized = JSON.stringify(transformed.messages);
      assert.ok(!serialized.includes("explore the storage boundary"), "the covered history leaves the request");
      assert.ok(!serialized.includes("export default register()"), "the covered tool result leaves the request");
      assert.ok(serialized.includes("keep the alpha-bravo planning instruction verbatim"),
        "the retained instruction stays raw");
      assert.ok(serialized.includes("checking the lexer too") && serialized.includes("LEXER-NEEDLE confirmed"),
        "the retained working set stays whole");
      const carrier = transformed.messages.find((message) => message?.customType === CONTEXT_MEMORY_BLOCKS_TYPE);
      assert.ok(carrier, "the complete Memory carrier enters the request");
      assert.deepEqual(
        carrier.content.map((part) => part.text),
        [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${body}`],
      );
      const trailingCall = transformed.messages
        .filter((message) => message?.role === "assistant")
        .flatMap((message) => message.content.filter((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block"));
      assert.equal(trailingCall.length, 1, "the trailing compression pair survives whole");
      assert.equal(trailingCall[0].arguments.markdown, "(this Memory block is carried in full above)",
        "the tool arguments no longer duplicate the carried body");
      assert.ok(serialized.includes("Memory block recorded."), "the trailing result stays visible");
      assert.ok(!serialized.includes(CONTEXT_MEMORY_ADVISORY_TYPE),
        "the recorded Memory relieves the pressure — no advisory");
      assert.ok(serialized.length < JSON.stringify(rawRequest).length,
        "the projected request is smaller than the raw request");
      assert.equal(ioHarness.registration.snapshot({ tokens: 40000, contextWindow: 200000 }).applied, true);

      // A batch the call does not solely occupy refuses.
      await ioHarness.emit("message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-io-mixed", name: "read", arguments: { path: "x" } },
            { type: "toolCall", id: "call-io-second", name: "compact_to_memory_block", arguments: { markdown: body } },
          ],
        },
      }, ioCtx);
      await assert.rejects(
        () => ioHarness.tools.get("compact_to_memory_block").execute(
          "call-io-second", { markdown: body }, undefined, undefined, ioCtx,
        ),
        (error) => {
          assert.match(error.message, /^COMPACT_NOT_SOAL_TOOL: /);
          return true;
        },
      );
      assert.equal(ioSession.getBranch().filter((entry) => entry.type === "custom").length, 1,
        "a refused call records nothing");

      // Nothing new is compressible since the recorded block.
      await ioHarness.emit("message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-io-third", name: "compact_to_memory_block", arguments: { markdown: body } }],
        },
      }, ioCtx);
      await assert.rejects(
        () => ioHarness.tools.get("compact_to_memory_block").execute(
          "call-io-third", { markdown: body }, undefined, undefined, ioCtx,
        ),
        (error) => {
          assert.match(error.message, /^COMPACT_NOT_DUE: /);
          return true;
        },
      );

      await ioHarness.emit("session_compact", {
        type: "session_compact",
        compactionEntry: ioSession.getBranch().at(-1),
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      }, ioCtx);
      await ioHarness.emit("agent_settled", { type: "agent_settled" }, ioCtx);
      await ioHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ioCtx);
      assert.equal(ioHarness.registration.snapshot({ tokens: 900, contextWindow: 200000 }).state, "disabled",
        "the full recording path and teardown ran under the write guard");
    } finally {
      for (const restore of restores.reverse()) restore();
    }
    assert.deepEqual(violations, [],
      "the complete recording path attempts no direct filesystem mutation — Pi's SessionManager is the only session writer");
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
      const repEnd = repSource.appendMessage({
        role: "assistant", content: [{ type: "text", text: "the lifecycle follows the leaf" }], stopReason: "stop", timestamp: 2,
      });
      seedMemoryState(repSource, [{ endEntryId: repEnd, markdown: "# Lifecycle digest\n\n- the leaf owns derivation", retainedEntryIds: [] }]);
      const repHarness = harness();
      await repHarness.emit("session_start", { type: "session_start", reason: "startup" }, commandContext(repSource));
      assert.equal(repHarness.registration.snapshot({ tokens: 100, contextWindow: 200000 }).state, "active");

      await repHarness.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, commandContext(repSource));
      assert.deepEqual(repHarness.registration.snapshot(), { state: "disabled" },
        "shutdown clears the controller entirely");

      const replacement = SessionManager.inMemory("/project");
      await repHarness.emit("session_start", { type: "session_start", reason: "new" }, commandContext(replacement));
      assert.deepEqual(repHarness.registration.snapshot(), { state: "no-memory", ephemeral: true },
        "replacement re-derives the new session's own branch");
      assert.ok(!repHarness.activeTools().includes("read_memory_source"),
        "the reading surface stays closed until the new session records its own Memory");
      assert.ok(repHarness.activeTools().includes("compact_to_memory_block"),
        "the resident compression tool follows the new session");
    }

    // Crash residue (#222): restart replays nothing from dead runs. Historical
    // submit artifacts never became Memory, while a recorded state entry
    // survives restart exactly as recorded.
    {
      const crashSource = SessionManager.create("/proj-crash", dirA);
      crashSource.appendMessage({ role: "user", content: "explore the deployment flow", timestamp: 1 });
      crashSource.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "the deploy script pushes then verifies" },
          { type: "toolCall", id: "call-crash", name: "submit_memory", arguments: { markdown: "# Residue\n\n- never committed" } },
        ],
        stopReason: "toolUse", timestamp: 2,
      });
      crashSource.appendMessage({
        role: "toolResult", toolCallId: "call-crash", toolName: "submit_memory",
        content: [{ type: "text", text: "SUBMIT_NOT_DUE: no Context Memory compression is due in this run" }], isError: true, timestamp: 3,
      });
      const crashEnd = crashSource.appendMessage({ role: "user", content: "ship it", timestamp: 4 });
      const crashFile = crashSource.getSessionFile();
      const reopened = SessionManager.open(crashFile, dirA);

      const crashHarness = harness();
      const crashCtx = commandContext(reopened);
      await crashHarness.emit("session_start", {
        type: "session_start", reason: "resume", previousSessionFile: crashFile,
      }, crashCtx);
      assert.deepEqual(crashHarness.registration.snapshot(), { state: "no-memory" },
        "restart replays nothing: the dead run's artifacts created no Memory");
      assert.ok(!crashHarness.activeTools().includes("read_memory_source"));

      // The historical refused submit pair leaves provider requests while its
      // ordinary assistant text survives.
      const filtered = await crashHarness.emit("context", {
        type: "context", messages: reopened.buildSessionContext().messages,
      }, crashCtx);
      const filteredSerialized = JSON.stringify(filtered.messages);
      assert.ok(!filteredSerialized.includes("submit_memory"), "the retired protocol pair leaves the request");
      assert.ok(!filteredSerialized.includes("SUBMIT_NOT_DUE"), "the refused result never re-enters a request");
      assert.ok(filteredSerialized.includes("the deploy script pushes then verifies"),
        "ordinary assistant text in the same message survives");
      assert.ok(filteredSerialized.includes("explore the deployment flow"),
        "without a carrier nothing is evicted — the raw history stays whole");

      // A fresh recording through the new protocol covers the same range and
      // excludes the protocol artifacts from every source stream.
      const digest = "# Deploy tour\n\n- the deploy script pushes then verifies";
      reopened.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, {
        format: MEMORY_STATE_FORMAT_TAG,
        blocks: [{ endEntryId: crashEnd, markdown: digest, retainedEntryIds: [] }],
      });
      await crashHarness.emit("agent_settled", { type: "agent_settled" }, crashCtx);
      const recorded = crashHarness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
      assert.equal(recorded.state, "active");
      assert.equal(recorded.carrier, "state");
      assert.equal(recorded.blocks, 1);
      const crashTranscript = await readAllPages(crashHarness.tools.get("read_memory_source"), crashCtx, 1);
      for (const needle of ["explore the deployment flow", "the deploy script pushes then verifies", "ship it"]) {
        assert.ok(crashTranscript.includes(needle), `the recorded block recovers ${JSON.stringify(needle)}`);
      }
      for (const forbidden of ["submit_memory", "SUBMIT_NOT_DUE", "# Residue", "call-crash"]) {
        assert.ok(!crashTranscript.includes(forbidden),
          `the source stream never exposes ${JSON.stringify(forbidden)}`);
      }

      // Restart derives the recorded Memory again — and only that.
      const rerun = SessionManager.open(crashFile, dirA);
      const rerunHarness = harness();
      await rerunHarness.emit("session_start", {
        type: "session_start", reason: "resume", previousSessionFile: crashFile,
      }, commandContext(rerun));
      const rerunSnapshot = rerunHarness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
      assert.equal(rerunSnapshot.state, "active", "a recorded state entry survives restart as Memory");
      assert.equal(rerunSnapshot.blocks, 1);
      const rerunInspected = rerunHarness.registration.inspect({ block: 1, page: 1 }, rerun);
      assert.equal(rerunInspected.ok, true);
      assert.ok(rerunInspected.text.includes(digest), "the recorded block is byte-exact after restart");
      assert.ok(!rerunInspected.text.includes("# Residue"),
        "the dead run's submitted Markdown never became Memory");
      const stateEntries = rerun.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
      assert.equal(stateEntries.length, 1, "exactly the one recorded state entry exists");

      // A fork of the recorded session derives its own state Memory self-contained.
      const crashFork = SessionManager.forkFrom(crashFile, "/proj-b", dirB);
      const crashForkHarness = harness();
      await crashForkHarness.emit("session_start", {
        type: "session_start", reason: "fork", previousSessionFile: crashFile,
      }, commandContext(crashFork));
      const forkSnapshot = crashForkHarness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
      assert.equal(forkSnapshot.state, "active");
      assert.equal(forkSnapshot.carrier, "state");
      assert.ok(crashForkHarness.activeTools().includes("read_memory_source"));
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
