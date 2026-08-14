import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const NOOP = async () => {};

// ---------- rg argument construction ----------

test("buildRgArgs emits fixed wrapper flags then -- separator", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "foo", path: "." });
  const sep = args.indexOf("--");
  assert.ok(sep > 0, "must contain -- separator");
  const head = args.slice(0, sep);
  assert.equal(head[0], "--no-config", "--no-config must be first");
  assert.deepEqual(head, [
    "--no-config", "--json", "--sort", "path", "--color", "never", "-S",
  ]);
  assert.deepEqual(args.slice(sep + 1), ["foo", "."]);
});

test("buildRgArgs places pattern and path after --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "foo", path: "src" });
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(sep + 1), ["foo", "src"]);
});

test("buildRgArgs always includes --no-config", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: "." });
  assert.ok(args.includes("--no-config"));
});

test("buildRgArgs hostile RIPGREP_CONFIG_PATH cannot inject arguments", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const prev = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = "/tmp/nonexistent-hostile-rg-config";
  try {
    const args = buildRgArgs({ pattern: "foo", path: "." });
    assert.ok(args.includes("--no-config"));
    assert.ok(!args.includes("--stats"));
    assert.ok(!args.includes("--max-count"));
  } finally {
    if (prev === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = prev;
  }
});

test("buildRgArgs places leading-dash pattern after --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "-foo", path: "." });
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(sep + 1), ["-foo", "."]);
});

test("buildRgArgs places leading-dash path after --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "foo", path: "-bar" });
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(sep + 1), ["foo", "-bar"]);
});

test("buildRgArgs always includes -S smart-case as a fixed wrapper flag", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: "." });
  assert.ok(args.includes("-S"));
  // case is no longer a parameter; -S is fixed and always present
  assert.ok(!args.includes("-s"));
  assert.ok(!args.includes("-i"));
});

test("buildRgArgs literal=true adds -F before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", literal: true });
  const sep = args.indexOf("--");
  assert.ok(args.slice(0, sep).includes("-F"));
});

test("buildRgArgs context: 3 produces -C 3 before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", context: 3 });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  const cIdx = head.indexOf("-C");
  assert.ok(cIdx >= 0, "must include -C");
  assert.equal(head[cIdx + 1], "3");
});

test("buildRgArgs context omitted produces no -C flag", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: "." });
  const sep = args.indexOf("--");
  assert.ok(!args.slice(0, sep).includes("-C"));
});

test("buildRgArgs globs pass through directly with ! negation", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", globs: ["*.ts", "!*.test.ts"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  // Expect exactly: -g *.ts -g !*.test.ts
  const gIdx = head.indexOf("-g");
  assert.ok(gIdx >= 0, "must include -g");
  assert.equal(head[gIdx + 1], "*.ts");
  assert.equal(head[gIdx + 2], "-g");
  assert.equal(head[gIdx + 3], "!*.test.ts");
});

test("buildRgArgs globs omitted produces no -g flag", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: "." });
  const sep = args.indexOf("--");
  assert.ok(!args.slice(0, sep).includes("-g"));
});

// ---------- fd argument construction ----------

test("buildFdArgs emits NUL output flag and -- separator", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({});
  const sep = args.indexOf("--");
  assert.ok(sep > 0);
  assert.ok(args.slice(0, sep).some((a) => a === "--print0" || a === "-0"));
});

test("buildFdArgs default pattern and path after --", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({});
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(sep + 1), [".", "."]);
});

test("buildFdArgs places leading-dash pattern and path after --", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({ pattern: "-foo", path: "-bar" });
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(sep + 1), ["-foo", "-bar"]);
});

test("buildFdArgs removes leading dot from extension values", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({ extensions: [".ts", "js"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(head.includes("ts"));
  assert.ok(head.includes("js"));
  assert.ok(!head.includes(".ts"), "leading dot must be stripped");
});

test("buildFdArgs types map to -t with full names before --", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({ types: ["file", "directory"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(head.includes("file"));
  assert.ok(head.includes("directory"));
});

test("buildFdArgs excludeGlobs map to -E before --", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({ excludeGlobs: ["node_modules"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  const eIdx = head.indexOf("-E");
  assert.ok(eIdx >= 0, "must include -E");
  assert.equal(head[eIdx + 1], "node_modules");
});

test("buildFdArgs maxDepth maps to --max-depth before --", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({ maxDepth: 5 });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  const dIdx = head.indexOf("--max-depth");
  assert.ok(dIdx >= 0, "must include --max-depth");
  assert.equal(head[dIdx + 1], "5");
});

test("buildFdArgs omits removed params (case, hidden, noIgnore, matchMode, minDepth)", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({});
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(!head.includes("-i") && !head.includes("-s"));
  assert.ok(!head.includes("-H"));
  assert.ok(!head.includes("-I"));
  assert.ok(!head.includes("--fixed-strings"));
  assert.ok(!head.includes("--glob"));
  assert.ok(!head.includes("--min-depth"));
});

// ---------- schema additionalProperties and bounds ----------

test("rg schema has additionalProperties false", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.additionalProperties, false);
});

test("fd schema has additionalProperties false", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.parameters.additionalProperties, false);
});

test("rg schema array properties enforce 1-20 unique non-empty items", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = def.parameters.properties;
  for (const key of ["globs"]) {
    const arr = props[key];
    assert.ok(arr, `${key} must exist in schema`);
    assert.equal(arr.minItems, 1, `${key} minItems must be 1`);
    assert.equal(arr.maxItems, 20, `${key} maxItems must be 20`);
    assert.equal(arr.uniqueItems, true, `${key} must require unique items`);
  }
});

test("fd schema array properties enforce 1-20 unique non-empty items", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  const props = def.parameters.properties;
  for (const key of ["types", "extensions", "excludeGlobs"]) {
    const arr = props[key];
    assert.ok(arr, `${key} must exist in schema`);
    assert.equal(arr.minItems, 1);
    assert.equal(arr.maxItems, 20);
    assert.equal(arr.uniqueItems, true);
  }
});

await run();
