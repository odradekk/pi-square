import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const NOOP = async () => {};

// ---------- rg schema ----------

test("rg schema exposes exact 8 properties", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties).sort();
  const expected = ["context", "filesOnly", "globs", "limit", "literal", "offset", "path", "pattern"];
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

test("rg schema has additionalProperties false", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.additionalProperties, false);
});

test("rg schema requires only pattern", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.ok(def.parameters.required.includes("pattern"));
  assert.equal(def.parameters.required.length, 1);
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

test("rg schema rejects empty pattern, path, and glob strings", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.pattern.minLength, 1);
  assert.equal(def.parameters.properties.path.minLength, 1);
  assert.equal(def.parameters.properties.globs.items.minLength, 1);
});

// ---------- fd schema ----------

test("fd schema exposes exact 8 properties", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties).sort();
  const expected = ["excludeGlobs", "extensions", "limit", "maxDepth", "offset", "path", "pattern", "types"];
  assert.deepEqual(props, [...expected].sort());
});

test("fd schema omits forbidden legacy properties", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties);
  for (const forbidden of ["rawArgs", "type", "extension", "caseSensitive", "maxdepth", "exact", "case", "hidden", "noIgnore", "matchMode", "minDepth"]) {
    assert.ok(!props.includes(forbidden), `fd schema must not include ${forbidden}`);
  }
});

test("fd schema has additionalProperties false", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.additionalProperties, false);
});

test("fd schema has no required fields (pattern is optional)", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const required = def.parameters.required || [];
  assert.equal(required.length, 0, "fd should have no required fields");
  assert.ok(!required.includes("pattern"), "fd pattern must be optional");
});

test("fd schema bounds offset to 1000000 and limit to 1-100", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.offset.minimum, 0);
  assert.equal(def.parameters.properties.offset.maximum, 1_000_000);
  assert.equal(def.parameters.properties.limit.minimum, 1);
  assert.equal(def.parameters.properties.limit.maximum, 100);
});

test("fd schema rejects empty pattern, path, extension, and exclude strings", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.pattern.minLength, 1);
  assert.equal(def.parameters.properties.path.minLength, 1);
  assert.equal(def.parameters.properties.extensions.items.minLength, 1);
  assert.equal(def.parameters.properties.excludeGlobs.items.minLength, 1);
});

test("fd schema types items is StringEnum (enum array, not anyOf)", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const typesSchema = def.parameters.properties.types;
  assert.ok(typesSchema, "fd must have types property");

  // StringEnum produces { type: "string", enum: [...] }; in an array the
  // items should carry the enum directly, not via anyOf/const.
  const items = typesSchema.items;
  assert.ok(items, "types must have items schema");
  assert.ok(Array.isArray(items.enum), "types items must have enum array");
  assert.ok(!items.anyOf, "types items must not use anyOf");
  const allowed = items.enum;
  for (const t of ["file", "directory", "symlink", "executable"]) {
    assert.ok(allowed.includes(t), `fd types must include ${t}`);
  }
  assert.ok(!allowed.includes("f"), "must use full names not single-letter aliases");
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

// ---------- prompt guidelines ----------

test("rg has exactly 3 prompt guidelines", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.promptGuidelines.length, 3);
});

test("fd has exactly 2 prompt guidelines", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.promptGuidelines.length, 2);
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
