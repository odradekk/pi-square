import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { effectiveDuePoint } = await load("../../src/context-memory/controller.ts");
const { MEMORY_DETAILS_MAX_BYTES, MEMORY_FORMAT_TAG, MEMORY_SUMMARY_WRAPPER, composeMemorySummary } = await load("../../src/context-memory/format.ts");
const { CONTEXT_MEMORY_ADVISORY_TYPE } = await load("../../src/context-memory/view.ts");

/**
 * #218 deterministic submission-handshake traces: due detection under the
 * pre-native safety clamp, the one ephemeral advisory, the run-scoped
 * `submit_memory` candidate, compaction takeover, exact confirmation, and
 * every safe-fallback path — driven through the same registrar events and
 * tool surfaces Pi drives.
 */

const TS = "2026-01-01T00:00:00.000Z";
// window 200000 · reserve 16384 · clamp 163616 · budget 1% = 2000 < 5000.
const DUE_CONFIG = { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 };
const DUE_USAGE = { tokens: 12000, contextWindow: 200000 };

function messageEntry(id, parentId, message) {
  return { id, parentId, type: "message", timestamp: TS, message };
}
function userEntry(id, parentId, content) {
  return messageEntry(id, parentId, { role: "user", content, timestamp: 1 });
}
function assistantEntry(id, parentId, parts) {
  return messageEntry(id, parentId, {
    role: "assistant",
    content: parts,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  });
}
function toolResultEntry(id, parentId, toolName, text) {
  return messageEntry(id, parentId, {
    role: "toolResult", toolCallId: `call-${id}`, toolName,
    content: [{ type: "text", text }], isError: false, timestamp: 1,
  });
}

/** A mutable fake session tree the test appends run entries to, like Pi does. */
function mutableSession(initial) {
  let entries = initial;
  return {
    getLeafId: () => entries.at(-1)?.id ?? null,
    getBranch: () => [...entries],
    get __entries() { return entries; },
    set __entries(next) { entries = next; },
  };
}

function createHarness(options = {}) {
  const {
    config = DUE_CONFIG,
    usage = DUE_USAGE,
    usageUnavailable = false,
    activeTools = ["read", "bash"],
    isIdle = true,
  } = options;
  const tools = new Map();
  const events = new Map();
  let active = [...activeTools];
  const compactCalls = [];
  const notified = [];
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
      throw new Error("the handshake harness never renders");
    },
    reserveTokens: () => 16384,
  });
  async function emit(name, event = {}, ctx) {
    let last;
    for (const handler of events.get(name) ?? []) {
      last = await handler(event, ctx ?? baseContext());
    }
    return last;
  }
  function baseContext(session) {
    return {
      cwd: "/project",
      hasUI: true,
      mode: "tui",
      sessionManager: session ?? { getBranch: () => [] },
      compact: () => { compactCalls.push(true); },
      getContextUsage: () => (usageUnavailable ? undefined : usage),
      getSystemPrompt: () => "",
      isIdle: () => isIdle,
      hasPendingMessages: () => false,
      isProjectTrusted: () => true,
      ui: { notify: (text, level) => notified.push({ text, level }) },
    };
  }
  return {
    pi, tools, registration, emit, compactCalls, notified,
    activeTools: () => [...active],
    baseContext,
  };
}

/** The pre-run branch of every handshake trace: three eligible old entries. */
function preRunBranch() {
  return [
    userEntry("e1", null, "walk me through the repo"),
    assistantEntry("e2", "e1", [{ type: "text", text: "one entry point registers the modules" }]),
    toolResultEntry("e3", "e2", "read", "export default register()\n"),
  ];
}

/** Append the due run's persisted entries to the branch, like Pi does. */
function appendDueRun(session, markdown) {
  session.__entries.push(userEntry("e4", "e3", "ship it"));
  session.__entries.push(assistantEntry("e5", "e4", [
    { type: "text", text: "done — submitting the Memory block" },
    { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown } },
  ]));
  session.__entries.push(toolResultEntry("e6", "e5", "submit_memory", "Memory candidate accepted; compaction pending."));
}

const BLOCK = "# Repo tour\n\n- one entry point registers the modules";

function beforeCompactEvent(session, tokensBefore = 4321) {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "e4", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore, settings: {} },
    branchEntries: session.getBranch(),
    reason: "manual",
    willRetry: false,
    signal: undefined,
  };
}

/** Append the compaction entry the way Pi's SessionManager does and build the event. */
function appendCompactionEntry(session, compaction, fromExtension = true) {
  const entry = {
    id: "c1", parentId: session.__entries.at(-1)?.id ?? null, type: "compaction", timestamp: TS,
    summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId,
    tokensBefore: compaction.tokensBefore, details: compaction.details, fromExtension,
  };
  session.__entries.push(entry);
  return { type: "session_compact", compactionEntry: entry, fromExtension, reason: "manual", willRetry: false };
}

/** A committed compaction entry carrying `bodies` with ordered `ends` (#219 fixtures). */
function compactionOf(id, parentId, firstKeptEntryId, bodies, ends) {
  return {
    id, parentId, type: "compaction", timestamp: TS,
    summary: composeMemorySummary(bodies),
    firstKeptEntryId,
    tokensBefore: 4321,
    details: {
      format: MEMORY_FORMAT_TAG,
      blocks: bodies.map((body, index) => ({
        endEntryId: ends[index],
        markdownBytes: Buffer.byteLength(body, "utf8"),
      })),
    },
    fromExtension: true,
  };
}

try {

  // ── Effective due point: configured value, safety clamp, disable rules ──

  assert.equal(effectiveDuePoint({ percent: 30 }, 10, 200000, 16384), 60000);
  // The clamp wins when the configured percent sits too close to Pi's native boundary.
  assert.equal(effectiveDuePoint({ percent: 80 }, 1, 50000, 16384), 28616);
  assert.equal(effectiveDuePoint({ tokens: 1000 }, 1, 50000, 16384), 1000);
  // A Memory budget that is not strictly smaller than the due point disables the takeover.
  assert.equal(effectiveDuePoint({ percent: 2 }, 10, 100000, 16384), null);
  // A clamp that reaches below zero (tiny windows) disables the takeover.
  assert.equal(effectiveDuePoint({ percent: 30 }, 1, 18000, 16384), null);
  assert.equal(effectiveDuePoint({ tokens: 500 }, 1, null, 16384), null);

  // ── Due detection at settle opens the handshake at the next real-user input ──

  const harness = createHarness();
  const session = mutableSession(preRunBranch());
  const ctx = harness.baseContext(session);
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(harness.registration.snapshot(), { state: "due" },
    "usage past the due point with no Memory renders the due state");
  assert.ok(!harness.activeTools().includes("submit_memory"),
    "no due run is open before a real-user input");

  // An extension-origin continuation never opens the handshake.
  await harness.emit("input", { type: "input", text: "go on", source: "extension" }, ctx);
  assert.ok(!harness.activeTools().includes("submit_memory"));

  await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
  assert.ok(harness.activeTools().includes("submit_memory"),
    "the real-user input activates submit_memory before request construction");
  assert.deepEqual(
    harness.activeTools().filter((name) => name !== "submit_memory"),
    ["read", "bash"],
    "unrelated active tools keep their identity and order",
  );

  // A steering input during the open run keeps the frozen handshake.
  const steering = { ...harness.baseContext(session), isIdle: () => false };
  await harness.emit("input", { type: "input", text: "also check tests", source: "interactive", streamingBehavior: "steer" }, steering);
  assert.ok(harness.activeTools().includes("submit_memory"));

  // ── The one ephemeral tail advisory through the context transform ──

  const firstRequest = [
    { role: "user", content: "walk me through the repo", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "one entry point" }], timestamp: 2 },
    { role: "user", content: "ship it", timestamp: 3 },
  ];
  const transformed = await harness.emit("context", { type: "context", messages: firstRequest }, ctx);
  assert.ok(transformed && Array.isArray(transformed.messages), "the first request is transformed");
  assert.equal(transformed.messages.length, firstRequest.length + 1);
  const advisory = transformed.messages.at(-1);
  assert.equal(advisory.role, "custom");
  assert.equal(advisory.customType, CONTEXT_MEMORY_ADVISORY_TYPE);
  assert.equal(advisory.display, false, "the advisory is non-display");
  assert.ok(advisory.content.includes("submit_memory"), "the advisory names the submission tool");
  assert.ok(advisory.content.includes("final and sole tool call"), "the advisory demands the sole final call");
  assert.ok(advisory.content.includes("conversation before this run"), "the advisory states the append scope");
  assert.ok(advisory.content.includes("Do not copy credential values"), "the advisory carries the secret warning");
  const laterRequest = [...firstRequest, advisory, { role: "assistant", content: [{ type: "text", text: "working" }] }];
  const secondTransform = await harness.emit("context", { type: "context", messages: laterRequest }, ctx);
  const secondMessages = secondTransform?.messages ?? laterRequest;
  assert.equal(
    secondMessages.filter((message) => message?.customType === CONTEXT_MEMORY_ADVISORY_TYPE).length,
    1,
    "later requests never repeat the advisory",
  );

  // The advisory exists only in the transformed request: nothing was appended to the session.
  assert.ok(session.getBranch().every((entry) => entry.type === "message"),
    "the advisory never becomes a SessionEntry");

  // ── Submission validation ──

  const submit = harness.tools.get("submit_memory");
  appendDueRun(session, BLOCK);
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: [
      { type: "text", text: "done — submitting the Memory block" },
      { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
    ] },
  }, ctx);

  // A sibling tool call in the same batch is refused.
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: [
      { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      { type: "toolCall", id: "call-read", name: "read", arguments: { path: "x" } },
    ] },
  }, ctx);
  await assert.rejects(
    () => submit.execute("call-submit", { markdown: BLOCK }, undefined, undefined, ctx),
    (error) => {
      assert.match(error.message, /^SUBMIT_NOT_SOLE_TOOL: /);
      assert.ok(!error.message.includes(BLOCK), "the failure never echoes Memory Markdown");
      return true;
    },
  );

  // Invalid bodies are refused with the bound code and no echo.
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: [
      { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: "x" } },
    ] },
  }, ctx);
  for (const body of ["", "\u0000 embedded nul", "bad\u0001control", "x".repeat(16 * 1024 + 1)]) {
    await assert.rejects(
      () => submit.execute("call-submit", { markdown: body }, undefined, undefined, ctx),
      (error) => {
        assert.match(error.message, /^BOUND_EXCEEDED: /);
        assert.ok(!error.message.includes("x".repeat(64)), "the failure never echoes the body");
        return true;
      },
    );
  }

  // Restore the sole-call batch and accept the candidate.
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: [
      { type: "text", text: "done — submitting the Memory block" },
      { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
    ] },
  }, ctx);
  const accepted = await submit.execute("call-submit", { markdown: BLOCK }, undefined, undefined, ctx);
  assert.deepEqual(accepted.content, [{ type: "text", text: "Memory candidate accepted; compaction pending." }]);
  assert.deepEqual(accepted.details, { accepted: true });
  assert.equal(accepted.terminate, true, "the accepted submission terminates the tool batch");
  assert.deepEqual(Object.keys(accepted.details), ["accepted"]);
  assert.deepEqual(harness.registration.snapshot(), { state: "pending" });

  // A duplicate submission while the slot is pending is refused.
  await assert.rejects(
    () => submit.execute("call-submit", { markdown: BLOCK }, undefined, undefined, ctx),
    (error) => {
      assert.match(error.message, /^COMPACTION_BUSY: /);
      return true;
    },
  );

  // ── Settle triggers the manual compaction exactly once ──

  await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(harness.compactCalls.length, 1, "agent_settled calls ctx.compact() exactly once");
  assert.ok(!harness.activeTools().includes("submit_memory"),
    "settle closes the due run and deactivates submit_memory");

  // ── The takeover consumes the candidate through Pi's seam ──

  const takeover = await harness.emit("session_before_compact", beforeCompactEvent(session, 4321), ctx);
  assert.ok(takeover && takeover.compaction, "the matching candidate is consumed");
  assert.equal(takeover.compaction.summary, composeMemorySummary([BLOCK]));
  assert.equal(takeover.compaction.summary, MEMORY_SUMMARY_WRAPPER + "\n---\n\n" + BLOCK);
  assert.equal(takeover.compaction.firstKeptEntryId, "e4",
    "the current real-user request becomes firstKeptEntryId");
  assert.equal(takeover.compaction.tokensBefore, 4321,
    "the takeover uses truthful Pi preparation token accounting");
  assert.deepEqual(takeover.compaction.details, {
    format: MEMORY_FORMAT_TAG,
    blocks: [{ endEntryId: "e3", markdownBytes: Buffer.byteLength(BLOCK, "utf8") }],
  }, "the directory ends at the last eligible entry before the request");
  assert.equal(takeover.cancel, undefined, "the takeover never cancels");
  assert.deepEqual(harness.registration.snapshot(), { state: "committing" });

  // ── Exact saved-entry confirmation ──

  const compactEvent = appendCompactionEntry(session, takeover.compaction, true);
  await harness.emit("session_compact", compactEvent, ctx);
  const committed = harness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
  assert.equal(committed.state, "active", "confirmation derives the committed Memory");
  assert.equal(committed.blocks, 1);
  assert.ok(harness.activeTools().includes("read_memory_source"),
    "committed Memory activates the reading surface");
  assert.ok(!harness.activeTools().includes("submit_memory"));

  // The kept tail stays recent: the request plus its full assistant/tool run.
  const derived = harness.registration.inspect({ block: 1, page: 1 }, session);
  assert.equal(derived.ok, true);
  assert.ok(derived.text.includes(BLOCK), "the block body survives byte-exact");
  assert.ok(derived.text.includes("walk me through the repo"), "block 1 covers the first eligible entry");
  assert.equal(harness.compactCalls.length, 1, "no further compaction is triggered");

  // ── Safe fallback: no candidate means native compaction proceeds ──

  {
    const fallback = createHarness();
    const nativeSession = mutableSession(preRunBranch());
    const nativeCtx = fallback.baseContext(nativeSession);
    await fallback.emit("session_start", { type: "session_start", reason: "startup" }, nativeCtx);
    const result = await fallback.emit("session_before_compact", beforeCompactEvent(nativeSession), nativeCtx);
    assert.equal(result, undefined, "no candidate returns no custom compaction");
  }

  // ── Safe fallback: a branch mismatch clears the slot without cancel ──

  {
    const mismatch = createHarness();
    const mismatchSession = mutableSession(preRunBranch());
    const mismatchCtx = mismatch.baseContext(mismatchSession);
    await mismatch.emit("session_start", { type: "session_start", reason: "startup" }, mismatchCtx);
    await mismatch.emit("input", { type: "input", text: "ship it", source: "rpc" }, mismatchCtx);
    appendDueRun(mismatchSession, BLOCK);
    await mismatch.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } }] },
    }, mismatchCtx);
    await mismatch.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, mismatchCtx);
    await mismatch.emit("agent_settled", { type: "agent_settled" }, mismatchCtx);
    assert.equal(mismatch.compactCalls.length, 1);

    // The user request entry is gone (navigation behind the candidate's back).
    mismatchSession.__entries = mismatchSession.__entries.filter((entry) => entry.id !== "e4");
    const cleared = await mismatch.emit("session_before_compact", beforeCompactEvent(mismatchSession), mismatchCtx);
    assert.equal(cleared, undefined, "a mismatched snapshot returns no custom compaction");
    assert.equal(cleared && cleared.cancel, undefined);
    assert.notDeepEqual(mismatch.registration.snapshot(), { state: "committing" },
      "the slot is cleared after the mismatch");
  }

  // ── Conflict: a competing handler saved a different entry ──

  {
    const conflict = createHarness();
    const conflictSession = mutableSession(preRunBranch());
    const conflictCtx = conflict.baseContext(conflictSession);
    await conflict.emit("session_start", { type: "session_start", reason: "startup" }, conflictCtx);
    await conflict.emit("input", { type: "input", text: "ship it", source: "interactive" }, conflictCtx);
    appendDueRun(conflictSession, BLOCK);
    await conflict.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } }] },
    }, conflictCtx);
    await conflict.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, conflictCtx);
    await conflict.emit("agent_settled", { type: "agent_settled" }, conflictCtx);
    const consumed = await conflict.emit("session_before_compact", beforeCompactEvent(conflictSession), conflictCtx);
    assert.ok(consumed?.compaction);

    // Another handler wins the append with a different native summary.
    conflictSession.__entries.push(userEntry("e4", "e3", "ship it"));
    const foreignEntry = {
      id: "c-foreign", parentId: "e4", type: "compaction", timestamp: TS,
      summary: "a plain native summary", firstKeptEntryId: "e4", tokensBefore: 4321, fromExtension: false,
    };
    conflictSession.__entries = conflictSession.__entries.filter((entry) => entry.id !== "e4");
    conflictSession.__entries.push(userEntry("e4", "e3", "ship it"));
    conflictSession.__entries.push(foreignEntry);
    await conflict.emit("session_compact", {
      type: "session_compact", compactionEntry: foreignEntry, fromExtension: false, reason: "threshold", willRetry: false,
    }, conflictCtx);
    assert.equal(conflict.notified.length, 1, "one bounded conflict diagnostic");
    assert.match(conflict.notified[0].text, /^COMPACTION_CONFLICT: /);
    assert.equal(conflict.notified[0].level, "warning");
    assert.deepEqual(conflict.registration.snapshot(), { state: "opaque" },
      "the foreign entry stays ordinary opaque Pi context");
  }

  // ── An aborted run discards its pending submission ──

  {
    const aborted = createHarness();
    const abortedSession = mutableSession(preRunBranch());
    const abortedCtx = aborted.baseContext(abortedSession);
    await aborted.emit("session_start", { type: "session_start", reason: "startup" }, abortedCtx);
    await aborted.emit("input", { type: "input", text: "ship it", source: "interactive" }, abortedCtx);
    appendDueRun(abortedSession, BLOCK);
    await aborted.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } }] },
    }, abortedCtx);
    await aborted.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, abortedCtx);
    await aborted.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "…" }], stopReason: "aborted" }],
    }, abortedCtx);
    await aborted.emit("agent_settled", { type: "agent_settled" }, abortedCtx);
    assert.equal(aborted.compactCalls.length, 0, "an aborted run never compacts its discarded candidate");
    assert.notDeepEqual(aborted.registration.snapshot(), { state: "pending" });
  }

  // ── Tree and model invalidation clear the open handshake ──

  {
    const invalidation = createHarness();
    const invalidationSession = mutableSession(preRunBranch());
    const invalidationCtx = invalidation.baseContext(invalidationSession);
    await invalidation.emit("session_start", { type: "session_start", reason: "startup" }, invalidationCtx);
    await invalidation.emit("input", { type: "input", text: "ship it", source: "interactive" }, invalidationCtx);
    assert.ok(invalidation.activeTools().includes("submit_memory"));
    await invalidation.emit("session_tree", {
      type: "session_tree", newLeafId: "e1", oldLeafId: "e3",
    }, invalidationCtx);
    assert.ok(!invalidation.activeTools().includes("submit_memory"),
      "tree navigation closes the due run");
    await invalidation.emit("input", { type: "input", text: "again", source: "interactive" }, invalidationCtx);
    assert.ok(invalidation.activeTools().includes("submit_memory"));
    await invalidation.emit("model_select", {
      type: "model_select", model: {}, previousModel: undefined, source: "set",
    }, invalidationCtx);
    assert.ok(!invalidation.activeTools().includes("submit_memory"),
      "a model change invalidates the handshake and recomputes the budget");
  }

  // ── Projection failure returns the unmodified context and closes the window ──

  {
    const failure = createHarness();
    const failureSession = mutableSession(preRunBranch());
    const failureCtx = failure.baseContext(failureSession);
    await failure.emit("session_start", { type: "session_start", reason: "startup" }, failureCtx);
    await failure.emit("input", { type: "input", text: "ship it", source: "interactive" }, failureCtx);
    assert.ok(failure.activeTools().includes("submit_memory"));
    const result = await failure.emit("context", {
      type: "context",
      messages: [{ role: "assistant", content: [{ type: "text", text: "no user message" }] }],
    }, failureCtx);
    assert.equal(result, undefined, "a projection failure returns the unmodified context");
    assert.ok(!failure.activeTools().includes("submit_memory"),
      "submission is deactivated for the run after the failure");
    assert.ok(!failure.registration.snapshot().state !== undefined);
  }

  // ── A new real-user run clears a stale pending candidate ──

  {
    const stale = createHarness();
    const staleSession = mutableSession(preRunBranch());
    const staleCtx = stale.baseContext(staleSession);
    await stale.emit("session_start", { type: "session_start", reason: "startup" }, staleCtx);
    await stale.emit("input", { type: "input", text: "ship it", source: "interactive" }, staleCtx);
    appendDueRun(staleSession, BLOCK);
    await stale.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } }] },
    }, staleCtx);
    await stale.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, staleCtx);
    await stale.emit("agent_settled", { type: "agent_settled" }, { ...staleCtx, isIdle: () => false });
    assert.equal(stale.compactCalls.length, 0, "a non-idle settle never compacts");
    await stale.emit("input", { type: "input", text: "next task", source: "interactive" }, staleCtx);
    assert.notDeepEqual(stale.registration.snapshot(), { state: "pending" },
      "the new real-user run discards the stale candidate");
  }

  // ── Default-off and no-usage configurations never open the handshake ──

  {
    const disabled = createHarness({ config: { enabled: false, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 } });
    await disabled.emit("session_start", { type: "session_start", reason: "startup" });
    await disabled.emit("input", { type: "input", text: "ship it", source: "interactive" });
    assert.deepEqual(disabled.registration.snapshot(), { state: "disabled" });
    assert.ok(!disabled.activeTools().includes("submit_memory"));

    const unknownUsage = createHarness({ usageUnavailable: true });
    await unknownUsage.emit("session_start", { type: "session_start", reason: "startup" }, unknownUsage.baseContext(mutableSession(preRunBranch())));
    assert.deepEqual(unknownUsage.registration.snapshot(), { state: "no-memory" },
      "unknown usage falls back to the deterministic branch estimate, which is not due here");
  }

  // ── Submit artifacts leave every provider-bound request (#215) ──

  {
    const filtering = createHarness();
    const filteringSession = mutableSession(preRunBranch());
    const filteringCtx = filtering.baseContext(filteringSession);
    await filtering.emit("session_start", { type: "session_start", reason: "startup" }, filteringCtx);
    const request = [
      { role: "user", content: "old task", timestamp: 1 },
      { role: "assistant", content: [
        { type: "text", text: "kept ordinary text" },
        { type: "toolCall", id: "call-submit-old", name: "submit_memory", arguments: { markdown: "# stale" } },
      ], timestamp: 2 },
      { role: "toolResult", toolCallId: "call-submit-old", toolName: "submit_memory", content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], timestamp: 3 },
      { role: "assistant", content: [
        { type: "toolCall", id: "call-read-src", name: "read_memory_source", arguments: { block: 1, page: 1 } },
      ], timestamp: 4 },
      { role: "toolResult", toolCallId: "call-read-src", toolName: "read_memory_source", content: [{ type: "text", text: "page" }], timestamp: 5 },
      { role: "user", content: "next task", timestamp: 6 },
    ];
    const filtered = await filtering.emit("context", { type: "context", messages: request }, filteringCtx);
    assert.ok(filtered?.messages, "the transform runs even outside a due run");
    const serialized = JSON.stringify(filtered.messages);
    assert.ok(!serialized.includes("submit_memory"), "submit call parts and results leave the request");
    assert.ok(!serialized.includes("Memory candidate accepted"), "paired results leave the request");
    assert.ok(serialized.includes("kept ordinary text"), "ordinary assistant text survives its message");
    assert.ok(serialized.includes("read_memory_source"), "read artifacts stay provider-visible");
    assert.equal(filtered.messages.length, 5, "only the paired submit result drops as a whole message");
  }

  // ── #219: appending further blocks onto committed Memory ──

  {
    const appendHarness = createHarness();
    const session = mutableSession(preRunBranch()); // e1..e3 eligible old prefix
    appendDueRun(session, BLOCK); // e4 request, e5 submit call, e6 paired result
    const blockOne = composeMemorySummary([BLOCK]);
    const directoryOne = {
      format: MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: "e3", markdownBytes: Buffer.byteLength(BLOCK, "utf8") }],
    };
    session.__entries.push({
      id: "c1", parentId: "e6", type: "compaction", timestamp: TS,
      summary: blockOne, firstKeptEntryId: "e4", tokensBefore: 4321,
      details: directoryOne, fromExtension: true,
    });

    // The newly accumulated eligible raw prefix: an ordinary exchange plus a
    // read_memory_source round trip that stays usable now but must never
    // enter a later block-source stream.
    session.__entries.push(userEntry("e7", "c1", "now compress the parser work too"));
    session.__entries.push(assistantEntry("e8", "e7", [
      { type: "text", text: "checking the exact prior exchange first" },
      { type: "toolCall", id: "call-read-src", name: "read_memory_source", arguments: { block: 1, page: 1 } },
    ]));
    session.__entries.push(toolResultEntry("e9", "e8", "read_memory_source", "MEMORY-PAGE-NEEDLE"));
    session.__entries.push(assistantEntry("e10", "e9", [{ type: "text", text: "the exact exchange is verified" }]));

    const appendCtx = appendHarness.baseContext(session);
    await appendHarness.emit("session_start", { type: "session_start", reason: "resume" }, appendCtx);
    await appendHarness.emit("input", { type: "input", text: "ship the parser block", source: "interactive" }, appendCtx);
    assert.ok(appendHarness.activeTools().includes("submit_memory"),
      "the due real-user run activates submit_memory onto existing Memory");
    assert.ok(appendHarness.activeTools().includes("read_memory_source"),
      "valid Memory keeps read_memory_source active beside the due submit tool");
    assert.deepEqual(
      appendHarness.activeTools().filter((name) => name !== "submit_memory" && name !== "read_memory_source"),
      ["read", "bash"],
      "unrelated active tools keep their identity and order across the append boundary",
    );

    const roundTwoRequest = [
      { role: "user", content: "walk me through the repo", timestamp: 1 },
      { role: "assistant", content: [
        { type: "text", text: "kept ordinary text" },
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ], timestamp: 2 },
      { role: "toolResult", toolCallId: "call-submit", toolName: "submit_memory", content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], timestamp: 3 },
      { role: "user", content: "ship the parser block", timestamp: 4 },
    ];
    const transformed = await appendHarness.emit("context", { type: "context", messages: roundTwoRequest }, appendCtx);
    assert.ok(transformed?.messages, "the append run transforms its provider requests");
    const nonAdvisory = JSON.stringify(
      transformed.messages.filter((message) => message?.customType !== CONTEXT_MEMORY_ADVISORY_TYPE),
    );
    assert.ok(!nonAdvisory.includes("submit_memory"),
      "round-one submit artifacts leave the append run's requests too");
    assert.ok(!nonAdvisory.includes("Memory candidate accepted"), "paired results leave the request");
    assert.ok(nonAdvisory.includes("kept ordinary text"), "ordinary assistant text survives");
    const advisory = transformed.messages.at(-1);
    assert.equal(advisory.role, "custom");
    assert.equal(advisory.customType, CONTEXT_MEMORY_ADVISORY_TYPE);
    assert.ok(advisory.content.includes("since the existing Memory blocks"),
      "the append advisory names the newly accumulated source scope");
    assert.ok(advisory.content.includes("appended after the existing Memory blocks"),
      "the append advisory identifies the append operation");
    assert.ok(!advisory.content.includes("replace the older conversation"),
      "the first-block phrasing is not reused");
    assert.ok(advisory.content.includes("Do not copy credential values"), "the secret warning stays");

    const BLOCK2 = "# Parser work\n\n- the parser walk was verified exactly";
    session.__entries.push(userEntry("e11", "e10", "ship the parser block"));
    session.__entries.push(assistantEntry("e12", "e11", [
      { type: "text", text: "done — appending the parser Memory block" },
      { type: "toolCall", id: "call-append", name: "submit_memory", arguments: { markdown: BLOCK2 } },
    ]));
    session.__entries.push(toolResultEntry("e13", "e12", "submit_memory", "Memory candidate accepted; compaction pending."));
    await appendHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "text", text: "done — appending the parser Memory block" },
        { type: "toolCall", id: "call-append", name: "submit_memory", arguments: { markdown: BLOCK2 } },
      ] },
    }, appendCtx);
    const acceptedTwo = await appendHarness.tools.get("submit_memory")
      .execute("call-append", { markdown: BLOCK2 }, undefined, undefined, appendCtx);
    assert.equal(acceptedTwo.content[0].text, "Memory candidate accepted; compaction pending.");
    assert.deepEqual(appendHarness.registration.snapshot(), { state: "pending" });

    await appendHarness.emit("agent_settled", { type: "agent_settled" }, appendCtx);
    assert.equal(appendHarness.compactCalls.length, 1, "the append candidate reaches Pi's seam once");
    assert.ok(!appendHarness.activeTools().includes("submit_memory"),
      "settle closes the append run and deactivates submit_memory");
    assert.ok(appendHarness.activeTools().includes("read_memory_source"),
      "the reading surface stays active across the settle boundary");

    const takeoverTwo = await appendHarness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e11", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 8888, settings: {} },
      branchEntries: session.getBranch(),
      reason: "manual",
      willRetry: false,
      signal: undefined,
    }, appendCtx);
    assert.ok(takeoverTwo?.compaction, "the append candidate is consumed");
    assert.equal(takeoverTwo.compaction.summary, composeMemorySummary([BLOCK, BLOCK2]));
    assert.ok(takeoverTwo.compaction.summary.startsWith(blockOne),
      "the complete existing rendering stays the byte-identical prefix");
    assert.equal(takeoverTwo.compaction.summary.slice(blockOne.length), "\n---\n\n" + BLOCK2,
      "divergence begins exactly at the separator before the new body");
    assert.equal(takeoverTwo.compaction.firstKeptEntryId, "e11",
      "the append run's user request becomes the retained-tail boundary");
    assert.equal(takeoverTwo.compaction.tokensBefore, 8888);
    assert.deepEqual(takeoverTwo.compaction.details, {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: "e3", markdownBytes: Buffer.byteLength(BLOCK, "utf8") },
        { endEntryId: "e10", markdownBytes: Buffer.byteLength(BLOCK2, "utf8") },
      ],
    }, "the directory carries the unchanged entry plus one new ordered end");

    session.__entries.push({
      id: "c2", parentId: "e13", type: "compaction", timestamp: TS,
      summary: takeoverTwo.compaction.summary, firstKeptEntryId: "e11",
      tokensBefore: 8888, details: takeoverTwo.compaction.details, fromExtension: true,
    });
    await appendHarness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: session.__entries.at(-1),
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, appendCtx);

    const committedTwo = appendHarness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
    assert.equal(committedTwo.state, "active");
    assert.equal(committedTwo.blocks, 2, "the appended Memory carries both blocks");
    assert.equal(committedTwo.stablePrefix, 2);
    assert.equal(committedTwo.nextOperation, "append", "two small blocks still append next");
    assert.equal(committedTwo.rows.length, 2);
    assert.equal(committedTwo.rows[1].sources, 5,
      "block 2 covers exactly the accumulated eligible entries between the two boundaries");

    // The new block's source stream keeps ordinary text and drops every
    // protocol artifact: the round-one submit result, the read call part,
    // and the paired read result.
    const inspectedTwo = appendHarness.registration.inspect({ block: 2, page: 1 }, session);
    assert.equal(inspectedTwo.ok, true);
    assert.ok(inspectedTwo.text.includes(BLOCK2));
    assert.ok(inspectedTwo.text.includes("now compress the parser work too"), "the kept-tail request enters block 2");
    assert.ok(inspectedTwo.text.includes("checking the exact prior exchange first"), "ordinary text beside a read call survives");
    assert.ok(inspectedTwo.text.includes("the exact exchange is verified"));
    for (const forbidden of ["read_memory_source", "MEMORY-PAGE-NEEDLE", "Memory candidate accepted", "walk me through the repo"]) {
      assert.ok(!inspectedTwo.text.includes(forbidden),
        `block 2 sources never expose ${JSON.stringify(forbidden)}`);
    }
    const inspectedOne = appendHarness.registration.inspect({ block: 1, page: 1 }, session);
    assert.equal(inspectedOne.ok, true);
    assert.ok(inspectedOne.text.includes("walk me through the repo"), "block 1 keeps its original sources after the append");

    // ── A repeated append keeps the two-block prefix byte-identical ──

    session.__entries.push(userEntry("e14", "c2", "one more exchange"));
    session.__entries.push(assistantEntry("e15", "e14", [{ type: "text", text: "acknowledged again" }]));
    await appendHarness.emit("agent_settled", { type: "agent_settled" }, appendCtx);
    await appendHarness.emit("input", { type: "input", text: "ship the third block", source: "interactive" }, appendCtx);
    assert.ok(appendHarness.activeTools().includes("submit_memory"),
      "the third due run opens after the settled usage re-derivation");
    session.__entries.push(userEntry("e16", "e15", "ship the third block"));
    const BLOCK3 = "# Third block\n\n- appended after two unchanged blocks";
    session.__entries.push(assistantEntry("e17", "e16", [
      { type: "text", text: "done — appending the third block" },
      { type: "toolCall", id: "call-append-3", name: "submit_memory", arguments: { markdown: BLOCK3 } },
    ]));
    session.__entries.push(toolResultEntry("e18", "e17", "submit_memory", "Memory candidate accepted; compaction pending."));
    await appendHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-append-3", name: "submit_memory", arguments: { markdown: BLOCK3 } },
      ] },
    }, appendCtx);
    await appendHarness.tools.get("submit_memory").execute("call-append-3", { markdown: BLOCK3 }, undefined, undefined, appendCtx);
    await appendHarness.emit("agent_settled", { type: "agent_settled" }, appendCtx);
    const takeoverThree = await appendHarness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e16", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 9999, settings: {} },
      branchEntries: session.getBranch(),
      reason: "manual",
      willRetry: false,
      signal: undefined,
    }, appendCtx);
    assert.ok(takeoverThree?.compaction);
    assert.equal(takeoverThree.compaction.summary, composeMemorySummary([BLOCK, BLOCK2, BLOCK3]));
    assert.ok(takeoverThree.compaction.summary.startsWith(takeoverTwo.compaction.summary),
      "the repeated append keeps the two-block rendering byte-identical");
    assert.deepEqual(takeoverThree.compaction.details.blocks.slice(0, 2), takeoverTwo.compaction.details.blocks,
      "the existing directory entries stay byte-identical on the repeated append");
    assert.equal(takeoverThree.compaction.details.blocks[2].endEntryId, "e15");
  }

  // ── #219: the total Memory budget rejects an append rather than truncating ──

  {
    // window 200000 · threshold 5000 · budget 2% = 4000 tokens. The existing
    // block renders far below half budget so the append run opens; a new
    // block that fits the 16 KiB per-block bound but pushes the complete
    // rendering past the total budget is refused.
    const budgetHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 2 },
    });
    const existing = "e".repeat(100);
    const session = mutableSession([
      userEntry("b1", null, "long task"),
      assistantEntry("b2", "b1", [{ type: "text", text: "x".repeat(400) }]),
      userEntry("b3", "b2", "ship it"),
      compactionOf("bc", "b3", "b3", [existing], ["b2"]),
    ]);
    const budgetCtx = budgetHarness.baseContext(session);
    await budgetHarness.emit("session_start", { type: "session_start", reason: "resume" }, budgetCtx);
    await budgetHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, budgetCtx);
    assert.ok(budgetHarness.activeTools().includes("submit_memory"),
      "the existing Memory still sits below half budget so the append run opens");
    session.__entries.push(userEntry("b4", "bc", "ship it"));
    session.__entries.push(assistantEntry("b5", "b4", [
      { type: "toolCall", id: "call-budget", name: "submit_memory", arguments: { markdown: "n".repeat(15900) } },
    ]));
    await budgetHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-budget", name: "submit_memory", arguments: { markdown: "n".repeat(15900) } },
      ] },
    }, budgetCtx);
    await assert.rejects(
      () => budgetHarness.tools.get("submit_memory")
        .execute("call-budget", { markdown: "n".repeat(15900) }, undefined, undefined, budgetCtx),
      (error) => {
        assert.match(error.message, /^BOUND_EXCEEDED: /);
        assert.ok(!error.message.includes("nnnn"), "the failure never echoes the Memory body");
        return true;
      },
    );
    assert.notDeepEqual(budgetHarness.registration.snapshot(), { state: "pending" },
      "the rejected append stores no candidate");
  }

  // ── #219: the 64 KiB details cap rejects an append rather than evicting ──

  {
    // window 200000 · threshold 80% → due point 160000 · budget 25% = 50000
    // tokens, so many one-byte blocks stay far below half budget. The
    // existing directory is the largest one that still fits the 64 KiB
    // serialization cap; one more ordered item must cross it, and the cap
    // rejects the append instead of evicting blocks to make it fit.
    const capHarness = createHarness({
      config: { enabled: true, compressionThreshold: { percent: 80 }, memoryBudgetPercent: 25 },
      usage: { tokens: 170000, contextWindow: 200000 },
    });
    const idOf = (index) => `entry-${String(index).padStart(12, "0")}-block`;
    const dirBytes = (count) => Buffer.byteLength(JSON.stringify({
      format: MEMORY_FORMAT_TAG,
      blocks: Array.from({ length: count }, (_, index) => ({ endEntryId: idOf(index), markdownBytes: 1 })),
    }), "utf8");
    let blocks = 1;
    while (dirBytes(blocks + 1) <= MEMORY_DETAILS_MAX_BYTES) blocks += 1;
    assert.ok(dirBytes(blocks + 1) > MEMORY_DETAILS_MAX_BYTES,
      "the fixture really crosses the serialization cap on the appended item");

    const entries = [];
    for (let i = 0; i < blocks; i++) {
      const parent = entries.at(-1)?.id ?? null;
      entries.push(userEntry(idOf(i), parent, `exchange ${i}`));
    }
    // The kept tail begins at the next id, which the appended block would
    // claim as its ordered end.
    entries.push(userEntry(idOf(blocks), idOf(blocks - 1), "ship it"));
    const bodies = Array.from({ length: blocks }, () => "x");
    entries.push(compactionOf("cc", idOf(blocks), idOf(blocks), bodies, Array.from({ length: blocks }, (_, i) => idOf(i))));
    const session = mutableSession(entries);
    const capCtx = capHarness.baseContext(session);
    await capHarness.emit("session_start", { type: "session_start", reason: "resume" }, capCtx);
    const active = capHarness.registration.snapshot({ tokens: 170000, contextWindow: 200000 });
    assert.equal(active.state, "active");
    assert.equal(active.blocks, blocks, "the fixture Memory stays strictly inside every bound");
    await capHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, capCtx);
    assert.ok(capHarness.activeTools().includes("submit_memory"),
      "the tiny blocks still sit below half budget so the append run opens");
    session.__entries.push(userEntry("over-req", "cc", "ship it"));
    session.__entries.push(assistantEntry("over", "over-req", [
      { type: "toolCall", id: "call-cap", name: "submit_memory", arguments: { markdown: "y" } },
    ]));
    await capHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-cap", name: "submit_memory", arguments: { markdown: "y" } },
      ] },
    }, capCtx);
    await assert.rejects(
      () => capHarness.tools.get("submit_memory").execute("call-cap", { markdown: "y" }, undefined, undefined, capCtx),
      (error) => {
        assert.match(error.message, /^BOUND_EXCEEDED: /);
        return true;
      },
    );
    assert.notDeepEqual(capHarness.registration.snapshot(), { state: "pending" },
      "the over-cap append stores no candidate; no block is evicted to make it fit");
  }

  // ── #219: Memory above half budget does not open an append run ──

  {
    // window 200000 · threshold 5000 · budget 2% = 4000 tokens → half is
    // 2000 tokens (8000 chars). One 8100-char block renders above half, so
    // the next due run belongs to the suffix rebuild (#220), not append.
    const overHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 2 },
    });
    const big = "b".repeat(8100);
    const session = mutableSession([
      userEntry("h1", null, "long task"),
      assistantEntry("h2", "h1", [{ type: "text", text: "work" }]),
      userEntry("h3", "h2", "ship it"),
      compactionOf("hc", "h3", "h3", [big], ["h2"]),
    ]);
    const overCtx = overHarness.baseContext(session);
    await overHarness.emit("session_start", { type: "session_start", reason: "resume" }, overCtx);
    await overHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, overCtx);
    assert.ok(!overHarness.activeTools().includes("submit_memory"),
      "Memory above half budget does not open an append run");
    assert.ok(overHarness.activeTools().includes("read_memory_source"),
      "the reading surface is unaffected by the next-operation choice");
    const snapshot = overHarness.registration.snapshot({ tokens: 12000, contextWindow: 200000 });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.nextOperation, "rebuild", "/context reports the rebuild operation");
    assert.equal(snapshot.stablePrefix, 0, "no block stays stable under a full suffix rebuild");
  }

  // ── The deterministic fallback estimator flags a large resumed branch ──

  {
    const entries = [];
    for (let i = 0; i < 40; i++) {
      const parent = entries.at(-1)?.id ?? null;
      const id = `u${i}`;
      entries.push(userEntry(id, parent, `task update ${i} `.repeat(64)));
      entries.push(assistantEntry(`a${i}`, id, [{ type: "text", text: `acknowledged ${i} `.repeat(64) }]));
    }
    const estimator = createHarness({ usage: { tokens: null, contextWindow: 200000 } });
    const estimatorCtx = estimator.baseContext(mutableSession(entries));
    await estimator.emit("session_start", { type: "session_start", reason: "resume" }, estimatorCtx);
    assert.deepEqual(estimator.registration.snapshot(), { state: "due" },
      "null usage falls back to the deterministic estimate and flags the large branch");
  }
  console.log("context-memory submit tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
