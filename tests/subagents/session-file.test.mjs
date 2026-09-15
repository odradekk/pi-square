import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { createPromptSnapshot, run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const artifacts = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const sessionFileModule = await load(join(packageRoot, "src", "subagents", "session-file.ts"));

const { ensureArtifactsDir, initializeSessionFile, writeRunState } = artifacts;
const { NODE_SESSION_FILE_IO, SessionFileRefusal, openChildSessionFile } = sessionFileModule;

const ID = "subagent_00000000-0000-4000-8000-000000000001";
const SESSION_ID = "019f0000-0000-7000-8000-000000000001";

function makeTempRoot() {
  return join(tmpdir(), `pi-square-session-file-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function createValidArtifacts(root) {
  process.env.PI_AGENT_DIR = root;
  const artifactsDir = ensureArtifactsDir(ID);
  const file = join(artifactsDir, "session.jsonl");
  initializeSessionFile({
    id: ID,
    artifactsDir,
    sessionFile: file,
    header: { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd: "/tmp/project" },
  });
  writeRunState(artifactsDir, {
    version: 4,
    id: ID,
    operation: "delegate",
    artifactsDir,
    sessionFile: file,
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
  });
  return { artifactsDir, file };
}

test("openChildSessionFile resolves the run record and serves identity-verified reads", () => {
  const root = makeTempRoot();
  try {
    const { artifactsDir, file } = createValidArtifacts(root);
    const opened = openChildSessionFile(ID, "view");
    assert.equal(opened.artifactsDir, resolve(artifactsDir));
    assert.equal(opened.details.id, ID);
    assert.equal(opened.handle.path, file);

    const text = opened.handle.readText();
    assert.ok(text.includes('"type":"session"'), "the whole native session file is readable");
    const range = opened.handle.readRange(0, 5);
    assert.equal(range.data.toString("utf8"), text.slice(0, 5), "positioned reads serve the same bytes");
    assert.equal(range.stat.size, Buffer.byteLength(text), "the read reports the opened descriptor's own size");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session-file boundary refuses a symlinked session file, even inside the artifacts directory", () => {
  const root = makeTempRoot();
  try {
    const { artifactsDir, file } = createValidArtifacts(root);

    // A symlink pointing to a file inside the same artifacts directory is a
    // rewritten artifact: the boundary rejects it rather than resolving it.
    const inner = join(artifactsDir, "inner-target.jsonl");
    writeFileSync(inner, readFileSync(file));
    rmSync(file);
    symlinkSync(inner, file);
    assert.throws(
      () => openChildSessionFile(ID),
      (error) => error?.info?.code === "SESSION_HISTORY_UNAVAILABLE" && /missing or invalid/.test(String(error?.message ?? "")),
    );

    // A symlink pointing outside the directory is rejected the same way.
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, readFileSync(inner));
    rmSync(file);
    symlinkSync(outside, file);
    assert.throws(
      () => openChildSessionFile(ID),
      (error) => error?.info?.code === "SESSION_HISTORY_UNAVAILABLE" && /missing or invalid/.test(String(error?.message ?? "")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session-file boundary refuses a non-regular session file", () => {
  const root = makeTempRoot();
  try {
    const { file } = createValidArtifacts(root);
    rmSync(file);
    mkdirSync(file);
    assert.throws(
      () => openChildSessionFile(ID),
      (error) => error?.info?.code === "SESSION_HISTORY_UNAVAILABLE" && /missing or invalid/.test(String(error?.message ?? "")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the identity protocol refuses a path replaced between the pre-open and post-open observations", () => {
  const root = makeTempRoot();
  try {
    const { file } = createValidArtifacts(root);
    const stable = { dev: 1, ino: 2, size: 3, isFile: () => true };
    const replacement = { dev: 1, ino: 3, size: 3, isFile: () => true };
    let observations = 0;
    let read = false;
    let closed = false;
    const io = {
      lstat(candidate) {
        assert.equal(candidate, file);
        observations += 1;
        return observations === 1 ? stable : replacement;
      },
      open(candidate) {
        assert.equal(candidate, file);
        return 7;
      },
      fstat(descriptor) {
        assert.equal(descriptor, 7);
        return stable;
      },
      read() {
        read = true;
        return 0;
      },
      close(descriptor) {
        assert.equal(descriptor, 7);
        closed = true;
      },
    };
    const opened = openChildSessionFile(ID, "resume", io);
    assert.throws(
      () => opened.handle.readText(),
      (error) => error instanceof SessionFileRefusal && error.code === "IDENTITY_CHANGED",
    );
    assert.equal(read, false, "the replacement target is never read");
    assert.equal(closed, true, "the opened descriptor is still closed on refusal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the identity protocol refuses a non-regular file it observes itself", () => {
  const root = makeTempRoot();
  try {
    createValidArtifacts(root);
    const io = {
      ...NODE_SESSION_FILE_IO,
      lstat: () => ({ dev: 1, ino: 2, size: 0, isFile: () => false }),
    };
    const opened = openChildSessionFile(ID, "view", io);
    assert.throws(
      () => opened.handle.readText(),
      (error) => error instanceof SessionFileRefusal && error.code === "NOT_A_REGULAR_FILE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("the identity protocol refuses a symlink raced in before the open", () => {
  const root = makeTempRoot();
  try {
    createValidArtifacts(root);
    let attemptedOpen = false;
    let read = false;
    const io = {
      ...NODE_SESSION_FILE_IO,
      open(candidate) {
        attemptedOpen = true;
        throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
      },
      read() {
        read = true;
        return 0;
      },
    };
    const opened = openChildSessionFile(ID, "view", io);
    assert.throws(
      () => opened.handle.readText(),
      (error) => error?.code === "ELOOP",
    );
    assert.equal(attemptedOpen, true, "the open was attempted with O_NOFOLLOW");
    assert.equal(read, false, "no byte is read from a refused open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await run();
