import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errCode } from "./utils";
import { identityOf, sameNodeIdentity, type FileIdentity } from "../core/safe-write.ts";

/**
 * Cross-process per-target exclusion used by every anchored operation —
 * parent and writable-child reads, replaces, and writes — so byte
 * observation or mutation and the matching owner-scoped store publication
 * happen as one unit across every Pi session that shares the workspace lock
 * area. A second session editing the same file therefore comes under the
 * same discipline as a second agent in this session: it waits for the lock
 * (bounded), then either proceeds against the now-current content or is
 * refused recoverably with `E_FILE_LOCKED`.
 *
 * The lock is a file under the session store directory's `locks/`
 * subdirectory named by the operation key (the canonical target path, or the
 * file's stable identity for an existing multi-link file), so operations on
 * different files never contend.
 *
 * ## Ownership protocol
 *
 * Publication writes the complete owner record to a unique exclusive
 * temporary file and hard-links it into the lock path: the lock name never
 * exists with partial content, and publication either wins the name or
 * fails. Platforms without hard-link support fail closed (the lock cannot be
 * published safely, so the operation reports `[E_FILE_LOCKED]`/an error
 * rather than locking unsafely).
 *
 * Removal never unlinks by path after a check. It takes the file atomically
 * with `rename` to a unique retirement name and then verifies the taken file
 * two ways: its filesystem identity must match the identity the remover
 * verified beforehand, and — because inode reuse inside one coarse
 * birthtime window can falsify identity alone — the unique acquisition token
 * inside the taken record must match the token of the record that was
 * verified:
 *
 * - On both matches the retired file is exactly the one the remover proved
 *   to be its own or a confirmed-dead owner's, and only then is it deleted.
 * - On a mismatch the remover took a successor's lock (possible when a
 *   racing reclaimer retired a dead owner's file first and the successor
 *   installed in between, or an inode was reused). A foreign lock is never
 *   destroyed or clobbered: it is restored with a no-clobber hard link as
 *   soon as the lock path is free again.
 *
 * Because a live owner is never reclaimed (below), a holder's own release
 * always finds exactly its own file at the lock path, so the mismatch path
 * exists only for racing reclamations of a dead owner.
 *
 * Reclamation requires a positive determination that the recorded local
 * process is gone: the recorded Linux start time differs from the current
 * one for that pid (a reused pid proves the original died), or the pid is
 * confirmed dead by the operating system. Foreign-host and malformed
 * ownership is unverifiable and fails closed: the lock is only waited on,
 * never reclaimed, and elapsed time alone is never proof of death.
 */

function readEnvMs(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const DEFAULT_LOCK_WAIT_MS = readEnvMs("PI_SQUARE_LOCK_WAIT_MS", 3000);
const DEFAULT_LOCK_POLL_MS = 40;

/** Bound on restoring a foreign lock retired by a racing reclaimer. Read per
 *  call so deployments (and tests) can tighten it without a reload. */
function restoreWaitMs(): number {
  return readEnvMs("PI_SQUARE_LOCK_RESTORE_MS", 10_000);
}

export interface FileLock {
  /** Releases the lock by retiring the lock file, removing it only after the
   *  retired file's identity matches this acquisition's published file, so a
   *  release can never destroy a successor's lock. Best-effort after a
   *  committed mutation: failures are logged, never thrown into a caller
   *  whose filesystem work already succeeded. */
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Total budget to wait for a live holder before refusing (default 3000 ms). */
  waitMs?: number;
  /** Poll interval while waiting (default 40 ms). */
  pollMs?: number;
  /** Cancellation. An aborted wait ends as classified contention (`null`,
   *  reported as `E_FILE_LOCKED`), never as an unclassified throw. */
  signal?: AbortSignal;
}

interface LockOwnerRecord {
  v: 1;
  /** Random token uniquely identifying this acquisition. */
  token: string;
  pid: number;
  hostname: string;
  /**
   * Linux process start time (field 22 of /proc/<pid>/stat, clock ticks
   * since boot). Distinguishes this process instance from a later process
   * that reused the pid; undefined where the platform cannot provide it.
   */
  startTime?: string;
  acquiredAt: number;
}

/** Refusal text for failure to enter the operation boundary: the bounded
 *  wait on a busy target ended without the lock. Nothing was modified. */
export function fileLockedMessage(path: string, operation: string): string {
  return `[E_FILE_LOCKED] Another editor holds the write lock on ${path}; the ${operation} was not applied. Retry the ${operation}.`;
}

function lockFileName(operationKey: string): string {
  // The operation key is the canonical target path, or the file's stable
  // identity for an already-existing multi-link file so its hard-link aliases
  // within one workspace lock area coordinate. Hashing keeps the name
  // filesystem-safe regardless of the key's shape.
  return `${createHash("sha256").update(operationKey).digest("hex")}.lock`;
}

/** Canonical location of the lock file for one operation key under the session's
 *  anchored store directory (`anchoredStoreDir`). */
export function lockFilePath(storeDir: string, targetPath: string): string {
  return join(storeDir, "locks", lockFileName(targetPath));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** POSIX signal-0 liveness probe; on Windows EPERM means "exists but not ours". */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errCode(error) === "EPERM";
  }
}

function readStartTime(pid: number): string | undefined {
  // Linux only: /proc/<pid>/stat field 22. Reading it for another process is
  // a plain file read; a missing file means the process is gone or the
  // platform has no /proc, and the caller falls back to the liveness probe.
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field may contain spaces and parentheses; the start time is the
    // field after the closing parenthesis of comm.
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = raw.slice(close + 2).split(" ");
    // fields[0] is state (field 3); starttime is field 22 → index 19.
    return fields[19];
  } catch {
    return undefined;
  }
}

const localHostname = hostname();
const localStartTime = readStartTime(process.pid);

function isCompleteOwnerRecord(value: unknown): value is LockOwnerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<LockOwnerRecord>;
  return record.v === 1
    && typeof record.token === "string"
    && record.token.length > 0
    && record.token.length <= 128
    && typeof record.pid === "number"
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.hostname === "string"
    && record.hostname.length > 0
    && typeof record.acquiredAt === "number"
    && Number.isFinite(record.acquiredAt)
    && (record.startTime === undefined || typeof record.startTime === "string");
}

function currentOwnerRecord(): LockOwnerRecord {
  return {
    v: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: localHostname,
    ...(localStartTime !== undefined ? { startTime: localStartTime } : {}),
    acquiredAt: Date.now(),
  };
}

/**
 * Positive determination that a recorded local owner is gone. Foreign-host
 * ownership is unverifiable from here and fails closed. A start-time mismatch
 * proves the original process died and the pid was reused; when the current
 * start time cannot be read, the decision falls back to the OS liveness probe
 * — only a confirmed-dead pid or a proven reuse reclaims, never an
 * unverifiable read or elapsed time.
 */
function isOwnerGone(owner: LockOwnerRecord): boolean {
  if (owner.hostname !== localHostname) return false;
  if (typeof owner.startTime === "string" && localStartTime !== undefined) {
    const current = readStartTime(owner.pid);
    if (current !== undefined) return current !== owner.startTime;
  }
  return !processIsAlive(owner.pid);
}

interface LockFileInfo {
  owner: LockOwnerRecord | undefined;
  identity: FileIdentity | undefined;
}

async function readLockInfo(lockPath: string): Promise<LockFileInfo> {
  try {
    const stats = await stat(lockPath);
    if (!stats.isFile()) return { owner: undefined, identity: undefined };
    const identity = identityOf(stats);
    const raw = await readFile(lockPath, "utf8");
    let owner: LockOwnerRecord | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isCompleteOwnerRecord(parsed)) owner = parsed;
    } catch {
      // A complete record is published atomically, so a partial file is a
      // foreign or damaged artifact: fail closed and never reclaim it.
    }
    return { owner, identity };
  } catch {
    return { owner: undefined, identity: undefined };
  }
}

/** Reads just the acquisition token from a lock record file, or undefined
 *  when the file holds no complete record. */
async function readLockToken(lockPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return isCompleteOwnerRecord(parsed) ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Publishes the complete owner record atomically: the record is written to a
 * unique exclusive temporary file and hard-linked into the lock path, so the
 * lock name never exists with partial content and no fallback path is
 * taken. Returns the published lock file's identity for removal-time
 * verification, or undefined when the lock path is already held (EEXIST).
 * Any other failure propagates: publication is fail-closed.
 */
async function publishOwnerRecord(
  lockPath: string,
  ownerRaw: string,
): Promise<FileIdentity | undefined> {
  const tempPath = join(dirname(lockPath), `.publish-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, ownerRaw, { flag: "wx", mode: 0o600 });
    try {
      await link(tempPath, lockPath);
    } catch (error) {
      if (errCode(error) === "EEXIST") return undefined;
      // Fail closed: without an atomic no-clobber publication the lock name
      // could expose a partial record, so the operation must not proceed.
      throw error;
    }
    return identityOf(await stat(lockPath));
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Removes the lock file at `lockPath` only after proving, through an atomic
 * rename-take and an identity comparison, that the file being deleted is the
 * exact one the remover verified. A foreign file taken in a reclaimer race is
 * restored with a no-clobber link once the lock path is free; it is never
 * destroyed or overwritten. `lockBarrier.afterTake` is a deterministic test
 * seam between the take and the identity check.
 */
async function removeVerifiedLockFile(
  lockPath: string,
  expected: FileIdentity,
  expectedToken: string | undefined,
  pollMs: number,
): Promise<void> {
  const retiredPath = join(dirname(lockPath), `.retired-${randomUUID()}.tmp`);
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if (errCode(error) === "ENOENT") return; // already gone: nothing to remove
    throw error;
  }
  await __lockTestables.lockBarrier.afterTake?.(lockPath, retiredPath);
  let retired: FileIdentity;
  let retiredToken: string | undefined;
  try {
    retired = identityOf(await lstat(retiredPath));
    retiredToken = await readLockToken(retiredPath);
  } catch (error) {
    if (errCode(error) === "ENOENT") return;
    throw error;
  }
  // Both proofs must hold: same node identity, and the same unique
  // acquisition token the verifier read. Inode reuse alone cannot falsify
  // the token, and the token alone cannot survive a genuine replacement.
  if (sameNodeIdentity(retired, expected) && retiredToken !== undefined && retiredToken === expectedToken) {
    // The retired file is exactly the one this remover verified (its own
    // acquisition, or a confirmed-dead owner's record); only now may it be
    // deleted.
    await rm(retiredPath, { force: true }).catch(() => {});
    return;
  }
  // A racing reclaimer retired the verified file first and a successor
  // installed in between. The retired file is foreign: restore it under its
  // name with a no-clobber link as soon as the path is free. Never destroy
  // or clobber it.
  const deadline = Date.now() + restoreWaitMs();
  for (;;) {
    try {
      await link(retiredPath, lockPath);
      await rm(retiredPath, { force: true }).catch(() => {});
      return;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) {
      // The path stayed occupied for the whole restore budget. Leave the
      // retired file in place (the locks directory is pi-square-owned) and
      // surface the displacement; the lock is preserved, not destroyed.
      console.error(
        `Anchored lock retirement could not restore a foreign lock file at ${lockPath}; left at ${retiredPath}.`,
      );
      return;
    }
    await sleep(pollMs);
  }
}

/**
 * Acquires the per-file lock with a bounded wait. Returns a release handle,
 * or null when the wait budget ended or the wait was cancelled — both are
 * classified contention the caller reports as `E_FILE_LOCKED`. Locks whose
 * recorded owner is confirmed dead locally are reclaimed on the way;
 * foreign-host, reused-pid-ambiguous, malformed, and live ownership is only
 * ever waited on. The loop is bounded even across repeated reclamations: the
 * deadline is checked before every publish attempt, so it always ends in a
 * handle or a refusal, never an indefinite spin.
 */
export async function acquireFileLock(
  lockPath: string,
  options?: AcquireLockOptions,
): Promise<FileLock | null> {
  const waitMs = options?.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const signal = options?.signal;
  const deadline = Date.now() + waitMs;
  const owner = currentOwnerRecord();
  const ownerRaw = JSON.stringify(owner);

  await mkdir(dirname(lockPath), { recursive: true });

  let delayMs = 1;
  for (;;) {
    // Cancellation and deadline exhaustion are the same classified outcome:
    // the boundary was not entered and nothing was modified.
    if (signal?.aborted || Date.now() >= deadline) return null;
    let identity: FileIdentity | undefined;
    try {
      identity = await publishOwnerRecord(lockPath, ownerRaw);
    } catch (error) {
      if (errCode(error) === "EEXIST") {
        identity = undefined;
      } else {
        throw error;
      }
    }
    if (identity) {
      return {
        release: () =>
          removeVerifiedLockFile(lockPath, identity!, owner.token, pollMs).catch((error) => {
            // Release is best-effort after committed work: log, never throw
            // into a caller whose filesystem operation already succeeded.
            console.error(`Failed to release anchored lock ${lockPath}:`, error);
          }),
      };
    }
    const info = await readLockInfo(lockPath);
    if (info.owner && info.identity && isOwnerGone(info.owner)) {
      // The dead owner's file still blocks every other publisher. Retire it
      // under its verified identity; a racing reclaimer that wins leaves a
      // successor's file that the identity check restores, never deletes.
      // Either way the publish is retried immediately (the loop deadline
      // still bounds the wait).
      await removeVerifiedLockFile(lockPath, info.identity, info.owner.token, pollMs).catch(() => {});
    }
    await sleep(Math.min(delayMs, pollMs));
    delayMs *= 2;
  }
}

/**
 * @internal Deterministic test seams: direct access to the verified-removal
 * protocol (so a previous owner's late release can be exercised against an
 * installed successor) and a barrier between the atomic take and the
 * identity check. Production never sets the barrier.
 */
export const __lockTestables = {
  removeVerifiedLockFile,
  publishOwnerRecord,
  currentOwnerRecord,
  isOwnerGone,
  isCompleteOwnerRecord,
  lockBarrier: {
    afterTake: undefined as ((lockPath: string, retiredPath: string) => Promise<void>) | undefined,
  },
};
