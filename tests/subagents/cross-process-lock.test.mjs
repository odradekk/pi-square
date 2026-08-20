import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { initHasher, _lineHashesPure } = await load("../../src/anchored-edit/hashline/index.ts");
const { acquireFileLock, lockFilePath } = await load("../../src/anchored-edit/file-lock.ts");
const { resolveTarget } = await load("../../src/anchored-edit/fs-write.ts");
const { createAnchoredReplaceToolDefinition } = await load("../../src/anchored-edit/workspace-replace.ts");
const { createAnchoredRevertToolDefinition } = await load("../../src/anchored-edit/workspace-revert.ts");
const { loadProjectHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { getUndoRecord, saveUndo } = await load("../../src/anchored-edit/replace-undo.ts");

const helperPath = join(dirname(fileURLToPath(import.meta.url)), "cross-process-lock-helper.mjs");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const root = mkdtempSync(join(tmpdir(), "pi-square-write-lock-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

await initHasher();

function hashesOf(content) {
  return _lineHashesPure(content);
}

function lockDir() {
  return join(workspace, ".pi", "anchored-edit", "locks");
}

async function canonicalLockPath(file) {
  const target = await resolveTarget(join(workspace, file));
  return lockFilePath(workspace, target);
}

function lockDirFiles() {
  try {
    return readdirSync(lockDir());
  } catch {
    return [];
  }
}

function textOf(content) {
  return (content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function readRows(content) {
  return textOf(content).split("\n").flatMap((line) => {
    const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
    return match ? [{ hash: match[1], text: match[2] }] : [];
  });
}

let jobCounter = 0;
const children = [];

function spawnJob(job) {
  const jobPath = join(root, `job-${jobCounter++}.json`);
  const resultPath = join(root, `result-${jobCounter++}.json`);
  writeFileSync(jobPath, JSON.stringify({ ...job, resultPath }));
  const child = spawn(process.execPath, [helperPath, jobPath], {
    env: { ...process.env, PI_SQUARE_LOCK_WAIT_MS: "400" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return { child, resultPath };
}

async function waitResult(resultPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      return JSON.parse(readFileSync(resultPath, "utf8"));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for helper result: ${resultPath}`);
}

function kill(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    child.once("exit", resolvePromise);
    child.kill("SIGKILL");
  });
}

async function holdLock(file) {
  const job = spawnJob({ mode: "hold", workspace, path: file });
  const result = await waitResult(job.resultPath);
  assert.equal(result.locked, true, `holder acquired the lock on ${file}`);
  return job;
}

try {
  // --- Criterion 1/9: acquire, hold, release; the artefact is observable and
  // is cleaned up on release. Verified directly (in-process) and confirmed
  // cross-process below via real child processes. ---
  const aPath = await canonicalLockPath("unit.txt");
  const lockA = await acquireFileLock(aPath);
  assert.ok(lockA, "the lock is acquired");
  assert.ok(existsSync(aPath), "the lock file exists while held");
  const holderInfo = JSON.parse(readFileSync(aPath, "utf8"));
  assert.equal(typeof holderInfo.pid, "number", "the lock records its owning pid");
  assert.equal(typeof holderInfo.acquiredAt, "number", "the lock records its acquire time");
  await lockA.release();
  assert.ok(!existsSync(aPath), "the lock file is removed on release");

  // --- Criterion 4/9: different files are not serialised against each other;
  // two separate OS processes hold different per-file locks simultaneously. ---
  writeFileSync(join(workspace, "d1.txt"), "one\n");
  writeFileSync(join(workspace, "d2.txt"), "two\n");
  const h1 = await holdLock("d1.txt");
  const h2Job = spawnJob({ mode: "hold", workspace, path: "d2.txt" });
  const h2Result = await waitResult(h2Job.resultPath);
  assert.equal(h2Result.locked, true, "a second file acquires its own lock while the first is held");
  await kill(h1.child);
  await kill(h2Job.child);

  // --- Criterion 6/9: a lock whose owning process no longer exists is
  // reclaimed rather than blocking indefinitely. ---
  const stalePath = await canonicalLockPath("stale-inproc.txt");
  writeFileSync(stalePath, JSON.stringify({ pid: 2_147_483_647, hostname: "x", acquiredAt: Date.now() - 1000 }));
  const reclaimInProc = await acquireFileLock(stalePath, { waitMs: 200 });
  assert.ok(reclaimInProc, "a lock owned by a dead pid is reclaimed");
  await reclaimInProc.release();

  // --- Criterion 8/9: a lock held by a live process is waited on, not
  // reclaimed; the bounded wait ends in a refusal, not an indefinite block. ---
  const livePath = await canonicalLockPath("live.txt");
  const live = await acquireFileLock(livePath);
  assert.ok(live);
  const again = await acquireFileLock(livePath, { waitMs: 60 });
  assert.equal(again, null, "a live lock is not reclaimed, only waited on");
  await live.release();

  // --- Criterion 5/9: the lock is observable by a separate operating-system
  // process. A real child holds the lock and a probe from another real process
  // (and the parent) sees the artefact. ---
  writeFileSync(join(workspace, "observed.txt"), "one\n");
  const observer = await holdLock("observed.txt");
  const probeJob = spawnJob({ mode: "probe", workspace, path: "observed.txt" });
  const probe = await waitResult(probeJob.resultPath);
  assert.equal(probe.exists, true, "a separate process observes the held lock");
  assert.ok(probe.content.includes(`"pid":${observer.child.pid}`), "the observed lock names the holding process");
  await kill(observer.child);

  // --- Criterion 2/3/9: two processes editing the same file produce one
  // success and one recoverable refusal, never a lost update. The refusal
  // after the bounded wait uses E_RANGE_STALE and carries fresh anchors. ---
  writeFileSync(join(workspace, "same.txt"), "alpha\nbeta\ngamma\n");
  const holder = await holdLock("same.txt");
  const middle = hashesOf("alpha\nbeta\ngamma\n")[1];
  const contender = spawnJob({
    mode: "replace",
    workspace,
    path: "same.txt",
    removeFrom: middle,
    removeTo: middle,
    replacement: "BETA",
  });
  const refusal = await waitResult(contender.resultPath);
  assert.match(textOf(refusal.content), /\[E_RANGE_STALE\]/, "the refusal uses the recoverable stale-range code");
  assert.match(textOf(refusal.content), /Another editor holds the write lock/, "the refusal explains the lock contention");
  const freshRows = readRows(refusal.content);
  assert.ok(freshRows.length > 0, "the refusal carries fresh anchors");
  assert.deepEqual(freshRows.map((row) => row.text), ["beta"], "the fresh anchors are the current range");
  assert.equal(
    readFileSync(join(workspace, "same.txt"), "utf8"),
    "alpha\nbeta\ngamma\n",
    "a refused process never overwrites the holder's work (no lost update)",
  );
  await kill(holder.child);

  // --- Criterion 6/9: a real process that dies without releasing is reclaimed
  // by the next process, which then writes successfully and releases. ---
  writeFileSync(join(workspace, "stale.txt"), "alpha\nbeta\ngamma\n");
  const crashed = await holdLock("stale.txt");
  await kill(crashed.child); // simulate a crash: no release() ran
  assert.ok(existsSync(await canonicalLockPath("stale.txt")), "the crashed holder leaves its lock behind");
  const reclaimJob = spawnJob({
    mode: "replace",
    workspace,
    path: "stale.txt",
    removeFrom: middle,
    removeTo: middle,
    replacement: "BETA",
  });
  await waitResult(reclaimJob.resultPath);
  assert.equal(
    readFileSync(join(workspace, "stale.txt"), "utf8"),
    "alpha\nBETA\ngamma\n",
    "the reclaiming process proceeds and writes",
  );
  assert.ok(!existsSync(await canonicalLockPath("stale.txt")), "the lock is released after the successful replace");

  // --- Criterion 7/9: revert takes the same lock. While a real process holds
  // the lock, a revert is refused with E_FILE_LOCKED and leaves state intact;
  // once the lock is free, the same revert succeeds. ---
  writeFileSync(join(workspace, "revert.txt"), "alpha\nBETA\ngamma\n");
  const store = await loadProjectHashStore(workspace, PARENT_OWNER);
  const undo = await saveUndo(
    join(workspace, "revert.txt"),
    { content: "alpha\nbeta\ngamma\n", bom: "", originalEnding: "\n", hashes: [], resultContent: "alpha\nBETA\ngamma\n" },
    store,
  );
  store.release();
  assert.equal(undo.persisted, true, "the undo record persists");

  const revertHolder = await holdLock("revert.txt");
  const reverter = spawnJob({ mode: "revert", workspace, path: "revert.txt" });
  const lockedRevert = await waitResult(reverter.resultPath);
  assert.match(textOf(lockedRevert.content), /\[E_FILE_LOCKED\]/, "revert is refused while the lock is held");
  const store2 = await loadProjectHashStore(workspace, PARENT_OWNER);
  const intact = await getUndoRecord(join(workspace, "revert.txt"), store2);
  assert.ok(intact, "a refused revert leaves the undo record intact");
  store2.release();
  await kill(revertHolder.child);

  const reverter2 = spawnJob({ mode: "revert", workspace, path: "revert.txt" });
  await waitResult(reverter2.resultPath);
  assert.equal(
    readFileSync(join(workspace, "revert.txt"), "utf8"),
    "alpha\nbeta\ngamma\n",
    "the revert succeeds once the lock is free and restores the file",
  );

  // --- Criterion 7/9: the child anchored write takes the same lock. While a
  // real process holds it, a writable subagent's write is refused with
  // E_FILE_LOCKED and leaves the file untouched; once the lock is free the
  // write applies. ---
  writeFileSync(join(workspace, "childwrite.txt"), "before\n");
  const writeHolder = await holdLock("childwrite.txt");
  const lockedWrite = spawnJob({
    mode: "write",
    workspace,
    path: "childwrite.txt",
    content: "after\n",
    owner: "subagent_write",
  });
  const lockedWriteResult = await waitResult(lockedWrite.resultPath);
  assert.equal(lockedWriteResult.ok, false, "the child write is refused while the lock is held");
  assert.match(lockedWriteResult.error, /\[E_FILE_LOCKED\]/, "the child write refusal names the lock code");
  assert.equal(
    readFileSync(join(workspace, "childwrite.txt"), "utf8"),
    "before\n",
    "a refused child write never touches the file",
  );
  await kill(writeHolder.child);
  const freeWrite = spawnJob({
    mode: "write",
    workspace,
    path: "childwrite.txt",
    content: "after\n",
    owner: "subagent_write",
  });
  const freeWriteResult = await waitResult(freeWrite.resultPath);
  assert.equal(freeWriteResult.ok, true, "the child write applies once the lock is free");
  assert.equal(
    readFileSync(join(workspace, "childwrite.txt"), "utf8"),
    "after\n",
    "the successful child write lands",
  );

  // --- Criterion 8/9: the lock coexists with Pi's per-session mutation queue.
  // Two replaces on the same file in one process complete (no deadlock) and
  // both edits land (no lost update); the queue and the lock serialize. Clear
  // any stale locks left by the killed holders first so the cleanliness
  // assertion below checks only the concurrent replaces. ---
  rmSync(lockDir(), { recursive: true, force: true });
  writeFileSync(join(workspace, "coexist.txt"), "l1\nl2\nl3\nl4\n");
  const coexHashes = hashesOf("l1\nl2\nl3\nl4\n");
  const replace = createAnchoredReplaceToolDefinition(workspace);
  const ctx = { cwd: workspace };
  const [r1, r2] = await Promise.all([
    replace.execute(
      "replace",
      { path: "coexist.txt", remove_from: coexHashes[0], remove_to: coexHashes[0], replacement_text: "X1" },
      undefined,
      undefined,
      ctx,
    ),
    replace.execute(
      "replace",
      { path: "coexist.txt", remove_from: coexHashes[3], remove_to: coexHashes[3], replacement_text: "X4" },
      undefined,
      undefined,
      ctx,
    ),
  ]);
  assert.ok(r1 && r2, "concurrent same-file replaces complete without deadlock");
  const coexContent = readFileSync(join(workspace, "coexist.txt"), "utf8");
  const x1Land = coexContent.includes("X1") && !coexContent.includes("X4");
  const x4Land = coexContent.includes("X4") && !coexContent.includes("X1");
  assert.ok(x1Land || x4Land, "exactly one of the two concurrent edits landed (well-defined, no lost update)");
  const r1Text = textOf(r1.content);
  const r2Text = textOf(r2.content);
  assert.ok(
    /Successfully replaced/.test(r1Text) !== /Successfully replaced/.test(r2Text),
    "exactly one concurrent edit was applied",
  );
  assert.ok(
    /\[E_RANGE_STALE\]/.test(r1Text) !== /\[E_RANGE_STALE\]/.test(r2Text),
    "the other concurrent edit was refused recoverably against the updated served state",
  );
  assert.ok(!lockDirFiles().length, "no lock artefacts remain after the concurrent replaces");

  // --- Criterion 9/9: lock artefacts are excluded from version control. ---
  const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /anchored-edit\/locks\//, ".gitignore excludes the lock artefacts");

  console.log("cross-process write lock tests: OK");
} finally {
  await Promise.all(children.map((child) => kill(child).catch(() => {})));
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
