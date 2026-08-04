import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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
const { createTodoWidget, syncTodoWidget, todoPanelWidth, todoWidgetRowBudget } = load(join(packageRoot, "src", "todo", "widget.ts"));
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

const plainTheme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
  bg(_color, text) { return String(text); },
};

function state(items, title = "Tasks") {
  return { title, items };
}

function item(index, status = "pending", text = `Task ${index + 1}`) {
  return { id: `task-${index + 1}`, text, status };
}

function render(component, width) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("panel width is full on narrow terminals and left-aligned half width on wide terminals", () => {
  assert.equal(todoPanelWidth(40), 40);
  assert.equal(todoPanelWidth(80), 60);
  assert.equal(todoPanelWidth(120), 60);
  assert.equal(todoPanelWidth(200), 100);
  assert.equal(todoWidgetRowBudget(10), 5);
  assert.equal(todoWidgetRowBudget(24), 7);
  assert.equal(todoWidgetRowBudget(80), 12);
});

test("short lists show semantic three-state rows without exposing internal ids", () => {
  const component = createTodoWidget(
    { terminal: { rows: 30 } },
    plainTheme,
    state([item(0, "completed"), item(1, "in_progress"), item(2)], "Release"),
  );
  const output = render(component, 80).join("\n");
  assert.match(output, /^◆ TODO  Release/);
  assert.match(output, /1\/3 · 33%/);
  assert.match(output, /✓  01  Task 1/);
  assert.match(output, /◆  02  Task 2/);
  assert.match(output, /○  03  Task 3/);
  assert.doesNotMatch(output, /task-1|task-2|task-3/);
});

test("long lists stay within the dynamic viewport and keep the current item visible", () => {
  const items = Array.from({ length: 20 }, (_, index) => item(index, index < 8 ? "completed" : index === 10 ? "in_progress" : "pending"));
  const component = createTodoWidget({ terminal: { rows: 24 } }, plainTheme, state(items));
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = render(component, width);
    assert.ok(lines.length <= 7, `${lines.length} rows exceed budget`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => visibleWidth(line.trimEnd()) <= todoPanelWidth(width)));
    assert.match(lines.join("\n"), /Task 11/);
    assert.match(lines.join("\n"), /earlier/);
    assert.match(lines.join("\n"), /later/);
  }
});

test("the current item may wrap to two lines without moving past the height cap", () => {
  const current = item(4, "in_progress", "Current work ".repeat(30));
  const items = [item(0, "completed"), item(1), item(2), item(3), current, item(5), item(6), item(7)];
  const lines = render(createTodoWidget({ terminal: { rows: 30 } }, plainTheme, state(items)), 80);
  assert.ok(lines.length <= 9);
  assert.equal(lines.filter((line) => line.includes("Current work")).length, 2);
});

test("theme tokens distinguish completed, current, pending, rail, and paused states", () => {
  const foreground = [];
  const theme = {
    fg(color, text) { foreground.push({ color, text: String(text) }); return String(text); },
    bold(text) { return String(text); },
    bg(_color, text) { return String(text); },
  };
  createTodoWidget({ terminal: { rows: 30 } }, theme, state([
    item(0, "completed"), item(1, "in_progress"), item(2, "pending"),
  ])).render(80);
  assert.ok(foreground.some((call) => call.color === "success" && call.text === "✓"));
  assert.ok(foreground.some((call) => call.color === "accent" && call.text === "◆"));
  assert.ok(foreground.some((call) => call.color === "muted" && call.text === "○"));
  assert.ok(foreground.some((call) => call.color === "borderMuted" && call.text.includes("─")));
  assert.ok(!foreground.some((call) => call.color === "selectedBg"));

  foreground.length = 0;
  createTodoWidget({ terminal: { rows: 30 } }, theme, state([item(0), item(1)])).render(80);
  assert.ok(foreground.some((call) => call.color === "muted" && call.text.includes("PAUSED")));
});

test("widget synchronization is read-only, clears completed lists, and handles no-UI mode", () => {
  const calls = [];
  const ui = { setWidget(...args) { calls.push(args); } };
  let status = syncTodoWidget({ hasUI: true, ui }, state([item(0, "in_progress")]));
  assert.equal(status, "shown");
  assert.equal(typeof calls.at(-1)[1], "function");
  assert.deepEqual(calls.at(-1)[2], { placement: "aboveEditor" });

  status = syncTodoWidget({ hasUI: true, ui }, state([item(0, "completed")]));
  assert.equal(status, "cleared");
  assert.equal(calls.at(-1)[1], undefined);
  assert.equal(syncTodoWidget({ hasUI: false }, state([item(0)])), "unavailable");
});

test("real dark and light themes render bounded maximum-pressure widgets", () => {
  const items = Array.from({ length: 20 }, (_, index) => item(
    index,
    index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
    `${index + 1} ${"long task text ".repeat(35)}`,
  ));
  const started = performance.now();
  let renders = 0;
  for (const themeName of ["pi-square-theme-dark", "pi-square-theme-light"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", `${themeName}.json`));
    for (const rows of [18, 24, 40, 80]) {
      const component = createTodoWidget({ terminal: { rows } }, theme, state(items, "Maximum pressure"));
      for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
        const lines = component.render(width);
        assert.ok(lines.length <= todoWidgetRowBudget(rows));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        renders += 1;
      }
    }
  }
  assert.ok(performance.now() - started < 2_000);
  assert.equal(renders, 64);
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
