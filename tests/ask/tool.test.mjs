import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.NODE_PATH = [join(packageRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const require = createRequire(import.meta.url);
const { default: jiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const load = jiti(import.meta.url, { moduleCache: false });
const { createAskToolDefinition } = load(join(packageRoot, "src", "ask-user", "index.ts"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function validQuestions(overrides = {}) {
  return [{
    id: "choice",
    text: "Choose",
    type: "single",
    options: [{ value: "a", label: "Alpha", description: "First choice" }],
    ...overrides,
  }];
}

function context(hasUI = true) {
  return { hasUI, ui: {} };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

test("ask schema exposes strict bounded questions and option descriptions", () => {
  const definition = createAskToolDefinition();
  const schema = definition.parameters;
  const question = schema.properties.questions.items;
  const option = question.properties.options.items;

  assert.equal(definition.name, "ask");
  assert.equal(definition.renderShell, undefined);
  assert.equal(typeof definition.renderCall, "function");
  assert.equal(typeof definition.renderResult, "function");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.questions.minItems, 1);
  assert.equal(schema.properties.questions.maxItems, 10);
  assert.equal(question.additionalProperties, false);
  assert.equal(question.properties.options.maxItems, 20);
  assert.equal(question.properties.allowComment.default, false);
  assert.equal(question.properties.required.default, true);
  assert.equal(option.additionalProperties, false);
  assert.equal(option.properties.description.maxLength, 1000);
});

test("ask normalizes defaults, streams count-only progress, and returns JSON v1", async () => {
  let notified = 0;
  let receivedQuestions;
  const updates = [];
  const definition = createAskToolDefinition({ question() { notified += 1; } }, {
    async prompt(_ui, questions, _signal, onProgress) {
      receivedQuestions = questions;
      onProgress({ phase: "reviewing", totalQuestions: 2, answeredCount: 1, skippedCount: 1 });
      return {
        status: "submitted",
        drafts: [
          { selected: ["b", "a"], comment: "exact\ncomment", skipped: false, completed: true },
          { selected: [], skipped: true, completed: true },
        ],
      };
    },
  });

  const result = await definition.execute("ask-1", { questions: [
    {
      id: "choice",
      text: "Choose",
      type: "multi",
      options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
      allowComment: true,
    },
    {
      id: "optional",
      text: "Optional",
      type: "single",
      options: [{ value: "x", label: "X" }],
      required: false,
    },
  ] }, undefined, (update) => updates.push(update), context());

  assert.equal(notified, 1);
  assert.equal(receivedQuestions[0].required, true);
  assert.equal(receivedQuestions[1].allowComment, false);
  assert.ok(updates.length >= 2);
  assert.ok(updates.every((update) => !Object.hasOwn(update.details, "answers")));
  assert.ok(updates.every((update) => !update.content[0].text.includes("exact")));

  const payload = parse(result);
  assert.deepEqual(payload, {
    version: 1,
    status: "submitted",
    answers: [
      {
        questionId: "choice",
        questionText: "Choose",
        selected: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
        comment: "exact\ncomment",
        skipped: false,
      },
      {
        questionId: "optional",
        questionText: "Optional",
        selected: [],
        skipped: true,
      },
    ],
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.phase, "done");
  assert.equal(result.details.answeredCount, 1);
  assert.equal(result.details.skippedCount, 1);
});

test("user cancellation is normal and discards every draft", async () => {
  const definition = createAskToolDefinition(undefined, {
    async prompt() { return { status: "cancelled", reason: "user" }; },
  });
  const result = await definition.execute("ask-2", { questions: validQuestions() }, undefined, undefined, context());
  assert.deepEqual(parse(result), { version: 1, status: "cancelled", reason: "user" });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.answers, undefined);
  assert.equal(result.details.phase, "cancelled");
});

test("pre-abort and running abort are errors without opening or retaining answers", async () => {
  let promptCalls = 0;
  const definition = createAskToolDefinition(undefined, {
    async prompt() { promptCalls += 1; return { status: "cancelled", reason: "aborted" }; },
  });
  const pre = new AbortController();
  pre.abort();
  const preResult = await definition.execute("ask-3", { questions: validQuestions() }, pre.signal, undefined, context());
  assert.equal(promptCalls, 0);
  assert.equal(preResult.isError, true);
  assert.deepEqual(parse(preResult), { version: 1, status: "cancelled", reason: "aborted" });

  const runningResult = await definition.execute("ask-4", { questions: validQuestions() }, undefined, undefined, context());
  assert.equal(promptCalls, 1);
  assert.equal(runningResult.isError, true);
  assert.equal(runningResult.details.answers, undefined);
});

test("ask rejects semantic ambiguity before opening the UI", async () => {
  let promptCalls = 0;
  let notifications = 0;
  const definition = createAskToolDefinition({ question() { notifications += 1; } }, {
    async prompt() { promptCalls += 1; throw new Error("must not run"); },
  });
  const result = await definition.execute("ask-5", { questions: [{
    id: "duplicate",
    text: "Duplicate options",
    type: "multi",
    options: [{ value: "x", label: "One" }, { value: "x", label: "Two" }],
  }] }, undefined, undefined, context());

  assert.equal(result.isError, true);
  assert.equal(parse(result).error.code, "ASK_INVALID_INPUT");
  assert.match(parse(result).error.message, /duplicated/);
  assert.equal(promptCalls, 0);
  assert.equal(notifications, 0);
});

test("ask classifies no-UI and component failures with stable error codes", async () => {
  const noUiDefinition = createAskToolDefinition();
  const noUi = await noUiDefinition.execute("ask-6", { questions: validQuestions() }, undefined, undefined, context(false));
  assert.equal(noUi.isError, true);
  assert.equal(parse(noUi).error.code, "ASK_UI_UNAVAILABLE");

  const failingDefinition = createAskToolDefinition(undefined, {
    async prompt() { throw new Error("broken\x1b]0;owned\x07 ui"); },
  });
  const failed = await failingDefinition.execute("ask-7", { questions: validQuestions() }, undefined, undefined, context());
  assert.equal(failed.isError, true);
  assert.equal(parse(failed).error.code, "ASK_UI_FAILED");
  assert.equal(parse(failed).error.message, "broken ui");
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
