import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DisplayLayerConfig } from "../display/types";
import { validateConfigLayer } from "./config";

const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_BYTES = 1_024;
const CONFIG_FILENAME = "pi-square.json";
const LOCK_SUFFIX = ".lock";
const DEFAULT_FILE_MODE = 0o600;

export type DisplayConfigWriteScope = "agent" | "project";

export interface DisplayConfigWriterContext {
  readonly cwd: string;
  readonly isProjectTrusted: boolean;
}

export interface DisplayConfigReview {
  /** SHA-256 fingerprint of the complete config text at review time. */
  readonly fingerprint: string;
  /** Complete display section approved by the review screen. */
  readonly display: DisplayLayerConfig;
  /** Remove only the deprecated footer.mode field approved by the review. */
  readonly removeFooterMode?: boolean;
}

export interface DisplayConfigWriteResult {
  readonly path: string;
}

export interface DisplayConfigSnapshot {
  readonly path: string;
  readonly fingerprint: string;
  readonly display: DisplayLayerConfig;
  readonly footerModePresent: boolean;
}

export interface DisplayConfigWriterTestHooks {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly beforeRename?: () => Promise<void>;
  readonly rename?: typeof rename;
}

export class DisplayConfigWriteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DisplayConfigWriteError";
  }
}

interface ScopePaths {
  readonly base: string;
  readonly segments: readonly string[];
  readonly root: string;
  readonly configPath: string;
  readonly lockPath: string;
}

interface FileIdentity {
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

interface LockHandle {
  readonly token: string;
  readonly identity: FileIdentity;
}

function canonicalExistingDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(path));
  } catch (error) {
    throw new DisplayConfigWriteError(
      `${label} cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
      "DISPLAY_SCOPE_INVALID",
    );
  }
  const stats = lstatSync(canonical);
  if (!stats.isDirectory()) {
    throw new DisplayConfigWriteError(`${label} is not a directory`, "DISPLAY_SCOPE_INVALID");
  }
  return canonical;
}

function resolveScopePaths(scope: DisplayConfigWriteScope, cwd: string): ScopePaths {
  const base = scope === "agent"
    ? canonicalExistingDirectory(getAgentDir(), "agent directory")
    : canonicalExistingDirectory(cwd, "project directory");
  const segments = scope === "agent" ? ["config"] : [".pi", "config"];
  const root = join(base, ...segments);
  const configPath = join(root, CONFIG_FILENAME);
  return {
    base,
    segments,
    root,
    configPath,
    lockPath: configPath + LOCK_SUFFIX,
  };
}

export function displayConfigPath(scope: DisplayConfigWriteScope, cwd: string): string {
  return resolveScopePaths(scope, cwd).configPath;
}

export function fingerprintConfigContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertRegularOrMissing(path: string, label: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new DisplayConfigWriteError(`${label} is a symlink`, "DISPLAY_SCOPE_ESCAPED");
    }
    if (!stats.isFile()) {
      throw new DisplayConfigWriteError(`${label} is not a regular file`, "DISPLAY_SCOPE_INVALID");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function assertScopePathSafe(paths: ScopePaths): void {
  const rel = relative(paths.base, paths.configPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DisplayConfigWriteError("config path escapes its canonical scope", "DISPLAY_SCOPE_ESCAPED");
  }

  let current = paths.base;
  for (const segment of paths.segments) {
    current = join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new DisplayConfigWriteError(
          `config scope segment '${current}' is a symlink`,
          "DISPLAY_SCOPE_ESCAPED",
        );
      }
      if (!stats.isDirectory()) {
        throw new DisplayConfigWriteError(
          `config scope segment '${current}' is not a directory`,
          "DISPLAY_SCOPE_INVALID",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  assertRegularOrMissing(paths.configPath, "config file");
}

export async function readDisplayConfigSnapshot(
  scope: DisplayConfigWriteScope,
  context: DisplayConfigWriterContext,
): Promise<DisplayConfigSnapshot> {
  if (scope === "project" && !context.isProjectTrusted) {
    throw new DisplayConfigWriteError(
      "project-scope display configuration requires a trusted project",
      "DISPLAY_PROJECT_UNTRUSTED",
    );
  }
  const paths = resolveScopePaths(scope, context.cwd);
  assertScopePathSafe(paths);
  let content = "";
  try {
    content = await readFile(paths.configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let root: Record<string, unknown> = {};
  if (content.trim()) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
      root = parsed as Record<string, unknown>;
    } catch (error) {
      throw new DisplayConfigWriteError(
        `existing config file is not valid configuration JSON: ${error instanceof Error ? error.message : String(error)}`,
        "DISPLAY_CANDIDATE_INVALID",
      );
    }
  }
  const validationError = validateConfigLayer(root, scope);
  if (validationError) {
    throw new DisplayConfigWriteError(
      `existing config is invalid: ${validationError}`,
      "DISPLAY_CANDIDATE_INVALID",
    );
  }
  const display = root.display && typeof root.display === "object" && !Array.isArray(root.display)
    ? structuredClone(root.display as DisplayLayerConfig)
    : {};
  const footer = root.footer;
  const footerModePresent = Boolean(
    footer
    && typeof footer === "object"
    && !Array.isArray(footer)
    && Object.hasOwn(footer, "mode"),
  );
  return {
    path: paths.configPath,
    fingerprint: fingerprintConfigContent(content),
    display,
    footerModePresent,
  };
}

export async function readConfigFingerprint(configPath: string): Promise<string> {
  assertRegularOrMissing(configPath, "config file");
  try {
    return fingerprintConfigContent(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fingerprintConfigContent("");
    throw error;
  }
}

function identityOf(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function sameNode(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameNode(left, right) && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function pathIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: false });
    if (stats.isSymbolicLink()) {
      throw new DisplayConfigWriteError(`lock path '${path}' is a symlink`, "DISPLAY_SCOPE_ESCAPED");
    }
    if (!stats.isFile()) {
      throw new DisplayConfigWriteError(`lock path '${path}' is not a regular file`, "DISPLAY_SCOPE_INVALID");
    }
    return identityOf(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkSameNode(path: string, expected: FileIdentity): Promise<boolean> {
  const current = await pathIdentity(path);
  if (!current || !sameNode(current, expected)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function tryCreateLock(lockPath: string, token: string, now: number): Promise<LockHandle | undefined> {
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
    if (createdIdentity) await unlinkSameNode(lockPath, createdIdentity);
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
  if (identity.size > LOCK_MAX_BYTES) return undefined;
  try {
    return await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryReclaimStaleLock(lockPath: string, token: string, now: number): Promise<LockHandle | undefined> {
  const firstIdentity = await pathIdentity(lockPath);
  if (!firstIdentity) return undefined;

  const firstContent = await readBoundedLock(lockPath, firstIdentity);
  if (firstContent === undefined) return undefined;
  const payload = parseLockPayload(firstContent);
  if (!payload) return undefined;
  if (now - Math.max(payload.created, firstIdentity.mtimeMs) < LOCK_STALE_MS) return undefined;

  const secondIdentity = await pathIdentity(lockPath);
  if (!secondIdentity || !sameIdentity(firstIdentity, secondIdentity)) return undefined;
  const secondContent = await readBoundedLock(lockPath, secondIdentity);
  if (secondContent === undefined || secondContent !== firstContent) return undefined;
  const finalIdentity = await pathIdentity(lockPath);
  if (!finalIdentity || !sameIdentity(secondIdentity, finalIdentity)) return undefined;

  if (!await unlinkSameNode(lockPath, finalIdentity)) return undefined;
  return tryCreateLock(lockPath, token, now);
}

async function acquireLock(
  lockPath: string,
  token: string,
  hooks: DisplayConfigWriterTestHooks,
): Promise<LockHandle | undefined> {
  const now = hooks.now ?? Date.now;
  const wait = hooks.sleep ?? ((milliseconds: number) => new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    const timestamp = now();
    const created = await tryCreateLock(lockPath, token, timestamp);
    if (created) return created;
    const reclaimed = await tryReclaimStaleLock(lockPath, token, timestamp);
    if (reclaimed) return reclaimed;
    if (attempt < LOCK_RETRY_COUNT - 1) await wait(LOCK_RETRY_DELAY_MS);
  }
  return undefined;
}

async function releaseLock(lockPath: string, handle: LockHandle): Promise<void> {
  const current = await pathIdentity(lockPath);
  if (!current || !sameIdentity(current, handle.identity)) return;
  const content = await readBoundedLock(lockPath, current);
  if (content === undefined) return;
  const payload = parseLockPayload(content);
  const finalIdentity = await pathIdentity(lockPath);
  if (!payload || payload.token !== handle.token || !finalIdentity || !sameIdentity(current, finalIdentity)) return;
  await unlinkSameNode(lockPath, finalIdentity);
}

function applyDisplayReview(
  current: Record<string, unknown>,
  review: DisplayConfigReview,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = { ...current, display: review.display };
  if (!review.removeFooterMode) return candidate;

  const footer = candidate.footer;
  if (!footer || typeof footer !== "object" || Array.isArray(footer)) return candidate;
  const nextFooter = { ...(footer as Record<string, unknown>) };
  delete nextFooter.mode;
  if (Object.keys(nextFooter).length === 0) delete candidate.footer;
  else candidate.footer = nextFooter;
  return candidate;
}

async function createTempFile(
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
    if (initialIdentity) await unlinkSameNode(tempPath, initialIdentity);
    throw error;
  } finally {
    if (!closed) await file.close();
  }
}

export async function writeDisplayConfig(
  review: DisplayConfigReview,
  context: DisplayConfigWriterContext,
  scope: DisplayConfigWriteScope = "agent",
  testHooks: DisplayConfigWriterTestHooks = {},
): Promise<DisplayConfigWriteResult> {
  if (scope === "project" && !context.isProjectTrusted) {
    throw new DisplayConfigWriteError(
      "project-scope display writes require a trusted project",
      "DISPLAY_PROJECT_UNTRUSTED",
    );
  }

  const paths = resolveScopePaths(scope, context.cwd);
  assertScopePathSafe(paths);
  await mkdir(paths.root, { recursive: true });
  assertScopePathSafe(paths);

  const token = randomBytes(16).toString("hex");
  const lock = await acquireLock(paths.lockPath, token, testHooks);
  if (!lock) {
    throw new DisplayConfigWriteError(
      "could not acquire display config lock after retries",
      "DISPLAY_LOCK_TIMEOUT",
    );
  }

  let tempPath: string | undefined;
  let tempIdentity: FileIdentity | undefined;
  try {
    assertScopePathSafe(paths);
    let currentContent = "";
    try {
      currentContent = await readFile(paths.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (fingerprintConfigContent(currentContent) !== review.fingerprint) {
      throw new DisplayConfigWriteError(
        "config file changed since review; review the current configuration and try again",
        "DISPLAY_STALE_REVIEW",
      );
    }

    let current: Record<string, unknown> = {};
    if (currentContent.trim()) {
      try {
        const parsed = JSON.parse(currentContent) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
        current = parsed as Record<string, unknown>;
      } catch (error) {
        throw new DisplayConfigWriteError(
          `existing config file is not valid configuration JSON: ${error instanceof Error ? error.message : String(error)}`,
          "DISPLAY_CANDIDATE_INVALID",
        );
      }
    }

    const candidate = applyDisplayReview(current, review);
    const validationError = validateConfigLayer(candidate, scope);
    if (validationError) {
      throw new DisplayConfigWriteError(
        `candidate config is invalid: ${validationError}`,
        "DISPLAY_CANDIDATE_INVALID",
      );
    }

    let mode = DEFAULT_FILE_MODE;
    try {
      const existing = lstatSync(paths.configPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new DisplayConfigWriteError("config file is not a regular file", "DISPLAY_SCOPE_INVALID");
      }
      mode = existing.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    tempPath = join(paths.root, `${CONFIG_FILENAME}.${token}.tmp`);
    tempIdentity = await createTempFile(tempPath, `${JSON.stringify(candidate, null, 2)}\n`, mode);
    await testHooks.beforeRename?.();
    assertScopePathSafe(paths);

    let latestContent = "";
    try {
      latestContent = await readFile(paths.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (fingerprintConfigContent(latestContent) !== review.fingerprint) {
      throw new DisplayConfigWriteError(
        "config file changed while the reviewed update was being prepared",
        "DISPLAY_STALE_REVIEW",
      );
    }

    const currentTempIdentity = await pathIdentity(tempPath);
    if (!currentTempIdentity || !sameIdentity(tempIdentity, currentTempIdentity)) {
      throw new DisplayConfigWriteError("temporary config identity changed before rename", "DISPLAY_TEMP_CHANGED");
    }

    const renameFile = testHooks.rename ?? rename;
    try {
      await renameFile(tempPath, paths.configPath);
    } catch (error) {
      throw new DisplayConfigWriteError(
        `atomic rename failed: ${error instanceof Error ? error.message : String(error)}`,
        "DISPLAY_RENAME_FAILED",
      );
    }
    tempPath = undefined;
    tempIdentity = undefined;
    return { path: paths.configPath };
  } finally {
    try {
      if (tempPath && tempIdentity) await unlinkSameNode(tempPath, tempIdentity);
    } finally {
      await releaseLock(paths.lockPath, lock);
    }
  }
}
