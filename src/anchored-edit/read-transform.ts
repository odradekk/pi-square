import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isWithinWorkspace } from "../core/paths.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile } from "./file-reader.ts";
import { resolveTarget } from "./fs-write.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { anchoredStoreDir, toCwd } from "./paths.ts";
import { fmtReadPreview } from "./read.ts";
import { recordServed } from "./served.ts";
import { errCode } from "./utils.ts";
import { PARENT_OWNER, loadAnchoredHashStore } from "./workspace-support.ts";
import { pruneMissingForAllOwners } from "./partitions.ts";

export type ReadModelContent = AgentToolResult<unknown>["content"];

function textContent(text: string): ReadModelContent {
  return [{ type: "text", text }];
}

function errorText(code: string, message: string): ReadModelContent {
  return textContent(`[${code}] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readParams(value: unknown): { path: string; offset?: number; limit?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  if (typeof params.path !== "string") return undefined;
  return {
    path: params.path,
    ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

/**
 * Path policy for the anchored read surfaces (#185). The parent passes
 * `confineToWorkspace: false` so anchored read preserves Pi 0.84.2's native
 * path authority: absolute paths, `~` paths, cwd-relative paths (including
 * `../`), and canonical targets reached through symlinks, all under the same
 * OS permissions as Pi's native read. Child surfaces keep the default
 * workspace containment; the writable-child composition passes false (#186).
 *
 * External targets keep the initiating workspace's snapshot/served state and
 * lock area: two different workspaces intentionally do not share state or
 * locks for the same external file (accepted last-write-wins, matching Pi's
 * native cross-workspace behavior), while two sessions in one workspace
 * still coordinate through that workspace's shared store and locks.
 */
export interface AnchoredReadPathOptions {
  confineToWorkspace?: boolean;
  /**
   * Persistent session directory of the initiating session, used to locate the
   * anchor store (`<sessionDir>/anchored-edit/`). Undefined or "" selects the
   * throwaway temp-directory fallback for non-persisted sessions. Child
   * compositions pass the parent session's directory captured at assembly time.
   */
  sessionDir?: string;
}
interface ResolvedReadTarget {
  workspaceRoot: string;
  absolutePath: string;
}

/** Resolves a read path with Pi's native semantics: normalize (~, `@`,
 *  unicode spaces, file:// URLs), resolve against the execution cwd, then
 *  canonicalize existing segments through symlinks. Unlike a realpath probe,
 *  a missing target resolves instead of throwing, so Pi's factory can produce
 *  its own native not-found result. */
async function resolveReadTarget(cwd: string, requestedPath: string): Promise<ResolvedReadTarget> {
  const workspaceRoot = realpathSync(cwd);
  const absolutePath = await resolveTarget(toCwd(requestedPath, cwd));
  return { workspaceRoot, absolutePath };
}

export async function guardAnchoredRead(
  value: unknown,
  cwd: string,
  options: AnchoredReadPathOptions = {},
): Promise<ReadModelContent | undefined> {
  const params = readParams(value);
  if (!params) return undefined;
  const confineToWorkspace = options.confineToWorkspace ?? true;

  let resolved;
  try {
    resolved = await resolveReadTarget(cwd, params.path);
  } catch (error) {
    return errorText("E_READ_PATH", `Cannot resolve ${params.path}: ${errorMessage(error)}`);
  }
  if (confineToWorkspace && !isWithinWorkspace(resolved.workspaceRoot, resolved.absolutePath)) {
    return errorText(
      "E_OUTSIDE_WORKSPACE",
      `${params.path} resolves outside the workspace. Disable anchoredEditing.enabled to use Pi's built-in read for that path.`,
    );
  }

  try {
    const fileStat = await stat(resolved.absolutePath);
    if (fileStat.isDirectory()) {
      return errorText("E_READ_FAILED", `[E_NOT_TEXT] Path is a directory: ${params.path}. Use ls to inspect directories.`);
    }
    if (!fileStat.isFile()) {
      return errorText("E_READ_FAILED", `[E_NOT_TEXT] Path is not a regular file: ${params.path}.`);
    }
  } catch {
    // Let Pi's factory preserve its standard not-found and access errors.
  }
  return undefined;
}

export async function initializeAnchoredReadStore(cwd: string, sessionDir?: string): Promise<void> {
  await pruneMissingForAllOwners(cwd, sessionDir);
}
export async function transformAnchoredReadContent(
  content: ReadModelContent,
  value: unknown,
  cwd: string,
  owner: string = PARENT_OWNER,
  options: AnchoredReadPathOptions = {},
): Promise<ReadModelContent> {
  const params = readParams(value);
  if (!params) return content;
  const confineToWorkspace = options.confineToWorkspace ?? true;

  let resolved;
  try {
    resolved = await resolveReadTarget(cwd, params.path);
  } catch (error) {
    return errorText("E_READ_PATH", `Cannot resolve ${params.path}: ${errorMessage(error)}`);
  }
  if (confineToWorkspace && !isWithinWorkspace(resolved.workspaceRoot, resolved.absolutePath)) {
    return errorText(
      "E_OUTSIDE_WORKSPACE",
      `${params.path} resolves outside the workspace. Disable anchoredEditing.enabled to use Pi's built-in read for that path.`,
    );
  }

  let file;
  try {
    file = await loadFileKindAndText(resolved.absolutePath, {
      maxLines: MAX_HASH_LINES,
      displayPath: params.path,
    });
  } catch (error) {
    // The factory already produced its own native not-found result; pass it
    // through unchanged instead of replacing it with anchored wording.
    if (errCode(error) === "ENOENT") return content;
    return errorText("E_READ_FAILED", errorMessage(error));
  }
  if (file.kind === "image") return content;

  try {
    // Native path authority (#185): the store stays attributed to the
    // initiating session even for external targets, so served rows for the
    // same external file in two workspaces never mix.
    const store = await loadAnchoredHashStore(
      anchoredStoreDir(options.sessionDir, resolved.workspaceRoot),
      owner,
    );
    try {
      const normalized = await readNormFile(params.path, resolved.workspaceRoot, {
        preloadedFile: file,
        maxLines: MAX_HASH_LINES,
        store,
      });
      const preview = await fmtReadPreview(
        normalized.normalized,
        { offset: params.offset, limit: params.limit },
        normalized.fileHashes,
      );
      recordServed(store, normalized.absolutePath, preview.servedHashes);
      const text = normalized.hadUtf8DecodeErrors
        ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
        : preview.text;
      return textContent(text);
    } finally {
      store.release();
    }
  } catch (error) {
    return errorText(
      "E_READ_FAILED",
      `${errorMessage(error)} Disable anchoredEditing.enabled to use Pi's built-in read for this path.`,
    );
  }
}
