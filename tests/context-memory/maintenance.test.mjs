import assert from "node:assert/strict";
import { SessionManager, buildContextEntries, estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG } = await load("../../src/context-memory/format.ts");
const { MAINTENANCE_ADVISORY_FAILURE_LIMIT } = await load("../../src/context-memory/maintenance.ts");
const { CompactMemoryParamsSchema } = await load("../../src/context-memory/tools.ts");
const { Check } = await import("typebox/value");
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
    tools, events, registration,
    activeTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
    async emit(name, event, ctx) {
      let last;
      for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
      return last;
    },
  };
}

function commandContext(sessionManager, usage, systemPrompt) {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager,
    compact() {},
    getContextUsage: usage ?? (() => ({ tokens: 40000, contextWindow: 200000, percent: 20 })),
    getSystemPrompt: systemPrompt ?? (() => ""),
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
  };
}

/** The deterministic tools estimate the controller computes, replicated for exact assertions. */
function expectedToolsTokens(session) {
  const active = new Set(session.activeTools());
  let chars = 0;
  for (const tool of session.tools.values()) {
    if (!active.has(tool.name)) continue;
    chars += JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
  }
  return Math.ceil(chars / 4);
}

/** Pi's own per-message estimate over the branch's native projection. */
function expectedMessageTokens(sm) {
  let total = 0;
  for (const message of buildContextEntries(sm.getBranch(), sm.getLeafId()).flatMap(sessionEntryToContextMessages)) {
    total += estimateTokens(message);
  }
  return total;
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

  // ── The request's system prompt counts directly, with no usage report at all ──
  {
    // The reviewer reproduction: threshold 6000, a comparable small usage
    // report, then only the system prompt grows from empty to 200000
    // characters while messages and Memory stay unchanged. The long-system
    // request must arm the advisory — the contribution is read from the
    // host's public system-prompt seam every request, not reconstructed from
    // a stale usage residual.
    const SYSTEM_CONFIG = { enabled: true, compressionThreshold: { tokens: 6000 }, memoryBudgetPercent: 1 };
    let systemPromptText = "";
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "y:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "y:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(SYSTEM_CONFIG, sm);
    const ctx = commandContext(sm, undefined, () => systemPromptText);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    const emptySystem = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(emptySystem).length, 0,
      "an empty system prompt leaves the message estimate below the threshold");

    // A comparable small report on the empty-system view: its residual is
    // tiny and must not be able to grow with the system prompt later.
    await noteBatch(session, ctx, [{ type: "text", text: "ok" }], { input: 4000, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 4001 });
    const afterReport = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(afterReport).length, 0,
      "the small report's residual keeps the empty-system request below the threshold");

    systemPromptText = "s".repeat(200000);
    const longSystem = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(longSystem).length, 1,
      "a 200000-character system prompt crosses the threshold on the very request it appears");
    const snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.ok(snapshot.pressure.estimated >= 50000,
      "the estimate counts the system prompt directly (>= 50000 tokens)");
    assert.equal(snapshot.maintenance.sources, 3, "the pinned sources are unaffected by the system change");
    assert.equal(snapshot.pressure.reported, 4000, "the old report stays distinguishable from the estimate");
  }

  // ── Active tool schema growth counts on the request it appears ──
  {
    const SYSTEM_CONFIG = { enabled: true, compressionThreshold: { tokens: 6000 }, memoryBudgetPercent: 1 };
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "t:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "t:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(SYSTEM_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const beforeTools = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(beforeTools).length, 0, "the baseline composition stays below the threshold");
    const baselineEstimated = expectedMessageTokens(sm) + expectedToolsTokens(session);
    assert.ok(baselineEstimated < 6000, "the baseline stays below the threshold by construction");

    // One huge additional active tool definition crosses the threshold.
    const HUGE_DESCRIPTION = "tool guidance padding that makes this schema a substantial contribution. ".repeat(700);
    session.tools.set("huge-evidence-tool", {
      name: "huge-evidence-tool",
      description: HUGE_DESCRIPTION,
      parameters: { type: "object", additionalProperties: false },
    });
    session.setActiveTools([...session.activeTools(), "huge-evidence-tool"]);
    const afterTools = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(afterTools).length, 1,
      "activating a large tool schema arms the advisory on the next request");
    const grownEstimated = session.registration.snapshot({ tokens: null, contextWindow: 200000 }).pressure.estimated;
    assert.ok(grownEstimated - baselineEstimated >= Math.ceil(HUGE_DESCRIPTION.length / 4),
      "the grown estimate counts the new schema directly, not through a stale residual");
  }

  // ── After a compression the still-present overhead stays counted ──
  {
    const SYSTEM_CONFIG = { enabled: true, compressionThreshold: { tokens: 6000 }, memoryBudgetPercent: 1 };
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "o:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "o:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(SYSTEM_CONFIG, sm);
    const ctx = commandContext(sm, undefined, () => "o".repeat(200000));
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveContext(session, sm, ctx);
    sm.appendMessage(assistantWith([compactCallPart("o:3")], 6));
    await serveContext(session, sm, ctx);
    await noteBatch(session, ctx, [compactCallPart("o:3")]);
    await compactTool(session).execute("o:3", { markdown: "# Overhead digest" }, undefined, undefined, ctx);
    const applied = await serveContext(session, sm, ctx);
    assert.ok(!JSON.stringify(applied).includes("EVIDENCE-A"),
      "the covered sources leave the applied request");
    const snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.state, "active");
    assert.ok(snapshot.pressure.estimated >= 50000,
      "the system prompt stays counted after the compression — the stable overhead is not lost");
    assert.equal(snapshot.maintenance, undefined,
      "no new advisory invites work while nothing beyond the recorded block is uncovered");
  }

  // ── A stale residual suspends on composition change and never double counts ──
  {
    const SYSTEM_CONFIG = { enabled: true, compressionThreshold: { tokens: 2500 }, memoryBudgetPercent: 1 };
    let systemPromptText = "v".repeat(40000);
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "d:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "d:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(SYSTEM_CONFIG, sm);
    const ctx = commandContext(sm, undefined, () => systemPromptText);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveContext(session, sm, ctx);

    // A report 300 tokens above the full basis pins a 300-token residual.
    const basis = session.registration.snapshot({ tokens: null, contextWindow: 200000 }).pressure.estimated;
    await noteBatch(session, ctx, [{ type: "text", text: "ok" }], { input: basis + 300, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: basis + 301 });
    let snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.pressure.estimated, basis + 300,
      "an unchanged composition carries the residual from the report that measured it");

    // The system prompt changes: the residual suspends until the next report,
    // and the estimate is exactly the new composition — no double count and
    // no stale residue.
    systemPromptText = "w".repeat(80000);
    await serveContext(session, sm, ctx);
    const expectedAfterChange = basis - Math.ceil(40000 / 4) + Math.ceil(80000 / 4);
    snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.pressure.estimated, expectedAfterChange,
      "a composition change suspends the stale residual instead of stacking it");

    // A fresh report on the new composition recalibrates the residual.
    await noteBatch(session, ctx, [{ type: "text", text: "ok" }], { input: expectedAfterChange + 500, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: expectedAfterChange + 501 });
    snapshot = session.registration.snapshot({ tokens: null, contextWindow: 200000 });
    assert.equal(snapshot.pressure.estimated, expectedAfterChange + 500,
      "the next report on the new composition recalibrates the residual");
  }

  // ── A schema-passing, byte-over-wide body counts as an invalid submission ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "w:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "w:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const armed = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(armed).length, 1,
      "the advisory is armed on the due request before the invalid submissions begin");

    // 6000 CJK characters pass the tool schema — maxLength counts characters
    // — while the canonical UTF-8 encoding is 18000 bytes, far over the
    // 16 KiB body bound.
    const wideBody = "汉".repeat(6000);
    assert.equal(Check(CompactMemoryParamsSchema, { markdown: wideBody }), true,
      "the wide body passes the provider-visible schema");
    assert.ok(Buffer.byteLength(wideBody, "utf8") > 16 * 1024, "the canonical bytes exceed the body bound");

    for (let attempt = 1; attempt <= MAINTENANCE_ADVISORY_FAILURE_LIMIT; attempt++) {
      const callId = `w:c${attempt}`;
      sm.appendMessage(assistantWith([compactCallPart(callId, wideBody)], 6 + attempt));
      await noteBatch(session, ctx, [compactCallPart(callId, wideBody)]);
      const message = await refusalMessage(session, ctx, callId, wideBody);
      assert.match(message, /^BOUND_EXCEEDED: /, `attempt ${attempt} refuses with the specific code`);
      assert.match(message, /16 KiB of canonical UTF-8/,
        "the refusal names the bounded next step");
      // The failed call and its error result enter the branch exactly as a
      // real run records them, and the next request is served.
      sm.appendMessage({
        role: "toolResult",
        toolCallId: callId,
        toolName: "compact_to_memory_block",
        content: [{ type: "text", text: message }],
        isError: true,
        timestamp: 7 + attempt,
      });
      await serveContext(session, sm, ctx);
    }
    const suppressed = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(suppressed).length, 0,
      "schema-passing over-byte bodies suppress the advisory within the bounded budget");
    const snapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(snapshot.maintenance.suppressed, true);
    assert.equal(snapshot.maintenance.lastErrorCode, "BOUND_EXCEEDED");
    assert.equal(snapshot.maintenance.sources, 3,
      "the refused protocol pairs never change the pinned scope");

    // Real growth in the same task re-enables the advisory without a user
    // input, exactly like any other suppressed scope.
    appendReadRound(sm, "w:3", "c.txt", `EVIDENCE-C ${PADDING}`, 40);
    const recovered = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(recovered).length, 1, "real growth re-enables the advisory");
  }

  // ── Mixed batches count as invalid submissions against the same budget ──
  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `research task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "x:1", "a.txt", `EVIDENCE-A ${PADDING}`, 2);
    appendReadRound(sm, "x:2", "b.txt", `EVIDENCE-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    for (let attempt = 1; attempt <= MAINTENANCE_ADVISORY_FAILURE_LIMIT; attempt++) {
      await serveContext(session, sm, ctx);
      const callId = `x:c${attempt}`;
      await noteBatch(session, ctx, [compactCallPart(callId), readCallPart(`${callId}:sibling`, "c.txt")]);
      assert.match(await refusalMessage(session, ctx, callId, "# Mixed"), /^COMPACT_NOT_SOAL_TOOL: /);
    }
    const suppressed = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(suppressed).length, 0,
      "repeated mixed batches suppress the advisory within the bounded budget");
    assert.equal(session.registration.snapshot({ tokens: 40000, contextWindow: 200000 }).maintenance.lastErrorCode, "COMPACT_NOT_SOAL_TOOL");
  }

  // #320 + #322: a tail reading pair stays outside a fixed pin, then leaves
  // whole when later served work brings the exchange into a new range.
  {
    const sm = SessionManager.inMemory("/project");
    const task = sm.appendMessage({ role: "user", content: `combined task ${PADDING}`, timestamp: 1 });
    appendReadRound(sm, "pair:a", "a.txt", `PAIR-A ${PADDING}`, 2);
    const resultB = appendReadRound(sm, "pair:b", "b.txt", `PAIR-B ${PADDING}`, 4);
    const session = harness(DUE_CONFIG, sm);
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await serveContext(session, sm, ctx);
    const submit = async (id, timestamp) => {
      const part = compactCallPart(id, `# ${id} digest`);
      sm.appendMessage(assistantWith([part], timestamp));
      await noteBatch(session, ctx, [part]);
      const result = await compactTool(session).execute(id, part.arguments, undefined, undefined, ctx);
      sm.appendMessage(toolResult(id, "compact_to_memory_block", result.content[0].text, timestamp + 1));
    };
    await submit("pair:initial", 6);
    const firstBlock = structuredClone(stateEntriesOf(sm).at(-1).data.blocks[0]);

    await serveContext(session, sm, ctx);
    const readingId = "pair:source";
    sm.appendMessage(assistantWith([
      { type: "text", text: "checking the first block's original evidence" },
      { type: "toolCall", id: readingId, name: "read_memory_source", arguments: { block: 1, page: 1 } },
    ], 8));
    const page = await session.tools.get("read_memory_source").execute(
      readingId, { block: 1, page: 1 }, undefined, undefined, ctx,
    );
    sm.appendMessage(toolResult(readingId, "read_memory_source", page.content.map((part) => part.text).join("\n"), 9));
    const resultC = appendReadRound(sm, "pair:c", "c.txt", `PAIR-C ${PADDING}`, 10);
    const pinned = await serveContext(session, sm, ctx);
    assert.equal(advisoriesOf(pinned).length, 1, "the tail-safe range establishes a pending request");

    // Growth after that request must not silently expand its pinned source.
    appendReadRound(sm, "pair:d", "d.txt", `PAIR-D ${PADDING}`, 12);
    await submit("pair:tail", 14);
    const tailBlocks = stateEntriesOf(sm).at(-1).data.blocks;
    assert.equal(tailBlocks.at(-1).endEntryId, resultB,
      "the pin ends before the reading exchange, even after later ordinary work");
    assert.deepEqual(tailBlocks[0], firstBlock, "the existing block and retained instruction are unchanged");
    const tailView = await serveContext(session, sm, ctx);
    const readingParts = (messages) => ({
      calls: messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((part) => part?.type === "toolCall" && part.id === readingId),
      results: messages.filter((message) => message.role === "toolResult" && message.toolCallId === readingId),
    });
    assert.equal(readingParts(tailView).calls.length, 1, "the tail reading call stays raw");
    assert.equal(readingParts(tailView).results.length, 1, "its matching result stays raw too");
    assert.equal(advisoriesOf(tailView).length, 1, "served growth establishes the next maintenance request");

    await submit("pair:middle", 16);
    const middleBlocks = stateEntriesOf(sm).at(-1).data.blocks;
    assert.equal(middleBlocks.at(-1).endEntryId, resultC, "only the newly served range is accepted");
    assert.deepEqual(middleBlocks.slice(0, -1), tailBlocks, "the old prefix stays byte-stable");
    const middleView = await serveContext(session, sm, ctx);
    assert.deepEqual(readingParts(middleView), { calls: [], results: [] }, "the covered reading pair leaves whole");
    assert.ok(middleView.some((message) => message.role === "user" && message.content.includes("combined task")),
      "the original task remains raw after protection and maintenance advance");
    assert.deepEqual(middleBlocks[0].retainedEntryIds, [task]);
    // Registrar recovery must derive exactly the same replacement set from
    // the tree; the native persisted recovery matrix lives in lifecycle.test.
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const recovered = await serveContext(session, sm, ctx);
    assert.deepEqual(recovered, middleView, "re-derivation does not resurrect a reading half-pair");
  }

  console.log("context-memory maintenance boundary tests: OK");
} finally {
  // Nothing persistent is created: every SessionManager is in-memory.
}
