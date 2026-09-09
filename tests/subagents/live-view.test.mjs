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
  MAX_LIVE_COMPLETED,
  MAX_LIVE_STREAM_TEXT,
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
// The aliased loader routes the background module's runSubagentTask import to
// the test-helpers mock seam, exactly like background.test.mjs.
const mockedBackground = await (await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"))).loadBackgroundModule();
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

function overlayHarness(model, columns = 80, rows = 30) {
  const tui = { terminal: { columns, rows }, requestRender() {} };
  const overlay = new ChildTranscriptOverlay({
    tui,
    theme: plainTheme(),
    model,
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

// ---------------------------------------------------------------------------
// Event derivation

test("derivation maps one native run into the ordered view-event sequence", () => {
  const sequence = [
    { type: "agent_start" },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Wor" }] } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Working on it" }] } },
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

test("deltas carry cumulative sanitized text and thinking separately and bounded", () => {
  const secret = "api_key=SK-1234567890abcdef";
  const long = `${secret} ${"x".repeat(20_000)} tail-marker`;
  const first = deriveChildViewEvent({
    type: "message_update",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "plan the work" },
      { type: "text", text: "Working" },
    ] },
  });
  assert.deepEqual(first, { kind: "message_delta", text: "Working", thinking: "plan the work" });

  const grown = deriveChildViewEvent({
    type: "message_update",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "plan the work carefully" },
      { type: "text", text: long },
    ] },
  });
  assert.equal(grown.thinking, "plan the work carefully");
  assert.ok(grown.text.length <= MAX_LIVE_STREAM_TEXT + 100,
    "streaming text stays bounded (the shared clipper's omitted marker is the only overhead)");
  assert.match(grown.text, /tail-marker/);
  assert.ok(!grown.text.includes("SK-1234567890abcdef"), "credentials never cross into a live event");

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
  assert.deepEqual(started, { kind: "tool_started", toolCallId: "call-9", name: "grep", summary: "called" });

  const unknown = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: "call-x",
    toolName: "totally_custom",
    args: { anything: "raw" },
  });
  assert.deepEqual(unknown, { kind: "tool_started", toolCallId: "call-x", name: "tool", summary: "called" });

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

test("completed message content equals the persisted projection of the same content", () => {
  const content = [
    { type: "thinking", thinking: "reasoning" },
    { type: "text", text: "answer text" },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
    { type: "unsupported" },
  ];
  const event = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content } });
  assert.equal(event.kind, "message_completed");
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
    assert.equal(isStructuralViewEvent({ kind, text: "", thinking: "", toolCallId: "", name: "" }), false, kind);
  }
  for (const kind of ["run_started", "message_completed", "tool_started", "tool_finished", "tool_result_completed", "run_finished"]) {
    const event = { kind };
    assert.equal(isStructuralViewEvent(event), true, kind);
  }
});

// ---------------------------------------------------------------------------
// Execution-boundary publication and containment

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
    assert.deepEqual(events[1], { kind: "message_delta", text: "Partial", thinking: "" });
    assert.deepEqual(events[2], { kind: "message_delta", text: "Partial answer", thinking: "" });

    assert.equal(withFeed.details.phase, "completed");
    assert.equal(withFeed.details.finalText, baseline.details.finalText);
    assert.equal(withFeed.details.usage.output, baseline.details.usage.output);
    assert.equal(withFeed.details.timeline.length, baseline.details.timeline.length);
    assert.equal(events.filter((event) => event.kind === "message_completed").length, 1);
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

// ---------------------------------------------------------------------------
// Feed

test("the feed is ephemeral: no subscribers means no work and no buffering", () => {
  const feed = createChildViewFeed();
  feed.publish("child-1", { kind: "run_started" });
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event));
  feed.publish("child-1", { kind: "run_finished" });
  assert.deepEqual(seen.map((event) => event.kind), ["run_finished"]);
});

test("subscribers are isolated and fan out in order", () => {
  const feed = createChildViewFeed();
  const healthy = [];
  feed.subscribe("child-1", () => { throw new Error("broken subscriber"); });
  feed.subscribe("child-1", (event) => healthy.push(event.kind));
  feed.publish("child-1", { kind: "run_started" });
  feed.publish("child-1", { kind: "message_completed", content: [] });
  assert.deepEqual(healthy, ["run_started", "message_completed"]);
});

test("unsubscribe, clear, and the subscriber bound hold", () => {
  const feed = createChildViewFeed();
  const seen = [];
  const unsubscribe = feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_started" });
  unsubscribe();
  feed.publish("child-1", { kind: "run_finished" });
  assert.deepEqual(seen, ["run_started"]);

  for (let index = 0; index < 12; index += 1) feed.subscribe("child-2", () => {});
  const late = [];
  feed.subscribe("child-2", (event) => late.push(event.kind));
  feed.publish("child-2", { kind: "run_started" });
  assert.deepEqual(late, [], "the per-child subscriber bound rejects the ninth subscription");

  feed.clear();
  feed.publish("child-1", { kind: "run_finished" });
  assert.deepEqual(seen, ["run_started"]);
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

test("streaming assistant text and thinking render below the persisted window", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-overlay-"));
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "please research" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    let lines = plain(overlay.render(64));
    assert.ok(lines.some((line) => line.includes("please research")));
    assert.ok(!lines.some((line) => line.includes("Starting…")), "persisted content replaces the placeholder");

    overlay.applyLiveEvent({ kind: "message_delta", text: "Partial answ", thinking: "planning" });
    lines = plain(overlay.render(64));
    const persistedIndex = lines.findIndex((line) => line.includes("please research"));
    const thinkingIndex = lines.findIndex((line) => line.includes("planning"));
    const partialIndex = lines.findIndex((line) => line.includes("Partial answ"));
    assert.ok(persistedIndex >= 0 && thinkingIndex > persistedIndex && partialIndex > thinkingIndex,
      "live content renders in order below the persisted window");
    assert.ok(!lines.includes("Starting…"));

    overlay.applyLiveEvent({ kind: "message_delta", text: "Partial answer complete", thinking: "" });
    lines = plain(overlay.render(64));
    assert.ok(lines.some((line) => line.includes("Partial answer complete")));
    assert.ok(!lines.some((line) => line.includes("Partial answ") && !line.includes("Partial answer complete")),
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

    overlay.applyLiveEvent({ kind: "message_delta", text: "Working", thinking: "" });
    // The completion fires inside the message_end listener, before Pi appends
    // the entry: the immediate refresh cannot see it yet.
    overlay.applyLiveEvent({ kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: "Working" }]) });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Working"), 1, "the completed live message stays visible before persistence lands");

    // Pi appends the entry right after the listener; the next structural
    // event's refresh confirms and drops the live copy.
    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "Working" }] }));
    overlay.applyLiveEvent({ kind: "run_started" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Working"), 1, "reconciliation never duplicates the message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical messages reconcile one-to-one without reordering or stale replacement", () => {
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
    overlay.applyLiveEvent({ kind: "tool_started", toolCallId: "c1", name: "grep", summary: "called" });
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

test("tool lifecycle shows persisted running calls and results without payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-tools-"));
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "search things" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);

    // The assistant message carrying the tool call persisted before execution.
    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "SECRET-PATTERN", path: "." } }],
    }));
    overlay.applyLiveEvent({ kind: "tool_started", toolCallId: "c1", name: "grep", summary: "called" });
    let lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /Grep/, "the persisted tool call renders as a running operational row");
    assert.ok(!lines.includes("SECRET-PATTERN"), "raw arguments never render in the live view");

    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "grep",
      isError: true,
      content: [{ type: "text", text: "SECRET RESULT BODY" }],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("SECRET RESULT BODY"), "result payloads never render");
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

    overlay.applyLiveEvent({ kind: "message_delta", text: "Final answer text", thinking: "" });
    overlay.applyLiveEvent({ kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: "Final answer text" }]) });
    overlay.applyLiveEvent({ kind: "run_finished" });

    const lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Final answer text"), 1,
      "run_finished without a persisted copy keeps the final buffered content visible");
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

    overlay.applyLiveEvent({ kind: "message_delta", text: "streaming tail content", thinking: "" });
    const lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("streaming tail content"), "a pinned top viewport ignores new tail content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live buffers stay bounded: completed queue cap and streaming clip", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-bounds-"));
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { overlay } = overlayHarness(runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })));
    overlay.render(64);

    for (let index = 0; index < MAX_LIVE_COMPLETED + 4; index += 1) {
      overlay.applyLiveEvent({ kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: `completed ${index}` }]) });
    }
    let lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("completed 0"), "the oldest overflow entry is dropped");
    assert.ok(lines.includes(`completed ${MAX_LIVE_COMPLETED + 3}`), "the newest completion stays");

    overlay.applyLiveEvent({ kind: "message_delta", text: `${"y".repeat(30_000)} end`, thinking: `${"z".repeat(30_000)} end` });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("end"), "the clipped head/tail keeps the newest content visible");
    assert.ok(overlay.render(64).length < 120, "the rendered body stays bounded");
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

    overlay.applyLiveEvent({ kind: "message_delta", text: "recovered", thinking: "" });
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
  const id = ID;
  process.env.PI_AGENT_DIR = root;
  const { artifactsDir, sessionFile } = writeChildArtifacts(root, id, [
    messageEntry("e1", { role: "user", content: [{ type: "text", text: "task text" }] }),
  ]);
  const state = createBackgroundState();
  const job = {
    id,
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
  state.jobs.set(id, job);

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
  return { state, job, controller, timers, calls, input, tui, sessionFile };
}

test("live deltas coalesce to at most one repaint per window; structure renders immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-paint-"));
  try {
    const { state, job, timers, calls, input } = controllerHarness(root);
    input("\x1b[B"); // select
    input("\r"); // open
    assert.ok(calls.component, "the overlay opened");
    assert.equal(calls.renders, 0, "opening alone requests no repaint");
    assert.equal(timers.pending(), 0, "no repaint timer is scheduled while idle");

    const publish = (event) => state.viewFeed.publish(job.id, event);

    timers.clock.now = 0;
    publish({ kind: "message_delta", text: "a", thinking: "" });
    assert.equal(calls.renders, 1, "the first delta after a long idle paints immediately");

    timers.clock.now = 10;
    publish({ kind: "message_delta", text: "ab", thinking: "" });
    timers.clock.now = 50;
    publish({ kind: "message_delta", text: "abc", thinking: "" });
    timers.clock.now = 80;
    publish({ kind: "message_delta", text: "abcd", thinking: "" });
    assert.equal(calls.renders, 1, "deltas inside the window request no extra repaint");
    assert.equal(timers.pending(), 1, "exactly one coalesced repaint is pending");

    timers.clock.now = LIVE_REPAINT_COALESCE_MS; // the window edge
    timers.fire();
    assert.equal(calls.renders, 2, "the pending timer paints once at the window edge");
    assert.equal(timers.pending(), 0);

    timers.clock.now = LIVE_REPAINT_COALESCE_MS + 5;
    publish({ kind: "message_delta", text: "abcde", thinking: "" });
    assert.equal(timers.pending(), 1, "a fresh delta schedules the next window");

    timers.clock.now = LIVE_REPAINT_COALESCE_MS + 8;
    publish({ kind: "message_completed", content: [] });
    assert.equal(calls.renders, 3, "structural events render immediately");
    assert.equal(timers.pending(), 0, "the structural flush cancels the pending coalesced timer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlay close and session teardown cancel the pending repaint timer", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-dispose-"));
  try {
    const harness = controllerHarness(root);
    const { state, job, timers, calls, input, controller } = harness;
    input("\x1b[B");
    input("\r");
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "a", thinking: "" });
    timers.clock.now = 10;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "ab", thinking: "" });
    assert.equal(timers.pending(), 1);

    calls.component.handleInput("\x1b"); // Escape closes the open overlay.
    assert.equal(timers.pending(), 0, "overlay close cancels the pending repaint");

    timers.clock.now = 500;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "stale", thinking: "" });
    assert.equal(calls.renders, 1, "events after close repaint nothing");

    input("\x1b[B");
    input("\r");
    timers.clock.now = 600;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "again", thinking: "" });
    timers.clock.now = 610;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "againx", thinking: "" });
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
    const { state, job, timers, calls, input, sessionFile } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "final words", thinking: "" });
    // message_end fires before Pi appends the entry: the completed live copy
    // stays visible, then the run's own completion event flushes.
    state.viewFeed.publish(job.id, { kind: "message_completed", content: boundedAssistantTextParts([{ type: "text", text: "final words" }]) });

    // The store transitioned the job after Pi persisted the final message.
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
    const { state, job, timers, calls, input } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    const overlay = calls.component;
    overlay.applyLiveEvent = () => {
      throw new Error("renderer exploded");
    };
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", text: "hidden", thinking: "" });
    state.viewFeed.publish(job.id, { kind: "message_completed", content: [] });

    assert.ok(calls.renders >= 2, "structural repaints still flow around a throwing renderer");
    const lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /live updates paused after a viewer error/, "the contained failure shows one bounded diagnostic row");
    assert.ok(lines.includes("task text"), "the persisted view keeps rendering");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background integration: feed events flow in order and a broken subscriber changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-live-background-"));
  try {
    const pi = createPiStub();
    process.env.PI_AGENT_DIR = root;
    const state = mockedBackground.createBackgroundState();
    const job = mockedBackground.createQueuedJob({
      state,
      id: ID,
      task: "smoke task",
      cwd: "/tmp/subagents",
      parentSessionId: "parent-session",
      promptSnapshot: createPromptSnapshot(),
    });

    const captured = [];
    state.viewFeed.subscribe(job.id, (event) => captured.push(event.kind));
    state.viewFeed.subscribe(job.id, () => { throw new Error("broken viewer subscriber"); });

    setRunSubagentTaskMock(async (input) => {
      input.onViewEvent?.({ kind: "run_started" });
      input.onViewEvent?.({ kind: "message_delta", text: "partial", thinking: "" });
      input.onViewEvent?.({ kind: "message_completed", content: [] });
      input.onViewEvent?.({ kind: "run_finished" });
      return {
        details: {
          ...job.details,
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
      job,
      ctx: {},
      task: "smoke task",
      parentSessionId: "parent-session",
    });

    await waitFor(() => state.jobs.get(job.id)?.status === "completed", "job completion");
    await waitFor(() => pi.sent.length === 1, "the ordinary completion delivery");
    assert.deepEqual(captured, ["run_started", "message_delta", "message_completed", "run_finished"]);
    assert.equal(job.details.finalText, "ACK");
    assert.equal(job.details.phase, "completed");
    assert.equal(pi.sent[0].message.customType, "pi-square.subagent-notification",
      "a broken live subscriber leaves the ordinary completion delivery untouched");
  } finally {
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
