/**
 * Safe Shadow definition overlay writer (odradekk/pi-square#149, slice #154).
 *
 * Every persistent change to an agent or trusted-project overlay goes through
 * this module: canonical scope resolution, project-trust enforcement, symlink
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
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  acquireFileLock,
  createAtomicTempFile,
  regularFileIdentity,
  releaseFileLock,
  sameFileIdentity,
  unlinkIfSameNode,
  type SafeWriteTiming,
} from "../core/safe-write";
import { getAgentPath, isWithinWorkspace } from "../core/paths";
import { previewShadowDefinition, shadowProjectScopeLocation } from "./definitions";
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
): OverlayScopePaths {
  if (!SHADOW_ID_PATTERN.test(id)) {
    throw failShadow("SHADOW_CANDIDATE_INVALID", `Shadow definition id must match ${SHADOW_ID_PATTERN} (got '${id}').`);
  }
  if (scope === "agent") {
    const base = canonicalExistingDirectory(getAgentPath(), "agent directory");
    const segments = ["shadow-minds"];
    const root = join(base, ...segments);
    const filePath = join(root, `${id}.md`);
    return { base, segments, root, filePath, lockPath: filePath + LOCK_SUFFIX };
  }
  const walked = shadowProjectScopeLocation(cwd);
  if (walked?.error) {
    throw failShadow("SHADOW_SCOPE_INVALID", walked.error);
  }
  // Writes follow discovery: an existing ancestor `.pi/shadow-minds` is the
  // canonical target, otherwise the workspace-local default is created. The
  // base for containment checks is the location's own project root, so a
  // canonical overlay path can never escape the workspace that reviews it.
  const projectRoot = walked ? walked.projectRoot : canonicalExistingDirectory(cwd, "project directory");
  const dir = walked ? walked.dir : join(projectRoot, ".pi", "shadow-minds");
  const relativeDir = relative(projectRoot, dir);
  if (relativeDir.startsWith(`..${sep}`) || relativeDir === ".." || isAbsolute(relativeDir) || !isWithinWorkspace(projectRoot, dir)) {
    throw failShadow("SHADOW_SCOPE_ESCAPED", "Shadow overlay path escapes the project workspace");
  }
  const segments = relativeDir === "" ? [] : relativeDir.split(sep);
  return { base: projectRoot, segments, root: dir, filePath: join(dir, `${id}.md`), lockPath: join(dir, `${id}.md`) + LOCK_SUFFIX };
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

function assertProjectWritable(scope: ShadowOverlayScope, projectTrusted: boolean): void {
  if (scope === "project" && !projectTrusted) {
    throw failShadow(
      "SHADOW_PROJECT_UNTRUSTED",
      "project-scope Shadow overlays require a trusted project",
    );
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

/**
 * Reviews-ready state for one overlay: its canonical path plus the
 * fingerprint of the exact current content (empty string when absent).
 */
export async function readShadowOverlaySnapshot(
  scope: ShadowOverlayScope,
  cwd: string,
  id: string,
  context: { projectTrusted: boolean },
): Promise<{ filePath: string; fingerprint: string }> {
  assertProjectWritable(scope, context.projectTrusted);
  const paths = resolveOverlayPaths(scope, cwd, id);
  assertOverlayPathSafe(paths);
  return { filePath: paths.filePath, fingerprint: fingerprintContent(await readOverlayContent(paths.filePath)) };
}

export async function writeShadowOverlay(
  input: {
    cwd: string;
    projectTrusted: boolean;
    scope: ShadowOverlayScope;
    fields: ShadowDefinitionFields;
    reviewFingerprint: string;
  },
  testHooks: ShadowOverlayTestHooks = {},
): Promise<{ filePath: string; content: string }> {
  assertProjectWritable(input.scope, input.projectTrusted);
  const paths = resolveOverlayPaths(input.scope, input.cwd, input.fields.id);
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
    // reparse and merge into a valid effective definition under the current
    // on-disk state of every other layer.
    const preview = previewShadowDefinition(input.cwd, {
      projectTrusted: input.projectTrusted,
      scope: input.scope,
      filePath: paths.filePath,
      content,
    });
    if (preview.errors.length > 0 || !preview.definition) {
      throw failShadow(
        "SHADOW_CANDIDATE_INVALID",
        `the effective definition is invalid: ${preview.errors.join(" ")}`,
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
    projectTrusted: boolean;
    scope: ShadowOverlayScope;
    id: string;
    reviewFingerprint: string;
  },
  testHooks: ShadowOverlayTestHooks = {},
): Promise<{ removed: boolean; filePath: string }> {
  assertProjectWritable(input.scope, input.projectTrusted);
  const paths = resolveOverlayPaths(input.scope, input.cwd, input.id);
  assertOverlayPathSafe(paths);

  const identity = await regularFileIdentity(failShadow, paths.filePath, "overlay file", SHADOW_IDENTITY_CODES);
  if (!identity) return { removed: false, filePath: paths.filePath };

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
    try {
      await unlink(paths.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, filePath: paths.filePath };
      throw error;
    }
    return { removed: true, filePath: paths.filePath };
  } finally {
    await releaseFileLock(failShadow, paths.lockPath, lock, SHADOW_IDENTITY_CODES);
  }
}
