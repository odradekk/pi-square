import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  acquireFileLock,
  createAtomicTempFile,
  regularFileIdentity,
  releaseFileLock,
  sameFileIdentity,
  unlinkIfSameNode,
  type FileIdentity,
} from "./safe-write";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DisplayMigrationError,
  migrateDisplayConfig,
  migrateFooterMode,
  type DisplayMigrationChange,
} from "../display/migration";
import type { DisplayLayerConfig } from "../display/types";
import { validateConfigLayer } from "./config";

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
  /** Migration changes detected when reading legacy configuration (display fields or footer.mode). Present only when non-empty. */
  readonly migration?: readonly DisplayMigrationChange[];
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

const failDisplay = (code: string, message: string): DisplayConfigWriteError =>
  new DisplayConfigWriteError(message, code);

const DISPLAY_IDENTITY_CODES = {
  escaped: "DISPLAY_SCOPE_ESCAPED",
  invalid: "DISPLAY_SCOPE_INVALID",
} as const;

const DISPLAY_LOCK_CODES = {
  ...DISPLAY_IDENTITY_CODES,
  timeout: "DISPLAY_LOCK_TIMEOUT",
} as const;

interface ScopePaths {
  readonly base: string;
  readonly segments: readonly string[];
  readonly root: string;
  readonly configPath: string;
  readonly lockPath: string;
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
  // Run the migration reader on the display section. This accepts legacy
  // fields (e.g. diffIndicators) and produces a canonical DisplayLayerConfig
  // with explicit change records. For already-canonical input the reader is a
  // no-op (same display, no changes). Invalid display input is rejected.
  const rawDisplay = root.display && typeof root.display === "object" && !Array.isArray(root.display)
    ? root.display
    : undefined;
  let migrationResult;
  try {
    migrationResult = migrateDisplayConfig(rawDisplay);
  } catch (error) {
    if (error instanceof DisplayMigrationError) {
      throw new DisplayConfigWriteError(
        `existing display config is invalid: ${error.message}`,
        "DISPLAY_CANDIDATE_INVALID",
      );
    }
    throw error;
  }

  // Validate the complete config layer with the canonical display substituted
  // so that non-display parts (version, footer, banner, ssh) are still checked.
  const validatedRoot = { ...root, display: migrationResult.display };
  const validationError = validateConfigLayer(validatedRoot, scope);
  if (validationError) {
    throw new DisplayConfigWriteError(
      `existing config is invalid: ${validationError}`,
      "DISPLAY_CANDIDATE_INVALID",
    );
  }

  const footer = root.footer;
  const footerModePresent = Boolean(
    footer
    && typeof footer === "object"
    && !Array.isArray(footer)
    && Object.hasOwn(footer, "mode"),
  );

  // Collect all migration changes: display changes plus footer.mode removal.
  const footerModeChange = migrateFooterMode(footerModePresent);
  const allChanges = footerModeChange
    ? [...migrationResult.changes, footerModeChange]
    : migrationResult.changes;

  return {
    path: paths.configPath,
    fingerprint: fingerprintConfigContent(content),
    display: structuredClone(migrationResult.display),
    footerModePresent,
    ...(allChanges.length > 0 ? { migration: allChanges } : {}),
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
  const lock = await acquireFileLock({
    lockPath: paths.lockPath,
    token,
    fail: failDisplay,
    codes: DISPLAY_LOCK_CODES,
    timing: testHooks,
  });
  if (!lock) {
    throw new DisplayConfigWriteError(
      `could not acquire display config lock '${paths.lockPath}' after retries`,
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
    tempIdentity = await createAtomicTempFile(failDisplay, DISPLAY_IDENTITY_CODES, tempPath, `${JSON.stringify(candidate, null, 2)}\n`, mode);
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

    const currentTempIdentity = await regularFileIdentity(failDisplay, tempPath, "temporary config", DISPLAY_IDENTITY_CODES);
    if (!currentTempIdentity || !sameFileIdentity(tempIdentity, currentTempIdentity)) {
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
      if (tempPath && tempIdentity) {
        await unlinkIfSameNode(failDisplay, tempPath, tempIdentity, DISPLAY_IDENTITY_CODES);
      }
    } finally {
      await releaseFileLock(failDisplay, paths.lockPath, lock, DISPLAY_IDENTITY_CODES);
    }
  }
}
