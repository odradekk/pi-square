import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

function range(line, column, endColumn = column + 3) {
  return {
    byteOffset: { start: line * 10 + column, end: line * 10 + endColumn },
    start: { line, column },
    end: { line, column: endColumn },
  };
}

function match(file, line, text, meta = {}) {
  return {
    text,
    range: range(line, 2, 2 + Buffer.byteLength(text)),
    file,
    lines: `  ${text}`,
    language: "TypeScript",
    metaVariables: {
      single: Object.fromEntries(Object.entries(meta).map(([name, value]) => [name, { text: value, range: range(line, 2) }])),
      multi: {},
      transformed: {},
    },
  };
}

function stream(matches) {
  return Buffer.from(matches.map((item) => JSON.stringify(item)).join("\n") + (matches.length > 0 ? "\n" : ""));
}

const NOOP = async () => {};
const goodBinary = async () => "/fake/ast-grep";

// ---------- binary distribution ----------

test("sg platform packages cover the project's six targets", async () => {
  const { sgPlatformPackage } = await loadModule("src/search/sg-binary.ts");
  const expected = new Map([
    ["linux-x64", "@ast-grep/cli-linux-x64-gnu"],
    ["linux-arm64", "@ast-grep/cli-linux-arm64-gnu"],
    ["darwin-x64", "@ast-grep/cli-darwin-x64"],
    ["darwin-arm64", "@ast-grep/cli-darwin-arm64"],
    ["win32-x64", "@ast-grep/cli-win32-x64-msvc"],
    ["win32-arm64", "@ast-grep/cli-win32-arm64-msvc"],
  ]);
  for (const [target, packageName] of expected) {
    const [platform, arch] = target.split("-");
    const resolved = sgPlatformPackage(platform, arch);
    assert.equal(resolved.packageName, packageName);
    assert.equal(resolved.binaryName, platform === "win32" ? "ast-grep.exe" : "ast-grep");
  }
  assert.throws(() => sgPlatformPackage("linux", "ia32"), /Unsupported ast-grep/);
});

test("sg resolves the installed native package without PATH fallback", async () => {
  const { resolveSgBinary } = await loadModule("src/search/sg-binary.ts");
  const binary = resolveSgBinary(process.platform, process.arch, process.cwd());
  assert.ok(isAbsolute(binary));
  assert.match(binary, /node_modules[\\/]@ast-grep[\\/]cli-/);
  assert.notEqual(binary, "sg");
  assert.notEqual(binary, "ast-grep");

  const isolatedRoot = mkdtempSync(join(tmpdir(), "pi-square-sg-missing-"));
  try {
    assert.throws(
      () => resolveSgBinary(process.platform, process.arch, isolatedRoot),
      /native package .* is not installed/,
    );
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

// ---------- argument and schema contract ----------

test("sg arguments are fixed, read-only, and isolate the path", async () => {
  const { buildSgArgs } = await loadModule("src/search/arguments.ts");
  assert.deepEqual(buildSgArgs({
    pattern: "call($ARG)",
    language: "ts",
    selector: "call_expression",
    strictness: "ast",
    path: "--hostile-path",
    hidden: true,
    noIgnore: true,
    includeGlobs: ["src/**/*.ts"],
    excludeGlobs: ["vendor/**"],
    beforeContext: 1,
    afterContext: 2,
  }), [
    "run", "--json=stream", "--color=never",
    "--pattern", "call($ARG)", "--lang", "ts", "--selector", "call_expression", "--strictness", "ast",
    "--no-ignore", "hidden", "--no-ignore", "dot", "--no-ignore", "exclude", "--no-ignore", "global", "--no-ignore", "vcs",
    "--globs", "src/**/*.ts", "--globs", "!vendor/**", "--before", "1", "--after", "2",
    "--", "--hostile-path",
  ]);
});

test("sg arguments require exactly one query and reject pattern-only options for kind", async () => {
  const { buildSgArgs } = await loadModule("src/search/arguments.ts");
  assert.throws(() => buildSgArgs({}), /Exactly one/);
  assert.throws(() => buildSgArgs({ pattern: "a", kind: "identifier" }), /Exactly one/);
  assert.throws(() => buildSgArgs({ kind: "identifier", strictness: "ast" }), /require pattern/);
  assert.throws(() => buildSgArgs({ pattern: "a", includeGlobs: ["!bad"] }), /must not begin/);
  assert.deepEqual(buildSgArgs({ kind: "function_declaration" }), [
    "run", "--json=stream", "--color=never", "--kind", "function_declaration", "--", ".",
  ]);
});

test("sg schema exposes only the bounded read-only search surface", async () => {
  const { createSgToolDefinition } = await loadModule("src/search/tools/sg.ts");
  const def = createSgToolDefinition({ resolveBinary: NOOP, runCommand: NOOP });
  assert.equal(def.name, "sg");
  assert.equal(def.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), [
    "afterContext", "beforeContext", "excludeGlobs", "hidden", "includeGlobs", "kind", "language", "limit",
    "noIgnore", "offset", "path", "pattern", "selector", "strictness",
  ]);
  for (const forbidden of ["rawArgs", "rewrite", "interactive", "updateAll", "rule", "config"]) {
    assert.equal(def.parameters.properties[forbidden], undefined);
  }
  assert.equal(def.parameters.properties.limit.maximum, 50);
  assert.equal(def.parameters.properties.offset.maximum, 1_000_000);
});

// ---------- streamed output ----------

test("sg accumulator handles split UTF-8 NDJSON, paging, and metavariables", async () => {
  const { SgAccumulator } = await loadModule("src/search/sg-output.ts");
  const raw = stream([
    match("src/a.ts", 0, "call(first)"),
    match("src/中文.ts", 2, "call(值)", { ARG: "值" }),
    match("src/c.ts", 4, "call(third)"),
    match("src/d.ts", 6, "call(fourth)"),
  ]);
  const accumulator = new SgAccumulator({ offset: 1, limit: 2 });
  for (let index = 0; index < raw.length; index += 3) accumulator.push(raw.subarray(index, index + 3));
  const result = accumulator.finish({ naturalEnd: false, exitCode: null, stderr: "" });
  assert.equal(result.details.page.returned, 2);
  assert.equal(result.details.page.hasMore, true);
  assert.equal(result.details.page.nextOffset, 3);
  assert.equal(result.details.page.total, undefined);
  assert.equal(result.details.matches[0].path, "src/中文.ts");
  assert.deepEqual(result.details.matches[0].range.start, { line: 3, column: 3 });
  assert.equal(result.details.matches[0].metaVariables[0].name, "ARG");
  assert.match(result.content[0].text, /\$ARG=值/);
});

test("sg accumulator reports natural totals and successful empty output", async () => {
  const { SgAccumulator } = await loadModule("src/search/sg-output.ts");
  const populated = new SgAccumulator({ offset: 0, limit: 5 });
  populated.push(stream([match("a.ts", 0, "foo()"), match("b.ts", 1, "foo()") ]));
  const result = populated.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.total, 2);
  assert.equal(result.details.page.hasMore, false);

  const empty = new SgAccumulator({ offset: 0, limit: 5 });
  const emptyResult = empty.finish({ naturalEnd: true, exitCode: 1, stderr: "" });
  assert.equal(emptyResult.details.page.returned, 0);
  assert.match(emptyResult.content[0].text, /No structural matches found/);
});

test("sg accumulator makes content-budget truncation explicit", async () => {
  const { SgAccumulator } = await loadModule("src/search/sg-output.ts");
  const accumulator = new SgAccumulator({ offset: 0, limit: 5, contentBudget: 1_100 });
  accumulator.push(stream([
    match("a.ts", 0, "a".repeat(700)),
    match("b.ts", 1, "b".repeat(700)),
  ]));
  const result = accumulator.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.returned, 1);
  assert.equal(result.details.page.hasMore, true);
  assert.equal(result.details.page.nextOffset, 1);
  assert.equal(result.details.truncation.contentBudgetReached, true);
});

test("sg accumulator rejects malformed and incomplete output", async () => {
  const { SgAccumulator } = await loadModule("src/search/sg-output.ts");
  const malformed = new SgAccumulator({ offset: 0, limit: 5 });
  assert.throws(() => malformed.push("{bad}\n"), /malformed sg JSON/);

  const incomplete = new SgAccumulator({ offset: 0, limit: 5 });
  incomplete.push(stream([match("a.ts", 0, "foo()") ]));
  assert.throws(() => incomplete.finish({ naturalEnd: false, exitCode: null, stderr: "" }), /did not end naturally/);
});

// ---------- tool execution ----------

test("sg tool executes in cwd without retaining stdout", async () => {
  const { createSgToolDefinition } = await loadModule("src/search/tools/sg.ts");
  let observedCommand;
  let observedArgs;
  let observedOptions;
  const runCommand = async (command, args, options) => {
    observedCommand = command;
    observedArgs = args;
    observedOptions = options;
    options.onChunk(stream([match("src/a.ts", 0, "call(value)", { ARG: "value" })]));
    return { status: "ok", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false };
  };
  const def = createSgToolDefinition({ resolveBinary: goodBinary, runCommand });
  const result = await def.execute("id", { pattern: "call($ARG)", language: "ts" }, undefined, undefined, { cwd: "/workspace" });
  assert.equal(observedCommand, "/fake/ast-grep");
  assert.ok(observedArgs.includes("--json=stream"));
  assert.equal(observedOptions.cwd, "/workspace");
  assert.equal(observedOptions.captureStdout, false);
  assert.equal(result.details.page.returned, 1);
  assert.deepEqual(result.details.presentation, { version: 1, executionCwd: "/workspace", platform: process.platform });
});

test("sg tool handles no-match and rejects runtime failures", async () => {
  const { createSgToolDefinition } = await loadModule("src/search/tools/sg.ts");
  const resultShape = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false };
  const noMatch = createSgToolDefinition({
    resolveBinary: goodBinary,
    runCommand: async () => ({ ...resultShape, status: "non-zero", exitCode: 1 }),
  });
  const empty = await noMatch.execute("id", { kind: "identifier" }, undefined);
  assert.equal(empty.details.page.returned, 0);

  for (const [status, message] of [["timeout", /timed out/], ["aborted", /aborted/], ["stdout-cap", /stdout exceeded/]]) {
    const def = createSgToolDefinition({
      resolveBinary: goodBinary,
      runCommand: async () => ({ ...resultShape, status, exitCode: null }),
    });
    await assert.rejects(def.execute("id", { kind: "identifier" }, undefined), message);
  }
  const failed = createSgToolDefinition({
    resolveBinary: goodBinary,
    runCommand: async () => ({ ...resultShape, status: "non-zero", exitCode: 2, stderr: Buffer.from("invalid pattern") }),
  });
  await assert.rejects(failed.execute("id", { pattern: "(" }, undefined), /invalid pattern/);
});

await run();
