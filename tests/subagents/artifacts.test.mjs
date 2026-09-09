import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { createPromptSnapshot, run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const artifacts = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const {
  artifactsDirFor,
  createSubagentId,
  deleteParentSessionRun,
  ensureArtifactsDir,
  initializeSessionFile,
  isValidSubagentId,
  listParentSessionRuns,
  listRunDirs,
  readRunState,
  recordParentSessionRun,
  resolveChildSessionFile,
  tryReadRunState,
  validateRunArtifacts,
  writeRunState,
} = artifacts;
const {
  withTransientFsRetries,
  fsRetryCount,
  resolveDirectRegularSessionFile,
  validateRunArtifactsWithReadIo,
} = artifacts.__testables;

const ID = "subagent_00000000-0000-4000-8000-000000000001";
const SESSION_ID = "019f0000-0000-7000-8000-000000000001";

function makeTempRoot() {
  return join(tmpdir(), `pi-square-artifacts-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function details(root, overrides = {}) {
  const artifactsDir = join(root, "state", "subagents", ID);
  return {
    version: 4,
    id: ID,
    operation: "delegate",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: SESSION_ID,
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    task: "task",
    cwd: "/tmp/project",
    startedAt: 1,
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    ...overrides,
  };
}

function createValidArtifacts(root, overrides = {}) {
  process.env.PI_AGENT_DIR = root;
  const dir = ensureArtifactsDir(ID);
  const value = details(root, overrides);
  initializeSessionFile({
    id: ID,
    artifactsDir: dir,
    sessionFile: value.sessionFile,
    header: { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: value.cwd },
  });
  writeRunState(dir, value);
  return { dir, value };
}

test("new public IDs use the UUID namespace and old IDs are invalid", () => {
  assert.equal(isValidSubagentId(createSubagentId()), true);
  assert.equal(isValidSubagentId(ID), true);
  assert.equal(isValidSubagentId("subagent_1717945200000_001"), false);
});

test("artifactsDirFor returns <agentDir>/state/subagents/<id>", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  assert.equal(artifactsDirFor(ID), resolve(root, "state", "subagents", ID));
});

test("writeRunState and readRunState round trip version 4 details", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  try {
    const dir = ensureArtifactsDir(ID);
    const original = details(root, { finalText: "hello" });
    writeRunState(dir, original);
    assert.deepEqual(readRunState(dir), original);
    assert.equal(existsSync(join(dir, "run.json.tmp")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old run-state versions are rejected", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  try {
    const dir = ensureArtifactsDir(ID);
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...details(root), version: 1 }), "utf8");
    assert.throws(() => readRunState(dir), /unsupported format version/);
    assert.equal(tryReadRunState(dir), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent-session index lists only owned V4 runs and supports confirmed deletion", () => {
  const root = makeTempRoot();
  try {
    const { dir } = createValidArtifacts(root);
    recordParentSessionRun("parent-session", ID);
    assert.deepEqual(listParentSessionRuns("different-parent"), []);
    assert.deepEqual(listParentSessionRuns("parent-session").map((item) => item.id), [ID]);
    assert.throws(() => deleteParentSessionRun("different-parent", ID), /SUBAGENT_NOT_FOUND/);
    deleteParentSessionRun("parent-session", ID);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(listParentSessionRuns("parent-session"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initializeSessionFile creates a native header and rejects a conflicting one", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  try {
    const dir = ensureArtifactsDir(ID);
    const file = join(dir, "session.jsonl");
    const header = { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: root };
    initializeSessionFile({ id: ID, artifactsDir: dir, sessionFile: file, header });
    const first = readFileSync(file, "utf8");
    assert.throws(
      () => initializeSessionFile({ id: ID, artifactsDir: dir, sessionFile: file, header: { ...header, id: "other" } }),
      /PERSISTENCE_FAILED/,
    );
    assert.equal(readFileSync(file, "utf8"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateRunArtifacts accepts a header-only native session", () => {
  const root = makeTempRoot();
  try {
    const { dir } = createValidArtifacts(root);
    const validated = validateRunArtifacts(ID);
    assert.equal(validated.artifactsDir, resolve(dir));
    assert.equal(validated.details.id, ID);
    assert.equal(validated.sessionEntries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateRunArtifacts rejects malformed JSONL without modifying it", () => {
  const root = makeTempRoot();
  try {
    const { value } = createValidArtifacts(root);
    const damaged = `${readFileSync(value.sessionFile, "utf8")}{ broken\n`;
    writeFileSync(value.sessionFile, damaged, "utf8");
    assert.throws(() => validateRunArtifacts(ID), /SESSION_HISTORY_UNAVAILABLE/);
    assert.equal(readFileSync(value.sessionFile, "utf8"), damaged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem retry accounting reports actual additional attempts", () => {
  let attempts = 0;
  const value = withTransientFsRetries(() => {
    attempts += 1;
    if (attempts <= 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(attempts, 4);

  let permanent;
  try {
    withTransientFsRetries(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  } catch (error) {
    permanent = error;
  }
  assert.equal(fsRetryCount(permanent), 0);
});

test("resolveChildSessionFile rejects a symlinked session file, even inside the artifacts directory", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  try {
    // A regular file resolves normally.
    const { dir } = createValidArtifacts(root);
    assert.equal(resolveChildSessionFile(ID).sessionFile, join(dir, "session.jsonl"));

    // A symlink pointing to a file inside the same artifacts directory is a
    // rewritten artifact: the boundary rejects it rather than resolving it.
    const inner = join(dir, "inner-target.jsonl");
    writeFileSync(inner, readFileSync(join(dir, "session.jsonl")));
    rmSync(join(dir, "session.jsonl"));
    symlinkSync(inner, join(dir, "session.jsonl"));
    assert.throws(() => resolveChildSessionFile(ID), /missing or invalid/);

    // A symlink pointing outside the directory is rejected the same way.
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, readFileSync(inner));
    rmSync(join(dir, "session.jsonl"));
    symlinkSync(outside, join(dir, "session.jsonl"));
    assert.throws(() => resolveChildSessionFile(ID), /missing or invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveChildSessionFile rejects non-regular session paths", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  try {
    const { dir } = createValidArtifacts(root);
    const sessionFile = join(dir, "session.jsonl");
    rmSync(sessionFile);
    mkdirSync(sessionFile);
    assert.throws(() => resolveChildSessionFile(ID), /missing or invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session path resolution rejects a file replaced during canonicalization", () => {
  const path = "/artifacts/session.jsonl";
  let observations = 0;
  const regular = { dev: 1, ino: 2, isFile: () => true };
  const replacement = { dev: 1, ino: 3, isFile: () => false };
  assert.throws(
    () => resolveDirectRegularSessionFile(path, "/artifacts", {
      lstat(candidate) {
        assert.equal(candidate, path);
        observations += 1;
        return observations === 1 ? regular : replacement;
      },
      realpath(candidate) {
        assert.equal(candidate, path);
        return "/artifacts/target.jsonl";
      },
    }),
    /changed while resolving/,
  );
  assert.equal(observations, 2);
});

test("session path resolution rejects mutable intermediate path components", () => {
  assert.throws(
    () => resolveDirectRegularSessionFile("/artifacts/link/session.jsonl", "/artifacts", {
      lstat: () => ({ dev: 1, ino: 2, isFile: () => true }),
      realpath: () => "/artifacts/target/session.jsonl",
    }),
    /not directly inside/,
  );
});

test("resume validation never reads a session path replaced after open", () => {
  const root = makeTempRoot();
  try {
    const { value } = createValidArtifacts(root);
    const stable = { dev: 1, ino: 2, isFile: () => true };
    const replacement = { dev: 1, ino: 3, isFile: () => true };
    let observations = 0;
    let read = false;
    let closed = false;
    assert.throws(
      () => validateRunArtifactsWithReadIo(ID, {
        lstat(candidate) {
          assert.equal(candidate, value.sessionFile);
          observations += 1;
          return observations === 1 ? stable : replacement;
        },
        open(candidate) {
          assert.equal(candidate, value.sessionFile);
          return 7;
        },
        fstat(descriptor) {
          assert.equal(descriptor, 7);
          return stable;
        },
        readFile() {
          read = true;
          return "replacement content";
        },
        close(descriptor) {
          assert.equal(descriptor, 7);
          closed = true;
        },
      }),
      /SESSION_HISTORY_UNAVAILABLE/,
    );
    assert.equal(read, false, "the replacement target is never read");
    assert.equal(closed, true, "the opened descriptor is still closed on rejection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listRunDirs ignores old-ID directories and sorts valid directories by mtime", () => {
  const root = makeTempRoot();
  process.env.PI_AGENT_DIR = root;
  const newerId = "subagent_00000000-0000-4000-8000-000000000002";
  try {
    const older = ensureArtifactsDir(ID);
    const newer = ensureArtifactsDir(newerId);
    mkdirSync(join(root, "state", "subagents", "subagent_1717945200000_001"), { recursive: true });
    const now = Date.now() / 1000;
    utimesSync(older, now - 100, now - 100);
    utimesSync(newer, now, now);
    assert.deepEqual(listRunDirs(), [newer, older]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await run();
