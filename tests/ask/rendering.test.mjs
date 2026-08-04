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
const { createAskToolDefinition } = load(join(packageRoot, "src", "ask-user", "index.ts"));
const definition = createAskToolDefinition();

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

function result(details, text = "{}") {
  return { content: [{ type: "text", text }], details };
}

const questions = [{
  id: "choice",
  text: "Choose a deployment strategy",
  type: "single",
  options: [
    { value: "rolling", label: "Rolling", description: "Replace instances gradually" },
    { value: "blue-green", label: "Blue-green", description: "Switch traffic between environments" },
  ],
  allowComment: true,
  commentPlaceholder: "Add rollout constraints",
}];

const doneDetails = {
  version: 1,
  phase: "done",
  totalQuestions: 2,
  answeredCount: 1,
  skippedCount: 1,
  answers: [
    {
      questionId: "choice",
      questionText: "Choose a deployment strategy",
      selected: [{ value: "rolling", label: "Rolling" }],
      comment: "Keep capacity above 80%\nUse the canary pool",
      skipped: false,
    },
    {
      questionId: "optional",
      questionText: "Optional follow-up",
      selected: [],
      skipped: true,
    },
  ],
};

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("ask keeps the default Pi shell and defines native renderers", () => {
  assert.equal(definition.renderShell, undefined);
  assert.equal(typeof definition.renderCall, "function");
  assert.equal(typeof definition.renderResult, "function");
});

test("collapsed call is a semantic summary and expanded call shows complete questions", () => {
  const collapsed = plain(definition.renderCall({ questions }, plainTheme, context()));
  assert.match(collapsed.trimEnd(), /^ASK  1 question$/);
  assert.doesNotMatch(collapsed, /deployment|Rolling/);

  const expanded = plain(definition.renderCall({ questions }, plainTheme, context({ expanded: true })));
  assert.match(expanded, /Choose a deployment strategy/);
  assert.match(expanded, /\[single · required\]/);
  assert.match(expanded, /Rolling \(rolling\)/);
  assert.match(expanded, /Replace instances gradually/);
  assert.match(expanded, /Comment enabled · Add rollout constraints/);
});

test("call rendering removes terminal controls from damaged arguments", () => {
  const rendered = plain(definition.renderCall({ questions: [{
    ...questions[0],
    text: "safe\x1b]0;owned\x07 question",
    options: [{ value: "x", label: "safe\u0000label", description: "safe\x1b]8;;https://evil.example\x07link\x1b]8;;\x07tail" }],
  }] }, plainTheme, context({ expanded: true })));
  assert.match(rendered, /safe question/);
  assert.match(rendered, /safelabel/);
  assert.match(rendered, /safelinktail/);
  assert.doesNotMatch(rendered, /owned|evil\.example|\x1b|\x07|\u0000/);
});

test("partial result reports question and review progress without answer previews", () => {
  const asking = plain(definition.renderResult(result({
    version: 1,
    phase: "asking",
    totalQuestions: 3,
    currentQuestion: 2,
    answeredCount: 1,
    skippedCount: 0,
  }), { expanded: false, isPartial: true }, plainTheme, context()));
  assert.match(asking, /Question 2\/3 · 1 answered/);

  const reviewing = plain(definition.renderResult(result({
    version: 1,
    phase: "reviewing",
    totalQuestions: 3,
    answeredCount: 2,
    skippedCount: 1,
  }), { expanded: false, isPartial: true }, plainTheme, context()));
  assert.match(reviewing, /Reviewing 3 questions · 2 answered · 1 skipped/);
  assert.doesNotMatch(`${asking}\n${reviewing}`, /Rolling|canary/);
});

test("collapsed result hides answers while expanded result shows every submitted field", () => {
  const collapsed = plain(definition.renderResult(
    result(doneDetails),
    { expanded: false, isPartial: false },
    plainTheme,
    context(),
  ));
  assert.match(collapsed, /Answered 1\/2 · 1 skipped/);
  assert.match(collapsed, /expand/);
  assert.doesNotMatch(collapsed, /Rolling|capacity|follow-up/);

  const expanded = plain(definition.renderResult(
    result(doneDetails),
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ));
  assert.match(expanded, /Choose a deployment strategy \(choice\)/);
  assert.match(expanded, /Rolling \(rolling\)/);
  assert.match(expanded, /Keep capacity above 80%/);
  assert.match(expanded, /Use the canary pool/);
  assert.match(expanded, /Optional follow-up \(optional\)/);
  assert.match(expanded, /Skipped/);
  assert.match(expanded, /collapse/);
});

test("result rendering sanitizes submitted text and handles cancelled and error states", () => {
  const damaged = structuredClone(doneDetails);
  damaged.answers[0].comment = "safe\x1b]0;owned\x07 comment\u0000tail";
  const expanded = plain(definition.renderResult(result(damaged), { expanded: true, isPartial: false }, plainTheme, context()));
  assert.match(expanded, /safe commenttail/);
  assert.doesNotMatch(expanded, /owned|\x1b|\x07|\u0000/);

  const cancelled = plain(definition.renderResult(result({
    version: 1,
    phase: "cancelled",
    totalQuestions: 2,
    answeredCount: 0,
    skippedCount: 0,
    reason: "user",
  }), { expanded: false, isPartial: false }, plainTheme, context()));
  assert.match(cancelled, /Ask cancelled/);

  const failed = plain(definition.renderResult(result({
    version: 1,
    phase: "error",
    totalQuestions: 1,
    answeredCount: 0,
    skippedCount: 0,
    error: { code: "ASK_UI_FAILED", message: "broken" },
  }), { expanded: false, isPartial: false }, plainTheme, context({ isError: true })));
  assert.match(failed, /ASK_UI_FAILED: broken/);
});

test("malformed details keep collapsed content private and expanded fallback complete", () => {
  const tail = "unique-legacy-tail";
  const content = `${"legacy answer ".repeat(100)}${tail}`;
  const malformed = { content: [{ type: "text", text: content }], details: { version: 1, phase: "done", answers: [null] } };
  const collapsed = plain(definition.renderResult(
    malformed,
    { expanded: false, isPartial: false },
    plainTheme,
    context(),
  ), 40);
  assert.match(collapsed, /Ask result/);
  assert.match(collapsed, /expand/);
  assert.doesNotMatch(collapsed, /legacy answer|unique-legacy-tail/);

  const expanded = plain(definition.renderResult(
    malformed,
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ), 40);
  assert.match(expanded, new RegExp(tail));
});

test("ask call and result stay within every display boundary width", () => {
  const longQuestions = [{
    ...questions[0],
    text: `Question ${"long text ".repeat(40)}`,
    options: [{ value: "long", label: "label ".repeat(60), description: "description ".repeat(80) }],
  }];
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const components = [
      definition.renderCall({ questions: longQuestions }, plainTheme, context({ expanded: true })),
      definition.renderResult(result(doneDetails), { expanded: false, isPartial: false }, plainTheme, context()),
      definition.renderResult(result(doneDetails), { expanded: true, isPartial: false }, plainTheme, context()),
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
