import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const transcriptModule = await load(join(packageRoot, "src", "subagents", "transcript.ts"));
const { createChildTranscript } = transcriptModule;
const { assistantContentKey } = await load(join(packageRoot, "src", "subagents", "child-history.ts"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/**
 * Scriptable persisted-history surface. Pages stage invisibly and reveal in
 * order on loadNewer, so a test models the session file growing between two
 * moments: the live event arrives first and the persisted record only appends
 * later (live-then-persisted), or the record is already loaded before the
 * event (persisted-before-live).
 */
function scriptedHistory({ initial = [], moreBefore = false } = {}) {
  let items = [...initial];
  let pending = [];
  let olderPending = [];
  let fixedMoreBefore = moreBefore === true;
  return {
    view: {
      snapshot: () => ({
        items: [...items],
        moreBefore: fixedMoreBefore || olderPending.length > 0,
        moreAfter: pending.length > 0,
      }),
      loadOlder: () => {
        const page = olderPending.shift();
        if (page === undefined) return false;
        items = [...page, ...items];
        return true;
      },
      loadNewer: () => {
        const page = pending.shift();
        if (page === undefined) return false;
        items = [...items, ...page];
        return true;
      },
      retryInitial: () => false,
    },
    /** Appends one or more persisted pages, like the child writing ahead. */
    stage(...pages) {
      pending.push(...pages);
    },
    /** Stages one or more older pages, like demand paging discovering them. */
    stageOlder(...pages) {
      olderPending.push(...pages);
    },
  };
}

/** One persisted assistant item carrying the occurrence identity reconciliation matches. */
function assistantItem(text, { entryId = "m1", timestamp = 9_000, byteOffset = 120, entryItemIndex = 0 } = {}) {
  return {
    kind: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }], timestamp },
    entryId,
    entryByteOffset: byteOffset,
    entryItemIndex,
  };
}

/** One live completion event for the same occurrence shape. */
function completionEvent(text, { timestamp = 9_000, historyFloor = 120 } = {}) {
  return { kind: "message_completed", content: [{ type: "text", text }], timestamp, historyFloor };
}

const TOOL_KEY = "0a0a0a0a";

function toolCallRow({ entryId = "c1", byteOffset = 64, withResult = true } = {}) {
  return {
    kind: "toolCall",
    name: "Read",
    summary: "notes.txt",
    callKey: TOOL_KEY,
    ...(withResult ? { result: { isError: false } } : {}),
    entryId,
    entryByteOffset: byteOffset,
    entryItemIndex: 1,
  };
}

function toolStartedEvent() {
  return { kind: "tool_started", callKey: TOOL_KEY, name: "Read", summary: "notes.txt", startedAt: 5 };
}

test("live-only: a completion with no persisted record appears once, in the tail alone", () => {
  const transcript = createChildTranscript(scriptedHistory({}).view);
  const changes = [];
  const unsubscribe = transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent(completionEvent("hello"));

  assert.equal(transcript.liveTail().items.length, 1, "one live entry");
  assert.equal(transcript.liveTail().items[0].kind, "message");
  assert.equal(transcript.snapshot().items.length, 0, "no persisted record loaded");
  assert.deepEqual(changes, [{ grew: true, structural: true }], "the module reports visible growth as one structural change");
  unsubscribe();
});

test("persisted-only: a record with no live event appears once, in the persisted window alone", () => {
  const transcript = createChildTranscript(scriptedHistory({ initial: [assistantItem("hello")] }).view);

  assert.equal(transcript.snapshot().items.length, 1);
  assert.equal(transcript.liveTail().items.length, 0, "no live tail entry exists");
});

test("live-then-persisted: the persisted record confirms and the tail sheds the entry", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);
  const changes = [];
  transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent(completionEvent("hello"));
  assert.equal(transcript.liveTail().items.length, 1, "the live entry renders first");
  assert.equal(changes.length, 1, "one module-originated change for the event");

  history.stage([assistantItem("hello")]);
  assert.equal(transcript.loadNewer(), true, "the persisted page arrives");

  assert.equal(transcript.liveTail().items.length, 0, "the persisted record confirms: the tail sheds");
  assert.equal(transcript.snapshot().items.length, 1, "the record renders in the persisted window");
  assert.equal(
    transcript.snapshot().items.length + transcript.liveTail().items.length,
    1,
    "the occurrence is visible exactly once overall",
  );
  assert.equal(changes.length, 1, "the caller-driven page load reports through its return value, not a notification");
});

test("persisted-before-live: the completion confirms immediately against the already-loaded record", () => {
  const transcript = createChildTranscript(scriptedHistory({ initial: [assistantItem("hello")] }).view);
  const changes = [];
  transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent(completionEvent("hello"));

  assert.equal(transcript.liveTail().items.length, 0, "the entry never enters the tail");
  assert.equal(transcript.snapshot().items.length, 1, "the loaded record stays the single visible occurrence");
  assert.equal(changes.length, 1, "one module-originated change for the event");
  assert.equal(changes[0].grew, true, "the pushed-then-confirmed entry still marks visible growth, as before #367");
});

test("live-then-persisted, tools: the persisted call row with its result covers the live row", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);

  transcript.applyLiveEvent(toolStartedEvent());
  assert.equal(transcript.liveTail().items.length, 1, "one live tool row");

  history.stage([toolCallRow()]);
  assert.equal(transcript.loadNewer(), true);
  assert.equal(transcript.liveTail().items.length, 0, "the persisted call row covers the live row");
});

test("persisted-before-live, tools: a started event adds no row when the persisted call row is loaded", () => {
  const transcript = createChildTranscript(scriptedHistory({ initial: [toolCallRow({ withResult: false })] }).view);
  const changes = [];
  transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent(toolStartedEvent());

  assert.equal(transcript.liveTail().items.length, 0, "the persisted running row already shows the call");
  assert.deepEqual(changes, [{ grew: false, structural: true }], "no visible growth: a structural reconciliation only");
});

test("a finished live row sheds only after the persisted call row carries its result", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view, { now: () => 42 });

  transcript.applyLiveEvent(toolStartedEvent());
  transcript.applyLiveEvent({ kind: "tool_finished", callKey: TOOL_KEY, name: "Read", isError: false });
  assert.equal(transcript.liveTail().items.length, 1, "the finished row stays until its result persists");
  assert.equal(transcript.liveTail().items[0].tool.endedAt, 42, "the end state shows immediately");

  history.stage([toolCallRow()]);
  assert.equal(transcript.loadNewer(), true, "the toolResult entry arrives");
  assert.equal(transcript.liveTail().items.length, 0, "the result-bearing call row covers the finished row");
});

test("a dropped-entry fingerprint clears only when persisted history recovers that occurrence", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);

  for (let index = 0; index < 17; index += 1) {
    transcript.applyLiveEvent(completionEvent(`msg-${index}`, { timestamp: 100 + index, historyFloor: 10 + index }));
  }
  assert.equal(transcript.liveTail().items.length, 16, "the live tail stays bounded");
  assert.equal(transcript.liveTail().droppedCount, 1, "the shed oldest entry keeps one fingerprint");

  history.stage([assistantItem("msg-0", { entryId: "e0", timestamp: 100, byteOffset: 10 })]);
  assert.equal(transcript.loadNewer(), true);
  assert.equal(transcript.liveTail().droppedCount, 0, "recovering the persisted occurrence clears the fingerprint");
});

test("an unrelated persisted append recovers nothing and unknown drops stay sticky", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);

  for (let index = 0; index < 17; index += 1) {
    transcript.applyLiveEvent(completionEvent(`msg-${index}`, { timestamp: 100 + index, historyFloor: 10 + index }));
  }
  transcript.applyLiveEvent({ kind: "live_events_dropped", droppedUnknown: true });
  assert.equal(transcript.liveTail().droppedUnknown, true);

  history.stage([assistantItem("unrelated", { entryId: "e9", timestamp: 999, byteOffset: 500 })]);
  assert.equal(transcript.loadNewer(), true);
  assert.equal(transcript.liveTail().droppedCount, 1, "the unrelated record does not recover the shed entry");
  assert.equal(transcript.liveTail().droppedUnknown, true, "unknown drops never clear");
});

test("an event-driven reconcile reports persisted growth through the notification", () => {
  const history = scriptedHistory({});
  history.stage([assistantItem("tail")]);
  const transcript = createChildTranscript(history.view);
  const changes = [];
  transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent({ kind: "run_finished" });

  assert.equal(transcript.snapshot().items.length, 1, "run_finished reconciles up to eight newer pages");
  assert.deepEqual(changes, [{ grew: true, structural: true }], "persisted growth found while reconciling an event is visible growth");
});

test("subscriptions receive every module-originated change and unsubscribe stops delivery", () => {
  const transcript = createChildTranscript(scriptedHistory({}).view);
  const changes = [];
  const unsubscribe = transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent({ kind: "tool_updated", callKey: TOOL_KEY, name: "Read" });
  assert.deepEqual(changes, [], "a no-op tool update notifies nothing");

  transcript.setLiveDiagnostic();
  assert.equal(transcript.liveTail().diagnostic, "live updates paused after a viewer error");
  transcript.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "partial" }] });
  assert.equal(transcript.liveTail().diagnostic, undefined, "the next successful event clears the diagnostic");
  assert.deepEqual(changes, [{ grew: false, structural: false }, { grew: true, structural: false }], "the diagnostic and a streaming delta notify in order, both non-structural");

  unsubscribe();
  transcript.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "more" }] });
  assert.equal(changes.length, 2, "an unsubscribed listener receives nothing");
});

test("a delayed duplicate completion reconciles instead of duplicating a shed occurrence", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);
  const changes = [];
  transcript.subscribe((change) => changes.push(change));

  transcript.applyLiveEvent(completionEvent("hello"));
  assert.equal(transcript.liveTail().items.length, 1);
  history.stage([assistantItem("hello")]);
  assert.equal(transcript.loadNewer(), true);
  assert.equal(transcript.liveTail().items.length, 0);

  changes.length = 0;
  // The same occurrence delivers again with a floor at or below the highest
  // floor already seen: the module reconciles the persisted window instead of
  // re-admitting the entry.
  transcript.applyLiveEvent({ ...completionEvent("hello"), historyFloor: 120 });

  assert.equal(transcript.liveTail().items.length, 0, "no second live entry");
  assert.equal(transcript.snapshot().items.length, 1, "the record still renders exactly once");
  assert.deepEqual(changes, [{ grew: false, structural: true }], "the reconcile found no persisted growth");
});

test("a recoverable dropped fingerprint clears on the next module read even without a new page", () => {
  const item = assistantItem("recovered", { entryId: "e1", timestamp: 500, byteOffset: 64 });
  const transcript = createChildTranscript(scriptedHistory({ initial: [item] }).view);

  transcript.applyLiveEvent({
    kind: "live_events_dropped",
    dropped: [{ kind: "message", key: assistantContentKey(item.message.content), timestamp: 500, historyFloor: 64 }],
  });
  assert.equal(transcript.liveTail().droppedCount, 1, "the marker appears when the feed reports the drop");

  transcript.snapshot();
  assert.equal(
    transcript.liveTail().droppedCount,
    0,
    "a plain read enforces the invariant: no successful loadNewer is needed first",
  );
});

test("reconcileNewer cascades bounded newer pages in one call", () => {
  const history = scriptedHistory({});
  history.stage(
    [assistantItem("one", { entryId: "e1", timestamp: 1, byteOffset: 10 })],
    [assistantItem("two", { entryId: "e2", timestamp: 2, byteOffset: 20 })],
    [assistantItem("three", { entryId: "e3", timestamp: 3, byteOffset: 30 })],
  );
  const transcript = createChildTranscript(history.view);

  assert.equal(transcript.reconcileNewer(2), true, "one call reads up to the requested page count");
  assert.equal(transcript.snapshot().items.length, 2);
  assert.equal(transcript.reconcileNewer(8), true, "the next call continues the cascade");
  assert.equal(transcript.snapshot().items.length, 3);
  assert.equal(transcript.reconcileNewer(1), false, "with nothing newer the cascade stays a quiet false");
});

test("the external catch-up reconcile notifies on a changed window and stays quiet at EOF", () => {
  const history = scriptedHistory({});
  history.stage(
    [assistantItem("one", { entryId: "e1", timestamp: 1, byteOffset: 10 })],
    [assistantItem("two", { entryId: "e2", timestamp: 2, byteOffset: 20 })],
  );
  const transcript = createChildTranscript(history.view);
  const changes = [];
  transcript.subscribe((change) => changes.push(change));

  assert.equal(transcript.reconcileNewer(8), true, "the caller-initiated catch-up loads the newer pages");
  assert.deepEqual(
    changes,
    [{ grew: true, structural: true }],
    "a changed window notifies once: the view bound to this transcript is not the caller and must refresh",
  );

  changes.length = 0;
  assert.equal(transcript.reconcileNewer(8), false, "nothing newer stays a quiet false");
  assert.deepEqual(changes, [], "no change means no notification");
});

test("a dropped terminal tool event recovers only after its own persisted result", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);

  transcript.applyLiveEvent({
    kind: "live_events_dropped",
    dropped: [{ kind: "tool", callKey: TOOL_KEY, name: "Read", terminal: true }],
  });
  assert.equal(transcript.liveTail().droppedCount, 1, "the dropped terminal event keeps one fingerprint");

  history.stage([toolCallRow({ withResult: false })]);
  assert.equal(transcript.loadNewer(), true);
  assert.equal(transcript.liveTail().droppedCount, 1,
    "the persisted call row alone does not recover the dropped terminal state");

  history.stage([toolCallRow({ entryId: "c2", byteOffset: 96 })]);
  assert.equal(transcript.loadNewer(), true);
  assert.equal(transcript.liveTail().droppedCount, 0,
    "the call's own persisted result recovers the terminal state");
});

// ---------------------------------------------------------------------------
// Occurrence identity: one live completion confirms only against its own
// persisted record — the same bounded content, the same native message
// timestamp, and a JSONL line beginning exactly at the completion's captured
// pre-append floor. Persisted rows are consumed one-for-one, so an unrelated
// or older occurrence can never confirm a completion that is not its own.

test("distinct pre-append floors keep identical completions occurrence-exact", () => {
  const history = scriptedHistory({
    initial: [assistantItem("Same words", { entryId: "e2", timestamp: 9_000, byteOffset: 100 })],
  });
  const transcript = createChildTranscript(history.view);

  // A pre-existing identical message carries the same content and timestamp
  // but a different floor: it confirms nothing.
  transcript.applyLiveEvent(completionEvent("Same words", { timestamp: 9_000, historyFloor: 200 }));
  assert.equal(transcript.liveTail().items.length, 1,
    "the pre-existing identical message cannot consume the completion with a different floor");

  // The completion's own record at the exact pre-append floor confirms it.
  history.stage([assistantItem("Same words", { entryId: "e9", timestamp: 9_000, byteOffset: 200 })]);
  transcript.applyLiveEvent({ kind: "tool_result_completed" });
  assert.equal(transcript.liveTail().items.length, 0,
    "only the record beginning exactly at the captured floor confirms the completion");
  assert.equal(transcript.snapshot().items.length, 2);

  // The same wall shape with a different timestamp confirms nothing either.
  const other = scriptedHistory({
    initial: [assistantItem("Same words", { entryId: "old", timestamp: 1_000, byteOffset: 100 })],
  });
  const otherTranscript = createChildTranscript(other.view);
  otherTranscript.applyLiveEvent(completionEvent("Same words", { timestamp: 8_000, historyFloor: 200 }));
  assert.equal(otherTranscript.liveTail().items.length, 1,
    "a pre-existing identical message with a different timestamp stays a separate occurrence");
});

test("a newer completion cannot consume an older occurrence after paging it back in", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);

  // Only the newer completion is live when the older record pages back in.
  transcript.applyLiveEvent(completionEvent("same completion", { timestamp: 9_000, historyFloor: 200 }));
  assert.equal(transcript.liveTail().items.length, 1);

  // The older record enters the window first — after eviction it pages back in
  // the same way. Its floor is not the completion's, so it confirms nothing.
  history.stage([assistantItem("same completion", { entryId: "older", timestamp: 9_000, byteOffset: 100 })]);
  transcript.applyLiveEvent({ kind: "tool_result_completed" });
  assert.equal(transcript.liveTail().items.length, 1,
    "the reloaded old row cannot consume the still-unpersisted newer completion");

  history.stage([assistantItem("same completion", { entryId: "newer", timestamp: 9_000, byteOffset: 200 })]);
  transcript.applyLiveEvent({ kind: "tool_result_completed" });
  assert.equal(transcript.liveTail().items.length, 0, "its own record confirms the newer completion");
  assert.equal(transcript.snapshot().items.length, 2, "both persisted occurrences show, no live duplicate");
});

test("delayed identical completions cannot both consume the newer loaded occurrence", () => {
  // The newer record is already loaded with older history behind it: the
  // delayed identical completions must split by pre-append floor, not by
  // which of them arrived later.
  const history = scriptedHistory({ initial: [
    assistantItem("delayed identical", { entryId: "newer-loaded", timestamp: 9_000, byteOffset: 200 }),
  ], moreBefore: true });
  const transcript = createChildTranscript(history.view);

  transcript.applyLiveEvent(completionEvent("delayed identical", { timestamp: 9_000, historyFloor: 100 }));
  transcript.applyLiveEvent(completionEvent("delayed identical", { timestamp: 9_000, historyFloor: 200 }));
  assert.equal(transcript.liveTail().items.length, 1,
    "the newer row confirms only the completion whose pre-append floor it equals");

  // Demand-paging the older record in confirms the remaining completion.
  history.stageOlder([assistantItem("delayed identical", { entryId: "older", timestamp: 9_000, byteOffset: 100 })]);
  assert.equal(transcript.loadOlder(), true, "the older page loads on demand");
  assert.equal(transcript.liveTail().items.length, 0,
    "the older record confirms the completion whose floor it equals, not the newer one twice");
});

test("page up reconciles a live completion against the older page it loads", () => {
  const recent = { kind: "generic", text: "recent", entryId: "recent", entryByteOffset: 200, entryItemIndex: 0 };
  const history = scriptedHistory({ initial: [recent], moreBefore: true });
  const transcript = createChildTranscript(history.view);

  transcript.applyLiveEvent(completionEvent("paged completion", { timestamp: 9_000, historyFloor: 100 }));
  assert.equal(transcript.liveTail().items.length, 1, "the live row renders before its record is reachable");

  history.stageOlder([assistantItem("paged completion", { entryId: "older-match", timestamp: 9_000, byteOffset: 100 })]);
  assert.equal(transcript.loadOlder(), true, "demand paging loads exactly one older page");
  assert.equal(transcript.liveTail().items.length, 0,
    "the live row confirms the moment its persisted occurrence enters the loaded window");
  assert.deepEqual(
    transcript.snapshot().items.map((item) => item.entryId),
    ["older-match", "recent"],
    "the older page takes its native position ahead of the recent row",
  );
});

test("occurrence matching follows append position, not a wall-clock timestamp", () => {
  const history = scriptedHistory({});
  const transcript = createChildTranscript(history.view);

  transcript.applyLiveEvent(completionEvent("first", { timestamp: 2_000, historyFloor: 100 }));
  history.stage([assistantItem("clock moved backward", { entryId: "second", timestamp: 1_000, byteOffset: 200 })]);
  transcript.applyLiveEvent({ kind: "tool_result_completed" });
  assert.equal(transcript.liveTail().items.length, 1, "the unrelated later occurrence confirms nothing");

  transcript.applyLiveEvent(completionEvent("clock moved backward", { timestamp: 1_000, historyFloor: 200 }));
  assert.equal(transcript.liveTail().items.length, 1,
    "the backward-clock record confirms its own completion, not the still-pending earlier one");
  assert.equal(transcript.liveTail().items[0].kind, "message");
  assert.equal(
    transcript.liveTail().items[0].content[0].text,
    "first",
    "the earlier completion stays live: matching never reorders by timestamp",
  );
});


// ---------------------------------------------------------------------------
// Runner

let failed = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    console.log(`✓ ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${entry.name}`);
    console.error(error);
  }
}
console.log(`${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
