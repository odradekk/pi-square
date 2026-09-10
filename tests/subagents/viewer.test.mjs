import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import jiti from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// One caching jiti instance: the roster controller and these tests must
// observe the same input-surface module state, which a fresh per-load
// evaluation would split into separate counters.
const load = jiti(import.meta.url);
const viewerModule = await load(join(packageRoot, "src", "subagents", "viewer.ts"));
const rosterModule = await load(join(packageRoot, "src", "subagents", "roster.ts"));
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const artifactsModule = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const inputSurfaceModule = await load(join(packageRoot, "src", "core", "input-surface.ts"));
const { DEFAULT_CONFIG } = await load(join(packageRoot, "src", "core", "config.ts"));
const { DisplayRuntime } = await load(join(packageRoot, "src", "display", "runtime.ts"));
const { createPromptSnapshot } = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));

const {
  ChildTranscriptOverlay,
  childOverlayPlan,
  classifyViewerInput,
  projectSessionEntries,
} = viewerModule;
const childHistoryModule = await load(join(packageRoot, "src", "subagents", "child-history.ts"));
const { staticChildHistory } = childHistoryModule;
const {
  createSubagentRosterController,
  renderSubagentRoster,
  rosterRowBudget,
  SUBAGENT_ROSTER_KEY,
} = rosterModule;
const { createBackgroundState } = backgroundModule;
const { ensureArtifactsDir, initializeSessionFile, writeRunState } = artifactsModule;
const { isOwnedInputSurfaceActive, withOwnedInputSurface } = inputSurfaceModule;

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const themeModulePath = pathToFileURL(join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
  tick() { for (const callback of [...this.callbacks.values()]) callback(); }
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";

// ---------------------------------------------------------------------------
// Input classification

test("escape closes, editing no-ops stay open, and shortcuts are suppressed", () => {
  assert.deepEqual(classifyViewerInput(ESCAPE), { kind: "close" });
  assert.deepEqual(classifyViewerInput(BACKSPACE), { kind: "ignore" });
  assert.deepEqual(classifyViewerInput(DELETE), { kind: "ignore" });
  assert.deepEqual(classifyViewerInput("\x08"), { kind: "ignore" }, "ctrl+h backspace stays open");
  assert.deepEqual(classifyViewerInput(UP), { kind: "candidate", delta: -1 }, "up moves the roster candidate");
  assert.deepEqual(classifyViewerInput(DOWN), { kind: "candidate", delta: 1 }, "down moves the roster candidate");
  assert.deepEqual(classifyViewerInput(PAGE_UP), { kind: "scroll", delta: -1 }, "page up scrolls the transcript");
  assert.deepEqual(classifyViewerInput(PAGE_DOWN), { kind: "scroll", delta: 1 }, "page down scrolls the transcript");
  assert.deepEqual(classifyViewerInput(HOME), { kind: "jump", to: "start" }, "home jumps toward the earliest entry");
  assert.deepEqual(classifyViewerInput(END), { kind: "jump", to: "end" }, "end jumps to the newest edge");
  assert.deepEqual(classifyViewerInput("\x1b[C"), { kind: "ignore" }, "right arrow suppressed");
  assert.deepEqual(classifyViewerInput(ENTER), { kind: "confirm" }, "enter confirms a candidate and never submits through the overlay");
  assert.deepEqual(classifyViewerInput("\t"), { kind: "ignore" });
  assert.deepEqual(classifyViewerInput("\x03"), { kind: "ignore" }, "ctrl+c suppressed with the other shortcuts");
  assert.deepEqual(classifyViewerInput("\x1ba"), { kind: "ignore" }, "alt-modified keys are not replayed");
  assert.deepEqual(classifyViewerInput(""), { kind: "ignore" });
});

test("printable, multibyte, kitty, and paste input replay complete content", () => {
  assert.deepEqual(classifyViewerInput("a"), { kind: "replay", text: "a" });
  assert.deepEqual(classifyViewerInput("abc"), { kind: "replay", text: "abc" }, "fast multi-key chunks replay whole");
  assert.deepEqual(classifyViewerInput("你好"), { kind: "replay", text: "你好" });
  assert.deepEqual(classifyViewerInput(" "), { kind: "replay", text: " " }, "space is printable");
  assert.deepEqual(classifyViewerInput("\x1b[97u"), { kind: "replay", text: "a" }, "kitty printable decodes");
  const paste = classifyViewerInput("\x1b[200~line one\nline two\x1b[201~");
  assert.equal(paste.kind, "replay");
  assert.equal(paste.text, "line one\nline two");
  const unterminated = classifyViewerInput("\x1b[200~partial");
  assert.equal(unterminated.kind, "replay");
  assert.equal(unterminated.text, "partial");
});

// ---------------------------------------------------------------------------
// Overlay geometry

test("normal terminals target 80% width and 75% height centered", () => {
  const plan = childOverlayPlan(80, 24);
  assert.equal(plan.small, false);
  assert.deepEqual(plan.overlay, { width: "80%", maxHeight: "75%", anchor: "center" });
  assert.equal(plan.bodyRows, Math.floor(24 * 0.75) - 4);
  assert.equal(childOverlayPlan(100, 40).bodyRows, 26);
});

test("small terminals degrade to a one-cell-margin near-fullscreen panel", () => {
  const plan = childOverlayPlan(40, 12);
  assert.equal(plan.small, true);
  assert.deepEqual(plan.overlay, { width: "100%", maxHeight: "100%", margin: 1, anchor: "center" });
  assert.equal(plan.bodyRows, 12 - 2 - 4);
  assert.equal(childOverlayPlan(59, 24).small, true);
  assert.equal(childOverlayPlan(60, 24).small, false, "60 columns is normal");
  assert.equal(childOverlayPlan(80, 15).small, true);
  assert.equal(childOverlayPlan(80, 16).small, false, "16 rows is normal");
});

// ---------------------------------------------------------------------------
// Transcript projection

function messageEntry(id, message, timestamp = "2025-01-01T00:00:00Z") {
  return { type: "message", id, parentId: null, timestamp, message };
}

function sessionHeader(id = "session-1") {
  return { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" };
}

test("projection keeps ordered user, thinking, text, tool call, and tool result content", () => {
  const entries = [
    sessionHeader(),
    messageEntry("e1", { role: "user", content: "find the bug", timestamp: 1 }),
    messageEntry("e2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "consider the cache" },
        { type: "text", text: "Reading the file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts", offset: 3, limit: 38 } },
      ],
      api: "anthropic", provider: "anthropic", model: "m", usage: { totalTokens: 1 }, stopReason: "toolUse", timestamp: 2,
    }, "2025-01-01T00:00:02.000Z"),
    messageEntry("e3", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "10 lines" }],
      isError: false,
      timestamp: 3,
    }, "2025-01-01T00:00:03.250Z"),
    messageEntry("e4", { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 4 }),
  ];

  const projection = projectSessionEntries(entries);
  assert.equal(projection.omitted, 0);
  assert.deepEqual(
    projection.items.map((item) => item.kind),
    ["user", "assistant", "toolCall", "assistant"],
  );
  const call = projection.items[2];
  assert.equal("callId" in call, false, "internal pairing IDs never enter the display projection");
  assert.equal(call.summary, "lines 3-40", "the call carries only the structural range summary");
  assert.equal("text" in call.result, false, "result payloads never enter the projection");
  assert.equal(call.result.isError, false);
  assert.equal(call.durationMs, 1_250, "outer session-entry timestamps become the operational elapsed duration");
});

test("projection hides system-shaped entries and sanitizes generic fallback lines", () => {
  const entries = [
    sessionHeader(),
    { type: "custom", id: "c1", parentId: null, timestamp: "t", customType: "artifact", data: { secret: "x" } },
    { type: "label", id: "l1", parentId: null, timestamp: "t", targetId: "e1", label: "bookmark" },
    { type: "model_change", id: "m1", parentId: null, timestamp: "t", provider: "p", modelId: "m" },
    { type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "rename" },
    { type: "compaction", id: "k1", parentId: null, timestamp: "t", summary: "summary text", firstKeptEntryId: "e1", tokensBefore: 1 },
    { type: "branch_summary", id: "b1", parentId: null, timestamp: "t", fromId: "e1", summary: "branch" },
    { type: "custom_message", id: "cm1", parentId: null, timestamp: "t", customType: "guide", content: "password: swordfish\x1b[31m and control chars", display: false },
    { type: "custom_message", id: "cm2", parentId: null, timestamp: "t", customType: "guide", content: "password: swordfish visible", display: true },
    messageEntry("e9", { role: "toolResult", toolCallId: "orphan", toolName: "web_fetch", content: [], isError: false, timestamp: 9 }),
  ];

  const projection = projectSessionEntries(entries);
  const texts = projection.items.map((item) => item.text ?? "");
  assert.deepEqual(
    projection.items.map((item) => item.kind),
    ["generic", "generic", "generic", "generic"],
    "compaction, branch summary, visible custom message, and the orphan result all render once",
  );
  assert.match(texts[0], /context compacted/);
  assert.match(texts[1], /branch summary recorded/);
  assert.match(texts[2], /visible/);
  assert.ok(!texts[2].includes("swordfish"), "credential forms are redacted in fallback lines");
  assert.ok(!texts[2].includes("\x1b"), "control sequences never render in fallback lines");
  assert.match(texts[3], /tool result: web_fetch/, "a cataloged orphan result keeps its identity");
  const hostileOrphan = projectSessionEntries([
    sessionHeader(),
    messageEntry("e1", { role: "toolResult", toolCallId: "gone", toolName: "curl password: swordfish", content: [], isError: false, timestamp: 1 }),
  ]);
  assert.match(hostileOrphan.items[0].text, /tool result: tool/, "an untrusted orphan result name stays anonymous");
  assert.ok(!hostileOrphan.items[0].text.includes("swordfish"));
  for (const text of texts) assert.ok(text.length <= 200, "generic lines stay bounded");
});

test("projection clips unbounded text and keeps only the bounded recent window", () => {
  const long = "x".repeat(10_000);
  const entries = [sessionHeader(), messageEntry("e1", { role: "user", content: long, timestamp: 1 })];
  const clipped = projectSessionEntries(entries).items[0];
  assert.ok(clipped.text.length < 2_200, "entry text passes the shared head/tail budget");
  assert.match(clipped.text, /\[omitted \d+ characters\]/);

  const many = [sessionHeader()];
  for (let index = 0; index < 30; index += 1) {
    many.push(messageEntry(`e${index}`, { role: "user", content: `message ${index}`, timestamp: index }));
  }
  const window = projectSessionEntries(many, 24);
  assert.equal(window.items.length, 24);
  assert.equal(window.omitted, 6);
  assert.match(window.items.at(-1).text, /message 29/);
  assert.match(window.items[0].text, /message 6/, "the recent tail is the visible window");
});

test("assistant-terminal tool calls do not invent a tool duration without a result entry", () => {
  const observedAt = Date.parse("2025-01-01T00:01:00.000Z");
  const projection = projectSessionEntries([
    sessionHeader(),
    messageEntry("e1", {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-no-result", name: "read", arguments: { offset: 1, limit: 2 } }],
      stopReason: "error",
      errorMessage: "provider failure",
      timestamp: observedAt - 60_000,
    }, "2025-01-01T00:00:02.000Z"),
  ], 24, observedAt);
  const call = projection.items.find((item) => item.kind === "toolCall");
  assert.equal(call.result.isError, true, "the fixed terminal state remains visible");
  assert.equal(call.durationMs, undefined, "no result boundary means no tool-execution duration");
});

test("projection display-sanitizes every text channel before any renderer", () => {
  const hostile = "keep this\npassword: swordfish\ntoken=abc123\nBearer eyJhbGc\x1b[31mred\x1b[0m";
  const jsonCredential = '{"password":"bare-secret"}';
  const providerDiagnostic = '{"request_id":"req-internal"}';
  const entries = [
    sessionHeader(),
    messageEntry("e1", { role: "user", content: `${hostile}\n${jsonCredential}`, timestamp: 1 }),
    messageEntry("e2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `thinking ${hostile}` },
        { type: "text", text: `answer ${hostile}` },
      ],
      stopReason: "stop",
      timestamp: 2,
    }),
    messageEntry("e3", {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: `boom ${hostile} ${jsonCredential} ${providerDiagnostic}`,
      timestamp: 3,
    }),
    messageEntry("e4", {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-secret-1",
          name: "bash",
          arguments: { command: `curl -u alice:swordfish ${hostile}` },
        },
      ],
      stopReason: "toolUse",
      timestamp: 4,
    }),
    messageEntry("e5", {
      role: "toolResult",
      toolCallId: "call-secret-1",
      toolName: "bash",
      content: [{ type: "text", text: "SECRET TOOL RESULT with password: swordfish" }],
      isError: true,
      timestamp: 5,
    }),
  ];

  const serialized = JSON.stringify(projectSessionEntries(entries));
  assert.ok(!serialized.includes("swordfish"), "credential values never enter any item");
  assert.ok(!serialized.includes("abc123"), "token values never enter any item");
  assert.ok(!serialized.includes("eyJhbGc"), "bearer values never enter any item");
  assert.ok(!serialized.includes("\\x1b") && !serialized.includes("\u001b"), "control sequences never enter any item");
  // Tool results cross as one bounded sanitized evidence projection for the
  // expanded row (#307): the payload text survives, credentials do not.
  const projectedCall = projectSessionEntries(entries).items.find((item) => item.kind === "toolCall");
  assert.ok(projectedCall.output.includes("SECRET TOOL RESULT"), "the bounded result projection enters the call item");
  assert.ok(!projectedCall.output.includes("swordfish") && !projectedCall.output.includes("abc123"), "result credentials never enter the projection");
  assert.ok(projectedCall.output.length <= 620, "the result projection stays inside its explicit budget");
  assert.ok(!serialized.includes("curl"), "raw argument commands never enter any item");
  assert.ok(!serialized.includes("bare-secret"), "structured credentials never enter any item");
  assert.ok(!serialized.includes("req-internal"), "provider-internal error identifiers never enter any item");
  assert.ok(!serialized.includes("call-secret-1"), "raw tool-call identifiers never enter any item");

  const { items } = projectSessionEntries(entries);
  const call = items.find((item) => item.kind === "toolCall");
  assert.equal(call.name, "bash", "tool identity survives sanitization");
  assert.match(call.summary, /called/, "the allowlisted summary replaces raw command arguments");

  // The rendered overlay shows none of the hostile channels either.
  const rendered = renderOverlayLines(baseModel({ history: staticChildHistory(items) }));
  const renderedText = plain(rendered).join("\n");
  for (const leak of ["swordfish", "abc123", "eyJhbGc", "bare-secret", "req-internal", "SECRET TOOL RESULT", "call-secret-1", "curl", "\u001b"]) {
    assert.ok(!renderedText.includes(leak), `${leak} never renders`);
  }
  assert.ok(renderedText.includes("Bash"), "the sentence-case tool identity line still renders");
  assert.ok(renderedText.includes("failed"), "the error result state still renders");
  for (const line of rendered) assert.ok(visibleWidth(line) <= 64, "every rendered line stays inside the width");
  for (const item of items) {
    const text = item.kind === "user" ? item.text
      : item.kind === "assistant" ? JSON.stringify(item.message)
        : item.kind === "toolCall" ? `${item.name} ${item.summary} ${item.output ?? ""}`
          : item.text;
    assert.ok(text.length < 2_600, "every projected text stays inside the entry budget");
  }
});

test("unsupported but meaningful content becomes a non-empty sanitized fallback", () => {
  const entries = [
    sessionHeader(),
    { type: "custom_message", id: "cm1", parentId: null, timestamp: "t", customType: "guide", content: [{ type: "image", data: "AAA", mimeType: "image/png" }], display: true },
    messageEntry("e1", { role: "user", content: [{ type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 }),
    messageEntry("e2", { role: "assistant", content: [], timestamp: 2 }),
    messageEntry("e3", { role: "assistant", content: "not-an-array", timestamp: 3 }),
    messageEntry("e4", { role: "futureRole", content: "payload", timestamp: 4 }),
  ];
  const { items } = projectSessionEntries(entries);
  assert.equal(items.length, 5, "every meaningful entry produces exactly one item");
  assert.ok(items.every((item) => item.kind === "generic" && item.text.trim() !== ""), "no silent gaps and no empty lines");
  const text = items.map((item) => item.text).join("\n");
  assert.match(text, /extension message/);
  assert.match(text, /user message/);
  assert.match(text, /assistant message/g);
  assert.match(text, /unsupported message entry/);

  // A generic fallback fits whatever narrow width the renderer offers.
  const { overlay } = overlayHarness(baseModel({ history: staticChildHistory(items) }), 24, 10);
  const lines = overlay.render(20);
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, "fallback lines respect narrow overlay widths");
  const plainLines = plain(lines);
  assert.ok(
    plainLines.some((line) => /extension|user message|unsupported|assistant/.test(line)),
    "fallbacks stay readable when clipped",
  );
});

test("unsupported parts remain visible while Pi-native assistant grouping stays intact", () => {
  const entries = [
    sessionHeader(),
    messageEntry("e1", {
      role: "user",
      content: [
        { type: "text", text: "user before" },
        { type: "image", data: "private-image-data", mimeType: "image/png" },
        { type: "text", text: "user after" },
      ],
      timestamp: 1,
    }),
    messageEntry("e2", {
      role: "assistant",
      content: [
        { type: "text", text: "assistant before" },
        { type: "future", payload: "private-provider-payload" },
        { type: "toolCall", id: "call-private", name: "read", arguments: { offset: 2, limit: 3 } },
        { type: "thinking", thinking: "assistant after" },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    }),
  ];

  const projection = projectSessionEntries(entries);
  assert.deepEqual(
    projection.items.map((item) => item.kind),
    ["user", "generic", "user", "assistant", "toolCall", "generic"],
    "Pi's native assistant group stays intact before its tool rows; unsupported content remains visible afterward",
  );
  const rendered = plain(renderOverlayLines(baseModel({ history: staticChildHistory(projection.items) }))).join("\n");
  for (const expected of ["user before", "unsupported user message content", "user after", "assistant before", "assistant after", "Read", "unsupported assistant content"]) {
    assert.ok(rendered.includes(expected), `${expected} remains visible`);
  }
  for (const hidden of ["private-image-data", "private-provider-payload", "call-private"]) {
    assert.ok(!JSON.stringify(projection).includes(hidden), `${hidden} never enters the display projection`);
  }
});

// ---------------------------------------------------------------------------
// Transcript reads

const ID = "subagent_00000000-0000-4000-8000-000000000001";
const SESSION_ID = "019f0000-0000-7000-8000-000000000001";

function transcriptRoot() {
  return join(tmpdir(), `pi-square-viewer-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function writeSessionFile(root, lines, overrides = {}) {
  process.env.PI_AGENT_DIR = root;
  const artifactsDir = ensureArtifactsDir(ID);
  const sessionFile = join(artifactsDir, "session.jsonl");
  const header = { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: "/tmp/project" };
  initializeSessionFile({ id: ID, artifactsDir, sessionFile, header });
  writeFileSync(sessionFile, [header, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeRunState(artifactsDir, {
    version: 4,
    id: ID,
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
    ...overrides,
  });
  return { artifactsDir, sessionFile };
}

// ---------------------------------------------------------------------------
// Overlay component

function fakeTui(columns = 80, rows = 30) {
  return { terminal: { columns, rows }, requestRender() {} };
}

function overlayHarness(model, columns = 80, rows = 30) {
  const events = { closed: 0, replayed: [] };
  const overlay = new ChildTranscriptOverlay({
    tui: fakeTui(columns, rows),
    theme: plainTheme(),
    model,
    onClose: () => { events.closed += 1; },
    onReplay: (text) => { events.replayed.push(text); },
  });
  return { overlay, events };
}

/** Scriptable history view: records loads and mutates through the handlers. */
function scriptedHistory(initial, handlers = {}) {
  const calls = { older: 0, newer: 0, retries: 0 };
  let snapshot = {
    items: initial.items ?? [],
    moreBefore: initial.moreBefore === true,
    moreAfter: initial.moreAfter === true,
    ...(initial.olderError !== undefined ? { olderError: initial.olderError } : {}),
    ...(initial.newerError !== undefined ? { newerError: initial.newerError } : {}),
    ...(initial.initialError !== undefined ? { initialError: initial.initialError } : {}),
  };
  return {
    calls,
    snapshot: () => snapshot,
    set(next) { snapshot = { ...snapshot, ...next }; },
    loadOlder() {
      calls.older += 1;
      return handlers.loadOlder ? handlers.loadOlder(this) : false;
    },
    loadNewer() {
      calls.newer += 1;
      return handlers.loadNewer ? handlers.loadNewer(this) : false;
    },
    retryInitial() {
      calls.retries += 1;
      return handlers.retryInitial ? handlers.retryInitial(this) : false;
    },
  };
}

function baseModel(overrides = {}) {
  return {
    role: "explorer",
    idLabel: "aaaaaaaa",
    lifecycleLabel: "● running",
    lifecycleTone: "accent",
    status: "running",
    durationText: "1m 05s",
    history: staticChildHistory([]),
    cwd: "/tmp/project",
    ...overrides,
  };
}

function plain(lines) {
  return lines.map((line) => stripVTControlCharacters(line));
}

function renderOverlayLines(model, columns = 80, rows = 30, width = 64) {
  const { overlay } = overlayHarness(model, columns, rows);
  return overlay.render(width);
}

test("overlay renders title, rules, transcript body, and help within the width", () => {
  const model = baseModel({
    history: staticChildHistory([
        { kind: "user", text: "find the bug in the parser" },
        {
          kind: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "look at the lexer" }, { type: "text", text: "Found it." }],
            stopReason: "stop",
          },
        },
        { kind: "toolCall", name: "pwsh", summary: "called", durationMs: 1_250, result: { isError: false } },
    ]),
  });
  const { overlay, events } = overlayHarness(model, 120, 45);
  const lines = overlay.render(96);
  const text = plain(lines);
  assert.equal(text[0], "explorer aaaaaaaa ● running 1m 05s", "title carries role, ID, lifecycle, duration");
  assert.match(text[1], /^─+$/, "a quiet rule separates the title");
  assert.ok(text.some((line) => line.includes("find the bug in the parser")), "user entry renders");
  assert.ok(text.some((line) => line.includes("Found it.")), "assistant text renders");
  const toolLine = text.find((line) => line.includes("PowerShell"));
  assert.match(toolLine, /^\s*\u2713 PowerShell called Completed.*1\.3s/, "the shared operational row owns title, target, outcome, fallback lifecycle marker, and duration");
  assert.equal(text.filter((line) => /[✓×].*PowerShell/.test(line)).length, 1, "the call and result share exactly one row");
  assert.ok(!text.some((line) => /^\s*[✓×]\s+(?:result|completed|failed)\b/i.test(line)), "no detached result row can survive body clipping");
  const darkTheme = loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json"));
  const themed = new ChildTranscriptOverlay({
    tui: fakeTui(120, 45),
    theme: darkTheme,
    model,
    onClose: () => {},
    onReplay: () => {},
  }).render(96).find((line) => stripVTControlCharacters(line).includes("PowerShell"));
  assert.ok(themed, "the themed operational row renders");
  assert.ok(themed.includes(darkTheme.fg("muted", "called")), "the structural target stays muted");
  assert.ok(themed.includes(darkTheme.fg("toolOutput", "Completed")), "the terminal outcome stays neutral");
  assert.ok(!themed.includes(darkTheme.fg("success", "Completed")), "success hue stays on the marker");
  assert.match(text.at(-1), /esc close/, "help row names the escape path");
  for (const line of lines) assert.ok(visibleWidth(line) <= 96, "every line fits the overlay width");
  overlay.handleInput(BACKSPACE);
  assert.equal(events.closed, 0, "backspace keeps the overlay open");
});

test("empty queued, starting, failed, aborted, completed, and read-error states are explicit", () => {
  const cases = [
    [{ status: "queued" }, /Waiting to start/],
    [{ status: "running" }, /Starting…/],
    [{ status: "cancelling" }, /Starting…/],
    [{ status: "failed", failureReason: "model refused" }, /Failed: model refused/],
    [{ status: "aborted", failureReason: "user interrupt" }, /Aborted: user interrupt/],
    [{ status: "completed" }, /No transcript recorded\./],
    [{ history: staticChildHistory([], { initialError: "artifacts missing" }) }, /Transcript unavailable: artifacts missing/],
  ];
  for (const [overrides, pattern] of cases) {
    const { overlay } = overlayHarness(baseModel(overrides));
    const text = plain(overlay.render(64));
    assert.match(text[2], pattern, `state ${overrides.status ?? "read-error"} renders one explicit line`);
  }
});

test("overlay input closes on escape, replays complete content, and suppresses the rest", () => {
  const { overlay, events } = overlayHarness(baseModel());
  overlay.handleInput(ESCAPE);
  assert.equal(events.closed, 1);
  assert.deepEqual(events.replayed, []);

  overlay.handleInput("h");
  overlay.handleInput("i");
  assert.deepEqual(events.replayed, ["h", "i"], "printable input is the replay path");
  assert.equal(events.closed, 1, "replay is not a second close event");

  overlay.handleInput("\x1b[200~first\nsecond\x1b[201~");
  assert.deepEqual(events.replayed.at(-1), "first\nsecond", "paste replay keeps newlines without submitting");

  overlay.handleInput(DOWN);
  overlay.handleInput(ENTER);
  overlay.handleInput(DELETE);
  assert.equal(events.closed, 1, "non-editing keys neither close nor replay");
  assert.equal(events.replayed.length, 3, "only h, i, and the paste ever replayed");
});

test("overlay body opens on the bounded recent tail and scrolls with bounded indicators", () => {
  // Generic rows are exactly one line each, so the assertions track the
  // viewport math rather than Pi's user-message padding.
  const items = Array.from({ length: 40 }, (_, index) => ({
    kind: "generic",
    text: `entry ${String(index).padStart(2, "0")}`,
    entryId: `e${index}`,
  }));
  const { overlay } = overlayHarness(baseModel({ history: staticChildHistory(items) }), 80, 20);
  const text = plain(overlay.render(80));
  const plan = childOverlayPlan(80, 20);
  assert.ok(text.length <= plan.bodyRows + 4, "total rows stay within the overlay plan");
  assert.match(text[2], /\+\d+ earlier lines/, "the leading indicator states the cut once");
  assert.ok(text.some((line) => line.includes("entry 39")), "the most recent entry stays visible");
  assert.ok(!text.some((line) => /entry 0\d/.test(line) && line.trim() !== "entry 09"), "entries above the viewport do not render");

  overlay.handleInput(PAGE_UP);
  const moved = plain(overlay.render(80));
  assert.match(moved[2], /\+\d+ earlier lines/, "the indicator still leads after a page up");
  assert.ok(moved.some((line) => /entry 1\d|entry 2\d/.test(line)), "an earlier page becomes visible");
  assert.ok(!moved.some((line) => line.includes("entry 39")), "the previous bottom leaves the viewport");

  overlay.handleInput(PAGE_DOWN);
  const back = plain(overlay.render(80));
  assert.ok(back.some((line) => line.includes("entry 39")), "page down returns toward the tail");
  assert.match(back[2], /\+\d+ earlier lines/);

  // A history that still holds unread older bytes names it once at the top.
  const moreModel = baseModel({ history: staticChildHistory(items.slice(-5), { moreBefore: true }) });
  const { overlay: moreOverlay } = overlayHarness(moreModel, 80, 30);
  assert.match(plain(moreOverlay.render(80))[2], /earlier history \(page up\)/);
});

test("page up at the loaded top demands exactly one bounded older page and keeps the seam stable", () => {
  // Twenty single-line items; pressing page up at the top of the loaded
  // window loads one older page whose items prepend in native order.
  const older = Array.from({ length: 12 }, (_, index) => ({
    kind: "generic",
    text: `old ${String(index).padStart(2, "0")}`,
    entryId: `old-${index}`,
  }));
  const recent = Array.from({ length: 20 }, (_, index) => ({
    kind: "generic",
    text: `new ${String(index).padStart(2, "0")}`,
    entryId: `new-${index}`,
  }));
  const history = scriptedHistory({ items: recent, moreBefore: true }, {
    loadOlder(view) {
      view.set({ items: [...older, ...view.snapshot().items], moreBefore: false });
      return true;
    },
  });
  const { overlay } = overlayHarness(baseModel({ history }), 80, 20);
  let text = plain(overlay.render(80));
  assert.ok(text.some((line) => line.includes("new 19")), "the tail page opens at the bottom");

  // Scroll once to the loaded top; the edge marker names the unread page.
  overlay.handleInput(PAGE_UP);
  text = plain(overlay.render(80));
  assert.equal(history.calls.older, 0, "scrolling inside the loaded window requests nothing");
  assert.match(text[2], /earlier history \(page up\)/, "the loaded top names the unread older page");

  overlay.handleInput(PAGE_UP);
  text = plain(overlay.render(80));
  assert.equal(history.calls.older, 1, "one page-up at the loaded top loads exactly one older page");
  assert.ok(text.some((line) => /old \d\d/.test(line)), "the loaded older page becomes visible");
  assert.ok(text.some((line) => line.includes("new 00")), "the seam entry closes the viewport at its bottom edge");
  assert.ok(!text.some((line) => /earlier history/.test(line)), "the edge marker disappears once byte history is loaded");

  // Page up again only scrolls: the demand request does not repeat.
  overlay.handleInput(PAGE_UP);
  assert.equal(history.calls.older, 1, "scrolling inside the loaded window never re-requests a page");
  text = plain(overlay.render(80));
  assert.ok(text.some((line) => /old 0\d/.test(line)), "the scroll reaches older loaded entries");
});

test("older and newer page errors render on their own edge with the matching retry hint", () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    kind: "generic",
    text: `kept ${index}`,
    entryId: `kept-${index}`,
  }));
  // Both directions have failed: each edge carries its own bounded error.
  const history = scriptedHistory({
    items,
    moreBefore: true,
    moreAfter: true,
    olderError: "child history could not be read",
    newerError: "child history could not be read",
  }, {
    loadOlder(view) {
      view.set({ olderError: undefined, moreBefore: false, items: [{ kind: "generic", text: "older recovered", entryId: "rec-old" }, ...view.snapshot().items] });
      return true;
    },
    loadNewer(view) {
      view.set({ newerError: undefined, moreAfter: false, items: [...view.snapshot().items, { kind: "generic", text: "newer recovered", entryId: "rec-new" }] });
      return true;
    },
  });
  const { overlay } = overlayHarness(baseModel({ history }), 80, 30);
  const text = plain(overlay.render(80));
  assert.match(text[2], /older child history could not be read — page up retries/, "the older error leads the older edge");
  assert.match(text.at(-3), /newer child history could not be read — page down retries/, "the newer error leads the newer edge");
  assert.ok(text.some((line) => line.includes("kept 5")), "validated pages stay visible between both errors");

  // Each direction retries through its own edge key and clears only its error.
  overlay.handleInput(PAGE_UP);
  let moved = plain(overlay.render(80));
  assert.equal(history.calls.older, 1, "page up at the loaded top retries the older page");
  assert.equal(history.calls.newer, 0, "the older retry never touches the newer direction");
  assert.ok(moved.some((line) => line.includes("older recovered")), "the recovered older page renders");
  assert.match(moved.at(-3), /newer child history could not be read/, "the newer error survives the older recovery");

  overlay.handleInput(END);
  moved = plain(overlay.render(80));
  assert.ok(history.calls.newer >= 1, "end at the loaded bottom retries the newer page");
  assert.ok(moved.some((line) => line.includes("newer recovered")), "the recovered newer page renders");
  assert.ok(!moved.some((line) => /could not be read/.test(line)), "both error lines are cleared");
});

test("page errors remain visible when the loaded history has no projected entries", () => {
  const history = staticChildHistory([], {
    moreBefore: true,
    moreAfter: true,
    olderError: "child history could not be read",
    newerError: "child history could not be read",
  });
  const text = plain(renderOverlayLines(baseModel({ history })));
  assert.ok(text.some((line) => /older child history could not be read — page up retries/.test(line)));
  assert.ok(text.some((line) => /newer child history could not be read — page down retries/.test(line)));
  assert.ok(!text.some((line) => line.includes("Starting…")), "the lifecycle placeholder never masks retryable errors");
});

test("stable entry ordinals preserve the seam when one native entry spans retained windows", () => {
  const rows = (from, to) => Array.from({ length: to - from }, (_, offset) => ({
    kind: "generic",
    text: `logical row ${from + offset}`,
    entryId: "one-native-entry",
    entryItemIndex: from + offset,
  }));
  const history = scriptedHistory({ items: rows(20, 32), moreBefore: true }, {
    loadOlder(view) {
      view.set({ items: rows(0, 32), moreBefore: false, moreAfter: true });
      return true;
    },
  });
  const { overlay } = overlayHarness(baseModel({ history }), 80, 20);
  overlay.render(80);
  overlay.handleInput(PAGE_UP);
  overlay.render(80);
  overlay.handleInput(PAGE_UP);
  const text = plain(overlay.render(80));
  assert.equal(history.calls.older, 1);
  assert.ok(text.some((line) => line.includes("logical row 20")), "the previous top row remains the loaded-page seam");
  assert.ok(!text.some((line) => line.includes("logical row 0")), "the seam key never aliases the first row of the new slice");
});

test("scroll keys retry a failed initial read and reveal the recovered tail", () => {
  const history = scriptedHistory({ initialError: "child history could not be read" }, {
    retryInitial(view) {
      view.set({ initialError: undefined, items: [{ kind: "generic", text: "recovered tail", entryId: "r" }] });
      return true;
    },
  });
  const { overlay } = overlayHarness(baseModel({ history }), 80, 30);
  let text = plain(overlay.render(80));
  assert.match(text[2], /Transcript unavailable: child history could not be read/);
  overlay.handleInput(PAGE_UP);
  assert.equal(history.calls.retries, 1, "a scroll key retries the failed initial load");
  text = plain(overlay.render(80));
  assert.ok(text.some((line) => line.includes("recovered tail")), "the recovered tail page renders");
});

test("page up reaches history from a state-line body with no parsed items yet", () => {
  // A running child whose tail page is entirely one incomplete append leaves
  // zero parsed items; the explicit state line stays, but paging still works.
  const history = scriptedHistory({ items: [], moreBefore: true }, {
    loadOlder(view) {
      view.set({
        items: [
          { kind: "generic", text: "earliest recovered", entryId: "first" },
          { kind: "generic", text: "next recovered", entryId: "second" },
        ],
        moreBefore: false,
      });
      return true;
    },
  });
  const { overlay } = overlayHarness(baseModel({ history }), 80, 30);
  let text = plain(overlay.render(80));
  assert.match(text[2], /Starting…/, "the empty parsed window keeps its explicit state");
  overlay.handleInput(PAGE_UP);
  assert.equal(history.calls.older, 1, "page up still demands the older page");
  text = plain(overlay.render(80));
  assert.ok(text.some((line) => line.includes("earliest recovered")), "the recovered page replaces the state line");
});

test("home walks bounded page loads toward the earliest entry and end follows the newest edge", () => {
  const makeItems = (prefix, count) => Array.from({ length: count }, (_, index) => ({
    kind: "generic",
    text: `${prefix}${String(index).padStart(2, "0")}`,
    entryId: `${prefix}-${index}`,
  }));
  let batches = 3;
  const history = scriptedHistory({ items: makeItems("new", 20), moreBefore: true }, {
    loadOlder(view) {
      if (batches <= 0) { view.set({ moreBefore: false }); return false; }
      batches -= 1;
      view.set({ items: [...makeItems(`old${batches}`, 10), ...view.snapshot().items], moreBefore: batches > 0 });
      return true;
    },
  });
  const { overlay } = overlayHarness(baseModel({ history }), 80, 20);
  overlay.render(80);
  overlay.handleInput(HOME);
  assert.equal(history.calls.older, 3, "home chains the remaining bounded page loads to the earliest entry");
  let text = plain(overlay.render(80));
  assert.ok(text.some((line) => line.includes("old000")), "the earliest loaded entry is at the top");
  assert.ok(!text.some((line) => /earlier history/.test(line)), "no older edge remains");

  // End probes the newest edge even when the snapshot flag is stale, then
  // stops at the first empty probe.
  let appendedOnce = false;
  const appended = scriptedHistory({ items: makeItems("a", 4) }, {
    loadNewer(view) {
      if (appendedOnce) return false;
      appendedOnce = true;
      view.set({ items: [...view.snapshot().items, { kind: "generic", text: "appended line", entryId: "z" }] });
      return true;
    },
  });
  const { overlay: endOverlay } = overlayHarness(baseModel({ history: appended }), 80, 20);
  endOverlay.render(80);
  endOverlay.handleInput(END);
  assert.equal(appended.calls.newer, 2, "end probes the newest edge and stops at the first empty page");
  const endText = plain(endOverlay.render(80));
  assert.ok(endText.some((line) => line.includes("appended line")), "the appended entry is followed");
});

test("overlay lines cache by width and terminal size and invalidate cleanly", () => {
  const model = baseModel({
    history: staticChildHistory([{ kind: "user", text: "cached question" }]),
  });
  const { overlay } = overlayHarness(model);
  const first = overlay.render(64);
  assert.equal(overlay.render(64), first, "unchanged width and rows reuse the cached lines");
  const wider = overlay.render(80);
  assert.notEqual(wider, first);
  overlay.invalidate();
  assert.notEqual(overlay.render(64), first, "invalidate drops the cache");
});

test("overlay adapts to a small terminal with the one-cell-margin plan", () => {
  const model = baseModel({
    status: "queued",
    lifecycleLabel: "– queued",
    lifecycleTone: "muted",
    history: staticChildHistory([{ kind: "user", text: "queued work" }]),
  });
  const { overlay } = overlayHarness(model, 40, 12);
  const plan = childOverlayPlan(40, 12);
  assert.equal(plan.small, true);
  const lines = overlay.render(36);
  assert.ok(lines.length <= plan.bodyRows + 4, "the body budget shrinks on small terminals");
  for (const line of lines) assert.ok(visibleWidth(line) <= 36);
});

test("an open overlay recomputes its plan across the resize threshold", () => {
  const tui = fakeTui(80, 30);
  const entries = Array.from({ length: 30 }, (_, index) => ({
    kind: "generic",
    text: `entry ${String(index).padStart(2, "0")}`,
    entryId: `e${index}`,
  }));
  const overlay = new ChildTranscriptOverlay({
    tui,
    theme: plainTheme(),
    model: baseModel({ history: staticChildHistory(entries) }),
    onClose: () => {},
    onReplay: () => {},
  });

  const normal = plain(overlay.render(64));
  const normalPlan = childOverlayPlan(80, 30);
  assert.ok(normal.length <= normalPlan.bodyRows + 4, "normal plan bounds the open overlay");
  assert.ok(normal.some((line) => /entry 2\d/.test(line)), "the recent tail of the 30-entry history is visible");

  // Same instance, same render width, small terminal now: the plan must
  // recompute from the current terminal columns, not a cached key, and the
  // body reflows to the tighter budget.
  tui.terminal.columns = 40;
  tui.terminal.rows = 12;
  const small = plain(overlay.render(64));
  const smallPlan = childOverlayPlan(40, 12);
  assert.ok(small.length <= smallPlan.bodyRows + 4, "small plan re-bounds the same open overlay");
  assert.ok(small.length < normal.length, "the smaller body drops visible history rows");
  assert.match(small[2], /\+\d+ earlier lines/, "the reflowed body states the cut once");

  tui.terminal.columns = 80;
  tui.terminal.rows = 30;
  const restored = plain(overlay.render(64));
  assert.equal(restored.length, normal.length, "resizing back restores the normal plan");
  assert.deepEqual(restored, normal, "the restored layout shows the same history rows");
});

test("outer overlay options follow the live terminal dimensions", async () => {
  const { childOverlayOptions } = viewerModule;
  const tui = fakeTui(80, 30);
  const options = childOverlayOptions(tui);
  assert.deepEqual(
    { width: options.width, maxHeight: options.maxHeight, margin: options.margin },
    { width: "80%", maxHeight: "75%", margin: undefined },
    "normal terminal geometry at 80x30",
  );

  tui.terminal.columns = 40;
  tui.terminal.rows = 12;
  assert.deepEqual(
    { width: options.width, maxHeight: options.maxHeight, margin: options.margin },
    { width: "100%", maxHeight: "100%", margin: 1 },
    "the same options object switches to the one-cell-margin panel after resize",
  );

  // Through the controller seam: the options an open overlay registered keep
  // tracking the shared terminal.
  const { input, calls, tui: harnessTui, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));
  input(DOWN);
  input(ENTER);
  const live = calls.customs[0].options.overlayOptions();
  assert.equal(live.width, "80%");
  harnessTui.terminal.columns = 40;
  harnessTui.terminal.rows = 12;
  assert.equal(live.width, "100%");
  assert.equal(live.margin, 1);
  controller.stop();
});

test("the overlay renders responsively under both shipped themes", () => {
  const model = baseModel({
    history: staticChildHistory([
      { kind: "user", text: "trace the failing path through the scheduler" },
      { kind: "toolCall", name: "grep", summary: "called", result: { isError: false } },
    ], { moreBefore: true }),
  });
  for (const themeFile of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", themeFile));
    for (const [columns, rows, width] of [[120, 45, 96], [80, 30, 64], [60, 20, 48], [40, 12, 36], [24, 8, 22]]) {
      const overlay = new ChildTranscriptOverlay({
        tui: fakeTui(columns, rows),
        theme,
        model,
        onClose: () => {},
        onReplay: () => {},
      });
      const lines = overlay.render(width);
      const plan = childOverlayPlan(columns, rows);
      assert.ok(lines.length <= plan.bodyRows + 4, `${themeFile} ${columns}x${rows} stays within the plan`);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${themeFile} ${columns}x${rows} line fits ${width} cells`);
      }
      const text = plain(lines);
      assert.match(text[0], /explorer aaaaaaaa/, `${themeFile} ${columns}x${rows} keeps the title identity`);
      assert.match(text.at(-1), /esc close/, `${themeFile} ${columns}x${rows} keeps the help row`);
      // One bounded affordance states the unread earlier window: the
      // history edge at the loaded top, or the scroll indicator above it.
      assert.match(
        text[2],
        /earlier history \(page up\)|\+\d+ earlier lines/,
        `${themeFile} ${columns}x${rows} states the unread older window`,
      );
      // The tiny plans keep only the most recent lines; the readable sizes
      // keep the user entry too.
      if (columns >= 60) {
        assert.ok(text.some((line) => line.includes("trace the failing path")), `${themeFile} ${columns}x${rows} renders the user entry`);
      } else {
        assert.ok(text.some((line) => /grep|matches|earlier/.test(line)), `${themeFile} ${columns}x${rows} keeps recent evidence`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Controller traces

function job(id, status, createdAt, name, overrides = {}) {
  return {
    id,
    status,
    createdAt,
    updatedAt: createdAt + 1,
    abortController: new AbortController(),
    details: {
      version: 4,
      id,
      operation: "delegate",
      artifactsDir: "",
      sessionFile: "",
      sessionId: "",
      originParentSessionId: "parent-1",
      lastParentSessionId: "parent-1",
      promptSnapshot: createPromptSnapshot(),
      phase: status,
      agent: { name },
      task: "task text",
      cwd: "/tmp/project",
      startedAt: createdAt,
      endedAt: ["completed", "failed", "aborted"].includes(status) ? createdAt + 90_000 : undefined,
      finalText: "",
      retries: 0,
      toolErrors: [],
      timeline: [],
      ...overrides,
    },
  };
}

function fakeUiHarness({ columns = 80, rows = 30 } = {}) {
  const editor = { text: "" };
  const calls = { widgets: [], customs: [], pastes: [], inputUnsubscribed: 0, renders: 0 };
  let inputHandler;
  let rejectCustom;
  const tui = { terminal: { columns, rows }, requestRender() { calls.renders += 1; } };
  const keybindings = { matches: () => false };
  const ui = {
    theme: plainTheme(),
    onTerminalInput(handler) {
      inputHandler = handler;
      return () => { calls.inputUnsubscribed += 1; inputHandler = undefined; };
    },
    setWidget(key, content, options) {
      calls.widgets.push({ key, content, options });
      if (typeof content === "function") {
        const component = content(tui, plainTheme());
        calls.widgets.at(-1).component = component;
      }
    },
    getEditorText: () => editor.text,
    setEditorText(value) { editor.text = value; },
    pasteToEditor(text) { calls.pastes.push(text); editor.text = text; },
    custom(factory, options) {
      const entry = { factory, options, resolved: false, component: undefined };
      calls.customs.push(entry);
      entry.component = factory(tui, plainTheme(), keybindings, (value) => { entry.resolved = true; entry.result = value; });
      return new Promise((_resolve, reject) => { rejectCustom = reject; });
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: { getSessionId: () => "parent-1" },
  };
  return {
    ctx, calls, editor, tui,
    input: (data) => inputHandler?.(data),
    rejectCustom: (error = new Error("custom surface failed")) => rejectCustom?.(error),
    widgetLines: (width = 80) => {
      const last = [...calls.widgets].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY && call.component);
      return last ? last.component.render(width).map(stripVTControlCharacters) : [];
    },
  };
}

function controllerHarness({ columns = 80, rows = 30, options = {} } = {}) {
  const harness = fakeUiHarness({ columns, rows });
  const state = createBackgroundState();
  const controller = createSubagentRosterController(state, { now: () => 500_000, ...options });
  controller.start(harness.ctx);
  const addJob = (fixture) => { state.jobs.set(fixture.id, fixture); for (const listener of state.listeners) listener(); };
  return { ...harness, state, controller, addJob };
}

test("first Down selects the first child, first Up the last, and movement never wraps", () => {
  const { ctx, input, widgetLines, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));
  addJob(job("subagent_22222222-2222-4222-8222-222222222222", "queued", 2, "crawler"));
  addJob(job("subagent_33333333-3333-4333-8333-333333333333", "completed", 3, "generalist"));

  assert.equal(input(DOWN).consume, true, "Down over the empty editor is consumed");
  assert.match(widgetLines()[0], /^● explorer/, "the first child carries the solid marker");
  assert.ok(widgetLines().every((line) => !line.startsWith("● crawler") && !line.startsWith("● generalist")), "all other rows stay hollow");

  assert.equal(input(DOWN).consume, true);
  assert.match(widgetLines()[1], /^● crawler/);

  input(DOWN);
  assert.equal(input(DOWN).consume, true, "clamped movement still consumes");
  assert.match(widgetLines()[2], /^● generalist/, "clamped at the last child");

  // Escape-like non-navigation input clears the candidate; Up then enters at the last row.
  assert.equal(input("j"), undefined, "ordinary input passes through unchanged");
  assert.ok(widgetLines().every((line) => line.startsWith("○")), "editing clears the candidate");

  assert.equal(input(UP).consume, true);
  assert.match(widgetLines()[2], /^● generalist/, "first Up selects the last child");
  assert.equal(input(UP).consume, true);
  assert.equal(input(UP).consume, true);
  assert.match(widgetLines()[0], /^● explorer/, "clamped at the first child without wrapping");
  controller.stop();
  assert.ok(ctx);
});

test("a removed candidate re-enters like no candidate: Down first, Up last", () => {
  const { input, state, widgetLines, addJob, controller } = controllerHarness();
  const first = job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer");
  const second = job("subagent_22222222-2222-4222-8222-222222222222", "running", 2, "crawler");
  const third = job("subagent_33333333-3333-4333-8333-333333333333", "running", 3, "generalist");
  addJob(first);
  addJob(second);
  addJob(third);

  input(DOWN);
  input(DOWN);
  assert.match(widgetLines()[1], /^● crawler/, "the second child is the candidate");

  // The selected child leaves the store between key presses.
  state.jobs.delete(second.id);
  for (const listener of state.listeners) listener();
  assert.ok(!widgetLines().some((line) => line.startsWith("● crawler")), "the removed row is gone");

  input(UP);
  assert.match(widgetLines().at(-1), /^● generalist/, "Up from a removed candidate selects the last child, not the first");
  input("j");
  input(DOWN);
  assert.match(widgetLines()[0], /^● explorer/, "Down from a removed candidate selects the first child");
  controller.stop();
});

test("navigation activates only from an exactly empty editor", () => {
  const { input, editor, widgetLines, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));

  for (const draft of ["x", " ", "\n", "  draft  ", "\t"]) {
    editor.text = draft;
    assert.equal(input(DOWN), undefined, `draft ${JSON.stringify(draft)} keeps native Up/Down`);
    assert.equal(input(UP), undefined, `draft ${JSON.stringify(draft)} keeps native Up arrow`);
  }
  assert.ok(widgetLines().every((line) => line.startsWith("○")), "no candidate was created");

  editor.text = "";
  assert.equal(input(DOWN).consume, true);
  editor.text = " ";
  assert.equal(input(DOWN), undefined);
  assert.ok(widgetLines().every((line) => line.startsWith("○")), "a non-empty editor clears an existing candidate");
  controller.stop();
});

test("Enter opens only an explicit candidate in a centered capturing overlay", () => {
  const { input, calls, widgetLines, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));

  assert.equal(input(ENTER), undefined, "Enter without a candidate preserves Pi behavior");
  assert.equal(calls.customs.length, 0);

  input(DOWN);
  assert.equal(input(ENTER).consume, true);
  assert.equal(calls.customs.length, 1);
  const opened = calls.customs[0];
  assert.equal(opened.options.overlay, true, "the child opens as an overlay");
  const overlayOptions = opened.options.overlayOptions();
  assert.equal(overlayOptions.width, "80%", "normal-terminal outer width");
  assert.equal(overlayOptions.maxHeight, "75%", "normal-terminal outer height");
  assert.equal(overlayOptions.margin, undefined, "normal terminals add no margin");
  assert.match(widgetLines()[0], /^● explorer/, "the open child keeps the solid marker");

  // While the overlay owns input the global listener passes everything through.
  assert.equal(input(DOWN), undefined);
  assert.equal(input("a"), undefined);
  controller.stop();
});

test("controller routes transcript tools through the active display runtime and releases motion on UI rejection", async () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const observedAt = Date.parse("2025-01-01T00:00:05.000Z");
  const clock = new FakeClock();
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), {
    environment: { isTTY: true },
    clock,
  });
  let componentCreations = 0;
  const createComponent = runtime.createComponent.bind(runtime);
  runtime.createComponent = (...args) => {
    componentCreations += 1;
    return createComponent(...args);
  };

  try {
    writeSessionFile(root, [
      messageEntry("e1", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-runtime", name: "read", arguments: { offset: 2, limit: 3 } }],
        stopReason: "toolUse",
        timestamp: observedAt - 10_000,
      }, "2025-01-01T00:00:03.000Z"),
    ]);
    const { input, calls, rejectCustom, addJob, controller } = controllerHarness({
      options: { now: () => observedAt, display: () => runtime },
    });
    addJob(job(ID, "running", observedAt - 4_000, "explorer", { startedAt: observedAt - 4_000 }));

    input(DOWN);
    input(ENTER);
    const overlay = calls.customs[0].component;
    const before = overlay.render(64);
    const text = before.map(stripVTControlCharacters).join("\n");
    assert.match(text, /● Read lines 2-4/, "color-capable production runtime owns the operational marker and target");
    assert.equal(componentCreations, 1, "controller passes the active runtime into the overlay");

    clock.tick();
    assert.ok(calls.renders > 0, "the overlay's running row requests a frame on the shared motion tick");
    assert.notEqual(overlay.render(64), before, "the motion tick invalidates the outer overlay cache");

    calls.renders = 0;
    rejectCustom();
    await new Promise((resolve) => setImmediate(resolve));
    clock.tick();
    assert.equal(calls.renders, 0, "a rejected custom surface disposes the overlay motion subscriber");

    controller.stop();
    assert.equal(clock.callbacks.size, 0, "teardown releases roster and overlay motion subscriptions");
  } finally {
    runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("escape closes the overlay and clears the candidate", () => {
  const { input, calls, widgetLines, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));
  input(DOWN);
  input(ENTER);
  const opened = calls.customs[0];

  opened.component.handleInput(ESCAPE);
  assert.equal(opened.resolved, true, "closing resolves the overlay's custom promise");
  assert.ok(widgetLines().every((line) => line.startsWith("○")), "selection is cleared after close");
  assert.equal(calls.pastes.length, 0);

  // The roster seam is live again after the close.
  assert.equal(input(DOWN).consume, true);
  controller.stop();
});

test("printable input and paste close the overlay and replay without submitting", () => {
  const { input, editor, calls, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));
  input(DOWN);
  input(ENTER);
  const opened = calls.customs[0];

  opened.component.handleInput("\x1b[200~first\nsecond\x1b[201~");
  assert.equal(opened.resolved, true);
  assert.deepEqual(calls.pastes, ["first\nsecond"], "the complete paste replays into the editor");

  // The replayed draft is ordinary editor content now; navigation needs an
  // exactly empty editor again before a second child can open.
  editor.text = "";
  input(DOWN);
  input(ENTER);
  calls.customs[1].component.handleInput("z");
  assert.deepEqual(calls.pastes.at(-1), "z");
  controller.stop();
});

test("backspace and delete against the empty editor never close the overlay", () => {
  const { input, calls, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));
  input(DOWN);
  input(ENTER);
  const opened = calls.customs[0];
  opened.component.handleInput(BACKSPACE);
  opened.component.handleInput(DELETE);
  opened.component.handleInput("\x08");
  assert.equal(opened.resolved, false, "no-op editing keys keep the overlay open");
  assert.equal(calls.pastes.length, 0);
  controller.stop();
});

test("the owned-input-surface guard keeps pi-square modals in control", async () => {
  const { input, widgetLines, addJob, controller } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));

  assert.equal(isOwnedInputSurfaceActive(), false);
  const modal = withOwnedInputSurface(async () => {
    assert.equal(isOwnedInputSurfaceActive(), true);
    assert.equal(input(DOWN), undefined, "Up/Down stay with the owned modal");
    assert.equal(input(ENTER), undefined, "Enter stays with the owned modal");
    assert.ok(widgetLines().every((line) => line.startsWith("○")));
  });
  await modal;
  assert.equal(isOwnedInputSurfaceActive(), false);
  assert.equal(input(DOWN).consume, true, "navigation returns once the modal settles");
  controller.stop();
});

test("opening and viewing a child changes nothing in the background store", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    writeSessionFile(root, [messageEntry("e1", { role: "user", content: "question", timestamp: 1 })]);
    const { input, calls, state, addJob, controller } = controllerHarness();
    const fixture = job(ID, "running", 1, "explorer");
    addJob(fixture);
    const storeBefore = JSON.stringify({
      keys: [...state.jobs.keys()],
      jobs: [...state.jobs.values()].map((entry) => ({
        status: entry.status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        details: {
          phase: entry.details.phase,
          endedAt: entry.details.endedAt,
          finalText: entry.details.finalText,
          timeline: entry.details.timeline.length,
        },
      })),
    });

    input(DOWN);
    input(ENTER);
    assert.equal(calls.customs.length, 1);
    const opened = calls.customs[0];
    const text = opened.component.render(64).map(stripVTControlCharacters);
    assert.ok(text.some((line) => line.includes("question")), "the recent transcript renders in the overlay");
    assert.ok(text.every((line) => !line.includes(root)), "session paths never render");
    opened.component.handleInput(ESCAPE);
    input(DOWN);
    input(ENTER);
    calls.customs[1].component.handleInput("note");
    assert.deepEqual(calls.pastes, ["note"], "replay is the only editor effect");

    const storeAfter = JSON.stringify({
      keys: [...state.jobs.keys()],
      jobs: [...state.jobs.values()].map((entry) => ({
        status: entry.status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        details: {
          phase: entry.details.phase,
          endedAt: entry.details.endedAt,
          finalText: entry.details.finalText,
          timeline: entry.details.timeline.length,
        },
      })),
    });
    assert.equal(storeAfter, storeBefore, "viewing never mutates lifecycle, timing, or result state");
    controller.stop();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty failed child exposes a fixed reason without provider diagnostics", () => {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  try {
    writeSessionFile(root, []);
    const { input, calls, addJob, controller } = controllerHarness();
    addJob(job(ID, "failed", 1, "explorer", {
      error: 'Subagent failed: SUBAGENT_FAILED\nCause: {"password":"bare-secret","request_id":"req-internal"}\nPath: /private/session.jsonl',
      errorInfo: {
        code: "SUBAGENT_FAILED",
        message: "Subagent execution failed.",
        operation: "delegate",
        retryable: false,
        retries: 0,
      },
    }));

    input(DOWN);
    input(ENTER);
    const text = calls.customs[0].component.render(64).map(stripVTControlCharacters).join("\n");
    assert.match(text, /Failed: Child execution failed/);
    for (const leak of ["bare-secret", "req-internal", "/private/session.jsonl"]) {
      assert.ok(!text.includes(leak), `${leak} never renders in the empty failure state`);
    }
    controller.stop();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the roster viewport follows the candidate beyond the visible rows", () => {
  const columns = 80;
  const rows = 30;
  const budget = rosterRowBudget(rows);
  const { input, calls, widgetLines, addJob, controller } = controllerHarness({ columns, rows });
  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index).padStart(4, "0");
    addJob(job(`subagent_${suffix}${suffix}-${suffix}-4${suffix}-8${suffix}-${suffix}${suffix}${suffix}`, "running", index, `role${index}`));
  }
  const total = 12;
  assert.ok(total > budget, "fixture exceeds the visible budget");

  assert.equal(input(UP).consume, true, "first Up selects the last child");
  const lines = widgetLines();
  assert.match(lines.find((line) => line.startsWith("●")), /role11/, "the candidate row is visible");
  assert.match(lines[0], new RegExp(`\\+${total - budget} earlier`), "the leading indicator counts the rows above the window");
  assert.ok(!lines.at(-1).includes("more"), "no trailing accounting when the window reaches the end");
  const last = [...calls.widgets].reverse().find((call) => call.component);
  assert.ok(last.component.render(80).length <= budget + 1);

  assert.equal(input(UP).consume, true);
  assert.match(widgetLines().find((line) => line.startsWith("●")), /role10/, "movement inside the window keeps the row visible");
  controller.stop();
});

test("non-interactive contexts register no listener and teardown is clean", () => {
  const state = createBackgroundState();
  const controller = createSubagentRosterController(state);
  const calls = { widgets: [], input: 0 };
  const ctx = {
    mode: "print",
    hasUI: true,
    ui: {
      theme: plainTheme(),
      onTerminalInput() { calls.input += 1; return () => {}; },
      setWidget(key, content) { calls.widgets.push({ key, content }); },
      getEditorText: () => "",
    },
    sessionManager: { getSessionId: () => "parent-1" },
  };
  controller.start(ctx);
  assert.equal(calls.input, 0, "print mode registers no terminal listener");
  assert.equal(calls.widgets.length, 0);
  controller.stop();

  const { input, calls: tuiCalls, addJob, controller: tuiController } = controllerHarness();
  addJob(job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer"));
  input(DOWN);
  input(ENTER);
  tuiController.stop();
  assert.equal(tuiCalls.inputUnsubscribed, 1, "stop unsubscribes the terminal listener");
  assert.equal(tuiCalls.customs[0].resolved, true, "stop closes an open overlay");
  const last = tuiCalls.widgets.at(-1);
  assert.equal(last.key, SUBAGENT_ROSTER_KEY);
  assert.equal(last.content, undefined, "stop clears the roster widget");
});

test("the render layer marks the focus row solid and windows by start", () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    role: "explorer",
    status: "running",
    createdAt: index,
    startedAt: 0,
    endedAt: undefined,
    activity: "",
  }));
  const lines = renderSubagentRoster(plainTheme(), rows, {
    width: 80,
    rowBudget: 2,
    now: 0,
    focusId: rows[3].id,
    start: 2,
  }).map(stripVTControlCharacters);
  assert.equal(lines.length, 3, "the window shows the start slice plus its leading indicator");
  assert.match(lines[0], /\+2 earlier/, "the leading indicator counts the rows above the window");
  assert.match(lines[2], /^● /, "the focused row renders solid");
  assert.ok(lines.slice(1, 2).every((line) => line.startsWith("○ ")), "unfocused rows stay hollow");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
