/**
 * Safe Shadow definition overlay writer (odradekk/pi-square#149, slice #154).
 *
 * Every persistent change to an agent or project overlay goes through
 * this module: canonical scope resolution, symlink
 * and file-identity checks, an advisory lock with stale reclaim, fingerprint
 * CAS against the reviewed content, complete effective-candidate validation
 * through the same merge used for discovery, permission preservation, and an
 * fsync'd temporary file renamed atomically into place. A stale or concurrent
 * write is refused with `SHADOW_STALE_REVIEW` and neither version is lost.
 * Package templates are read-only by construction — only the agent and
 * project scopes are writable here.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  acquireFileLock,
  createAtomicTempFile,
  regularFileIdentity,
  releaseFileLock,
  sameFileIdentity,
  unlinkIfSameNode,
  type FileIdentity,
  type SafeWriteTiming,
} from "../core/safe-write";
import { getAgentPath, isWithinWorkspace } from "../core/paths";
import {
  previewShadowDefinition,
  previewShadowDefinitionDeletion,
  shadowProjectScopeLocation,
} from "./definitions";
import { SHADOW_ID_PATTERN } from "./parser";
import type { ShadowDefinitionFields } from "./parser";
import { serializeShadowDefinition } from "./serialize";

const DEFAULT_FILE_MODE = 0o600;
const LOCK_SUFFIX = ".lock";
const TEMP_SUFFIX = ".tmp";

export type ShadowOverlayScope = "agent" | "project";

export class ShadowOverlayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ShadowOverlayError";
  }
}

const failShadow = (code: string, message: string): ShadowOverlayError =>
  new ShadowOverlayError(message, code);

const SHADOW_IDENTITY_CODES = {
  escaped: "SHADOW_SCOPE_ESCAPED",
  invalid: "SHADOW_SCOPE_INVALID",
} as const;

const SHADOW_LOCK_CODES = {
  ...SHADOW_IDENTITY_CODES,
  timeout: "SHADOW_LOCK_TIMEOUT",
} as const;

export interface ShadowOverlayTestHooks extends SafeWriteTiming {
  beforeRename?: () => Promise<void> | void;
  rename?: typeof rename;
  retryCount?: number;
  retryDelayMs?: number;
}

interface OverlayScopePaths {
  readonly base: string;
  readonly segments: readonly string[];
  readonly root: string;
  readonly filePath: string;
  readonly lockPath: string;
}

function canonicalExistingDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch (error) {
    throw failShadow(
      "SHADOW_SCOPE_INVALID",
      `${label} cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stats = lstatSync(canonical);
  if (!stats.isDirectory()) {
    throw failShadow("SHADOW_SCOPE_INVALID", `${label} is not a directory`);
  }
  return canonical;
}

/** Resolves the canonical write location for one overlay. */
function resolveOverlayPaths(
  scope: ShadowOverlayScope,
  cwd: string,
  id: string,
  requestedFilePath?: string,
): OverlayScopePaths {
  if (!SHADOW_ID_PATTERN.test(id)) {
    throw failShadow("SHADOW_CANDIDATE_INVALID", `Shadow definition id must match ${SHADOW_ID_PATTERN} (got '${id}').`);
  }
  let base: string;
  let segments: readonly string[];
  let root: string;
  if (scope === "agent") {
    base = canonicalExistingDirectory(getAgentPath(), "agent directory");
    segments = ["shadow-minds"];
    root = join(base, ...segments);
  } else {
    const walked = shadowProjectScopeLocation(cwd);
    if (walked?.error) throw failShadow("SHADOW_SCOPE_INVALID", walked.error);
    const projectRoot = walked ? walked.projectRoot : canonicalExistingDirectory(cwd, "project directory");
    const dir = walked ? walked.dir : join(projectRoot, ".pi", "shadow-minds");
    const relativeDir = relative(projectRoot, dir);
    if (relativeDir.startsWith(`..${sep}`) || relativeDir === ".." || isAbsolute(relativeDir) || !isWithinWorkspace(projectRoot, dir)) {
      throw failShadow("SHADOW_SCOPE_ESCAPED", "Shadow overlay path escapes the project workspace");
    }
    base = projectRoot;
    segments = relativeDir === "" ? [] : relativeDir.split(sep);
    root = dir;
  }

  let filePath = join(root, `${id}.md`);
  if (requestedFilePath !== undefined) {
    const requested = resolve(requestedFilePath);
    const stem = basename(requested).replace(/\.md$/i, "");
    if (dirname(requested) !== resolve(root) || !/\.md$/i.test(basename(requested)) || stem !== id) {
      throw failShadow("SHADOW_SCOPE_INVALID", "the selected overlay path is not the canonical writable file for this scope and ID");
    }
    filePath = requested;
  }
  return { base, segments, root, filePath, lockPath: filePath + LOCK_SUFFIX };
}

function assertOverlayPathSafe(paths: OverlayScopePaths): void {
  let current = paths.base;
  for (const segment of paths.segments) {
    current = join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw failShadow("SHADOW_SCOPE_ESCAPED", `overlay scope segment '${current}' is a symlink`);
      }
      if (!stats.isDirectory()) {
        throw failShadow("SHADOW_SCOPE_INVALID", `overlay scope segment '${current}' is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const stats = lstatSync(paths.filePath);
    if (stats.isSymbolicLink()) {
      throw failShadow("SHADOW_SCOPE_ESCAPED", `overlay file '${paths.filePath}' is a symlink`);
    }
    if (!stats.isFile()) {
      throw failShadow("SHADOW_SCOPE_INVALID", `overlay file '${paths.filePath}' is not a regular file`);
    }
    if (lstatSync(paths.lockPath).isSymbolicLink()) {
      throw failShadow("SHADOW_SCOPE_ESCAPED", `overlay lock '${paths.lockPath}' is a symlink`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function fingerprintContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Fingerprint a review carries for an overlay that does not exist yet. */
export const MISSING_OVERLAY_FINGERPRINT: string = fingerprintContent("");

async function readOverlayContent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Canonical, scope-checked overlay path for one scope and ID. */
export function shadowOverlayFilePath(
  scope: ShadowOverlayScope,
  cwd: string,
  id: string,
): string {
  const paths = resolveOverlayPaths(scope, cwd, id);
  assertOverlayPathSafe(paths);
  return paths.filePath;
}

export interface ShadowOverlaySnapshot {
  filePath: string;
  fingerprint: string;
  contextFingerprint: string;
  identity?: FileIdentity;
  content: string;
}

/**
 * Review-ready state for one overlay. A supplied `filePath` must be the exact
 * canonical writable path for the requested scope and ID; this prevents an
 * invalid-source path from being silently remapped to a sibling file.
 */
export async function readShadowOverlaySnapshot(
  scope: ShadowOverlayScope,
  cwd: string,
  id: string,
  context: { filePath?: string } = {},
): Promise<ShadowOverlaySnapshot> {
  const paths = resolveOverlayPaths(scope, cwd, id, context.filePath);
  assertOverlayPathSafe(paths);
  const content = await readOverlayContent(paths.filePath);
  const identity = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
  const preview = previewShadowDefinitionDeletion(cwd, {
    scope,
    filePath: paths.filePath,
  });
  return {
    filePath: paths.filePath,
    fingerprint: fingerprintContent(content),
    contextFingerprint: preview.contextFingerprint,
    ...(identity ? { identity } : {}),
    content,
  };
}

export async function writeShadowOverlay(
  input: {
    cwd: string;
    scope: ShadowOverlayScope;
    fields: ShadowDefinitionFields;
    reviewFingerprint: string;
    reviewContextFingerprint: string;
    reviewFilePath?: string;
    reviewIdentity?: FileIdentity;
  },
  testHooks: ShadowOverlayTestHooks = {},
): Promise<{ filePath: string; content: string }> {
  const paths = resolveOverlayPaths(input.scope, input.cwd, input.fields.id, input.reviewFilePath);
  assertOverlayPathSafe(paths);
  await mkdir(paths.root, { recursive: true });
  assertOverlayPathSafe(paths);

  const token = randomBytes(16).toString("hex");
  const lock = await acquireFileLock({
    lockPath: paths.lockPath,
    token,
    fail: failShadow,
    codes: SHADOW_LOCK_CODES,
    timing: testHooks,
    retryCount: testHooks.retryCount,
    retryDelayMs: testHooks.retryDelayMs,
  });
  if (!lock) {
    throw failShadow(
      "SHADOW_LOCK_TIMEOUT",
      `could not acquire the Shadow overlay lock '${paths.lockPath}' after retries`,
    );
  }

  let tempPath: string | undefined;
  let tempIdentity: Awaited<ReturnType<typeof createAtomicTempFile>> | undefined;
  try {
    assertOverlayPathSafe(paths);
    const currentContent = await readOverlayContent(paths.filePath);
    if (fingerprintContent(currentContent) !== input.reviewFingerprint) {
      throw failShadow(
        "SHADOW_STALE_REVIEW",
        "overlay changed since review; review the current file and try again",
      );
    }
    const reviewedIdentity = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
    const identityMatches = input.reviewIdentity
      ? Boolean(reviewedIdentity && sameFileIdentity(input.reviewIdentity, reviewedIdentity))
      : reviewedIdentity === undefined;
    if (!identityMatches) {
      throw failShadow("SHADOW_STALE_REVIEW", "overlay file identity changed since review; review the current file and try again");
    }

    let content: string;
    try {
      content = serializeShadowDefinition(input.fields);
    } catch (error) {
      throw failShadow(
        "SHADOW_CANDIDATE_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }

    // Complete effective-candidate validation: the serialized layer must
    // reparse and merge into a valid effective definition under exactly the
    // same package/agent/project context that the manager reviewed.
    const preview = previewShadowDefinition(input.cwd, {
      scope: input.scope,
      filePath: paths.filePath,
      content,
      expectedContextFingerprint: input.reviewContextFingerprint,
    });
    if (preview.errors.length > 0 || !preview.definition) {
      const contextChanged = preview.contextFingerprint !== input.reviewContextFingerprint;
      throw failShadow(
        contextChanged ? "SHADOW_STALE_REVIEW" : "SHADOW_CANDIDATE_INVALID",
        contextChanged
          ? "Shadow definition layers changed since review; review the current definition and try again"
          : `the effective definition is invalid: ${preview.errors.join(" ")}`,
      );
    }

    let mode = DEFAULT_FILE_MODE;
    const existing = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
    if (existing) {
      try {
        mode = lstatSync(paths.filePath).mode & 0o777;
      } catch {
        mode = DEFAULT_FILE_MODE;
      }
    }

    tempPath = join(paths.root, `.${input.fields.id}.${token}${TEMP_SUFFIX}`);
    tempIdentity = await createAtomicTempFile(failShadow, SHADOW_IDENTITY_CODES, tempPath, content, mode);
    await testHooks.beforeRename?.();
    assertOverlayPathSafe(paths);

    const latestContent = await readOverlayContent(paths.filePath);
    if (fingerprintContent(latestContent) !== input.reviewFingerprint) {
      throw failShadow(
        "SHADOW_STALE_REVIEW",
        "overlay changed while the reviewed update was being prepared",
      );
    }
    const latestIdentity = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
    const latestIdentityMatches = input.reviewIdentity
      ? Boolean(latestIdentity && sameFileIdentity(input.reviewIdentity, latestIdentity))
      : latestIdentity === undefined;
    if (!latestIdentityMatches) {
      throw failShadow("SHADOW_STALE_REVIEW", "overlay file identity changed while the reviewed update was being prepared");
    }
    const finalPreview = previewShadowDefinition(input.cwd, {
      scope: input.scope,
      filePath: paths.filePath,
      content,
      expectedContextFingerprint: input.reviewContextFingerprint,
    });
    if (finalPreview.contextFingerprint !== input.reviewContextFingerprint) {
      throw failShadow("SHADOW_STALE_REVIEW", "Shadow definition layers changed while the reviewed update was being prepared");
    }
    if (finalPreview.errors.length > 0 || !finalPreview.definition) {
      throw failShadow("SHADOW_CANDIDATE_INVALID", `the effective definition became invalid: ${finalPreview.errors.join(" ")}`);
    }
    const currentTempIdentity = await regularFileIdentity(failShadow, tempPath, "temporary overlay", SHADOW_IDENTITY_CODES);
    if (!currentTempIdentity || !sameFileIdentity(tempIdentity, currentTempIdentity)) {
      throw failShadow("SHADOW_TEMP_CHANGED", "temporary overlay identity changed before rename");
    }

    const renameFile = testHooks.rename ?? rename;
    try {
      await renameFile(tempPath, paths.filePath);
    } catch (error) {
      throw failShadow(
        "SHADOW_RENAME_FAILED",
        `atomic rename failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    tempPath = undefined;
    tempIdentity = undefined;
    return { filePath: paths.filePath, content };
  } finally {
    try {
      if (tempPath && tempIdentity) {
        await unlinkIfSameNode(failShadow, tempPath, tempIdentity, SHADOW_IDENTITY_CODES);
      }
    } finally {
      await releaseFileLock(failShadow, paths.lockPath, lock, SHADOW_IDENTITY_CODES);
    }
  }
}

export async function deleteShadowOverlay(
  input: {
    cwd: string;
    scope: ShadowOverlayScope;
    id: string;
    reviewFingerprint: string;
    reviewContextFingerprint: string;
    reviewIdentity?: FileIdentity;
    filePath?: string;
  },
  testHooks: ShadowOverlayTestHooks = {},
): Promise<{ removed: boolean; filePath: string }> {
  const paths = resolveOverlayPaths(input.scope, input.cwd, input.id, input.filePath);
  assertOverlayPathSafe(paths);

  const identity = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
  const identityMatches = input.reviewIdentity
    ? Boolean(identity && sameFileIdentity(input.reviewIdentity, identity))
    : identity === undefined;
  if (!identityMatches) {
    throw failShadow("SHADOW_STALE_REVIEW", "overlay file identity changed since review; review the current file and try again");
  }
  if (!identity) {
    if (input.reviewFingerprint !== MISSING_OVERLAY_FINGERPRINT) {
      throw failShadow("SHADOW_STALE_REVIEW", "overlay was removed since review; review the current definition and try again");
    }
    const preview = previewShadowDefinitionDeletion(input.cwd, {
      scope: input.scope,
      filePath: paths.filePath,
      expectedContextFingerprint: input.reviewContextFingerprint,
    });
    if (preview.contextFingerprint !== input.reviewContextFingerprint) {
      throw failShadow("SHADOW_STALE_REVIEW", "Shadow definition layers changed since review; review the current definition and try again");
    }
    return { removed: false, filePath: paths.filePath };
  }
  await mkdir(paths.root, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const lock = await acquireFileLock({
    lockPath: paths.lockPath,
    token,
    fail: failShadow,
    codes: SHADOW_LOCK_CODES,
    timing: testHooks,
    retryCount: testHooks.retryCount,
    retryDelayMs: testHooks.retryDelayMs,
  });
  if (!lock) {
    throw failShadow(
      "SHADOW_LOCK_TIMEOUT",
      `could not acquire the Shadow overlay lock '${paths.lockPath}' after retries`,
    );
  }

  try {
    const currentContent = await readOverlayContent(paths.filePath);
    if (fingerprintContent(currentContent) !== input.reviewFingerprint) {
      throw failShadow(
        "SHADOW_STALE_REVIEW",
        "overlay changed since review; review the current file and try again",
      );
    }
    const preview = previewShadowDefinitionDeletion(input.cwd, {
      scope: input.scope,
      filePath: paths.filePath,
      expectedContextFingerprint: input.reviewContextFingerprint,
    });
    if (preview.contextFingerprint !== input.reviewContextFingerprint) {
      throw failShadow(
        "SHADOW_STALE_REVIEW",
        "Shadow definition layers changed since review; review the current definition and try again",
      );
    }
    if (preview.errors.length > 0) {
      throw failShadow("SHADOW_CANDIDATE_INVALID", `the effective definition after deletion is invalid: ${preview.errors.join(" ")}`);
    }
    await testHooks.beforeRename?.();
    const finalPreview = previewShadowDefinitionDeletion(input.cwd, {
      scope: input.scope,
      filePath: paths.filePath,
      expectedContextFingerprint: input.reviewContextFingerprint,
    });
    if (finalPreview.contextFingerprint !== input.reviewContextFingerprint) {
      throw failShadow("SHADOW_STALE_REVIEW", "Shadow definition layers changed before deletion; review the current definition and try again");
    }
    if (finalPreview.errors.length > 0) {
      throw failShadow("SHADOW_CANDIDATE_INVALID", `the effective definition after deletion became invalid: ${finalPreview.errors.join(" ")}`);
    }
    const currentIdentity = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
    if (!currentIdentity || !sameFileIdentity(identity, currentIdentity)) {
      throw failShadow("SHADOW_STALE_REVIEW", "overlay identity changed since review; review the current file and try again");
    }
    if (!await unlinkIfSameNode(failShadow, paths.filePath, currentIdentity, SHADOW_IDENTITY_CODES)) {
      throw failShadow("SHADOW_STALE_REVIEW", "overlay changed before deletion; review the current file and try again");
    }
    return { removed: true, filePath: paths.filePath };
  } finally {
    await releaseFileLock(failShadow, paths.lockPath, lock, SHADOW_IDENTITY_CODES);
  }
}
