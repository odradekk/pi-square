import assert from "node:assert/strict";
import {
  MARKER,
  WINDOW,
  createHarness,
  fakeTree,
  soleSubmitBatch,
  pushDueRun,
  beforeCompactEvent,
  userEntry,
  memoryCompaction,
  format,
} from "./harness.mjs";
import {
  malformedCompactionPatches,
  patchedMemoryBranch,
  detailsCapFixture,
} from "./fixtures.mjs";

/**
 * The boundary-fixture sweep (#223): malformed wrapper/directory/length
 * fixtures degrade to opaque with no repair, the maximum block and details
 * sizes parse and reject exactly at their bounds, and multibyte Markdown is
 * counted in canonical UTF-8 bytes by the submission transaction. Control
 * characters, multibyte paging, image/binary placeholders, and sources too
 * large for maintenance are boundary fixtures exercised inside the
 * source-paging and suffix-rebuild areas.
 */

const SUBMIT = "submit_memory";
const READ = "read_memory_source";

export async function areaBoundaryFixtures(recorder) {
  const A = "boundary-fixtures";

  for (const [label, patch] of malformedCompactionPatches()) {
    await recorder.check(A, `malformed:${label}`, "uncertainty-promotion", async () => {
      const harness = createHarness();
      const session = fakeTree(patchedMemoryBranch(patch));
      const ctx = harness.baseContext(session);
      await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
      assert.deepEqual(
        harness.registration.snapshot(),
        { state: "opaque" },
        `${label} degrades the compaction to opaque without repair or fallback`,
      );
      assert.ok(!harness.activeTools().includes(READ), `${label} leaves the structured tools off`);
    });
  }

  await recorder.check(A, "details-at-cap-parses", "fabrication", async () => {
    const fixture = detailsCapFixture();
    const harness = createHarness({
      config: { enabled: true, compressionThreshold: { percent: 80 }, memoryBudgetPercent: 25 },
      usage: { tokens: 170_000, contextWindow: WINDOW },
    });
    const ctx = harness.baseContext(fakeTree(fixture.entries));
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const snapshot = harness.registration.snapshot({ tokens: 170_000, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.blocks, fixture.blocks, "the largest directory inside the 64 KiB cap derives completely");
    assert.ok(harness.activeTools().includes(READ));
  });

  await recorder.check(A, "details-over-cap-opaque", "uncertainty-promotion", async () => {
    const fabricated = Array.from({ length: 64 }, (_, index) => ({
      endEntryId: `fabricated-${index}-${"p".repeat(1_200)}`,
      markdownBytes: 1,
    }));
    assert.ok(
      Buffer.byteLength(JSON.stringify({ format: format.MEMORY_FORMAT_TAG, blocks: fabricated }), "utf8") > 64 * 1024,
      "the fixture really exceeds the serialization cap",
    );
    const harness = createHarness();
    const session = fakeTree(patchedMemoryBranch((base) => ({
      ...base,
      details: { format: format.MEMORY_FORMAT_TAG, blocks: fabricated },
    })));
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, harness.baseContext(session));
    assert.deepEqual(harness.registration.snapshot(), { state: "opaque" },
      "an over-cap details serialization is rejected, never truncated");
  });

  await recorder.check(A, "append-crossing-details-cap-rejected", "negative-constraint", async () => {
    const fixture = detailsCapFixture();
    const harness = createHarness({
      config: { enabled: true, compressionThreshold: { percent: 80 }, memoryBudgetPercent: 25 },
      usage: { tokens: 170_000, contextWindow: WINDOW },
    });
    const session = fakeTree(fixture.entries);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const active = harness.registration.snapshot({ tokens: 170_000, contextWindow: WINDOW });
    assert.equal(active.blocks, fixture.blocks, "the fixture Memory stays strictly inside every bound");
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    assert.ok(harness.activeTools().includes(SUBMIT), "the tiny blocks still sit below half budget so the append run opens");
    pushDueRun(session, {
      request: "cap-req", assistant: "cap-a", result: "cap-r", callId: "call-cap",
      body: "y", requestText: "ship it",
    });
    await harness.emit("message_end", soleSubmitBatch("call-cap", "y"), ctx);
    await assert.rejects(
      () => harness.tools.get(SUBMIT).execute("call-cap", { markdown: "y" }, undefined, undefined, ctx),
      (error) => { assert.match(error.message, /^BOUND_EXCEEDED: /); return true; },
      "one more ordered item crosses the serialization cap",
    );
    assert.equal(
      harness.registration.snapshot({ tokens: 170_000, contextWindow: WINDOW }).blocks,
      fixture.blocks,
      "the over-cap append stores no candidate; no block is evicted to make it fit",
    );
  });

  await recorder.check(A, "maximum-block-commits-exactly", "exact-detail-corruption", async () => {
    // "漢" is 3 UTF-8 bytes: 5461 code points plus one ASCII byte is exactly 16 KiB.
    const exactlyMax = "漢".repeat(5_461) + "x";
    assert.equal(Buffer.byteLength(exactlyMax, "utf8"), 16 * 1024);
    const harness = createHarness();
    const session = fakeTree([
      userEntry("w1", null, `${MARKER} walk me through`),
      userEntry("w2", "w1", "ship it"),
      memoryCompaction("wc", "w2", { firstKeptEntryId: "w2", ends: ["w1"], bodies: [exactlyMax] }),
    ]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const snapshot = harness.registration.snapshot({ tokens: 1_000, contextWindow: WINDOW });
    assert.equal(snapshot.state, "active", "a maximum-size block parses and derives");
    assert.equal(snapshot.blocks, 1);
    const inspected = harness.registration.inspect({ block: 1, page: 1 }, session);
    assert.equal(inspected.ok, true);
    assert.ok(inspected.text.includes(exactlyMax), "the maximum body recovers byte-exact");
  });

  await recorder.check(A, "maximum-block-submit-boundary", "negative-constraint", async () => {
    // window 200000 · threshold 25000 · budget 10% = 20000 tokens: a 16 KiB
    // body renders well inside the total budget, so exactly-max is accepted.
    const config = { enabled: true, compressionThreshold: { tokens: 25_000 }, memoryBudgetPercent: 10 };
    const exactlyMax = "漢".repeat(5_461) + "x";
    const harness = createHarness({ config, usage: { tokens: 30_000, contextWindow: WINDOW } });
    const session = fakeTree([
      userEntry("v1", null, `${MARKER} one task`),
      userEntry("v2", "v1", "ship it"),
    ]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    pushDueRun(session, {
      request: "v3", assistant: "v4", result: "v5", callId: "call-max",
      body: exactlyMax, requestText: "ship it",
    });
    await harness.emit("message_end", soleSubmitBatch("call-max", exactlyMax), ctx);
    const accepted = await harness.tools.get(SUBMIT).execute("call-max", { markdown: exactlyMax }, undefined, undefined, ctx);
    assert.equal(accepted.content[0].text, "Memory candidate accepted; compaction pending.");
    const takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "v3" }),
      ctx,
    );
    assert.ok(takeover?.compaction, "the maximum-size candidate is consumed");
    assert.equal(takeover.compaction.details.blocks[0].markdownBytes, 16 * 1024,
      "the directory records the exact canonical UTF-8 byte count");

    const overMax = "漢".repeat(5_461) + "xx";
    const overHarness = createHarness({ config, usage: { tokens: 30_000, contextWindow: WINDOW } });
    const overSession = fakeTree([
      userEntry("o1", null, `${MARKER} one task`),
      userEntry("o2", "o1", "ship it"),
    ]);
    const overCtx = overHarness.baseContext(overSession);
    await overHarness.emit("session_start", { type: "session_start", reason: "startup" }, overCtx);
    await overHarness.emit("input", { type: "input", text: "ship it", source: "interactive" }, overCtx);
    pushDueRun(overSession, {
      request: "o3", assistant: "o4", result: "o5", callId: "call-over",
      body: overMax, requestText: "ship it",
    });
    await overHarness.emit("message_end", soleSubmitBatch("call-over", overMax), overCtx);
    await assert.rejects(
      () => overHarness.tools.get(SUBMIT).execute("call-over", { markdown: overMax }, undefined, undefined, overCtx),
      (error) => { assert.match(error.message, /^BOUND_EXCEEDED: /); return true; },
      "one byte over the block bound is rejected",
    );
  });

  await recorder.check(A, "multibyte-counted-in-utf8-bytes", "exact-detail-corruption", async () => {
    const body = `# ${MARKER} 漢字テスト\n\n- 多バイトの境界`;
    assert.ok(Buffer.byteLength(body, "utf8") > body.length, "the fixture is genuinely multibyte");
    const harness = createHarness();
    const session = fakeTree([
      userEntry("k1", null, `${MARKER} one task`),
      userEntry("k2", "k1", "ship it"),
    ]);
    const ctx = harness.baseContext(session);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await harness.emit("input", { type: "input", text: "ship it", source: "interactive" }, ctx);
    pushDueRun(session, {
      request: "k3", assistant: "k4", result: "k5", callId: "call-mb",
      body, requestText: "ship it",
    });
    await harness.emit("message_end", soleSubmitBatch("call-mb", body), ctx);
    await harness.tools.get(SUBMIT).execute("call-mb", { markdown: body }, undefined, undefined, ctx);
    const takeover = await harness.emit(
      "session_before_compact",
      beforeCompactEvent(session, { firstKeptEntryId: "k3" }),
      ctx,
    );
    assert.ok(takeover?.compaction);
    assert.equal(
      takeover.compaction.details.blocks[0].markdownBytes,
      Buffer.byteLength(body, "utf8"),
      "the directory counts canonical UTF-8 bytes, not code points",
    );
  });
}
