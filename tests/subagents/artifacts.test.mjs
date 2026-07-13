import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const artifacts = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const {
  artifactsDirFor,
  createSubagentId,
  ensureArtifactsDir,
  initializeSessionFile,
  isValidSubagentId,
  listRunDirs,
  readRunState,
  tryReadRunState,
  validateRunArtifacts,
  writeRunState,
} = artifacts;
const { withTransientFsRetries, fsRetryCount } = artifacts.__testables;

const ID = "subagent_00000000-0000-4000-8000-000000000001";
const SESSION_ID = "019f0000-0000-7000-8000-000000000001";

function makeTempRoot() {
  return join(tmpdir(), `pi-square-artifacts-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function details(root, overrides = {}) {
  const artifactsDir = join(root, "state", "subagents", ID);
  return {
    version: 2,
    id: ID,
    mode: "fg",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: SESSION_ID,
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

test("writeRunState and readRunState round trip version 2 details", () => {
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
