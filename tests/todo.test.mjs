import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_PATH = [join(packageRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const require = createRequire(import.meta.url);
const { default: jiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const load = jiti(import.meta.url, { moduleCache: false });
const { default: registerTodo, TodoParamsSchema } = load(join(packageRoot, "src", "todo", "index.ts"));

function createRuntime(entries = [], overrides = {}) {
  const events = new Map();
  const tools = new Map();
  const widgets = [];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    appendEntry(customType, data) {
      if (overrides.appendError) throw overrides.appendError;
      entries.push({ type: "custom", customType, data });
    },
  };
  registerTodo(pi);
  const ctx = {
    hasUI: overrides.hasUI ?? false,
    ui: overrides.hasUI ? { setWidget(...args) { widgets.push(args); } } : undefined,
    sessionManager: { getBranch: () => entries },
  };
  return { entries, events, widgets, tool: tools.get("todo"), ctx };
}

async function execute(runtime, params) {
  return runtime.tool.execute("todo-test", params, undefined, undefined, runtime.ctx);
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("todo exposes a provider-compatible strict top-level object schema", () => {
  assert.equal(TodoParamsSchema.description, "Manage the current session's bounded, persistent three-state task list");
  assert.equal(TodoParamsSchema.type, "object");
  assert.equal(TodoParamsSchema.additionalProperties, false);
  assert.equal(TodoParamsSchema.anyOf, undefined);
  assert.deepEqual(TodoParamsSchema.required, ["action"]);
  assert.deepEqual([...TodoParamsSchema.properties.action.enum].sort(), [
    "add", "check", "clear", "list", "pause", "set", "start", "uncheck", "update",
  ]);
  assert.ok(!TodoParamsSchema.properties.action.enum.includes("create"));
  assert.equal(TodoParamsSchema.properties.todos.minItems, 1);
  assert.equal(TodoParamsSchema.properties.todos.maxItems, 20);
  assert.equal(TodoParamsSchema.properties.todos.items.additionalProperties, false);
  assert.equal(TodoParamsSchema.properties.todos.items.properties.text.maxLength, 500);
  assert.equal(TodoParamsSchema.properties.todos.items.properties.id.maxLength, 64);

  const anthropicInputSchema = {
    type: "object",
    properties: TodoParamsSchema.properties ?? {},
    required: TodoParamsSchema.required ?? [],
  };
  assert.ok(anthropicInputSchema.properties.action, "Anthropic conversion must retain the action schema");
  assert.deepEqual(anthropicInputSchema.required, ["action"]);
});

test("set returns JSON v1, starts the first pending item, and writes v2", async () => {
  const runtime = createRuntime();
  await runtime.events.get("session_start")({}, runtime.ctx);
  const result = await execute(runtime, {
    action: "set",
    title: "Release",
    todos: [{ text: "Inspect" }, { id: "build", text: "Build" }, { text: "Ship", status: "completed" }],
  });
  const body = payload(result);
  assert.equal(result.isError, undefined);
  assert.deepEqual(body, result.details);
  assert.equal(body.version, 1);
  assert.equal(body.status, "ok");
  assert.equal(body.changed, true);
  assert.deepEqual(body.counts, { total: 3, pending: 1, inProgress: 1, completed: 1 });
  assert.equal(body.currentId, "todo-1");
  assert.equal(body.widget, "unavailable");
  assert.equal(runtime.entries.length, 1);
  assert.equal(runtime.entries[0].customType, "pi-square.todo.v2");
  assert.equal(runtime.entries[0].data.version, 2);
});

test("generated ids reserve later explicit ids independent of item order", async () => {
  const runtime = createRuntime();
  const result = await execute(runtime, {
    action: "set",
    todos: [{ text: "Generated first" }, { id: "todo-1", text: "Explicit second" }],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.items.map((item) => item.id), ["todo-2", "todo-1"]);
  assert.equal(result.details.currentId, "todo-2");
});

test("check advances continuously, pause is explicit, and advance=false stops", async () => {
  const runtime = createRuntime();
  await execute(runtime, { action: "set", todos: [{ id: "one", text: "One" }, { id: "two", text: "Two" }, { id: "three", text: "Three" }] });
  let result = await execute(runtime, { action: "check", id: "one" });
  assert.equal(result.details.currentId, "two");
  assert.equal(result.details.items[0].status, "completed");

  result = await execute(runtime, { action: "pause" });
  assert.equal(result.details.currentId, undefined);
  assert.equal(result.details.items[1].status, "pending");

  result = await execute(runtime, { action: "start", id: "three" });
  assert.equal(result.details.currentId, "three");
  result = await execute(runtime, { action: "check", id: "three", advance: false });
  assert.equal(result.details.currentId, undefined);
  assert.equal(result.details.items[2].status, "completed");
});

test("add, update, batch check, and uncheck preserve the single-current invariant", async () => {
  const runtime = createRuntime();
  await execute(runtime, { action: "set", title: "Original", todos: [{ id: "one", text: "One" }, { id: "two", text: "Two" }] });
  await execute(runtime, { action: "add", todos: [{ id: "three", text: "Three" }] });
  let result = await execute(runtime, { action: "update", id: "three", text: "Third", title: "Updated" });
  assert.equal(result.details.title, "Updated");
  assert.equal(result.details.items[2].text, "Third");

  result = await execute(runtime, { action: "check", ids: ["one", "two"] });
  assert.equal(result.details.currentId, "three");
  assert.equal(result.details.counts.completed, 2);

  await execute(runtime, { action: "pause" });
  result = await execute(runtime, { action: "uncheck", id: "one" });
  assert.equal(result.details.currentId, "one");
  assert.equal(result.details.counts.inProgress, 1);
});

test("semantic failures are atomic, stable, and marked as errors", async () => {
  const runtime = createRuntime();
  await execute(runtime, { action: "set", todos: [{ id: "one", text: "One" }, { id: "two", text: "Two" }] });
  const beforeEntries = runtime.entries.length;
  const before = payload(await execute(runtime, { action: "list" }));

  const unknown = await execute(runtime, { action: "check", id: "missing" });
  assert.equal(unknown.isError, true);
  assert.equal(payload(unknown).error.code, "TODO_UNKNOWN_ID");
  assert.equal(unknown.details.changed, false);
  assert.deepEqual(unknown.details.items, before.items);
  assert.equal(runtime.entries.length, beforeEntries);

  const duplicate = await execute(runtime, { action: "add", todos: [{ id: "two", text: "Duplicate" }] });
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.details.error.code, "TODO_DUPLICATE_ID");
  assert.equal(runtime.entries.length, beforeEntries);

  const controls = await execute(runtime, { action: "update", id: "one", text: "unsafe\x1b]0;owned\x07" });
  assert.equal(controls.details.error.code, "TODO_INVALID_INPUT");
  assert.doesNotMatch(controls.content[0].text, /owned/);

  const conflicting = await execute(runtime, {
    action: "set",
    todos: [{ id: "a", text: "A", status: "in_progress" }, { id: "b", text: "B", status: "in_progress" }],
  });
  assert.equal(conflicting.details.error.code, "TODO_STATE_CONFLICT");

  const tooMany = await execute(runtime, {
    action: "set",
    todos: Array.from({ length: 21 }, (_, index) => ({ id: `large-${index}`, text: `Large ${index}` })),
  });
  assert.equal(tooMany.details.error.code, "TODO_ITEM_LIMIT");
  assert.equal(runtime.entries.length, beforeEntries);
});

test("adding work to an empty or completed list starts the first new pending item", async () => {
  const empty = createRuntime();
  let result = await execute(empty, { action: "add", todos: [{ id: "new", text: "New" }] });
  assert.equal(result.details.currentId, "new");

  const completed = createRuntime();
  await execute(completed, { action: "set", todos: [{ id: "old", text: "Old" }] });
  await execute(completed, { action: "check", id: "old" });
  result = await execute(completed, { action: "add", todos: [{ id: "next", text: "Next" }] });
  assert.equal(result.details.currentId, "next");
});

test("idempotent operations return changed=false and do not append snapshots", async () => {
  const runtime = createRuntime();
  await execute(runtime, { action: "set", title: "Stable", todos: [{ id: "one", text: "One" }] });
  const afterSet = runtime.entries.length;
  let result = await execute(runtime, { action: "list" });
  assert.equal(result.details.changed, false);
  result = await execute(runtime, { action: "start", id: "one" });
  assert.equal(result.details.changed, false);
  result = await execute(runtime, { action: "update", id: "one", text: "One", title: "Stable" });
  assert.equal(result.details.changed, false);
  assert.equal(runtime.entries.length, afterSet);
});

test("v1 snapshots migrate to three-state state without writing during restore", async () => {
  const entries = [{
    type: "custom",
    customType: "pi-square.todo.v1",
    data: {
      version: 1,
      title: "Legacy",
      items: [{ id: "old one", text: "Pending", completed: false }, { id: "done", text: "Done", completed: true }],
    },
  }];
  const runtime = createRuntime(entries);
  await runtime.events.get("session_start")({}, runtime.ctx);
  const result = await execute(runtime, { action: "list" });
  assert.equal(result.details.title, "Legacy");
  assert.deepEqual(result.details.items.map((item) => item.status), ["pending", "completed"]);
  assert.equal(result.details.items[0].id, "old-one");
  assert.equal(result.details.currentId, undefined);
  assert.equal(entries.length, 1);
});

test("damaged newest persistence entries fail closed without throwing or reviving stale state", async () => {
  for (const customType of ["pi-square.todo.v1", "pi-square.todo.v2"]) {
    const entries = [
      {
        type: "custom",
        customType: "pi-square.todo.v2",
        data: { version: 2, title: "Stale", items: [{ id: "stale", text: "Stale", status: "in_progress" }] },
      },
      { type: "custom", customType, data: null },
    ];
    const runtime = createRuntime(entries);
    await runtime.events.get("session_start")({}, runtime.ctx);
    const result = await execute(runtime, { action: "list" });
    assert.equal(result.details.counts.total, 0);
    assert.equal(result.details.title, "Tasks");
  }
});

test("session-tree restore follows branch state and keeps forks isolated", async () => {
  const parentEntries = [];
  const parent = createRuntime(parentEntries);
  await execute(parent, { action: "set", todos: [{ id: "one", text: "One" }, { id: "two", text: "Two" }] });
  await execute(parent, { action: "check", id: "one" });

  const forkEntries = structuredClone(parentEntries);
  const fork = createRuntime(forkEntries);
  await fork.events.get("session_tree")({}, fork.ctx);
  let result = await execute(fork, { action: "list" });
  assert.equal(result.details.currentId, "two");
  await execute(fork, { action: "clear" });

  const resumedParent = createRuntime(parentEntries);
  await resumedParent.events.get("session_start")({}, resumedParent.ctx);
  result = await execute(resumedParent, { action: "list" });
  assert.equal(result.details.counts.total, 2);
  assert.equal(parentEntries.length, 2);
});

test("persistence failure leaves in-memory and branch state unchanged", async () => {
  const runtime = createRuntime([], { appendError: new Error("disk\x1b]0;owned\x07 failed") });
  const result = await execute(runtime, { action: "set", todos: [{ text: "One" }] });
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "TODO_PERSISTENCE_FAILED");
  assert.equal(result.details.counts.total, 0);
  assert.equal(runtime.entries.length, 0);
  assert.doesNotMatch(result.content[0].text, /owned/);
});

test("clear resets state and removes the interactive widget", async () => {
  const runtime = createRuntime([], { hasUI: true });
  await execute(runtime, { action: "set", todos: [{ text: "One" }] });
  const result = await execute(runtime, { action: "clear" });
  assert.equal(result.details.widget, "cleared");
  assert.equal(result.details.counts.total, 0);
  assert.equal(runtime.widgets.at(-1)[1], undefined);
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
