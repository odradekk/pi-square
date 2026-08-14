import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const NOOP = async () => {};

// ---------- rg schema ----------

test("rg schema exposes exact v2 properties", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties).sort();
  const expected = ["pattern", "path", "globs", "literal", "context", "filesOnly", "offset", "limit"];
  assert.deepEqual(props, [...expected].sort());
});

test("rg schema omits forbidden and removed properties", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties);
  for (const forbidden of [
    "rawArgs", "lineNumber", "stats", "caseSensitive", "type", "glob", "exact",
    "case", "word", "hidden", "noIgnore", "includeGlobs", "excludeGlobs",
    "types", "beforeContext", "afterContext", "maxDepth",
  ]) {
    assert.ok(!props.includes(forbidden), `rg schema must not include ${forbidden}`);
  }
});

test("rg schema requires pattern", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.ok(def.parameters.required.includes("pattern"));
});

test("rg schema bounds offset to 1000000, limit to 1-25, and context to 0-20", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.offset.minimum, 0);
  assert.equal(def.parameters.properties.offset.maximum, 1_000_000);
  assert.equal(def.parameters.properties.limit.minimum, 1);
  assert.equal(def.parameters.properties.limit.maximum, 25);
  assert.equal(def.parameters.properties.context.minimum, 0);
  assert.equal(def.parameters.properties.context.maximum, 20);
});

test("fd schema bounds offset to 1000000 and limit to 1-100", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.offset.minimum, 0);
  assert.equal(def.parameters.properties.offset.maximum, 1_000_000);
  assert.equal(def.parameters.properties.limit.minimum, 1);
  assert.equal(def.parameters.properties.limit.maximum, 100);
});

test("rg schema rejects empty pattern, path, and glob strings", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.pattern.minLength, 1);
  assert.equal(def.parameters.properties.path.minLength, 1);
  assert.equal(def.parameters.properties.globs.items.minLength, 1);
});

// ---------- fd schema ----------

test("fd schema exposes exact v2 properties", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties).sort();
  const expected = ["pattern", "path", "excludeGlobs", "types", "extensions", "maxDepth", "offset", "limit"];
  assert.deepEqual(props, [...expected].sort());
});

test("fd schema omits forbidden and removed properties", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties);
  for (const forbidden of [
    "rawArgs", "type", "extension", "caseSensitive", "maxdepth", "exact",
    "case", "hidden", "noIgnore", "matchMode", "minDepth", "includeGlobs",
  ]) {
    assert.ok(!props.includes(forbidden), `fd schema must not include ${forbidden}`);
  }
});

test("fd schema has no required fields (pattern is optional)", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const required = def.parameters.required || [];
  assert.ok(!required.includes("pattern"), "fd pattern must be optional");
});

test("fd schema rejects empty pattern, path, extension, and exclude strings", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.pattern.minLength, 1);
  assert.equal(def.parameters.properties.path.minLength, 1);
  assert.equal(def.parameters.properties.extensions.items.minLength, 1);
  assert.equal(def.parameters.properties.excludeGlobs.items.minLength, 1);
});

test("fd schema types is a string enum, not a literal union", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const typesSchema = def.parameters.properties.types;
  assert.ok(typesSchema, "fd must have types property");
  // StringEnum renders items as { type: "string", enum: [...] } with no anyOf
  const items = typesSchema.items;
  assert.ok(items, "types must be an array with items");
  assert.ok(!items.anyOf, "types items must not use anyOf (literal union)");
  assert.ok(Array.isArray(items.enum), "types items must be a string enum");
  for (const t of ["file", "directory", "symlink", "executable"]) {
    assert.ok(items.enum.includes(t), `fd types must include ${t}`);
  }
  assert.ok(!items.enum.includes("f"), "must use full names not single-letter aliases");
});

// ---------- definition shape ----------

test("createRgToolDefinition returns object with name rg and execute", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.name, "rg");
  assert.equal(typeof def.execute, "function");
  assert.equal(def.renderCall, undefined);
  assert.equal(def.renderResult, undefined);
  assert.equal(def.renderShell, undefined);
});

test("createFdToolDefinition returns object with name fd and execute", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.name, "fd");
  assert.equal(typeof def.execute, "function");
  assert.equal(def.renderCall, undefined);
  assert.equal(def.renderResult, undefined);
  assert.equal(def.renderShell, undefined);
});

// ---------- index.ts registration ----------

test("index registers rg and fd with no command or hook", async () => {
  const mod = await loadModule("src/search/index.ts");
  const tools = [];
  const commands = [];
  const hooks = [];
  const mockPi = {
    registerTool: (def) => tools.push(def.name),
    registerCommand: (name) => commands.push(name),
    on: (event) => hooks.push(event),
  };
  mod.default(mockPi);
  assert.deepEqual(tools.sort(), ["fd", "rg"]);
  assert.equal(commands.length, 0, "no commands should be registered");
  assert.equal(hooks.length, 0, "no session hooks should be registered");
});

await run();
