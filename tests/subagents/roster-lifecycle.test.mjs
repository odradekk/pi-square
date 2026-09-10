import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

// One caching jiti instance keeps the composed modules — roster controller,
// manager, tools, delivery, and the input-surface counter — on shared module
// state, exactly like one Pi process.
const load = jiti(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rosterModule = await load(join(packageRoot, "src", "subagents", "roster.ts"));
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const toolModule = await load(join(packageRoot, "src", "subagents", "tool.ts"));
const managerModule = await load(join(packageRoot, "src", "subagents", "manager.ts"));
const deliveryModule = await load(join(packageRoot, "src", "subagents", "delivery.ts"));
const waitModule = await load(join(packageRoot, "src", "subagents", "wait.ts"));
const artifactsModule = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const liveEventsModule = await load(join(packageRoot, "src", "subagents", "live-events.ts"));
const { createPromptSnapshot } = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));

const { SUBAGENT_ROSTER_KEY, createSubagentRosterController } = rosterModule;
const {
  abortAllBackgroundJobs,
  cancelBackgroundJobs,
  createBackgroundState,
  createQueuedJob,
  notifyBackgroundChange,
  replaceBackgroundViewFeed,
} = backgroundModule;
const { registerSubagentTool } = toolModule;
const { registerSubagentManager, __testables: managerTestables } = managerModule;
const { createDeliveryController } = deliveryModule;
const { createSubagentBlockingCallRegistry } = waitModule;
const { ensureArtifactsDir, initializeSessionFile, writeRunState } = artifactsModule;
const { createChildViewFeed } = liveEventsModule;

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

const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const ENTER = "\r";
const ESCAPE = "\x1b";

const SESSION_ID = "parent-1";
const NOTIFICATION_TYPE = "pi-square.subagent-notification";

function id(n) {
  return `subagent_00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
}

async function waitFor(predicate, description, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function jobFixture(idValue, status, createdAt, role, overrides = {}) {
  return {
    id: idValue,
    status,
    createdAt,
    updatedAt: createdAt + 1,
    abortController: new AbortController(),
    details: {
      startedAt: createdAt,
      endedAt: ["completed", "failed", "aborted"].includes(status) ? createdAt + 90_000 : undefined,
      agent: { name: role },
      lastParentSessionId: SESSION_ID,
      timeline: [],
      ...overrides,
    },
  };
}

/** Writes one child's native artifacts so the pager reads real session files. */
function writeChildArtifacts(root, idValue) {
  process.env.PI_AGENT_DIR = root;
  const artifactsDir = ensureArtifactsDir(idValue);
  const sessionFile = join(artifactsDir, "session.jsonl");
  const header = { type: "session", version: 3, id: `native-${idValue}`, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" };
  initializeSessionFile({ id: idValue, artifactsDir, sessionFile, header });
  const entries = [header];
  for (let index = 0; index < 30; index += 1) {
    entries.push({
      type: "message",
      id: `${idValue}-e${index}`,
      parentId: null,
      timestamp: new Date(index * 1000).toISOString(),
      message: { role: "user", content: `entry ${String(index).padStart(2, "0")}`, timestamp: index },
    });
  }
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeRunState(artifactsDir, {
    version: 4,
    id: idValue,
    operation: "delegate",
    artifactsDir,
    sessionFile,
    sessionId: `native-${idValue}`,
    originParentSessionId: SESSION_ID,
    lastParentSessionId: SESSION_ID,
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    agent: { promptVersion: 2, name: "explorer", inheritParentSystem: true },
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

/**
 * Composition harness for #308: the real roster controller, delivery machine,
 * blocking-call registry, parent tools, and manager command over one real
 * background store, wired with the same event seams `src/subagents/index.ts`
 * installs. Any wiring change there must be mirrored here.
 */
function lifecycleHarness({ columns = 80, rows = 30, tuiMode = "regular", idle = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-square-roster-lifecycle-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = root;

  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const customs = [];
  const pastes = [];
  const notifications = [];
  let inputHandler;
  let inputUnsubscribed = false;
  const editor = { text: "" };
  const idleRef = { value: idle };
  const tui = { terminal: { columns, rows }, mode: tuiMode, requestRender() {} };
  const theme = plainTheme();
  const keybindings = { matches: () => false, getKeys: () => [] };

  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    registerCommand(name, definition) { commands.set(name, definition); },
    getThinkingLevel: () => "off",
    sendMessage(message, options) { sent.push({ message, options }); },
    sendUserMessage(text, options) {
      // Pi routes sendUserMessage through session.prompt with source
      // "extension"; the input handlers observe it exactly that way.
      handlers.get("input")?.({ type: "input", text, source: "extension", streamingBehavior: options?.deliverAs });
    },
  };

  const state = {
    registry: { definitions: [], errors: [], projectDir: null },
    background: createBackgroundState(),
    sessionCtx: undefined,
    inheritedSystemCore: undefined,
    config: undefined,
  };
  const delivery = createDeliveryController({
    pi,
    isIdle: () => state.sessionCtx?.isIdle() ?? true,
    notify: () => notifyBackgroundChange(state.background),
  });
  const blockingCallRegistry = createSubagentBlockingCallRegistry();
  state.background.delivery = delivery;
  const roster = createSubagentRosterController(state.background, {});

  registerSubagentTool(pi, state, undefined, blockingCallRegistry);
  registerSubagentManager(pi, state, undefined);

  // The same event wiring src/subagents/index.ts installs.
  pi.on("input", (event) => {
    roster.handleMainInput(event?.source);
  });
  pi.on("agent_start", () => { delivery.handleAgentStart(); });
  pi.on("turn_end", (event) => { delivery.handleTurnEnd(event?.message); });
  pi.on("agent_end", (event) => { delivery.handleAgentEnd(event?.messages); });
  pi.on("agent_settled", () => { delivery.handleAgentSettled(); });
  pi.on("message_start", (event) => { delivery.observeMessage(event?.message); });
  pi.on("session_shutdown", async () => {
    state.background.viewFeed?.clear();
    roster.stop();
    blockingCallRegistry.terminateAll("session shutdown");
    abortAllBackgroundJobs(pi, state.background);
    delivery.reset();
    state.sessionCtx = undefined;
    state.inheritedSystemCore = undefined;
  });

  const ui = {
    theme,
    widgetCalls: [],
    notify(message, level) { notifications.push({ message, level }); },
    setWidget(key, content, options) { ui.widgetCalls.push({ key, content, options }); },
    getEditorText: () => editor.text,
    setEditorText(value) { editor.text = value; },
    pasteToEditor(text) { pastes.push(text); editor.text = text; },
    onTerminalInput(handler) {
      inputHandler = handler;
      return () => { inputUnsubscribed = true; inputHandler = undefined; };
    },
    custom(factory, options) {
      const entry = { factory, options, resolved: false, component: undefined, finish: undefined, resolve: undefined };
      entry.finish = () => {
        if (entry.resolved) return;
        entry.resolved = true;
        entry.resolve?.();
      };
      customs.push(entry);
      entry.component = factory(tui, theme, keybindings, () => entry.finish());
      return new Promise((resolve) => { entry.resolve = resolve; });
    },
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    isIdle: () => idleRef.value,
    ui,
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getSessionDir: () => root,
    },
  };

  const toolCtx = {
    cwd: root,
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
  };

  const startSession = async (sessionCtx = ctx) => {
    state.sessionCtx = sessionCtx;
    blockingCallRegistry.terminateAll("session replaced");
    delivery.reset();
    replaceBackgroundViewFeed(state.background);
    roster.stop();
    roster.start(sessionCtx);
  };

  const fireStore = () => {
    for (const listener of state.background.listeners) listener();
  };

  const addChild = (job) => {
    state.background.jobs.set(job.id, job);
    fireStore();
  };

  const patchChild = (jobId, patch) => {
    const current = state.background.jobs.get(jobId);
    assert.ok(current, `job ${jobId} exists`);
    Object.assign(current, patch);
    current.updatedAt = 500_001;
    fireStore();
  };

  const input = (data) => inputHandler?.(data);
  const widgetLines = (width = columns) => {
    const last = [...ui.widgetCalls].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY);
    if (!last || typeof last.content !== "function") return [];
    return last.content(tui, theme).render(width).map(stripVTControlCharacters);
  };
  const overlay = () => {
    const last = [...customs].reverse().find((entry) => entry.component !== undefined);
    return last?.component;
  };
  const overlayText = (width = 64) => {
    const component = overlay();
    return component ? component.render(width).map(stripVTControlCharacters) : [];
  };
  /** Opens the roster row at `index` (creation order): first Down selects row 0. */
  const openChildAt = (index) => {
    for (let step = 0; step <= index; step += 1) input(DOWN);
    input(ENTER);
    return overlay();
  };
  const mainInput = (source = "interactive", text = "next task please") => {
    handlers.get("input")?.({ type: "input", text, source });
  };

  return {
    root,
    previousAgentDir,
    pi,
    handlers,
    tools,
    commands,
    sent,
    customs,
    pastes,
    notifications,
    editor,
    idleRef,
    tui,
    ctx,
    toolCtx,
    ui,
    state,
    delivery,
    blockingCallRegistry,
    roster,
    startSession,
    fireStore,
    addChild,
    patchChild,
    input,
    widgetLines,
    overlay,
    overlayText,
    openChildAt,
    mainInput,
    get inputUnsubscribed() { return inputUnsubscribed; },
    cleanup() {
      if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Deterministic terminal transition through the real delivery seam. The
 * details become a complete V4 record so notification validation and
 * transcript confirmation see exactly what a real run would persist.
 */
function finishJob(harness, job, status, extra = {}) {
  job.status = status;
  job.details = {
    version: 4,
    id: job.id,
    operation: "delegate",
    ...job.details,
    phase: status,
    finalText: extra.finalText ?? (status === "completed" ? `result of ${job.id}` : ""),
    endedAt: 500_000,
    durationMs: 500_000 - job.details.startedAt,
  };
  harness.state.background.delivery.enqueue({ id: job.id, status, details: job.details });
  harness.fireStore();
}

// ─── Main-task visibility epochs ────────────────────────────────────

test("terminal rows of every terminal lifecycle stay inspectable through the current main task", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));
    harness.addChild(jobFixture(id(2), "failed", 2, "crawler"));
    harness.addChild(jobFixture(id(3), "aborted", 3, "generalist"));

    let lines = harness.widgetLines();
    assert.equal(lines.length, 3, "all terminal rows render through the current task");
    assert.ok(lines[0].includes("✓ completed"));
    assert.ok(lines[1].includes("✗ failed"));
    assert.ok(lines[2].includes("× aborted"));

    // A terminal row stays openable while its task is current.
    const overlay = harness.openChildAt(0);
    assert.ok(overlay, "the completed child opens while its row is current");
    assert.match(harness.overlayText()[0], /^explorer /);
    overlay.handleInput(ESCAPE);
    lines = harness.widgetLines();
    assert.equal(lines.length, 3, "closing the overlay changes no retention");
  } finally {
    harness.cleanup();
  }
});

test("a real prompt submitted to main expires the preceding task's terminal rows; active rows survive", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    const completed = jobFixture(id(1), "completed", 1, "explorer");
    const running = jobFixture(id(2), "running", 2, "crawler");
    harness.addChild(completed);
    harness.addChild(running);
    assert.equal(harness.widgetLines().length, 2);

    harness.mainInput("interactive");
    let lines = harness.widgetLines();
    assert.equal(lines.length, 1, "the terminal row expired with the preceding task");
    assert.ok(lines[0].includes("crawler"), "the active row survived the new prompt");

    // The store is untouched: the UI adds no retention store of its own, and
    // the manager still owns the historical record.
    assert.equal(harness.state.background.jobs.size, 2, "store retention is unchanged");

    // The surviving active child stays visible when it later terminalizes.
    finishJob(harness, running, "completed");
    lines = harness.widgetLines();
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("✓ completed"), "the later terminalization joins the current epoch");

    // And expires with the next real prompt, like every ordinary terminal row.
    harness.mainInput("interactive");
    lines = harness.widgetLines();
    assert.equal(lines.length, 0, "no rows remain after the following prompt");
    assert.equal(harness.state.background.jobs.size, 2, "store retention still unchanged");
  } finally {
    harness.cleanup();
  }
});

test("slash commands, shell commands, drafts, navigation, overlay changes, and scrolling never advance the epoch", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(2));
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));
    harness.addChild(jobFixture(id(2), "running", 2, "crawler"));

    // Slash commands: Pi handles built-ins in the TUI and extension commands
    // inside session.prompt before the input event fires, so the epoch seam
    // never sees one; local `!` shell commands emit user_bash instead, which
    // nothing here subscribes to.
    assert.equal(harness.handlers.has("user_bash"), false, "no local-shell epoch seam exists");

    // A draft never submits: typed input passes through and keeps the rows.
    harness.editor.text = "a draft";
    assert.deepEqual(harness.input("x"), undefined, "draft input reaches Pi unchanged");
    harness.editor.text = "";
    assert.equal(harness.widgetLines().length, 2, "drafting keeps the terminal row");

    // Roster navigation is consumed and never advances the epoch.
    assert.deepEqual(harness.input(DOWN), { consume: true });
    assert.equal(harness.widgetLines().length, 2, "navigation keeps the terminal row");

    // Opening, scrolling inside, and closing the overlay neither.
    const overlay = harness.openChildAt(1);
    assert.ok(overlay);
    overlay.handleInput(PAGE_UP);
    overlay.handleInput(DOWN); // in-overlay candidate movement
    overlay.handleInput(ESCAPE); // cancel the candidate
    overlay.handleInput(ESCAPE); // close
    assert.equal(harness.customs[0].resolved, true, "overlay closed");
    assert.equal(harness.widgetLines().length, 2, "view interaction keeps the terminal row");

    // An extension continuation (the Config Guide follow-up path) is a real
    // input event but never a task boundary.
    harness.pi.sendUserMessage("please inspect the subagent configuration", { deliverAs: "followUp" });
    assert.equal(harness.widgetLines().length, 2, "extension continuations keep the terminal row");

    // The same seam does expire on a real prompt, proving the trace can see
    // the difference.
    harness.mainInput("interactive");
    assert.equal(harness.widgetLines().length, 1, "only the active row survives a real prompt");
  } finally {
    harness.cleanup();
  }
});

test("interactive and rpc prompts advance the epoch; extension sources never do", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    harness.mainInput("rpc");
    assert.equal(harness.widgetLines().length, 0, "an rpc prompt is a real prompt");

    // A later extension continuation must not expire the next task's rows.
    const later = jobFixture(id(2), "running", 20, "crawler");
    harness.addChild(later);
    finishJob(harness, later, "completed");
    assert.equal(harness.widgetLines().length, 1);
    harness.mainInput("extension");
    assert.equal(harness.widgetLines().length, 1, "extension source keeps the current task");
    harness.mainInput("interactive");
    assert.equal(harness.widgetLines().length, 0, "interactive expires again");
  } finally {
    harness.cleanup();
  }
});

test("a resumed public ID returns to the roster when re-queued and re-joins the current epoch", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));
    assert.equal(harness.widgetLines().length, 1);

    harness.mainInput("interactive");
    assert.equal(harness.widgetLines().length, 0, "expired with its task");

    // Re-queue under the same public ID, exactly like createQueuedResumeJob.
    const queued = createQueuedJob({
      state: harness.state.background,
      id: id(1),
      task: "continue the work",
      cwd: harness.root,
      parentSessionId: SESSION_ID,
      promptSnapshot: createPromptSnapshot(),
    });
    void queued;
    let lines = harness.widgetLines();
    assert.equal(lines.length, 1, "the resumed public ID is visible again");
    assert.ok(lines[0].includes("– queued"));

    finishJob(harness, harness.state.background.jobs.get(id(1)), "completed");
    lines = harness.widgetLines();
    assert.equal(lines.length, 1, "the re-terminalized row joins the current epoch");
    assert.ok(lines[0].includes("✓ completed"));
  } finally {
    harness.cleanup();
  }
});

test("store compaction stays the single retention authority; the roster follows it exactly", async () => {
  // Distinct eight-character prefixes keep every row individually checkable.
  const cid = (index) => `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const harness = lifecycleHarness({ rows: 40 });
  try {
    await harness.startSession();
    const jobs = [];
    for (let index = 0; index < 22; index += 1) {
      jobs.push(createQueuedJob({
        state: harness.state.background,
        id: cid(index),
        task: `task-${index}`,
        cwd: harness.root,
        parentSessionId: SESSION_ID,
        promptSnapshot: createPromptSnapshot(),
      }));
    }
    // One child carries an undelivered pending result before compaction ever
    // runs, so its exemption is in force for every cycle below.
    const survivor = jobs[0];
    harness.state.background.delivery.enqueue({ id: survivor.id, status: "completed", details: survivor.details });
    assert.equal(harness.state.background.delivery.isPending(survivor.id), true);

    // Cancel every queued job through the real cancellation seam: each
    // terminal transition runs the store's finished-job compaction. The
    // pending result is exempt, so the bound keeps twenty ordinary finished
    // jobs plus the exempt survivor.
    cancelBackgroundJobs({ state: harness.state.background, all: true, reason: "cancel queued fixtures" });
    assert.equal(harness.state.background.jobs.size, 21, "twenty finished jobs plus the pending exemption");
    assert.ok(harness.state.background.jobs.has(survivor.id), "the pending result survived compaction");

    // The roster renders exactly the store's retained set: ten visible rows
    // at this terminal height plus the accounting line for the other eleven.
    const lines = harness.widgetLines();
    assert.equal(lines.length, 11, "ten rows plus the below-window accounting line");
    assert.ok(lines.at(-1).includes("+11 more"), "the accounting line names the retained remainder");

    for (let index = 100; index < 104; index += 1) {
      createQueuedJob({
        state: harness.state.background,
        id: cid(index),
        task: `extra-${index}`,
        cwd: harness.root,
        parentSessionId: SESSION_ID,
        promptSnapshot: createPromptSnapshot(),
      });
      cancelBackgroundJobs({ state: harness.state.background, all: true, reason: "compaction cycle" });
    }
    assert.ok(harness.state.background.jobs.has(survivor.id), "the pending result stays retained");
    assert.ok(
      harness.widgetLines().some((line) => line.includes("00000000")),
      "the pending-result row still renders",
    );
  } finally {
    harness.cleanup();
  }
});

// ─── No-UI modes and interactive mode equivalence ───────────────────

test("print, JSON, RPC, and headless contexts create no roster, overlay, listener, timer, or output change", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const harness = lifecycleHarness();
    try {
      const widgetCalls = [];
      let listenerRegistered = false;
      const ctx = {
        mode,
        hasUI: false,
        cwd: harness.root,
        ui: {
          theme: plainTheme(),
          setWidget(key, content, options) { widgetCalls.push({ key, content, options }); },
          getEditorText: () => "",
          notify() { throw new Error("no output change in no-UI contexts"); },
          onTerminalInput() { listenerRegistered = true; return () => {}; },
          custom() { throw new Error("no overlay may be created"); },
        },
        sessionManager: { getSessionId: () => SESSION_ID, getSessionDir: () => harness.root },
      };
      await harness.startSession(ctx);
      assert.equal(widgetCalls.length, 0, `${mode}: no widget published`);
      assert.equal(listenerRegistered, false, `${mode}: no terminal-input listener registered`);
      assert.equal(harness.customs.length, 0, `${mode}: no overlay was created`);

      const job = jobFixture(id(1), "running", 1, "explorer");
      harness.state.background.jobs.set(job.id, job);
      harness.mainInput("interactive");
      harness.mainInput("extension");
      harness.roster.refresh();
      assert.equal(widgetCalls.length, 0, `${mode}: store changes and input events change nothing`);
    } finally {
      harness.cleanup();
    }
  }
});

test("interactive regular and fullscreen modes expose the same roster, selection, overlay, scrolling, and replay contract", async () => {
  async function script(harness) {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    writeChildArtifacts(harness.root, id(2));
    harness.addChild(jobFixture(id(1), "running", 1, "explorer"));
    harness.addChild(jobFixture(id(2), "completed", 2, "crawler"));
    const trace = {};
    trace.rows = harness.widgetLines();
    assert.deepEqual(harness.input(DOWN), { consume: true });
    trace.selection = harness.widgetLines();
    const overlay = harness.openChildAt(0);
    trace.openTitle = harness.overlayText()[0];
    overlay.handleInput(PAGE_UP);
    trace.scrolled = harness.overlayText().some((line) => /earlier lines/.test(line));
    overlay.handleInput(ESCAPE);
    overlay.handleInput(ESCAPE);
    trace.closed = harness.customs[0].resolved;
    // Ordinary printable input replays into the empty editor without submit.
    harness.input("h");
    trace.replay = harness.pastes;
    return trace;
  }
  const regularHarness = lifecycleHarness({ tuiMode: "regular" });
  let regular;
  const fullscreenHarness = lifecycleHarness({ tuiMode: "fullscreen" });
  let fullscreen;
  try {
    regular = await script(regularHarness);
    fullscreen = await script(fullscreenHarness);
  } finally {
    regularHarness.cleanup();
    fullscreenHarness.cleanup();
  }
  assert.deepEqual(regular.rows, fullscreen.rows, "roster rows are identical");
  assert.deepEqual(regular.selection, fullscreen.selection, "selection is identical");
  assert.equal(regular.openTitle, fullscreen.openTitle, "the open overlay title is identical");
  assert.equal(regular.scrolled, fullscreen.scrolled, "transcript scrolling behaves the same");
  assert.equal(regular.closed, fullscreen.closed, "overlay close behaves the same");
  assert.deepEqual(regular.replay, fullscreen.replay, "input replay behaves the same");
  // The mouse wheel is the one compositing difference: pi-tui delivers wheel
  // events to the focused overlay only on the fullscreen alt screen, and the
  // roster never enables mouse tracking itself.
});

// ─── Deterministic teardown across parent-session boundaries ────────

test("parent replacement closes the overlay, clears widget and view state, and leaves jobs to the store", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    harness.addChild(jobFixture(id(1), "running", 1, "explorer"));
    const overlay = harness.openChildAt(0);
    assert.ok(overlay);

    const secondWidgets = [];
    const secondCtx = {
      mode: "tui",
      hasUI: true,
      cwd: harness.root,
      isIdle: () => true,
      ui: {
        ...harness.ctx.ui,
        setWidget(key, content, options) { secondWidgets.push({ key, content, options }); },
      },
      sessionManager: { getSessionId: () => "parent-2", getSessionDir: () => harness.root },
    };
    await harness.startSession(secondCtx);

    assert.equal(harness.customs[0].resolved, true, "the overlay was closed by teardown");
    assert.equal(
      [...harness.ui.widgetCalls].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY)?.content,
      undefined,
      "the prior session's widget was cleared",
    );
    assert.equal(secondWidgets.length, 1, "the new session publishes its own state");
    assert.equal(secondWidgets[0].content, undefined, "the replacement session has no current children");
    // The viewer teardown never aborts children: the job stays exactly as it
    // was, now foreign to the new session like every old-session record.
    assert.equal(harness.state.background.jobs.get(id(1)).status, "running");
    assert.equal(harness.state.background.viewFeed === undefined, false, "the feed generation was replaced, not destroyed");
  } finally {
    harness.cleanup();
  }
});

test("every replacement reason tears the roster down through the same session_start path", async () => {
  for (const reason of ["reload", "new", "resume", "fork"]) {
    const harness = lifecycleHarness();
    try {
      await harness.startSession();
      harness.addChild(jobFixture(id(1), "running", 1, "explorer"));
      assert.equal(harness.widgetLines().length, 1);

      const widgets = [];
      const nextCtx = {
        mode: "tui",
        hasUI: true,
        cwd: harness.root,
        isIdle: () => true,
        ui: { ...harness.ctx.ui, setWidget(key, content, options) { widgets.push({ key, content, options }); } },
        sessionManager: { getSessionId: () => `parent-${reason}`, getSessionDir: () => harness.root },
      };
      await harness.startSession(nextCtx);
      assert.equal(
        [...harness.ui.widgetCalls].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY)?.content,
        undefined,
        `${reason}: prior widget cleared`,
      );
      assert.equal(widgets.length, 1, `${reason}: the new session starts clean`);
    } finally {
      harness.cleanup();
    }
  }
});

test("session shutdown closes the overlay and keeps abort and delivery reset in the established path", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    createQueuedJob({
      state: harness.state.background,
      id: id(1),
      task: "task",
      cwd: harness.root,
      parentSessionId: SESSION_ID,
      promptSnapshot: createPromptSnapshot(),
    });
    const overlay = harness.openChildAt(0);
    assert.ok(overlay);
    // An undelivered pending result exercises the delivery reset.
    const finished = jobFixture(id(2), "completed", 2, "crawler");
    harness.addChild(finished);
    harness.state.background.delivery.enqueue({ id: id(2), status: "completed", details: finished.details });
    assert.ok(harness.state.background.delivery.pendingCount() >= 1);

    await harness.handlers.get("session_shutdown")({}, harness.ctx);

    assert.equal(harness.customs[0].resolved, true, "shutdown closed the overlay");
    assert.equal(
      [...harness.ui.widgetCalls].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY)?.content,
      undefined,
      "shutdown cleared the widget",
    );
    assert.equal(harness.inputUnsubscribed, true, "the terminal-input listener was released");
    // The established shutdown path — not the viewer — owns aborting and the
    // delivery reset.
    assert.equal(harness.state.background.jobs.get(id(1)).status, "aborted", "active children were aborted");
    assert.equal(harness.state.background.delivery.pendingCount(), 0, "delivery was reset");
  } finally {
    harness.cleanup();
  }
});

test("the viewer's own teardown never aborts children or resets delivery", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    const running = jobFixture(id(1), "running", 1, "explorer");
    harness.addChild(running);
    const finished = jobFixture(id(2), "completed", 2, "crawler");
    harness.addChild(finished);
    harness.state.background.delivery.enqueue({ id: id(2), status: "completed", details: finished.details });
    const pendingBefore = harness.state.background.delivery.pendingCount();

    // The roster controller's stop is the viewer teardown alone: no session
    // boundary, no abort, no delivery reset, no wait termination.
    harness.roster.stop();
    assert.equal(harness.state.background.jobs.get(id(1)).status, "running", "viewer teardown never aborts");
    assert.equal(harness.state.background.delivery.pendingCount(), pendingBefore, "viewer teardown never resets delivery");
    assert.equal(
      [...harness.ui.widgetCalls].reverse().find((call) => call.key === SUBAGENT_ROSTER_KEY)?.content,
      undefined,
      "the widget is still cleared",
    );
  } finally {
    harness.cleanup();
  }
});

test("teardown unsubscribes every listener and cancels pending repaint work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-roster-lifecycle-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = root;
  try {
    const timers = { pending: new Map(), seq: 0 };
    const paintTimers = {
      setTimeout(callback, ms) { timers.seq += 1; timers.pending.set(timers.seq, callback); return timers.seq; },
      clearTimeout(handle) { timers.pending.delete(handle); },
    };
    const motionSubscribers = { count: 0 };
    const state = createBackgroundState();
    const widgets = [];
    let inputUnsubscribed = false;
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      ui: {
        theme: plainTheme(),
        setWidget(key, content, options) { widgets.push({ key, content, options }); },
        getEditorText: () => "",
        onTerminalInput() { return () => { inputUnsubscribed = true; }; },
        custom() { return new Promise(() => {}); },
      },
      sessionManager: { getSessionId: () => SESSION_ID, getSessionDir: () => root },
    };
    const controller = createSubagentRosterController(state, {
      now: () => 500_000,
      motion: () => ({
        subscribe: (listener) => {
          motionSubscribers.count += 1;
          void listener;
          return () => { motionSubscribers.count -= 1; };
        },
      }),
      timers: paintTimers,
    });
    controller.start(ctx);
    state.jobs.set(id(1), jobFixture(id(1), "running", 1, "explorer"));
    for (const listener of state.listeners) listener();
    assert.equal(typeof widgets.at(-1).content, "function", "the running child published a widget");

    controller.handleMainInput("interactive");
    controller.stop();
    assert.equal(state.listeners.size, 0, "background subscription released");
    assert.equal(inputUnsubscribed, true, "terminal-input listener released");
    assert.equal(motionSubscribers.count, 0, "motion subscription released");
    assert.equal(timers.pending.size, 0, "pending repaint work was cancelled");
    assert.equal(widgets.at(-1).content, undefined, "widget cleared");

    // A restarted controller opens its first main task with no carried-over
    // expiry: terminal rows of the new session are visible from epoch 1.
    const second = jobFixture(id(2), "completed", 5, "crawler");
    controller.start(ctx);
    state.jobs.set(second.id, second);
    for (const listener of state.listeners) listener();
    assert.equal(
      typeof widgets.at(-1).content,
      "function",
      "the new session's terminal rows start visible",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Delivery, wait, abort, and resume isolation while the viewer is used ──

test("automatic delivery, its confirmation, and expiry stay exact while the viewer is open", async () => {
  const harness = lifecycleHarness({ idle: false });
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    const running = jobFixture(id(1), "running", 1, "explorer");
    harness.addChild(running);
    const overlay = harness.openChildAt(0);
    assert.ok(overlay);

    finishJob(harness, running, "completed");
    assert.equal(harness.state.background.delivery.isPending(id(1)), true, "viewing consumed no result");
    // Overlay interaction while the busy parent holds the result for its next
    // turn boundary.
    overlay.handleInput(PAGE_UP);
    overlay.handleInput(ESCAPE);
    overlay.handleInput(ESCAPE);
    assert.equal(harness.sent.length, 0, "viewing sends nothing by itself");

    // The settled idle parent receives the batch through the established path.
    harness.idleRef.value = true;
    harness.handlers.get("agent_settled")();
    assert.equal(harness.sent.length, 1, "automatic delivery fired once");
    assert.equal(harness.sent[0].message.customType, NOTIFICATION_TYPE);
    assert.equal(harness.sent[0].message.details.results[0].id, id(1));
    assert.equal(harness.state.background.delivery.pendingCount(), 1, "unconfirmed until the transcript observes it");

    // Confirmation comes only from the transcript observation: Pi injects the
    // sent custom message into the parent transcript as message_start.
    harness.handlers.get("message_start")({
      message: {
        role: "custom",
        customType: harness.sent[0].message.customType,
        details: harness.sent[0].message.details,
      },
    });
    assert.equal(harness.state.background.delivery.pendingCount(), 0, "transcript confirmation consumed the result");

    // The delivered row stays visible through the current task, and expires
    // with the next real prompt like every ordinary terminal row.
    assert.ok(harness.widgetLines().some((line) => line.includes("✓ completed")));
    harness.mainInput("interactive");
    assert.equal(harness.widgetLines().length, 0);
  } finally {
    harness.cleanup();
  }
});

test("an explicit wait claims, survives viewer use, and consumes the result without automatic delivery", async () => {
  const harness = lifecycleHarness({ idle: false });
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    const running = jobFixture(id(1), "running", 1, "explorer");
    harness.addChild(running);
    const waitTool = harness.tools.get("wait_subagent");
    assert.ok(waitTool);

    const pending = waitTool.execute("call-1", { ids: [id(1)] }, undefined, undefined, harness.toolCtx);
    await waitFor(() => harness.state.background.delivery.isClaimed(id(1)), "claim registered");
    const overlay = harness.openChildAt(0);
    assert.ok(overlay, "a claimed child stays openable");
    overlay.handleInput(PAGE_UP);
    overlay.handleInput(ESCAPE);
    overlay.handleInput(ESCAPE);
    assert.ok(harness.state.background.delivery.isClaimed(id(1)), "viewer use never releases the claim");
    assert.equal(harness.sent.length, 0, "nothing delivered while the claim is held");

    finishJob(harness, running, "completed");
    harness.handlers.get("agent_settled")();
    assert.equal(harness.sent.length, 0, "a claimed result is excluded from automatic delivery");

    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.equal(result.details.results[0].id, id(1));
    assert.equal(result.details.results[0].status, "completed");
    assert.equal(harness.state.background.delivery.isClaimed(id(1)), false, "the wait consumed its claim");
  } finally {
    harness.cleanup();
  }
});

test("interrupting a wait releases its claims without aborting children while the viewer is open", async () => {
  const harness = lifecycleHarness({ idle: false });
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    const running = jobFixture(id(1), "running", 1, "explorer");
    harness.addChild(running);
    const waitTool = harness.tools.get("wait_subagent");
    const controller = new AbortController();

    const pending = waitTool.execute("call-1", { ids: [id(1)] }, controller.signal, undefined, harness.toolCtx);
    await waitFor(() => harness.state.background.delivery.isClaimed(id(1)), "claim registered");

    const overlay = harness.openChildAt(0);
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "ABORTED");
    assert.equal(harness.state.background.delivery.isClaimed(id(1)), false, "claims released");
    assert.equal(harness.state.background.jobs.get(id(1)).status, "running", "the child was not aborted");
    assert.ok(overlay, "the open overlay survived the interruption");

    // The released completed result rejoins the automatic schedule.
    finishJob(harness, running, "completed");
    harness.idleRef.value = true;
    harness.handlers.get("agent_settled")();
    assert.equal(harness.sent.length, 1, "the released result delivers automatically");
  } finally {
    harness.cleanup();
  }
});

test("explicit abort stops a viewed child, keeps the overlay open on its final state, and never delivers an unclaimed aborted result", async () => {
  const harness = lifecycleHarness({ idle: true });
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    createQueuedJob({
      state: harness.state.background,
      id: id(1),
      task: "task",
      cwd: harness.root,
      parentSessionId: SESSION_ID,
      promptSnapshot: createPromptSnapshot(),
    });
    const overlay = harness.openChildAt(0);
    assert.ok(overlay);

    const abortTool = harness.tools.get("abort_subagent");
    assert.ok(abortTool);
    const result = await abortTool.execute("call-1", { ids: [id(1)] }, undefined, undefined, harness.toolCtx);
    assert.equal(result.isError, undefined, "a successful abort request is a successful tool call");
    assert.equal(harness.state.background.jobs.get(id(1)).status, "aborted");

    // The overlay the abort targeted stays open and truthful.
    assert.match(harness.overlayText()[0], /aborted/, "the open overlay shows the aborted lifecycle");
    overlay.handleInput(ESCAPE);
    assert.equal(harness.customs[0].resolved, true);

    harness.handlers.get("agent_settled")();
    assert.equal(harness.sent.length, 0, "an unclaimed aborted result never notifies the parent");
    assert.ok(
      harness.widgetLines().some((line) => line.includes("× aborted")),
      "the aborted row stays inspectable through the current task",
    );
  } finally {
    harness.cleanup();
  }
});

test("same-ID resume stays blocked by pending and claimed results while the viewer is used", async () => {
  const harness = lifecycleHarness({ idle: false });
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    const finished = jobFixture(id(1), "completed", 1, "explorer");
    harness.addChild(finished);
    finishJob(harness, finished, "completed");
    const resumeTool = harness.tools.get("resume_subagent");
    assert.ok(resumeTool);

    const overlay = harness.openChildAt(0);
    assert.ok(overlay, "the finished child is openable while its result is pending");

    let result = await resumeTool.execute("resume-1", { id: id(1), task: "again" }, undefined, undefined, harness.toolCtx);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "RESULT_PENDING");

    // The public ID becomes active again while its earlier result stays
    // pending, so an explicit wait owns the result instead of consuming it
    // immediately.
    createQueuedJob({
      state: harness.state.background,
      id: id(1),
      task: "continue",
      cwd: harness.root,
      parentSessionId: SESSION_ID,
      promptSnapshot: createPromptSnapshot(),
    });
    const waitTool = harness.tools.get("wait_subagent");
    const pending = waitTool.execute("call-1", { ids: [id(1)] }, undefined, undefined, harness.toolCtx);
    await waitFor(() => harness.state.background.delivery.isClaimed(id(1)), "claim registered");
    result = await resumeTool.execute("resume-2", { id: id(1), task: "again" }, undefined, undefined, harness.toolCtx);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "RESULT_CLAIMED");
    assert.ok(harness.state.background.delivery.isClaimed(id(1)), "viewer use changed no ownership");

    finishJob(harness, harness.state.background.jobs.get(id(1)), "completed");
    await pending;
  } finally {
    harness.cleanup();
  }
});

test("manager inspection and the roster coexist without stealing keys or touching ownership", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    const running = jobFixture(id(1), "running", 1, "explorer");
    harness.addChild(running);
    assert.equal(harness.widgetLines().length, 1);

    // The manager's own data view (its inspection) sees the same store.
    const snapshot = managerTestables.snapshot(harness.state, SESSION_ID);
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].id, id(1));

    // Opening the manager holds the owned-input surface; the roster's keys
    // defer to it while it is open and return afterwards.
    const opened = harness.commands.get("subagent").handler("", harness.ctx);
    assert.equal(harness.customs.length, 1, "the manager opened");
    assert.deepEqual(harness.input(DOWN), undefined, "roster navigation defers to the owned modal");
    harness.customs[0].finish();
    await opened;
    assert.deepEqual(harness.input(DOWN), { consume: true }, "roster navigation returns after the manager closes");
    harness.input(ESCAPE);

    // The parameterized command's Config Guide follow-up is an extension
    // continuation: it never advances the visibility epoch.
    const before = harness.widgetLines().length;
    await harness.commands.get("subagent").handler("make the explorer definition read-only", harness.ctx);
    assert.equal(harness.widgetLines().length, before, "the follow-up kept the current task");
    const guide = harness.sent.find((entry) => entry.message.customType === "pi-square.subagent-config-guide");
    assert.ok(guide, "the Config Guide was sent as a follow-up");

    // Ownership untouched throughout.
    assert.equal(harness.state.background.delivery.pendingCount(), 0);
    assert.equal(harness.state.background.delivery.isClaimed(id(1)), false);
    assert.equal(harness.state.background.jobs.get(id(1)).status, "running");
  } finally {
    harness.cleanup();
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
