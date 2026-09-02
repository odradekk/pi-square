import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errCode } from "./utils";
import { identityOf, sameNodeIdentity, unlinkIfSameNode, type FileIdentity } from "../core/safe-write.ts";

/**
 * Cross-process per-target exclusion used by every anchored operation —
 * parent and writable-child reads, replaces, and writes — so byte
 * observation or mutation and the matching owner-scoped store publication
 * happen as one unit across every Pi session that shares the workspace lock
 * area. A second session editing the same file therefore comes under the
 * same discipline as a second agent in this session: it waits for the lock
 * (bounded), then either proceeds against the now-current content or is
 * refused recoverably.
 *
 * The lock is a file under the session store directory's `locks/`
 * subdirectory named by the operation key (the canonical target path, or the
 * file's stable identity for an existing multi-link file), so operations on
 * different files never contend.
 *
 * Ownership is a complete record published atomically: the record is written
 * to a unique exclusive temporary file and linked into place, so no observer
 * ever sees a partial lock. A lock whose recorded owner is a confirmed-dead
 * local process is reclaimed on the next attempt; a live, foreign-host,
 * reused-pid, or malformed owner is never reclaimed on elapsed age alone —
 * a slow supported operation keeps its exclusion regardless of wall time.
 */

function readEnvMs(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const DEFAULT_LOCK_WAIT_MS = readEnvMs("PI_SQUARE_LOCK_WAIT_MS", 3000);
const DEFAULT_LOCK_POLL_MS = 40;

export interface FileLock {
  /** Releases the lock by removing its file only while it still holds this
   *  acquisition's token and file identity, so a release never deletes a
   *  lock re-acquired by another owner after a stale reclamation. */
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Total budget to wait for a live holder before refusing (default 3000 ms). */
  waitMs?: number;
  /** Poll interval while waiting (default 40 ms). */
  pollMs?: number;
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
  try {
    return processStartTime(pid);
  } catch {
    return undefined;
  }
}

function processStartTime(pid: number): string | undefined {
  // Linux only: /proc/<pid>/stat field 22. Reading it for another process is
  // a plain file read; a missing file means the process is gone or the
  // platform has no /proc.
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The comm field may contain spaces and parentheses; the start time is the
  // field after the closing parenthesis of comm.
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).split(" ");
  // fields[0] is state (field 3); starttime is field 22 → index 19.
  return fields[19];
}

interface LockFileInfo {
  owner: LockOwnerRecord | undefined;
  raw: string | undefined;
  identity: FileIdentity | undefined;
}

async function readLockInfo(lockPath: string): Promise<LockFileInfo> {
  let raw: string | undefined;
  let identity: FileIdentity | undefined;
  try {
    const stats = await stat(lockPath);
    if (!stats.isFile()) return { owner: undefined, raw: undefined, identity: undefined };
    identity = identityOf(stats);
    raw = await readFile(lockPath, "utf8");
  } catch {
    return { owner: undefined, raw: undefined, identity: undefined };
  }
  let owner: LockOwnerRecord | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockOwnerRecord).pid === "number" &&
      typeof (parsed as LockOwnerRecord).hostname === "string"
    ) {
      // Records from the pre-token format (no `v`) are still attributable
      // owners for reclaim decisions; only current records can release.
      owner = parsed as LockOwnerRecord;
    }
  } catch {
    // A complete record is published atomically, so a partial file is a
    // foreign or damaged artifact: fail closed and never reclaim it.
  }
  return { owner, raw, identity };
}

const localHostname = hostname();
const localStartTime = readStartTime(process.pid);

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
 * Decides whether a held lock's owner is a confirmed-gone local process.
 * Foreign-host and malformed ownership are unverifiable from here and fail
 * closed: the lock is treated as live and only waited on. Elapsed age is
 * never proof of death — a slow but supported operation keeps its lock.
 */
function isOwnerGone(owner: LockOwnerRecord): boolean {
  if (owner.hostname !== localHostname) return false;
  if (typeof owner.startTime === "string") {
    const current = readStartTime(owner.pid);
    if (current !== undefined) return current !== owner.startTime;
    // No /proc entry while the platform provided one for us: the pid is gone.
    if (localStartTime !== undefined) return true;
  }
  return !processIsAlive(owner.pid);
}

async function removeTemp(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}

/**
 * Publishes the complete owner record atomically: the record is written to a
 * unique exclusive temporary file and hard-linked into the lock path, so the
 * lock name never exists with partial content. Returns the lock file's
 * identity for release-time verification, or undefined when the lock path is
 * already taken (EEXIST) or link is unsupported (caller falls back).
 */
async function publishOwnerRecord(
  lockPath: string,
  ownerRaw: string,
): Promise<FileIdentity | undefined> {
  const tempPath = join(dirname(lockPath), `.publish-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, ownerRaw, { flag: "wx", mode: 0o600 });
    const stats = await stat(tempPath);
    const tempIdentity = identityOf(stats);
    try {
      await link(tempPath, lockPath);
    } catch (error) {
      if (errCode(error) === "EEXIST") return undefined;
      // Platforms or filesystems without hard-link support fall back to an
      // exclusive direct write, matching the previous create behavior.
      await writeFile(lockPath, ownerRaw, { flag: "wx", mode: 0o600 });
    }
    return tempIdentity;
  } finally {
    await removeTemp(tempPath);
  }
}

function anchoredFail(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

const IDENTITY_CODES = { escaped: "E_LOCK_INVALID", invalid: "E_LOCK_INVALID" } as const;

/**
 * Acquires the per-file lock with a bounded wait. Returns a release handle,
 * or null when the wait budget is exhausted while a holder owns the lock (the
 * caller then refuses recoverably with E_FILE_LOCKED). Locks whose recorded
 * owner is confirmed dead locally are reclaimed on the way; foreign-host,
 * reused-pid-ambiguous, and malformed ownership is only ever waited on. The
 * loop is bounded even across repeated reclamations: the deadline is checked
 * before every publish attempt, so it always ends in a handle or a refusal,
 * never an indefinite spin.
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
    if (signal?.aborted) throw new Error("Operation aborted");
    if (Date.now() >= deadline) return null;
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
        release: () => releaseLock(lockPath, owner.token, identity!),
      };
    }
    const info = await readLockInfo(lockPath);
    if (info.owner && isOwnerGone(info.owner)) {
      // The dead owner's file still blocks every other publisher, so the
      // same-node unlink removes exactly that file and cannot destroy a
      // successor's lock.
      if (info.identity) {
        const removed = await unlinkIfSameNode(anchoredFail, lockPath, info.identity, IDENTITY_CODES);
        if (!removed) continue; // a racing reclaimer won; retry the publish
      }
      continue; // retry the publish immediately
    }
    await sleep(Math.min(delayMs, pollMs));
    delayMs *= 2;
  }
}

/**
 * Releases one acquisition: the lock file is removed only while it still
 * carries this acquisition's token and the same file identity observed at
 * publish time, so a successor lock re-acquired after a stale reclamation
 * survives the previous owner's release.
 */
async function releaseLock(
  lockPath: string,
  token: string,
  identity: FileIdentity,
): Promise<void> {
  const info = await readLockInfo(lockPath);
  if (!info.owner || info.owner.token !== token) return;
  if (!info.identity || !sameNodeIdentity(info.identity, identity)) return;
  await unlinkIfSameNode(anchoredFail, lockPath, info.identity, IDENTITY_CODES);
}
