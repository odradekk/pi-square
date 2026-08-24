/**
 * Shared safe-file-write primitives (odradekk/pi-square#154).
 *
 * Extracted from the display configuration writer so every persistent
 * pi-square write with review semantics shares one implementation of the
 * filesystem safety mechanics: identity-tracked lock files with stale
 * reclaim, dev/ino/birthtime file identity, same-node unlink, and
 * fsync'd exclusive-create temporary files for atomic renames.
 *
 * Domain callers keep their own error types and codes by supplying a `fail`
 * factory and code strings; this module owns no feature policy.
 */

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";

export const SAFE_WRITE_LOCK_STALE_MS = 30_000;
export const SAFE_WRITE_LOCK_RETRY_COUNT = 10;
export const SAFE_WRITE_LOCK_RETRY_DELAY_MS = 20;
export const SAFE_WRITE_LOCK_MAX_BYTES = 1_024;

/** Builds the caller's typed error for one code; the message must stay bounded. */
export type SafeWriteFail = (code: string, message: string) => Error;

export interface SafeWriteIdentityCodes {
  /** Code for a path that is a symlink. */
  readonly escaped: string;
  /** Code for a path that is not a regular file. */
  readonly invalid: string;
}

export interface SafeWriteLockCodes extends SafeWriteIdentityCodes {
  /** Code for failing to acquire the lock after all retries. */
  readonly timeout: string;
}

export interface FileIdentity {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly birthtimeMs: number;
  readonly mtimeMs: number;
  readonly size: number;
}

interface LockPayload {
  readonly token: string;
  readonly created: number;
}

export interface SafeLockHandle {
  readonly token: string;
  readonly identity: FileIdentity;
}

export interface SafeWriteTiming {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function identityOf(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

export function sameNodeIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameNodeIdentity(left, right) && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

/** Regular-file identity, or undefined when the path does not exist. */
export async function regularFileIdentity(
  fail: SafeWriteFail,
  path: string,
  label: string,
  codes: SafeWriteIdentityCodes,
): Promise<FileIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: false });
    if (stats.isSymbolicLink()) {
      throw fail(codes.escaped, `${label} '${path}' is a symlink`);
    }
    if (!stats.isFile()) {
      throw fail(codes.invalid, `${label} '${path}' is not a regular file`);
    }
    return identityOf(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Unlinks `path` only when it still names the same inode the caller saw. */
export async function unlinkIfSameNode(
  fail: SafeWriteFail,
  path: string,
  expected: FileIdentity,
  codes: SafeWriteIdentityCodes,
): Promise<boolean> {
  const current = await regularFileIdentity(fail, path, "path", codes);
  if (!current || !sameNodeIdentity(current, expected)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function tryCreateLock(
  fail: SafeWriteFail,
  lockPath: string,
  token: string,
  now: number,
  codes: SafeWriteIdentityCodes,
): Promise<SafeLockHandle | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let createdIdentity: FileIdentity | undefined;
  try {
    file = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    createdIdentity = identityOf(await file.stat());
    await file.writeFile(JSON.stringify({ token, created: now } satisfies LockPayload), "utf8");
    await file.sync();
    const identity = identityOf(await file.stat());
    await file.close();
    file = undefined;
    return { token, identity };
  } catch (error) {
    try {
      await file?.close();
    } catch {
      // Preserve the primary error; identity-based cleanup below handles the path.
    }
    if (createdIdentity) await unlinkIfSameNode(fail, lockPath, createdIdentity, codes);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

function parseLockPayload(content: string): LockPayload | undefined {
  try {
    const value = JSON.parse(content) as Partial<LockPayload>;
    if (
      typeof value.token !== "string"
      || value.token.length === 0
      || value.token.length > 128
      || typeof value.created !== "number"
      || !Number.isFinite(value.created)
      || value.created < 0
    ) return undefined;
    return { token: value.token, created: value.created };
  } catch {
    return undefined;
  }
}

async function readBoundedLock(lockPath: string, identity: FileIdentity): Promise<string | undefined> {
  if (identity.size > SAFE_WRITE_LOCK_MAX_BYTES) return undefined;
  try {
    return await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryReclaimStaleLock(
  fail: SafeWriteFail,
  lockPath: string,
  token: string,
  now: number,
  codes: SafeWriteIdentityCodes,
): Promise<SafeLockHandle | undefined> {
  const firstIdentity = await regularFileIdentity(fail, lockPath, "lock path", codes);
  if (!firstIdentity) return undefined;

  const firstContent = await readBoundedLock(lockPath, firstIdentity);
  if (firstContent === undefined) return undefined;
  const payload = parseLockPayload(firstContent);
  const claimedCreated = payload?.created ?? firstIdentity.mtimeMs;
  if (now - Math.max(claimedCreated, firstIdentity.mtimeMs) < SAFE_WRITE_LOCK_STALE_MS) return undefined;

  const secondIdentity = await regularFileIdentity(fail, lockPath, "lock path", codes);
  if (!secondIdentity || !sameFileIdentity(firstIdentity, secondIdentity)) return undefined;
  const secondContent = await readBoundedLock(lockPath, secondIdentity);
  if (secondContent === undefined || secondContent !== firstContent) return undefined;
  const finalIdentity = await regularFileIdentity(fail, lockPath, "lock path", codes);
  if (!finalIdentity || !sameFileIdentity(secondIdentity, finalIdentity)) return undefined;

  if (!await unlinkIfSameNode(fail, lockPath, finalIdentity, codes)) return undefined;
  return tryCreateLock(fail, lockPath, token, now, codes);
}

/**
 * Acquires the advisory lock file with the standard retry/stale-reclaim
 * policy. Returns undefined when the lock stays held by another writer.
 */
export async function acquireFileLock(input: {
  lockPath: string;
  token: string;
  fail: SafeWriteFail;
  codes: SafeWriteLockCodes;
  timing?: SafeWriteTiming;
  retryCount?: number;
  retryDelayMs?: number;
}): Promise<SafeLockHandle | undefined> {
  const now = input.timing?.now ?? Date.now;
  const wait = input.timing?.sleep ?? ((milliseconds: number) => new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));
  const retryCount = input.retryCount ?? SAFE_WRITE_LOCK_RETRY_COUNT;
  const retryDelayMs = input.retryDelayMs ?? SAFE_WRITE_LOCK_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    const timestamp = now();
    const created = await tryCreateLock(input.fail, input.lockPath, input.token, timestamp, input.codes);
    if (created) return created;
    const reclaimed = await tryReclaimStaleLock(input.fail, input.lockPath, input.token, timestamp, input.codes);
    if (reclaimed) return reclaimed;
    if (attempt < retryCount - 1) await wait(retryDelayMs);
  }
  return undefined;
}

/** Releases a lock handle only when the lock file still carries our token. */
export async function releaseFileLock(
  fail: SafeWriteFail,
  lockPath: string,
  handle: SafeLockHandle,
  codes: SafeWriteIdentityCodes,
): Promise<void> {
  const current = await regularFileIdentity(fail, lockPath, "lock path", codes);
  if (!current || !sameFileIdentity(current, handle.identity)) return;
  const content = await readBoundedLock(lockPath, current);
  if (content === undefined) return;
  const payload = parseLockPayload(content);
  const finalIdentity = await regularFileIdentity(fail, lockPath, "lock path", codes);
  if (!payload || payload.token !== handle.token || !finalIdentity || !sameFileIdentity(current, finalIdentity)) return;
  await unlinkIfSameNode(fail, lockPath, finalIdentity, codes);
}

/**
 * Creates an exclusive temporary file with the given content and mode,
 * fsyncs it, and returns its identity for pre-rename verification. Raw
 * filesystem errors propagate after same-node cleanup.
 */
export async function createAtomicTempFile(
  fail: SafeWriteFail,
  codes: SafeWriteIdentityCodes,
  tempPath: string,
  content: string,
  mode: number,
): Promise<FileIdentity> {
  const file = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  let initialIdentity: FileIdentity | undefined;
  let closed = false;
  try {
    initialIdentity = identityOf(await file.stat());
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.chmod(mode);
    const identity = identityOf(await file.stat());
    await file.close();
    closed = true;
    return identity;
  } catch (error) {
    if (!closed) {
      try {
        await file.close();
      } catch {
        // Preserve the write error; cleanup still checks the created file identity.
      }
      closed = true;
    }
    if (initialIdentity) await unlinkIfSameNode(fail, tempPath, initialIdentity, codes);
    throw error;
  } finally {
    if (!closed) await file.close();
  }
}
