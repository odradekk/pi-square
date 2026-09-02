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
 * Removal never unlinks the canonical lock path after a mere check, and it
 * never renames the canonical lock path away before proving — under a
 * per-target removal right — that the file to remove is still the exact one
 * the remover verified. Every remover first publishes a short-lived removal
 * marker (`<lock>.rm`, the same atomic record protocol) naming the remover
 * process. While a marker is held, no other remover can act (its marker
 * publish fails) and no successor can install (the canonical path is still
 * occupied), so the remover's single rename-take necessarily grabs exactly
 * the file it re-verified — a dead owner's record, or its own acquisition.
 * A live successor's lock is therefore never moved off the canonical path by
 * a stale verifier: the verifier re-reads the canonical record under the
 * marker, finds a different token, and walks away having touched nothing.
 *
 * A marker whose holder died is reclaimed the same positive-death way as a
 * dead lock: while the old marker exists no new marker can be published, so
 * its verified removal is exact. All removal waits share the calling
 * acquire's deadline and cancellation and end in the same classified
 * `E_FILE_LOCKED` outcome (or, for a release, a logged best-effort
 * failure) — never an unbounded or un-cancellable wait.
 *
 * Reclamation requires a positive determination that the recorded local
 * process is gone: the recorded Linux start time (strictly digits; anything
 * else makes the record unverifiable) differs from the current one for that
 * pid (a reused pid proves the original died), or the pid is confirmed dead
 * by the operating system. Foreign-host and malformed ownership is
 * unverifiable and fails closed: the lock is only waited on, never
 * reclaimed, and elapsed time alone is never proof of death.
 */

function readEnvMs(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const DEFAULT_LOCK_WAIT_MS = readEnvMs("PI_SQUARE_LOCK_WAIT_MS", 3000);
const DEFAULT_LOCK_POLL_MS = 40;
/** Bound for a release-time removal (no caller budget): bounded, never
 *  unbounded, and failures are logged rather than thrown. */
const RELEASE_REMOVAL_BUDGET_MS = readEnvMs("PI_SQUARE_RELEASE_BUDGET_MS", 10_000);

export interface FileLock {
  /** Releases the lock through the verified-removal protocol. Best-effort
   *  after a committed mutation: failures are logged, never thrown into a
   *  caller whose filesystem work already succeeded. */
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

/** Shared wait budget: one deadline and cancellation for an acquire and
 *  every removal (reclaim, marker, restore) it performs. */
interface WaitBudget {
  deadlineAt: number;
  signal?: AbortSignal;
  pollMs: number;
}

function budgetSpent(budget: WaitBudget): boolean {
  return budget.signal?.aborted === true || Date.now() >= budget.deadlineAt;
}

interface LockOwnerRecord {
  v: 1;
  /** Random token uniquely identifying this acquisition. */
  token: string;
  pid: number;
  hostname: string;
  /**
   * Linux process start time (field 22 of /proc/<pid>/stat, clock ticks
   * since boot — strictly digits). Distinguishes this process instance from
   * a later process that reused the pid; undefined where the platform cannot
   * provide it. A value that is not digits is not a start time: the record
   * is unverifiable and fails closed.
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

function markerPath(lockPath: string): string {
  return `${lockPath}.rm`;
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

function isValidStartTime(value: string): boolean {
  return /^[0-9]{1,20}$/.test(value);
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
    const value = fields[19];
    return value !== undefined && isValidStartTime(value) ? value : undefined;
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
    && (record.startTime === undefined || (typeof record.startTime === "string" && isValidStartTime(record.startTime)));
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
 * proves the original process died and the pid was reused — but only between
 * two well-formed start times; when the current start time cannot be read,
 * the decision falls back to the OS liveness probe. Only a confirmed-dead pid
 * or a proven reuse reclaims, never an unverifiable read or elapsed time.
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
  token: string | undefined;
}

async function readLockInfo(lockPath: string): Promise<LockFileInfo> {
  try {
    const stats = await stat(lockPath);
    if (!stats.isFile()) return { owner: undefined, identity: undefined, token: undefined };
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
    return { owner, identity, token: owner?.token };
  } catch {
    return { owner: undefined, identity: undefined, token: undefined };
  }
}

/**
 * Publishes the complete owner record atomically: the record is written to a
 * unique exclusive temporary file and hard-linked into the target path, so
 * the name never exists with partial content and no fallback path is
 * taken. Returns the published file's identity, or undefined when the path is
 * already held (EEXIST). Any other failure propagates: publication is
 * fail-closed.
 */
async function publishOwnerRecord(
  targetPath: string,
  ownerRaw: string,
): Promise<FileIdentity | undefined> {
  const tempPath = join(dirname(targetPath), `.publish-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, ownerRaw, { flag: "wx", mode: 0o600 });
    try {
      await link(tempPath, targetPath);
    } catch (error) {
      if (errCode(error) === "EEXIST") return undefined;
      // Fail closed: without an atomic no-clobber publication the name
      // could expose a partial record, so the operation must not proceed.
      throw error;
    }
    return identityOf(await stat(targetPath));
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/** Outcome of a verified removal attempt. */
type RemovalOutcome = "removed" | "absent" | "foreign" | "busy";

/**
 * Removes the lock file at `lockPath` through the marker-guarded protocol:
 *
 * 1. Acquire the per-target removal marker (atomic record publish). A marker
 *    whose holder is provably dead is reclaimed first; a live marker makes
 *    this attempt "busy" so the caller's bounded loop can retry.
 * 2. Under the marker, re-read the canonical record. Anything other than the
 *    exact expected identity and token means a successor owns the path now:
 *    return "foreign" having touched nothing — the canonical path was never
 *    disturbed, so no third writer could have slipped in.
 * 3. One rename-take, then delete only on a matching identity and token.
 *    Because the marker excludes every other remover and installers cannot
 *    install while the path is occupied, the take grabs exactly the
 *    re-verified file. A mismatch is defense-in-depth (a non-protocol actor):
 *    the taken file is restored with a no-clobber link within the remaining
 *    budget, never destroyed.
 *
 * `expectedToken` undefined (an unverifiable original) always maps to
 * "foreign": an unverifiable lock is only ever waited on.
 */
async function removeVerifiedLockFile(
  lockPath: string,
  expected: FileIdentity,
  expectedToken: string | undefined,
  budget: WaitBudget,
): Promise<RemovalOutcome> {
  if (expectedToken === undefined) return "foreign";
  const marker = await acquireRemovalMarker(lockPath, budget);
  if (marker === undefined) return "busy";
  try {
    await __lockTestables.lockBarrier.markerHeld?.(lockPath);
    if (budgetSpent(budget)) return "busy";
    const current = await readLockInfo(lockPath);
    if (current.identity === undefined) return "absent";
    if (!sameNodeIdentity(current.identity, expected) || current.token !== expectedToken) {
      // A successor owns the canonical path now. Touch nothing: the path was
      // never disturbed by this attempt, so exclusion held throughout.
      return "foreign";
    }

    const retiredPath = join(dirname(lockPath), `.retired-${randomUUID()}.tmp`);
    try {
      await rename(lockPath, retiredPath);
    } catch (error) {
      if (errCode(error) === "ENOENT") return "absent";
      throw error;
    }
    await __lockTestables.lockBarrier.afterTake?.(lockPath, retiredPath);
    let retired: FileIdentity;
    let retiredToken: string | undefined;
    try {
      retired = identityOf(await lstat(retiredPath));
      retiredToken = (await readLockInfo(retiredPath)).token;
    } catch (error) {
      if (errCode(error) === "ENOENT") return "absent";
      throw error;
    }
    if (sameNodeIdentity(retired, expected) && retiredToken === expectedToken) {
      // Exactly the file re-verified under the marker.
      await rm(retiredPath, { force: true }).catch(() => {});
      return "removed";
    }
    // Defense-in-depth: a non-protocol actor replaced the canonical file
    // between the re-verify and the take. The taken file is foreign —
    // restore it under its name, never destroy it, bounded by the shared
    // budget.
    for (;;) {
      try {
        await link(retiredPath, lockPath);
        await rm(retiredPath, { force: true }).catch(() => {});
        return "foreign";
      } catch (error) {
        if (errCode(error) !== "EEXIST") throw error;
      }
      if (budgetSpent(budget)) {
        console.error(
          `Anchored lock removal could not restore a foreign lock file at ${lockPath}; left at ${retiredPath}.`,
        );
        return "foreign";
      }
      await sleep(budget.pollMs);
    }
  } finally {
    await releaseRemovalMarker(lockPath, marker).catch((error) => {
      console.error(`Failed to release anchored lock removal marker for ${lockPath}:`, error);
    });
  }
}

/**
 * Acquires the per-target removal marker under the shared budget. A marker
 * left by a provably dead remover is reclaimed first (while it exists no new
 * marker can be published, so its verified removal is exact); a live or
 * unverifiable marker yields undefined — "busy" — and the caller retries
 * within its own budget.
 */
async function acquireRemovalMarker(
  lockPath: string,
  budget: WaitBudget,
): Promise<{ token: string; identity: FileIdentity } | undefined> {
  const path = markerPath(lockPath);
  for (;;) {
    if (budgetSpent(budget)) return undefined;
    const record = currentOwnerRecord();
    const identity = await publishOwnerRecord(path, JSON.stringify(record));
    if (identity) return { token: record.token, identity };
    const existing = await readLockInfo(path);
    if (existing.owner && existing.identity && isOwnerGone(existing.owner)) {
      // Reclaim the dead remover's marker. While it exists, no other marker
      // can be published, so the take is exact; failure just retries.
      await removeExactFile(path, existing.identity, existing.owner.token, budget).catch(() => {});
      continue;
    }
    // A live remover holds the marker (or it is unverifiable — same
    // treatment): back off to the caller's bounded loop.
    return undefined;
  }
}

/** Releases (removes) this process's own removal marker. Only a remover that
 *  positively determined us dead could touch it, so the take is exact;
 *  defense-in-depth restore keeps it safe regardless. */
async function releaseRemovalMarker(
  lockPath: string,
  marker: { token: string; identity: FileIdentity },
): Promise<void> {
  await removeExactFile(markerPath(lockPath), marker.identity, marker.token, {
    deadlineAt: Date.now() + RELEASE_REMOVAL_BUDGET_MS,
    pollMs: DEFAULT_LOCK_POLL_MS,
  });
}

/** Rename-take plus identity-and-token verification for a file whose
 *  replacement is excluded by construction (our own marker, or a dead
 *  marker/lock no one else can currently replace). */
async function removeExactFile(
  path: string,
  expected: FileIdentity,
  expectedToken: string,
  budget: WaitBudget,
): Promise<void> {
  const retiredPath = join(dirname(path), `.retired-${randomUUID()}.tmp`);
  try {
    await rename(path, retiredPath);
  } catch (error) {
    if (errCode(error) === "ENOENT") return;
    throw error;
  }
  let retired: FileIdentity;
  let retiredToken: string | undefined;
  try {
    retired = identityOf(await lstat(retiredPath));
    retiredToken = (await readLockInfo(retiredPath)).token;
  } catch (error) {
    if (errCode(error) === "ENOENT") return;
    throw error;
  }
  if (sameNodeIdentity(retired, expected) && retiredToken === expectedToken) {
    await rm(retiredPath, { force: true }).catch(() => {});
    return;
  }
  // Defense-in-depth: restore rather than destroy, within the budget.
  for (;;) {
    try {
      await link(retiredPath, path);
      await rm(retiredPath, { force: true }).catch(() => {});
      return;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
    }
    if (budgetSpent(budget)) {
      console.error(`Anchored lock removal could not restore a foreign file at ${path}; left at ${retiredPath}.`);
      return;
    }
    await sleep(budget.pollMs);
  }
}

/**
 * Acquires the per-file lock with a bounded wait. Returns a release handle,
 * or null when the wait budget ended or the wait was cancelled — both are
 * classified contention the caller reports as `E_FILE_LOCKED`. Locks whose
 * recorded owner is confirmed dead locally are reclaimed on the way through
 * the same marker-guarded protocol; foreign-host, malformed, live, and
 * marker-busy states are only ever waited on. Every wait — publish polling,
 * marker acquisition, reclamation — shares this call's deadline and
 * cancellation, so the acquire always ends in a handle or a refusal, never
 * an unbounded or un-cancellable wait.
 */
export async function acquireFileLock(
  lockPath: string,
  options?: AcquireLockOptions,
): Promise<FileLock | null> {
  const budget: WaitBudget = {
    deadlineAt: Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    pollMs: options?.pollMs ?? DEFAULT_LOCK_POLL_MS,
  };
  const owner = currentOwnerRecord();
  const ownerRaw = JSON.stringify(owner);

  await mkdir(dirname(lockPath), { recursive: true });

  let delayMs = 1;
  for (;;) {
    // Cancellation and deadline exhaustion are the same classified outcome:
    // the boundary was not entered and nothing was modified.
    if (budgetSpent(budget)) return null;
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
          removeVerifiedLockFile(lockPath, identity!, owner.token, {
            deadlineAt: Date.now() + RELEASE_REMOVAL_BUDGET_MS,
            pollMs: DEFAULT_LOCK_POLL_MS,
          })
            .then(() => undefined)
            .catch((error) => {
              // Release is best-effort after committed work: log, never throw
              // into a caller whose filesystem operation already succeeded.
              console.error(`Failed to release anchored lock ${lockPath}:`, error);
            }),
      };
    }
    const info = await readLockInfo(lockPath);
    if (info.owner && info.identity && isOwnerGone(info.owner)) {
      // The dead owner's file still blocks every publisher. Remove it under
      // the marker protocol; busy (another remover holds the marker) simply
      // falls through to the bounded wait, and the loop deadline still bounds
      // everything.
      await removeVerifiedLockFile(lockPath, info.identity, info.owner.token, budget)
        .then(() => undefined)
        .catch(() => {});
    }
    await sleep(Math.min(delayMs, budget.pollMs));
    delayMs *= 2;
  }
}

/**
 * @internal Deterministic test seams: direct access to the verified-removal
 *  protocol (so a stale verifier can be exercised against an installed
 *  successor) and barriers at the marker-hold and take points. Production
 *  never sets the barriers.
 */
export const __lockTestables = {
  removeVerifiedLockFile,
  publishOwnerRecord,
  currentOwnerRecord,
  isOwnerGone,
  isCompleteOwnerRecord,
  markerPath,
  lockBarrier: {
    markerHeld: undefined as ((lockPath: string) => Promise<void>) | undefined,
    afterTake: undefined as ((lockPath: string, retiredPath: string) => Promise<void>) | undefined,
  },
};
