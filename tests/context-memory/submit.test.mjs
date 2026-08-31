import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { effectiveDuePoint } = await load("../../src/context-memory/controller.ts");
const { MEMORY_FORMAT_TAG, MEMORY_SUMMARY_WRAPPER, composeMemorySummary } = await load("../../src/context-memory/format.ts");
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
