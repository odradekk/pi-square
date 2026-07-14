import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const NOOP = async () => {};

// ---------- rg schema ----------

test("rg schema exposes exact v2 properties", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties).sort();
  const expected = ["pattern", "path", "case", "literal", "word", "hidden", "noIgnore", "offset", "limit", "includeGlobs", "excludeGlobs", "types", "beforeContext", "afterContext", "maxDepth"];
  assert.deepEqual(props, [...expected].sort());
});

test("rg schema omits forbidden legacy properties", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties);
  for (const forbidden of ["rawArgs", "lineNumber", "stats", "caseSensitive", "type", "glob", "context", "exact"]) {
    assert.ok(!props.includes(forbidden), `rg schema must not include ${forbidden}`);
  }
});

test("rg schema requires pattern", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.ok(def.parameters.required.includes("pattern"));
});

test("rg schema offset bounded 0-1000000 and limit bounded 1-50", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.offset.minimum, 0);
  assert.equal(def.parameters.properties.offset.maximum, 1_000_000);
  assert.equal(def.parameters.properties.limit.minimum, 1);
  assert.equal(def.parameters.properties.limit.maximum, 50);
});

test("rg schema rejects empty pattern, path, glob, and type strings", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.properties.pattern.minLength, 1);
  assert.equal(def.parameters.properties.path.minLength, 1);
  assert.equal(def.parameters.properties.includeGlobs.items.minLength, 1);
  assert.equal(def.parameters.properties.excludeGlobs.items.minLength, 1);
  assert.equal(def.parameters.properties.types.items.minLength, 1);
});

// ---------- fd schema ----------

test("fd schema exposes exact v2 properties", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties).sort();
  const expected = ["pattern", "path", "case", "hidden", "noIgnore", "offset", "limit", "matchMode", "types", "extensions", "excludeGlobs", "minDepth", "maxDepth"];
  assert.deepEqual(props, [...expected].sort());
});

test("fd schema omits forbidden legacy properties", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = Object.keys(def.parameters.properties);
  for (const forbidden of ["rawArgs", "type", "extension", "caseSensitive", "maxdepth", "exact"]) {
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

test("fd schema types restricted to file/directory/symlink/executable", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const typesSchema = def.parameters.properties.types;
  assert.ok(typesSchema, "fd must have types property");
  // TypeBox enum representation: extract allowed values
  let allowed;
  if (typesSchema.anyOf) {
    allowed = typesSchema.anyOf.map((s) => s.const);
  } else if (typesSchema.items?.anyOf) {
    allowed = typesSchema.items.anyOf.map((s) => s.const);
  } else if (typesSchema.items?.enum) {
    allowed = typesSchema.items.enum;
  } else if (typesSchema.enum) {
    allowed = typesSchema.enum;
  }
  assert.ok(allowed, "must be able to extract type enum values");
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
  assert.equal(typeof def.renderCall, "function");
  assert.equal(typeof def.renderResult, "function");
  assert.equal(def.renderShell, undefined);
});

test("createFdToolDefinition returns object with name fd and execute", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.name, "fd");
  assert.equal(typeof def.execute, "function");
  assert.equal(typeof def.renderCall, "function");
  assert.equal(typeof def.renderResult, "function");
  assert.equal(def.renderShell, undefined);
});

// ---------- index.ts registration ----------

test("index registers rg, fd, and sg with no command or hook", async () => {
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
  assert.deepEqual(tools.sort(), ["fd", "rg", "sg"]);
  assert.equal(commands.length, 0, "no commands should be registered");
  assert.equal(hooks.length, 0, "no session hooks should be registered");
});

await run();
