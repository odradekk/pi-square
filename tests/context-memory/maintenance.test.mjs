import assert from "node:assert/strict";
import { SessionManager, buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG } = await load("../../src/context-memory/format.ts");
const { MAINTENANCE_ADVISORY_FAILURE_LIMIT } = await load("../../src/context-memory/maintenance.ts");
const { CONTEXT_MEMORY_ADVISORY_TYPE } = await load("../../src/context-memory/view.ts");

/**
 * #320 sustained-maintenance boundaries at the controller seam, always through
 * the registrar's real event and tool wiring against a real in-memory Pi
 * SessionManager tree: the pinned maintenance request's fixed sources, the
 * bounded failure suppression and its recovery on real growth or state
 * change, the request-bound provider-usage accounting (missing, stale,
 * clamped, and pre-compression reports), the large-output threshold crossing,
 * and the bounded `/context` diagnostics — no widget, no unbounded metrics.
 */

const DUE_CONFIG = { enabled: true, compressionThreshold: { tokens: 2500 }, memoryBudgetPercent: 1 };
const PADDING = "detailed module boundary notes that make each read a substantial evidence payload. ".repeat(60);

const readCallPart = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const compactCallPart = (id, markdown = "# m") =>
  ({ type: "toolCall", id, name: "compact_to_memory_block", arguments: { markdown } });
const assistantWith = (parts, timestamp) =>
  ({ role: "assistant", content: parts, stopReason: "toolUse", timestamp });
const toolResult = (id, name, text, timestamp) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp });

function harness(config = DUE_CONFIG, sessionManager) {
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
      throw new Error("display runtime is not needed for the maintenance boundary contract");
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

function commandContext(sessionManager, usage) {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager,
    compact() {},
    getContextUsage: usage ?? (() => ({ tokens: 40000, contextWindow: 200000, percent: 20 })),
    getSystemPrompt: () => "",
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
  };
}

/** Serve one provider request through the real context handler (#319). */
async function serveContext(session, sm, ctx, transform) {
  const native = structuredClone(buildContextEntries(sm.getBranch(), sm.getLeafId()).flatMap(sessionEntryToContextMessages));
  const messages = transform ? transform(native) : native;
  const result = await session.emit("context", { type: "context", messages }, ctx);
  return result === undefined ? messages : result.messages;
}

async function noteBatch(session, ctx, parts, usage) {
  await session.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: parts, ...(usage ? { usage } : {}) },
  }, ctx);
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
const advisoriesOf = (messages) => messages.filter((message) => message?.customType === CONTEXT_MEMORY_ADVISORY_TYPE);
const stateEntriesOf = (sm) => sm.getBranch().filter((entry) => entry.type === "custom"
  && entry.customType === MEMORY_STATE_CUSTOM_TYPE);

/** One completed ordinary read round appended to the branch; returns the result entry id. */
function appendReadRound(sm, id, path, text, timestamp) {
  sm.appendMessage(assistantWith([readCallPart(`${id}:call`, path)], timestamp));
  return sm.appendMessage(toolResult(`${id}:call`, "read", text, timestamp + 1));
}

try {
  // ── Fixed sources: the advisory's pinned range never silently grows ──
  {
    // Sub-case A: growth between request boundaries. The advisory's request
    // pinned its range at establishment; the branch grows a third completed
    // round afterwards; the compact call executes with no new request
    // boundary in between — the submission stays bound to the pinned range
    // and the new round is not silently swallowed into it.
    const sm = SessionManager.inMemory("/project");
    const task = sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    const resultA = appendReadRound(sm, "f:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "f:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const dueRequest = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(dueRequest).length, 1, "the due request carries the advisory");
    const dueSnapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(dueSnapshot.state, "due");
    assert.equal(dueSnapshot.maintenance.sources, 3,
      "the pending request reports its pinned source count (task, call, result)");
    assert.equal(dueSnapshot.maintenance.suppressed, false);
    assert.equal(dueSnapshot.maintenance.lastErrorCode, null);

    // Real growth after the advisory — with no request boundary serving it,
    // the pinned range stays fixed and the submission cannot cover the new
    // round (#320: a changed source requires an explicit re-scope at a
    // served request).
    appendReadRound(sm, "f:3", "c.txt", `EVIDENCE-C ${PADDING}`, 6);
    sm.appendMessage(assistantWith([compactCallPart("f:4")], 8));
    await noteBatch(session, ctx, [compactCallPart("f:4")]);
    const accepted = await compactTool(session).execute(
      "f:4", { markdown: "# Pinned digest\n\n- the first round summarized" }, undefined, undefined, ctx,
    );
    assert.match(accepted.content[0].text, /Memory block recorded\./);
    const states = stateEntriesOf(sm);
    assert.equal(states.length, 1);
    assert.equal(states[0].data.blocks[0].endEntryId, resultA,
      "the accepted range ends at the pinned boundary, not at the unserved post-advisory round");
    assert.deepEqual(states[0].data.blocks[0].retainedEntryIds, [task]);
    // The completed request clears and its net savings surface (#320).
    const activeSnapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(activeSnapshot.state, "active");
    assert.equal(activeSnapshot.maintenance, undefined, "success clears the pending request");
    assert.ok(activeSnapshot.lastNetSavingsTokens > 0,
      "the accepted compression reports its projected net savings");
  }

  {
    // Sub-case B: the same growth crossing a request boundary. The next due
    // request re-scopes the pending request over the extended range — the
    // old request is invalidated and the new sources are served in that very
    // request — and the following submission covers them.
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "g:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    const resultB = appendReadRound(sm, "g:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const firstDue = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(firstDue).length, 1);
    assert.equal(session.registration.snapshot({ tokens: 40000, contextWindow: 200000 }).maintenance.sources, 3);

    appendReadRound(sm, "g:3", "c.txt", `EVIDENCE-C ${PADDING}`, 6);
    const reScoped = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(reScoped).length, 1, "the re-scoped request still carries exactly one advisory");
    assert.equal(session.registration.snapshot({ tokens: 40000, contextWindow: 200000 }).maintenance.sources, 5,
      "the pending request re-scopes over the newly completed round");
    sm.appendMessage(assistantWith([compactCallPart("g:4")], 8));
    await noteBatch(session, ctx, [compactCallPart("g:4")]);
    await compactTool(session).execute("g:4", { markdown: "# Re-scoped digest" }, undefined, undefined, ctx);
    const states = stateEntriesOf(sm);
    assert.equal(states[0].data.blocks[0].endEntryId, resultB,
      "the submission after a served re-scope covers the extended range");
  }

  // ── Bounded failure suppression and recovery on real growth ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "s:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "s:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    // Repeated no-benefit submissions against the same pinned scope: the
    // refusal stays specific, and after the bounded limit the advisory stops
    // inviting the same attempt — the tool itself stays resident.
    const hugeBody = "# Huge digest\n\n" + "x".repeat(6000);
    for (let attempt = 1; attempt <= MAINTENANCE_ADVISORY_FAILURE_LIMIT; attempt++) {
      await serveContext(session, sm, ctx);
      sm.appendMessage(assistantWith([compactCallPart(`s:c${attempt}`, hugeBody)], 6 + attempt));
      await noteBatch(session, ctx, [compactCallPart(`s:c${attempt}`, hugeBody)]);
      const message = await refusalMessage(session, ctx, `s:c${attempt}`, hugeBody);
      assert.match(message, /^NO_NET_BENEFIT: /, `attempt ${attempt} refuses with the specific code`);
      assert.match(message, /wait for more eligible conversation or a changed source/,
        "the refusal carries a bounded next-step hint");
      assert.ok(session.activeTools().includes("compact_to_memory_block"),
        "the tool stays resident through the suppression");
    }
    const suppressedRequest = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(suppressedRequest).length, 0,
      "the advisory is suppressed after the bounded identical refusals");
    const suppressedSnapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(suppressedSnapshot.maintenance.suppressed, true);
    assert.equal(suppressedSnapshot.maintenance.lastErrorCode, "NO_NET_BENEFIT");
    assert.equal(suppressedSnapshot.maintenance.sources, 3, "the suppressed request stays visible in /context");

    // Real new work in the same task re-enables evaluation without any user
    // input: the extended scope resets the failure budget and the advisory
    // returns with the new sources served.
    appendReadRound(sm, "s:3", "c.txt", `EVIDENCE-C ${PADDING}`, 40);
    const recovered = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(recovered).length, 1, "real growth re-enables the advisory");
    const recoveredSnapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(recoveredSnapshot.maintenance.suppressed, false);
    assert.equal(recoveredSnapshot.maintenance.lastErrorCode, null);
    assert.equal(recoveredSnapshot.maintenance.sources, 5, "the recovered request covers the new round");
    // A refusal against the recovered scope starts a fresh bounded budget.
    const overBudgetBody = "# Over-budget digest\n\n" + "x".repeat(12000);
    sm.appendMessage(assistantWith([compactCallPart("s:c9", overBudgetBody)], 60));
    await noteBatch(session, ctx, [compactCallPart("s:c9", overBudgetBody)]);
    assert.match(await refusalMessage(session, ctx, "s:c9", overBudgetBody), /^BOUND_EXCEEDED: /);
    const afterOne = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(afterOne.maintenance.suppressed, false, "one refusal on a new scope does not stay suppressed");
    assert.equal(afterOne.maintenance.lastErrorCode, "BOUND_EXCEEDED");
  }

  // ── Model change invalidates the pending request; the next due request re-establishes ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "m:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "m:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveContext(session, sm, ctx);
    assert.notEqual(session.registration.snapshot({ tokens: 40000, contextWindow: 200000 }).maintenance, undefined);

    await session.emit("model_select", { type: "model_select", model: { id: "other-model", contextWindow: 200000 } }, ctx);
    const afterChange = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(afterChange.maintenance, undefined, "a model change clears the pending maintenance request");
    const reEstablished = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(reEstablished).length, 1,
      "the next due request re-establishes a fresh request from the live branch");
  }

  // ── Usage accounting: missing, clamped, never a floor, version-bound ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "u:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "u:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    // Missing usage: the pressure judgment still runs on the estimate alone
    // and the advisory still rides the due request.
    const noUsage = await serveContext(session, sm, commandContext(sm, () => undefined));
    assert.equal(advisoriesOf(noUsage).length, 1, "a missing usage report never blocks the due advisory");
    let snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.ok(snapshot.pressure.estimated > 0, "the pressure split reports the deterministic estimate");
    assert.equal(snapshot.pressure.reported, null, "no provider report is invented");
    assert.equal(snapshot.pressure.reportedForCurrentMemory, false);

    // A provider report binds to the request it measured: while the view is
    // unchanged the calibration tracks the provider's own accounting of that
    // comparable view (#320).
    await noteBatch(session, ctx, [{ type: "text", text: "ok" }], { input: 26000, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 26001 });
    snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.pressure.reported, 26000);
    assert.equal(snapshot.pressure.estimated, 26000,
      "an unchanged view carries the calibration derived from the report that measured it");

    // A pathological report clamps to a window share instead of running away.
    await serveContext(session, sm, ctx);
    await noteBatch(session, ctx, [{ type: "text", text: "ok" }], { input: 5_000_000, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 5_000_001 });
    snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.ok(snapshot.pressure.estimated < snapshot.pressure.reported,
      "the estimate never exceeds a huge reported size through the calibration term");
    assert.ok(snapshot.pressure.estimated <= 200000 / 4 + 10_000,
      "the calibration term stays bounded by a window share");

    // Accepting a compression rebuilds the pressure baseline: the recorded
    // projection is the next estimate's only input, the pre-compression
    // report never floors it, and the stale report stays distinguishable.
    sm.appendMessage(assistantWith([compactCallPart("u:3")], 8));
    await serveContext(session, sm, ctx);
    await noteBatch(session, ctx, [compactCallPart("u:3")]);
    await compactTool(session).execute("u:3", { markdown: "# Usage digest" }, undefined, undefined, ctx);
    const applied = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(applied).length, 0, "the projection relieves the pressure for the next request");
    snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.state, "active");
    assert.ok(snapshot.pressure.estimated < 4000,
      "the post-compression estimate is rebuilt from the projected view — the huge pre-compression report does not floor it");
    assert.equal(snapshot.pressure.reportedForCurrentMemory, false,
      "the pre-compression report is distinguishable from the current Memory version");
    // A report measured on the applied view recalibrates and matches the
    // current Memory version (#320).
    await noteBatch(session, ctx, [{ type: "text", text: "ok" }], { input: 12000, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 12001 });
    snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.pressure.reportedForCurrentMemory, true,
      "a fresh report measured on the applied view matches the current Memory version");
    assert.equal(snapshot.pressure.estimated, 12000,
      "the recalibrated pressure tracks the fresh report of the current view");
  }

  // ── One large tool output crossing the threshold: pressure is visible, the protected working set is not invited ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "small research task", timestamp: 1 });
    appendReadRound(sm, "l:1", "a.txt", "tiny", 2);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const before = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(before).length, 0, "a small branch stays below the threshold");

    // One huge tool result pushes the projected request far past the due
    // point, but it is the newest completed batch — the protected working
    // set — and the older range is too small to save anything. The honest
    // handling is visible pressure with no invitable request, never an
    // invitation to cover protected work.
    const hugeOutput = "HUGE-OUTPUT " + "y".repeat(24000);
    appendReadRound(sm, "l:2", "b.txt", hugeOutput, 4);
    const crossed = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(crossed).length, 0,
      "a large newest batch is protected: the advisory never invites covering the working set");
    const crossedSnapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(crossedSnapshot.state, "due");
    assert.ok(crossedSnapshot.pressure.estimated >= 2500,
      "the crossed pressure is observable in /context");
    assert.equal(crossedSnapshot.maintenance, undefined,
      "no pending request exists while nothing net-beneficial is compressible");

    // Once a later round completes, the huge output becomes eligible history
    // and the next due request carries the advisory over it.
    appendReadRound(sm, "l:3", "c.txt", `EVIDENCE-C ${PADDING}`, 6);
    const armed = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(armed).length, 1,
      "the huge output joins the invitable range only after newer work completes");
    assert.equal(session.registration.snapshot({ tokens: null, contextWindow: 200000 }).maintenance.sources, 5);
  }

  // ── Refused protocol calls never enter the source streams ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "p:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    const resultB = appendReadRound(sm, "p:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveContext(session, sm, ctx);
    sm.appendMessage(assistantWith([compactCallPart("p:3", "# Huge\n\n" + "z".repeat(6000))], 6));
    await noteBatch(session, ctx, [compactCallPart("p:3")]);
    await refusalMessage(session, ctx, "p:3", "# Huge\n\n" + "z".repeat(6000));
    // The refused protocol pair sits between eligible rounds but never counts
    // as source material for the next accepted block.
    const resultC = appendReadRound(sm, "p:4", "c.txt", `EVIDENCE-C ${PADDING}`, 8);
    await serveContext(session, sm, ctx);
    sm.appendMessage(assistantWith([compactCallPart("p:5")], 12));
    await noteBatch(session, ctx, [compactCallPart("p:5")]);
    await compactTool(session).execute("p:5", { markdown: "# Clean digest" }, undefined, undefined, ctx);
    const states = stateEntriesOf(sm);
    assert.equal(states[0].data.blocks.length, 1);
    assert.equal(states[0].data.blocks[0].endEntryId, resultB,
      "the range ends before the newest completed round, skipping the refused protocol pair entirely");
    assert.equal(states[0].data.format, MEMORY_STATE_FORMAT_TAG);
    const derived = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(derived.rows[0].sources, 5,
      "the accepted block counts only eligible sources — the refused protocol pair is excluded");
  }

  console.log("context-memory maintenance boundary tests: OK");
} finally {
  // Nothing persistent is created: every SessionManager is in-memory.
}
