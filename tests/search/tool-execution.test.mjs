import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

// ---------- rg JSON helpers (duplicated for isolation) ----------

function rgMatch(path, line, text, subs) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: subs.map(([s, e, m]) => ({ match: { text: m }, start: s, end: e })),
    },
  });
}

function rgSummary(n) {
  return JSON.stringify({
    type: "summary",
    data: { stats: { matches: n, matched_lines: n } },
  });
}

// ---------- mock runCommand factories ----------

function mockRunNoMatch() {
  return async (_cmd, _args, opts) => {
    const data = Buffer.from(rgSummary(0) + "\n");
    opts?.onChunk?.(data);
    return { status: "non-zero", exitCode: 1, stdout: data, stderr: Buffer.alloc(0), stderrTruncated: false };
  };
}

function mockRunInvalidRegex() {
  return async () => ({
    status: "non-zero",
    exitCode: 2,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("regex parse error:\n    (\n    ^\nerror: unclosed group\n"),
    stderrTruncated: false,
  });
}

function mockRunSpawnFail() {
  return async () => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  };
}

function mockRunTimeout() {
  return async () => ({ status: "timeout", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false });
}

function mockRunAbort() {
  return async (_cmd, _args, opts) => {
    if (opts?.signal?.aborted) {
      return { status: "aborted", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false };
    }
    return { status: "ok", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false };
  };
}

function mockRunStdoutCap() {
  return async () => ({ status: "stdout-cap", exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false });
}

function mockRunRgStop(nMatches) {
  return async (_cmd, _args, opts) => {
    let raw = "";
    for (let i = 1; i <= nMatches; i++) {
      raw += rgMatch("a.ts", i, `match${i}`, [[0, 6, `match${i}`]]) + "\n";
    }
    const data = Buffer.from(raw);
    let stopped = false;
    if (opts?.onChunk) {
      stopped = opts.onChunk(data);
    }
    return {
      status: stopped ? "stopped" : "ok",
      exitCode: stopped ? null : 0,
      stdout: data,
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
    };
  };
}

function mockRunFdPaths(paths) {
  return async (_cmd, _args, opts) => {
    const data = Buffer.from(paths.map((p) => p + "\0").join(""));
    opts?.onChunk?.(data);
    return { status: "ok", exitCode: 0, stdout: data, stderr: Buffer.alloc(0), stderrTruncated: false };
  };
}

const goodBinary = async () => "/fake/rg";
const goodBinaryFd = async () => "/fake/fd";

// ---------- rg execution tests ----------

test("rg no-match exit code 1 with control events is successful empty", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunNoMatch() });
  const result = await def.execute("id", { pattern: "foo", path: "." }, undefined);
  assert.equal(result.details.page.returned, 0);
  assert.ok(result.content[0].text.includes("No matches found"));
});

test("rg invalid regex rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunInvalidRegex() });
  await assert.rejects(def.execute("id", { pattern: "(", path: "." }, undefined));
});

test("rg spawn failure rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunSpawnFail() });
  await assert.rejects(def.execute("id", { pattern: "foo", path: "." }, undefined));
});

test("rg missing binary rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const missing = async () => {
    throw new Error("rg binary not found");
  };
  const def = createRgToolDefinition({ resolveBinary: missing, runCommand: mockRunNoMatch() });
  await assert.rejects(def.execute("id", { pattern: "foo", path: "." }, undefined));
});

test("rg unsupported target rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const unsupported = async () => {
    throw new Error("Unsupported platform/arch: solaris/x64");
  };
  const def = createRgToolDefinition({ resolveBinary: unsupported, runCommand: mockRunNoMatch() });
  await assert.rejects(def.execute("id", { pattern: "foo", path: "." }, undefined));
});

test("rg timeout rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunTimeout() });
  await assert.rejects(def.execute("id", { pattern: "foo", path: "." }, undefined));
});

test("rg abort rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunAbort() });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(def.execute("id", { pattern: "foo", path: "." }, controller.signal));
});

test("rg stdout cap rejects execution", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunStdoutCap() });
  await assert.rejects(def.execute("id", { pattern: "foo", path: "." }, undefined));
});

test("rg intentional stop returns successful page with hasMore", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand: mockRunRgStop(7) });
  const result = await def.execute("id", { pattern: "match", path: ".", limit: 5 }, undefined);
  assert.equal(result.details.page.returned, 5);
  assert.equal(result.details.page.hasMore, true);
  assert.equal(result.details.page.nextOffset, 5);
});

test("rg executes in extension cwd without retaining streamed stdout", async () => {
  const { createRgToolDefinition } = await loadModule("src/search/tools/rg.ts");
  let observedOptions;
  const runCommand = async (_command, _args, options) => {
    observedOptions = options;
    options.onChunk(Buffer.from(rgMatch("/workspace/src/a.ts", 1, "match", [[0, 5, "match"]]) + "\n" + rgSummary(1) + "\n"));
    return { status: "ok", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false };
  };
  const def = createRgToolDefinition({ resolveBinary: goodBinary, runCommand });
  const result = await def.execute("id", { pattern: "match", path: "." }, undefined, undefined, { cwd: "/workspace" });
  assert.equal(observedOptions.cwd, "/workspace");
  assert.equal(observedOptions.captureStdout, false);
  assert.equal(result.details.files[0].path, "src/a.ts");
  assert.deepEqual(result.details.presentation, {
    version: 1,
    executionCwd: "/workspace",
    platform: process.platform,
  });
});

// ---------- fd execution tests ----------

test("fd normal returns sorted paths", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: goodBinaryFd, runCommand: mockRunFdPaths(["c.ts", "a.ts", "b.ts"]) });
  const result = await def.execute("id", { path: "." }, undefined);
  assert.equal(result.details.page.returned, 3);
  assert.equal(result.details.page.total, 3);
  const paths = result.details.paths.map((p) => p.path);
  assert.deepEqual(paths, ["a.ts", "b.ts", "c.ts"]);
});

test("fd executes in extension cwd without retaining streamed stdout", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  let observedOptions;
  const runCommand = async (_command, _args, options) => {
    observedOptions = options;
    options.onChunk(Buffer.from("/workspace/src/a.ts\0"));
    return { status: "ok", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stderrTruncated: false };
  };
  const def = createFdToolDefinition({ resolveBinary: goodBinaryFd, runCommand });
  const result = await def.execute("id", { path: "." }, undefined, undefined, { cwd: "/workspace" });
  assert.equal(observedOptions.cwd, "/workspace");
  assert.equal(observedOptions.captureStdout, false);
  assert.equal(result.details.paths[0].path, "src/a.ts");
  assert.deepEqual(result.details.presentation, {
    version: 1,
    executionCwd: "/workspace",
    platform: process.platform,
  });
});

test("fd stdout cap rejects execution", async () => {
  const { createFdToolDefinition } = await loadModule("src/search/tools/fd.ts");
  const def = createFdToolDefinition({ resolveBinary: goodBinaryFd, runCommand: mockRunStdoutCap() });
  await assert.rejects(def.execute("id", { path: "." }, undefined));
});

await run();
