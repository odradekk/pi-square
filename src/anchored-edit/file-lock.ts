import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errCode } from "./utils";

/**
 * Cross-process per-target-file lock used by the anchored replace and child
 * write, so served-state verification and the write happen as one atomic
 * unit across every Pi session that shares the workspace. A second session
 * editing the same file therefore comes under the same discipline as a second
 * agent in this session: it waits for the lock (bounded), then either proceeds
 * against the now-current content or is refused recoverably against current
 * anchors.
 *
 * The lock is a file under `.pi/anchored-edit/locks/` named by the SHA-256 of
 * the canonical target path, so parallel edits to different files never
 * contend. The file records the owning process id and acquire time; a lock
 * whose owning process no longer exists is reclaimed on the next attempt
 * rather than blocking indefinitely.
 */

function readEnvMs(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const DEFAULT_LOCK_WAIT_MS = readEnvMs("PI_SQUARE_LOCK_WAIT_MS", 3000);
const DEFAULT_LOCK_POLL_MS = 40;
/**
 * Safety net: a lock this old is reclaimed even when its recorded pid looks
 * alive (pid reuse, an indeterminate liveness check, or a leaked holder).
 * Anchored operations hold the lock only for the duration of one read,
 * verification, and write, so a live lock never approaches this bound.
 */
const MAX_LOCK_AGE_MS = 60_000;
/**
 * A live writer completes the tiny owner write in well under a second. An
 * unparseable lock file (empty or partial JSON) older than this is a crashed
 * writer, not an in-progress one, so it is reclaimed.
 */
const MAX_LOCK_CREATE_MS = 1000;

export interface FileLock {
  /** Releases the lock by removing its file, resolving once removed. Only
   *  removes the file if it still holds this process's owner record, so a
   *  release never deletes a lock re-acquired by another owner after a stale
   *  reclamation. */
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Total budget to wait for a live holder before refusing (default 3000 ms). */
  waitMs?: number;
  /** Poll interval while waiting (default 40 ms). */
  pollMs?: number;
  signal?: AbortSignal;
}

interface LockOwner {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

/** Refusal text used by the child `write` on lock timeout. The `replace` path
 *  uses its own `E_RANGE_STALE` refusal with fresh anchors. */
export function fileLockedMessage(path: string, operation: string): string {
  return `[E_FILE_LOCKED] Another editor holds the write lock on ${path}; the ${operation} was not applied. Retry the ${operation}.`;
}

function lockFileName(targetPath: string): string {
  return `${createHash("sha256").update(targetPath).digest("hex")}.lock`;
}

/** Canonical location of the lock file for one target file in a workspace. */
export function lockFilePath(workspaceRoot: string, targetPath: string): string {
  return join(workspaceRoot, ".pi", "anchored-edit", "locks", lockFileName(targetPath));
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

interface LockFileInfo {
  owner: LockOwner | undefined;
  raw: string | undefined;
  mtimeMs: number | undefined;
}

async function readLockInfo(lockPath: string): Promise<LockFileInfo> {
  let raw: string | undefined;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return { owner: undefined, raw: undefined, mtimeMs: undefined };
  }
  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch {
    // the file vanished while reading: the next create attempt will win
  }
  let owner: LockOwner | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockOwner).pid === "number"
    ) {
      owner = parsed as LockOwner;
    }
  } catch {
    // partial or corrupt write: judged by age below
  }
  return { owner, raw, mtimeMs };
}

function isLockStale(info: LockFileInfo): boolean {
  if (info.owner) {
    if (!processIsAlive(info.owner.pid)) return true;
    if (
      typeof info.owner.acquiredAt === "number" &&
      Date.now() - info.owner.acquiredAt > MAX_LOCK_AGE_MS
    ) {
      return true;
    }
    return false;
  }
  return (
    info.mtimeMs !== undefined &&
    Date.now() - info.mtimeMs > MAX_LOCK_CREATE_MS
  );
}

/** Removes the lock file only if it still holds the expected content, closing
 *  the gap between a stale check (or a release) and the delete: a lock that was
 *  re-acquired by a new owner in between is left alone. */
async function removeIfUnchanged(lockPath: string, expectedRaw: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(lockPath, "utf8");
  } catch {
    return; // already gone: nothing to do
  }
  if (current === expectedRaw) {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * Acquires the per-file lock with a bounded wait. Returns a release handle, or
 * null when the wait budget is exhausted while a live holder owns the lock (the
 * caller then refuses recoverably against current content). Stale locks — an
 * owner that no longer exists, a lock older than MAX_LOCK_AGE_MS, or an
 * unparseable lock older than MAX_LOCK_CREATE_MS — are reclaimed on the way.
 * The loop is bounded even across repeated stale reclamations: the deadline is
 * checked before every create attempt, so it always ends in a handle or a
 * refusal, never an indefinite spin.
 */
export async function acquireFileLock(
  lockPath: string,
  options?: AcquireLockOptions,
): Promise<FileLock | null> {
  const waitMs = options?.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const signal = options?.signal;
  const deadline = Date.now() + waitMs;
  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: Date.now(),
  };
  const ownerRaw = JSON.stringify(owner);

  await mkdir(dirname(lockPath), { recursive: true });

  let delayMs = 1;
  for (;;) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (Date.now() >= deadline) return null;
    try {
      // Atomic create-exclusive with the owner content already present, so a
      // competing process never observes an empty "in-progress" lock file.
      await writeFile(lockPath, ownerRaw, { flag: "wx", mode: 0o600 });
      return {
        release: () => removeIfUnchanged(lockPath, ownerRaw),
      };
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
      const info = await readLockInfo(lockPath);
      if (isLockStale(info)) {
        if (info.raw !== undefined) {
          await removeIfUnchanged(lockPath, info.raw);
        }
        continue; // retry the create immediately
      }
      await sleep(Math.min(delayMs, pollMs));
      delayMs *= 2;
    }
  }
}
