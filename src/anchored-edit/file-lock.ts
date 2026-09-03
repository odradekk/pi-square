import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
 * A marker whose holder died is reclaimed through a per-dead-token claim:
 * reclaimers must first win an exclusive claim file named after the dead
 * marker's unique token, and only the claim winner ever takes the marker
 * path — so two stale reclaimers can never race a check-then-rename on the
 * marker itself, and a live marker installed by another reclaimer is never
 * displaced. All removal waits share the calling
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
 *  unbounded, and failures are logged rather than thrown. Read per call so
 *  deployments (and tests) can tighten it without a reload. */
function releaseBudgetMs(): number {
  return readEnvMs("PI_SQUARE_RELEASE_BUDGET_MS", 10_000);
}

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
  return signalAborted(budget) || Date.now() >= budget.deadlineAt;
}

/** Cancellation query behind a function boundary: the flag can flip between
 *  any two awaits, which the type system cannot see. */
function signalAborted(budget: WaitBudget): boolean {
  return budget.signal?.aborted === true;
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

/** Upper bound of a Linux pid (`pid_max` ceiling, 2^22): a record naming a
 *  pid above it is malformed ownership, not a process to probe. */
const MAX_REPRESENTABLE_PID = 4_194_304;

type Liveness = "alive" | "dead" | "unknown";

/**
 * POSIX signal-0 liveness probe. ESRCH is the only definitive death proof;
 * EPERM means alive (exists but not ours, Windows included); every other
 * error (EINVAL for an invalid pid, EIO, ...) is *unknown* and fails closed
 * — it is never treated as death.
 */
function probeLiveness(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = errCode(error);
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
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
    && record.pid <= MAX_REPRESENTABLE_PID
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
  // Only a definitive ESRCH (or the start-time reuse proof above) counts as
  // death; alive and unknown both fail closed.
  return probeLiveness(owner.pid) === "dead";
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
    // The marker is held: the re-verify and take are single non-waiting
    // steps, so a zero-wait caller still completes this round; only
    // cancellation aborts it.
    if (signalAborted(budget)) return "busy";
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
    await restoreForeignFile(retiredPath, lockPath, budget);
    return "foreign";
  } finally {
    await releaseRemovalMarker(lockPath, marker).catch((error) => {
      console.error(`Failed to release anchored lock removal marker for ${lockPath}:`, error);
    });
  }
}

/**
 * Releases a held lock by running the verified-removal protocol and retrying
 * while the removal marker is busy, within the bounded release budget. A
 * single busy attempt must never leak the lock file for the process
 * lifetime; exhausting the budget logs an explicit safe failure (the lock
 * file remains and is reclaimed once this process is gone).
 */
async function releaseWithRetry(lockPath: string, identity: FileIdentity, token: string): Promise<void> {
  const deadlineAt = Date.now() + releaseBudgetMs();
  for (;;) {
    const outcome = await removeVerifiedLockFile(lockPath, identity, token, {
      deadlineAt,
      pollMs: DEFAULT_LOCK_POLL_MS,
    });
    if (outcome !== "busy") return;
    if (Date.now() >= deadlineAt) {
      console.error(
        `Failed to release anchored lock ${lockPath}: the removal marker stayed busy for the whole release budget. The lock file remains and will be reclaimed after this process exits.`,
      );
      return;
    }
    await sleep(DEFAULT_LOCK_POLL_MS);
  }
}

function claimPathFor(lockPath: string, deadToken: string): string {
  return `${markerPath(lockPath)}.claim.${deadToken}`;
}

/**
 * Acquires the per-target removal marker under the shared budget. A live or
 * unverifiable marker yields undefined — "busy" — and the caller retries
 * within its own budget.
 *
 * A marker left by a provably dead remover is reclaimed through a per-dead-
 * token claim: the reclaimer must first win an exclusive claim file named
 * after the dead marker's unique token, and only the claim winner ever takes
 * the marker path. Two stale reclaimers of the same dead marker cannot both
 * act (one claim name, one link winner), so a delayed reclaimer can never
 * rename-take the live marker another reclaimer installed — the claim breaks
 * the check-then-rename recursion instead of repeating it. If the claim
 * winner's own marker publish loses the empty path to a fresh remover that
 * arrived in the take-to-publish gap, the winner backs off: exactly one
 * holder exists at every instant, and a live marker is never displaced.
 */
async function acquireRemovalMarker(
  lockPath: string,
  budget: WaitBudget,
): Promise<{ token: string; identity: FileIdentity } | undefined> {
  const path = markerPath(lockPath);
  {
    const record = currentOwnerRecord();
    const identity = await publishOwnerRecord(path, JSON.stringify(record));
    if (identity) return { token: record.token, identity };
  }
  const existing = await readLockInfo(path);
  if (!(existing.owner && existing.identity && isOwnerGone(existing.owner))) {
    // A live remover holds the marker (or it is unverifiable — same
    // treatment): back off to the caller's bounded loop.
    return undefined;
  }
  if (signalAborted(budget)) return undefined;

  // Claim the dead marker's reclamation exclusively.
  const deadToken = existing.owner.token;
  const claimPath = claimPathFor(lockPath, deadToken);
  const claimRecord = currentOwnerRecord();
  let claimIdentity = await publishOwnerRecord(claimPath, JSON.stringify(claimRecord));
  if (!claimIdentity) {
    // A claim file exists. A claim holder that crashed between publishing
    // its claim and taking the marker must not block reclamation forever:
    // like any lock record, a provably dead claim holder's file is removed
    // through the verified take (while it exists, no other claimant for this
    // dead marker can publish), and a live claim holder simply means busy.
    const staleClaim = await readLockInfo(claimPath);
    if (!(staleClaim.owner && staleClaim.identity && isOwnerGone(staleClaim.owner))) {
      return undefined;
    }
    await removeExactFile(claimPath, staleClaim.identity, staleClaim.owner.token, budget).catch(() => {});
    if (signalAborted(budget)) return undefined;
    claimIdentity = await publishOwnerRecord(claimPath, JSON.stringify(claimRecord));
    if (!claimIdentity) return undefined;
  }
  try {
    await __lockTestables.lockBarrier.markerClaimed?.(lockPath, claimPath);
    if (signalAborted(budget)) return undefined;
    // Re-read under the claim: only the claim winner writes the marker path,
    // so the marker must still be the exact dead record read above.
    const now = await readLockInfo(path);
    if (!(now.owner && now.identity && now.owner.token === deadToken)) {
      return undefined; // replaced or gone between the read and the claim
    }

    // Take the dead marker. The claim makes this take exclusive, so the
    // taken file is the verified dead record; a mismatch is a non-protocol
    // actor and is restored, never deleted.
    const retiredPath = join(dirname(path), `.retired-${randomUUID()}.tmp`);
    try {
      await rename(path, retiredPath);
    } catch (error) {
      if (errCode(error) === "ENOENT") return undefined;
      throw error;
    }
    await __lockTestables.lockBarrier.markerTaken?.(lockPath, retiredPath);
    const retiredInfo = await readLockInfo(retiredPath).catch(() => ({ owner: undefined, identity: undefined, token: undefined }) as LockFileInfo);
    if (
      retiredInfo.identity === undefined
      || !sameNodeIdentity(retiredInfo.identity, now.identity!)
      || retiredInfo.token !== deadToken
    ) {
      if (retiredInfo.identity !== undefined) {
        await restoreForeignFile(retiredPath, path, budget);
      }
      return undefined;
    }

    // Publish our own marker into the now-empty path. A fresh remover may
    // have won this gap; losing the link means exactly that, and we back off
    // leaving it the sole holder. Either way the dead file is safe to delete.
    const ownIdentity = await publishOwnerRecord(path, JSON.stringify(claimRecord));
    await rm(retiredPath, { force: true }).catch(() => {});
    if (!ownIdentity) return undefined;
    return { token: claimRecord.token, identity: ownIdentity };
  } finally {
    // The claim file is uniquely ours (named after the dead token, won by
    // this process): verified-own removal, best-effort.
    await removeExactFile(claimPath, claimIdentity, claimRecord.token, {
      deadlineAt: Date.now() + releaseBudgetMs(),
      pollMs: DEFAULT_LOCK_POLL_MS,
    }).catch((error) => {
      console.error(`Failed to release anchored lock removal claim ${claimPath}:`, error);
    });
  }
}

/** Restores a taken foreign file under its name with a no-clobber link,
 *  bounded by the shared budget; never destroys it. */
async function restoreForeignFile(retiredPath: string, targetPath: string, budget: WaitBudget): Promise<void> {
  for (;;) {
    try {
      await link(retiredPath, targetPath);
      await rm(retiredPath, { force: true }).catch(() => {});
      return;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
    }
    if (budgetSpent(budget)) {
      console.error(`Anchored lock removal could not restore a foreign file at ${targetPath}; left at ${retiredPath}.`);
      return;
    }
    await sleep(budget.pollMs);
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
    deadlineAt: Date.now() + releaseBudgetMs(),
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
  await restoreForeignFile(retiredPath, path, budget);
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
  // A dead-owner reclamation right at the deadline earns exactly one extra
  // publish attempt, so zero-wait callers can still recover a crashed owner
  // without gaining an unbounded loop.
  let retriedAfterDeadline = false;
  for (;;) {
    // Cancellation comes first: an aborted caller never publishes, never
    // leaves a lock artifact, and never observes or mutates the target.
    if (signalAborted(budget)) return null;
    // One immediate publish attempt happens even at a zero budget: the
    // parent write uses a zero-wait boundary (its seam carries no
    // AbortSignal, so it never enters a cancellable wait), and a busy target
    // is classified E_FILE_LOCKED at once.
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
          releaseWithRetry(lockPath, identity!, owner.token)
            .then(() => undefined)
            .catch((error) => {
              // Release is best-effort after committed work: log, never throw
              // into a caller whose filesystem operation already succeeded.
              console.error(`Failed to release anchored lock ${lockPath}:`, error);
            }),
      };
    }
    if (signalAborted(budget)) return null;
    const info = await readLockInfo(lockPath);
    if (info.owner && info.identity && isOwnerGone(info.owner)) {
      // The dead owner's file still blocks every publisher. Remove it under
      // the marker protocol. Only a completed removal earns the immediate
      // publish retry (even at an exhausted deadline, so a zero-wait caller
      // reclaims crashed owners — bounded to one such post-deadline retry);
      // a busy marker (another remover holds it) falls through to the
      // bounded wait instead of spinning.
      let removed = false;
      try {
        removed = (await removeVerifiedLockFile(lockPath, info.identity, info.owner.token, budget)) === "removed";
      } catch {
        // Reclaim failures classify as contention on the next pass.
      }
      if (removed) {
        if (signalAborted(budget)) return null;
        if (Date.now() >= budget.deadlineAt) {
          if (retriedAfterDeadline) return null;
          retriedAfterDeadline = true;
        }
        continue;
      }
    }
    if (budgetSpent(budget)) return null;
    await sleep(Math.min(delayMs, budget.pollMs));
    delayMs *= 2;
  }
}

// ---------------------------------------------------------------------------
// Synchronous zero-wait protocol (parent write's non-yielding operation)
// ---------------------------------------------------------------------------

/**
 * The parent write's injected operation runs without any real-asynchronous
 * I/O so no cancellation or competing operation can interleave between its
 * boundary verification and its filesystem commit (ADR-0014). These
 * synchronous mirrors implement exactly the zero-wait slice of the async
 * protocol above — one publish attempt, one non-waiting dead-owner
 * reclamation through the same marker/claim records, one verified release —
 * so both protocols interoperate through the same file formats.
 */

function readLockInfoSync(lockPath: string): LockFileInfo {
  try {
    const stats = statSync(lockPath);
    if (!stats.isFile()) return { owner: undefined, identity: undefined, token: undefined };
    const identity = identityOf(stats);
    let owner: LockOwnerRecord | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
      if (isCompleteOwnerRecord(parsed)) owner = parsed;
    } catch {
      // Partial or foreign artifact: unverifiable, fail closed.
    }
    return { owner, identity, token: owner?.token };
  } catch {
    return { owner: undefined, identity: undefined, token: undefined };
  }
}

function publishOwnerRecordSync(targetPath: string, ownerRaw: string): FileIdentity | undefined {
  const tempPath = join(dirname(targetPath), `.publish-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, ownerRaw, { flag: "wx", mode: 0o600 });
    try {
      linkSync(tempPath, targetPath);
    } catch (error) {
      if (errCode(error) === "EEXIST") return undefined;
      throw error;
    }
    return identityOf(statSync(targetPath));
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // already gone
    }
  }
}

/** Verified take plus delete for a file whose replacement is excluded by
 *  construction (our own marker or claim, or a re-verified dead record).
 *  A mismatch is a non-protocol actor: restore once, never destroy. */
function removeExactFileSync(path: string, expected: FileIdentity, expectedToken: string): "removed" | "absent" | "foreign" {
  const retiredPath = join(dirname(path), `.retired-${randomUUID()}.tmp`);
  try {
    renameSync(path, retiredPath);
  } catch (error) {
    if (errCode(error) === "ENOENT") return "absent";
    throw error;
  }
  const retired = readLockInfoSync(retiredPath);
  if (
    retired.identity !== undefined
    && sameNodeIdentity(retired.identity, expected)
    && retired.token === expectedToken
  ) {
    try {
      unlinkSync(retiredPath);
    } catch {
      // best-effort
    }
    return "removed";
  }
  try {
    if (!existsSync(path)) linkSync(retiredPath, path);
    else console.error(`Anchored lock removal could not restore a foreign file at ${path}; left at ${retiredPath}.`);
  } catch (error) {
    console.error(`Anchored lock removal could not restore a foreign file at ${path}:`, error);
  }
  return "foreign";
}

/**
 * Synchronous zero-wait acquisition of the canonical target lock: one
 * publish attempt; on a busy target, one non-waiting dead-owner check and
 * reclamation through the marker/claim protocol, then one final publish
 * attempt. Every live, foreign, malformed, or marker-busy state is an
 * immediate classified refusal — there is never a wait.
 */
export function acquireZeroWaitFileSync(lockPath: string): { token: string; identity: FileIdentity } | undefined {
  mkdirSync(dirname(lockPath), { recursive: true });
  const record = currentOwnerRecord();
  const ownerRaw = JSON.stringify(record);
  const attempt = (): FileIdentity | undefined => {
    try {
      return publishOwnerRecordSync(lockPath, ownerRaw);
    } catch (error) {
      if (errCode(error) === "EEXIST") return undefined;
      throw error;
    }
  };

  let identity = attempt();
  if (identity) return { token: record.token, identity };

  // One non-waiting dead-owner reclamation round.
  const info = readLockInfoSync(lockPath);
  if (info.owner && info.identity && isOwnerGone(info.owner)) {
    reclaimDeadLockSync(lockPath, info.identity, info.owner.token);
    identity = attempt();
    if (identity) return { token: record.token, identity };
  }
  return undefined;
}

/** Non-waiting marker/claim reclamation of a verified dead lock. */
function reclaimDeadLockSync(lockPath: string, expected: FileIdentity, deadToken: string): void {
  const marker = markerPath(lockPath);
  const markerRecord = currentOwnerRecord();
  let markerIdentity: FileIdentity | undefined;
  try {
    markerIdentity = publishOwnerRecordSync(marker, JSON.stringify(markerRecord));
  } catch {
    return;
  }
  if (!markerIdentity) {
    // Marker busy: reclaim it only when its holder is provably dead (one
    // non-waiting claim round); anything else is an immediate give-up.
    const existing = readLockInfoSync(marker);
    if (!(existing.owner && existing.identity && isOwnerGone(existing.owner))) return;
    reclaimDeadMarkerSync(lockPath, existing.identity, existing.owner.token);
    try {
      markerIdentity = publishOwnerRecordSync(marker, JSON.stringify(markerRecord));
    } catch {
      return;
    }
    if (!markerIdentity) return;
  }
  try {
    const current = readLockInfoSync(lockPath);
    if (!current.identity || !sameNodeIdentity(current.identity, expected) || current.token !== deadToken) return;
    const outcome = removeExactFileSync(lockPath, expected, deadToken);
    void outcome;
  } finally {
    removeExactFileSync(marker, markerIdentity, markerRecord.token);
  }
}

/** Non-waiting claim-guarded reclamation of a verified dead marker. */
function reclaimDeadMarkerSync(lockPath: string, expected: FileIdentity, deadToken: string): void {
  const marker = markerPath(lockPath);
  const claimPath = claimPathFor(lockPath, deadToken);
  const claimRecord = currentOwnerRecord();
  let claimIdentity: FileIdentity | undefined;
  try {
    claimIdentity = publishOwnerRecordSync(claimPath, JSON.stringify(claimRecord));
  } catch {
    return;
  }
  if (!claimIdentity) {
    const stale = readLockInfoSync(claimPath);
    if (!(stale.owner && stale.identity && isOwnerGone(stale.owner))) return;
    removeExactFileSync(claimPath, stale.identity, stale.owner.token);
    try {
      claimIdentity = publishOwnerRecordSync(claimPath, JSON.stringify(claimRecord));
    } catch {
      return;
    }
    if (!claimIdentity) return;
  }
  try {
    const current = readLockInfoSync(marker);
    if (!current.identity || !sameNodeIdentity(current.identity, expected) || current.token !== deadToken) return;
    removeExactFileSync(marker, expected, deadToken);
  } finally {
    removeExactFileSync(claimPath, claimIdentity, claimRecord.token);
  }
}

/**
 * Synchronous verified release of this process's own acquisition. When the
 * removal marker is busy (another remover holds it), the release continues
 * asynchronously through the retrying protocol — the lock is ours, so the
 * deferred release never affects the operation's reported outcome.
 */
export function releaseFileSync(lockPath: string, token: string, identity: FileIdentity): void {
  const markerRecord = currentOwnerRecord();
  let markerIdentity: FileIdentity | undefined;
  try {
    markerIdentity = publishOwnerRecordSync(markerPath(lockPath), JSON.stringify(markerRecord));
  } catch (error) {
    console.error(`Failed to release anchored lock ${lockPath}:`, error);
    return;
  }
  if (!markerIdentity) {
    // Busy marker: defer to the bounded retrying release.
    void releaseWithRetry(lockPath, identity, token).catch((error) => {
      console.error(`Failed to release anchored lock ${lockPath}:`, error);
    });
    return;
  }
  try {
    const current = readLockInfoSync(lockPath);
    if (!current.identity || !sameNodeIdentity(current.identity, identity) || current.token !== token) return;
    removeExactFileSync(lockPath, identity, token);
  } finally {
    removeExactFileSync(markerPath(lockPath), markerIdentity, markerRecord.token);
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
  acquireRemovalMarker,
  releaseRemovalMarker,
  acquireZeroWaitFileSync,
  releaseFileSync,
  publishOwnerRecord,
  currentOwnerRecord,
  isOwnerGone,
  isCompleteOwnerRecord,
  markerPath,
  lockBarrier: {
    markerHeld: undefined as ((lockPath: string) => Promise<void>) | undefined,
    markerClaimed: undefined as ((lockPath: string, claimPath: string) => Promise<void>) | undefined,
    markerTaken: undefined as ((lockPath: string, retiredPath: string) => Promise<void>) | undefined,
    afterTake: undefined as ((lockPath: string, retiredPath: string) => Promise<void>) | undefined,
  },
};
