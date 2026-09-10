import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import jiti from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// One caching jiti instance keeps the roster controller and these tests on the
// same input-surface module state.
const load = jiti(import.meta.url);
const rosterModule = await load(join(packageRoot, "src", "subagents", "roster.ts"));
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const artifactsModule = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const liveEventsModule = await load(join(packageRoot, "src", "subagents", "live-events.ts"));
const { createPromptSnapshot } = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));

const { createSubagentRosterController, rosterRowBudget, SUBAGENT_ROSTER_KEY } = rosterModule;
const { createBackgroundState } = backgroundModule;
const { ensureArtifactsDir, initializeSessionFile, writeRunState } = artifactsModule;
const { createChildViewFeed } = liveEventsModule;

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

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const ENTER = "\r";
const ESCAPE = "\x1b";
const EXPAND = "\x0f";
const WHEEL_UP_SGR = "\x1b[<64;10;5M";
const WHEEL_DOWN_SGR = "\x1b[<65;10;5M";
const WHEEL_UP_X10 = "\x1b[M`@@";

const ALPHA = "subagent_11111111-1111-4111-8111-111111111111";
const BETA = "subagent_22222222-2222-4222-8222-222222222222";
const GAMMA = "subagent_33333333-3333-4333-8333-333333333333";
const SESSION_ID = "session-1";

function transcriptRoot() {
  return join(tmpdir(), `pi-square-nav-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sessionHeader() {
  return { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" };
}

function messageEntry(id, message, timestamp = "2025-01-01T00:00:00Z") {
  return { type: "message", id, parentId: null, timestamp, message };
}

/** Writes one child's native artifacts so the pager reads real session files. */
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

/** A long ordered history whose every entry renders as a user message. */
function longHistory(prefix, count = 60) {
  return Array.from({ length: count }, (_, index) => messageEntry(
    `${prefix}-e${index}`,
    { role: "user", content: `${prefix} entry ${String(index).padStart(2, "0")}`, timestamp: index },
    new Date(index * 1000).toISOString(),
  ));
}

function job(id, status, createdAt, role, overrides = {}) {
  return {
    id,
    status,
    createdAt,
    updatedAt: createdAt + 1,
    abortController: new AbortController(),
    details: {
      startedAt: createdAt,
      agent: { name: role },
      lastParentSessionId: "parent-1",
      timeline: [],
      ...overrides,
    },
  };
}

function manualFeed() {
  const steps = [];
  const feed = createChildViewFeed({ schedule: (callback) => steps.push(callback) });
  return {
    feed,
    deliverAll: () => { while (steps.length > 0) steps.shift()?.(); },
  };
}

/**
 * Controller-level harness for #307: a real roster controller over a real
 * background store, real child session files, and a fake Pi UI whose custom
 * factory records one overlay component. The keybinding stub mirrors Pi's
 * effective expand-tools shortcut.
 */
function navigationHarness({
  columns = 80,
  rows = 30,
  theme,
  expandKey = EXPAND,
  display,
} = {}) {
  const root = transcriptRoot();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = root;
  const state = createBackgroundState();
  const live = manualFeed();
  state.viewFeed = live.feed;
  const editor = { text: "" };
  const calls = { customs: [], pastes: [], widgets: [] };
  let inputHandler;
  const tui = { terminal: { columns, rows }, requestRender() {} };
  const effectiveTheme = theme ?? plainTheme();
  const keybindings = {
    matches: (data, binding) => binding === "app.tools.expand" && data === expandKey,
    getKeys: (binding) => (binding === "app.tools.expand" ? ["ctrl+o"] : []),
  };
  const ui = {
    theme: effectiveTheme,
    onTerminalInput(handler) { inputHandler = handler; return () => {}; },
    setWidget(key, content, options) {
      calls.widgets.push({ key, content, options });
      if (typeof content === "function") {
        calls.widgets.at(-1).component = content(tui, effectiveTheme);
      }
    },
    getEditorText: () => editor.text,
    setEditorText(value) { editor.text = value; },
    pasteToEditor(text) { calls.pastes.push(text); editor.text = text; },
    custom(factory, options) {
      const entry = { factory, options, resolved: false, component: undefined };
      calls.customs.push(entry);
      entry.component = factory(tui, effectiveTheme, keybindings, () => { entry.resolved = true; });
      return new Promise(() => {});
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: { getSessionId: () => "parent-1" },
  };
  const options = { now: () => 500_000 };
  if (display !== undefined) options.display = () => display;
  const controller = createSubagentRosterController(state, options);
  controller.start(ctx);

  const addChild = (fixture) => {
    state.jobs.set(fixture.id, fixture);
    for (const listener of state.listeners) listener();
  };
  const removeChild = (id) => {
    state.jobs.delete(id);
    for (const listener of state.listeners) listener();
  };
  const updateChild = (id, patch) => {
    const current = state.jobs.get(id);
    if (!current) return;
    state.jobs.set(id, { ...current, ...patch, updatedAt: 500_001 });
    for (const listener of state.listeners) listener();
  };
  const input = (data) => inputHandler?.(data);
  const widgetLines = (width = 80) => {
    const last = [...calls.widgets].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY && call.component);
    return last ? last.component.render(width).map(stripVTControlCharacters) : [];
  };
  const overlay = () => {
    const last = [...calls.customs].reverse().find((entry) => entry.component);
    return last?.component;
  };
  const overlayText = (width = 64) => {
    const component = overlay();
    return component ? component.render(width).map(stripVTControlCharacters) : [];
  };
  const openChild = (id) => {
    input(DOWN);
    input(ENTER);
    return overlay();
  };

  return {
    root,
    previousAgentDir,
    state,
    controller,
    tui,
    editor,
    calls,
    live,
    input,
    addChild,
    removeChild,
    updateChild,
    widgetLines,
    overlay,
    overlayText,
    openChild,
  };
}

function cleanup(harness) {
  harness.controller.stop();
  if (harness.previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = harness.previousAgentDir;
  rmSync(harness.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Cross-child switching and per-child reading state

test("two simultaneous children switch in place through one overlay handle", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    assert.ok(overlay, "the first child opens");
    assert.equal(harness.calls.customs.length, 1);
    assert.match(harness.overlayText()[0], /^explorer /, "the open title names the first child");

    // Down moves a candidate; the roster marks it solid and the overlay footer
    // names it while the overlay covers the roster.
    overlay.handleInput(DOWN);
    assert.match(harness.widgetLines()[1], /^● crawler/, "the tentative candidate carries the solid marker");
    assert.match(harness.overlayText().at(-1), /candidate crawler /, "the footer names the off-screen candidate");

    // Enter re-points the same overlay: no stacking, no return to main.
    overlay.handleInput(ENTER);
    assert.equal(harness.calls.customs.length, 1, "switching never stacks a second overlay");
    assert.equal(harness.calls.customs[0].resolved, false, "the overlay stays open through the switch");
    assert.match(harness.overlayText()[0], /^crawler /, "the same overlay now shows the second child");
    assert.ok(!harness.overlayText().at(-1).includes("candidate"), "a confirmed candidate leaves the footer");
    assert.match(harness.widgetLines()[1], /^● crawler/, "the switched-to child keeps the solid marker");
    assert.ok(harness.widgetLines()[0].startsWith("○"), "the previous child is hollow again");
  } finally {
    cleanup(harness);
  }
});

test("each child independently preserves scroll position across direct switches", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.render(64); // resolve the tail viewport
    overlay.handleInput(PAGE_UP);
    const alphaText = harness.overlayText();
    const alphaIndicator = alphaText.find((line) => /earlier lines/.test(line));
    assert.ok(alphaIndicator, "page up suspends tail following for the first child");

    // Switch to the second child, scroll a different distance, switch back.
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    overlay.render(64);
    overlay.handleInput(PAGE_UP);
    overlay.handleInput(PAGE_UP);
    const betaIndicator = harness.overlayText().find((line) => /earlier lines/.test(line));
    assert.ok(betaIndicator, "the second child has its own suspended position");
    assert.notEqual(betaIndicator, alphaIndicator, "the two children hold different positions");

    overlay.handleInput(UP);
    overlay.handleInput(ENTER);
    const backText = harness.overlayText();
    assert.equal(
      backText.find((line) => /earlier lines/.test(line)),
      alphaIndicator,
      "returning to the first child restores its exact scroll offset",
    );
    assert.match(backText[0], /^explorer /, "the restored view is the first child again");
  } finally {
    cleanup(harness);
  }
});

test("follow state survives switches: a following child keeps following, a suspended one stays put", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.render(64);
    assert.ok(!harness.overlayText().some((line) => /later lines/.test(line)), "first open follows the tail");

    overlay.handleInput(PAGE_UP);
    assert.ok(harness.overlayText().some((line) => /later lines/.test(line)), "scrolling up suspends following");

    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    assert.ok(!harness.overlayText().some((line) => /later lines/.test(line)), "the other child opens following its own tail");

    overlay.handleInput(UP);
    overlay.handleInput(ENTER);
    assert.ok(harness.overlayText().some((line) => /later lines/.test(line)), "the suspended child stays suspended");
  } finally {
    cleanup(harness);
  }
});

test("escape cancels a changed candidate first and only then closes", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.handleInput(DOWN);
    assert.match(harness.overlayText().at(-1), /candidate crawler/);

    overlay.handleInput(ESCAPE);
    assert.equal(harness.calls.customs[0].resolved, false, "cancelling a candidate keeps the overlay open");
    assert.match(harness.overlayText()[0], /^explorer /, "the open child is restored");
    assert.ok(!harness.overlayText().at(-1).includes("candidate"), "the footer candidate is gone");
    assert.match(harness.widgetLines()[0], /^● explorer/, "the solid marker returns to the open child");
    assert.ok(harness.widgetLines()[1].startsWith("○"), "the cancelled candidate is hollow again");

    overlay.handleInput(ESCAPE);
    assert.equal(harness.calls.customs[0].resolved, true, "a second escape closes the overlay");
    assert.ok(harness.widgetLines().every((line) => line.startsWith("○")), "close clears selection");
  } finally {
    cleanup(harness);
  }
});

test("enter without a changed candidate keeps the open child", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.handleInput(ENTER);
    assert.equal(harness.calls.customs.length, 1);
    assert.match(harness.overlayText()[0], /^explorer /, "enter without a candidate changes nothing");

    // Clamped movement back onto the open child is no change either.
    overlay.handleInput(UP);
    assert.ok(!harness.overlayText().at(-1).includes("candidate"), "clamping onto the open child is not a change");
    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^explorer /);
    assert.equal(harness.calls.customs.length, 1);
  } finally {
    cleanup(harness);
  }
});

// ---------------------------------------------------------------------------
// Key separation, new output, expansion, wheel

test("transcript keys scroll while up and down stay roster keys", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.render(64);

    overlay.handleInput(PAGE_UP);
    let text = harness.overlayText();
    assert.ok(text.some((line) => /later lines/.test(line)), "page up suspends the tail and scrolls the transcript");
    assert.ok(!text.at(-1).includes("candidate"), "scrolling creates no candidate");
    const scrolled = text.find((line) => /later lines/.test(line));

    overlay.handleInput(DOWN);
    text = harness.overlayText();
    assert.equal(
      text.find((line) => /later lines/.test(line)),
      scrolled,
      "roster movement leaves the transcript position untouched",
    );
    assert.match(text.at(-1), /candidate crawler/, "roster movement sets the candidate");

    overlay.handleInput(PAGE_DOWN);
    assert.ok(!harness.overlayText().some((line) => /later lines/.test(line)), "page down scrolls back without touching the candidate");
    assert.match(harness.overlayText().at(-1), /candidate crawler/, "the candidate survives transcript scrolling");

    overlay.handleInput(END);
    assert.ok(!harness.overlayText().some((line) => /later lines/.test(line)), "end returns to the tail and resumes following");
  } finally {
    cleanup(harness);
  }
});

test("new live output below a suspended view is visible until end resumes following", () => {
  const harness = navigationHarness();
  try {
    const { sessionFile } = writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    const alpha = job(ALPHA, "running", 1, "explorer");
    harness.addChild(alpha);
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.render(64);
    overlay.handleInput(PAGE_UP);
    assert.ok(!harness.overlayText().at(-1).includes("new output"), "no notice before new content arrives");

    harness.live.feed.publish(ALPHA, { kind: "message_delta", parts: [{ type: "text", text: "streaming work" }] });
    harness.live.deliverAll();
    const suspended = harness.overlayText();
    assert.match(suspended.at(-1), /new output below/, "new live output sets the visible state");
    assert.ok(!suspended.some((line) => line.includes("streaming work")), "the suspended position does not jump to the new content");

    overlay.handleInput(END);
    const resumed = harness.overlayText();
    assert.ok(!resumed.at(-1).includes("new output"), "end clears the notice");
    assert.ok(resumed.some((line) => line.includes("streaming work")), "end resumes following at the tail");

    // Persisted growth behaves the same way: a later event's reconcile loads
    // the appended page below the suspended position.
    overlay.handleInput(PAGE_UP);
    appendSessionLine(sessionFile, messageEntry("late-1", {
      role: "user",
      content: "persisted later",
      timestamp: 61,
    }, new Date(61_000).toISOString()));
    harness.live.feed.publish(ALPHA, {
      kind: "tool_started",
      callKey: "deadbeef",
      name: "read",
      summary: "lines 1-4",
      startedAt: 500_000,
    });
    harness.live.deliverAll();
    assert.match(harness.overlayText().at(-1), /new output below/, "persisted appends below a suspended view set the state");
    overlay.handleInput(END);
    assert.ok(!harness.overlayText().at(-1).includes("new output"), "end clears it again after persisted growth");
  } finally {
    cleanup(harness);
  }
});

test("the effective expand-tools shortcut toggles only the open child's tool rows", () => {
  const created = [];
  const display = {
    createComponent(description, theme, options) {
      created.push({ tool: description.tool, expanded: options?.expanded === true });
      return {
        render: (width) => [`row ${description.tool} ${options?.expanded === true ? "expanded" : "collapsed"}`],
        invalidate: () => {},
      };
    },
    subscribeMotion: () => () => {},
  };
  const harness = navigationHarness({ display });
  try {
    writeChildArtifacts(harness.root, ALPHA, [
      messageEntry("e1", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
        stopReason: "toolUse",
        timestamp: 2,
      }),
      messageEntry("e2", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], isError: false, timestamp: 3 }),
    ]);
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    assert.ok(harness.overlayText().some((line) => line.includes("row read collapsed")), "tool rows start collapsed");

    overlay.handleInput(EXPAND);
    assert.ok(harness.overlayText().some((line) => line.includes("row read expanded")), "the shortcut expands the open child's tool rows");
    assert.deepEqual(harness.calls.pastes, [], "the shortcut never reaches the main editor");
    assert.equal(harness.calls.customs[0].resolved, false, "the shortcut never closes the overlay");
    assert.ok(!harness.overlayText().at(-1).includes("candidate"), "the shortcut is not roster navigation");

    // The state is per child: the other child opens collapsed, and switching
    // back restores the expanded state.
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    assert.ok(!harness.overlayText().some((line) => line.includes("expanded")), "a fresh child opens collapsed");

    overlay.handleInput(UP);
    overlay.handleInput(ENTER);
    assert.ok(harness.overlayText().some((line) => line.includes("row read expanded")), "expansion survives the round trip");

    overlay.handleInput(EXPAND);
    assert.ok(harness.overlayText().some((line) => line.includes("row read collapsed")), "the shortcut toggles back");
  } finally {
    cleanup(harness);
  }
});

test("the mouse wheel scrolls the transcript by small line steps", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));

    const overlay = harness.openChild(ALPHA);
    overlay.render(64);

    overlay.handleInput(WHEEL_DOWN_SGR);
    assert.ok(!harness.overlayText().some((line) => /later lines/.test(line)), "wheel down at the tail clamps");

    const earlierCount = (text) => {
      const line = text.find((candidate) => /\+\d+ earlier lines/.test(candidate));
      return line === undefined ? undefined : Number(/\+(\d+) earlier/.exec(line)[1]);
    };
    const atTail = earlierCount(harness.overlayText());
    assert.ok(atTail > 6, "fixture provides room to scroll");

    overlay.handleInput(WHEEL_UP_SGR);
    assert.equal(earlierCount(harness.overlayText()), atTail - 3, "one SGR wheel notch scrolls three lines");
    assert.ok(harness.overlayText().some((line) => /later lines/.test(line)), "the wheel suspends the tail too");
    assert.ok(!harness.overlayText().at(-1).includes("candidate"), "the wheel never moves the roster candidate");

    overlay.handleInput(WHEEL_UP_X10);
    assert.equal(earlierCount(harness.overlayText()), atTail - 6, "the X10 wheel sequence scrolls too");

    overlay.handleInput(WHEEL_DOWN_SGR);
    assert.equal(earlierCount(harness.overlayText()), atTail - 3, "wheel down moves back down");
  } finally {
    cleanup(harness);
  }
});

// ---------------------------------------------------------------------------
// Terminalization, dynamic rosters, viewport, resize

test("a viewed child that terminalizes stays open and stays switchable", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.handleInput(DOWN);
    assert.match(harness.overlayText().at(-1), /candidate crawler/);

    harness.updateChild(ALPHA, { status: "completed", details: { startedAt: 1, agent: { name: "explorer" }, lastParentSessionId: "parent-1", timeline: [], endedAt: 500_000 } });
    assert.equal(harness.calls.customs.length, 1, "terminalization never stacks or closes the overlay");
    assert.equal(harness.calls.customs[0].resolved, false);
    assert.match(harness.overlayText()[0], /completed/, "the open title shows the terminal lifecycle");
    assert.match(harness.overlayText().at(-1), /candidate crawler/, "a pending candidate survives terminalization of the open child");

    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^crawler /, "switching after terminalization still works");
  } finally {
    cleanup(harness);
  }
});

test("dynamic roster changes invalidate candidates and reading state safely", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    writeChildArtifacts(harness.root, GAMMA, longHistory("gamma"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));
    harness.addChild(job(GAMMA, "running", 3, "generalist"));

    const overlay = harness.openChild(ALPHA);

    // The candidate child leaves the store while tentative.
    overlay.handleInput(DOWN);
    assert.match(harness.overlayText().at(-1), /candidate crawler/);
    harness.removeChild(BETA);
    assert.ok(!harness.overlayText().at(-1).includes("candidate"), "a removed candidate leaves the footer");
    assert.match(harness.widgetLines()[0], /^● explorer/, "the solid marker returns to the open child");
    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^explorer /, "enter with a vanished candidate switches nowhere");
    assert.equal(harness.calls.customs.length, 1);

    // A child delegated while the overlay is open joins the navigation order
    // at its roster-creation position (here: last).
    harness.addChild(job(BETA, "running", 4, "crawler"));
    overlay.handleInput(DOWN);
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^crawler /, "new children join the navigation order");
    assert.match(harness.widgetLines().at(-1), /^● crawler/);

    // Escape after the removed-candidate case still closes.
    overlay.handleInput(ESCAPE);
    assert.equal(harness.calls.customs[0].resolved, true);
  } finally {
    cleanup(harness);
  }
});

test("the roster viewport follows an off-screen candidate while the overlay is open", () => {
  const rows = 30;
  const budget = rosterRowBudget(rows);
  const harness = navigationHarness({ columns: 80, rows });
  try {
    const fixtures = [];
    for (let index = 0; index < 12; index += 1) {
      // A valid public ID whose eight-character roster prefix is unique.
      const head = `${(index + 1).toString(16).padStart(2, "0")}111111`;
      const id = `subagent_${head}-1111-4111-8111-111111111111`;
      writeChildArtifacts(harness.root, id, longHistory(`role${index}`, 2));
      fixtures.push(job(id, "running", index, `role${index}`));
    }
    for (const fixture of fixtures) harness.addChild(fixture);
    assert.ok(fixtures.length > budget, "fixture exceeds the visible budget");

    const overlay = harness.openChild(fixtures[0].id);
    for (let index = 0; index < fixtures.length; index += 1) overlay.handleInput(DOWN);
    const lines = harness.widgetLines();
    assert.match(lines[0], new RegExp(`\\+${fixtures.length - budget} earlier`), "the window scrolled to the far end");
    assert.match(lines.find((line) => line.startsWith("●")), /role11/, "the candidate row is visible");
    const footer = harness.overlayText().at(-1);
    assert.match(footer, /candidate role11 /, "the footer identifies the off-screen candidate");
    assert.match(footer, /0c111111/, "the footer carries the candidate's unique short ID");
    assert.match(footer, /enter opens/, "the footer states the confirm path");

    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^role11 /, "the far-end candidate opens in place");
  } finally {
    cleanup(harness);
  }
});

test("resize recomputes budgets without losing the child, position, or width bounds", () => {
  const harness = navigationHarness({ columns: 120, rows: 45 });
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.render(96);
    overlay.handleInput(PAGE_UP);
    overlay.handleInput(DOWN);
    assert.match(harness.overlayText(96).at(-1), /candidate crawler/);

    // Cross the small/normal threshold in both dimensions.
    harness.tui.terminal.columns = 40;
    harness.tui.terminal.rows = 14;
    const narrow = harness.overlayText(36);
    assert.match(narrow[0], /^explorer /, "the open child survives the resize");
    assert.match(narrow.at(-1), /candidate crawler/, "the tentative candidate survives the resize");
    for (const line of narrow) assert.ok(visibleWidth(line) <= 36, "every line fits the narrow width");
    assert.ok(narrow.length <= 14, "the small overlay respects the low-height budget");

    harness.tui.terminal.columns = 120;
    harness.tui.terminal.rows = 45;
    const wide = harness.overlayText(96);
    assert.match(wide[0], /^explorer /);
    assert.match(wide.at(-1), /candidate crawler/);
    assert.ok(wide.some((line) => /earlier lines/.test(line)), "the suspended position survives both resizes");
    for (const line of wide) assert.ok(visibleWidth(line) <= 96, "every line fits the wide width");
    for (const line of harness.widgetLines(120)) assert.ok(visibleWidth(line) <= 120);
  } finally {
    cleanup(harness);
  }
});

// ---------------------------------------------------------------------------
// Regressions: replay, suppression, and the observational boundary

test("replay, no-op editing keys, and shortcut suppression stay correct after navigation", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const overlay = harness.openChild(ALPHA);
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    overlay.handleInput(UP);
    overlay.handleInput("\x1b[C");
    overlay.handleInput("\t");
    overlay.handleInput("\x03");
    overlay.handleInput("\x7f");
    overlay.handleInput("\x1b[3~");
    assert.equal(harness.calls.customs[0].resolved, false, "no-op and suppressed keys keep the overlay open");
    assert.deepEqual(harness.calls.pastes, []);

    overlay.handleInput("\x1b[200~first\nsecond\x1b[201~");
    assert.equal(harness.calls.customs[0].resolved, true, "paste closes the overlay");
    assert.deepEqual(harness.calls.pastes, ["first\nsecond"], "the complete paste replays without submitting");
    assert.ok(harness.widgetLines().every((line) => line.startsWith("○")), "replay clears selection");
  } finally {
    cleanup(harness);
  }
});

test("no view-state transition performs a child control or result-ownership operation", () => {
  const harness = navigationHarness();
  try {
    writeChildArtifacts(harness.root, ALPHA, longHistory("alpha"));
    writeChildArtifacts(harness.root, BETA, longHistory("beta"));
    harness.addChild(job(ALPHA, "running", 1, "explorer"));
    harness.addChild(job(BETA, "running", 2, "crawler"));

    const snapshot = () => JSON.stringify([...harness.state.jobs.entries()].map(([id, entry]) => ({
      id,
      status: entry.status,
      abortSignaled: entry.abortController.signal.aborted,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      details: {
        phase: entry.details.phase,
        endedAt: entry.details.endedAt ?? null,
        finalText: entry.details.finalText,
        timeline: entry.details.timeline.length,
      },
    })));

    const baseline = snapshot();
    const overlay = harness.openChild(ALPHA);
    overlay.render(64);
    overlay.handleInput(PAGE_UP);
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    overlay.handleInput(EXPAND);
    overlay.handleInput(UP);
    overlay.handleInput(ENTER);
    overlay.handleInput(DOWN);
    overlay.handleInput(ESCAPE);
    overlay.handleInput(ESCAPE);
    assert.equal(harness.calls.customs[0].resolved, true);
    assert.equal(snapshot(), baseline, "scrolling, switching, expanding, and cancelling change no store state");
  } finally {
    cleanup(harness);
  }
});

// ---------------------------------------------------------------------------
// Real theme snapshots

test("real light and dark themes snapshot the navigation overlay across layouts", () => {
  const themes = [
    ["dark", loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json"))],
    ["light", loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-light.json"))],
  ];
  for (const [name, theme] of themes) {
    for (const [columns, rows, width] of [[120, 45, 96], [40, 14, 36], [80, 18, 64]]) {
      const harness = navigationHarness({ columns, rows, theme });
      try {
        writeChildArtifacts(harness.root, ALPHA, longHistory("alpha", 40));
        writeChildArtifacts(harness.root, BETA, longHistory("beta", 40));
        harness.addChild(job(ALPHA, "running", 1, "explorer"));
        harness.addChild(job(BETA, "running", 2, "crawler"));

        const overlay = harness.openChild(ALPHA);
        overlay.render(width);
        overlay.handleInput(PAGE_UP);
        overlay.handleInput(DOWN);

        const lines = overlay.render(width);
        const text = lines.map(stripVTControlCharacters);
        assert.match(text[0], /^explorer /, `${name} ${columns}x${rows}: the title keeps the open child`);
        assert.match(text.at(-1), /candidate crawler /, `${name} ${columns}x${rows}: the footer names the candidate`);
        assert.ok(text.at(-1).includes("22222222"), `${name} ${columns}x${rows}: the candidate short ID renders`);
        assert.ok(lines.length <= rows, `${name} ${columns}x${rows}: the overlay fits the terminal height`);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width, `${name} ${columns}x${rows}: every line fits the width`);
        }
        assert.equal(text.filter((line) => /candidate crawler/.test(line)).length, 1, "exactly one footer row carries the candidate");

        // The default key-map row renders once no candidate is pending. The
        // full map fits the wide layout; narrower layouts keep its bounded
        // head, which is exactly the truncation contract.
        overlay.handleInput(ESCAPE);
        const settled = overlay.render(width).map(stripVTControlCharacters);
        assert.match(settled.at(-1), /esc close/, `${name} ${columns}x${rows}: the default key hints return`);
        if (width >= 96) {
          assert.match(settled.at(-1), /up\/down switch child/, "the key map documents roster navigation");
          assert.match(settled.at(-1), /ctrl\+o expand tools/, "the key map documents the expand shortcut");
        } else {
          assert.ok(settled.at(-1).length <= width, "narrow layouts truncate the key map to one bounded row");
        }

        const roster = harness.widgetLines(Math.min(columns, 80));
        for (const line of roster) assert.ok(visibleWidth(line) <= Math.min(columns, 80), `${name}: roster rows fit`);
        assert.ok(roster.some((line) => line.startsWith("●")), `${name}: the candidate row stays solid`);
      } finally {
        cleanup(harness);
      }
    }
  }
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
