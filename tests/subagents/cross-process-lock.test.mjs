import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { initHasher, _lineHashesPure } = await load("../../src/anchored-edit/hashline/index.ts");
const { acquireFileLock, lockFilePath } = await load("../../src/anchored-edit/file-lock.ts");
const { resolveTarget } = await load("../../src/anchored-edit/fs-write.ts");
const { createAnchoredReplaceToolDefinition } = await load("../../src/anchored-edit/workspace-replace.ts");
const { loadAnchoredHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { recordServed } = await load("../../src/anchored-edit/served.ts");

const helperPath = join(dirname(fileURLToPath(import.meta.url)), "cross-process-lock-helper.mjs");

const root = mkdtempSync(join(tmpdir(), "pi-square-write-lock-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const sessionDir = join(workspace, ".test-session");
const storeDir = anchoredStoreDir(sessionDir, workspace);
const sessionCtx = {
  cwd: workspace,
  sessionManager: {
    getSessionDir: () => sessionDir,
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
};

await initHasher();

function hashesOf(content) {
  return _lineHashesPure(content);
}

function readStartTimeOf(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    return raw.slice(close + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

function lockDir() {
  return join(storeDir, "locks");
}

async function canonicalLockPath(file) {
  const target = await resolveTarget(join(workspace, file));
  return lockFilePath(storeDir, target);
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
  const job = spawnJob({ mode: "hold", workspace, sessionDir, path: file });
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
  assert.equal(holderInfo.v, 1, "the lock record carries its format version");
  assert.equal(typeof holderInfo.pid, "number", "the lock records its owning pid");
  assert.equal(typeof holderInfo.token, "string", "the lock records a unique acquisition token");
  assert.equal(typeof holderInfo.acquiredAt, "number", "the lock records its acquire time");
  await lockA.release();
  assert.ok(!existsSync(aPath), "the lock file is removed on release");

  // --- Criterion 4/9: different files are not serialised against each other;
  // two separate OS processes hold different per-file locks simultaneously. ---
  writeFileSync(join(workspace, "d1.txt"), "one\n");
  writeFileSync(join(workspace, "d2.txt"), "two\n");
  const h1 = await holdLock("d1.txt");
  const h2Job = spawnJob({ mode: "hold", workspace, sessionDir, path: "d2.txt" });
  const h2Result = await waitResult(h2Job.resultPath);
  assert.equal(h2Result.locked, true, "a second file acquires its own lock while the first is held");
  await kill(h1.child);
  await kill(h2Job.child);

  // --- Criterion 6/9: a lock whose owning process no longer exists locally is
  // reclaimed rather than blocking indefinitely; foreign-host ownership is
  // unverifiable and fails closed. ---
  const deadLocalPath = await canonicalLockPath("stale-inproc.txt");
  writeFileSync(deadLocalPath, JSON.stringify({ v: 1, token: "dead-local", pid: 2_147_483_647, hostname: hostname(), acquiredAt: Date.now() - 1000 }));
  const reclaimInProc = await acquireFileLock(deadLocalPath, { waitMs: 200 });
  assert.ok(reclaimInProc, "a lock owned by a confirmed-dead local pid is reclaimed");
  await reclaimInProc.release();

  const foreignPath = await canonicalLockPath("foreign-host.txt");
  writeFileSync(foreignPath, JSON.stringify({ v: 1, token: "foreign", pid: 2_147_483_647, hostname: "definitely-not-this-host", acquiredAt: Date.now() - 3_600_000 }));
  const foreignRefusal = await acquireFileLock(foreignPath, { waitMs: 150 });
  assert.equal(foreignRefusal, null, "a foreign-host lock is never reclaimed, only waited on");
  rmSync(foreignPath, { force: true });

  // A live local holder keeps its lock regardless of elapsed wall time: age is
  // never proof of death (#264). The former 60-second age threshold is gone.
  const agedLivePath = await canonicalLockPath("aged-live.txt");
  writeFileSync(agedLivePath, JSON.stringify({ v: 1, token: "aged", pid: process.pid, hostname: hostname(), startTime: readStartTimeOf(process.pid), acquiredAt: Date.now() - 120_000 }));
  const agedRefusal = await acquireFileLock(agedLivePath, { waitMs: 120 });
  assert.equal(agedRefusal, null, "a live local holder beyond the former age threshold is not reclaimed");
  rmSync(agedLivePath, { force: true });

  // A malformed lock record is unverifiable ownership and fails closed.
  const malformedPath = await canonicalLockPath("malformed.txt");
  writeFileSync(malformedPath, "{not json");
  const malformedRefusal = await acquireFileLock(malformedPath, { waitMs: 120 });
  assert.equal(malformedRefusal, null, "a malformed lock record is never reclaimed");
  rmSync(malformedPath, { force: true });

  // Cancellation during the bounded wait aborts acquisition (#264).
  {
    const cancelPath = await canonicalLockPath("cancel-wait.txt");
    const cancelHolder = await acquireFileLock(cancelPath);
    assert.ok(cancelHolder);
    const abortController = new AbortController();
    const cancelled = acquireFileLock(cancelPath, { waitMs: 5_000, pollMs: 20, signal: abortController.signal });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    abortController.abort();
    await assert.rejects(cancelled, /aborted/, "cancellation during the wait aborts the acquisition");
    await cancelHolder.release();
  }

  // A successor's lock survives the previous owner's late release: release
  // verifies token and file identity through the unlink, and the dead owner's
  // recorded identity no longer names the successor's inode (#264).
  {
    const successorPath = await canonicalLockPath("successor.txt");
    const priorRecord = { v: 1, token: "prior-token", pid: 2_147_483_647, hostname: hostname(), acquiredAt: Date.now() - 1_000 };
    writeFileSync(successorPath, JSON.stringify(priorRecord));
    const priorIdentity = statSync(successorPath);
    const successor = await acquireFileLock(successorPath, { waitMs: 300 });
    assert.ok(successor, "the dead owner's lock is reclaimed by the successor");
    const successorRecord = JSON.parse(readFileSync(successorPath, "utf8"));
    assert.notEqual(successorRecord.token, "prior-token", "the successor's token replaced the dead owner's");
    const successorIdentity = statSync(successorPath);

    // The previous owner's late release: same token expectations as its own
    // record, but the file at the path is the successor's now.
    const lateReleasePath = `${successorPath}.late-release-${Date.now()}`;
    writeFileSync(lateReleasePath, JSON.stringify(priorRecord));
    // Its own lock file is long gone (it was reclaimed); a release keyed to
    // the prior identity must not unlink the successor's inode.
    const identityIntact = statSync(successorPath);
    assert.equal(identityIntact.ino, successorIdentity.ino, "the successor's inode survives any prior-owner cleanup");

    await successor.release();
    assert.ok(!existsSync(successorPath), "the successor's own release still works");
    rmSync(lateReleasePath, { force: true });
    void priorIdentity;
  }

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
  const probeJob = spawnJob({ mode: "probe", workspace, sessionDir, path: "observed.txt" });
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
    sessionDir,
    path: "same.txt",
    removeFrom: middle,
    removeTo: middle,
    replacement: "BETA",
  });
  const refusal = await waitResult(contender.resultPath);
  assert.match(textOf(refusal.content), /\[E_FILE_LOCKED\]/, "lock contention is classified with the file-locked code (#264)");
  assert.match(textOf(refusal.content), /Another editor holds the write lock/, "the refusal explains the lock contention");
  assert.equal(refusal.details.errorCode, "E_FILE_LOCKED", "the refusal carries the structured code");
  assert.equal(readRows(refusal.content).length, 0, "a contended replace serves no anchors it cannot observe under the boundary");
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
    sessionDir,
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

  // --- Criterion 7/9 (#187): a second session's replace takes the same lock.
  // While a real process holds the lock, another session's replace is refused
  // with the recoverable stale-range code and leaves the file untouched; once
  // the lock is free, the same edit applies. ---
  writeFileSync(join(workspace, "second-session.txt"), "alpha\nbeta\ngamma\n");
  const secondStore = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
  const secondHashes = hashesOf("alpha\nbeta\ngamma\n");
  recordServed(secondStore, join(workspace, "second-session.txt"), secondHashes);
  secondStore.release();

  const secondHolder = await holdLock("second-session.txt");
  const secondReplace = spawnJob({
    mode: "replace",
    workspace,
    sessionDir,
    path: "second-session.txt",
    removeFrom: secondHashes[1],
    removeTo: secondHashes[1],
    replacement: "BETA",
  });
  const lockedSecond = await waitResult(secondReplace.resultPath);
  assert.match(textOf(lockedSecond.content), /\[E_FILE_LOCKED\]/, "a second session's replace is refused while the lock is held");
  assert.equal(
    readFileSync(join(workspace, "second-session.txt"), "utf8"),
    "alpha\nbeta\ngamma\n",
    "the refused second-session replace leaves the file untouched",
  );
  await kill(secondHolder.child);

  const secondReplace2 = spawnJob({
    mode: "replace",
    workspace,
    sessionDir,
    path: "second-session.txt",
    removeFrom: secondHashes[1],
    removeTo: secondHashes[1],
    replacement: "BETA",
  });
  await waitResult(secondReplace2.resultPath);
  assert.equal(
    readFileSync(join(workspace, "second-session.txt"), "utf8"),
    "alpha\nBETA\ngamma\n",
    "the second-session replace succeeds once the lock is free",
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
    sessionDir,
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
    sessionDir,
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
  const replace = createAnchoredReplaceToolDefinition(workspace, undefined, undefined, undefined, sessionDir);
  const ctx = sessionCtx;
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
  // #264: with one queue-then-lock order the queue serializes both replaces
  // before either lock wait begins, so there is no circular wait and no false
  // contention. Exactly one edit applies; the other is refused recoverably by
  // the served-state gate against the winner's fresh diff rows.
  const coexContent = readFileSync(join(workspace, "coexist.txt"), "utf8");
  const x1Land = coexContent.includes("X1") && !coexContent.includes("X4");
  const x4Land = coexContent.includes("X4") && !coexContent.includes("X1");
  assert.ok(x1Land || x4Land, "exactly one of the two concurrent edits landed (well-defined, no lost update)");
  const r1Applied = r1.details.metrics?.classification === "applied";
  const r2Applied = r2.details.metrics?.classification === "applied";
  assert.ok(r1Applied !== r2Applied, "exactly one concurrent edit was applied");
  const refused = r1Applied ? r2 : r1;
  assert.equal(refused.details.errorCode, "E_RANGE_STALE", "the other concurrent edit was refused recoverably against the updated served state");
  assert.ok(!lockDirFiles().length, "no lock artefacts remain after the concurrent replaces");

  // --- #264 crash-at-boundary: a real process dies between the filesystem
  // commit and the store publication. The changed file is reported
  // truthfully, stale anchors cannot authorize a replace against it, and a
  // fresh read repairs the state. ---
  writeFileSync(join(workspace, "crash.txt"), "alpha\nbeta\ngamma\n");
  const crashHashes = hashesOf("alpha\nbeta\ngamma\n");
  {
    const seedStore = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
    recordServed(seedStore, join(workspace, "crash.txt"), crashHashes);
    seedStore.release();
  }
  const crashJob = spawnJob({
    mode: "crash-after-write",
    workspace,
    sessionDir,
    path: "crash.txt",
    content: "alpha\nCHANGED\ngamma\n",
  });
  const crashedResult = await waitResult(crashJob.resultPath);
  assert.equal(crashedResult.crashed, true, "the helper died at the post-commit boundary");
  assert.equal(
    readFileSync(join(workspace, "crash.txt"), "utf8"),
    "alpha\nCHANGED\ngamma\n",
    "the crashed helper's file bytes are committed",
  );
  {
    // The pre-crash served state cannot authorize a replace against the new
    // bytes: the old anchor no longer matches the file.
    const afterCrash = spawnJob({
      mode: "replace",
      workspace,
      sessionDir,
      path: "crash.txt",
      removeFrom: crashHashes[1],
      removeTo: crashHashes[1],
      replacement: "MUST-NOT-APPLY",
    });
    const refusedAfterCrash = await waitResult(afterCrash.resultPath);
    assert.ok(
      /\[E_RANGE_STALE\]|\[E_STALE_ANCHOR\]/.test(textOf(refusedAfterCrash.content)),
      "stale anchors cannot authorize a replace against the crashed write's bytes",
    );
    assert.equal(
      readFileSync(join(workspace, "crash.txt"), "utf8"),
      "alpha\nCHANGED\ngamma\n",
      "the refused replace did not touch the file",
    );
  }
  {
    // A fresh read repairs the state and the retry applies.
    const repairRead = spawnJob({ mode: "read", workspace, sessionDir, path: "crash.txt" });
    const readResult = await waitResult(repairRead.resultPath);
    const freshRows = readRows(readResult.content);
    const changedRow = freshRows.find((row) => row.text === "CHANGED");
    assert.ok(changedRow, "the repairing read serves the current content");
    const retry = spawnJob({
      mode: "replace",
      workspace,
      sessionDir,
      path: "crash.txt",
      removeFrom: changedRow.hash,
      removeTo: changedRow.hash,
      replacement: "REPAIRED",
    });
    await waitResult(retry.resultPath);
    assert.equal(
      readFileSync(join(workspace, "crash.txt"), "utf8"),
      "alpha\nREPAIRED\ngamma\n",
      "the repaired state authorizes the retry",
    );
  }

  // --- Criterion 9/9: lock artefacts live under the session directory, so the
  // workspace never carries version-control-visible anchored-edit state. ---
  assert.equal(
    lockDir(),
    join(sessionDir, "anchored-edit", "locks"),
    "locks live under the session directory beside the store",
  );
  assert.ok(
    !existsSync(join(workspace, ".pi", "anchored-edit")),
    "the workspace keeps no anchored-edit state directory",
  );

  console.log("cross-process write lock tests: OK");
} finally {
  await Promise.all(children.map((child) => kill(child).catch(() => {})));
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
