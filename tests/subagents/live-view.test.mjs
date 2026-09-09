import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const liveEventsModule = await load(join(packageRoot, "src", "subagents", "live-events.ts"));
const {
  MAX_LIVE_ITEMS,
  MAX_PENDING_EVENTS,
  LIVE_REPAINT_COALESCE_MS,
  createChildViewFeed,
  deriveChildViewEvent,
  isStructuralViewEvent,
} = liveEventsModule;
const childHistoryModule = await load(join(packageRoot, "src", "subagents", "child-history.ts"));
const { createChildHistory, boundedAssistantTextParts } = childHistoryModule;
const viewerModule = await load(join(packageRoot, "src", "subagents", "viewer.ts"));
const { ChildTranscriptOverlay } = viewerModule;
const rosterModule = await load(join(packageRoot, "src", "subagents", "roster.ts"));
const { createSubagentRosterController } = rosterModule;
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const { createBackgroundState } = backgroundModule;
const registrarModule = await load(join(packageRoot, "src", "subagents", "index.ts"));
const artifactsModule = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const { ensureArtifactsDir, initializeSessionFile, writeRunState } = artifactsModule;
const { createPromptSnapshot, createPiStub, setRunSubagentTaskMock, waitFor } = await load(
  join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"),
);
// The real promptSession seam, without the background-test alias.
const { __testables } = await load(join(packageRoot, "src", "subagents", "session.ts"));

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

const ID = "subagent_00000000-0000-4000-8000-000000000301";
const SESSION_ID = "019f0000-0000-7000-8000-000000000301";

function sessionHeader() {
  return { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: "/tmp/project" };
}

function messageEntry(id, message, timestamp = "2025-01-01T00:00:00Z") {
  return { type: "message", id, parentId: null, timestamp, message };
}

/** Writes run.json plus a native session file of raw JSONL lines for one child. */
function writeChildArtifacts(testRoot, id, lines) {
  process.env.PI_AGENT_DIR = testRoot;
  const artifactsDir = ensureArtifactsDir(id);
  const sessionFile = join(artifactsDir, "session.jsonl");
  initializeSessionFile({ id, artifactsDir, sessionFile, header: sessionHeader() });
  writeFileSync(sessionFile, [sessionHeader(), ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeRunState(artifactsDir, {
    version: 4,
    id,
    operation: "delegate",
    artifactsDir,
    sessionFile,
    sessionId: SESSION_ID,
    originParentSessionId: "parent-1",
    lastParentSessionId: "parent-1",
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    task: "task",
    cwd: "/tmp/project",
    startedAt: 1,
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
  });
  return { artifactsDir, sessionFile };
}

function appendSessionLine(sessionFile, entry) {
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

/** A feed with a manually driven scheduler, so delivery order is deterministic. */
function manualFeed() {
  const steps = [];
  const feed = createChildViewFeed({ schedule: (callback) => steps.push(callback) });
  return {
    feed,
    deliver: () => {
      const pending = steps.splice(0, steps.length);
      for (const callback of pending) callback();
    },
    pending: () => steps.length,
  };
}

function overlayHarness(model, columns = 80, rows = 30, now) {
  const tui = { terminal: { columns, rows }, requestRender() {} };
  const overlay = new ChildTranscriptOverlay({
    tui,
    theme: plainTheme(),
    model,
    ...(now !== undefined ? { now: () => now } : {}),
    onClose: () => {},
    onReplay: () => {},
  });
  return { overlay, tui };
}

function plain(lines) {
  return lines.map(stripVTControlCharacters);
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const busyWait = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* deliberate slow viewer work */ }
};

// ---------------------------------------------------------------------------
// Event derivation

test("derivation maps one native run into the ordered view-event sequence", () => {
  const sequence = [
    { type: "agent_start" },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Wor" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "needle", path: "." } }] } },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "grep", args: { pattern: "needle", path: "." } },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "grep", partialResult: { content: [] } },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "SECRET RESULT" }] } },
    { type: "message_end", message: { role: "toolResult", toolCallId: "call-1", content: [] } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } },
    { type: "agent_end" },
    { type: "auto_retry_start", attempt: 1 },
  ].map(deriveChildViewEvent);

  assert.deepEqual(sequence.map((event) => event && event.kind), [
    "run_started",
    "message_delta",
    "message_completed",
    "tool_started",
    "tool_updated",
    "tool_finished",
    "tool_result_completed",
    "message_delta",
    "message_completed",
    "run_finished",
    undefined,
  ]);
});

test("deltas keep native text/thinking interleaving order and stay sanitized and bounded", () => {
  // Regression (#306 review): the projection must be ordered parts, not
  // text/thinking buckets, so text→thinking→text renders in native order.
  const interleaved = deriveChildViewEvent({
    type: "message_update",
    message: { role: "assistant", content: [
      { type: "text", text: "first" },
      { type: "thinking", thinking: "plan the work" },
      { type: "text", text: "second" },
    ] },
  });
  assert.equal(interleaved.kind, "message_delta");
  assert.deepEqual(interleaved.parts, [
    { type: "text", text: "first" },
    { type: "thinking", thinking: "plan the work" },
    { type: "text", text: "second" },
  ]);

  const long = `api_key=SK-1234567890abcdef ${"x".repeat(20_000)} tail-marker`;
  const grown = deriveChildViewEvent({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: long }] },
  });
  const text = grown.parts.map((part) => part.type === "text" ? part.text : "").join("");
  assert.ok(text.length < long.length, "streaming text stays bounded through the shared clipper");
  assert.match(text, /tail-marker/);
  assert.ok(!text.includes("SK-1234567890abcdef"), "credentials never cross into a live event");

  const nonAssistant = deriveChildViewEvent({
    type: "message_update",
    message: { role: "user", content: [] },
  });
  assert.equal(nonAssistant, undefined);
});

test("tool events use the roster-grade projection and never raw arguments or results", () => {
  const started = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: "call-9",
    toolName: "grep",
    args: { pattern: "SECRET-PATTERN", path: "/deep/path" },
  });
  assert.equal(started.kind, "tool_started");
  assert.equal(started.name, "grep");
  assert.equal(started.summary, "called");
  assert.equal(started.toolCallId, "call-9");
  assert.ok(Number.isFinite(started.startedAt), "tool start carries a clock for the live duration");

  const unknown = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: "call-x",
    toolName: "totally_custom",
    args: { anything: "raw" },
  });
  assert.deepEqual(
    { ...unknown, startedAt: 0 },
    { kind: "tool_started", toolCallId: "call-x", name: "tool", summary: "called", startedAt: 0 },
  );

  const updated = deriveChildViewEvent({
    type: "tool_execution_update",
    toolCallId: "call-9",
    toolName: "grep",
    partialResult: { content: [{ type: "text", text: "partial SECRET" }] },
  });
  assert.deepEqual(updated, { kind: "tool_updated", toolCallId: "call-9", name: "grep" });

  const finished = deriveChildViewEvent({
    type: "tool_execution_end",
    toolCallId: "call-9",
    toolName: "grep",
    isError: true,
    result: { content: [{ type: "text", text: "SECRET FAILURE BODY" }] },
  });
  assert.deepEqual(finished, { kind: "tool_finished", toolCallId: "call-9", name: "grep", summary: "called", isError: true });
});

test("completed message content equals the persisted projection exactly, beyond any part cap", () => {
  // Regression (#306 review): a message with more parts than any live cap
  // must project identically on both sides so reconciliation stays exact.
  const content = [];
  for (let index = 0; index < 200; index += 1) {
    content.push(index % 2 === 0
      ? { type: "text", text: `part ${index}` }
      : { type: "thinking", thinking: `thought ${index}` });
  }
  const event = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content } });
  assert.equal(event.kind, "message_completed");
  assert.equal(event.content.length, 200, "no live part cap diverges from the persisted projection");
  assert.deepEqual(event.content, boundedAssistantTextParts(content));

  const persisted = childHistoryModule.projectSessionEntries([
    messageEntry("e1", { role: "assistant", content }),
  ]);
  const persistedAssistant = persisted.items.find((item) => item.kind === "assistant");
  assert.equal(JSON.stringify(event.content), JSON.stringify(persistedAssistant.message.content));
});

test("derivation ignores malformed events without throwing", () => {
  assert.equal(deriveChildViewEvent(undefined), undefined);
  assert.equal(deriveChildViewEvent(null), undefined);
  assert.equal(deriveChildViewEvent("agent_start"), undefined);
  assert.equal(deriveChildViewEvent({}), undefined);
  assert.equal(deriveChildViewEvent({ type: "message_end", message: 5 }), undefined);
  assert.equal(deriveChildViewEvent({ type: "tool_execution_start", toolName: null, args: null }).name, "tool");
});

test("structural classification separates completion from streaming deltas", () => {
  for (const kind of ["message_delta", "tool_updated"]) {
    assert.equal(isStructuralViewEvent({ kind, parts: [], toolCallId: "", name: "" }), false, kind);
  }
  for (const kind of ["run_started", "message_completed", "tool_started", "tool_finished", "tool_result_completed", "run_finished", "live_events_dropped"]) {
    assert.equal(isStructuralViewEvent({ kind }), true, kind);
  }
});

// ---------------------------------------------------------------------------
// Execution-boundary publication, containment, and decoupling

function seamDetails(artifactsDir) {
  return {
    version: 4,
    id: ID,
    operation: "delegate",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: SESSION_ID,
    originParentSessionId: "parent-1",
    lastParentSessionId: "parent-1",
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    agent: { promptVersion: 2, name: "worker", effort: "high", inheritParentSystem: true },
    task: "Stream a bounded answer.",
    cwd: "/tmp/project",
    model: "provider/model",
    startedAt: Date.now(),
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
  };
}

function seamSession(script) {
  let subscriber;
  const session = {
    state: { messages: [] },
    agent: { abort() {} },
    subscribe(fn) {
      subscriber = fn;
      return () => { subscriber = undefined; };
    },
    async prompt() {
      await script((event) => subscriber?.(event), session);
    },
    dispose() {},
  };
  return session;
}

test("promptSession publishes ordered view events without changing the run outcome", async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-live-seam-"));
  try {
    const buildFinal = () => ({
      role: "assistant",
      content: [{ type: "text", text: "# Final\n\nComplete answer." }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.0001 } },
      model: { provider: "provider", id: "model" },
      stopReason: "stop",
    });
    const script = async (emit, session) => {
      emit({ type: "agent_start" });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial" }] } });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }] } });
      emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: { pattern: "x" } });
      emit({ type: "tool_execution_update", toolCallId: "c1", toolName: "grep" });
      emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "grep", isError: false, result: { content: [] } });
      const message = buildFinal();
      session.state.messages = [message];
      emit({ type: "message_end", message });
      emit({ type: "agent_end" });
    };

    const baseline = await __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
    });

    const events = [];
    const withFeed = await __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      onViewEvent(event) { events.push(event); },
    });

    assert.deepEqual(events.map((event) => event.kind), [
      "run_started",
      "message_delta",
      "message_delta",
      "tool_started",
      "tool_updated",
      "tool_finished",
      "message_completed",
      "run_finished",
    ]);
    assert.deepEqual(events[1], { kind: "message_delta", parts: [{ type: "text", text: "Partial" }] });
    assert.deepEqual(events[2], { kind: "message_delta", parts: [{ type: "text", text: "Partial answer" }] });

    assert.equal(withFeed.details.phase, "completed");
    assert.equal(withFeed.details.finalText, baseline.details.finalText);
    assert.equal(withFeed.details.usage.output, baseline.details.usage.output);
    assert.equal(withFeed.details.timeline.length, baseline.details.timeline.length);
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test("a throwing view subscriber cannot fail, delay, or alter the child run", async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-live-isolation-"));
  try {
    const script = async (emit, session) => {
      emit({ type: "agent_start" });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        model: { provider: "p", id: "m" },
        stopReason: "stop",
      };
      session.state.messages = [message];
      emit({ type: "message_end", message });
      emit({ type: "agent_end" });
    };
    const runOnce = async (onViewEvent) => __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      ...(onViewEvent ? { onViewEvent } : {}),
    });

    const healthy = await runOnce(undefined);
    const broken = await runOnce(() => {
      throw new Error("viewer exploded");
    });

    assert.equal(broken.details.phase, healthy.details.phase);
    assert.equal(broken.details.finalText, healthy.details.finalText);
    assert.equal(broken.details.usage.turns, healthy.details.usage.turns);
    assert.deepEqual(broken.details.timeline, healthy.details.timeline);
    const persisted = JSON.parse(readFileSync(join(artifactsDir, "run.json"), "utf8"));
    assert.equal(persisted.phase, "completed");
    assert.equal(persisted.finalText, "Done");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test("a slow live subscriber never runs inside the child's native event dispatch", async () => {
  // Regression (#306 review): feed delivery must be decoupled from the child
  // run. Every subscriber invocation happens after the child's synchronous
  // dispatch finished and after the run itself resolved — however slow the
  // subscriber is, it cannot delay the child.
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-live-decoupled-"));
  try {
    const feed = createChildViewFeed();
    const observed = { dispatching: false, runDone: false, invocations: 0, illegal: 0 };
    const script = async (emit, session) => {
      observed.dispatching = true;
      emit({ type: "agent_start" });
      for (let index = 0; index < 5; index += 1) {
        emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `chunk ${index}` }] } });
      }
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        model: { provider: "p", id: "m" },
        stopReason: "stop",
      };
      session.state.messages = [message];
      emit({ type: "message_end", message });
      emit({ type: "agent_end" });
      observed.dispatching = false;
    };
    feed.subscribe(ID, () => {
      if (observed.dispatching || !observed.runDone) observed.illegal += 1;
      observed.invocations += 1;
      busyWait(15);
    });

    const runDone = __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      onViewEvent(event) { feed.publish(ID, event); },
    }).then(() => {
      observed.runDone = true;
    });
    await runDone;
    // Let the scheduled flush run; it was scheduled during the run, so this
    // immediate queues strictly behind it.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(observed.illegal, 0, "no subscriber work ran during dispatch or before the run resolved");
    assert.ok(observed.invocations >= 4, "the decoupled flush still delivers every coalesced event");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Feed

test("the feed is ephemeral: no subscribers means no work and no buffering", () => {
  const { feed, deliver } = manualFeed();
  feed.publish("child-1", { kind: "run_started" });
  deliver();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_finished" });
  deliver();
  assert.deepEqual(seen, ["run_finished"]);
});

test("delivery is ordered, isolated, and never synchronous", () => {
  const { feed, deliver } = manualFeed();
  const healthy = [];
  let syncPublish = true;
  feed.subscribe("child-1", () => { throw new Error("broken subscriber"); });
  feed.subscribe("child-1", (event) => {
    healthy.push(event.kind);
    assert.ok(!syncPublish, "subscribers never run inside publish");
  });
  feed.publish("child-1", { kind: "run_started" });
  assert.deepEqual(healthy, [], "nothing is delivered synchronously");
  syncPublish = false;
  feed.publish("child-1", { kind: "message_completed", content: [] });
  deliver();
  assert.deepEqual(healthy, ["run_started", "message_completed"]);
});

test("cumulative deltas coalesce in place without disturbing order", () => {
  const { feed, deliver } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event));
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "a" }] });
  feed.publish("child-1", { kind: "tool_started", toolCallId: "c1", name: "grep", summary: "called", startedAt: 1 });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "abc" }] });
  deliver();
  assert.deepEqual(seen.map((event) => event.kind), ["message_delta", "tool_started"]);
  assert.deepEqual(seen[0].parts, [{ type: "text", text: "abc" }], "the pending delta kept its queue position with the newest payload");
});

test("a bounded pending queue drops the oldest with one visible omission marker", () => {
  const { feed, deliver } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event.kind));
  for (let index = 0; index < MAX_PENDING_EVENTS + 5; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  deliver();
  assert.ok(seen.length <= MAX_PENDING_EVENTS + 1, "the delivered batch stays bounded");
  assert.equal(seen[0], "live_events_dropped", "the drop is explicit, never silent");
});

test("unsubscribe, clear, and the subscriber bound hold", () => {
  const { feed, deliver } = manualFeed();
  const seen = [];
  const unsubscribe = feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_started" });
  deliver();
  unsubscribe();
  feed.publish("child-1", { kind: "run_finished" });
  deliver();
  assert.deepEqual(seen, ["run_started"]);

  for (let index = 0; index < 12; index += 1) feed.subscribe("child-2", () => {});
  const late = [];
  feed.subscribe("child-2", (event) => late.push(event.kind));
  feed.publish("child-2", { kind: "run_started" });
  deliver();
  assert.deepEqual(late, [], "the per-child subscriber bound rejects the ninth subscription");

  const before = [];
  feed.subscribe("child-3", (event) => before.push(event.kind));
  feed.clear();
  feed.publish("child-3", { kind: "run_started" });
  deliver();
  assert.deepEqual(before, [], "clear drops subscribers and undelivered events");
});

// ---------------------------------------------------------------------------
// Overlay live tail over a real demand-paged history

function runningModel(history) {
  return {
    role: "explorer",
    idLabel: "aaaaaaaa",
    lifecycleLabel: "● running",
    lifecycleTone: "accent",
    status: "running",
    durationText: "4s",
    history,
  };
}

function openOverlay(root, lines, options = {}) {
  writeChildArtifacts(root, ID, lines);
  return overlayHarness(
    runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })),
    options.columns ?? 80,
    options.rows ?? 30,
    options.now,
  );
}

test("streaming assistant parts render below the persisted window in native order", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-overlay-"));
  try {
    const { overlay } = openOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "please research" }] }),
    ]);
    let lines = plain(overlay.render(64));
    assert.ok(lines.some((line) => line.includes("please research")));
    assert.ok(!lines.some((line) => line.includes("Starting…")), "persisted content replaces the placeholder");

    overlay.applyLiveEvent({
      kind: "message_delta",
      parts: [
        { type: "text", text: "Partial answ" },
        { type: "thinking", thinking: "planning" },
        { type: "text", text: "ering" },
      ],
    });
    lines = plain(overlay.render(64)).join("\n");
    const persistedIndex = lines.indexOf("please research");
    const firstText = lines.indexOf("Partial answ");
    const thinking = lines.indexOf("planning");
    const secondText = lines.indexOf("ering");
    assert.ok(persistedIndex >= 0, "persisted items stay visible");
    assert.ok(firstText > persistedIndex, "live content renders below the persisted window");
    assert.ok(thinking > firstText && secondText > thinking, "text→thinking→text keeps its native order");

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "Full partial replaced" }] });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("Full partial replaced"));
    assert.ok(!lines.includes("Partial answ") && !lines.includes("planning"),
      "the partial is replaced by the grown cumulative text, not duplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed message reconciles with the persisted entry exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-reconcile-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "Working" }] });
    overlay.applyLiveEvent({ kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: "Working" }]) });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Working"), 1, "the completed live message stays visible before persistence lands");

    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "Working" }] }));
    overlay.applyLiveEvent({ kind: "run_started" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Working"), 1, "reconciliation never duplicates the message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-existing identical message never consumes a newer completion", () => {
  // Regression (#306 review): the loaded history already contains the same
  // text. The new completion's own entry has not appended yet, so the live
  // copy must survive reconciliation instead of being matched against the old
  // occurrence.
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-prerace-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
      messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "Same words" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: "Same words" }]) });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2,
      "the live copy stays: only occurrences beyond the recorded baseline can confirm it");

    // An unrelated entry appends and a structural event reconciles: the new
    // completion's own entry still has not landed, so consuming the live copy
    // against the old identical occurrence would hide the new message.
    appendSessionLine(sessionFile, messageEntry("e8", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c9", name: "grep", arguments: { pattern: "x" } }],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2,
      "an unrelated persisted append never consumes the live completion against the pre-existing identical message");

    // The new entry appends; only now may reconciliation drop the live copy.
    appendSessionLine(sessionFile, messageEntry("e9", { role: "assistant", content: [{ type: "text", text: "Same words" }] }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2, "two persisted occurrences show, no live duplicate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a message longer than any live part cap reconciles exactly", () => {
  // Regression (#306 review): the live and persisted projections must be one
  // projection, so a 200-part message confirms instead of lingering.
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-manyparts-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })), 80, 400);
    overlay.render(64);

    const content = [];
    for (let index = 0; index < 200; index += 1) {
      content.push({ type: "text", text: `part ${index}` });
    }
    // Through the derivation, so any live-side cap makes reconciliation fail.
    const completed = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content } });
    assert.equal(completed.kind, "message_completed");
    overlay.applyLiveEvent(completed);
    let lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("part 199"));

    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", content }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "part 0"), 1, "the exact projection confirms and never duplicates");
    assert.equal(occurrences(lines, "part 199"), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical completions reconcile one-to-one without reordering", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-order-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);

    const first = boundedAssistantTextParts([{ type: "text", text: "Same words" }]);
    const second = boundedAssistantTextParts([{ type: "text", text: "Same words" }]);
    overlay.applyLiveEvent({ kind: "message_completed", content: first });
    overlay.applyLiveEvent({ kind: "message_completed", content: second });

    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "Same words" }] }));
    overlay.applyLiveEvent({ kind: "tool_started", toolCallId: "c1", name: "grep", summary: "called", startedAt: 1 });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2, "two identical live completions stay until both persist");

    appendSessionLine(sessionFile, messageEntry("e3", { role: "assistant", content: [{ type: "text", text: "Same words" }] }));
    overlay.applyLiveEvent({ kind: "tool_finished", toolCallId: "c1", name: "grep", isError: false });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2, "each live copy drops against its own persisted counterpart");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live tail overflow sheds the oldest with an explicit omission state and recovers", () => {
  // Regression (#306 review): overflowing the bounded live tail must never
  // silently lose an unpersisted message. The oldest entry drops with a
  // visible omission marker, and persisted history recovers everything once
  // the appends land.
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-overflow-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })), 80, 400);
    overlay.render(64);

    const total = MAX_LIVE_ITEMS + 4;
    for (let index = 0; index < total; index += 1) {
      overlay.applyLiveEvent({
        kind: "message_completed",
        content: boundedAssistantTextParts([{ type: "text", text: `completion ${index}` }]),
      });
    }
    let lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("completion 0"), "the oldest overflow entry is dropped");
    assert.ok(lines.includes(`completion ${total - 1}`), "the newest entry never drops");
    assert.match(lines, /older live updates were dropped/, "the drop is an explicit omission state");

    for (let index = 0; index < total; index += 1) {
      appendSessionLine(sessionFile, messageEntry(`p${index}`, {
        role: "assistant",
        content: [{ type: "text", text: `completion ${index}` }],
      }));
    }
    overlay.applyLiveEvent({ kind: "run_finished" });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("older live updates were dropped"), "a recovering load clears the omission state");
    assert.ok(lines.includes("completion 0") && lines.includes(`completion ${total - 1}`),
      "persisted history recovers every dropped message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live tool start, update, and end are observable without any persisted append", () => {
  // Regression (#306 review): tool progress must render from the live events
  // themselves — a running row on start, an immediate terminal state on end —
  // while the persisted projection catches up.
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-tools-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "search things" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })), 80, 30, 5_000);
    overlay.render(64);

    // No assistant entry has been appended yet: the live row is the only view.
    overlay.applyLiveEvent({ kind: "tool_started", toolCallId: "c1", name: "grep", summary: "called", startedAt: 1_000 });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "a running live tool row appears immediately");
    assert.ok(!lines.includes("SECRET"), "no raw argument ever renders");

    overlay.applyLiveEvent({ kind: "tool_updated", toolCallId: "c1", name: "grep" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "an update leaves exactly one row");

    overlay.applyLiveEvent({ kind: "tool_finished", toolCallId: "c1", name: "grep", isError: true });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "the same row flips in place");
    assert.match(lines, /Tool failed/, "the end state shows immediately, before any toolResult append");

    // A finished call that was never started still shows its terminal state.
    overlay.applyLiveEvent({ kind: "tool_finished", toolCallId: "c2", name: "find", isError: false });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("Find"), "a finish without a start still renders a live row");
    assert.match(lines, /Completed/);

    // History catches up: the persisted projection takes over, one row each.
    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "SECRET-PATTERN", path: "." } }],
    }));
    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "find", arguments: { pattern: "*" } }],
    }));
    appendSessionLine(sessionFile, messageEntry("e4", {
      role: "toolResult", toolCallId: "c1", toolName: "grep", isError: true,
      content: [{ type: "text", text: "SECRET RESULT BODY" }],
    }));
    appendSessionLine(sessionFile, messageEntry("e5", {
      role: "toolResult", toolCallId: "c2", toolName: "find", isError: false,
      content: [{ type: "text", text: "SECRET RESULT BODY" }],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "the persisted row replaces the live row without duplication");
    assert.equal(occurrences(lines, "Find"), 1);
    assert.ok(!lines.includes("SECRET RESULT BODY"), "result payloads never render");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool call already covered by persisted history adds no duplicate live row", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-toolcover-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);
    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "x" } }],
    }));
    overlay.applyLiveEvent({ kind: "tool_started", toolCallId: "c1", name: "grep", summary: "called", startedAt: 1_000 });
    const lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "the persisted running row covers the call; no live duplicate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a final message that never persists is not lost while the overlay stays open", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-final-"));
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "Final answer text" }] });
    overlay.applyLiveEvent({ kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: "Final answer text" }]) });
    overlay.applyLiveEvent({ kind: "run_finished" });

    const lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Final answer text"), 1,
      "run_finished without a persisted copy keeps the final buffered content visible");

    // A stream that never completed keeps its last observed partial too.
    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "uncommitted tail" }] });
    overlay.applyLiveEvent({ kind: "run_finished" });
    assert.ok(plain(overlay.render(64)).join("\n").includes("uncommitted tail"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a view scrolled away from the tail is not pulled back by live growth", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-scroll-"));
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "first line of a long task" }] }),
      messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "second entry with body text" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })), 80, 12);
    overlay.render(64);
    overlay.handleInput("\x1b[H"); // Home: pin the viewport to the top.

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "streaming tail content" }] });
    const lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("streaming tail content"), "a pinned top viewport ignores new tail content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a queued child shows the waiting state even before a session file exists", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-queued-"));
  try {
    process.env.PI_AGENT_DIR = root;
    const { overlay } = overlayHarness({
      ...runningModel(createChildHistory(ID, { observedAt: 1 })),
      status: "queued",
      lifecycleLabel: "– queued",
    });
    const lines = plain(overlay.render(64));
    assert.ok(lines.some((line) => line.includes("Waiting to start")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a contained live failure renders one bounded diagnostic and recovers", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-diag-"));
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);
    overlay.setLiveDiagnostic();
    let lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /live updates paused after a viewer error/);
    assert.ok(lines.includes("task"), "the persisted view stays visible");

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "recovered" }] });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("live updates paused"), "the next successful event clears the diagnostic");
    assert.ok(lines.includes("recovered"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Controller: coalesced repaints, immediate structure, disposal, lifecycle

function fakePaintTimers() {
  const clock = { now: 0, timers: new Map(), seq: 0 };
  return {
    clock,
    setTimeout(callback, ms) {
      clock.seq += 1;
      clock.timers.set(clock.seq, { callback, at: clock.now + ms });
      return clock.seq;
    },
    clearTimeout(handle) { clock.timers.delete(handle); },
    pending: () => clock.timers.size,
    fire() {
      const due = [...clock.timers.entries()].sort((left, right) => left[1].at - right[1].at);
      for (const [handle, entry] of due) {
        clock.timers.delete(handle);
        entry.callback();
      }
    },
  };
}

function controllerHarness(root, { status = "running", startedAt = 0 } = {}) {
  process.env.PI_AGENT_DIR = root;
  const { artifactsDir, sessionFile } = writeChildArtifacts(root, ID, [
    messageEntry("e1", { role: "user", content: [{ type: "text", text: "task text" }] }),
  ]);
  const state = createBackgroundState();
  const live = manualFeed();
  state.viewFeed = live.feed;
  const job = {
    id: ID,
    status,
    createdAt: startedAt,
    updatedAt: startedAt + 1,
    abortController: new AbortController(),
    details: {
      startedAt,
      agent: { name: "explorer" },
      lastParentSessionId: "parent-1",
      timeline: [],
    },
  };
  state.jobs.set(ID, job);

  const timers = fakePaintTimers();
  const editor = { text: "" };
  let inputHandler;
  const calls = { renders: 0, customs: [] };
  const tui = { terminal: { columns: 80, rows: 30 }, requestRender() { calls.renders += 1; } };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme: plainTheme(),
      onTerminalInput(handler) { inputHandler = handler; return () => {}; },
      setWidget() {},
      getEditorText: () => editor.text,
      pasteToEditor() {},
      custom(factory) {
        calls.customs.push(factory);
        const component = factory(tui, plainTheme(), { matches: () => false }, () => {});
        calls.component = component;
        return new Promise(() => {});
      },
    },
    sessionManager: { getSessionId: () => "parent-1" },
  };
  const controller = createSubagentRosterController(state, {
    now: () => timers.clock.now,
    timers,
  });
  controller.start(ctx);
  const input = (data) => inputHandler?.(data);
  return { state, job, controller, timers, calls, input, tui, sessionFile, deliver: live.deliver };
}

test("live deltas coalesce to at most one repaint per window; structure renders immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-paint-"));
  try {
    const { state, job, timers, calls, input, deliver } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    assert.ok(calls.component, "the overlay opened");
    assert.equal(calls.renders, 0, "opening alone requests no repaint");
    assert.equal(timers.pending(), 0, "no repaint timer is scheduled while idle");

    const publish = (event) => { state.viewFeed.publish(job.id, event); };

    timers.clock.now = 0;
    publish({ kind: "message_delta", parts: [{ type: "text", text: "a" }] });
    deliver();
    assert.equal(calls.renders, 1, "the first delta after a long idle paints immediately");

    timers.clock.now = 10;
    publish({ kind: "message_delta", parts: [{ type: "text", text: "ab" }] });
    deliver();
    timers.clock.now = 50;
    publish({ kind: "message_delta", parts: [{ type: "text", text: "abc" }] });
    deliver();
    timers.clock.now = 80;
    publish({ kind: "message_delta", parts: [{ type: "text", text: "abcd" }] });
    deliver();
    assert.equal(calls.renders, 1, "deltas inside the window request no extra repaint");
    assert.equal(timers.pending(), 1, "exactly one coalesced repaint is pending");

    timers.clock.now = LIVE_REPAINT_COALESCE_MS;
    timers.fire();
    assert.equal(calls.renders, 2, "the pending timer paints once at the window edge");
    assert.equal(timers.pending(), 0);

    timers.clock.now = LIVE_REPAINT_COALESCE_MS + 5;
    publish({ kind: "message_delta", parts: [{ type: "text", text: "abcde" }] });
    deliver();
    assert.equal(timers.pending(), 1, "a fresh delta schedules the next window");

    timers.clock.now = LIVE_REPAINT_COALESCE_MS + 8;
    publish({ kind: "message_completed", content: [] });
    deliver();
    assert.equal(calls.renders, 3, "structural events render immediately");
    assert.equal(timers.pending(), 0, "the structural flush cancels the pending coalesced timer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlay close and session teardown cancel the pending repaint timer", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-dispose-"));
  try {
    const { state, job, timers, calls, input, controller, deliver } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "a" }] });
    deliver();
    timers.clock.now = 10;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "ab" }] });
    deliver();
    assert.equal(timers.pending(), 1);

    calls.component.handleInput("\x1b"); // Escape closes the open overlay.
    assert.equal(timers.pending(), 0, "overlay close cancels the pending repaint");

    timers.clock.now = 500;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "stale" }] });
    deliver();
    assert.equal(calls.renders, 1, "events after close repaint nothing");

    input("\x1b[B");
    input("\r");
    timers.clock.now = 600;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "again" }] });
    deliver();
    timers.clock.now = 610;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "againx" }] });
    deliver();
    assert.equal(timers.pending(), 1);

    controller.stop();
    assert.equal(timers.pending(), 0, "session teardown cancels the pending repaint");
    timers.fire();
    assert.equal(calls.renders, 2, "no timer fires after teardown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child that terminalizes while open shows its final lifecycle and content", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-terminal-"));
  try {
    const { state, job, timers, calls, input, sessionFile, deliver } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "final words" }] });
    deliver();
    state.viewFeed.publish(job.id, {
      kind: "message_completed",
      content: boundedAssistantTextParts([{ type: "text", text: "final words" }]),
    });
    deliver();

    appendSessionLine(sessionFile, messageEntry("e9", { role: "assistant", content: [{ type: "text", text: "final words" }] }));
    job.status = "completed";
    job.details.phase = "completed";
    job.details.endedAt = 9_000;
    job.details.finalText = "final words";
    for (const listener of state.listeners) listener();

    assert.ok(calls.renders >= 1, "the terminal transition renders immediately");
    const lines = plain(calls.component.render(64)).join("\n");
    assert.match(lines, /completed/, "the open overlay title shows the final lifecycle");
    assert.equal(occurrences(lines, "final words"), 1, "the final content reconciled exactly once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken overlay renderer is contained as one diagnostic and never stops repaints", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-contained-"));
  try {
    const { state, job, timers, calls, input, deliver } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    const overlay = calls.component;
    overlay.applyLiveEvent = () => {
      throw new Error("renderer exploded");
    };
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "hidden" }] });
    deliver();
    state.viewFeed.publish(job.id, { kind: "message_completed", content: [] });
    deliver();

    assert.ok(calls.renders >= 2, "structural repaints still flow around a throwing renderer");
    const lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /live updates paused after a viewer error/, "the contained failure shows one bounded diagnostic row");
    assert.ok(lines.includes("task text"), "the persisted view keeps rendering");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration

test("background integration: feed events flow in order and a broken subscriber changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-background-"));
  try {
    const pi = createPiStub();
    process.env.PI_AGENT_DIR = root;
    const state = createBackgroundState();
    const mockedBackground = await (await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"))).loadBackgroundModule();
    const queued = mockedBackground.createQueuedJob({
      state,
      id: ID,
      task: "smoke task",
      cwd: "/tmp/subagents",
      parentSessionId: "parent-session",
      promptSnapshot: createPromptSnapshot(),
    });

    const captured = [];
    state.viewFeed.subscribe(queued.id, (event) => captured.push(event.kind));
    state.viewFeed.subscribe(queued.id, () => {
      busyWait(5);
      throw new Error("broken viewer subscriber");
    });

    setRunSubagentTaskMock(async (input) => {
      input.onViewEvent?.({ kind: "run_started" });
      input.onViewEvent?.({ kind: "message_delta", parts: [{ type: "text", text: "partial" }] });
      input.onViewEvent?.({ kind: "message_completed", content: [] });
      input.onViewEvent?.({ kind: "run_finished" });
      return {
        details: {
          ...queued.details,
          phase: "completed",
          finalText: "ACK",
          endedAt: 20,
          durationMs: 10,
        },
      };
    });

    mockedBackground.startBackgroundJob({
      pi: pi.api,
      state,
      job: queued,
      ctx: {},
      task: "smoke task",
      parentSessionId: "parent-session",
    });

    await waitFor(() => state.jobs.get(queued.id)?.status === "completed", "job completion");
    await waitFor(() => pi.sent.length === 1, "the ordinary completion delivery");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(captured, ["run_started", "message_delta", "message_completed", "run_finished"]);
    assert.equal(queued.details.finalText, "ACK");
    assert.equal(queued.details.phase, "completed");
    assert.equal(pi.sent[0].message.customType, "pi-square.subagent-notification",
      "a broken live subscriber leaves the ordinary completion delivery untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement and shutdown clear the session-scoped live view feed", async () => {
  // Regression (#306 review): no subscriber of one parent session may survive
  // into its replacement or past shutdown.
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-feedclear-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(root, "agent");
  try {
    const handlers = new Map();
    const pi = {
      handlers,
      on(event, handler) { handlers.set(event, handler); },
      registerTool() {},
      registerMessageRenderer() {},
      registerCommand() {},
      getThinkingLevel: () => "medium",
      sendMessage() {},
    };
    registrarModule.default(pi, undefined, () => ({
      version: 2,
      anchoredEditing: { enabled: false, autoRead: true },
    }));
    const state = registrarModule.__testables.lastState();
    assert.ok(state?.background?.viewFeed, "the registrar owns a session-scoped view feed");

    const ctx = (sessionId) => ({
      mode: "tui",
      hasUI: true,
      cwd: root,
      ui: {
        theme: plainTheme(),
        setWidget() {},
        getEditorText: () => "",
        onTerminalInput() { return () => {}; },
        notify() {},
      },
      sessionManager: { getSessionId: () => sessionId, getSessionDir: () => root },
    });

    const seen = [];
    state.background.viewFeed.subscribe(ID, (event) => seen.push(event.kind));
    await handlers.get("session_start")({}, ctx("parent-1"));
    state.background.viewFeed.publish(ID, { kind: "run_started" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [], "replacement clears subscribers and undelivered events");

    const after = [];
    state.background.viewFeed.subscribe(ID, (event) => after.push(event.kind));
    await handlers.get("session_shutdown")();
    state.background.viewFeed.publish(ID, { kind: "run_started" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(after, [], "shutdown clears the session-scoped feed");
  } finally {
    if (previousAgentDir !== undefined) process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error?.stack ?? error}`);
  }
}
if (failed > 0) {
  console.error(`${tests.length} tests, ${failed} failed`);
  process.exit(1);
}
console.log(`live child view tests: ${tests.length} tests, 0 failed`);
