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
const mainTaskInputModule = await load(join(packageRoot, "src", "subagents", "main-task-input.ts"));
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
const { registerMainTaskInputEvents } = mainTaskInputModule;

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

const UP = "\x1b[A";
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

  // A faithful stand-in for Pi's extension event chain: registrations append
  // (one extension may add several handlers per event) and emitInput runs
  // them in order with the runner's aggregation semantics — action:"handled"
  // short-circuits the chain so session.prompt never sends the prompt, and
  // action:"transform" rewrites the text later handlers see.
  const handlers = new Map();
  const queuedSteers = [];
  const queuedFollowUps = [];
  const extensionCtx = { hasPendingMessages: () => queuedSteers.length + queuedFollowUps.length > 0 };
  const chain = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    has(event) { return handlers.has(event); },
    async emitInput(text, source, streamingBehavior) {
      let currentText = text;
      for (const handler of handlers.get("input") ?? []) {
        const result = (await handler({
          type: "input",
          text: currentText,
          source,
          ...(streamingBehavior ? { streamingBehavior } : {}),
        }, extensionCtx)) ;
        if (result?.action === "handled") return { action: "handled" };
        if (result?.action === "transform") currentText = result.text;
      }
      return currentText !== text
        ? { action: "transform", text: currentText }
        : { action: "continue" };
    },
    async emit(event, payload, ctxArg = extensionCtx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctxArg);
    },
    emitMessageStart(message) {
      for (const handler of handlers.get("message_start") ?? []) {
        handler({ type: "message_start", message }, extensionCtx);
      }
    },
    emitBeforeAgentStart() {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        handler({ type: "before_agent_start" }, extensionCtx);
      }
    },
  };
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const customs = [];
  const pastes = [];
  const notifications = [];
  /** Prompt submissions that reached main: before_agent_start observed. */
  const acceptedPrompts = [];
  /**
   * A later-registered foreign extension's input response, applied after the
   * pi-square handlers in chain order exactly like a second extension.
   */
  const foreignInput = { response: undefined };
  let inputHandler;
  let inputUnsubscribed = false;
  const editor = { text: "" };
  const idleRef = { value: idle };
  const tui = { terminal: { columns, rows }, mode: tuiMode, requestRender() {} };
  const theme = plainTheme();
  const keybindings = { matches: () => false, getKeys: () => [] };

  const pi = {
    on(event, handler) { chain.on(event, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerMessageRenderer() {},
    registerCommand(name, definition) { commands.set(name, definition); },
    getThinkingLevel: () => "off",
    sendMessage(message, options) { sent.push({ message, options }); },
    sendUserMessage(text, options) {
      // Pi routes sendUserMessage through session.prompt with source
      // "extension"; the input chain observes it exactly that way.
      void chain.emitInput(text, "extension", options?.deliverAs);
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

  // Exercise the production event registrar rather than copying its ordering.
  registerMainTaskInputEvents(pi, () => roster.advanceMainTaskEpoch());
  pi.on("agent_start", () => { delivery.handleAgentStart(); });
  pi.on("turn_end", (event) => { delivery.handleTurnEnd(event?.message); });
  pi.on("agent_end", (event) => { delivery.handleAgentEnd(event?.messages); });
  pi.on("agent_settled", () => { delivery.handleAgentSettled(); });
  pi.on("message_start", (event) => {
    delivery.observeMessage(event?.message);
  });
  // The foreign extension registers after pi-square, so its input response
  // applies later in the chain — the position a real second extension has.
  chain.on("input", () => foreignInput.response ?? undefined);
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
    queuedSteers.length = 0;
    queuedFollowUps.length = 0;
    await chain.emit("session_start", { type: "session_start", reason: "startup" }, sessionCtx);
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
  /**
   * Mirrors session.prompt's event order for one submitted prompt: the input
   * chain first (a later handler may handle or transform it), then — only if
   * nothing handled it and preflight passes — before_agent_start and the user
   * message_start. A streamingBehavior queues instead, exactly like Pi.
   */
  const submitPrompt = async (options = {}) => {
    const {
      source = "interactive",
      text = "next task please",
      streamingBehavior,
      preflightFail = false,
    } = options;
    const result = await chain.emitInput(text, source, streamingBehavior);
    if (result.action === "handled") return "handled";
    if (streamingBehavior) {
      const queue = streamingBehavior === "followUp" ? queuedFollowUps : queuedSteers;
      queue.push({
        text: result.action === "transform" ? result.text : text,
        timestamp: Date.now(),
      });
      return "queued";
    }
    if (preflightFail) return "preflight-failed";
    acceptedPrompts.push(result.action === "transform" ? result.text : text);
    chain.emitBeforeAgentStart();
    chain.emitMessageStart({
      role: "user",
      content: [{ type: "text", text: result.action === "transform" ? result.text : text }],
      timestamp: Date.now(),
    });
    return "sent";
  };
  /** Drains one queued streaming input the way the running agent does. */
  const drainStreamingInput = (text = "queued steering text") => {
    const queue = queuedSteers.length > 0 ? queuedSteers : queuedFollowUps;
    const queued = queue.shift();
    chain.emitMessageStart({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: queued?.timestamp ?? Date.now(),
    });
  };
  const mainInput = (source = "interactive") => submitPrompt({ source });

  return {
    root,
    previousAgentDir,
    pi,
    chain,
    foreignInput,
    acceptedPrompts,
    submitPrompt,
    drainStreamingInput,
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

    await harness.mainInput("interactive");
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
    await harness.mainInput("interactive");
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
    await harness.mainInput("interactive");
    assert.equal(harness.widgetLines().length, 1, "only the active row survives a real prompt");
  } finally {
    harness.cleanup();
  }
});

test("interactive and rpc idle prompts advance at before_agent_start; extension sources never do", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // Pi emits before_agent_start only after preflight, once the message
    // array is built — the boundary that proves main accepted the prompt.
    const outcome = await harness.submitPrompt({ source: "interactive", text: "next task" });
    assert.equal(outcome, "sent");
    assert.deepEqual(harness.acceptedPrompts, ["next task"]);
    assert.equal(harness.widgetLines().length, 0, "an accepted interactive prompt expires the row");

    const later = jobFixture(id(2), "running", 20, "crawler");
    harness.addChild(later);
    finishJob(harness, later, "completed");
    assert.equal(harness.widgetLines().length, 1);
    await harness.submitPrompt({ source: "extension", text: "config guide follow-up" });
    assert.equal(harness.widgetLines().length, 1, "an accepted extension prompt keeps the current task");
    await harness.submitPrompt({ source: "rpc", text: "rpc task" });
    assert.equal(harness.widgetLines().length, 0, "an accepted rpc prompt expires again");
    assert.deepEqual(
      harness.acceptedPrompts,
      ["next task", "config guide follow-up", "rpc task"],
      "all three reached main; only the real ones moved the epoch",
    );
  } finally {
    harness.cleanup();
  }
});

test("a later extension returning handled from the input chain never advances the epoch", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));
    assert.equal(harness.widgetLines().length, 1);

    // A second extension registered after pi-square answers the input chain
    // with action:"handled": session.prompt returns before any agent run, so
    // before_agent_start never fires and the prompt was never submitted.
    harness.foreignInput.response = { action: "handled" };
    const outcome = await harness.submitPrompt({ source: "interactive", text: "swallowed prompt" });
    assert.equal(outcome, "handled");
    assert.deepEqual(harness.acceptedPrompts, [], "main never accepted the prompt");
    assert.equal(harness.widgetLines().length, 1, "the terminal row survived the unsubmitted prompt");

    // The same chain with the foreign extension passive advances normally.
    harness.foreignInput.response = undefined;
    const second = await harness.submitPrompt({ source: "interactive", text: "real prompt" });
    assert.equal(second, "sent");
    assert.equal(harness.widgetLines().length, 0, "the next accepted prompt expires the row");
  } finally {
    harness.cleanup();
  }
});

test("a transformed prompt still advances when main accepts the transformed text", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    harness.foreignInput.response = { action: "transform", text: "transformed task text" };
    const outcome = await harness.submitPrompt({ source: "interactive", text: "original text" });
    assert.equal(outcome, "sent");
    assert.deepEqual(harness.acceptedPrompts, ["transformed task text"], "the transformed text is what main received");
    assert.equal(harness.widgetLines().length, 0, "the accepted transformed prompt expires the row");
  } finally {
    harness.cleanup();
  }
});

test("a prompt that fails preflight never advances the epoch", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // Pi throws out of session.prompt (no model / auth) before emitting
    // before_agent_start, so the epoch must not move.
    const outcome = await harness.submitPrompt({ source: "interactive", preflightFail: true });
    assert.equal(outcome, "preflight-failed");
    assert.deepEqual(harness.acceptedPrompts, []);
    assert.equal(harness.widgetLines().length, 1, "a rejected prompt keeps the preceding task's rows");
  } finally {
    harness.cleanup();
  }
});

test("a queued real steer advances at its user message_start, not at the input event", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // While the parent streams, Pi queues the steer without a new
    // before_agent_start; the input event alone must not expire anything.
    const queued = await harness.submitPrompt({ source: "interactive", text: "steer please", streamingBehavior: "steer" });
    assert.equal(queued, "queued");
    assert.equal(harness.widgetLines().length, 1, "the queued steer did not advance the epoch yet");

    // The running agent drains the queue: the user message_start is the
    // proof the steer reached main.
    harness.drainStreamingInput("steer please");
    assert.equal(harness.widgetLines().length, 0, "the drained real steer expires the row");
  } finally {
    harness.cleanup();
  }
});

test("a queued extension follow-up never advances at its user message_start", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    const running = jobFixture(id(2), "running", 2, "crawler");
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));
    harness.addChild(running);

    harness.pi.sendUserMessage("config guide continuation", { deliverAs: "followUp" });
    harness.drainStreamingInput("config guide continuation");
    assert.equal(harness.widgetLines().length, 2, "an extension follow-up never expires rows");
  } finally {
    harness.cleanup();
  }
});

test("a transformed streaming prompt advances only when its source remains unambiguous", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    harness.foreignInput.response = { action: "transform", text: "transformed real steer" };
    await harness.submitPrompt({
      source: "interactive",
      text: "original real steer",
      streamingBehavior: "steer",
    });
    harness.drainStreamingInput("transformed real steer");
    assert.equal(harness.widgetLines().length, 0, "an accepted transformed real steer advances the epoch");

    await harness.startSession();
    harness.foreignInput.response = { action: "transform", text: "transformed extension follow-up" };
    await harness.submitPrompt({
      source: "extension",
      text: "original extension follow-up",
      streamingBehavior: "followUp",
    });
    harness.drainStreamingInput("transformed extension follow-up");
    assert.equal(harness.widgetLines().length, 1, "an accepted transformed extension follow-up does not advance");
  } finally {
    harness.cleanup();
  }
});

test("a handled streaming input cannot contaminate the next accepted queued message", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // pi-square observes this real steer first, but a later extension handles
    // it, so Pi never queues it and no user message_start will consume it.
    harness.foreignInput.response = { action: "handled" };
    const swallowedReal = await harness.submitPrompt({
      source: "interactive",
      text: "swallowed real steer",
      streamingBehavior: "steer",
    });
    assert.equal(swallowedReal, "handled");

    // The next accepted message is an extension follow-up. Its source must be
    // correlated with its own text rather than the swallowed real input.
    harness.foreignInput.response = undefined;
    await harness.submitPrompt({
      source: "extension",
      text: "accepted extension follow-up",
      streamingBehavior: "followUp",
    });
    harness.drainStreamingInput("accepted extension follow-up");
    assert.equal(harness.widgetLines().length, 1, "the extension follow-up did not inherit the swallowed real source");

    // The inverse ordering must still recognize the real message that main
    // actually receives.
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({
      source: "extension",
      text: "swallowed extension steer",
      streamingBehavior: "steer",
    });
    harness.foreignInput.response = undefined;
    await harness.submitPrompt({
      source: "interactive",
      text: "accepted real follow-up",
      streamingBehavior: "followUp",
    });
    harness.drainStreamingInput("accepted real follow-up");
    assert.equal(harness.widgetLines().length, 0, "the accepted real follow-up advances the epoch");

    // Even equal text cannot contaminate the next accepted message when Pi's
    // pending-message signal proves the earlier observation was handled.
    await harness.startSession();
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({
      source: "interactive",
      text: "identical queued input",
      streamingBehavior: "steer",
    });
    harness.foreignInput.response = undefined;
    await harness.submitPrompt({
      source: "extension",
      text: "identical queued input",
      streamingBehavior: "steer",
    });
    harness.drainStreamingInput("identical queued input");
    assert.equal(harness.widgetLines().length, 1, "the accepted extension message keeps the row");
  } finally {
    harness.cleanup();
  }
});

test("native enqueue timestamps isolate handled input while older messages remain queued", async () => {
  const harness = lifecycleHarness();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // A keeps Pi's pending signal true while B is swallowed. C has B's text,
    // so only the timestamp captured when C really entered Pi's queue can
    // distinguish the two observations.
    await harness.submitPrompt({ source: "extension", text: "queued A", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({ source: "extension", text: "collision", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = undefined;
    await harness.submitPrompt({ source: "interactive", text: "collision", streamingBehavior: "steer" });
    harness.drainStreamingInput("queued A");
    assert.equal(harness.widgetLines().length, 1, "the older accepted extension message keeps the row");
    harness.drainStreamingInput("collision");
    assert.equal(harness.widgetLines().length, 0, "C uses its native enqueue timestamp and advances as real");

    // Reverse B and C's sources: a swallowed real input must not make the
    // accepted extension continuation expire the row.
    await harness.startSession();
    await harness.submitPrompt({ source: "extension", text: "queued A2", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({ source: "interactive", text: "collision 2", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = undefined;
    await harness.submitPrompt({ source: "extension", text: "collision 2", streamingBehavior: "steer" });
    harness.drainStreamingInput("queued A2");
    harness.drainStreamingInput("collision 2");
    assert.equal(harness.widgetLines().length, 1, "C remains an extension continuation");

    // A transform can make C's final text equal B's raw text. The newer
    // enqueue boundary still identifies C; text equality must not select B.
    await harness.startSession();
    now += 10;
    await harness.submitPrompt({ source: "extension", text: "queued A3", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({ source: "extension", text: "transformed collision", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = { action: "transform", text: "transformed collision" };
    await harness.submitPrompt({ source: "interactive", text: "original C3", streamingBehavior: "steer" });
    harness.drainStreamingInput("queued A3");
    harness.drainStreamingInput("transformed collision");
    assert.equal(harness.widgetLines().length, 0, "a transformed real C wins over handled B's matching text");

    await harness.startSession();
    now += 10;
    harness.foreignInput.response = undefined;
    await harness.submitPrompt({ source: "extension", text: "queued A4", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({ source: "interactive", text: "transformed collision 2", streamingBehavior: "steer" });
    now += 10;
    harness.foreignInput.response = { action: "transform", text: "transformed collision 2" };
    await harness.submitPrompt({ source: "extension", text: "original C4", streamingBehavior: "steer" });
    harness.drainStreamingInput("queued A4");
    harness.drainStreamingInput("transformed collision 2");
    assert.equal(harness.widgetLines().length, 1, "a transformed extension C never inherits handled real B's text");
  } finally {
    Date.now = realNow;
    harness.cleanup();
  }
});

test("queued input correlation has no arbitrary observation cap", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // Pi itself owns queue capacity. The presentation correlator must not
    // silently stop recognizing accepted real prompts at a separate bound.
    for (let index = 0; index < 65; index += 1) {
      await harness.submitPrompt({ source: "interactive", text: `steer ${index}`, streamingBehavior: "steer" });
    }
    harness.drainStreamingInput("steer 0");
    assert.equal(harness.widgetLines().length, 0, "the first of 65 accepted real steers still advances the epoch");
  } finally {
    harness.cleanup();
  }
});

test("an aborted run cannot poison later runs or replacement sessions", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));

    // A later extension swallows this observation. agent_end is the
    // deterministic recovery boundary after the run is aborted.
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({
      source: "interactive",
      text: "swallowed before abort",
      streamingBehavior: "steer",
    });
    await harness.chain.emit("agent_end", { messages: [] });

    harness.foreignInput.response = undefined;
    await harness.submitPrompt({
      source: "interactive",
      text: "real after abort",
      streamingBehavior: "steer",
    });
    harness.drainStreamingInput("real after abort");
    assert.equal(harness.widgetLines().length, 0, "agent_end discards the aborted run's observation");

    // A replacement session must also discard a swallowed source left by its
    // predecessor rather than applying it to a new-session extension message.
    await harness.startSession();
    harness.foreignInput.response = { action: "handled" };
    await harness.submitPrompt({
      source: "interactive",
      text: "old-session swallowed steer",
      streamingBehavior: "steer",
    });
    harness.foreignInput.response = undefined;
    await harness.startSession();
    await harness.submitPrompt({
      source: "extension",
      text: "new-session extension follow-up",
      streamingBehavior: "followUp",
    });
    harness.drainStreamingInput("new-session extension follow-up");
    assert.equal(harness.widgetLines().length, 1, "session replacement discards the predecessor's source state");
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

    await harness.mainInput("interactive");
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

test("expiry that empties the roster drops retained reading state; a returning row starts fresh", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.startSession();
    writeChildArtifacts(harness.root, id(1));
    writeChildArtifacts(harness.root, id(2));
    harness.addChild(jobFixture(id(1), "completed", 1, "explorer"));
    harness.addChild(jobFixture(id(2), "completed", 2, "crawler"));

    // Open the second child, switch to the first, suspend its tail, and
    // switch back: the first child now holds retained reading state (#307).
    const overlay = harness.openChildAt(1);
    assert.ok(overlay);
    overlay.handleInput(UP);
    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^explorer /);
    overlay.handleInput(PAGE_UP);
    const suspended = harness.overlayText();
    assert.ok(!suspended.some((line) => /entry 29/.test(line)), "the suspended view left the tail");
    assert.ok(suspended.some((line) => /entry (?:0[0-9]|1[0-9])/.test(line)), "the suspended view sits above the newest entries");
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^crawler /, "switched back to the open child");

    // A real prompt expires both terminal rows: the roster empties while the
    // overlay stays open on its child.
    await harness.mainInput("interactive");
    assert.equal(harness.widgetLines().length, 0, "both rows expired");
    assert.equal(harness.customs[0].resolved, false, "the overlay stays open");

    // The expired child returns under the same public ID and terminalizes
    // again inside the current epoch, so its history renders in the overlay.
    const returning = createQueuedJob({
      state: harness.state.background,
      id: id(1),
      task: "continue the work",
      cwd: harness.root,
      parentSessionId: SESSION_ID,
      promptSnapshot: createPromptSnapshot(),
    });
    returning.details.agent.name = "explorer";
    finishJob(harness, returning, "completed");
    assert.equal(harness.widgetLines().length, 1, "the returning row is visible again");

    // From the still-open overlay, navigate to it and confirm: the retained
    // reading state was dropped with the expired row, so the view is fresh —
    // it follows the tail instead of restoring the suspended position.
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    assert.match(harness.overlayText()[0], /^explorer /, "the overlay switched to the returning child");
    const fresh = harness.overlayText();
    assert.ok(fresh.some((line) => /entry 29/.test(line)), "the fresh view follows the tail");
    assert.ok(!fresh.some((line) => /entry 0[0-4]/.test(line)), "the suspended early-history position was not restored");
    assert.ok(!fresh.some((line) => /new output below/.test(line)), "no stale new-output notice survived");
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
      await harness.mainInput("interactive");
      await harness.mainInput("extension");
      harness.roster.refresh();
      assert.equal(widgetCalls.length, 0, `${mode}: store changes and input events change nothing`);
    } finally {
      harness.cleanup();
    }
  }
});

test("interactive regular and fullscreen modes expose the same roster, selection, overlay, scrolling, and replay contract", async () => {
  const TYPED = "keep working here";
  const PASTED = "first line\nsecond line";
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

    // Ordinary typed text, delivered to the OPEN overlay, closes it and
    // replays the complete content into the empty main editor without
    // submitting anything.
    const promptsBefore = harness.acceptedPrompts.length;
    overlay.handleInput(TYPED);
    trace.typedClosed = harness.customs[0].resolved;
    trace.typedPastes = [...harness.pastes];
    trace.typedEditor = harness.editor.text;
    trace.typedNoSubmit = harness.acceptedPrompts.length === promptsBefore;

    // A paste with newlines behaves the same: full replay, still no submit.
    harness.editor.text = "";
    const second = harness.openChildAt(0);
    assert.ok(second, "the overlay reopens for the paste replay");
    second.handleInput(`\x1b[200~${PASTED}\x1b[201~`);
    trace.pastedClosed = harness.customs.at(-1).resolved;
    trace.pastedPastes = [...harness.pastes];
    trace.pastedEditor = harness.editor.text;
    trace.pastedNoSubmit = harness.acceptedPrompts.length === promptsBefore;
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
  for (const trace of [regular, fullscreen]) {
    assert.equal(trace.typedClosed, true, "typed input closed the overlay");
    assert.deepEqual(trace.typedPastes, [TYPED], "the complete typed text replayed once");
    assert.equal(trace.typedEditor, TYPED, "the main editor holds the replayed text");
    assert.equal(trace.typedNoSubmit, true, "the replayed text was never submitted");
    assert.equal(trace.pastedClosed, true, "paste closed the overlay");
    assert.deepEqual(trace.pastedPastes, [TYPED, PASTED], "the complete multiline paste replayed");
    assert.equal(trace.pastedEditor, PASTED, "the paste kept its newlines");
    assert.equal(trace.pastedNoSubmit, true, "the pasted text was never submitted");
  }
  assert.deepEqual(regular.rows, fullscreen.rows, "roster rows are identical");
  assert.deepEqual(regular.selection, fullscreen.selection, "selection is identical");
  assert.equal(regular.openTitle, fullscreen.openTitle, "the open overlay title is identical");
  assert.equal(regular.scrolled, fullscreen.scrolled, "transcript scrolling behaves the same");
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

    await harness.chain.emit("session_shutdown", {});

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

test("teardown cancels a pending coalesced repaint and never repaints afterwards", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-square-roster-lifecycle-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = root;
  try {
    writeChildArtifacts(root, id(1));
    // Timer seam that keeps cancelled entries for inspection: firing the
    // store after teardown proves a cancelled callback never repaints.
    const timers = { entries: new Map(), seq: 0 };
    const paintTimers = {
      setTimeout(callback, ms) {
        timers.seq += 1;
        timers.entries.set(timers.seq, { callback, cancelled: false, ms });
        return timers.seq;
      },
      clearTimeout(handle) {
        const entry = timers.entries.get(handle);
        if (entry) entry.cancelled = true;
      },
    };
    const renders = { count: 0 };
    const tui = {
      terminal: { columns: 80, rows: 30 },
      requestRender() { renders.count += 1; },
    };
    const steps = [];
    const state = createBackgroundState();
    state.viewFeed = createChildViewFeed({ schedule: (callback) => steps.push(callback) });
    const widgets = [];
    const customs = [];
    let inputHandler;
    let inputUnsubscribed = false;
    let motionSubscribers = 0;
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      ui: {
        theme: plainTheme(),
        setWidget(key, content, options) { widgets.push({ key, content, options }); },
        getEditorText: () => "",
        onTerminalInput(handler) {
          inputHandler = handler;
          return () => { inputUnsubscribed = true; };
        },
        custom(factory, options) {
          const entry = { resolved: false };
          customs.push({ entry, component: factory(tui, plainTheme(), { matches: () => false, getKeys: () => [] }, () => { entry.resolved = true; }) });
          return new Promise(() => {});
        },
      },
      sessionManager: { getSessionId: () => SESSION_ID, getSessionDir: () => root },
    };
    const controller = createSubagentRosterController(state, {
      now: () => 500_000,
      motion: () => ({
        subscribe: (listener) => {
          motionSubscribers += 1;
          void listener;
          return () => { motionSubscribers -= 1; };
        },
      }),
      timers: paintTimers,
    });
    controller.start(ctx);
    state.jobs.set(id(1), jobFixture(id(1), "running", 1, "explorer"));
    for (const listener of state.listeners) listener();
    assert.equal(typeof widgets.at(-1).content, "function", "the running child published a widget");

    // Open the overlay through the real keyboard seam.
    inputHandler(DOWN);
    inputHandler(ENTER);
    assert.ok(customs[0]?.component, "the overlay opened");

    // Two ordinary streaming deltas through the live feed: the first paints
    // immediately and stamps the coalesce window; the second must leave
    // exactly one pending repaint timer.
    const publish = (text) => {
      state.viewFeed.publish(id(1), { kind: "message_delta", parts: [{ type: "text", text }] });
      while (steps.length > 0) steps.shift()?.();
    };
    const paintedAtOpen = renders.count;
    publish("first delta");
    assert.equal(renders.count, paintedAtOpen + 1, "the first delta painted immediately");
    publish("second delta");
    const pending = [...timers.entries.values()].filter((entry) => !entry.cancelled);
    assert.equal(pending.length, 1, "one coalesced repaint timer is pending");
    assert.equal(renders.count, paintedAtOpen + 1, "the second delta did not paint inside the window");

    controller.advanceMainTaskEpoch();
    controller.stop();

    const pendingAfter = [...timers.entries.values()].filter((entry) => !entry.cancelled);
    assert.equal(pendingAfter.length, 0, "teardown cancelled the pending repaint");
    assert.equal(customs[0].entry.resolved, true, "teardown closed the overlay");
    assert.equal(state.listeners.size, 0, "background subscription released");
    assert.equal(inputUnsubscribed, true, "terminal-input listener released");
    assert.equal(motionSubscribers, 0, "motion subscription released");
    assert.equal(widgets.at(-1).content, undefined, "widget cleared");

    // Let every timer fire as though it had expired: only non-cancelled
    // entries may run, and none remain, so nothing repaints after teardown.
    for (const entry of timers.entries.values()) {
      if (!entry.cancelled) entry.callback();
    }
    assert.equal(renders.count, paintedAtOpen + 1, "no repaint ran after teardown");

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
    await harness.chain.emit("agent_settled");
    assert.equal(harness.sent.length, 1, "automatic delivery fired once");
    assert.equal(harness.sent[0].message.customType, NOTIFICATION_TYPE);
    assert.equal(harness.sent[0].message.details.results[0].id, id(1));
    assert.equal(harness.state.background.delivery.pendingCount(), 1, "unconfirmed until the transcript observes it");

    // Confirmation comes only from the transcript observation: Pi injects the
    // sent custom message into the parent transcript as message_start.
    harness.chain.emitMessageStart({
      role: "custom",
      customType: harness.sent[0].message.customType,
      details: harness.sent[0].message.details,
    });
    assert.equal(harness.state.background.delivery.pendingCount(), 0, "transcript confirmation consumed the result");

    // The delivered row stays visible through the current task, and expires
    // with the next real prompt like every ordinary terminal row.
    assert.ok(harness.widgetLines().some((line) => line.includes("✓ completed")));
    await harness.mainInput("interactive");
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
    await harness.chain.emit("agent_settled");
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
    await harness.chain.emit("agent_settled");
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

    await harness.chain.emit("agent_settled");
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
