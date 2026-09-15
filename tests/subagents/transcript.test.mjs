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
  return {
    view: {
      snapshot: () => ({
        items: [...items],
        moreBefore,
        moreAfter: pending.length > 0,
      }),
      loadOlder: () => false,
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
  assert.deepEqual(changes, [{ grew: true }], "the module reports visible growth");
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
  assert.deepEqual(changes, [{ grew: false }], "no visible growth: reconciliation only");
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
  assert.deepEqual(changes, [{ grew: true }], "persisted growth found while reconciling an event is visible growth");
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
  assert.deepEqual(changes, [{ grew: false }, { grew: true }], "diagnostic and streaming changes notify in order");

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
  assert.deepEqual(changes, [{ grew: false }], "the reconcile found no persisted growth");
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
