import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const NOOP = async () => {};

// ---------- rg argument construction ----------

test("buildRgArgs emits fixed wrapper flags before -- separator", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "foo", path: "." });
  const sep = args.indexOf("--");
  assert.ok(sep > 0, "must contain -- separator");
  const head = args.slice(0, sep);
  assert.equal(head[0], "--no-config", "--no-config must be first");
  assert.deepEqual(
    head.slice(0, 6),
    ["--no-config", "--json", "--sort", "path", "--color", "never"],
  );
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

test("buildRgArgs smart case adds -S by default", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: "." });
  assert.ok(args.includes("-S"));
});

test("buildRgArgs sensitive case adds -s, insensitive adds -i", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const sens = buildRgArgs({ pattern: "x", path: ".", case: "sensitive" });
  const insens = buildRgArgs({ pattern: "x", path: ".", case: "insensitive" });
  assert.ok(sens.includes("-s"));
  assert.ok(insens.includes("-i"));
});

test("buildRgArgs literal=true adds -F before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", literal: true });
  const sep = args.indexOf("--");
  assert.ok(args.slice(0, sep).includes("-F"));
});

test("buildRgArgs word=true adds -w before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", word: true });
  const sep = args.indexOf("--");
  assert.ok(args.slice(0, sep).includes("-w"));
});

test("buildRgArgs includeGlobs emit -g entries before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", includeGlobs: ["*.ts"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(head.includes("-g"));
  assert.ok(head.includes("*.ts"));
});

test("buildRgArgs excludeGlobs are converted to ripgrep negation globs", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", excludeGlobs: ["*.test.ts"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  const gIdx = head.indexOf("-g");
  assert.ok(gIdx >= 0);
  assert.ok(head.includes("!*.test.ts"), "exclude glob must be negated with !");
});

test("buildRgArgs types emit -t entries before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", types: ["ts", "js"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(head.includes("-t"));
  assert.ok(head.includes("ts"));
  assert.ok(head.includes("js"));
});

test("buildRgArgs context flags emitted before --", async () => {
  const { buildRgArgs } = await loadModule("src/search/arguments.ts");
  const args = buildRgArgs({ pattern: "x", path: ".", beforeContext: 2, afterContext: 3 });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(head.includes("-B"));
  assert.ok(head.includes("2"));
  assert.ok(head.includes("-A"));
  assert.ok(head.includes("3"));
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

test("buildFdArgs matchMode fixed adds -F, glob adds --glob", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const fixed = buildFdArgs({ matchMode: "fixed" });
  const glob = buildFdArgs({ matchMode: "glob" });
  const sep1 = fixed.indexOf("--");
  const sep2 = glob.indexOf("--");
  assert.ok(fixed.slice(0, sep1).some((a) => a === "-F" || a === "--fixed-strings"));
  assert.ok(glob.slice(0, sep2).some((a) => a === "--glob" || a === "-g"));
});

test("buildFdArgs types map to -t with full names before --", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  const args = buildFdArgs({ types: ["file", "directory"] });
  const sep = args.indexOf("--");
  const head = args.slice(0, sep);
  assert.ok(head.includes("file"));
  assert.ok(head.includes("directory"));
});

test("buildFdArgs rejects minDepth > maxDepth", async () => {
  const { buildFdArgs } = await loadModule("src/search/arguments.ts");
  assert.throws(
    () => buildFdArgs({ minDepth: 5, maxDepth: 3 }),
    /min.*max|depth|invalid/i,
  );
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
  for (const key of ["includeGlobs", "excludeGlobs", "types"]) {
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
