import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.NODE_PATH = [join(packageRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const require = createRequire(import.meta.url);
const { default: jiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const load = jiti(import.meta.url, { moduleCache: false });
const { createTodoRuntime } = load(join(packageRoot, "src", "todo", "index.ts"));
const definition = createTodoRuntime({ appendEntry() {} }).tool;

const plainTheme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
  bg(_color, text) { return String(text); },
};

function context(overrides = {}) {
  return {
    state: {},
    lastComponent: undefined,
    expanded: false,
    executionStarted: false,
    isError: false,
    invalidate() {},
    ...overrides,
  };
}

function plain(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

const details = {
  version: 1,
  status: "ok",
  action: "check",
  changed: true,
  stateVersion: 2,
  title: "Release",
  counts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
  currentId: "build",
  widget: "shown",
  items: [
    { id: "inspect", text: "Inspect current behavior", status: "completed" },
    { id: "build", text: "Build implementation", status: "in_progress" },
    { id: "verify", text: "Verify all gates", status: "pending" },
  ],
};

function result(value = details, text = "{}") {
  return { content: [{ type: "text", text }], details: value };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("todo keeps the default Pi shell and defines native renderers", () => {
  assert.equal(definition.renderShell, undefined);
  assert.equal(typeof definition.renderCall, "function");
  assert.equal(typeof definition.renderResult, "function");
});

test("collapsed calls show semantic action metadata without task previews", () => {
  const args = {
    action: "set",
    title: "Secret release title",
    todos: [{ id: "inspect", text: "Sensitive task text", status: "in_progress" }],
  };
  const collapsed = plain(definition.renderCall(args, plainTheme, context())).trimEnd();
  assert.match(collapsed, /^TODO  set · 1 item$/);
  assert.doesNotMatch(collapsed, /Secret|Sensitive|inspect/);

  const expanded = plain(definition.renderCall(args, plainTheme, context({ expanded: true })));
  assert.match(expanded, /Title  Secret release title/);
  assert.match(expanded, /Sensitive task text/);
  assert.match(expanded, /in_progress · inspect/);
});

test("call rendering sanitizes damaged arguments", () => {
  const output = plain(definition.renderCall({
    action: "set",
    title: "safe\x1b]0;owned\x07 title",
    todos: [{ id: "safe", text: "task\u0000text\x1b]8;;https://evil.example\x07link\x1b]8;;\x07" }],
  }, plainTheme, context({ expanded: true })));
  assert.match(output, /safe title/);
  assert.match(output, /tasktextlink/);
  assert.doesNotMatch(output, /owned|evil\.example|\x1b|\x07|\u0000/);
});

test("collapsed results show progress only and expanded results show the complete list", () => {
  const collapsed = plain(definition.renderResult(result(), { expanded: false, isPartial: false }, plainTheme, context()));
  assert.match(collapsed, /1\/3 complete · current 02 · 1 pending · changed/);
  assert.match(collapsed, /expand/);
  assert.doesNotMatch(collapsed, /Inspect current|Build implementation|Release/);

  const expanded = plain(definition.renderResult(result(), { expanded: true, isPartial: false }, plainTheme, context()));
  assert.match(expanded, /Release/);
  assert.match(expanded, /Inspect current behavior  \(inspect · completed\)/);
  assert.match(expanded, /Build implementation  \(build · in_progress\)/);
  assert.match(expanded, /Verify all gates  \(verify · pending\)/);
  assert.match(expanded, /collapse/);
});

test("empty, paused, unchanged, and error summaries are explicit", () => {
  const empty = { ...details, action: "clear", counts: { total: 0, pending: 0, inProgress: 0, completed: 0 }, currentId: undefined, items: [] };
  assert.match(plain(definition.renderResult(result(empty), { expanded: false, isPartial: false }, plainTheme, context())), /Todo list cleared/);

  const paused = { ...details, changed: false, counts: { total: 2, pending: 2, inProgress: 0, completed: 0 }, currentId: undefined, items: details.items.slice(1).map((item) => ({ ...item, status: "pending" })) };
  assert.match(plain(definition.renderResult(result(paused), { expanded: false, isPartial: false }, plainTheme, context())), /paused · 2 pending · unchanged/);

  const failed = {
    ...details,
    status: "error",
    changed: false,
    error: { code: "TODO_UNKNOWN_ID", message: "unknown todo id: missing" },
  };
  assert.match(plain(definition.renderResult(result(failed), { expanded: false, isPartial: false }, plainTheme, context({ isError: true }))), /TODO_UNKNOWN_ID: unknown todo id/);
});

test("malformed details keep collapsed content private and expanded fallback complete", () => {
  const fallback = `${"private legacy content ".repeat(40)}unique-tail`;
  const malformed = { content: [{ type: "text", text: fallback }], details: { version: 1, status: "ok", items: [null] } };
  const collapsed = plain(definition.renderResult(malformed, { expanded: false, isPartial: false }, plainTheme, context()), 40);
  assert.match(collapsed, /Todo result/);
  assert.match(collapsed, /expand/);
  assert.doesNotMatch(collapsed, /private legacy|unique-tail/);

  const expanded = plain(definition.renderResult(malformed, { expanded: true, isPartial: false }, plainTheme, context()), 40);
  assert.match(expanded, /unique-tail/);
});

test("todo call and result render within every display boundary width", () => {
  const longDetails = structuredClone(details);
  longDetails.title = "title ".repeat(30);
  longDetails.items = Array.from({ length: 20 }, (_, index) => ({
    id: `item-${index + 1}`,
    text: `long task ${index + 1} ${"content ".repeat(60)}`,
    status: index < 8 ? "completed" : index === 8 ? "in_progress" : "pending",
  }));
  longDetails.counts = { total: 20, pending: 11, inProgress: 1, completed: 8 };
  longDetails.currentId = "item-9";
  const args = { action: "set", title: longDetails.title, todos: longDetails.items };

  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const components = [
      definition.renderCall(args, plainTheme, context({ expanded: true })),
      definition.renderResult(result(longDetails), { expanded: false, isPartial: false }, plainTheme, context()),
      definition.renderResult(result(longDetails), { expanded: true, isPartial: false }, plainTheme, context()),
    ];
    for (const component of components) {
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failures} failed`);
if (failures > 0) process.exit(1);
