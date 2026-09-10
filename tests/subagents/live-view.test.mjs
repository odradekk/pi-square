import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const liveEventsModule = await load(join(packageRoot, "src", "subagents", "live-events.ts"));
const {
  LIVE_FLUSH_BUDGET_MS,
  LIVE_LISTENER_BUDGET_MS,
  LIVE_REPAINT_COALESCE_MS,
  MAX_LIVE_ITEMS,
  MAX_PENDING_EVENTS,
  createChildViewFeed,
  deriveChildViewEvent,
  isStructuralViewEvent,
} = liveEventsModule;
const childHistoryModule = await load(join(packageRoot, "src", "subagents", "child-history.ts"));
const {
  createChildHistory,
  boundedAssistantTextParts,
  assistantContentKey,
  callKeyOf,
  MAX_ASSISTANT_PARTS,
} = childHistoryModule;
const viewerModule = await load(join(packageRoot, "src", "subagents", "viewer.ts"));
const { ChildTranscriptOverlay } = viewerModule;
const rosterModule = await load(join(packageRoot, "src", "subagents", "roster.ts"));
const { createSubagentRosterController } = rosterModule;
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const { createBackgroundState } = backgroundModule;
const artifactsModule = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const { ensureArtifactsDir, initializeSessionFile, writeRunState } = artifactsModule;
const helpers = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));
const { createPromptSnapshot, createPiStub, setRunSubagentTaskMock, waitFor } = helpers;
// The registrar loaded with the background module captured for teardown tests.
const capturePath = join(packageRoot, "tests", "subagents", "lib", "background-capture.mjs");
// One cached loader for the registrar and its aliased background capture, so
// both share a single capture-module instance.
const registrarLoad = jiti(import.meta.url, { alias: { "./background": capturePath } });
const registrarCapture = registrarLoad(capturePath);
const registrarModule = registrarLoad(join(packageRoot, "src", "subagents", "index.ts"));
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
const PAGE_UP = "\x1b[5~";

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

function completedAtCurrentEnd(sessionFile, content, timestamp) {
  return {
    kind: "message_completed",
    content: boundedAssistantTextParts(content),
    timestamp,
    historyFloor: statSync(sessionFile).size,
  };
}

/** A feed with a manually driven scheduler; structural prefixes may drain together. */
function manualFeed(scheduleOverride, now) {
  const steps = [];
  const feed = createChildViewFeed({
    schedule: scheduleOverride ?? ((callback) => steps.push(callback)),
    ...(now !== undefined ? { now } : {}),
  });
  return {
    feed,
    deliver: () => {
      const callback = steps.shift();
      if (callback !== undefined) callback();
    },
    deliverAll: () => {
      while (steps.length > 0) {
        const callback = steps.shift();
        if (callback !== undefined) callback();
      }
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

test("a completion carries the native message timestamp as publish-time identity", () => {
  const event = deriveChildViewEvent({
    type: "message_end",
    message: { role: "assistant", timestamp: 1_735_689_600_123, content: [{ type: "text", text: "Done" }] },
  });
  assert.equal(event.timestamp, 1_735_689_600_123);
  const without = deriveChildViewEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  });
  assert.equal(without.timestamp, undefined);
});

test("deltas keep native text/thinking interleaving order and stay sanitized and bounded", () => {
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

  assert.equal(deriveChildViewEvent({ type: "message_update", message: { role: "user", content: [] } }), undefined);
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
  assert.equal(started.callKey, callKeyOf("call-9"));
  assert.ok(Number.isFinite(started.startedAt), "tool start carries a clock for the live duration");

  const unknown = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: "call-x",
    toolName: "totally_custom",
    args: { anything: "raw" },
  });
  assert.deepEqual(
    { ...unknown, startedAt: 0 },
    { kind: "tool_started", callKey: callKeyOf("call-x"), name: "tool", summary: "called", startedAt: 0 },
  );

  const updated = deriveChildViewEvent({
    type: "tool_execution_update",
    toolCallId: "call-9",
    toolName: "grep",
    partialResult: { content: [{ type: "text", text: "partial SECRET" }] },
  });
  assert.deepEqual(updated, { kind: "tool_updated", callKey: callKeyOf("call-9"), name: "grep" });

  const finished = deriveChildViewEvent({
    type: "tool_execution_end",
    toolCallId: "call-9",
    toolName: "grep",
    isError: true,
    result: { content: [{ type: "text", text: "SECRET FAILURE BODY" }] },
  });
  assert.deepEqual(finished, { kind: "tool_finished", callKey: callKeyOf("call-9"), name: "grep", summary: "called", isError: true });
});

test("live and persisted tools share one exact non-reversible call identity", () => {
  const nativeCallId = `${"a".repeat(100)}${"b".repeat(100)}`;
  const started = deriveChildViewEvent({
    type: "tool_execution_start",
    toolCallId: nativeCallId,
    toolName: "grep",
    args: { pattern: "x" },
  });
  const persisted = childHistoryModule.projectSessionEntries([
    messageEntry("e1", {
      role: "assistant",
      content: [{ type: "toolCall", id: nativeCallId, name: "grep", arguments: { pattern: "x" } }],
    }),
  ]).items.find((item) => item.kind === "toolCall");
  assert.equal(started.callKey, persisted.callKey,
    "long native IDs are hashed identically instead of passing through incompatible truncation");
  assert.ok(!JSON.stringify(started).includes(nativeCallId), "the raw native ID never enters the event");
});

test("both projections share one bounded projection, beyond any live-only cap", () => {
  // Regression (review round 2): the live and persisted projections must be
  // the same bounded function, so part counts at or beyond the shared bound
  // still reconcile exactly.
  const build = (count) => {
    const content = [];
    for (let index = 0; index < count; index += 1) {
      content.push(index % 2 === 0 ? { type: "text", text: `part ${index}` } : { type: "thinking", thinking: `t ${index}` });
    }
    return content;
  };

  const within = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content: build(200) } });
  assert.equal(within.content.length, 200);
  const persistedWithin = childHistoryModule.projectSessionEntries([
    messageEntry("e1", { role: "assistant", content: build(200) }),
  ]).items.find((item) => item.kind === "assistant");
  assert.equal(JSON.stringify(within.content), JSON.stringify(persistedWithin.message.content));

  const over = deriveChildViewEvent({ type: "message_end", message: { role: "assistant", content: build(MAX_ASSISTANT_PARTS + 100) } });
  assert.equal(over.content.length, MAX_ASSISTANT_PARTS, "the shared part bound applies to both sides identically");
  const persistedOver = childHistoryModule.projectSessionEntries([
    messageEntry("e2", { role: "assistant", content: build(MAX_ASSISTANT_PARTS + 100) }),
  ]).items.find((item) => item.kind === "assistant");
  assert.equal(JSON.stringify(over.content), JSON.stringify(persistedOver.message.content));
});

test("derivation ignores malformed events without throwing", () => {
  assert.equal(deriveChildViewEvent(undefined), undefined);
  assert.equal(deriveChildViewEvent(null), undefined);
  assert.equal(deriveChildViewEvent("agent_start"), undefined);
  assert.equal(deriveChildViewEvent({}), undefined);
  assert.equal(deriveChildViewEvent({ type: "message_end", message: 5 }), undefined);
  assert.deepEqual(
    deriveChildViewEvent({ type: "tool_execution_start", toolName: null, args: null }),
    { kind: "live_events_dropped", droppedUnknown: true },
    "a tool event without its native call identity becomes a visible fail-closed omission",
  );
});

test("structural classification separates completion from streaming deltas", () => {
  for (const kind of ["message_delta", "tool_updated"]) {
    assert.equal(isStructuralViewEvent({ kind, parts: [], callKey: "", name: "" }), false, kind);
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
      timestamp: 1_000,
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
    assert.deepEqual(events[6], {
      kind: "message_completed",
      content: boundedAssistantTextParts([{ type: "text", text: "# Final\n\nComplete answer." }]),
      timestamp: 1_000,
    });

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
      busyWait(10);
    });

    await __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      onViewEvent(event) { feed.publish(ID, event); },
    }).then(() => {
      observed.runDone = true;
    });
    for (let tick = 0; tick < 10 && observed.invocations < 4; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(observed.illegal, 0, "no subscriber work ran during dispatch or before the run resolved");
    assert.ok(observed.invocations >= 4, "the decoupled flush still delivers every coalesced event");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test("scheduled viewer work cannot materially delay the child's next continuation", async () => {
  // A scheduled callback still shares Node's event-loop thread. Give the
  // child one continuation turn before viewer delivery and enforce a real
  // watchdog when the callback eventually runs.
  const feed = createChildViewFeed();
  let invoked = 0;
  feed.subscribe(ID, () => {
    invoked += 1;
    busyWait(300);
  });
  feed.publish(ID, { kind: "run_started" });
  const startedAt = Date.now();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Date.now() - startedAt < 100, "the child continuation runs before viewer work");
  for (let turn = 0; turn < 4 && invoked === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(invoked, 1, "the isolated delivery still attempts the subscriber once");
  feed.clear();
});

test("a child that yields between events is never blocked behind a batch of deliveries", async () => {
  // Regression (review round 2): each scheduler tick delivers exactly one
  // event, so a child continuation that yields between its events never waits
  // behind more than one delivered event's subscriber work.
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-live-interleave-"));
  try {
    const feed = createChildViewFeed();
    const trace = [];
    const script = async (emit, session) => {
      emit({ type: "agent_start" });
      for (let step = 0; step < 3; step += 1) {
        emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `s${step}a` }] } });
        emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `s${step}b` }] } });
        trace.push(`child-step-${step}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    };
    feed.subscribe(ID, () => {
      trace.push("delivery");
      busyWait(5);
    });
    await __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      onViewEvent(event) { feed.publish(ID, event); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Between two child continuations, at most one delivery may run; the
    // child's final emits have no following continuation to delay.
    const lastStep = trace.map((entry) => entry.startsWith("child")).lastIndexOf(true);
    let longestRun = 0;
    let run = 0;
    for (const entry of trace.slice(0, lastStep + 1)) {
      if (entry === "delivery") run += 1;
      else {
        longestRun = Math.max(longestRun, run);
        run = 0;
      }
    }
    assert.ok(longestRun <= 1, `one delivery per child yield, saw a run of ${longestRun}: ${trace.join(",")}`);
    assert.ok(trace.includes("child-step-2"), "the child run progressed through every yield");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Feed

test("the feed is ephemeral: no subscribers means no work and no buffering", () => {
  const { feed, deliverAll, pending } = manualFeed();
  feed.publish("child-1", { kind: "run_started" });
  assert.equal(pending(), 0, "an unobserved child creates no scheduled work or retained event");
  deliverAll();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(seen, ["run_finished"]);
});

test("delivery is ordered, isolated, asynchronous, and structural-boundary aware", () => {
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
  assert.deepEqual(healthy, ["run_started", "message_completed"],
    "one scheduled tick drains through the newest queued structural boundary");
  deliver();
  assert.deepEqual(healthy, ["run_started", "message_completed"]);
  deliver();
  assert.deepEqual(healthy, ["run_started", "message_completed"], "an empty queue schedules nothing");
});

test("a delta never reorders across a structural boundary of its child", () => {
  // Regression (review round 2): the minimal FIFO race — delta A, completion
  // A, delta B must deliver in exactly that order; the old backward scan
  // replaced delta A in place with B's payload ahead of the completion.
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event));
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "A" }] });
  feed.publish("child-1", { kind: "message_completed", content: [{ type: "text", text: "A done" }], timestamp: 1 });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "B" }] });
  deliverAll();
  assert.deepEqual(seen.map((event) => event.kind), ["message_delta", "message_completed", "message_delta"]);
  assert.deepEqual(seen[0].parts, [{ type: "text", text: "A" }], "delta A keeps its own payload and position");
  assert.deepEqual(seen[2].parts, [{ type: "text", text: "B" }], "delta B stays behind the completion boundary");
});

test("adjacent cumulative deltas still coalesce in place without disturbing order", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event));
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "a" }] });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "ab" }] });
  feed.publish("child-1", { kind: "tool_started", callKey: callKeyOf("c1"), name: "grep", summary: "called", startedAt: 1 });
  feed.publish("child-1", { kind: "message_delta", parts: [{ type: "text", text: "abc" }] });
  deliverAll();
  assert.deepEqual(seen.map((event) => event.kind), ["message_delta", "tool_started", "message_delta"]);
  assert.deepEqual(seen[0].parts, [{ type: "text", text: "ab" }], "adjacent deltas coalesce to the newest payload");
  assert.deepEqual(seen[2].parts, [{ type: "text", text: "abc" }], "the post-boundary delta keeps its own position");
});

test("a listener that overruns the time budget is evicted after one overrun", () => {
  // Regression (review round 2): the feed stays on this thread, so a listener
  // is time-budgeted; an overrunning listener is evicted after one delivery
  // instead of repeatedly preempting everything else.
  const feed = createChildViewFeed();
  const healthy = [];
  let slowInvocations = 0;
  feed.subscribe(ID, () => {
    slowInvocations += 1;
    busyWait(LIVE_LISTENER_BUDGET_MS + 60);
  });
  feed.subscribe(ID, (event) => healthy.push(event.kind));
  feed.publish(ID, { kind: "run_started" });
  feed.publish(ID, { kind: "tool_result_completed" });
  feed.publish(ID, { kind: "run_finished" });
  return new Promise((resolve, reject) => {
    const settle = setInterval(() => {
      if (healthy.length >= 3) {
        clearInterval(settle);
        try {
          assert.equal(slowInvocations, 1, "the overrunning listener delivered at most once");
          assert.deepEqual(healthy, ["run_started", "tool_result_completed", "run_finished"],
            "the healthy listener keeps receiving every event");
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    }, 10);
    setTimeout(() => {
      clearInterval(settle);
      reject(new Error(`eviction did not settle: slow=${slowInvocations} healthy=${healthy.length}`));
    }, 5_000).unref?.();
  });
});

test("the listener watchdog interrupts one blocking callback within a bounded turn", () => {
  const { feed, deliver } = manualFeed();
  let healthy = 0;
  feed.subscribe(ID, () => busyWait(LIVE_LISTENER_BUDGET_MS * 4));
  feed.subscribe(ID, () => { healthy += 1; });
  feed.publish(ID, { kind: "run_started" });
  const startedAt = Date.now();
  deliver();
  assert.ok(Date.now() - startedAt < LIVE_LISTENER_BUDGET_MS * 3,
    "the callback is interrupted rather than merely measured after returning");
  assert.equal(healthy, 0, "the exhausted total budget yields before the healthy sibling");
  deliver();
  assert.equal(healthy, 1, "a blocked sibling cannot prevent healthy delivery on the next tick");
});

test("a scheduler that throws never flushes inline and the queue stays bounded", () => {
  // Regression (review round 2): the old inline fallback re-ran subscriber
  // work inside the publishing stack. A broken scheduler must drop nothing
  // synchronously; a later working scheduler drains the retained queue.
  const steps = [];
  let broken = true;
  const feed = createChildViewFeed({
    schedule: (callback) => {
      if (broken) throw new Error("scheduler unavailable");
      steps.push(callback);
    },
  });
  const seen = [];
  let syncDelivery = 0;
  let inPublish = false;
  feed.subscribe(ID, (event) => {
    if (inPublish) syncDelivery += 1;
    seen.push(event.kind);
  });
  inPublish = true;
  feed.publish(ID, { kind: "run_started" });
  feed.publish(ID, { kind: "message_completed", content: [] });
  inPublish = false;
  assert.deepEqual(seen, [], "a throwing scheduler delivers nothing, inline or otherwise");

  broken = false;
  feed.publish(ID, { kind: "run_finished" });
  for (let tick = 0; tick < 5 && steps.length > 0; tick += 1) {
    const callback = steps.shift();
    if (callback !== undefined) callback();
  }
  assert.deepEqual(seen, ["run_started", "message_completed", "run_finished"],
    "a recovered scheduler drains the retained queue in order");
  assert.equal(syncDelivery, 0);
});

test("a recovered scheduler retries when the only later publication coalesces a delta", () => {
  const steps = [];
  let broken = true;
  const feed = createChildViewFeed({
    schedule: (callback) => {
      if (broken) throw new Error("scheduler unavailable");
      steps.push(callback);
    },
  });
  const seen = [];
  feed.subscribe(ID, (event) => seen.push(event));
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "old" }] });
  broken = false;
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "new" }] });
  assert.equal(steps.length, 1, "the coalesced publication retries scheduling");
  steps.shift()?.();
  assert.deepEqual(seen, [{ kind: "message_delta", parts: [{ type: "text", text: "new" }] }]);
});

test("a bounded pending queue drops the oldest with one visible omission marker", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe("child-1", (event) => seen.push(event.kind));
  for (let index = 0; index < MAX_PENDING_EVENTS + 5; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  deliverAll();
  assert.ok(seen.length <= MAX_PENDING_EVENTS, "the delivered stream stays within the hard queue bound");
  assert.equal(seen[0], "live_events_dropped", "the drop is explicit, never silent");
});

test("overflow across many observed children never exceeds the total feed bound", () => {
  const { feed, deliverAll } = manualFeed();
  let delivered = 0;
  for (let child = 0; child < MAX_PENDING_EVENTS + 44; child += 1) {
    feed.subscribe(`child-${child}`, () => { delivered += 1; });
  }
  for (let index = 0; index < MAX_PENDING_EVENTS + 44; index += 1) {
    feed.publish(`child-${index}`, { kind: "tool_result_completed" });
  }
  deliverAll();
  assert.ok(delivered <= MAX_PENDING_EVENTS, `delivered ${delivered} entries past the hard bound`);
});

test("a structural event is delivered in the first flush despite an ordinary-update backlog", () => {
  let clock = 0;
  const { feed, deliver } = manualFeed(undefined, () => clock);
  const seen = [];
  feed.subscribe(ID, (event) => {
    seen.push(event.kind);
    clock += 20;
  });
  for (let index = 0; index < 80; index += 1) {
    feed.publish(ID, { kind: "tool_updated", callKey: callKeyOf(`call-${index}`), name: "grep" });
  }
  feed.publish(ID, { kind: "tool_finished", callKey: callKeyOf("call-final"), name: "grep", isError: false });
  deliver();
  assert.deepEqual(seen, ["tool_finished"], "superseded ordinary updates cannot strand the boundary");
});

test("a slow subscriber cannot monopolize one structural flush", () => {
  let clock = 0;
  const { feed, deliver, pending } = manualFeed(undefined, () => clock);
  const seen = [];
  feed.subscribe(ID, (event) => {
    seen.push(event.kind);
    clock += 20;
  });
  feed.publish(ID, { kind: "tool_started", callKey: callKeyOf("slow"), name: "grep", summary: "called", startedAt: 1 });
  feed.publish(ID, { kind: "run_finished" });

  deliver();
  assert.equal(clock, 20, "one flush spends only its deterministic total budget");
  assert.deepEqual(seen, ["tool_started"], "the remaining structural boundary yields to another scheduler turn");
  assert.equal(pending(), 1, "the remainder is scheduled rather than dropped");
});

test("run completion keeps only the newest cumulative assistant partial", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  feed.subscribe(ID, (event) => seen.push(event));
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "old" }] });
  feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "final partial" }] });
  feed.publish(ID, { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(seen, [
    { kind: "message_delta", parts: [{ type: "text", text: "final partial" }] },
    { kind: "run_finished" },
  ]);
});

test("the total flush budget applies across distinct subscribers", () => {
  let clock = 0;
  const { feed, deliver, pending } = manualFeed(undefined, () => clock);
  let delivered = 0;
  for (let index = 0; index < 8; index += 1) {
    feed.subscribe(ID, () => {
      delivered += 1;
      clock += 20;
    });
  }
  feed.publish(ID, { kind: "run_finished" });

  deliver();
  assert.equal(clock, 20, "subscriber fan-out stays inside one deterministic total turn budget");
  assert.equal(delivered, 1, "later subscribers yield rather than accumulating their budgets");
  assert.equal(pending(), 1, "fan-out resumes at the next subscriber position");
});

test("overflow markers carry the dropped completions' fingerprints for recovery", () => {
  const { feed, deliverAll } = manualFeed();
  const markers = [];
  feed.subscribe("child-1", (event) => {
    if (event.kind === "live_events_dropped") markers.push(event);
  });
  for (let index = 0; index < MAX_PENDING_EVENTS + 2; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  feed.publish("child-1", { kind: "message_completed", content: [{ type: "text", text: "final" }], timestamp: 42 });
  for (let index = 0; index < MAX_PENDING_EVENTS + 2; index += 1) {
    feed.publish("child-1", { kind: "tool_result_completed" });
  }
  deliverAll();
  assert.ok(markers.length > 0, "overflow produced at least one marker");
  assert.ok(markers.some((marker) => marker.droppedUnknown === true),
    "unfingerprintable dropped lifecycle events remain explicitly unknown");
  assert.ok(markers.some((marker) => (marker.dropped ?? []).some(
    (entry) => entry.kind === "message" && entry.timestamp === 42,
  )), "the dropped completion's fingerprint travels with the marker");
});

test("unsubscribe, clear, and the subscriber bound hold", () => {
  const { feed, deliverAll } = manualFeed();
  const seen = [];
  const unsubscribe = feed.subscribe("child-1", (event) => seen.push(event.kind));
  feed.publish("child-1", { kind: "run_started" });
  deliverAll();
  unsubscribe();
  feed.publish("child-1", { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(seen, ["run_started"]);

  for (let index = 0; index < 8; index += 1) feed.subscribe("child-2", () => {});
  const late = [];
  feed.subscribe("child-2", (event) => late.push(event.kind));
  feed.publish("child-2", { kind: "run_started" });
  deliverAll();
  assert.deepEqual(late, [], "the global subscriber bound rejects the ninth subscription");

  feed.clear();
  const before = [];
  feed.subscribe("child-3", (event) => before.push(event.kind));
  feed.publish("child-3", { kind: "run_started" });
  deliverAll();
  assert.deepEqual(before, ["run_started"], "clear releases the global subscriber capacity");
  feed.clear();
  feed.publish("child-3", { kind: "run_finished" });
  deliverAll();
  assert.deepEqual(before, ["run_started"], "clear drops subscribers and later unobserved events");
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

function freshOverlay(root, lines, options = {}) {
  writeChildArtifacts(root, ID, lines);
  return overlayHarness(
    runningModel(createChildHistory(ID, { observedAt: Date.parse("2025-01-01T00:00:05Z") })),
    options.columns ?? 80,
    options.rows ?? 30,
    options.now,
  );
}

function liveOverlayRoot() {
  return mkdtempSync(join(tmpdir(), `pi-square-live-${Math.random().toString(16).slice(2)}-`));
}

test("native history items retain their exact JSONL entry byte offsets", () => {
  const root = liveOverlayRoot();
  try {
    const entries = [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
      messageEntry("e2", { role: "assistant", timestamp: 9_000, content: [{ type: "text", text: "answer" }] }),
    ];
    writeChildArtifacts(root, ID, entries);
    const snapshot = createChildHistory(ID).snapshot();
    const headerBytes = Buffer.byteLength(`${JSON.stringify(sessionHeader())}\n`);
    const firstBytes = Buffer.byteLength(`${JSON.stringify(entries[0])}\n`);
    assert.deepEqual(
      snapshot.items.map((item) => item.entryByteOffset),
      [headerBytes, headerBytes + firstBytes],
      "projected rows keep the native line-start offsets used by live reconciliation",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streaming assistant parts render below the persisted window in native order", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
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
  const root = liveOverlayRoot();
  try {
    const { overlay, } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "Working" }] });
    overlay.applyLiveEvent(completedAtCurrentEnd(
      sessionFile,
      [{ type: "text", text: "Working" }],
      5_000,
    ));
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Working"), 1, "the completed live message stays visible before persistence lands");

    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", timestamp: 5_000, content: [{ type: "text", text: "Working" }] }));
    overlay.applyLiveEvent({ kind: "run_started" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Working"), 1, "reconciliation never duplicates the message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal reconcile before delayed delivery shows the final message exactly once", () => {
  // Regression (review round 2): the background store can transition the job
  // and the roster's terminal reconcile can load the persisted final entry
  // BEFORE the scheduled feed flush delivers the completion. The completion
  // identifies its own occurrence by publish-time timestamp, so it confirms
  // instead of duplicating.
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    // Pi appended the final entry (message timestamp 7_000) and the store
    // transitioned; the overlay reconciles to the terminal state first.
    const historyFloor = statSync(sessionFile).size;
    appendSessionLine(sessionFile, messageEntry("e9", { role: "assistant", timestamp: 7_000, content: [{ type: "text", text: "final words" }] }));
    overlay.updateLifecycle({ status: "completed", lifecycleLabel: "✓ completed", lifecycleTone: "success", durationText: "9s" });
    overlay.reconcileNow(8);
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "final words"), 1, "the persisted final shows once");

    // Only now does the scheduled flush deliver the queued completion.
    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "final words" }] });
    overlay.applyLiveEvent({
      kind: "message_completed",
      content: boundedAssistantTextParts([{ type: "text", text: "final words" }]),
      timestamp: 7_000,
      historyFloor,
    });
    overlay.applyLiveEvent({ kind: "run_finished" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "final words"), 1,
      "the delayed completion confirms against its own persisted occurrence instead of duplicating");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distinct pre-append floors keep identical completions occurrence-exact", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    overlay.applyLiveEvent(completedAtCurrentEnd(sessionFile, [{ type: "text", text: "Same words" }], 9_000));
    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", timestamp: 9_000, content: [{ type: "text", text: "Same words" }] }));
    appendSessionLine(sessionFile, messageEntry("e8", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c9", name: "grep", arguments: { pattern: "x" } }],
    }));
    overlay.applyLiveEvent(completedAtCurrentEnd(sessionFile, [{ type: "text", text: "Same words" }], 9_000));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2,
      "the first completion confirms and unrelated prior history cannot consume the second");

    appendSessionLine(sessionFile, messageEntry("e3", { role: "assistant", timestamp: 9_000, content: [{ type: "text", text: "Same words" }] }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2, "its own second occurrence confirms the second completion");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newer completion cannot consume an older occurrence after paging it back in", () => {
  const content = [{ type: "text", text: "same completion" }];
  const persisted = {
    kind: "assistant",
    message: { role: "assistant", content, timestamp: 9_000 },
    entryId: "persisted-once",
    entryByteOffset: 100,
    entryItemIndex: 0,
  };
  const snapshot = { items: [persisted], moreBefore: false, moreAfter: false };
  let changed = false;
  const history = {
    snapshot: () => snapshot,
    loadOlder: () => false,
    loadNewer: () => {
      const result = changed;
      changed = false;
      return result;
    },
    retryInitial: () => false,
  };
  const { overlay } = overlayHarness(runningModel(history));
  const completion = {
    kind: "message_completed",
    content: boundedAssistantTextParts(content),
    timestamp: 9_000,
    historyFloor: 100,
  };

  overlay.applyLiveEvent(completion);
  overlay.applyLiveEvent({ ...completion, historyFloor: 200 });
  snapshot.items = [];
  changed = true;
  overlay.applyLiveEvent({ kind: "tool_result_completed" });
  snapshot.items = [persisted];
  changed = true;
  overlay.applyLiveEvent({ kind: "tool_result_completed" });

  assert.equal(occurrences(plain(overlay.render(64)).join("\n"), "same completion"), 2,
    "the reloaded old row cannot consume the still-unpersisted second completion");
});

test("delayed identical completions cannot both consume the newer loaded occurrence", () => {
  const content = [{ type: "text", text: "delayed identical" }];
  const newer = {
    kind: "assistant",
    message: { role: "assistant", content, timestamp: 9_000 },
    entryId: "newer-loaded",
    entryByteOffset: 200,
    entryItemIndex: 0,
  };
  const history = {
    snapshot: () => ({ items: [newer], moreBefore: true, moreAfter: false }),
    loadOlder: () => false,
    loadNewer: () => false,
    retryInitial: () => false,
  };
  const { overlay } = overlayHarness(runningModel(history));
  overlay.applyLiveEvent({ kind: "message_completed", content, timestamp: 9_000, historyFloor: 100 });
  overlay.applyLiveEvent({ kind: "message_completed", content, timestamp: 9_000, historyFloor: 200 });
  assert.equal(occurrences(plain(overlay.render(64)).join("\n"), "delayed identical"), 2,
    "the newer row confirms only the completion whose pre-append floor it equals");
});

test("page up reconciles a live completion against the older page it loads", () => {
  const content = [{ type: "text", text: "paged completion" }];
  const persisted = {
    kind: "assistant",
    message: { role: "assistant", content, timestamp: 9_000 },
    entryId: "older-match",
    entryByteOffset: 100,
    entryItemIndex: 0,
  };
  const recent = { kind: "generic", text: "recent", entryId: "recent", entryByteOffset: 200, entryItemIndex: 0 };
  const snapshot = { items: [recent], moreBefore: true, moreAfter: false };
  const history = {
    snapshot: () => snapshot,
    loadOlder: () => {
      snapshot.items = [persisted, recent];
      snapshot.moreBefore = false;
      return true;
    },
    loadNewer: () => false,
    retryInitial: () => false,
  };
  const { overlay } = overlayHarness(runningModel(history), 64, 30);
  overlay.applyLiveEvent({ kind: "message_completed", content, timestamp: 9_000, historyFloor: 100 });
  overlay.render(64);
  overlay.handleInput(PAGE_UP);
  assert.equal(occurrences(plain(overlay.render(64)).join("\n"), "paged completion"), 1,
    "demand paging confirms the live row as soon as its persisted occurrence enters the window");
});

test("occurrence matching follows append position, not a wall-clock timestamp", () => {
  const firstContent = [{ type: "text", text: "first" }];
  const secondContent = [{ type: "text", text: "clock moved backward" }];
  const snapshot = {
    items: [{
      kind: "assistant",
      message: { role: "assistant", content: firstContent, timestamp: 2_000 },
      entryId: "first",
      entryByteOffset: 100,
      entryItemIndex: 0,
    }],
    moreBefore: false,
    moreAfter: false,
  };
  let changed = false;
  const history = {
    snapshot: () => snapshot,
    loadOlder: () => false,
    loadNewer: () => {
      const result = changed;
      changed = false;
      return result;
    },
    retryInitial: () => false,
  };
  const { overlay } = overlayHarness(runningModel(history));
  overlay.applyLiveEvent({ kind: "message_completed", content: firstContent, timestamp: 2_000, historyFloor: 100 });
  snapshot.items = [];
  changed = true;
  overlay.applyLiveEvent({ kind: "tool_result_completed" });

  snapshot.items = [{
    kind: "assistant",
    message: { role: "assistant", content: secondContent, timestamp: 1_000 },
    entryId: "second",
    entryByteOffset: 200,
    entryItemIndex: 0,
  }];
  changed = true;
  overlay.applyLiveEvent({ kind: "tool_result_completed" });
  overlay.applyLiveEvent({ kind: "message_completed", content: secondContent, timestamp: 1_000, historyFloor: 200 });
  assert.equal(occurrences(plain(overlay.render(64)).join("\n"), "clock moved backward"), 1,
    "a later JSONL occurrence confirms even when its wall clock moved backward");
});

test("a pre-existing identical message never consumes a newer completion", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
      messageEntry("e2", { role: "assistant", timestamp: 1_000, content: [{ type: "text", text: "Same words" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    appendSessionLine(sessionFile, messageEntry("e8", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c9", name: "grep", arguments: { pattern: "x" } }],
    }));
    overlay.applyLiveEvent(completedAtCurrentEnd(
      sessionFile,
      [{ type: "text", text: "Same words" }],
      8_000,
    ));
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2,
      "the live copy stays: the old identical message carries a different timestamp");

    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2, "unrelated persisted history consumes nothing");

    appendSessionLine(sessionFile, messageEntry("e9", { role: "assistant", timestamp: 8_000, content: [{ type: "text", text: "Same words" }] }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Same words"), 2, "two persisted occurrences show, no live duplicate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a message longer than any live part cap reconciles exactly", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ], { rows: 400 });
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    const content = [];
    for (let index = 0; index < 200; index += 1) {
      content.push({ type: "text", text: `part ${index}` });
    }
    const completed = deriveChildViewEvent({
      type: "message_end",
      message: { role: "assistant", timestamp: 3_000, content },
    });
    assert.equal(completed.kind, "message_completed");
    overlay.applyLiveEvent({ ...completed, historyFloor: statSync(sessionFile).size });
    let lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("part 199"));

    appendSessionLine(sessionFile, messageEntry("e2", { role: "assistant", timestamp: 3_000, content }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "part 0"), 1, "the exact projection confirms and never duplicates");
    assert.equal(occurrences(lines, "part 199"), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live tail overflow sheds the oldest with an explicit omission state and recovers", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ], { rows: 400 });
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    const total = MAX_LIVE_ITEMS + 4;
    const unrelated = messageEntry("u1", {
      role: "assistant",
      content: [{ type: "toolCall", id: "cu", name: "grep", arguments: { pattern: "x" } }],
    });
    const persisted = Array.from({ length: total }, (_, index) => messageEntry(`p${index}`, {
      role: "assistant",
      timestamp: 10_000 + index,
      content: [{ type: "text", text: `completion ${index}` }],
    }));
    let nextOffset = statSync(sessionFile).size + Buffer.byteLength(`${JSON.stringify(unrelated)}\n`);
    for (let index = 0; index < total; index += 1) {
      overlay.applyLiveEvent({
        kind: "message_completed",
        content: boundedAssistantTextParts([{ type: "text", text: `completion ${index}` }]),
        timestamp: 10_000 + index,
        historyFloor: nextOffset,
      });
      nextOffset += Buffer.byteLength(`${JSON.stringify(persisted[index])}\n`);
    }
    let lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("completion 0"), "the oldest overflow entry is dropped");
    assert.ok(lines.includes(`completion ${total - 1}`), "the newest entry never drops");
    assert.match(lines, /older live updates were dropped/, "the drop is an explicit omission state");

    // An unrelated append recovers nothing: the omission state stays.
    appendSessionLine(sessionFile, unrelated);
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /older live updates were dropped/, "an unrelated append does not clear the omission state");
    assert.ok(!lines.includes("completion 0"), "the dropped entry is still unrecovered");

    for (const entry of persisted) appendSessionLine(sessionFile, entry);
    overlay.applyLiveEvent({ kind: "run_finished" });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("older live updates were dropped"), "actual recovery clears the omission state");
    assert.ok(lines.includes("completion 0") && lines.includes(`completion ${total - 1}`),
      "persisted history recovers every dropped message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate dropped completions require distinct persisted occurrences to recover", () => {
  const root = liveOverlayRoot();
  try {
    const content = boundedAssistantTextParts([{ type: "text", text: "same dropped completion" }]);
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);
    const first = messageEntry("e2", { role: "assistant", timestamp: 7_000, content });
    const firstFloor = statSync(sessionFile).size;
    const secondFloor = firstFloor + Buffer.byteLength(`${JSON.stringify(first)}\n`);
    overlay.applyLiveEvent({
      kind: "live_events_dropped",
      dropped: [
        { kind: "message", key: assistantContentKey(content), timestamp: 7_000, historyFloor: firstFloor },
        { kind: "message", key: assistantContentKey(content), timestamp: 7_000, historyFloor: secondFloor },
      ],
    });

    appendSessionLine(sessionFile, first);
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    let lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /older live updates were dropped/,
      "one persisted occurrence cannot recover two dropped occurrences");

    appendSessionLine(sessionFile, messageEntry("e3", { role: "assistant", timestamp: 7_000, content }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("older live updates were dropped"),
      "the second distinct occurrence completes recovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dropped tool end recovers only after its own persisted result", () => {
  const root = liveOverlayRoot();
  try {
    const callId = "call-terminal-recovery";
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);
    overlay.applyLiveEvent({
      kind: "live_events_dropped",
      dropped: [{ kind: "tool", callKey: callKeyOf(callId), name: "grep", terminal: true }],
    });
    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "grep", arguments: { pattern: "x" } }],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    let lines = plain(overlay.render(64)).join("\n");
    assert.match(lines, /older live updates were dropped/,
      "the call row alone does not recover the dropped terminal state");

    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "toolResult", toolCallId: callId, toolName: "grep", isError: false, content: [],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("older live updates were dropped"),
      "the call's persisted result recovers the terminal state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unfingerprintable feed drop still renders a sticky omission state", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    overlay.applyLiveEvent({ kind: "live_events_dropped", droppedUnknown: true });
    assert.match(plain(overlay.render(64)).join("\n"), /older live updates were dropped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed tool event cannot reconcile by name and stays visibly omitted", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    overlay.applyLiveEvent({ kind: "tool_started", callKey: "", name: "grep", summary: "called", startedAt: 1 });
    assert.match(plain(overlay.render(64)).join("\n"), /older live updates were dropped/);

    overlay.applyLiveEvent({ kind: "run_finished" });
    assert.match(plain(overlay.render(64)).join("\n"), /older live updates were dropped/,
      "history cannot prove recovery without a call identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live tool start, update, and end are observable without any persisted append", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "search things" }] }),
    ], { now: 5_000 });
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "tool_started", callKey: callKeyOf("c1"), name: "grep", summary: "called", startedAt: 1_000 });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "a running live tool row appears immediately");
    assert.ok(!lines.includes("SECRET"), "no raw argument ever renders");

    overlay.applyLiveEvent({ kind: "tool_updated", callKey: callKeyOf("c1"), name: "grep" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "an update leaves exactly one row");

    overlay.applyLiveEvent({ kind: "tool_finished", callKey: callKeyOf("c1"), name: "grep", isError: true });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "the same row flips in place");
    assert.match(lines, /Tool failed/, "the end state shows immediately, before any toolResult append");

    overlay.applyLiveEvent({ kind: "tool_finished", callKey: callKeyOf("c2"), name: "find", isError: false });
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("Find"), "a finish without a start still renders a live row");
    assert.match(lines, /Completed/);

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

test("same-name calls reconcile per call id, never per name aggregate", () => {
  // Regression (review round 2): two live grep rows finish; history persists
  // both call rows but only one result. Per-name counting dropped both live
  // rows; per-call identity keeps the unresolved one visible exactly once.
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ], { now: 9_000 });
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "tool_started", callKey: callKeyOf("g1"), name: "grep", summary: "called", startedAt: 1_000 });
    overlay.applyLiveEvent({ kind: "tool_started", callKey: callKeyOf("g2"), name: "grep", summary: "called", startedAt: 1_500 });
    let lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 2, "both live rows render");

    overlay.applyLiveEvent({ kind: "tool_finished", callKey: callKeyOf("g1"), name: "grep", isError: false });
    overlay.applyLiveEvent({ kind: "tool_finished", callKey: callKeyOf("g2"), name: "grep", isError: true });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 2, "both rows keep their own terminal state");

    // One assistant message with both same-name calls, only one result.
    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant",
      content: [
        { type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "a" } },
        { type: "toolCall", id: "g2", name: "grep", arguments: { pattern: "b" } },
      ],
    }));
    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "toolResult", toolCallId: "g1", toolName: "grep", isError: false,
      content: [{ type: "text", text: "SECRET RESULT BODY" }],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 2,
      "the resolved call's live row sheds and its persisted row renders; the unresolved call keeps exactly one row");
    assert.ok(!lines.includes("SECRET RESULT BODY"));

    appendSessionLine(sessionFile, messageEntry("e4", {
      role: "toolResult", toolCallId: "g2", toolName: "grep", isError: true,
      content: [{ type: "text", text: "SECRET RESULT BODY" }],
    }));
    overlay.applyLiveEvent({ kind: "tool_result_completed" });
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 2, "both persisted rows now carry their own results, no live rows left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool call already covered by persisted history adds no duplicate live row", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const sessionFile = join(process.env.PI_AGENT_DIR, "state", "subagents", ID, "session.jsonl");
    overlay.render(64);
    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "x" } }],
    }));
    overlay.applyLiveEvent({ kind: "tool_started", callKey: callKeyOf("c1"), name: "grep", summary: "called", startedAt: 1_000 });
    const lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Grep"), 1, "the persisted running row covers the call; no live duplicate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a final message that never persists is not lost while the overlay stays open", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    overlay.render(64);

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "Final answer text" }] });
    overlay.applyLiveEvent({
      kind: "message_completed",
      content: boundedAssistantTextParts([{ type: "text", text: "Final answer text" }]),
      timestamp: 6_000,
    });
    overlay.applyLiveEvent({ kind: "run_finished" });

    const lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "Final answer text"), 1,
      "run_finished without a persisted copy keeps the final buffered content visible");

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "uncommitted tail" }] });
    overlay.applyLiveEvent({ kind: "run_finished" });
    assert.ok(plain(overlay.render(64)).join("\n").includes("uncommitted tail"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a view scrolled away from the tail is not pulled back by live growth", () => {
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "first line of a long task" }] }),
      messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "second entry with body text" }] }),
    ], { columns: 80, rows: 12 });
    overlay.render(64);
    overlay.handleInput("\x1b[H");

    overlay.applyLiveEvent({ kind: "message_delta", parts: [{ type: "text", text: "streaming tail content" }] });
    const lines = plain(overlay.render(64)).join("\n");
    assert.ok(!lines.includes("streaming tail content"), "a pinned top viewport ignores new tail content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a queued child shows the waiting state even before a session file exists", () => {
  const root = liveOverlayRoot();
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
  const root = liveOverlayRoot();
  try {
    const { overlay } = freshOverlay(root, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
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
  const { sessionFile } = writeChildArtifacts(root, ID, [
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
  return { state, job, controller, timers, calls, input, tui, sessionFile, deliver: live.deliver, deliverAll: live.deliverAll };
}

test("live deltas coalesce to at most one repaint per window; structure renders immediately", () => {
  const root = liveOverlayRoot();
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
  const root = liveOverlayRoot();
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

    calls.component.handleInput("\x1b");
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

test("a real background terminal order shows the final content exactly once", () => {
  // Regression (review round 2): the store transition reconciles the terminal
  // overlay while the scheduled feed flush is still pending; the queued
  // completion must confirm against its own persisted occurrence.
  const root = liveOverlayRoot();
  try {
    const { state, job, timers, calls, input, sessionFile, deliverAll } = controllerHarness(root);
    input("\x1b[B");
    input("\r");
    timers.clock.now = 0;
    state.viewFeed.publish(job.id, { kind: "message_delta", parts: [{ type: "text", text: "final words" }] });
    const historyFloor = statSync(sessionFile).size;
    state.viewFeed.publish(job.id, {
      kind: "message_completed",
      content: boundedAssistantTextParts([{ type: "text", text: "final words" }]),
      timestamp: 7_000,
      historyFloor,
    });

    appendSessionLine(sessionFile, messageEntry("e9", { role: "assistant", timestamp: 7_000, content: [{ type: "text", text: "final words" }] }));
    job.status = "completed";
    job.details.phase = "completed";
    job.details.endedAt = 9_000;
    job.details.finalText = "final words";
    for (const listener of state.listeners) listener();

    deliverAll();
    assert.ok(calls.renders >= 1, "the terminal transition renders immediately");
    const lines = plain(calls.component.render(64)).join("\n");
    assert.match(lines, /completed/, "the open overlay title shows the final lifecycle");
    assert.equal(occurrences(lines, "final words"), 1, "the final content shows exactly once across both orders");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken overlay renderer is contained as one diagnostic and never stops repaints", () => {
  const root = liveOverlayRoot();
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
  const root = liveOverlayRoot();
  try {
    const pi = createPiStub();
    process.env.PI_AGENT_DIR = root;
    const state = createBackgroundState();
    const mockedBackground = await helpers.loadBackgroundModule();
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
    await waitFor(() => captured.length >= 4, "the decoupled flush drains");
    assert.deepEqual(captured, ["run_started", "message_delta", "message_completed", "run_finished"]);
    assert.equal(queued.details.finalText, "ACK");
    assert.equal(queued.details.phase, "completed");
    assert.equal(pi.sent[0].message.customType, "pi-square.subagent-notification",
      "a broken live subscriber leaves the ordinary completion delivery untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced parent feed fences late events from its still-running child", async () => {
  const root = liveOverlayRoot();
  try {
    process.env.PI_AGENT_DIR = root;
    const pi = createPiStub();
    const state = createBackgroundState();
    const mockedBackground = await helpers.loadBackgroundModule();
    const queued = mockedBackground.createQueuedJob({
      state,
      id: ID,
      task: "old parent task",
      cwd: "/tmp/subagents",
      parentSessionId: "parent-old",
      promptSnapshot: createPromptSnapshot(),
    });
    let oldPublisher;
    let finishRun;
    const finish = new Promise((resolve) => { finishRun = resolve; });
    state.viewFeed.subscribe(ID, () => {});
    setRunSubagentTaskMock(async (input) => {
      oldPublisher = input.onViewEvent;
      await finish;
      return {
        details: {
          ...queued.details,
          phase: "completed",
          finalText: "done",
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
      task: "old parent task",
      parentSessionId: "parent-old",
    });
    await waitFor(() => typeof oldPublisher === "function", "old-generation publisher capture");

    mockedBackground.replaceBackgroundViewFeed(state);
    const seenByNewParent = [];
    state.viewFeed.subscribe(ID, (event) => seenByNewParent.push(event.kind));
    oldPublisher({ kind: "run_started" });
    for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seenByNewParent, [], "the old publisher remains bound to the discarded feed generation");

    finishRun();
    await waitFor(() => queued.status === "completed", "old child cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement and shutdown clear the session-scoped live view feed", async () => {
  // Regression (review rounds 1+2): no subscriber of one parent session may
  // survive into its replacement or past shutdown; observed through the
  // registrar itself, with the background module captured by the test alias.
  const root = liveOverlayRoot();
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
    const capture = registrarCapture;
    capture.__resetCapturedStates();
    registrarModule.default(pi, undefined, () => ({
      version: 2,
      anchoredEditing: { enabled: false, autoRead: true },
    }));
    const states = capture.__capturedStates();
    assert.ok(states.length >= 1, "the registrar created its session-scoped state");
    const state = states.at(-1);
    assert.ok(state.viewFeed, "the registrar owns a session-scoped view feed");

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
    state.viewFeed.subscribe(ID, (event) => seen.push(event.kind));
    await handlers.get("session_start")({}, ctx("parent-1"));
    state.viewFeed.publish(ID, { kind: "run_started" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [], "replacement clears subscribers and undelivered events");

    const after = [];
    const currentState = capture.__capturedStates().at(-1);
    currentState.viewFeed.subscribe(ID, (event) => after.push(event.kind));
    await handlers.get("session_shutdown")();
    currentState.viewFeed.publish(ID, { kind: "run_started" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(after, [], "shutdown clears the session-scoped feed");
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
