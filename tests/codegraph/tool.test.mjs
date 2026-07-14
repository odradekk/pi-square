import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateToolCall } from "@earendil-works/pi-ai";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { createCodeGraphToolDefinition } = await load(join(packageRoot, "src", "codegraph", "tool.ts"));
const { resolveCodeGraphPath, findCodeGraphRoot } = await load(join(packageRoot, "src", "codegraph", "paths.ts"));

const BINARY = { command: "/bundle/node", prefixArgs: ["--liftoff-only", "/bundle/codegraph.js"], packageName: "test", version: "1.4.1" };
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function commandResult(stdout = "", overrides = {}) {
  return {
    status: "ok",
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    stderrTruncated: false,
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    initialized: true,
    version: "1.4.1",
    projectPath: "/repo",
    fileCount: 2,
    nodeCount: 3,
    edgeCount: 1,
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    worktreeMismatch: null,
    index: { state: "complete", reindexRecommended: false, pendingRefs: 0 },
    ...overrides,
  };
}

function context(cwd, overrides = {}) {
  return {
    cwd,
    hasUI: true,
    ui: { confirm: async () => true },
    ...overrides,
  };
}

function createIndex(root) {
  mkdirSync(join(root, ".codegraph"), { recursive: true });
  writeFileSync(join(root, ".codegraph", "codegraph.db"), "fixture");
}

function definition(runCommand, allowWrite = true, resolveBinary = async () => BINARY) {
  return createCodeGraphToolDefinition({ resolveBinary, runCommand }, allowWrite);
}

async function execute(def, params, ctx, updates = []) {
  return def.execute("call", params, undefined, (update) => updates.push(update), ctx);
}

test("full and child schemas use provider-compatible strict top-level objects", () => {
  const full = definition(async () => commandResult(), true);
  const child = definition(async () => commandResult(), false);
  for (const schema of [full.parameters, child.parameters]) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.anyOf, undefined);
    assert.deepEqual(schema.required, ["operation"]);
  }
  assert.deepEqual(full.parameters.properties.operation.enum, ["explore", "status", "init", "sync", "reindex"]);
  assert.deepEqual(child.parameters.properties.operation.enum, ["explore", "status"]);
  assert.equal(full.parameters.properties.query.maxLength, 10_000);
  assert.equal(full.parameters.properties.maxFiles.maximum, 20);
});

test("Pi validation accepts operation arguments and reports one clear empty-call error", () => {
  const full = definition(async () => commandResult(), true);
  assert.deepEqual(
    validateToolCall([full], { id: "status", name: "codegraph", arguments: { operation: "status" } }),
    { operation: "status" },
  );
  assert.deepEqual(
    validateToolCall([full], { id: "explore", name: "codegraph", arguments: { operation: "explore", query: "trace auth" } }),
    { operation: "explore", query: "trace auth" },
  );
  assert.throws(
    () => validateToolCall([full], { id: "empty", name: "codegraph", arguments: {} }),
    (error) => error instanceof Error
      && /required propert(?:y|ies) operation/.test(error.message)
      && !/anyOf/.test(error.message)
      && !/required propert(?:y|ies) operation, query/.test(error.message),
  );
});

test("NOT_INDEXED is recoverable and does not resolve or execute the binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-missing-"));
  let resolved = 0;
  let runs = 0;
  try {
    const def = definition(async () => { runs += 1; return commandResult(); }, true, async () => { resolved += 1; return BINARY; });
    const result = await execute(def, { operation: "explore", query: "How does auth work?" }, context(root));
    assert.equal(result.details.phase, "recoverable");
    assert.equal(result.details.code, "NOT_INDEXED");
    assert.equal(result.isError, undefined);
    assert.equal(resolved, 0);
    assert.equal(runs, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init requires UI confirmation and performs zero writes when declined", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-confirm-"));
  let runs = 0;
  try {
    const def = definition(async () => { runs += 1; return commandResult(); });
    const unavailable = await execute(def, { operation: "init" }, context(root, { hasUI: false }));
    assert.equal(unavailable.details.code, "CONFIRMATION_UNAVAILABLE");
    const declined = await execute(def, { operation: "init" }, context(root, { ui: { confirm: async () => false } }));
    assert.equal(declined.details.phase, "declined");
    assert.equal(declined.isError, undefined);
    assert.equal(runs, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init accepts an upstream marker-only directory but rejects other residue", async () => {
  const markerRoot = mkdtempSync(join(tmpdir(), "pi-codegraph-marker-"));
  const residueRoot = mkdtempSync(join(tmpdir(), "pi-codegraph-residue-"));
  mkdirSync(join(markerRoot, ".codegraph"));
  writeFileSync(join(markerRoot, ".codegraph", ".gitignore"), "*\n!.gitignore\n");
  mkdirSync(join(residueRoot, ".codegraph"));
  writeFileSync(join(residueRoot, ".codegraph", "stale.lock"), "stale");
  const calls = [];
  try {
    const def = definition(async (_command, args) => {
      calls.push(args[2]);
      return args[2] === "status"
        ? commandResult(JSON.stringify(status({ projectPath: markerRoot })))
        : commandResult("indexed\n");
    });
    const marker = await execute(def, { operation: "init" }, context(markerRoot));
    assert.equal(marker.details.phase, "done");
    assert.deepEqual(calls, ["init", "status"]);

    const residue = await execute(def, { operation: "init" }, context(residueRoot));
    assert.equal(residue.details.code, "INDEX_DIRECTORY_EXISTS");
    assert.deepEqual(calls, ["init", "status"]);
  } finally {
    rmSync(markerRoot, { recursive: true, force: true });
    rmSync(residueRoot, { recursive: true, force: true });
  }
});

test("confirmed init runs in the bounded target and returns fresh status", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-init-"));
  const calls = [];
  try {
    const def = definition(async (_command, args, options) => {
      calls.push({ args, options });
      const operation = args[2];
      if (operation === "init") return commandResult("indexed\n");
      if (operation === "status") return commandResult(JSON.stringify(status({ projectPath: root })));
      throw new Error(`unexpected operation ${operation}`);
    });
    const updates = [];
    const result = await execute(def, { operation: "init" }, context(root), updates);
    assert.equal(result.details.phase, "done");
    assert.deepEqual(calls.map((call) => call.args[2]), ["init", "status"]);
    assert.equal(calls[0].args[3], root);
    assert.equal(calls[0].options.killTree, true);
    assert.equal(calls[0].options.timeout, 0);
    assert.equal(calls[0].options.env.DO_NOT_TRACK, "1");
    assert.equal(calls[0].options.env.CODEGRAPH_NO_DOWNLOAD, "1");
    assert.ok(updates.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explore auto-syncs pending changes before querying", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-sync-"));
  createIndex(root);
  const calls = [];
  let statusCalls = 0;
  try {
    const def = definition(async (_command, args, options) => {
      calls.push({ args, options });
      const operation = args[2];
      if (operation === "status") {
        statusCalls += 1;
        return commandResult(JSON.stringify(status({
          projectPath: root,
          pendingChanges: statusCalls === 1 ? { added: 0, modified: 1, removed: 0 } : { added: 0, modified: 0, removed: 0 },
        })));
      }
      if (operation === "sync") return commandResult("synced\n");
      if (operation === "explore") return commandResult("## Flow\n\n```ts\nexport function run() {}\n```\n");
      throw new Error(`unexpected operation ${operation}`);
    });
    const result = await execute(def, { operation: "explore", query: "How does run work?", maxFiles: 4 }, context(root));
    assert.equal(result.details.phase, "done");
    assert.equal(result.details.autoSynced, true);
    assert.deepEqual(calls.map((call) => call.args[2]), ["status", "sync", "status", "explore"]);
    assert.deepEqual(calls.at(-1).args.slice(2), ["explore", "How does run work?", "--path", root, "--max-files", "4"]);
    assert.match(result.content[0].text, /export function run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status allowlists upstream fields before returning model content", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-status-"));
  createIndex(root);
  try {
    const def = definition(async () => commandResult(JSON.stringify({ ...status(), nodesByKind: { secretKind: 99 }, unexpected: "private" })));
    const value = await execute(def, { operation: "status" }, context(root));
    assert.equal(value.details.phase, "done");
    assert.doesNotMatch(value.content[0].text, /unexpected|private|nodesByKind|secretKind/);
    assert.equal(value.details.status.fileCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process failures expose a bounded sanitized message", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-error-"));
  createIndex(root);
  try {
    const def = definition(async () => commandResult("", {
      status: "non-zero",
      exitCode: 2,
      stderr: Buffer.from(`\x1b[31m${"e".repeat(5_000)}`),
    }));
    const value = await execute(def, { operation: "status" }, context(root));
    assert.equal(value.details.phase, "error");
    assert.ok(value.details.message.length <= 1_000);
    assert.doesNotMatch(value.details.message, /\x1b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unhealthy indexes return REINDEX_REQUIRED without querying", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-unhealthy-"));
  createIndex(root);
  const calls = [];
  try {
    const def = definition(async (_command, args) => {
      calls.push(args[2]);
      return commandResult(JSON.stringify(status({ index: { state: "partial", reindexRecommended: false, pendingRefs: 0 } })));
    });
    const result = await execute(def, { operation: "explore", query: "trace flow" }, context(root));
    assert.equal(result.details.code, "REINDEX_REQUIRED");
    assert.deepEqual(calls, ["status"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reindex is separately confirmed and uses the full index command", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-reindex-"));
  createIndex(root);
  let runs = 0;
  try {
    const declinedDef = definition(async () => { runs += 1; return commandResult(); });
    const declined = await execute(declinedDef, { operation: "reindex" }, context(root, { ui: { confirm: async () => false } }));
    assert.equal(declined.details.phase, "declined");
    assert.equal(runs, 0);

    const calls = [];
    const confirmedDef = definition(async (_command, args) => {
      calls.push(args[2]);
      return args[2] === "status"
        ? commandResult(JSON.stringify(status({ projectPath: root })))
        : commandResult("rebuilt\n");
    });
    const confirmed = await execute(confirmedDef, { operation: "reindex" }, context(root));
    assert.equal(confirmed.details.phase, "done");
    assert.deepEqual(calls, ["index", "status"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace realpath boundary rejects traversal and symlink escape", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-codegraph-path-"));
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, "escape"), "dir");
  try {
    assert.throws(() => resolveCodeGraphPath(workspace, ".."), (error) => error.code === "PATH_OUTSIDE_WORKSPACE");
    assert.throws(() => resolveCodeGraphPath(workspace, "escape"), (error) => error.code === "PATH_OUTSIDE_WORKSPACE");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("index discovery walks only from descendants up to the workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-root-"));
  const child = join(root, "packages", "app");
  mkdirSync(child, { recursive: true });
  createIndex(root);
  try {
    assert.equal(findCodeGraphRoot(child, root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explore output is Unicode-safe, sanitized, and visibly truncated", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-codegraph-cap-"));
  createIndex(root);
  try {
    const huge = `${"x".repeat(23_999)}😀\x1b[31msecret`;
    const def = definition(async (_command, args) => args[2] === "status"
      ? commandResult(JSON.stringify(status()))
      : commandResult(huge));
    const value = await execute(def, { operation: "explore", query: "large" }, context(root));
    assert.equal(value.details.outputChars, 24_000);
    assert.equal(value.details.outputTruncated, true);
    assert.match(value.content[0].text, /output truncated by pi-square/);
    assert.doesNotMatch(value.content[0].text, /\x1b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed) process.exit(1);
