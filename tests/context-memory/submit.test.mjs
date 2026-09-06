import assert from "node:assert/strict";
import jiti from "jiti";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
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
    registerMessageRenderer() {},
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

function beforeCompactEvent(session, tokensBefore = 4321, reason = "manual") {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "e4", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore, settings: {} },
    branchEntries: session.getBranch(),
    reason,
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
  assert.ok(advisory.content.includes("sole tool call of its batch"), "the advisory demands the sole tool call of its batch");
  assert.ok(advisory.content.includes("Complete the user's current task first"), "the advisory still requires the task first");
  assert.ok(advisory.content.includes("continue the same run"), "the advisory keeps the run running after the submission");
  assert.ok(!advisory.content.includes("finish the run"), "the advisory no longer ends the run with the submission");
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
  assert.equal(accepted.terminate, undefined, "the accepted submission no longer ends the run (#253)");
  assert.deepEqual(Object.keys(accepted.details), ["accepted"]);
  assert.deepEqual(harness.registration.snapshot(), { state: "pending" });
  assert.ok(!harness.activeTools().includes("submit_memory"),
    "acceptance deactivates submit_memory for the rest of the due run");
  assert.ok(harness.activeTools().includes("read"),
    "unrelated active tools keep their identity after acceptance");

  // A duplicate submission while the slot is pending is refused.
  await assert.rejects(
    () => submit.execute("call-submit", { markdown: BLOCK }, undefined, undefined, ctx),
    (error) => {
      assert.match(error.message, /^COMPACTION_BUSY: /);
      return true;
    },
  );

  // ── #253: the run continues after the acknowledgement ──

  // The model keeps working in the same run: further ordinary entries land on
  // the branch after the accepted submission, and the candidate stays pending
  // exactly as before.
  session.__entries.push(assistantEntry("e7", "e6", [
    { type: "text", text: "still working — the run did not end with the submission" },
    { type: "toolCall", id: "call-read-late", name: "read", arguments: { path: "x" } },
  ]));
  session.__entries.push(toolResultEntry("e8", "e7", "read", "late run evidence"));
  session.__entries.push(assistantEntry("e9", "e8", [{ type: "text", text: "the task is complete" }]));
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "the task is complete" }] },
  }, ctx);
  assert.deepEqual(harness.registration.snapshot(), { state: "pending" },
    "the candidate stays pending while the run continues");

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
  const committedProjection = buildSessionContext(session.getBranch(), session.getLeafId()).messages;
  assert.ok(committedProjection.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.text === "late run evidence")),
    "post-submission work stays uncompressed after the kept boundary");
  assert.ok(committedProjection.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.text === "the task is complete")),
    "the post-acknowledgement answer stays in the retained tail");

  // ── Safe fallback: no candidate means native compaction proceeds ──

  {
    const fallback = createHarness();
    const nativeSession = mutableSession(preRunBranch());
    const nativeCtx = fallback.baseContext(nativeSession);
    await fallback.emit("session_start", { type: "session_start", reason: "startup" }, nativeCtx);
    const result = await fallback.emit("session_before_compact", beforeCompactEvent(nativeSession), nativeCtx);
    assert.equal(result, undefined, "no candidate returns no custom compaction");
  }

  // ── #253: threshold/fallback interaction around the due-point safety clamp ──

  {
    // The ten-percent figure is the gap between the due point and Pi's native
    // compaction boundary — window 200000, reserve 16384, native boundary
    // 183616, clamp 163616, configured threshold 5000 — not a margin
    // guaranteed to remain when a due run opens. Usage is only re-checked at
    // session start, model selection, and agent settle, so the previous run
    // can settle with usage already far past the due point: at 170000 tokens
    // the distance left below the native boundary is 13616, under the 20000
    // ten-percent figure, and the due run still opens. Margin exhaustion is
    // then owned by Pi's own threshold path — checked after a completed run
    // and before the next prompt, never mid-run — through the same
    // `session_before_compact` seam, never by refusing or cutting the run.
    assert.equal(
      effectiveDuePoint(DUE_CONFIG.compressionThreshold, DUE_CONFIG.memoryBudgetPercent, 200000, 16384),
      5000,
      "the configured threshold sits far below the safety clamp",
    );
    assert.ok(183616 - 170000 < 200000 / 10,
      "this scenario opens the due run with less than ten percent of the window left below the native boundary");

    // With an accepted candidate, Pi's post-run threshold check consumes it:
    // the Memory compaction commits through the takeover, post-submission
    // work stays in the retained tail, and the later settle never compacts a
    // second time.
    const margin = createHarness({ usage: { tokens: 170000, contextWindow: 200000 } });
    const marginSession = mutableSession(preRunBranch());
    const marginCtx = margin.baseContext(marginSession);
    await margin.emit("session_start", { type: "session_start", reason: "startup" }, marginCtx);
    await margin.emit("input", { type: "input", text: "ship it", source: "interactive" }, marginCtx);
    assert.ok(margin.activeTools().includes("submit_memory"),
      "the due run opens even though usage settled far past the due point before it");
    appendDueRun(marginSession, BLOCK);
    await margin.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "text", text: "done — submitting the Memory block" },
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ] },
    }, marginCtx);
    const submitTool = margin.tools.get("submit_memory");
    const acceptedLate = await submitTool.execute("call-submit", { markdown: BLOCK }, undefined, undefined, marginCtx);
    assert.equal(acceptedLate.terminate, undefined, "the accepted submission keeps the run going");
    marginSession.__entries.push(assistantEntry("e7", "e6", [
      { type: "text", text: "kept working past the remaining distance" },
    ]));
    const takeover = await margin.emit("session_before_compact", beforeCompactEvent(marginSession, 190000, "threshold"), marginCtx);
    assert.ok(takeover && takeover.compaction, "the threshold check consumes the pending candidate");
    assert.equal(takeover.compaction.firstKeptEntryId, "e4",
      "the run's real-user request stays the kept boundary");
    assert.equal(takeover.cancel, undefined, "the takeover never cancels");
    const compactEvent = appendCompactionEntry(marginSession, takeover.compaction, true);
    await margin.emit("session_compact", compactEvent, marginCtx);
    assert.equal(margin.registration.snapshot({ tokens: 900, contextWindow: 200000 }).state, "active",
      "the threshold-consumed candidate commits as Memory");
    await margin.emit("agent_settled", { type: "agent_settled" }, marginCtx);
    assert.equal(margin.compactCalls.length, 0,
      "a candidate the threshold path consumed never triggers a second settle compaction");
    const marginProjection = buildSessionContext(marginSession.getBranch(), marginSession.getLeafId()).messages;
    assert.ok(marginProjection.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part?.text === "kept working past the remaining distance")),
      "post-submission work past the remaining distance stays in the retained tail");

    // Without a submission, the same threshold check offers no takeover:
    // Pi native compaction proceeds and its foreign entry closes the due run.
    const noSubmit = createHarness({ usage: { tokens: 170000, contextWindow: 200000 } });
    const noSubmitSession = mutableSession(preRunBranch());
    const noSubmitCtx = noSubmit.baseContext(noSubmitSession);
    await noSubmit.emit("session_start", { type: "session_start", reason: "startup" }, noSubmitCtx);
    await noSubmit.emit("input", { type: "input", text: "ship it", source: "interactive" }, noSubmitCtx);
    assert.ok(noSubmit.activeTools().includes("submit_memory"), "the due run opens");
    noSubmitSession.__entries.push(userEntry("e4", "e3", "ship it"));
    noSubmitSession.__entries.push(assistantEntry("e5", "e4", [
      { type: "text", text: "still working past the margin without submitting" },
    ]));
    const native = await noSubmit.emit("session_before_compact", beforeCompactEvent(noSubmitSession, 190000, "threshold"), noSubmitCtx);
    assert.equal(native, undefined, "no submission means no custom compaction is offered");
    const nativeEntry = {
      id: "c-native", parentId: "e5", type: "compaction", timestamp: TS,
      summary: "a plain native summary", firstKeptEntryId: "e4", tokensBefore: 4321, fromExtension: false,
    };
    noSubmitSession.__entries.push(nativeEntry);
    await noSubmit.emit("session_compact", {
      type: "session_compact", compactionEntry: nativeEntry, fromExtension: false, reason: "threshold", willRetry: false,
    }, noSubmitCtx);
    assert.ok(!noSubmit.activeTools().includes("submit_memory"),
      "the foreign compaction closes the due run whose submission window is gone");
    assert.deepEqual(noSubmit.registration.snapshot(), { state: "opaque" },
      "the branch degrades to the ordinary opaque native summary");
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

  // ── Submit artifacts leave provider-bound requests; the trailing pair passes whole (#215, #253) ──

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

  {
    // The immediate continuation request keeps the trailing submitting
    // exchange whole (#253): removing the call would end the request on an
    // assistant turn, and removing only the result leaves an unpaired tool
    // call — both shapes are rejected by providers.
    const tailPair = createHarness();
    const tailSession = mutableSession(preRunBranch());
    const tailCtx = tailPair.baseContext(tailSession);
    await tailPair.emit("session_start", { type: "session_start", reason: "startup" }, tailCtx);
    const continuationRequest = [
      { role: "user", content: "old task", timestamp: 1 },
      { role: "assistant", content: [
        { type: "text", text: "done — submitting the Memory block" },
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ], timestamp: 2 },
      { role: "toolResult", toolCallId: "call-submit", toolName: "submit_memory", content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], timestamp: 3 },
    ];
    const tailTransform = await tailPair.emit("context", { type: "context", messages: continuationRequest }, tailCtx);
    assert.equal(tailTransform?.messages.length, continuationRequest.length,
      "the trailing submitting exchange passes through whole");
    const tailSerialized = JSON.stringify(tailTransform?.messages);
    assert.ok(tailSerialized.includes("call-submit"), "the submit call part stays");
    assert.ok(tailSerialized.includes("Memory candidate accepted"), "its paired result stays");
    assert.notEqual(tailTransform?.messages.at(-1)?.role, "assistant",
      "the continuation request never ends on an assistant turn");
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

  // ── #220: Memory above half budget opens the rebuild run, not an append ──

  {
    // window 200000 · threshold 5000 · budget 2% = 4000 tokens → half is
    // 2000 tokens (8000 chars). One 8100-char block renders above half, so
    // the next due run rebuilds the full suffix (#220); its single-block
    // sources easily fit the window, so the run opens.
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
    assert.ok(overHarness.activeTools().includes("submit_memory"),
      "Memory above half budget opens the rebuild run instead of an append");
    assert.ok(overHarness.activeTools().includes("read_memory_source"),
      "the reading surface is unaffected by the next-operation choice");
    const snapshot = overHarness.registration.snapshot({ tokens: 12000, contextWindow: 200000 });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.nextOperation, "rebuild", "/context reports the rebuild operation");
    assert.equal(snapshot.stablePrefix, 0, "no block stays stable under a full suffix rebuild");
    const projected = await overHarness.emit("context", { type: "context", messages: [
      { role: "compactionSummary", summary: composeMemorySummary([big]) },
      { role: "user", content: "long task", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "work" }], timestamp: 2 },
      { role: "user", content: "ship it", timestamp: 3 },
    ] }, overCtx);
    assert.ok(projected?.messages, "the rebuild run transforms its first provider request");
    assert.equal(projected.messages[0].summary, MEMORY_SUMMARY_WRAPPER,
      "a full rebuild leaves the wrapper-only summary with no selected block");
    assert.equal(projected.messages[1].content, "long task",
      "the selected block's original sources are inserted in source order");
    const advisory = projected.messages.at(-1);
    assert.equal(advisory.customType, CONTEXT_MEMORY_ADVISORY_TYPE);
    assert.ok(advisory.content.includes("maintenance compression is due"),
      "the maintenance advisory identifies the rebuild operation");
    assert.ok(advisory.content.includes("replace the newest Memory blocks"),
      "the maintenance advisory states the replacement scope");
    assert.ok(advisory.content.includes("Do not copy credential values"), "the secret warning stays");
  }

  // ── #220: the maintenance run — selection, projection, replacement, prefix ──

  {
    // window 200000 · threshold 5000 · budget 1% = 2000 tokens → half is
    // 1000 tokens. Three blocks: A (~100 chars) alone renders 124 tokens
    // (≤ half); A+B renders 1978 tokens (> half). The shortest newest
    // contiguous suffix whose removal leaves an unchanged prefix at or below
    // half is therefore [B, C] with prefix [A].
    const ALPHA = "# Alpha\n\n" + "a".repeat(90);
    const BETA = "# Beta\n\n" + "b".repeat(7400);
    const GAMMA = "# Gamma\n\n" + "g".repeat(46);
    const maintenanceHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 },
    });
    const session = mutableSession([
      userEntry("m1", null, "alpha task"),
      assistantEntry("m2", "m1", [{ type: "text", text: "alpha answer ALPHA-SRC" }]),
      userEntry("m3", "m2", "beta task"),
      assistantEntry("m4", "m3", [{ type: "text", text: "beta answer BETA-SRC" }]),
      userEntry("m5", "m4", "gamma task"),
      assistantEntry("m6", "m5", [{ type: "text", text: "gamma answer GAMMA-SRC" }]),
      userEntry("m7", "m6", "ship it"),
      compactionOf("mc", "m7", "m7", [ALPHA, BETA, GAMMA], ["m2", "m4", "m6"]),
      userEntry("m8", "mc", "new work after the compaction"),
      assistantEntry("m9", "m8", [{ type: "text", text: "tail answer TAIL-SRC" }]),
    ]);
    const maintenanceCtx = maintenanceHarness.baseContext(session);
    await maintenanceHarness.emit("session_start", { type: "session_start", reason: "resume" }, maintenanceCtx);
    const before = maintenanceHarness.registration.snapshot({ tokens: 12000, contextWindow: 200000 });
    assert.equal(before.state, "active");
    assert.equal(before.blocks, 3);
    assert.equal(before.nextOperation, "rebuild");
    assert.equal(before.stablePrefix, 1, "the unchanged prefix is exactly block A");

    await maintenanceHarness.emit("input", { type: "input", text: "maintain the memory", source: "interactive" }, maintenanceCtx);
    assert.ok(maintenanceHarness.activeTools().includes("submit_memory"),
      "the due real-user run opens as the maintenance rebuild");
    assert.ok(maintenanceHarness.activeTools().includes("read_memory_source"),
      "the reading surface stays active through the maintenance boundary");
    assert.deepEqual(
      maintenanceHarness.activeTools().filter((name) => name !== "submit_memory" && name !== "read_memory_source"),
      ["read", "bash"],
      "unrelated active tools keep their identity and order across the maintenance boundary",
    );

    // The first provider request: Pi's own projection of the live branch.
    session.__entries.push(userEntry("m10", "m9", "maintain the memory"));
    const branchLength = session.getBranch().length;
    const request = buildSessionContext(session.getBranch(), session.getLeafId()).messages;
    assert.equal(request[0].role, "compactionSummary");
    assert.equal(request[0].summary, composeMemorySummary([ALPHA, BETA, GAMMA]));
    const transformed = await maintenanceHarness.emit("context", { type: "context", messages: request }, maintenanceCtx);
    assert.ok(transformed?.messages, "the maintenance run transforms its first provider request");
    const projected = transformed.messages;
    assert.equal(projected[0].role, "compactionSummary");
    assert.equal(projected[0].summary, composeMemorySummary([ALPHA]),
      "the summary message keeps exactly the unchanged prefix rendering");
    assert.ok(projected[0].summary.includes(ALPHA), "the unselected block body survives");
    assert.ok(!projected[0].summary.includes(BETA) && !projected[0].summary.includes(GAMMA),
      "the selected summaries leave the request");
    const serialized = JSON.stringify(projected);
    assert.equal((serialized.match(/beta task/g) ?? []).length, 1, "every selected source entry is inserted exactly once");
    assert.equal((serialized.match(/gamma answer GAMMA-SRC/g) ?? []).length, 1);
    assert.ok(!serialized.includes(BETA.slice(0, 200)), "a selected block body never appears beside its sources");
    assert.ok(projected[1].role === "user" && projected[1].content === "beta task",
      "the inserted sources begin at the first selected block's source start");
    const order = ["beta task", "gamma task", "ship it", "new work after the compaction", "maintain the memory"]
      .map((needle) => serialized.indexOf(needle));
    assert.ok(order.every((at, index) => at !== -1 && (index === 0 || at > order[index - 1])),
      "sources, raw tail, and current request stay in chronological order");
    const advisory = projected.at(-1);
    assert.equal(advisory.customType, CONTEXT_MEMORY_ADVISORY_TYPE);
    assert.ok(advisory.content.includes("maintenance compression is due"),
      "the maintenance advisory identifies the operation");
    assert.ok(advisory.content.includes("original conversation"), "the advisory names the source scope");
    assert.equal(projected.at(-2).content, "maintain the memory",
      "the advisory sits directly after the current user message");
    assert.equal(session.getBranch().length, branchLength,
      "the maintenance projection never persists anything");

    // The projection is one-shot: the next request keeps the full Memory
    // rendering and receives no second advisory.
    const secondRequest = buildSessionContext(session.getBranch(), session.getLeafId()).messages;
    const secondTransformed = await maintenanceHarness.emit("context", { type: "context", messages: secondRequest }, maintenanceCtx);
    assert.ok(secondTransformed?.messages);
    assert.equal(secondTransformed.messages[0].summary, composeMemorySummary([ALPHA, BETA, GAMMA]),
      "later requests carry the unmodified Memory rendering");
    assert.equal(
      secondTransformed.messages.filter((message) => message?.customType === CONTEXT_MEMORY_ADVISORY_TYPE).length,
      0,
      "later requests never repeat the advisory or re-insert the sources",
    );

    // The replacement block: complete suffix sources plus the raw tail.
    const REBUILT = "# Rebuilt\n\n- beta, gamma, and the tail in one block";
    session.__entries.push(assistantEntry("m11", "m10", [
      { type: "text", text: "done — submitting the replacement block" },
      { type: "toolCall", id: "call-rebuild", name: "submit_memory", arguments: { markdown: REBUILT } },
    ]));
    session.__entries.push(toolResultEntry("m12", "m11", "submit_memory", "Memory candidate accepted; compaction pending."));
    await maintenanceHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "text", text: "done — submitting the replacement block" },
        { type: "toolCall", id: "call-rebuild", name: "submit_memory", arguments: { markdown: REBUILT } },
      ] },
    }, maintenanceCtx);
    const acceptedRebuild = await maintenanceHarness.tools.get("submit_memory")
      .execute("call-rebuild", { markdown: REBUILT }, undefined, undefined, maintenanceCtx);
    assert.equal(acceptedRebuild.content[0].text, "Memory candidate accepted; compaction pending.");
    assert.deepEqual(maintenanceHarness.registration.snapshot(), { state: "pending" });

    await maintenanceHarness.emit("agent_settled", { type: "agent_settled" }, maintenanceCtx);
    assert.equal(maintenanceHarness.compactCalls.length, 1, "the rebuild candidate reaches Pi's seam once");

    const takeover = await maintenanceHarness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "m10", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 7777, settings: {} },
      branchEntries: session.getBranch(),
      reason: "manual",
      willRetry: false,
      signal: undefined,
    }, maintenanceCtx);
    assert.ok(takeover?.compaction, "the matching rebuild candidate is consumed");
    const prefixRendering = composeMemorySummary([ALPHA]);
    assert.equal(takeover.compaction.summary, composeMemorySummary([ALPHA, REBUILT]));
    assert.ok(takeover.compaction.summary.startsWith(prefixRendering),
      "every unselected older block stays byte-identical");
    assert.equal(takeover.compaction.summary.slice(prefixRendering.length), "\n---\n\n" + REBUILT,
      "divergence begins exactly at the first rebuilt block");
    assert.equal(takeover.compaction.firstKeptEntryId, "m10",
      "the maintenance run's user request becomes the retained-tail boundary");
    assert.equal(takeover.compaction.tokensBefore, 7777);
    assert.deepEqual(takeover.compaction.details, {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: "m2", markdownBytes: Buffer.byteLength(ALPHA, "utf8") },
        { endEntryId: "m9", markdownBytes: Buffer.byteLength(REBUILT, "utf8") },
      ],
    }, "the replacement block extends the source boundary to the last eligible entry before the request");

    session.__entries.push({
      id: "mc2", parentId: "m12", type: "compaction", timestamp: TS,
      summary: takeover.compaction.summary, firstKeptEntryId: "m10",
      tokensBefore: 7777, details: takeover.compaction.details, fromExtension: true,
    });
    await maintenanceHarness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: session.__entries.at(-1),
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, maintenanceCtx);

    const committed = maintenanceHarness.registration.snapshot({ tokens: 900, contextWindow: 200000 });
    assert.equal(committed.state, "active");
    assert.equal(committed.blocks, 2, "the selected suffix collapsed into one replacement block");
    assert.equal(committed.stablePrefix, 2);
    assert.equal(committed.nextOperation, "append");

    // The replacement block's sources cover the suffix's original
    // conversation plus the raw tail; the untouched prefix keeps its own.
    const inspectedRebuild = maintenanceHarness.registration.inspect({ block: 2, page: 1 }, session);
    assert.equal(inspectedRebuild.ok, true);
    for (const needle of ["beta task", "gamma task", "ship it", "new work after the compaction", "tail answer TAIL-SRC"]) {
      assert.ok(inspectedRebuild.text.includes(needle), `the rebuilt block covers ${JSON.stringify(needle)}`);
    }
    for (const forbidden of ["alpha task", "ALPHA-SRC"]) {
      assert.ok(!inspectedRebuild.text.includes(forbidden), `the rebuilt block never exposes ${JSON.stringify(forbidden)}`);
    }
    const inspectedAlpha = maintenanceHarness.registration.inspect({ block: 1, page: 1 }, session);
    assert.equal(inspectedAlpha.ok, true);
    assert.ok(inspectedAlpha.text.includes("alpha task"), "the unchanged prefix keeps its original sources");
  }

  // ── #220: the scale limit — no handshake, native compaction owns the boundary ──

  {
    // window 200000 · threshold 5000 · budget 1%: A (~100 chars) is the
    // unchanged prefix and B (~8000 chars) the selected suffix. B's original
    // source entry is ~720k chars (~180k tokens), so the complete
    // maintenance request cannot fit under the ten-percent allowance.
    const scaleHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 },
    });
    const usage = { tokens: 12000, contextWindow: 200000 };
    const scaleSession = mutableSession([
      userEntry("s1", null, "small task"),
      assistantEntry("s2", "s1", [{ type: "text", text: "small answer" }]),
      userEntry("s3", "s2", "huge task"),
      assistantEntry("s4", "s3", [{ type: "text", text: "HUGE-SRC " + "x".repeat(720000) }]),
      userEntry("s5", "s4", "ship it"),
      compactionOf("sc", "s5", "s5", ["# Small\n\n" + "a".repeat(90), "# Big\n\n" + "b".repeat(8000)], ["s2", "s4"]),
    ]);
    const scaleCtx = { ...scaleHarness.baseContext(scaleSession), getContextUsage: () => usage };
    await scaleHarness.emit("session_start", { type: "session_start", reason: "resume" }, scaleCtx);
    assert.deepEqual(scaleHarness.registration.snapshot(), { state: "scale-limit" },
      "the branch reports its scale limit while due Memory cannot be rebuilt to fit");

    await scaleHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, scaleCtx);
    assert.ok(!scaleHarness.activeTools().includes("submit_memory"),
      "the scale limit exposes no submission handshake");
    assert.ok(scaleHarness.activeTools().includes("read_memory_source"),
      "the reading surface is unaffected by the scale limit");
    assert.deepEqual(scaleHarness.registration.snapshot(), { state: "scale-limit" },
      "the scale-limit report survives the refused input");
    const native = await scaleHarness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "s5", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 4321, settings: {} },
      branchEntries: scaleSession.getBranch(),
      reason: "threshold",
      willRetry: false,
      signal: undefined,
    }, scaleCtx);
    assert.equal(native, undefined, "compaction is delegated to Pi native behavior");

    // A model change to a larger window recalculates the threshold and the
    // Memory budget; no block is deleted or scaled, and the maintenance run
    // opens on the next real-user input.
    usage.contextWindow = 400000;
    await scaleHarness.emit("model_select", {
      type: "model_select", model: {}, previousModel: undefined, source: "set",
    }, scaleCtx);
    const recalculated = scaleHarness.registration.snapshot({ tokens: 12000, contextWindow: 400000 });
    assert.equal(recalculated.state, "active", "the larger window clears the scale limit");
    assert.equal(recalculated.blocks, 2, "no block is deleted or scaled by the model change");
    assert.equal(recalculated.nextOperation, "rebuild");
    assert.equal(recalculated.stablePrefix, 1);
    await scaleHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, scaleCtx);
    assert.ok(scaleHarness.activeTools().includes("submit_memory"),
      "the maintenance run opens under the recalculated budgets");
  }

  // ── #220: a rebuild body over the total Memory budget is rejected ──

  {
    const boundHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 },
    });
    const session = mutableSession([
      userEntry("n1", null, "first"),
      assistantEntry("n2", "n1", [{ type: "text", text: "first answer" }]),
      userEntry("n3", "n2", "second"),
      assistantEntry("n4", "n3", [{ type: "text", text: "second answer" }]),
      userEntry("n5", "n4", "ship it"),
      compactionOf("nc", "n5", "n5", ["# One\n\n" + "a".repeat(90), "# Two\n\n" + "b".repeat(8000)], ["n2", "n4"]),
    ]);
    const boundCtx = boundHarness.baseContext(session);
    await boundHarness.emit("session_start", { type: "session_start", reason: "resume" }, boundCtx);
    await boundHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, boundCtx);
    assert.ok(boundHarness.activeTools().includes("submit_memory"),
      "the maintenance run opens when the sources fit");
    session.__entries.push(userEntry("n6", "nc", "ship it"));
    session.__entries.push(assistantEntry("n7", "n6", [
      { type: "toolCall", id: "call-bound", name: "submit_memory", arguments: { markdown: "n".repeat(7700) } },
    ]));
    await boundHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-bound", name: "submit_memory", arguments: { markdown: "n".repeat(7700) } },
      ] },
    }, boundCtx);
    await assert.rejects(
      () => boundHarness.tools.get("submit_memory").execute("call-bound", { markdown: "n".repeat(7700) }, undefined, undefined, boundCtx),
      (error) => {
        assert.match(error.message, /^BOUND_EXCEEDED: /);
        assert.ok(!error.message.includes("nnnn"), "the failure never echoes the Memory body");
        return true;
      },
    );
    assert.notDeepEqual(boundHarness.registration.snapshot(), { state: "pending" },
      "the rejected rebuild stores no candidate");
  }

  // ── #220: Memory changing under the maintenance run refuses safely ──

  {
    const changedHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 },
    });
    const session = mutableSession([
      userEntry("x1", null, "one"),
      assistantEntry("x2", "x1", [{ type: "text", text: "one answer" }]),
      userEntry("x3", "x2", "two"),
      assistantEntry("x4", "x3", [{ type: "text", text: "two answer" }]),
      userEntry("x5", "x4", "ship it"),
      compactionOf("xc", "x5", "x5", ["# One\n\n" + "a".repeat(90), "# Two\n\n" + "b".repeat(8000)], ["x2", "x4"]),
    ]);
    const changedCtx = changedHarness.baseContext(session);
    await changedHarness.emit("session_start", { type: "session_start", reason: "resume" }, changedCtx);
    await changedHarness.emit("input", { type: "input", text: "maintain", source: "interactive" }, changedCtx);
    assert.ok(changedHarness.activeTools().includes("submit_memory"));
    // The carrying compaction is rewritten in place with a different second
    // block, so the live Memory no longer matches the frozen selection.
    const entries = session.getBranch();
    const carrying = entries.at(-1);
    const edited = compactionOf("xc", "x5", "x5", ["# One\n\n" + "a".repeat(90), "# Two edited\n\n" + "b".repeat(8000)], ["x2", "x4"]);
    session.__entries = entries.map((entry) => (entry.id === "xc" ? { ...carrying, ...edited } : entry));
    session.__entries.push(userEntry("x6", "xc", "maintain"));
    session.__entries.push(assistantEntry("x7", "x6", [
      { type: "toolCall", id: "call-changed", name: "submit_memory", arguments: { markdown: "# Fresh" } },
    ]));
    await changedHarness.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-changed", name: "submit_memory", arguments: { markdown: "# Fresh" } },
      ] },
    }, changedCtx);
    await assert.rejects(
      () => changedHarness.tools.get("submit_memory").execute("call-changed", { markdown: "# Fresh" }, undefined, undefined, changedCtx),
      (error) => {
        assert.match(error.message, /^MEMORY_CHANGED: /);
        return true;
      },
    );
    assert.notDeepEqual(changedHarness.registration.snapshot(), { state: "pending" });
  }

  // ── #220: a maintenance projection failure returns the safe context ──

  {
    const failureHarness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 },
    });
    const session = mutableSession([
      userEntry("f1", null, "one"),
      assistantEntry("f2", "f1", [{ type: "text", text: "one answer" }]),
      userEntry("f3", "f2", "two"),
      assistantEntry("f4", "f3", [{ type: "text", text: "two answer" }]),
      userEntry("f5", "f4", "ship it"),
      compactionOf("fc", "f5", "f5", ["# One\n\n" + "a".repeat(90), "# Two\n\n" + "b".repeat(8000)], ["f2", "f4"]),
    ]);
    const failureCtx = failureHarness.baseContext(session);
    await failureHarness.emit("session_start", { type: "session_start", reason: "resume" }, failureCtx);
    await failureHarness.emit("input", { type: "input", text: "maintain", source: "interactive" }, failureCtx);
    assert.ok(failureHarness.activeTools().includes("submit_memory"));
    // The request carries a foreign compaction summary instead of the
    // carrying Memory, so the maintenance projection cannot be built.
    const result = await failureHarness.emit("context", { type: "context", messages: [
      { role: "compactionSummary", summary: "a foreign native summary" },
      { role: "user", content: "maintain", timestamp: 1 },
    ] }, failureCtx);
    assert.equal(result, undefined, "a maintenance projection failure returns the unmodified context");
    assert.ok(!failureHarness.activeTools().includes("submit_memory"),
      "submission is deactivated for the run after the projection failure");
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
  // ── #222: a compaction Pi never started keeps the slot pending until the next run boundary ──

  {
    const stall = createHarness();
    const stallSession = mutableSession(preRunBranch());
    const stallCtx = stall.baseContext(stallSession);
    await stall.emit("session_start", { type: "session_start", reason: "startup" }, stallCtx);
    await stall.emit("input", { type: "input", text: "ship it", source: "interactive" }, stallCtx);
    appendDueRun(stallSession, BLOCK);
    await stall.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ] },
    }, stallCtx);
    await stall.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, stallCtx);

    // Settle offers the candidate; Pi's compact() refuses ("session too
    // small") and never emits session_before_compact. Nothing committed and
    // nothing was lost, so the phase stays visible without any diagnostic.
    await stall.emit("agent_settled", { type: "agent_settled" }, stallCtx);
    assert.equal(stall.compactCalls.length, 1, "settle still offers the candidate to Pi's seam once");
    assert.deepEqual(stall.registration.snapshot(), { state: "pending" },
      "a compaction that never started leaves the slot reporting pending");
    assert.equal(stall.notified.length, 0, "a refused compaction is not a conflict");
    await assert.rejects(
      () => stall.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, stallCtx),
      (error) => {
        assert.match(error.message, /^SUBMIT_NOT_DUE: /);
        return true;
      },
      "the settled run refuses any further submission while the slot survives",
    );

    // The next real-user run is the stated recovery boundary.
    await stall.emit("input", { type: "input", text: "next task", source: "interactive" }, stallCtx);
    assert.notDeepEqual(stall.registration.snapshot(), { state: "pending" },
      "the next run boundary clears the stalled candidate");
    stallSession.__entries.push(userEntry("e7", "e6", "next task"));
    stallSession.__entries.push(assistantEntry("e8", "e7", [
      { type: "toolCall", id: "call-fresh", name: "submit_memory", arguments: { markdown: "# Fresh block" } },
    ]));
    await stall.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-fresh", name: "submit_memory", arguments: { markdown: "# Fresh block" } },
      ] },
    }, stallCtx);
    const recovered = await stall.tools.get("submit_memory")
      .execute("call-fresh", { markdown: "# Fresh block" }, undefined, undefined, stallCtx);
    assert.equal(recovered.content[0].text, "Memory candidate accepted; compaction pending.",
      "the fresh run accepts a new candidate after the boundary");
  }

  // ── #222: a takeover whose save never landed keeps committing until the next run boundary ──

  {
    const lost = createHarness();
    const lostSession = mutableSession(preRunBranch());
    const lostCtx = lost.baseContext(lostSession);
    await lost.emit("session_start", { type: "session_start", reason: "startup" }, lostCtx);
    await lost.emit("input", { type: "input", text: "ship it", source: "interactive" }, lostCtx);
    appendDueRun(lostSession, BLOCK);
    await lost.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ] },
    }, lostCtx);
    await lost.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, lostCtx);
    await lost.emit("agent_settled", { type: "agent_settled" }, lostCtx);
    const takeover = await lost.emit("session_before_compact", beforeCompactEvent(lostSession), lostCtx);
    assert.ok(takeover?.compaction);

    // Pi's save threw after the takeover, so session_compact never fires.
    assert.deepEqual(lost.registration.snapshot(), { state: "committing" },
      "a takeover whose save never landed keeps the committing phase visible");
    await assert.rejects(
      () => lost.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, lostCtx),
      (error) => {
        assert.match(error.message, /^SUBMIT_NOT_DUE: /);
        return true;
      },
      "the settled run refuses any further submission while the slot survives",
    );

    // The next real-user run clears the committing slot and a fresh candidate is accepted.
    await lost.emit("input", { type: "input", text: "next task", source: "interactive" }, lostCtx);
    assert.deepEqual(lost.registration.snapshot(), { state: "due" },
      "the next run boundary clears the committing slot");
    lostSession.__entries.push(userEntry("e7", "e6", "next task"));
    lostSession.__entries.push(assistantEntry("e8", "e7", [
      { type: "toolCall", id: "call-fresh", name: "submit_memory", arguments: { markdown: "# Fresh block" } },
    ]));
    await lost.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-fresh", name: "submit_memory", arguments: { markdown: "# Fresh block" } },
      ] },
    }, lostCtx);
    const recovered = await lost.tools.get("submit_memory")
      .execute("call-fresh", { markdown: "# Fresh block" }, undefined, undefined, lostCtx);
    assert.equal(recovered.content[0].text, "Memory candidate accepted; compaction pending.");
  }

  // ── #222: a committing slot is never rewritten by a later compaction retry ──

  {
    const retry = createHarness();
    const retrySession = mutableSession(preRunBranch());
    const retryCtx = retry.baseContext(retrySession);
    await retry.emit("session_start", { type: "session_start", reason: "startup" }, retryCtx);
    await retry.emit("input", { type: "input", text: "ship it", source: "interactive" }, retryCtx);
    appendDueRun(retrySession, BLOCK);
    await retry.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ] },
    }, retryCtx);
    await retry.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, retryCtx);
    await retry.emit("agent_settled", { type: "agent_settled" }, retryCtx);
    const consumed = await retry.emit("session_before_compact", beforeCompactEvent(retrySession), retryCtx);
    assert.ok(consumed?.compaction);

    // Pi retries compaction after the failed save: the committing slot never
    // returns a second takeover, so the retry stays Pi native.
    const second = await retry.emit("session_before_compact", beforeCompactEvent(retrySession), retryCtx);
    assert.equal(second, undefined, "a committing slot is never rewritten");
    assert.equal(second?.cancel, undefined);

    // The retry's native entry closing is one bounded conflict, never a false commit.
    retrySession.__entries.push({
      id: "c-native", parentId: "e6", type: "compaction", timestamp: TS,
      summary: "native summary after the failed save", firstKeptEntryId: "e4", tokensBefore: 4321, fromExtension: false,
    });
    await retry.emit("session_compact", {
      type: "session_compact",
      compactionEntry: retrySession.__entries.at(-1),
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    }, retryCtx);
    assert.equal(retry.notified.length, 1, "one bounded conflict diagnostic");
    assert.match(retry.notified[0].text, /^COMPACTION_CONFLICT: /);
    assert.equal(retry.notified[0].level, "warning");
    assert.deepEqual(retry.registration.snapshot(), { state: "opaque" },
      "the discarded candidate never claims commit");
    const after = await retry.emit("session_before_compact", beforeCompactEvent(retrySession), retryCtx);
    assert.equal(after, undefined, "the cleared slot never produces another takeover");
  }

  // ── #222: manual, threshold, and overflow compaction stay native without a candidate ──

  {
    for (const reason of ["manual", "threshold", "overflow"]) {
      const native = createHarness();
      const nativeSession = mutableSession(preRunBranch());
      const nativeCtx = native.baseContext(nativeSession);
      await native.emit("session_start", { type: "session_start", reason: "startup" }, nativeCtx);
      const result = await native.emit("session_before_compact", beforeCompactEvent(nativeSession), nativeCtx);
      assert.equal(result, undefined, `a ${reason} compaction without a candidate stays Pi native`);
      assert.equal(result?.cancel, undefined, `${reason} compaction is never cancelled`);
    }
  }

  // ── #222: Pi's post-run threshold/overflow compaction consumes the candidate before settle ──

  {
    for (const reason of ["threshold", "overflow"]) {
      const auto = createHarness();
      const autoSession = mutableSession(preRunBranch());
      const autoCtx = auto.baseContext(autoSession);
      await auto.emit("session_start", { type: "session_start", reason: "startup" }, autoCtx);
      await auto.emit("input", { type: "input", text: "ship it", source: "interactive" }, autoCtx);
      appendDueRun(autoSession, BLOCK);
      await auto.emit("message_end", {
        type: "message_end",
        message: { role: "assistant", content: [
          { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
        ] },
      }, autoCtx);
      await auto.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, autoCtx);

      // The auto-compaction fires before settle, so no ctx.compact() was requested.
      const takeover = await auto.emit("session_before_compact", {
        ...beforeCompactEvent(autoSession),
        reason,
      }, autoCtx);
      assert.ok(takeover?.compaction, `a ${reason} compaction consumes the matching candidate`);
      assert.equal(takeover.cancel, undefined, `the ${reason} takeover never cancels`);
      assert.equal(auto.compactCalls.length, 0, "the candidate was consumed without a settle-triggered request");
      const compactEvent = appendCompactionEntry(autoSession, takeover.compaction, true);
      await auto.emit("session_compact", { ...compactEvent, reason }, autoCtx);
      const committed = auto.registration.snapshot({ tokens: 900, contextWindow: 200000 });
      assert.equal(committed.state, "active", `the ${reason} takeover confirms exactly`);
      assert.equal(committed.blocks, 1);
    }
  }

  // ── #222: a mismatching extension-origin saved entry is a conflict, not a commit ──

  {
    const foreign = createHarness();
    const foreignSession = mutableSession(preRunBranch());
    const foreignCtx = foreign.baseContext(foreignSession);
    await foreign.emit("session_start", { type: "session_start", reason: "startup" }, foreignCtx);
    await foreign.emit("input", { type: "input", text: "ship it", source: "interactive" }, foreignCtx);
    appendDueRun(foreignSession, BLOCK);
    await foreign.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: BLOCK } },
      ] },
    }, foreignCtx);
    await foreign.tools.get("submit_memory").execute("call-submit", { markdown: BLOCK }, undefined, undefined, foreignCtx);
    await foreign.emit("agent_settled", { type: "agent_settled" }, foreignCtx);
    const consumed = await foreign.emit("session_before_compact", beforeCompactEvent(foreignSession), foreignCtx);
    assert.ok(consumed?.compaction);

    // Another extension's takeover wins the save with a different summary.
    const otherEntry = {
      id: "c-other", parentId: "e6", type: "compaction", timestamp: TS,
      summary: "another extension's compaction summary", firstKeptEntryId: "e4", tokensBefore: 4321,
      fromExtension: true,
    };
    foreignSession.__entries.push(otherEntry);
    await foreign.emit("session_compact", {
      type: "session_compact", compactionEntry: otherEntry, fromExtension: true, reason: "manual", willRetry: false,
    }, foreignCtx);
    assert.equal(foreign.notified.length, 1, "one bounded conflict diagnostic");
    assert.match(foreign.notified[0].text, /^COMPACTION_CONFLICT: /);
    assert.ok(!foreign.notified[0].text.includes(BLOCK), "the diagnostic never echoes the Memory body");
    assert.equal(foreign.notified[0].level, "warning");

    // No rewrite, no retry, no false commit: the cleared slot stays cleared.
    const after = await foreign.emit("session_before_compact", beforeCompactEvent(foreignSession), foreignCtx);
    assert.equal(after, undefined, "the discarded candidate is never rewritten");
    await foreign.emit("agent_settled", { type: "agent_settled" }, foreignCtx);
    assert.equal(foreign.compactCalls.length, 1, "the discarded candidate is never re-offered");
    assert.deepEqual(foreign.registration.snapshot(), { state: "opaque" },
      "the competing entry stays ordinary opaque Pi context");
    assert.ok(!foreign.activeTools().includes("read_memory_source"));
  }

  console.log("context-memory submit tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
