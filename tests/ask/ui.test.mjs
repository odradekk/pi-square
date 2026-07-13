import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { visibleWidth } from "./ui-stub.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sharedNodeModules = resolve(packageRoot, "node_modules");
process.env.NODE_PATH = [sharedNodeModules, process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const require = createRequire(import.meta.url);
const { default: jiti } = await import(pathToFileURL(require.resolve("jiti")).href);

const load = jiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-tui": join(packageRoot, "tests", "ask", "ui-stub.mjs"),
    "@earendil-works/pi-coding-agent": join(packageRoot, "tests", "ask", "ui-stub.mjs"),
  },
});

const theme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
  bg(_color, text) { return String(text); },
};

function keyMatches(data, binding) {
  const keys = {
    "tui.select.up": ["\x1b[A", "\x1bOA"],
    "tui.select.down": ["\x1b[B", "\x1bOB"],
    "tui.select.pageUp": ["\x1b[5~"],
    "tui.select.pageDown": ["\x1b[6~"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\x1b", "\x03"],
  };
  return keys[binding]?.includes(data) ?? false;
}

function createUiRecorder(options = {}) {
  let widgetFactory;
  let widgetComponent;
  let panel;
  let clearCount = 0;
  let customCount = 0;
  const activeTheme = options.theme ?? theme;
  const tui = { terminal: { rows: options.rows ?? 30 }, requestRender() {} };
  const keybindings = { matches: keyMatches };

  return {
    ui: {
      setWidget(_key, content) {
        if (content === undefined) {
          clearCount += 1;
          widgetFactory = undefined;
          widgetComponent = undefined;
        } else {
          widgetFactory = content;
          widgetComponent = content(tui, activeTheme);
        }
      },
      custom(factory) {
        customCount += 1;
        return new Promise((resolve) => {
          const done = (result) => {
            panel = undefined;
            resolve(result);
          };
          const built = factory(tui, activeTheme, keybindings, done);
          if (built instanceof Promise) built.then((component) => { panel = component; });
          else panel = built;
        });
      },
    },
    input(data) {
      assert.ok(panel, "no focused custom panel is active");
      panel.handleInput(data);
    },
    render(width) {
      if (panel) return panel.render(width);
      if (widgetComponent) return widgetComponent.render(width);
      throw new Error("no component is active");
    },
    text(width = 80) { return this.render(width).join("\n"); },
    hasWidget() { return typeof widgetFactory === "function"; },
    clearCount() { return clearCount; },
    customCount() { return customCount; },
  };
}

function pressDown(recorder, count = 1) {
  for (let index = 0; index < count; index += 1) recorder.input("\x1b[B");
}

const { promptQuestions } = load(join(packageRoot, "src", "ask-user", "prompt.ts"));
const { normalizeQuestions } = load(join(packageRoot, "src", "ask-user", "validation.ts"));

function questions(input) {
  return normalizeQuestions(input);
}

// Required questions reject an empty advance and single-select waits for explicit submit.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "choice",
    text: "Choose a deliberately long option to verify narrow rendering",
    type: "single",
    options: [{ value: "first", label: "The first option has enough text to be truncated in a narrow panel" }],
  }]));

  assert.equal(recorder.customCount(), 1);
  assert.equal(recorder.hasWidget(), false, "ask should use focused custom UI, not a widget");
  assert.match(recorder.text(32), /REQUIRED/);
  assert.ok(recorder.render(32).every((line) => visibleWidth(line) <= 32));

  pressDown(recorder);
  recorder.input("\r");
  assert.match(recorder.text(40), /Select at least one option/);
  recorder.input("\x1b[A");
  recorder.input("\r");
  assert.match(recorder.text(40), /●/);
  pressDown(recorder);
  recorder.input("\r");

  assert.deepEqual(await pending, {
    status: "submitted",
    drafts: [{ selected: ["first"], skipped: false, completed: true }],
  });
}

// Multi-select supports Space, multiline comments, placeholders, and exact comment preservation.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "toppings",
    text: "Pick toppings",
    type: "multi",
    options: [
      { value: "a", label: "Cheese" },
      { value: "b", label: "Olives" },
    ],
    allowComment: true,
    commentPlaceholder: "Explain the combination",
  }]));

  recorder.input(" ");
  pressDown(recorder);
  recorder.input(" ");
  pressDown(recorder);
  recorder.input("\r");
  assert.match(recorder.text(40), /Explain the combination/);
  for (const character of "line one") recorder.input(character);
  recorder.input("\x1b[13;2u");
  for (const character of "line two") recorder.input(character);
  recorder.input("\r");
  assert.match(recorder.text(40), /Edit comment/);
  pressDown(recorder);
  recorder.input("\r");

  assert.deepEqual(await pending, {
    status: "submitted",
    drafts: [{ selected: ["a", "b"], comment: "line one\nline two", skipped: false, completed: true }],
  });
}

// Oversized pasted comments are rejected without silent truncation.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "comment-limit",
    text: "Bound the comment",
    type: "single",
    options: [{ value: "x", label: "X" }],
    allowComment: true,
  }]));
  pressDown(recorder);
  recorder.input("\r");
  recorder.input(`\x1b[200~${"x".repeat(4001)}\x1b[201~`);
  assert.match(recorder.text(60), /at most 4000 characters/);
  for (const character of "accepted") recorder.input(character);
  recorder.input("\r");
  pressDown(recorder);
  recorder.input("\r");
  assert.deepEqual(await pending, {
    status: "submitted",
    drafts: [{ selected: [], comment: "accepted", skipped: false, completed: true }],
  });
}

// Back navigation and review editing preserve every question draft.
{
  const recorder = createUiRecorder();
  const progress = [];
  const pending = promptQuestions(recorder.ui, questions([
    {
      id: "first",
      text: "First question",
      type: "single",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
    },
    {
      id: "second",
      text: "Second question",
      type: "single",
      options: [{ value: "c", label: "C" }],
    },
  ]), undefined, (update) => progress.push(update));

  pressDown(recorder);
  recorder.input("\r");
  pressDown(recorder);
  recorder.input("\r");
  recorder.input("\r");
  pressDown(recorder, 2);
  recorder.input("\r");
  assert.match(recorder.text(60), /REVIEW\s+2 answered/);

  recorder.input("\x1b[A");
  recorder.input("\x1b[A");
  recorder.input("\x1b[A");
  assert.match(recorder.text(40), /B/);
  recorder.input("\r");
  assert.match(recorder.text(40), /●\s+B/);
  pressDown(recorder, 2);
  recorder.input("\r");
  pressDown(recorder, 3);
  recorder.input("\r");

  assert.deepEqual(await pending, {
    status: "submitted",
    drafts: [
      { selected: ["b"], skipped: false, completed: true },
      { selected: ["c"], skipped: false, completed: true },
    ],
  });
  assert.ok(progress.some((update) => update.phase === "reviewing"));
  assert.ok(progress.every((update) => !("answers" in update)), "progress must not expose draft answer content");
}

// Leaving a review edit through Previous must revisit the incomplete edit target before review.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([
    { id: "first-edit", text: "First edit question", type: "single", options: [{ value: "a", label: "A" }] },
    { id: "second-edit", text: "Second edit question", type: "single", options: [{ value: "b", label: "B" }] },
  ]));
  recorder.input("\r");
  pressDown(recorder);
  recorder.input("\r");
  recorder.input("\r");
  pressDown(recorder, 2);
  recorder.input("\r");
  recorder.input("\x1b[A");
  recorder.input("\x1b[A");
  recorder.input("\r");
  recorder.input("\r");
  pressDown(recorder);
  recorder.input("\r");
  assert.match(recorder.text(50), /First edit question/);
  pressDown(recorder);
  recorder.input("\r");
  assert.match(recorder.text(50), /Second edit question/);
  recorder.input("\r");
  pressDown(recorder, 2);
  recorder.input("\r");
  pressDown(recorder, 2);
  recorder.input("\r");
  assert.equal((await pending).status, "submitted");
}

// Optional questions use an explicit Skip action.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "optional",
    text: "Optional question",
    type: "single",
    options: [{ value: "x", label: "X" }],
    required: false,
  }]));
  pressDown(recorder);
  recorder.input("\r");
  assert.deepEqual(await pending, {
    status: "submitted",
    drafts: [{ selected: [], comment: undefined, skipped: true, completed: true }],
  });
}

// Dirty cancellation requires confirmation; Escape in confirmation keeps answering.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "cancel",
    text: "Cancel after selecting",
    type: "single",
    options: [{ value: "x", label: "X" }],
  }]));
  recorder.input("\r");
  recorder.input("\x1b");
  assert.match(recorder.text(50), /unsubmitted selections and comments/);
  recorder.input("\x1b");
  assert.match(recorder.text(50), /Cancel after selecting/);
  recorder.input("\x1b");
  pressDown(recorder);
  recorder.input("\r");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}

// Clean cancellation is immediate, while AbortSignal is classified separately.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "clean-cancel",
    text: "Cancel immediately",
    type: "single",
    options: [{ value: "x", label: "X" }],
  }]));
  recorder.input("\x1b");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}
{
  const recorder = createUiRecorder();
  const controller = new AbortController();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "abort",
    text: "Abort me",
    type: "single",
    options: [{ value: "x", label: "X" }],
  }]), controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled", reason: "aborted" });
}

// Long descriptions are paged and width-safe.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([{
    id: "description",
    text: "Inspect context",
    type: "single",
    options: [{
      value: "x",
      label: "X",
      description: `${"detail ".repeat(80)}safe tail`,
    }],
  }]));
  const firstPage = recorder.text(40);
  assert.match(firstPage, /DETAILS\s+1–/);
  assert.ok(recorder.render(40).every((line) => visibleWidth(line) <= 40));
  recorder.input("\x1b[6~");
  assert.match(recorder.text(40), /DETAILS\s+3–/);
  recorder.input("\x1b");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}

// The modern form layout uses responsive command bars, a compact step rail, and stable detail space.
{
  const recorder = createUiRecorder();
  const pending = promptQuestions(recorder.ui, questions([
    {
      id: "visual-first",
      text: "First visual question",
      type: "single",
      options: [{ value: "a", label: "Alpha" }],
    },
    {
      id: "visual-second",
      text: "Second visual question",
      type: "single",
      options: [
        { value: "b", label: "Beta", description: "Second description with enough context to scan" },
        { value: "c", label: "Gamma" },
      ],
      allowComment: true,
      required: false,
    },
  ]));
  recorder.input("\r");
  pressDown(recorder);
  recorder.input("\r");

  const wide = recorder.text(80);
  assert.match(wide, /ASK\s+02 \/ 02\s+●━●/);
  assert.match(wide, /Second description with enough context to scan/);
  assert.match(wide, /ADDITIONAL CONTEXT/);
  assert.match(wide, /‹ Back.*Skip.*Review answers →/s);
  const narrow = recorder.text(40);
  assert.match(narrow, /‹ Back/);
  assert.match(narrow, /Skip/);
  assert.match(narrow, /Review answers →/);
  assert.doesNotMatch(narrow, /‹ Back.*Skip.*Review answers →/);
  for (const width of [40, 80, 120]) {
    assert.ok(recorder.render(width).every((line) => visibleWidth(line) <= width));
  }
  assert.ok(
    recorder.render(120).every((line) => visibleWidth(line.trimEnd()) <= 60),
    "wide-terminal form content must stay within the left-aligned 50% column",
  );

  const beforeMove = recorder.render(80).length;
  pressDown(recorder);
  assert.equal(recorder.render(80).length, beforeMove, "moving between described and undescribed options must not jump the panel");
  pressDown(recorder, 2);
  assert.match(recorder.text(40), /›\s+‹ Back/);
  recorder.input("\x1b");
  pressDown(recorder);
  recorder.input("\r");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}

// Theme semantics distinguish focus, selection, and destructive actions without fixed colors.
{
  const foregroundCalls = [];
  const backgroundCalls = [];
  const tokenTheme = {
    fg(color, text) { foregroundCalls.push({ color, text: String(text) }); return String(text); },
    bg(color, text) { backgroundCalls.push({ color, text: String(text) }); return String(text); },
    bold(text) { return String(text); },
  };
  const recorder = createUiRecorder({ theme: tokenTheme });
  const pending = promptQuestions(recorder.ui, questions([{
    id: "tokens",
    text: "Inspect semantic tokens",
    type: "single",
    options: [{ value: "x", label: "X" }],
  }]));
  recorder.render(120);
  assert.ok(backgroundCalls.some((call) => call.color === "selectedBg"));
  recorder.input("\r");
  recorder.render(120);
  assert.ok(foregroundCalls.some((call) => call.color === "accent" && call.text === "●"));
  recorder.input("\x1b");
  pressDown(recorder);
  recorder.render(120);
  assert.ok(foregroundCalls.some((call) => call.color === "warning" && call.text === "Discard and cancel"));
  assert.ok(backgroundCalls.some((call) => call.color === "selectedBg"));
  recorder.input("\r");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}

// Long question text uses its own bounded viewport and independent paging keys.
{
  const recorder = createUiRecorder({ rows: 24 });
  const pending = promptQuestions(recorder.ui, questions([{
    id: "long-question",
    text: "question segment ".repeat(100),
    type: "single",
    options: [{ value: "x", label: "X" }],
  }]));
  const first = recorder.text(40);
  assert.match(first, /QUESTION\s+1–3 \/ \d+/);
  assert.match(first, /Shift\+PageUp\/PageDown/);
  assert.ok(recorder.render(40).length <= 20, "long questions must not consume the full terminal height");
  recorder.input("\x1b[6;2~");
  assert.match(recorder.text(40), /QUESTION\s+4–6 \/ \d+/);
  recorder.input("\x1b");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}

// Twenty-option questions keep a bounded viewport with visible continuation counts.
{
  const recorder = createUiRecorder({ rows: 24 });
  const pending = promptQuestions(recorder.ui, questions([{
    id: "viewport",
    text: "Scan many choices",
    type: "single",
    options: Array.from({ length: 20 }, (_, index) => ({
      value: `value-${index}`,
      label: `Option ${String(index + 1).padStart(2, "0")}`,
      description: `Description ${index + 1}`,
    })),
  }]));
  assert.match(recorder.text(80), /↓ \d+ more/);
  pressDown(recorder, 10);
  const moved = recorder.text(80);
  assert.match(moved, /↑ \d+ more/);
  assert.match(moved, /Option 11/);
  recorder.input("\x1b");
  assert.deepEqual(await pending, { status: "cancelled", reason: "user" });
}

// Todo's display-only widget contract remains intact beside the focused ask UI.
{
  const agentDir = mkdtempSync(join(tmpdir(), "pi-square-session-ui-test-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;

  try {
    mkdirSync(join(agentDir, "packages"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{}\n");
    const registerTodo = load(join(packageRoot, "src", "todo", "index.ts")).default;
    const tools = new Map();
    const events = new Map();
    const entries = [];
    registerTodo({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { events.set(name, handler); },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    });

    const recorder = createUiRecorder();
    const ctx = { hasUI: true, ui: recorder.ui, sessionManager: { getBranch: () => entries } };
    await events.get("session_start")({}, ctx);
    const tool = tools.get("todo");
    const created = await tool.execute("todo-1", {
      action: "create",
      title: "UI regression",
      todos: [{ id: "verify", text: "A long todo item that must remain inside a narrow terminal", completed: false }],
    }, undefined, undefined, ctx);
    assert.equal(created.details.widget, "shown");
    assert.ok(recorder.render(30).every((line) => visibleWidth(line) <= 30));
    await tool.execute("todo-2", { action: "check", id: "verify" }, undefined, undefined, ctx);
    assert.equal(recorder.hasWidget(), false);
    assert.ok(recorder.clearCount() >= 1);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

console.log("session UI tests: ask wizard and todo widget passed");
