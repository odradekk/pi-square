import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

// The ordered transcript one viewer sees for one background child (#371):
// asserted on the transcript module's public interface over the real wiring —
// the module's own pager construction over a real native session file, the
// session feed forwarding through the module's registry, and the overlay
// rendering entry drawing the module's reads. Background registration and the
// child execution seam stay outside this suite (background,
// session-view-events, and roster suites); the feed mechanics and the
// reconciliation rules have focused suites of their own (live-events and
// transcript).
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const transcriptModule = await load(join(packageRoot, "src", "subagents", "transcript.ts"));
const {
  createChildTranscriptRegistry,
  createChildViewFeed,
} = transcriptModule;
const viewerModule = await load(join(packageRoot, "src", "subagents", "viewer.ts"));
const { ChildTranscriptOverlay } = viewerModule;
const { createPromptSnapshot } = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));

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
const OTHER_ID = "subagent_00000000-0000-4000-8000-000000000302";
const SESSION_ID = "019f0000-0000-7000-8000-000000000301";

function sessionHeader() {
  return { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: "/tmp/project" };
}

function messageEntry(id, message, timestamp = "2025-01-01T00:00:00Z") {
  return { type: "message", id, parentId: null, timestamp, message };
}

/**
 * Writes the child's native artifacts (run.json plus the JSONL session file)
 * directly, the layout the artifact boundary validates: the state root below
 * the agent dir, run.json carrying the session-file identity, one regular
 * session file beside it.
 */
function writeChildArtifacts(testRoot, id, lines) {
  process.env.PI_AGENT_DIR = testRoot;
  const artifactsDir = join(testRoot, "state", "subagents", id);
  mkdirSync(artifactsDir, { recursive: true });
  const sessionFile = join(artifactsDir, "session.jsonl");
  writeFileSync(sessionFile, [sessionHeader(), ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify({
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
    timeline: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  }));
  return { artifactsDir, sessionFile };
}

function appendSessionLine(sessionFile, entry) {
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}
/** The same non-reversible call identity the module and its pager share. */
function callKeyOf(nativeCallId) {
  return createHash("sha256").update(nativeCallId).digest("hex");
}

function plain(lines) {
  return lines.map(stripVTControlCharacters);
}

function transcriptRoot() {
  return mkdtempSync(join(tmpdir(), `pi-square-live-view-${Math.random().toString(16).slice(2)}-`));
}

/** A session feed with a manually driven scheduler. */
function manualFeed() {
  const steps = [];
  const feed = createChildViewFeed({ schedule: (callback) => steps.push(callback) });
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
  };
}

// ---------------------------------------------------------------------------
// One ordered transcript over the module's real wiring

test("the registry composes one ordered transcript from the feed and the pager", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task text" }] }),
      messageEntry("e2", { role: "assistant", timestamp: 1_000, content: [{ type: "text", text: "first answer" }] }),
    ]);
    const { feed, deliver } = manualFeed();
    const registry = createChildTranscriptRegistry({ feed: () => feed, now: () => 0 });
    const transcript = registry.observe(ID);
    const changes = [];
    transcript.subscribe((change) => changes.push(change));

    // The module constructs the pager: the initial persisted window is
    // already reconciled and readable through one snapshot.
    const initial = transcript.snapshot();
    assert.deepEqual(
      initial.items.map((item) => item.kind),
      ["user", "assistant"],
      "the persisted window loads in native order",
    );

    // A streaming delta is one non-structural change below the window.
    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "Partial" }] });
    deliver();
    assert.deepEqual(
      transcript.liveTail().streaming,
      [{ type: "text", text: "Partial" }],
      "the delta renders as the cumulative streaming partial",
    );

    // One live tool call: start, a no-op update, and the terminal state all
    // land on the same live row below the persisted window.
    feed.publish(ID, { kind: "tool_started", callKey: callKeyOf("c1"), name: "grep", summary: "called", startedAt: 1 });
    deliver();
    feed.publish(ID, { kind: "tool_updated", callKey: callKeyOf("c1"), name: "grep" });
    deliver();
    assert.equal(transcript.liveTail().items.length, 1, "an update carries no visible state of its own");
    assert.equal(transcript.liveTail().items[0].tool.callKey, callKeyOf("c1"));
    feed.publish(ID, { kind: "tool_finished", callKey: callKeyOf("c1"), name: "grep", isError: true });
    deliver();
    assert.equal(transcript.liveTail().items.length, 1, "the same row flips terminal in place");
    assert.equal(transcript.liveTail().items[0].tool.endedAt !== undefined, true);

    // Pi persists the tool call and its result; the module's own reconcile
    // loads them and the live row sheds exactly when its persisted record
    // covers the call.
    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "x" } }],
    }));
    appendSessionLine(sessionFile, messageEntry("e4", {
      role: "toolResult", toolCallId: "c1", toolName: "grep", isError: false, content: [],
    }));
    feed.publish(ID, { kind: "tool_result_completed" });
    deliver();
    assert.equal(
      transcript.liveTail().items.length,
      0,
      "the persisted call row with its result covers the live row",
    );
    assert.deepEqual(
      transcript.snapshot().items.map((item) => item.kind),
      ["user", "assistant", "toolCall"],
      "the persisted tool row renders in its native position",
    );

    // The completion arrives before its own persisted record: it renders in
    // the tail first, then confirms against the record once it loads.
    const historyFloor = statSync(sessionFile).size;
    feed.publish(ID, {
      kind: "message_completed",
      content: [{ type: "text", text: "final words" }],
      timestamp: 5_000,
      historyFloor,
    });
    deliver();
    assert.equal(transcript.liveTail().items.length, 1, "the completion renders before persistence lands");
    appendSessionLine(sessionFile, messageEntry("e5", {
      role: "assistant", timestamp: 5_000, content: [{ type: "text", text: "final words" }],
    }));
    feed.publish(ID, { kind: "run_finished" });
    deliver();

    // The one ordered transcript: every occurrence exactly once, persisted
    // records in native order, nothing live left below the window.
    const final = transcript.snapshot();
    assert.deepEqual(
      final.items.map((item) => item.kind),
      ["user", "assistant", "toolCall", "assistant"],
      "the complete run reads as one ordered persisted transcript",
    );
    assert.equal(transcript.liveTail().items.length, 0, "every live entry reconciled against its own record");
    assert.equal(transcript.liveTail().streaming, undefined, "no streaming partial survives the run end");
    const texts = final.items
      .filter((item) => item.kind === "user" || item.kind === "assistant")
      .map((item) => (item.kind === "user" ? item.text : item.message.content[0].text));
    assert.deepEqual(texts, ["task text", "first answer", "final words"], "no occurrence appears twice");

    assert.deepEqual(
      changes.map((change) => `${change.grew}/${change.structural}`),
      ["true/false", "true/true", "true/true", "true/true", "true/true", "true/true"],
      "deltas notify non-structural and every structural observation notifies through the subscription",
    );
    registry.releaseAll();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry retains one transcript per child and observes exactly one at a time", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "child a" }] }),
    ]);
    writeChildArtifacts(root, OTHER_ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "child b" }] }),
    ]);
    const { feed, deliverAll } = manualFeed();
    const registry = createChildTranscriptRegistry({ feed: () => feed, now: () => 0 });

    const first = registry.observe(ID);
    assert.equal(registry.observe(ID), first, "a retained child keeps its loaded transcript across observations");
    const second = registry.observe(OTHER_ID);
    assert.notEqual(second, first, "each child owns its own transcript");

    // The observation moved: an unobserved child retains no events.
    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "for a" }] });
    feed.publish(OTHER_ID, { kind: "message_delta", parts: [{ type: "text", text: "for b" }] });
    deliverAll();
    assert.equal(first.liveTail().streaming, undefined, "the unobserved child's tail stays empty");
    assert.deepEqual(second.liveTail().streaming, [{ type: "text", text: "for b" }]);

    // Moving the observation back restores the retained window and restarts
    // the feed forwarding for that child.
    assert.equal(registry.observe(ID), first, "the retained transcript survives the round trip");
    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "for a again" }] });
    deliverAll();
    assert.deepEqual(first.liveTail().streaming, [{ type: "text", text: "for a again" }]);

    // Releasing drops the module's own session; the next observation starts
    // fresh over the current file.
    registry.release(ID);
    const reopened = registry.observe(ID);
    assert.notEqual(reopened, first, "a released child re-observes as a fresh transcript");
    assert.equal(reopened.liveTail().streaming, undefined);

    // releaseAll ends every feed forwarding.
    registry.releaseAll();
    feed.publish(OTHER_ID, { kind: "message_delta", parts: [{ type: "text", text: "late" }] });
    deliverAll();
    assert.deepEqual(
      second.liveTail().streaming,
      [{ type: "text", text: "for b" }],
      "a released child observes nothing: the late event never reached its transcript",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a registry without a feed stays persisted-only", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const registry = createChildTranscriptRegistry({ now: () => 0 });
    const transcript = registry.observe(ID);
    assert.equal(transcript.snapshot().items.length, 1, "the persisted window reads without any feed");

    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant", timestamp: 2_000, content: [{ type: "text", text: "answer" }],
    }));
    assert.equal(transcript.reconcileNewer(8), true, "the external catch-up still walks the real pager");
    assert.equal(transcript.snapshot().items.length, 2);
    registry.releaseAll();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a throwing transcript subscriber is contained as the bounded diagnostic and never breaks the feed", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const { feed, deliver } = manualFeed();
    const registry = createChildTranscriptRegistry({ feed: () => feed, now: () => 0 });
    const transcript = registry.observe(ID);

    const healthy = [];
    transcript.subscribe((change) => healthy.push(change));
    transcript.subscribe(() => {
      throw new Error("view exploded");
    });

    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "first" }] });
    deliver();
    assert.equal(
      transcript.liveTail().diagnostic,
      "live updates paused after a viewer error",
      "the registry's forwarder contains the failure as the one bounded diagnostic row",
    );
    assert.ok(
      healthy.some((change) => change.grew === false && change.structural === false),
      "healthy subscribers still observe the diagnostic change",
    );

    feed.publish(ID, { kind: "tool_started", callKey: callKeyOf("c2"), name: "grep", summary: "called", startedAt: 2 });
    deliver();
    assert.ok(
      healthy.some((change) => change.grew === true && change.structural === true),
      "the forwarder itself never threw, so the feed keeps delivering and healthy subscribers keep receiving",
    );
    registry.releaseAll();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the external catch-up reconciles the retained transcript and notifies exactly once per change", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task" }] }),
    ]);
    const registry = createChildTranscriptRegistry({ now: () => 0 });
    const transcript = registry.observe(ID);
    const changes = [];
    transcript.subscribe((change) => changes.push(change));

    appendSessionLine(sessionFile, messageEntry("e2", {
      role: "assistant", timestamp: 2_000, content: [{ type: "text", text: "one" }],
    }));
    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "assistant", timestamp: 3_000, content: [{ type: "text", text: "two" }],
    }));

    assert.equal(transcript.reconcileNewer(8), true, "the caller-initiated catch-up loads the newer pages");
    assert.deepEqual(
      changes,
      [{ grew: true, structural: true }],
      "the view bound to this transcript is not the caller: one notification per changed window",
    );
    assert.deepEqual(
      transcript.snapshot().items.map((item) => item.kind),
      ["user", "assistant", "assistant"],
    );

    changes.length = 0;
    assert.equal(transcript.reconcileNewer(8), false, "nothing newer stays a quiet false");
    assert.deepEqual(changes, [], "no change means no notification");
    registry.releaseAll();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The rendering entry draws the module's ordered transcript

test("the overlay renders exactly what the module's ordered transcript carries", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    const { sessionFile } = writeChildArtifacts(root, ID, [
      messageEntry("e1", { role: "user", content: [{ type: "text", text: "task text" }] }),
      messageEntry("e2", { role: "assistant", timestamp: 1_000, content: [{ type: "text", text: "first answer" }] }),
    ]);
    const { feed, deliverAll } = manualFeed();
    const registry = createChildTranscriptRegistry({ feed: () => feed, now: () => 0 });
    const transcript = registry.observe(ID);

    const overlay = new ChildTranscriptOverlay({
      tui: { terminal: { columns: 80, rows: 30 }, requestRender() {} },
      theme: plainTheme(),
      model: {
        role: "explorer",
        id: ID,
        idLabel: "aaaaaaaa",
        lifecycleLabel: "● running",
        lifecycleTone: "accent",
        status: "running",
        durationText: "4s",
        transcript,
      },
      onClose: () => {},
      onReplay: () => {},
    });

    let lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.indexOf("task text") >= 0 && lines.indexOf("task text") < lines.indexOf("first answer"),
      "persisted entries render in the module's native order");

    feed.publish(ID, { kind: "message_delta", parts: [{ type: "text", text: "streaming words" }] });
    deliverAll();
    lines = plain(overlay.render(64)).join("\n");
    assert.ok(lines.includes("streaming words"), "the live tail renders below the persisted window");
    assert.ok(
      lines.indexOf("first answer") < lines.indexOf("streaming words"),
      "the streaming partial stays below every persisted entry",
    );

    // The completion's own record persists and loads; the overlay renders
    // the occurrence exactly once, through the module's notification alone.
    const historyFloor = statSync(sessionFile).size;
    feed.publish(ID, {
      kind: "message_completed",
      content: [{ type: "text", text: "streaming words" }],
      timestamp: 5_000,
      historyFloor,
    });
    appendSessionLine(sessionFile, messageEntry("e3", {
      role: "assistant", timestamp: 5_000, content: [{ type: "text", text: "streaming words" }],
    }));
    feed.publish(ID, { kind: "run_finished" });
    deliverAll();
    lines = plain(overlay.render(64)).join("\n");
    assert.equal(occurrences(lines, "streaming words"), 1, "one occurrence across the live and persisted sides");
    assert.ok(lines.indexOf("first answer") < lines.indexOf("streaming words"),
      "the confirmed record keeps its native persisted position");
    registry.releaseAll();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runner

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
