import { stat } from "node:fs/promises";
import { runAnchoredRead, type ReadModelContent } from "./operations.ts";

export type { ReadModelContent };
import { resolveTarget } from "./fs-write.ts";
import { toCwd } from "./paths.ts";
import { errCode } from "./utils.ts";
import { PARENT_OWNER } from "./workspace-support.ts";
import { pruneMissingForAllOwners } from "./partitions.ts";

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
 * Path policy for the anchored read surfaces: Pi 0.84.2's native path
 * authority — absolute paths, `~` paths, cwd-relative paths (including
 * `../`), and canonical targets reached through symlinks — under the same OS
 * permissions as Pi's native read (#185, #186). The retired
 * workspace-confinement mode is gone; external targets keep the initiating
 * workspace's snapshot/served state and lock area, so two workspaces never
 * share state or locks for the same external file while two sessions in one
 * workspace still coordinate.
 */
export interface AnchoredReadPathOptions {
  /**
   * Persistent session directory of the initiating session, used to locate the
   * anchor store (`<sessionDir>/anchored-edit/`). Undefined or "" selects the
   * throwaway temp-directory fallback for non-persisted sessions. Child
   * compositions pass the parent session's directory captured at assembly time.
   */
  sessionDir?: string;
}

/** Resolves a read path with Pi's native semantics; a missing target resolves
 *  instead of throwing, so Pi's factory can produce its own native not-found
 *  result. */
async function resolveReadTarget(cwd: string, requestedPath: string): Promise<string> {
  return resolveTarget(toCwd(requestedPath, cwd));
}

export async function guardAnchoredRead(
  value: unknown,
  cwd: string,
): Promise<ReadModelContent | undefined> {
  const params = readParams(value);
  if (!params) return undefined;

  let resolved: string;
  try {
    resolved = await resolveReadTarget(cwd, params.path);
  } catch (error) {
    return errorText("E_READ_PATH", `Cannot resolve ${params.path}: ${errorMessage(error)}`);
  }

  try {
    const fileStat = await stat(resolved);
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

/**
 * Post-factory content transform delegating to the integrated anchored read
 * operation: the target exclusion is held from the byte read through
 * committing the matching snapshot and served hashes, so the anchors shown
 * describe exactly the bytes read. Contended reads return the classified
 * `[E_FILE_LOCKED]` contention instead of unanchored content presented as
 * anchored evidence; image targets and native not-found failures pass the
 * factory result through unchanged.
 */
export async function transformAnchoredReadContent(
  content: ReadModelContent,
  value: unknown,
  cwd: string,
  owner: string = PARENT_OWNER,
  options: AnchoredReadPathOptions = {},
): Promise<ReadModelContent> {
  const params = readParams(value);
  if (!params) return content;

  try {
    const result = await runAnchoredRead({
      cwd,
      requestedPath: params.path,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      owner,
      sessionDir: options.sessionDir,
    });
    if (result.status === "passthrough") return content;
    if (result.status === "locked") return textContent(result.message);
    return result.content;
  } catch (error) {
    if (errCode(error) === "ENOENT") return content;
    return errorText(
      "E_READ_FAILED",
      `${errorMessage(error)} Disable anchoredEditing.enabled to use Pi's built-in read for this path.`,
    );
  }
}
