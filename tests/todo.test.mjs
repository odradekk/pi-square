import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerTodo = (await load("../src/todo/index.ts")).default;

function createRuntime(entries) {
  const events = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  registerTodo(pi);
  const ctx = {
    hasUI: false,
    sessionManager: { getBranch: () => entries },
  };
  return { events, tool: tools.get("todo"), ctx };
}

const entries = [];
const first = createRuntime(entries);
await first.events.get("session_start")({ reason: "startup" }, first.ctx);
let result = await first.tool.execute("create", {
  action: "create",
  title: "Native todo",
  todos: [{ id: "one", text: "first item" }, { id: "two", text: "second item" }],
}, undefined, undefined, first.ctx);
assert.equal(result.details.totalCount, 2);
assert.equal(entries.length, 1);
assert.equal(entries[0].customType, "pi-square.todo.v1");

result = await first.tool.execute("check", { action: "check", id: "one" }, undefined, undefined, first.ctx);
assert.equal(result.details.completedCount, 1);
assert.equal(entries.length, 2);

const resumed = createRuntime(entries);
await resumed.events.get("session_start")({ reason: "resume" }, resumed.ctx);
result = await resumed.tool.execute("list", { action: "list" }, undefined, undefined, resumed.ctx);
assert.equal(result.details.title, "Native todo");
assert.equal(result.details.completedCount, 1);
assert.equal(result.details.items[1].id, "two");

const beforeError = entries.length;
result = await resumed.tool.execute("bad", { action: "check", id: "missing" }, undefined, undefined, resumed.ctx);
assert.match(result.details.error, /Unknown todo id/);
assert.equal(entries.length, beforeError, "failed mutations must not append state");

const forkEntries = [...entries];
const forked = createRuntime(forkEntries);
await forked.events.get("session_start")({ reason: "fork" }, forked.ctx);
result = await forked.tool.execute("fork-list", { action: "list" }, undefined, undefined, forked.ctx);
assert.equal(result.details.totalCount, 2, "fork should inherit branch state");

await forked.tool.execute("clear", { action: "clear" }, undefined, undefined, forked.ctx);
const cleared = createRuntime(forkEntries);
await cleared.events.get("session_start")({ reason: "resume" }, cleared.ctx);
result = await cleared.tool.execute("cleared-list", { action: "list" }, undefined, undefined, cleared.ctx);
assert.equal(result.details.totalCount, 0);
console.log("todo tests: OK");
