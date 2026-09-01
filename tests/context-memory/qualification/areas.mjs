import assert from "node:assert/strict";
import {
  ADVISORY_TYPE,
  DUE_CONFIG,
  DISABLED_CONFIG,
  MARKER,
  PENDING_ACK,
  WINDOW,
  createHarness,
  fakeTree,
  projectedMessages,
  pushDueRun,
  soleSubmitBatch,
  beforeCompactEvent,
  commitTakeover,
  readWholeBlock,
  userEntry,
  assistantEntry,
  toolResultEntry,
  memoryCompaction,
  nativeCompaction,
  format,
  transcript,
} from "./harness.mjs";
import {
  BLOCK_FIRST,
  BLOCK_SECOND,
  BLOCK_THIRD,
  BLOCK_REBUILT,
  preRunBranch,
  richMemoryTree,
  richSourceEntries,
} from "./fixtures.mjs";

/**
 * The eight deterministic corpus areas of #214/#223: first append, repeated
 * append, suffix rebuild, source paging, branch/session behavior, safe
 * fallback, transaction failures, and exact prefix snapshots. Every check is
 * zero-tolerance and classified by the severe-failure vocabulary the
 * qualification report uses.
 */

const SUBMIT = "submit_memory";
const READ = "read_memory_source";

/** Append the assistant submit turn after the request entry is already on the branch. */
function pushSubmitTurn(session, { assistant, result, callId, body }) {
  session.append(assistantEntry(assistant, session.parentId(), [
    { type: "text", text: `${MARKER} done — submitting the Memory block` },
    { type: "toolCall", id: callId, name: SUBMIT, arguments: { markdown: body } },
  ]));
  session.append(toolResultEntry(result, session.parentId(), SUBMIT, PENDING_ACK));
}

/** A fresh accepted candidate: due session, real-user run, sole accepted submission. */
async function openAcceptedRun(options = {}) {
  const {
    config = DUE_CONFIG,
    usage,
    isIdle = true,
    body = `# ${MARKER} candidate\n\n- the accepted block`,
    callId = "call-x",
    request = "r1",
    assistant = "r2",
    result = "r3",
    entries = preRunBranch("e"),
    requestText = `${MARKER} ship it`,
  } = options;
  const harness = createHarness({ config, usage, isIdle });
  const session = fakeTree([...entries]);
  const ctx = harness.baseContext(session);
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await harness.emit("input", { type: "input", text: requestText, source: "interactive" }, ctx);
  pushDueRun(session, { request, assistant, result, callId, body, requestText });
  await harness.emit("message_end", soleSubmitBatch(callId, body), ctx);
  const result2 = await harness.tools.get(SUBMIT).execute(callId, { markdown: body }, undefined, undefined, ctx);
  return { harness, session, ctx, accepted: result2 };
}

// ─── Area 1: first append ──────────────────────────────────────────

export async function areaFirstAppend(recorder, artifacts) {
  const A = "first-append";
  const harness = createHarness();
  const session = fakeTree(preRunBranch("e"));
  const ctx = harness.baseContext(session);

  await recorder.check(A, "due-state-before-input", "uncertainty-promotion", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "due" });
    assert.ok(!harness.activeTools().includes(SUBMIT), "no due run is open before a real-user input");
  });

  await recorder.check(A, "extension-input-never-opens", "negative-constraint", async () => {
    await harness.emit("input", { type: "input", text: "go on", source: "extension" }, ctx);
    assert.ok(!harness.activeTools().includes(SUBMIT));
  });

  await recorder.check(A, "real-user-input-activates-sole-tool", "fabrication", async () => {
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT), "the real-user input activates submit_memory");
    assert.deepEqual(
      harness.activeTools().filter((name) => name !== SUBMIT),
      ["read", "bash"],
      "unrelated active tools keep their identity and order",
    );
    const steering = harness.baseContext(session, { isIdle: () => false });
    await harness.emit("input", { type: "input", text: "also tests", source: "interactive", streamingBehavior: "steer" }, steering);
    assert.ok(harness.activeTools().includes(SUBMIT), "a steering input keeps the frozen handshake");
  });

  pushDueRun(session, {
    request: "e4", assistant: "e5", result: "e6", callId: "call-1",
    body: BLOCK_FIRST, requestText: "ship it",
  });

  await recorder.check(A, "one-ephemeral-advisory", "fabrication", async () => {
    const request = [
      { role: "user", content: `${MARKER} walk me through the repo`, timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: `${MARKER} one entry point` }], timestamp: 2 },
      { role: "user", content: "ship it", timestamp: 3 },
    ];
    const transformed = await harness.emit("context", { type: "context", messages: request }, ctx);
    assert.ok(transformed && Array.isArray(transformed.messages));
    assert.equal(transformed.messages.length, request.length + 1);
    const advisory = transformed.messages.at(-1);
    assert.equal(advisory.role, "custom");
    assert.equal(advisory.customType, ADVISORY_TYPE);
    assert.equal(advisory.display, false, "the advisory is non-display");
    artifacts.advisories.first = advisory.content;
    assert.ok(advisory.content.includes(SUBMIT));
    assert.ok(advisory.content.includes("sole tool call of its batch"));
    assert.ok(advisory.content.includes("continue the same run"), "the advisory keeps the run running after the submission (#253)");
    assert.ok(!advisory.content.includes("finish the run"), "the advisory no longer ends the run with the submission");
    assert.ok(advisory.content.includes("Do not copy credential values"));
    const later = [...request, advisory, { role: "assistant", content: [] }];
    const second = await harness.emit("context", { type: "context", messages: later }, ctx);
    const messages = second?.messages ?? [];
    assert.equal(
      messages.filter((message) => message?.customType === ADVISORY_TYPE).length,
      1,
      "later requests never repeat the advisory",
    );
    assert.ok(session.raw.every((entry) => entry.type === "message"), "the advisory never becomes a SessionEntry");
  });

  await recorder.check(A, "sibling-tool-call-refused", "negative-constraint", async () => {
    await harness.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-sib", name: SUBMIT, arguments: { markdown: BLOCK_FIRST } },
          { type: "toolCall", id: "call-other", name: "read", arguments: { path: "x" } },
        ],
      },
    }, ctx);
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-sib", { markdown: BLOCK_FIRST }, undefined, undefined, ctx),
      (error) => {
        assert.match(error.message, /^SUBMIT_NOT_SOLE_TOOL: /);
        assert.ok(!error.message.includes(MARKER), "the failure never echoes Memory Markdown");
        return true;
      },
    );
  });

  await recorder.check(A, "invalid-bodies-refused", "negative-constraint", async () => {
    await harness.emit("message_end", soleSubmitBatch("call-body", "x"), ctx);
    for (const body of ["", "\u0000 embedded nul", "bad\u0001control", "x".repeat(16 * 1024 + 1)]) {
      await assert.rejects(
        () => harness.tools.get(SUBMIT).execute("call-body", { markdown: body }, undefined, undefined, ctx),
        (error) => {
          assert.match(error.message, /^BOUND_EXCEEDED: /);
          assert.ok(!error.message.includes(MARKER));
          return true;
        },
      );
    }
    assert.notDeepEqual(harness.registration.snapshot(), { state: "pending" }, "no candidate was stored");
  });

  let takeover;
  await recorder.check(A, "accepted-result-and-settle", "fabrication", async () => {
    await harness.emit("message_end", soleSubmitBatch("call-1", BLOCK_FIRST), ctx);
    const accepted = await harness.tools.get(SUBMIT).execute("call-1", { markdown: BLOCK_FIRST }, undefined, undefined, ctx);
    assert.deepEqual(accepted.content, [{ type: "text", text: PENDING_ACK }]);
    assert.deepEqual(accepted.details, { accepted: true });
    assert.deepEqual(Object.keys(accepted.details), ["accepted"]);
    assert.equal(accepted.terminate, undefined, "the accepted submission no longer ends the run (#253)");
    assert.deepEqual(harness.registration.snapshot(), { state: "pending" });
    assert.ok(!harness.activeTools().includes(SUBMIT),
      "acceptance deactivates submit_memory for the rest of the due run");
    assert.deepEqual(
      harness.activeTools().filter((name) => name !== SUBMIT),
      ["read", "bash"],
      "unrelated active tools keep their identity and order after acceptance",
    );
    // The run continues after the acknowledgement: further ordinary entries
    // land after the accepted submission and the candidate stays pending.
    session.append(assistantEntry("e7", session.parentId(), [
      { type: "text", text: `${MARKER} still working — the run did not end with the submission` },
    ]));
    session.append(toolResultEntry("e8", session.parentId(), "read", `${MARKER} late run evidence`));
    assert.deepEqual(harness.registration.snapshot(), { state: "pending" },
      "the candidate stays pending while the run continues");
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-1", { markdown: BLOCK_FIRST }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^COMPACTION_BUSY: /); return true; },
      "a duplicate submission while the slot is pending is refused",
    );
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1, "settle calls ctx.compact() exactly once");
    assert.ok(!harness.activeTools().includes(SUBMIT), "settle closes the due run");
  });

  await recorder.check(A, "takeover-exact-shape", "exact-detail-corruption", async () => {
    takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "e4", tokensBefore: 4321 }),
      ctx,
    );
    assert.ok(takeover?.compaction, "the matching candidate is consumed");
    assert.equal(takeover.compaction.summary, format.composeMemorySummary([BLOCK_FIRST]));
    assert.equal(takeover.compaction.firstKeptEntryId, "e4",
      "the current real-user request becomes firstKeptEntryId");
    assert.equal(takeover.compaction.tokensBefore, 4321,
      "the takeover carries Pi's truthful preparation token accounting");
    assert.deepEqual(takeover.compaction.details, {
      format: format.MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: "e3", markdownBytes: Buffer.byteLength(BLOCK_FIRST, "utf8") }],
    }, "the directory ends at the last eligible entry before the request");
    assert.equal(takeover.cancel, undefined, "the takeover never cancels");
    assert.deepEqual(harness.registration.snapshot(), { state: "committing" });
  });

  await recorder.check(A, "exact-confirmation-commits", "exact-detail-corruption", async () => {
    assert.ok(takeover?.compaction, "takeover unavailable (earlier failure)");
    await commitTakeover(harness, session, ctx, takeover);
    const snapshot = harness.registration.snapshot({ tokens: 900, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.blocks, 1);
    assert.ok(harness.activeTools().includes(READ), "committed Memory activates the reading surface");
    assert.ok(!harness.activeTools().includes(SUBMIT));
    assert.equal(harness.compactCalls.length, 1, "no further compaction is triggered");
  });

  await recorder.check(A, "source-and-kept-boundaries", "exact-detail-corruption", async () => {
    const inspected = harness.registration.inspect({ block: 1, page: 1 }, session);
    assert.equal(inspected.ok, true);
    assert.ok(inspected.text.includes(BLOCK_FIRST), "the block body survives byte-exact");
    assert.ok(inspected.text.includes(`${MARKER} walk me through the repo`), "block 1 starts at the first eligible entry");
    assert.ok(inspected.text.includes(`${MARKER} export default register()`), "tool results recover as sources");
    assert.ok(!inspected.text.includes("ship it"), "the current request stays outside the new block");
    const projected = projectedMessages(session);
    assert.equal(projected[0].role, "compactionSummary");
    assert.equal(projected[0].summary, format.composeMemorySummary([BLOCK_FIRST]));
    assert.equal(projected[1].role, "user");
    assert.equal(projected[1].content, "ship it", "the run's user request is the retained-tail boundary");
    assert.equal(projected.length, 6, "the whole current run — including the post-submission work — stays uncompressed");
    assert.ok(JSON.stringify(projected.slice(2)).includes(`${MARKER} still working`),
      "the post-acknowledgement continuation stays in the retained tail (#253)");
    assert.ok(JSON.stringify(projected.slice(2)).includes(`${MARKER} late run evidence`),
      "post-submission tool evidence stays in the retained tail (#253)");
  });

  await recorder.check(A, "protocol-artifact-filtering", "negative-constraint", async () => {
    const transformed = await harness.emit("context", { type: "context", messages: projectedMessages(session) }, ctx);
    assert.ok(transformed?.messages, "the transform runs outside any due run");
    const serialized = JSON.stringify(transformed.messages);
    assert.ok(!serialized.includes(SUBMIT), "submit call parts and results leave provider-bound requests");
    assert.ok(!serialized.includes(PENDING_ACK), "paired submit results leave the request");
    assert.ok(serialized.includes("ship it"), "the current request survives");
    assert.equal(transformed.messages.length, 5, "only the paired submit result drops as a whole message");
    assert.deepEqual(
      transformed.messages[2].content,
      [{ type: "text", text: `${MARKER} done — submitting the Memory block` }],
      "ordinary assistant text survives its message",
    );
    assert.ok(serialized.includes(`${MARKER} still working`),
      "the post-acknowledgement continuation reaches later requests (#253)");
  });
}

// ─── Area 2: repeated append ───────────────────────────────────────

export async function areaRepeatedAppend(recorder, artifacts) {
  const A = "repeated-append";
  const session = fakeTree(preRunBranch("p"));
  pushDueRun(session, {
    request: "p4", assistant: "p5", result: "p6", callId: "call-1",
    body: BLOCK_FIRST, requestText: `${MARKER} ship it`,
  });
  session.append(memoryCompaction("pc1", session.parentId(), {
    firstKeptEntryId: "p4",
    ends: ["p3"],
    bodies: [BLOCK_FIRST],
  }));
  // The accumulated tail: an ordinary exchange plus a read_memory_source
  // round trip that stays usable now but must never enter a later source.
  session.append(userEntry("t1", session.parentId(), `${MARKER} now compress the lexer work too`));
  session.append(assistantEntry("t2", session.parentId(), [
    { type: "text", text: `${MARKER} checking the first block's exact sources` },
    { type: "toolCall", id: "call-read-src", name: READ, arguments: { block: 1, page: 1 } },
  ]));
  session.append(toolResultEntry("t3", session.parentId(), READ, `${MARKER}-PAGE-NEEDLE`));
  session.append(assistantEntry("t4", session.parentId(), [{ type: "text", text: `${MARKER} the exchange is verified` }]));

  const usage = { tokens: 800, contextWindow: WINDOW };
  const harness = createHarness({ usage });
  const ctx = harness.baseContext(session);

  await recorder.check(A, "resume-below-threshold-appends-next", "uncertainty-promotion", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const snapshot = harness.registration.snapshot({ tokens: 800, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.blocks, 1);
    assert.equal(snapshot.nextOperation, "append");
    assert.ok(!harness.activeTools().includes(SUBMIT), "below the threshold no due run opens");
  });

  usage.tokens = 12_000;
  await recorder.check(A, "second-due-run-opens-onto-memory", "fabrication", async () => {
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    await harness.emit("input", { type: "input", text: "ship the lexer block", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT), "the second due real-user run opens onto existing Memory");
    assert.ok(harness.activeTools().includes(READ), "the reading surface stays active through the append boundary");
    assert.deepEqual(
      harness.activeTools().filter((name) => name !== SUBMIT && name !== READ),
      ["read", "bash"],
    );
  });

  session.append(userEntry("u1", session.parentId(), "ship the lexer block"));

  await recorder.check(A, "append-advisory-and-artifact-filtering", "fabrication", async () => {
    const transformed = await harness.emit("context", { type: "context", messages: projectedMessages(session) }, ctx);
    assert.ok(transformed?.messages, "the append run transforms its provider requests");
    const nonAdvisory = JSON.stringify(
      transformed.messages.filter((message) => message?.customType !== ADVISORY_TYPE),
    );
    assert.ok(!nonAdvisory.includes(SUBMIT), "round-one submit artifacts leave the append run's requests");
    assert.ok(!nonAdvisory.includes(PENDING_ACK), "paired results leave the request");
    assert.ok(nonAdvisory.includes(`${MARKER} now compress the lexer work too`), "the accumulated tail survives");
    assert.ok(nonAdvisory.includes(READ), "read artifacts stay provider-visible");
    const advisory = transformed.messages.at(-1);
    assert.equal(advisory?.customType, ADVISORY_TYPE);
    artifacts.advisories.append = advisory.content;
    assert.ok(advisory.content.includes("since the existing Memory blocks"),
      "the append advisory names the newly accumulated source scope");
    assert.ok(advisory.content.includes("appended after the existing Memory blocks"),
      "the append advisory identifies the append operation");
    assert.ok(advisory.content.includes("Do not copy credential values"), "the secret warning stays");
    assert.equal(transformed.messages.at(-2).content, "ship the lexer block",
      "the advisory sits directly after the current user message");
  });

  let takeover;
  await recorder.check(A, "append-takeover-keeps-prefix-bytes", "exact-detail-corruption", async () => {
    pushSubmitTurn(session, { assistant: "u2", result: "u3", callId: "call-2", body: BLOCK_SECOND });
    await harness.emit("message_end", soleSubmitBatch("call-2", BLOCK_SECOND), ctx);
    const accepted = await harness.tools.get(SUBMIT).execute("call-2", { markdown: BLOCK_SECOND }, undefined, undefined, ctx);
    assert.equal(accepted.content[0].text, PENDING_ACK);
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1, "the append candidate reaches Pi's seam once");
    const oneBlock = format.composeMemorySummary([BLOCK_FIRST]);
    takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "u1", tokensBefore: 8888 }),
      ctx,
    );
    assert.ok(takeover?.compaction, "the append candidate is consumed");
    assert.equal(takeover.compaction.summary, format.composeMemorySummary([BLOCK_FIRST, BLOCK_SECOND]));
    assert.ok(takeover.compaction.summary.startsWith(oneBlock),
      "the complete existing rendering stays the byte-identical prefix");
    assert.equal(takeover.compaction.summary.slice(oneBlock.length), format.MEMORY_BLOCK_SEPARATOR + BLOCK_SECOND,
      "divergence begins exactly at the separator before the new body");
    assert.equal(takeover.compaction.firstKeptEntryId, "u1");
    assert.equal(takeover.compaction.tokensBefore, 8888);
    assert.deepEqual(takeover.compaction.details, {
      format: format.MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: "p3", markdownBytes: Buffer.byteLength(BLOCK_FIRST, "utf8") },
        { endEntryId: "t4", markdownBytes: Buffer.byteLength(BLOCK_SECOND, "utf8") },
      ],
    }, "the directory carries the unchanged entry plus one new ordered end");
  });

  await recorder.check(A, "append-commit-carries-full-latest-list", "exact-detail-corruption", async () => {
    assert.ok(takeover?.compaction, "takeover unavailable (earlier failure)");
    await commitTakeover(harness, session, ctx, takeover);
    const snapshot = harness.registration.snapshot({ tokens: 900, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.blocks, 2, "the complete latest compaction carries all current blocks");
    assert.equal(session.raw.filter((entry) => entry.type === "compaction").length, 2,
      "the older compaction stays history on the branch");
    assert.equal(snapshot.stablePrefix, 2);
    assert.equal(snapshot.nextOperation, "append");
    assert.equal(snapshot.rows[1].sources, 5,
      "block 2 covers exactly the accumulated eligible entries between the boundaries");
  });

  await recorder.check(A, "block-two-sources-drop-protocol-artifacts", "recursive-drift", async () => {
    const whole = await readWholeBlock(harness, ctx, 2);
    for (const needle of [
      "ship it",
      `${MARKER} now compress the lexer work too`,
      `${MARKER} checking the first block's exact sources`,
      `${MARKER} the exchange is verified`,
    ]) {
      assert.ok(whole.includes(needle), `block 2 sources preserve the accumulated conversation`);
    }
    for (const forbidden of [READ, `${MARKER}-PAGE-NEEDLE`, PENDING_ACK, `${MARKER} walk me through the repo`]) {
      assert.ok(!whole.includes(forbidden), `block 2 sources never expose protocol artifacts or older blocks`);
    }
    const first = await readWholeBlock(harness, ctx, 1);
    assert.ok(first.includes(`${MARKER} walk me through the repo`), "block 1 keeps its original sources after the append");
    assert.ok(!first.includes("lexer work"), "block ranges never overlap");
  });

  await recorder.check(A, "third-append-keeps-two-block-prefix", "exact-detail-corruption", async () => {
    session.append(userEntry("t5", session.parentId(), `${MARKER} one more exchange`));
    session.append(assistantEntry("t6", session.parentId(), [{ type: "text", text: `${MARKER} acknowledged again` }]));
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    await harness.emit("input", { type: "input", text: "ship the third block", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT), "the third due run opens after the settled re-derivation");
    pushDueRun(session, {
      request: "v1", assistant: "v2", result: "v3", callId: "call-3",
      body: BLOCK_THIRD, requestText: "ship the third block",
    });
    await harness.emit("message_end", soleSubmitBatch("call-3", BLOCK_THIRD), ctx);
    await harness.tools.get(SUBMIT).execute("call-3", { markdown: BLOCK_THIRD }, undefined, undefined, ctx);
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    const takeover3 = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "v1", tokensBefore: 9999 }),
      ctx,
    );
    assert.ok(takeover3?.compaction);
    assert.equal(takeover3.compaction.summary, format.composeMemorySummary([BLOCK_FIRST, BLOCK_SECOND, BLOCK_THIRD]));
    assert.ok(takeover3.compaction.summary.startsWith(format.composeMemorySummary([BLOCK_FIRST, BLOCK_SECOND])),
      "the repeated append keeps the two-block rendering byte-identical");
    assert.deepEqual(
      takeover3.compaction.details.blocks.slice(0, 2),
      takeover.compaction.details.blocks,
      "the existing directory entries stay byte-identical on the repeated append",
    );
    assert.equal(takeover3.compaction.details.blocks[2].endEntryId, "t6",
      "the new ordered end is the last eligible entry before the request");
  });
}

// ─── Area 3: suffix rebuild and the scale limit ────────────────────

export async function areaSuffixRebuild(recorder, artifacts) {
  const A = "suffix-rebuild";
  // budget 1% = 2000 tokens → half 1000 tokens (4000 chars): A alone renders
  // below half, A+B above, so the shortest newest suffix is [B, C] with
  // prefix [A].
  const ALPHA = `# ${MARKER} Alpha\n\n- ` + "a".repeat(90);
  const BETA = `# ${MARKER} Beta\n\n- ` + "b".repeat(7400);
  const GAMMA = `# ${MARKER} Gamma\n\n- ` + "g".repeat(46);
  const session = fakeTree([
    userEntry("m1", null, `${MARKER} alpha task`),
    assistantEntry("m2", "m1", [{ type: "text", text: `${MARKER} ALPHA-SRC` }]),
    userEntry("m3", "m2", `${MARKER} beta task`),
    assistantEntry("m4", "m3", [{ type: "text", text: `${MARKER} BETA-SRC` }]),
    userEntry("m5", "m4", `${MARKER} gamma task`),
    assistantEntry("m6", "m5", [{ type: "text", text: `${MARKER} GAMMA-SRC` }]),
    userEntry("m7", "m6", "ship it"),
    memoryCompaction("mc", "m7", {
      firstKeptEntryId: "m7",
      ends: ["m2", "m4", "m6"],
      bodies: [ALPHA, BETA, GAMMA],
    }),
    userEntry("m8", "mc", `${MARKER} new work after the compaction`),
    assistantEntry("m9", "m8", [{ type: "text", text: `${MARKER} TAIL-SRC` }]),
  ]);
  const harness = createHarness();
  const ctx = harness.baseContext(session);

  await recorder.check(A, "selection-shortest-newest-suffix", "exact-detail-corruption", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const snapshot = harness.registration.snapshot({ tokens: 12_000, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.blocks, 3);
    assert.equal(snapshot.nextOperation, "rebuild", "Memory above half budget plans the rebuild");
    assert.equal(snapshot.stablePrefix, 1, "the unchanged prefix is exactly block A");
  });

  await recorder.check(A, "rebuild-run-opens", "fabrication", async () => {
    await harness.emit("input", { type: "input", text: "maintain the memory", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT), "the due real-user run opens as the maintenance rebuild");
    assert.ok(harness.activeTools().includes(READ), "the reading surface is unaffected by the operation choice");
  });

  session.append(userEntry("m10", session.parentId(), "maintain the memory"));

  await recorder.check(A, "maintenance-projection-exact", "recursive-drift", async () => {
    const branchLength = session.raw.length;
    const request = projectedMessages(session);
    assert.equal(request[0].role, "compactionSummary");
    assert.equal(request[0].summary, format.composeMemorySummary([ALPHA, BETA, GAMMA]));
    const transformed = await harness.emit("context", { type: "context", messages: request }, ctx);
    assert.ok(transformed?.messages, "the maintenance run transforms its first provider request");
    const projected = transformed.messages;
    assert.equal(projected[0].summary, format.composeMemorySummary([ALPHA]),
      "the summary message keeps exactly the unchanged prefix rendering");
    assert.ok(!projected[0].summary.includes("b".repeat(64)) && !projected[0].summary.includes(GAMMA),
      "the selected summaries leave the request");
    const serialized = JSON.stringify(projected);
    assert.equal((serialized.match(/beta task/g) ?? []).length, 1, "every selected source entry is inserted exactly once");
    assert.equal((serialized.match(/GAMMA-SRC/g) ?? []).length, 1);
    assert.ok(!serialized.includes(BETA.slice(0, 200)), "a selected block body never appears beside its sources");
    assert.equal(projected[1].content, `${MARKER} beta task`, "the inserted sources begin at the first selected block's source start");
    const order = ["beta task", "gamma task", "ship it", "new work after the compaction", "maintain the memory"]
      .map((needle) => serialized.indexOf(needle));
    assert.ok(order.every((at, index) => at !== -1 && (index === 0 || at > order[index - 1])),
      "sources, raw tail, and current request stay in chronological order");
    const advisory = projected.at(-1);
    assert.equal(advisory?.customType, ADVISORY_TYPE);
    artifacts.advisories.maintenance = advisory.content;
    assert.ok(advisory.content.includes("maintenance compression is due"),
      "the maintenance advisory identifies the rebuild operation");
    assert.ok(advisory.content.includes("Do not copy credential values"));
    assert.equal(session.raw.length, branchLength, "the maintenance projection never persists anything");
  });

  await recorder.check(A, "projection-is-one-shot", "uncertainty-promotion", async () => {
    const second = await harness.emit("context", { type: "context", messages: projectedMessages(session) }, ctx);
    assert.ok(second?.messages);
    assert.equal(second.messages[0].summary, format.composeMemorySummary([ALPHA, BETA, GAMMA]),
      "later requests carry the unmodified Memory rendering");
    assert.equal(
      second.messages.filter((message) => message?.customType === ADVISORY_TYPE).length,
      0,
      "later requests never repeat the advisory or re-insert the sources",
    );
  });

  let takeover;
  await recorder.check(A, "rebuild-takeover-prefix-divergence", "exact-detail-corruption", async () => {
    pushSubmitTurn(session, { assistant: "m11", result: "m12", callId: "call-rebuild", body: BLOCK_REBUILT });
    await harness.emit("message_end", soleSubmitBatch("call-rebuild", BLOCK_REBUILT), ctx);
    const accepted = await harness.tools.get(SUBMIT).execute("call-rebuild", { markdown: BLOCK_REBUILT }, undefined, undefined, ctx);
    assert.equal(accepted.content[0].text, PENDING_ACK);
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1, "the rebuild candidate reaches Pi's seam once");
    takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "m10", tokensBefore: 7777 }),
      ctx,
    );
    assert.ok(takeover?.compaction, "the matching rebuild candidate is consumed");
    const prefixRendering = format.composeMemorySummary([ALPHA]);
    assert.equal(takeover.compaction.summary, format.composeMemorySummary([ALPHA, BLOCK_REBUILT]));
    assert.ok(takeover.compaction.summary.startsWith(prefixRendering),
      "every unselected older block stays byte-identical");
    assert.equal(takeover.compaction.summary.slice(prefixRendering.length), format.MEMORY_BLOCK_SEPARATOR + BLOCK_REBUILT,
      "divergence begins exactly at the first rebuilt block");
    assert.equal(takeover.compaction.firstKeptEntryId, "m10");
    assert.equal(takeover.compaction.tokensBefore, 7777);
    assert.deepEqual(takeover.compaction.details, {
      format: format.MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: "m2", markdownBytes: Buffer.byteLength(ALPHA, "utf8") },
        { endEntryId: "m9", markdownBytes: Buffer.byteLength(BLOCK_REBUILT, "utf8") },
      ],
    }, "the replacement extends the source boundary over the suffix sources and the raw tail");
  });

  await recorder.check(A, "rebuild-commit-collapses-suffix", "exact-detail-corruption", async () => {
    assert.ok(takeover?.compaction, "takeover unavailable (earlier failure)");
    await commitTakeover(harness, session, ctx, takeover);
    const snapshot = harness.registration.snapshot({ tokens: 900, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.blocks, 2, "the selected suffix collapsed into one replacement block");
    assert.equal(snapshot.stablePrefix, 2);
    assert.equal(snapshot.nextOperation, "append");
  });

  await recorder.check(A, "rebuilt-sources-cover-originals", "recursive-drift", async () => {
    const whole = await readWholeBlock(harness, ctx, 2);
    for (const needle of [
      `${MARKER} beta task`,
      `${MARKER} BETA-SRC`,
      `${MARKER} gamma task`,
      `${MARKER} GAMMA-SRC`,
      "ship it",
      `${MARKER} new work after the compaction`,
      `${MARKER} TAIL-SRC`,
    ]) {
      assert.ok(whole.includes(needle), "the rebuilt block covers the suffix's original conversation plus the raw tail");
    }
    for (const forbidden of [`${MARKER} alpha task`, `${MARKER} ALPHA-SRC`]) {
      assert.ok(!whole.includes(forbidden), "the unchanged prefix keeps its own sources");
    }
    const first = await readWholeBlock(harness, ctx, 1);
    assert.ok(first.includes(`${MARKER} alpha task`), "block 1 keeps its original sources after the rebuild");
    assert.ok(!first.includes("beta task"), "the rebuilt range never overlaps the prefix range");
  });

  // The scale limit: sources too large for maintenance (boundary fixture).
  await recorder.check(A, "scale-limit-stops-takeover", "uncertainty-promotion", async () => {
    const usage = { tokens: 12_000, contextWindow: WINDOW };
    const scaleHarness = createHarness({ usage });
    const scaleSession = fakeTree([
      userEntry("s1", null, `${MARKER} small task`),
      assistantEntry("s2", "s1", [{ type: "text", text: `${MARKER} small answer` }]),
      userEntry("s3", "s2", `${MARKER} huge task`),
      assistantEntry("s4", "s3", [{ type: "text", text: `${MARKER} HUGE-SRC ` + "x".repeat(720_000) }]),
      userEntry("s5", "s4", "ship it"),
      memoryCompaction("sc", "s5", {
        firstKeptEntryId: "s5",
        ends: ["s2", "s4"],
        bodies: [`# ${MARKER} Small\n\n- ` + "a".repeat(80), `# ${MARKER} Big\n\n- ` + "b".repeat(7900)],
      }),
    ]);
    const scaleCtx = scaleHarness.baseContext(scaleSession);
    await scaleHarness.emit("session_start", { type: "session_start", reason: "resume" }, scaleCtx);
    assert.deepEqual(scaleHarness.registration.snapshot(), { state: "scale-limit" },
      "the branch reports its scale limit while due Memory cannot be rebuilt to fit");
    await scaleHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, scaleCtx);
    assert.ok(!scaleHarness.activeTools().includes(SUBMIT), "the scale limit exposes no submission handshake");
    assert.ok(scaleHarness.activeTools().includes(READ), "the reading surface is unaffected by the scale limit");
    assert.deepEqual(scaleHarness.registration.snapshot(), { state: "scale-limit" },
      "the scale-limit report survives the refused input");
    const native = await scaleHarness.emit(
      "session_before_compact",
      beforeCompactEvent(scaleSession, { firstKeptEntryId: "s5", reason: "threshold" }),
      scaleCtx,
    );
    assert.equal(native, undefined, "compaction is delegated to Pi native behavior");

    usage.contextWindow = 400_000;
    await scaleHarness.emit("model_select", { type: "model_select", model: {}, previousModel: undefined, source: "set" }, scaleCtx);
    const recalculated = scaleHarness.registration.snapshot({ tokens: 12_000, contextWindow: 400_000 });
    assert.equal(recalculated.state, "active", "the larger window clears the scale limit");
    assert.equal(recalculated.blocks, 2, "no block is deleted or scaled by the model change");
    assert.equal(recalculated.nextOperation, "rebuild");
    assert.equal(recalculated.stablePrefix, 1);
    await scaleHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, scaleCtx);
    assert.ok(scaleHarness.activeTools().includes(SUBMIT), "the maintenance run opens under the recalculated budgets");
  });
}

// ─── Area 4: source paging ─────────────────────────────────────────

export async function areaSourcePaging(recorder) {
  const A = "source-paging";
  const { entries } = richMemoryTree();
  const session = fakeTree(entries);
  const harness = createHarness();
  const ctx = harness.baseContext(session);
  await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

  let whole = "";
  await recorder.check(A, "fixed-16-kib-code-point-safe-paging", "exact-detail-corruption", async () => {
    const read = harness.tools.get(READ);
    const pages = [];
    let page = 1;
    let totalPages = 0;
    for (;;) {
      const result = await read.execute(`q:1:${page}`, { block: 1, page }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /^Memory source · block 1 of 1 · page \d+ of \d+$/);
      assert.ok(Buffer.byteLength(result.content[1].text, "utf8") <= 16 * 1024, "every page respects the 16 KiB contract");
      assert.deepEqual(
        Object.keys(result.details).sort(),
        ["block", "hasMore", "page", "totalBlocks", "totalPages"],
        "details carry only the five bounded paging fields",
      );
      if (result.details.hasMore) {
        assert.deepEqual(
          result.content.at(-1).text,
          `Next page: read_memory_source({ "block": 1, "page": ${page + 1} })`,
          "the fixed next-page hint appears exactly on non-final pages",
        );
      } else {
        assert.equal(result.content.filter((part) => part.text.startsWith("Next page:")).length, 0,
          "the final page carries no next-page hint");
      }
      pages.push(result.content[1].text);
      totalPages = result.details.totalPages;
      if (!result.details.hasMore) break;
      page += 1;
    }
    assert.ok(totalPages >= 3, "the multibyte source spans several pages");
    whole = pages.join("");
    const multibyteRun = `${MARKER} 境界 ` + "境界ナンバー".repeat(3_400);
    assert.ok(whole.includes(multibyteRun), "no page boundary breaks a code point");
    assert.equal(whole, transcript.renderSourceTranscript(richSourceEntries()),
      "pages reassemble the deterministic transcript exactly");
  });

  await recorder.check(A, "role-labels-and-privacy", "negative-constraint", async () => {
    for (const needle of [
      "[user]",
      "[user · image] [image · image/png · 8 B]",
      "[assistant]",
      "[assistant · thinking]",
      "(redacted thinking)",
      "[assistant · tool call] read",
      "[tool result] read · ok",
      "[tool result] read · error",
      "[image · image/jpeg · 300 B]",
      "[custom message]",
      "[branch summary]",
      `${MARKER} 漢字テスト`,
    ]) {
      assert.ok(whole.includes(needle), `the transcript preserves ${JSON.stringify(needle)}`);
    }
    assert.ok(!whole.includes("\u0001") && !whole.includes("\u007f"),
      "prohibited control characters are replaced, never copied");
    assert.ok(whole.includes("\ufffd"), "the deterministic replacement appears");
    const read = harness.tools.get(READ);
    for (const forbidden of [
      "iVBORw0KGgo", "2026-01-01", "claude-sonnet", "totalTokens", "parentId",
      "pi-square/notice", "qcorpus-project",
    ]) {
      assert.ok(!whole.includes(forbidden), `the transcript never exposes ${JSON.stringify(forbidden)}`);
    }
    for (const id of ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "qc"]) {
      assert.ok(!whole.includes(` ${id} `) && !whole.includes(` ${id}\n`), `the transcript never exposes entry id ${id}`);
    }
  });

  await recorder.check(A, "safe-error-codes", "uncertainty-promotion", async () => {
    const read = harness.tools.get(READ);
    await assert.rejects(
      () => read.execute("q:e1", { block: 2, page: 1 }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^BLOCK_OUT_OF_RANGE: /); return true; },
    );
    await assert.rejects(
      () => read.execute("q:e2", { block: 1, page: 0 }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^PAGE_OUT_OF_RANGE: /); return true; },
    );
    const nativeSession = fakeTree([
      ...preRunBranch("n"),
      nativeCompaction("nc", "n3", "n3", "a plain native summary"),
    ]);
    await assert.rejects(
      () => read.execute("q:e3", { block: 1, page: 1 }, undefined, undefined, harness.baseContext(nativeSession)),
      (error) => { assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /); return true; },
    );
    const swapped = fakeTree(entries.map((entry) => (entry.id === "qc" ? { ...entry, id: "qc-swapped" } : entry)));
    await assert.rejects(
      () => read.execute("q:e4", { block: 1, page: 1 }, undefined, undefined, harness.baseContext(swapped)),
      (error) => { assert.match(error.message, /^MEMORY_CHANGED: /); return true; },
    );
    const disabled = createHarness({ config: DISABLED_CONFIG });
    await disabled.emit("session_start", { type: "session_start", reason: "resume" }, disabled.baseContext(session));
    await assert.rejects(
      () => disabled.tools.get(READ).execute("q:e5", { block: 1, page: 1 }, undefined, undefined, disabled.baseContext(session)),
      (error) => { assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /); return true; },
    );
  });
}

// ─── Area 5: branch and session behavior ───────────────────────────

export async function areaBranchSession(recorder) {
  const A = "branch-session";
  // Below the due threshold: a pre-compaction leaf reports no-memory, not due.
  const quietHarness = () => createHarness({ usage: { tokens: 100, contextWindow: WINDOW } });
  const blockBody = `# ${MARKER} branch block\n\n- one block on the carrying branch`;
  const treeOf = (options = {}) => fakeTree([
    userEntry("b1", null, `${MARKER} first task`),
    assistantEntry("b2", "b1", [{ type: "text", text: `${MARKER} first answer` }]),
    userEntry("b3", "b2", "ship it"),
    memoryCompaction("c1", "b3", { firstKeptEntryId: "b3", ends: ["b2"], bodies: [blockBody] }),
    userEntry("b4", "c1", `${MARKER} tail on the carrying branch`),
    nativeCompaction("d1", "b3", "b3", "a plain native summary on the divergent branch"),
    userEntry("d2", "d1", `${MARKER} tail on the divergent branch`),
  ], { leaf: "b4", ...options });

  await recorder.check(A, "navigation-rederives-from-leaf", "branch-contamination", async () => {
    const session = treeOf();
    const harness = quietHarness();
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    assert.equal(harness.registration.snapshot().state, "active");
    assert.ok(harness.activeTools().includes(READ));

    session.branchTo("d2");
    await harness.emit("session_tree", { type: "session_tree", newLeafId: "d2", oldLeafId: "b4" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "opaque" },
      "the divergent branch's native compaction degrades Memory");
    assert.ok(!harness.activeTools().includes(READ));

    session.branchTo("b3");
    await harness.emit("session_tree", { type: "session_tree", newLeafId: "b3", oldLeafId: "d2" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "no-memory" },
      "the pre-compaction leaf carries no Memory");

    session.branchTo("c1");
    await harness.emit("session_tree", { type: "session_tree", newLeafId: "c1", oldLeafId: "b3" }, ctx);
    assert.equal(harness.registration.snapshot().state, "active", "navigating back restores the branch's own Memory");
  });

  await recorder.check(A, "ranges-stay-branch-local", "branch-contamination", async () => {
    const harness = quietHarness();
    const ctx = harness.baseContext(treeOf());
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const snapshot = harness.registration.snapshot({ tokens: 1_000, contextWindow: WINDOW });
    assert.equal(snapshot.rows[0].sources, 2, "block 1 covers exactly its own branch's first two entries");
    const inspected = harness.registration.inspect({ block: 1, page: 1 }, treeOf());
    assert.equal(inspected.ok, true);
    assert.ok(inspected.text.includes(`${MARKER} first task`));
    assert.ok(!inspected.text.includes("divergent"), "another branch's entries never contaminate the range");
  });

  await recorder.check(A, "duplicate-ids-resolve-independently", "branch-contamination", async () => {
    const valid = quietHarness();
    await valid.emit("session_start", { type: "session_start", reason: "resume" }, valid.baseContext(treeOf()));
    const corrupted = treeOf();
    corrupted.replaceById("c1", memoryCompaction("c1", "b3", {
      firstKeptEntryId: "b3",
      ends: ["b2"],
      bodies: [`# ${MARKER} tampered\n\n- the directory no longer matches`],
      summary: format.composeMemorySummary([blockBody]),
    }));
    const corruptHarness = quietHarness();
    await corruptHarness.emit("session_start", { type: "session_start", reason: "resume" }, corruptHarness.baseContext(corrupted));
    assert.equal(valid.registration.snapshot().state, "active", "the first tree still derives its own Memory");
    assert.deepEqual(corruptHarness.registration.snapshot(), { state: "opaque" },
      "identical entry ids in a different tree never resolve across sessions");
  });

  await recorder.check(A, "resume-follows-pis-leaf", "branch-contamination", async () => {
    const first = quietHarness();
    const session = treeOf();
    await first.emit("session_start", { type: "session_start", reason: "resume" }, first.baseContext(session));
    session.branchTo("b3");
    await first.emit("session_tree", { type: "session_tree", newLeafId: "b3", oldLeafId: "b4" }, first.baseContext(session));
    assert.equal(first.registration.snapshot().state, "no-memory");
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, first.baseContext(session));

    const reopenedBefore = treeOf({ leaf: "b3" });
    await first.emit("session_start", { type: "session_start", reason: "resume" }, first.baseContext(reopenedBefore));
    assert.deepEqual(first.registration.snapshot(), { state: "no-memory" },
      "a resumed pre-compaction leaf derives no Memory — no remembered leaf preference");

    const reopenedAfter = treeOf({ leaf: "b4" });
    await first.emit("session_start", { type: "session_start", reason: "resume" }, first.baseContext(reopenedAfter));
    assert.equal(first.registration.snapshot().state, "active",
      "a resumed carrying leaf derives its Memory");
  });

  await recorder.check(A, "cancellable-session-events-unsubscribed", "negative-constraint", async () => {
    const harness = createHarness();
    const subscribed = [...harness.events.keys()];
    for (const cancellable of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
      assert.ok(!subscribed.includes(cancellable), `${cancellable} stays unsubscribed so Context Memory can never block it`);
    }
  });

  await recorder.check(A, "ephemeral-sessions-report-and-run", "fabrication", async () => {
    const ephemeral = quietHarness();
    await ephemeral.emit("session_start", { type: "session_start", reason: "startup" }, ephemeral.baseContext(treeOf({ persisted: false })));
    assert.equal(ephemeral.registration.snapshot().ephemeral, true, "an ephemeral session is clearly reported");
    const persisted = quietHarness();
    await persisted.emit("session_start", { type: "session_start", reason: "resume" }, persisted.baseContext(treeOf()));
    assert.equal(persisted.registration.snapshot().ephemeral, undefined, "a persisted session is not marked ephemeral");
  });
}

// ─── Area 6: safe fallback ──────────────────────────────────────────

export async function areaSafeFallback(recorder) {
  const A = "safe-fallback";

  await recorder.check(A, "native-compaction-reasons-stay-native", "uncertainty-promotion", async () => {
    for (const reason of ["manual", "threshold", "overflow"]) {
      const harness = createHarness();
      const session = fakeTree(preRunBranch("e"));
      const ctx = harness.baseContext(session);
      await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
      const result = await harness.emit(
        "session_before_compact",
        beforeCompactEvent(session, { firstKeptEntryId: "e1", reason }),
        ctx,
      );
      assert.equal(result, undefined, `a ${reason} compaction without a candidate stays Pi native`);
      assert.ok(!(result && "cancel" in result), `${reason} compaction is never cancelled`);
    }
  });

  await recorder.check(A, "opaque-memory-never-submits", "uncertainty-promotion", async () => {
    const session = fakeTree([
      ...preRunBranch("o"),
      userEntry("o4", "o3", "ship it"),
      nativeCompaction("oc", "o4", "o4", "a plain native summary"),
    ]);
    const harness = createHarness();
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "opaque" });
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(!harness.activeTools().includes(SUBMIT), "opaque Memory opens no submission handshake");
    const native = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "o4" }),
      ctx,
    );
    assert.equal(native, undefined, "the takeover leaves opaque Memory to Pi native compaction");
  });

  await recorder.check(A, "unsupported-host-exposes-nothing", "uncertainty-promotion", async () => {
    const session = fakeTree([
      ...preRunBranch("g"),
      userEntry("g4", "g3", "ship it"),
      memoryCompaction("gc", "g4", { firstKeptEntryId: "g4", ends: ["g3"], bodies: [`# ${MARKER} gated`] }),
    ]);
    const harness = createHarness({ hostVersion: () => "0.85.0" });
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "unsupported", reason: "host-version" });
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(!harness.activeTools().includes(SUBMIT));
    assert.ok(!harness.activeTools().includes(READ));
    const request = [
      { role: "assistant", content: [
        { type: "text", text: "kept text" },
        { type: "toolCall", id: "call-gated", name: SUBMIT, arguments: { markdown: `# ${MARKER} gated` } },
      ] },
      { role: "toolResult", toolCallId: "call-gated", toolName: SUBMIT, content: [{ type: "text", text: PENDING_ACK }] },
      { role: "user", content: "ship it" },
    ];
    const transformed = await harness.emit("context", { type: "context", messages: request }, ctx);
    assert.equal(transformed, undefined,
      "an unsupported host leaves the provider request untouched — no advisory and no artifact filtering");
    const takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "g4" }),
      ctx,
    );
    assert.equal(takeover, undefined, "an unsupported host never takes over a compaction");
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 0);
    session.append(nativeCompaction("gn", "g4", "g4", "a native summary"));
    await harness.emit("session_compact", {
      type: "session_compact", compactionEntry: session.raw.at(-1), fromExtension: false, reason: "manual", willRetry: false,
    }, ctx);
    assert.deepEqual(harness.notified, [], "an unsupported host emits no diagnostic");
    assert.deepEqual(harness.activeTools(), ["read", "bash"], "every other active tool is preserved");
  });

  await recorder.check(A, "missing-interfaces-unsupported", "uncertainty-promotion", async () => {
    const harness = createHarness();
    const ctx = harness.baseContext(fakeTree([]));
    delete ctx.compact;
    delete ctx.getContextUsage;
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "unsupported", reason: "host-interfaces" });
  });

  await recorder.check(A, "disabled-configuration-inert", "uncertainty-promotion", async () => {
    const harness = createHarness({ config: DISABLED_CONFIG });
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "disabled" });
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(!harness.activeTools().includes(SUBMIT));
    const transformed = await harness.emit("context", { type: "context", messages: [{ role: "user", content: "x" }] }, ctx);
    assert.equal(transformed, undefined, "a disabled configuration installs no context transform");
  });

  await recorder.check(A, "projection-failure-returns-safe-context", "uncertainty-promotion", async () => {
    const harness = createHarness();
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT));
    const result = await harness.emit("context", {
      type: "context",
      messages: [{ role: "assistant", content: [{ type: "text", text: "no user message" }] }],
    }, ctx);
    assert.equal(result, undefined, "a projection failure returns the unmodified context");
    assert.ok(!harness.activeTools().includes(SUBMIT), "submission is deactivated for the run after the failure");
  });

  await recorder.check(A, "maintenance-projection-failure-safe", "uncertainty-promotion", async () => {
    const harness = createHarness();
    const session = fakeTree([
      userEntry("f1", null, `${MARKER} one`),
      assistantEntry("f2", "f1", [{ type: "text", text: `${MARKER} one answer` }]),
      userEntry("f3", "f2", `${MARKER} two`),
      assistantEntry("f4", "f3", [{ type: "text", text: `${MARKER} two answer` }]),
      userEntry("f5", "f4", "ship it"),
      memoryCompaction("fc", "f5", {
        firstKeptEntryId: "f5",
        ends: ["f2", "f4"],
        bodies: [`# ${MARKER} One\n\n- ` + "a".repeat(90), `# ${MARKER} Two\n\n- ` + "b".repeat(8000)],
      }),
    ]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await harness.emit("input", { type: "input", text: "maintain", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT));
    const result = await harness.emit("context", {
      type: "context",
      messages: [
        { role: "compactionSummary", summary: "a foreign native summary" },
        { role: "user", content: "maintain", timestamp: 1 },
      ],
    }, ctx);
    assert.equal(result, undefined, "a maintenance projection failure returns the unmodified context");
    assert.ok(!harness.activeTools().includes(SUBMIT), "submission is deactivated for the run after the failure");
  });

  await recorder.check(A, "transform-never-throws-on-invalid-projections", "negative-constraint", async () => {
    const cyclic = { role: "user", content: "x" };
    cyclic.self = cyclic;
    const battery = [
      [],
      [null],
      [{}],
      [{ role: "user" }],
      [{ role: "assistant", content: null }],
      [{ role: "user", content: "x" }, null],
      [{ role: "toolResult", toolName: SUBMIT, content: [] }],
      Object.freeze([{ role: "user", content: "x" }]),
      [cyclic],
      "not-an-array",
      undefined,
      42,
    ];
    for (const withDueRun of [true, false]) {
      const harness = createHarness();
      const session = fakeTree(preRunBranch("e"));
      const ctx = harness.baseContext(session);
      await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
      if (withDueRun) {
        await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
      }
      for (const messages of battery) {
        const snapshot = Array.isArray(messages) ? [...messages] : null;
        const result = await harness.emit("context", { type: "context", messages }, ctx);
        assert.ok(result === undefined || (result && Array.isArray(result.messages)),
          "the transform returns the safe original context or a valid message list, never a throw");
        if (snapshot !== null) {
          assert.equal(messages.length, snapshot.length, "the input message array is never mutated");
          assert.deepEqual(messages, snapshot);
        }
      }
    }
  });

  await recorder.check(A, "deterministic-estimator-flags-large-branch", "uncertainty-promotion", async () => {
    const entries = [];
    for (let i = 0; i < 40; i++) {
      const parent = entries.at(-1)?.id ?? null;
      entries.push(userEntry(`u${i}`, parent, `${MARKER} task update ${i} `.repeat(64)));
      entries.push(assistantEntry(`a${i}`, `u${i}`, [{ type: "text", text: `${MARKER} acknowledged ${i} `.repeat(64) }]));
    }
    const harness = createHarness({ usage: { tokens: null, contextWindow: WINDOW } });
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, harness.baseContext(fakeTree(entries)));
    assert.deepEqual(harness.registration.snapshot(), { state: "due" },
      "absent numeric usage falls back to the deterministic estimate, which flags the large branch");
  });
}

// ─── Area 7: transaction failures ──────────────────────────────────

export async function areaTransactionFailures(recorder) {
  const A = "transaction-failures";
  const FRESH = `# ${MARKER} fresh\n\n- a fresh candidate`;

  await recorder.check(A, "sibling-refusal-leaves-no-residue", "negative-constraint", async () => {
    const harness = createHarness();
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    pushDueRun(session, { request: "e4", assistant: "e5", result: "e6", callId: "call-sib", body: BLOCK_FIRST, requestText: "ship it" });
    await harness.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-sib", name: SUBMIT, arguments: { markdown: BLOCK_FIRST } },
          { type: "toolCall", id: "call-next-to", name: "read", arguments: { path: "x" } },
        ],
      },
    }, ctx);
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-sib", { markdown: BLOCK_FIRST }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^SUBMIT_NOT_SOLE_TOOL: /); return true; },
    );
    await harness.emit("message_end", soleSubmitBatch("call-sib", BLOCK_FIRST), ctx);
    const accepted = await harness.tools.get(SUBMIT).execute("call-sib", { markdown: BLOCK_FIRST }, undefined, undefined, ctx);
    assert.equal(accepted.content[0].text, PENDING_ACK, "a refused batch leaves the slot clean for a sole retry");
    assert.deepEqual(harness.registration.snapshot(), { state: "pending" });
  });

  await recorder.check(A, "unnoted-batch-refused", "negative-constraint", async () => {
    const harness = createHarness();
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    pushDueRun(session, { request: "e4", assistant: "e5", result: "e6", callId: "call-quiet", body: BLOCK_FIRST, requestText: "ship it" });
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-quiet", { markdown: BLOCK_FIRST }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^SUBMIT_NOT_SOLE_TOOL: /); return true; },
      "a batch the controller never observed is not sole",
    );
  });

  await recorder.check(A, "duplicate-while-pending", "negative-constraint", async () => {
    const { harness, ctx } = await openAcceptedRun();
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-x", { markdown: FRESH }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^COMPACTION_BUSY: /); return true; },
    );
    assert.deepEqual(harness.registration.snapshot(), { state: "pending" });
  });

  await recorder.check(A, "invalid-bodies-store-nothing", "negative-constraint", async () => {
    const harness = createHarness();
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    pushDueRun(session, { request: "e4", assistant: "e5", result: "e6", callId: "call-b", body: "x", requestText: "ship it" });
    await harness.emit("message_end", soleSubmitBatch("call-b", "x"), ctx);
    for (const body of ["", "\u0000 nul", "bad\u0002control", "y".repeat(16 * 1024 + 1)]) {
      await assert.rejects(
        () => harness.tools.get(SUBMIT).execute("call-b", { markdown: body }, undefined, undefined, ctx),
        (error) => {
          assert.match(error.message, /^BOUND_EXCEEDED: /);
          return true;
        },
      );
    }
    assert.notDeepEqual(harness.registration.snapshot(), { state: "pending" }, "the refused bodies store no candidate");
  });

  await recorder.check(A, "over-budget-rendering-rejected", "negative-constraint", async () => {
    // window 200000 · threshold 5000 · budget 2% = 4000 tokens: the existing
    // block renders below half so the append run opens, but a 15 900-character
    // body pushes the complete rendering past the total budget.
    const harness = createHarness({
      config: { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 2 },
    });
    const session = fakeTree([
      userEntry("b1", null, `${MARKER} long task`),
      assistantEntry("b2", "b1", [{ type: "text", text: `${MARKER} answer` }]),
      userEntry("b3", "b2", "ship it"),
      memoryCompaction("bc", "b3", { firstKeptEntryId: "b3", ends: ["b2"], bodies: ["e".repeat(100)] }),
    ]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT), "the append run opens below half budget");
    pushDueRun(session, { request: "b4", assistant: "b5", result: "b6", callId: "call-budget", body: "n".repeat(15_900), requestText: "ship it" });
    await harness.emit("message_end", soleSubmitBatch("call-budget", "n".repeat(15_900)), ctx);
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-budget", { markdown: "n".repeat(15_900) }, undefined, undefined, ctx),
      (error) => {
        assert.match(error.message, /^BOUND_EXCEEDED: /);
        assert.ok(!error.message.includes("nnnn"), "the failure never echoes the Memory body");
        return true;
      },
    );
    assert.equal(harness.registration.snapshot().state, "active", "the rejected append leaves committed Memory intact");
  });

  await recorder.check(A, "branch-mismatch-clears-slot", "uncertainty-promotion", async () => {
    const { harness, session, ctx } = await openAcceptedRun();
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1);
    session.removeById("r1");
    const cleared = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.equal(cleared, undefined, "a mismatched snapshot returns no custom compaction");
    assert.equal(cleared && cleared.cancel, undefined, "a mismatch never cancels");
    assert.notDeepEqual(harness.registration.snapshot(), { state: "committing" }, "the slot is cleared after the mismatch");
  });

  await recorder.check(A, "memory-changed-under-rebuild-run", "uncertainty-promotion", async () => {
    const harness = createHarness();
    const session = fakeTree([
      userEntry("x1", null, `${MARKER} one`),
      assistantEntry("x2", "x1", [{ type: "text", text: `${MARKER} one answer` }]),
      userEntry("x3", "x2", `${MARKER} two`),
      assistantEntry("x4", "x3", [{ type: "text", text: `${MARKER} two answer` }]),
      userEntry("x5", "x4", "ship it"),
      memoryCompaction("xc", "x5", {
        firstKeptEntryId: "x5",
        ends: ["x2", "x4"],
        bodies: [`# ${MARKER} One\n\n- ` + "a".repeat(90), `# ${MARKER} Two\n\n- ` + "b".repeat(8000)],
      }),
    ]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await harness.emit("input", { type: "input", text: "maintain", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT));
    session.replaceById("xc", memoryCompaction("xc", "x5", {
      firstKeptEntryId: "x5",
      ends: ["x2", "x4"],
      bodies: [`# ${MARKER} One\n\n- ` + "a".repeat(90), `# ${MARKER} Two edited\n\n- ` + "b".repeat(8000)],
    }));
    pushDueRun(session, { request: "x6", assistant: "x7", result: "x8", callId: "call-changed", body: FRESH, requestText: "maintain" });
    await harness.emit("message_end", soleSubmitBatch("call-changed", FRESH), ctx);
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-changed", { markdown: FRESH }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^MEMORY_CHANGED: /); return true; },
      "a rewritten carrying compaction refuses the frozen selection",
    );
    assert.notDeepEqual(harness.registration.snapshot(), { state: "pending" });
  });

  await recorder.check(A, "no-eligible-source-refused", "uncertainty-promotion", async () => {
    const harness = createHarness();
    const session = fakeTree([]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    pushDueRun(session, { request: "r1", assistant: "r2", result: "r3", callId: "call-empty", body: FRESH, requestText: "ship it" });
    await harness.emit("message_end", soleSubmitBatch("call-empty", FRESH), ctx);
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-empty", { markdown: FRESH }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^SUBMIT_NOT_DUE: /); return true; },
      "a run with no eligible preceding conversation is not a compression run",
    );
  });

  await recorder.check(A, "aborted-run-discards-candidate", "negative-constraint", async () => {
    const { harness, ctx } = await openAcceptedRun();
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "…" }], stopReason: "aborted" }],
    }, ctx);
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 0, "an aborted run never compacts its discarded candidate");
    assert.notDeepEqual(harness.registration.snapshot(), { state: "pending" });
  });

  await recorder.check(A, "busy-settle-never-compacts", "negative-constraint", async () => {
    const nonIdle = await openAcceptedRun({ isIdle: false });
    await nonIdle.harness.emit("agent_settled", { type: "agent_settled" }, nonIdle.ctx);
    assert.equal(nonIdle.harness.compactCalls.length, 0, "a non-idle settle never compacts");
    assert.deepEqual(nonIdle.harness.registration.snapshot(), { state: "pending" }, "the candidate survives a busy settle");

    const queued = await openAcceptedRun();
    const queuedCtx = queued.harness.baseContext(queued.session, { hasPendingMessages: () => true });
    await queued.harness.emit("agent_settled", { type: "agent_settled" }, queuedCtx);
    assert.equal(queued.harness.compactCalls.length, 0, "a settle with queued messages never compacts");
    assert.deepEqual(queued.harness.registration.snapshot(), { state: "pending" });
  });

  await recorder.check(A, "tree-and-model-invalidation-close-handshake", "negative-constraint", async () => {
    const harness = createHarness();
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT));
    await harness.emit("session_tree", { type: "session_tree", newLeafId: "e1", oldLeafId: "e3" }, ctx);
    assert.ok(!harness.activeTools().includes(SUBMIT), "tree navigation closes the due run");
    await harness.emit("input", { type: "input", text: "again", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT));
    await harness.emit("model_select", { type: "model_select", model: {}, previousModel: undefined, source: "set" }, ctx);
    assert.ok(!harness.activeTools().includes(SUBMIT), "a model change invalidates the handshake and recomputes the budget");
  });

  await recorder.check(A, "stalled-compaction-survives-to-run-boundary", "uncertainty-promotion", async () => {
    const { harness, session, ctx } = await openAcceptedRun();
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1, "settle still offers the candidate to Pi's seam once");
    assert.deepEqual(harness.registration.snapshot(), { state: "pending" },
      "a compaction Pi never started leaves the slot reporting pending");
    assert.deepEqual(harness.notified, [], "a refused compaction is not a conflict");
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-x", { markdown: FRESH }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^SUBMIT_NOT_DUE: /); return true; },
      "the settled run refuses any further submission while the slot survives",
    );
    await harness.emit("input", { type: "input", text: "next task", source: "interactive" }, ctx);
    assert.notDeepEqual(harness.registration.snapshot(), { state: "pending" }, "the next run boundary clears the stalled candidate");
    pushDueRun(session, { request: "r7", assistant: "r8", result: "r9", callId: "call-fresh", body: FRESH, requestText: "next task" });
    await harness.emit("message_end", soleSubmitBatch("call-fresh", FRESH), ctx);
    const recovered = await harness.tools.get(SUBMIT).execute("call-fresh", { markdown: FRESH }, undefined, undefined, ctx);
    assert.equal(recovered.content[0].text, PENDING_ACK, "the fresh run accepts a new candidate after the boundary");
  });

  await recorder.check(A, "lost-save-keeps-committing-to-boundary", "uncertainty-promotion", async () => {
    const { harness, session, ctx } = await openAcceptedRun();
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    const takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.ok(takeover?.compaction);
    assert.deepEqual(harness.registration.snapshot(), { state: "committing" },
      "a takeover whose save never landed keeps the committing phase visible");
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-x", { markdown: FRESH }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^SUBMIT_NOT_DUE: /); return true; },
    );
    await harness.emit("input", { type: "input", text: "next task", source: "interactive" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "due" }, "the next run boundary clears the committing slot");
    pushDueRun(session, { request: "r7", assistant: "r8", result: "r9", callId: "call-fresh2", body: FRESH, requestText: "next task" });
    await harness.emit("message_end", soleSubmitBatch("call-fresh2", FRESH), ctx);
    const recovered = await harness.tools.get(SUBMIT).execute("call-fresh2", { markdown: FRESH }, undefined, undefined, ctx);
    assert.equal(recovered.content[0].text, PENDING_ACK);
  });

  await recorder.check(A, "committing-slot-never-rewritten", "uncertainty-promotion", async () => {
    const { harness, session, ctx } = await openAcceptedRun();
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    const consumed = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.ok(consumed?.compaction);
    const retry = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.equal(retry, undefined, "a committing slot never returns a second takeover");
    assert.equal(retry?.cancel, undefined);
    session.append(nativeCompaction("c-retry", "r3", "r1", "native summary after the failed save"));
    await harness.emit("session_compact", {
      type: "session_compact", compactionEntry: session.raw.at(-1), fromExtension: false, reason: "manual", willRetry: false,
    }, ctx);
    assert.equal(harness.notified.length, 1, "one bounded conflict diagnostic");
    assert.match(harness.notified[0].text, /^COMPACTION_CONFLICT: /);
    assert.equal(harness.notified[0].level, "warning");
    assert.deepEqual(harness.registration.snapshot(), { state: "opaque" }, "the discarded candidate never claims commit");
    const after = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.equal(after, undefined, "the cleared slot never produces another takeover");
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1, "the discarded candidate is never re-offered");
  });

  await recorder.check(A, "post-run-auto-compaction-consumes-before-settle", "exact-detail-corruption", async () => {
    for (const reason of ["threshold", "overflow"]) {
      const { harness, session, ctx } = await openAcceptedRun();
      const takeover = await harness.emit(
        "session_before_compact",
        beforeCompactEvent(session, { firstKeptEntryId: "r1", reason }),
        ctx,
      );
      assert.ok(takeover?.compaction, `a ${reason} compaction consumes the matching candidate`);
      assert.equal(takeover.cancel, undefined, `the ${reason} takeover never cancels`);
      assert.equal(harness.compactCalls.length, 0, "the candidate was consumed without a settle-triggered request");
      await commitTakeover(harness, session, ctx, takeover, { reason });
      const snapshot = harness.registration.snapshot({ tokens: 900, contextWindow: WINDOW });
      assert.equal(snapshot.state, "active", `the ${reason} takeover confirms exactly`);
      assert.equal(snapshot.blocks, 1);
    }
  });

  await recorder.check(A, "competing-extension-entry-is-one-conflict", "negative-constraint", async () => {
    const { harness, session, ctx } = await openAcceptedRun();
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    const consumed = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.ok(consumed?.compaction);
    session.append({
      id: "c-other", parentId: "r3", type: "compaction", timestamp: "2026-01-01T00:00:00.000Z",
      summary: "another extension's compaction summary", firstKeptEntryId: "r1", tokensBefore: 4321, fromExtension: true,
    });
    await harness.emit("session_compact", {
      type: "session_compact", compactionEntry: session.raw.at(-1), fromExtension: true, reason: "manual", willRetry: false,
    }, ctx);
    assert.equal(harness.notified.length, 1, "one bounded conflict diagnostic");
    assert.match(harness.notified[0].text, /^COMPACTION_CONFLICT: /);
    assert.equal(harness.notified[0].level, "warning");
    assert.ok(!harness.notified[0].text.includes(MARKER), "the diagnostic never echoes the Memory body");
    assert.deepEqual(harness.registration.snapshot(), { state: "opaque" }, "the competing entry stays ordinary opaque Pi context");
    const after = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "r1" }),
      ctx,
    );
    assert.equal(after, undefined, "the discarded candidate is never rewritten");
    await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(harness.compactCalls.length, 1, "the discarded candidate is never re-offered");
  });

  await recorder.check(A, "shutdown-and-replacement-clear-transients", "negative-constraint", async () => {
    const { harness, ctx } = await openAcceptedRun();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    assert.deepEqual(harness.registration.snapshot(), { state: "disabled" }, "shutdown drops the session-scoped controller");
    const replacement = fakeTree([]);
    await harness.emit("session_start", { type: "session_start", reason: "new" }, harness.baseContext(replacement));
    assert.deepEqual(harness.registration.snapshot(), { state: "due" },
      "a replaced session never inherits the pending candidate");
    await harness.emit("agent_settled", { type: "agent_settled" }, harness.baseContext(replacement));
    assert.equal(harness.compactCalls.length, 0, "a replaced session never compacts the discarded candidate");
  });
}

// ─── Area 8: exact prefix snapshots ────────────────────────────────

export async function areaExactPrefix(recorder, artifacts) {
  const A = "exact-prefix";

  await recorder.check(A, "format-literals-pinned", "fabrication", async () => {
    const { EXPECTED_WRAPPER } = await import("./fixtures.mjs");
    assert.equal(format.MEMORY_FORMAT_TAG, "pi-square.context-memory/1");
    assert.equal(format.MEMORY_BLOCK_SEPARATOR, "\n---\n\n");
    assert.equal(format.MEMORY_SUMMARY_WRAPPER, EXPECTED_WRAPPER, "the wrapper literal is exactly the pinned format");
    assert.equal(format.composeMemorySummary([]), EXPECTED_WRAPPER);
    assert.equal(transcript.MEMORY_SOURCE_PAGE_MAX_BYTES, 16 * 1024);
    assert.equal(format.MEMORY_BLOCK_MAX_BYTES, 16 * 1024);
    assert.equal(format.MEMORY_DETAILS_MAX_BYTES, 64 * 1024);
  });

  await recorder.check(A, "compose-is-deterministic-and-parses-back", "exact-detail-corruption", async () => {
    const bodies = [
      `# ${MARKER} 中文记忆\n\n— émigré naïve —\n\n漢字とひらがな`,
      `before${format.MEMORY_BLOCK_SEPARATOR}inside user markdown`,
      `del character is legal in a body:\u007f`,
      "x".repeat(1_000),
    ];
    const first = format.composeMemorySummary(bodies);
    assert.equal(format.composeMemorySummary(bodies), first, "repeated rendering of the same list is byte-identical");
    const directory = {
      format: format.MEMORY_FORMAT_TAG,
      blocks: bodies.map((body, index) => ({ endEntryId: `p${index}`, markdownBytes: Buffer.byteLength(body, "utf8") })),
    };
    assert.deepEqual(format.parseMemorySummary(first, directory), bodies,
      "byte-directory parsing recovers every body exactly");
  });

  await recorder.check(A, "provider-prefix-append-diverges-at-separator", "exact-detail-corruption", async () => {
    const one = `# ${MARKER} one\n\n- first`;
    const two = `# ${MARKER} two\n\n- second`;
    const tree = fakeTree([
      userEntry("f1", null, `${MARKER} first task`),
      assistantEntry("f2", "f1", [{ type: "text", text: `${MARKER} first answer` }]),
      userEntry("f3", "f2", "ship it"),
      memoryCompaction("fc1", "f3", { firstKeptEntryId: "f3", ends: ["f2"], bodies: [one] }),
    ]);
    const before = JSON.stringify(projectedMessages(tree));
    assert.equal(JSON.stringify(projectedMessages(tree)), before, "repeated rendering of one Memory state is byte-identical");
    tree.append(userEntry("f4", "fc1", `${MARKER} tail request`));
    tree.append(assistantEntry("f5", "f4", [{ type: "text", text: `${MARKER} tail answer` }]));
    tree.append(memoryCompaction("fc2", "f5", { firstKeptEntryId: "f5", ends: ["f2", "f4"], bodies: [one, two] }));
    const after = projectedMessages(tree);
    assert.equal(JSON.stringify(projectedMessages(tree)), JSON.stringify(after), "repeated rendering after the append is byte-identical");
    assert.equal(after[0].role, "compactionSummary");
    assert.equal(after[0].summary, JSON.parse(before)[0].summary + format.MEMORY_BLOCK_SEPARATOR + two,
      "append-only divergence begins exactly after the old block prefix");
    const directoryOne = format.parseMemoryDetails({
      format: format.MEMORY_FORMAT_TAG,
      blocks: [{ endEntryId: "f2", markdownBytes: Buffer.byteLength(one, "utf8") }],
    });
    const directoryTwo = format.parseMemoryDetails({
      format: format.MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: "f2", markdownBytes: Buffer.byteLength(one, "utf8") },
        { endEntryId: "f4", markdownBytes: Buffer.byteLength(two, "utf8") },
      ],
    });
    assert.deepEqual(directoryTwo.blocks.slice(0, 1), directoryOne.blocks, "existing directory entries stay byte-identical");
  });

  await recorder.check(A, "provider-prefix-rebuild-diverges-at-first-rebuilt", "exact-detail-corruption", async () => {
    const alpha = `# ${MARKER} Alpha\n\n- ` + "a".repeat(90);
    const beta = `# ${MARKER} Beta\n\n- ` + "b".repeat(7400);
    const rebuilt = `# ${MARKER} Rebuilt\n\n- the suffix collapsed`;
    const tree = fakeTree([
      userEntry("g1", null, `${MARKER} alpha task`),
      assistantEntry("g2", "g1", [{ type: "text", text: `${MARKER} alpha answer` }]),
      userEntry("g3", "g2", `${MARKER} beta task`),
      assistantEntry("g4", "g3", [{ type: "text", text: `${MARKER} beta answer` }]),
      userEntry("g5", "g4", "ship it"),
      memoryCompaction("gc1", "g5", { firstKeptEntryId: "g5", ends: ["g2", "g4"], bodies: [alpha, beta] }),
      userEntry("g6", "gc1", `${MARKER} tail request`),
      assistantEntry("g7", "g6", [{ type: "text", text: `${MARKER} tail answer` }]),
      memoryCompaction("gc2", "g7", { firstKeptEntryId: "g7", ends: ["g2", "g7"], bodies: [alpha, rebuilt] }),
    ]);
    const projected = projectedMessages(tree);
    assert.equal(JSON.stringify(projectedMessages(tree)), JSON.stringify(projected), "repeated rendering after the rebuild is byte-identical");
    assert.equal(projected[0].role, "compactionSummary");
    assert.ok(projected[0].summary.startsWith(format.composeMemorySummary([alpha])),
      "the unselected older block renders byte-identically");
    assert.equal(projected[0].summary, format.composeMemorySummary([alpha]) + format.MEMORY_BLOCK_SEPARATOR + rebuilt,
      "divergence begins exactly at the first rebuilt block");
    assert.ok(!projected[0].summary.startsWith(format.composeMemorySummary([alpha, beta])),
      "the replaced suffix never survives into the new rendering");
  });

  await recorder.check(A, "advisory-texts-fixed-and-distinct", "fabrication", async () => {
    const { first, append, maintenance } = artifacts.advisories;
    assert.ok(typeof first === "string" && first.length > 0, "the first-block advisory was captured");
    assert.ok(typeof append === "string" && append.length > 0, "the append advisory was captured");
    assert.ok(typeof maintenance === "string" && maintenance.length > 0, "the maintenance advisory was captured");
    const texts = [first, append, maintenance];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        assert.notEqual(texts[i], texts[j], "each operation carries its own fixed advisory");
      }
    }
    for (const text of texts) {
      assert.ok(text.includes(SUBMIT), "the advisory names the submission tool");
      assert.ok(text.includes("sole tool call of its batch"), "the sole-call requirement stays (#253)");
      assert.ok(text.includes("Complete the user's current task first"), "the task-first requirement stays (#253)");
      assert.ok(text.includes("continue the same run"), "the run continues after the submission (#253)");
      assert.ok(!text.includes("finish the run"), "no advisory ends the run with the submission (#253)");
      assert.ok(text.includes("Do not copy credential values"), "the secret warning stays");
      assert.ok(!text.includes(MARKER), "advisories are package-owned text with no fixture content");
      assert.ok(!text.includes("e4") && !text.includes("u1") && !text.includes("m10"), "no entry ids leak into advisories");
    }
    // Determinism: an identical first-block run delivers the identical text.
    const harness = createHarness();
    const session = fakeTree(preRunBranch("e"));
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    const transformed = await harness.emit("context", {
      type: "context",
      messages: [{ role: "user", content: "ship it", timestamp: 1 }],
    }, ctx);
    assert.equal(transformed.messages.at(-1).content, first, "the advisory text is deterministic across runs");
  });

  await recorder.check(A, "tool-schemas-pinned", "fabrication", async () => {
    const harness = createHarness();
    const submit = harness.tools.get(SUBMIT);
    assert.equal(submit.parameters.type, "object");
    assert.equal(submit.parameters.additionalProperties, false);
    assert.equal(submit.parameters.anyOf ?? submit.parameters.oneOf, undefined, "no top-level union");
    assert.deepEqual(submit.parameters.required, ["markdown"]);
    assert.deepEqual(Object.keys(submit.parameters.properties), ["markdown"]);
    assert.deepEqual(submit.parameters.properties.markdown, {
      type: "string",
      description: submit.parameters.properties.markdown.description,
      minLength: 1,
      maxLength: 16 * 1024,
    }, "the markdown bound is exactly the block byte cap");
    assert.equal(submit.executionMode, "sequential");
    assert.equal(typeof submit.parameters.description, "string");
    assert.ok(submit.parameters.description.length > 0);
    assert.equal(typeof submit.description, "string");

    const read = harness.tools.get(READ);
    assert.equal(read.parameters.type, "object");
    assert.equal(read.parameters.additionalProperties, false);
    assert.equal(read.parameters.anyOf ?? read.parameters.oneOf, undefined);
    assert.deepEqual(read.parameters.required, ["block", "page"]);
    assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["block", "page"]);
    assert.equal(read.parameters.properties.block.type, "integer");
    assert.equal(read.parameters.properties.block.minimum, 1);
    assert.equal(read.parameters.properties.page.type, "integer");
    assert.equal(read.parameters.properties.page.minimum, 1);
    assert.equal(typeof read.description, "string");
  });
}
