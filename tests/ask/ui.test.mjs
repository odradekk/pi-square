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
};

function createUiRecorder() {
  let inputHandler;
  let widgetFactory;
  // Real pi-tui invokes a setWidget() factory once to build the component,
  // then calls .render() on that SAME instance repeatedly — it does not
  // reconstruct a fresh component on every draw. Cache it here too, or
  // stateful widgets (like AskPanel) would silently reset every render().
  let widgetComponent;
  let clearCount = 0;
  let panel;
  return {
    ui: {
      onTerminalInput(handler) {
        inputHandler = handler;
        return () => { inputHandler = undefined; };
      },
      setWidget(_key, content) {
        if (content === undefined) {
          clearCount += 1;
          widgetFactory = undefined;
          widgetComponent = undefined;
        } else {
          widgetFactory = content;
          widgetComponent = content({ requestRender() {} }, theme);
        }
      },
      // Minimal stand-in for ExtensionUIContext.custom(): synchronously
      // invokes the factory (mirroring interactive mode's immediate mount)
      // and resolves the returned promise via the factory's `done` callback.
      custom(factory) {
        return new Promise((resolve) => {
          const tui = { requestRender() {} };
          const kb = {};
          const built = factory(tui, theme, kb, resolve);
          panel = built instanceof Promise ? undefined : built;
          if (built instanceof Promise) built.then((p) => { panel = p; });
        });
      },
    },
    input(data) {
      if (inputHandler) { inputHandler(data); return; }
      assert.ok(panel, "no panel installed (neither setWidget nor custom() was called)");
      panel.handleInput(data);
    },
    render(width) {
      if (widgetComponent) return widgetComponent.render(width);
      assert.ok(panel, "no panel installed (neither setWidget nor custom() was called)");
      return panel.render(width);
    },
    hasWidget() { return typeof widgetFactory === "function"; },
    clearCount() { return clearCount; },
  };
}

{
  const { promptQuestions } = load(join(packageRoot, "src", "ask-user", "prompt.ts"));

  // ── single-select: navigate, select, verify narrow-terminal truncation ──
  {
    const recorder = createUiRecorder();
    const pending = promptQuestions(recorder.ui, [{
      id: "choice",
      text: "Choose a deliberately long option to verify narrow rendering",
      type: "single",
      options: [
        { value: "first", label: "The first option has enough text to be truncated in a narrow panel" },
        { value: "second", label: "Second option" },
      ],
      allowComment: false,
    }]);

    const lines = recorder.render(32);
    assert.ok(lines.some((line) => line.includes("Choose a deliberately")), "question title should be rendered");
    assert.ok(lines.some((line) => line.includes("first option")), "long label should still be visible near its (truncated) start");
    assert.ok(lines.some((line) => line.includes("navigate")), "native hint line should be present (may be truncated in a narrow panel)");
    assert.ok(lines.every((line) => visibleWidth(line) <= 32), "ask panel must fit the terminal width");

    recorder.input("\r");
    const answers = await pending;
    assert.deepEqual(answers, [{ questionId: "choice", selected: ["first"], comment: undefined, skipped: false }]);
  }

  // ── multi-select: toggle two options, then confirm ──
  {
    const recorder = createUiRecorder();
    const pending = promptQuestions(recorder.ui, [{
      id: "toppings",
      text: "Pick toppings",
      type: "multi",
      options: [
        { value: "a", label: "Cheese" },
        { value: "b", label: "Olives" },
      ],
      allowComment: false,
    }]);

    recorder.input("\r"); // toggle "Cheese" (row 0)
    recorder.input("\x1b[B"); // down to "Olives"
    recorder.input("\r"); // toggle "Olives"
    recorder.input("\x1b[B"); // down to "Confirm"
    const beforeConfirm = recorder.render(24); // deliberately narrow — regression guard for unclamped header/hint lines
    assert.ok(beforeConfirm.some((line) => line.includes("Confirm (2)")), "confirm row should reflect two checked options");
    assert.ok(beforeConfirm.every((line) => visibleWidth(line) <= 24), "ask panel must fit a narrow terminal (header/divider/hint lines must be clamped)");
    recorder.input("\r"); // confirm

    const answers = await pending;
    assert.deepEqual(answers, [{ questionId: "toppings", selected: ["a", "b"], comment: undefined, skipped: false }]);
  }

  // ── free-text comment: write a custom answer instead of picking an option ──
  {
    const recorder = createUiRecorder();
    const pending = promptQuestions(recorder.ui, [{
      id: "feedback",
      text: "Anything else?",
      type: "single",
      options: [{ value: "none", label: "Nothing" }],
      allowComment: true,
    }]);

    recorder.input("\x1b[B"); // down to "Write your own answer…"
    recorder.input("\r"); // enter comment mode
    const inCommentMode = recorder.render(24); // deliberately narrow — same regression guard, in comment mode
    assert.ok(inCommentMode.every((line) => visibleWidth(line) <= 24), "comment-mode panel must fit a narrow terminal");
    for (const ch of "custom text") recorder.input(ch);
    recorder.input("\r"); // save draft, back to list (now shows the quoted comment + Edit)
    recorder.input("\r"); // submit the comment row

    const answers = await pending;
    assert.deepEqual(answers, [{ questionId: "feedback", selected: [], comment: "custom text", skipped: false }]);
  }

  // ── cancel: escape skips the question ──
  {
    const recorder = createUiRecorder();
    const pending = promptQuestions(recorder.ui, [{
      id: "skippable",
      text: "Skip me",
      type: "single",
      options: [{ value: "x", label: "X" }],
      allowComment: false,
    }]);

    recorder.input("\x1b");
    const answers = await pending;
    assert.deepEqual(answers, [{ questionId: "skippable", selected: [], skipped: true }]);
  }
}

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
    const ctx = {
      hasUI: true,
      ui: recorder.ui,
      sessionManager: { getBranch: () => entries },
    };
    await events.get("session_start")({}, ctx);

    const tool = tools.get("todo");
    assert.ok(tool);
    const created = await tool.execute("todo-1", {
      action: "create",
      title: "UI regression",
      todos: [{ id: "verify", text: "A long todo item that must remain inside a narrow terminal", completed: false }],
    }, undefined, undefined, ctx);
    assert.equal(created.details.widget, "shown");
    const lines = recorder.render(30);
    assert.ok(lines.some((line) => line.includes("UI regression")));
    assert.ok(lines.every((line) => visibleWidth(line) <= 30), "todo widget must fit the terminal width");

    const checked = await tool.execute("todo-2", { action: "check", id: "verify" }, undefined, undefined, ctx);
    assert.equal(checked.details.widget, "cleared");
    assert.equal(recorder.hasWidget(), false);
    assert.ok(recorder.clearCount() >= 1);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

console.log("session UI tests: ask selection and todo widget passed");
