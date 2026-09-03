import { Type } from "typebox";
import {
	type LineEnding,
} from "./replace-diff";
import { readNormFile } from "./file-reader";
import { isRec, rejectUnknownFields } from "./utils";
import {
	applyEdit,
	lineHashes,
	resEdit,
	parseHashRef,
	MAX_HASH_LINES,
	AnchorMismatchError,
	RangeStaleError,
	type HEdit,
	type NEdit,
} from "./hashline";
import {
	type RMetrics,
} from "./replace-response";
import { type HashStoreHandle } from "./hash-store";

const replacementTextSchema = Type.String({
  description:
    "Replacement text as a single string with \\n line separators; every \\n separates lines, so a trailing \\n adds a final empty line. Mirror the removed lines exactly, blank lines included. A replacement that is only blank lines is written as one \\n per blank line. Use \"\" to delete the range."
});

const removeFromSchema = Type.String({
  description: "Bare 3-char HASH only (e.g. \"aB3\") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the FIRST line to remove (inclusive)",
});

const removeToSchema = Type.String({
  description: "Bare 3-char HASH only (e.g. \"aB3\") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the LAST line to remove (inclusive)",
});

export const editToolSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchors as a fallback when omitted by mistake." })),
    remove_from: removeFromSchema,
    remove_to: removeToSchema,
    replacement_text: replacementTextSchema,
  },
  { additionalProperties: false },
);
export type ReqParams = {
  path: string;
  remove_from: string;
  remove_to: string;
  replacement_text: string;
};

type ReqParamsWithOptionalPath = Omit<ReqParams, "path"> & { path?: string };

export type ReplaceDetails = {
  diff: string;
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
  status?: "warning";
  errorCode?: string;
  /** Structured warnings from the executor; the model result and operational
   *  display consume this instead of parsing rendered prose. */
  warnings?: string[];
};

export interface PipelineResult {
  path: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  noopEdit?: NEdit;
  firstChangedLine?: number;
  lastChangedLine?: number;
  originalHashes: string[];
  resultHashes: string[];
  totalAddedLines: number;
  totalRemovedLines: number;
}

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_text"]);

export function assertReq(request: unknown): asserts request is ReqParams;
export function assertReq(
  request: unknown,
  options: { allowMissingPath: true },
): asserts request is ReqParamsWithOptionalPath;
export function assertReq(
  request: unknown,
  { allowMissingPath = false }: { allowMissingPath?: boolean } = {},
): void {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }

  rejectUnknownFields(request, ROOT_KS, "Edit request");

  const hasPath = Object.hasOwn(request, "path");
  if (
    (hasPath && (typeof request.path !== "string" || request.path.length === 0))
    || (!hasPath && !allowMissingPath)
  ) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }

  if (
    typeof request.remove_from !== "string" ||
    typeof request.remove_to !== "string" ||
    typeof request.replacement_text !== "string"
  ) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_text" at the top level.',
    );
  }
}

export async function resolveMissingPath(
  request: Record<string, unknown>,
  store: HashStoreHandle,
): Promise<{ path: string; warning: string } | undefined> {
  if (Object.hasOwn(request, "path")) return undefined;
  const from = request.remove_from;
  const to = request.remove_to;
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const hashes: string[] = [];
  for (const ref of [from, to]) {
    try {
      hashes.push(parseHashRef(ref).hash);
    } catch {
      return undefined;
    }
  }
  const matches = store.findSnapshotPaths(hashes);
  if (matches.length === 1) {
    return {
      path: matches[0]!,
      warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`,
    );
  }
  return undefined;
}

export interface PrepareOptions {
  accessMode?: number;
  signal?: AbortSignal;
  /** Explicit anchor store; required so no call site falls back to an implicit global store. */
  store: HashStoreHandle;
  /**
   * Forces the range-served verification even when the calling owner has no
   * served record for the path. A missing record then behaves as an empty set,
   * so a child that names anchors it never read for itself is refused and
   * receives the current range with fresh anchors. The parent leaves this off
   * to preserve its existing edit-without-prior-read behaviour.
   */
  requireServed?: boolean;
  /**
   * The boundary-locked canonical target for `path`. When set, the byte
   * read, authorization, and store keys observe exactly this frozen target
   * instead of re-resolving the request path, so a symlink retargeted after
   * the boundary acquisition cannot redirect the operation.
   */
  canonicalPath?: string;
}

function collectRemovedHashes(
  edit: HEdit,
  originalHashes: string[],
): Set<string> {
  const removedHashes = new Set<string>();
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const startLine = originalHashes.indexOf(startHash);
  const endLine = originalHashes.indexOf(endHash);
  if (startLine >= 0 && endLine >= 0) {
    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    for (let i = firstLine; i <= lastLine; i++) {
      removedHashes.add(originalHashes[i]!);
    }
  }
  return removedHashes;
}

function countLineChanges(
  edit: HEdit,
  originalHashes: string[],
  isNoop: boolean,
  removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  let totalRemovedLines = 0;
  const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
  const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
  if (startLine >= 0 && endLine >= 0) {
    totalRemovedLines = Math.abs(endLine - startLine) + 1;
  }
  return {
    totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
    totalRemovedLines,
  };
}

/**
 * Pure replace preparation: resolves and validates the range and computes the
 * replacement content and hashes without changing persistent or cached state.
 * The candidate snapshot is committed only after the filesystem write
 * succeeds (see `publishMutation`, called from the operation boundary while
 * the target exclusion is still held). Validation failures throw
 * `ReplaceValidationError` (wrapping `RangeStaleError`/`AnchorMismatchError`
 * with the observed content) when the owner had served rows for the path, or
 * the underlying error when it had none; the coordinator publishes the shown
 * feedback rows version-bound from inside the boundary.
 */
export async function prepareReplace(
  params: ReqParams,
  cwd: string,
  options: PrepareOptions,
): Promise<PipelineResult> {
  const path = params.path;

  const editWarnings: string[] = [];
  const edit = resEdit(
    {
      remove_from: params.remove_from,
      remove_to: params.remove_to,
      replacement_text: params.replacement_text,
    },
    editWarnings,
  );

  const hashStore = options.store;
  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath } = await readNormFile(
    options.canonicalPath ?? path, cwd, { signal: options.signal, accessMode: options.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: true },
  );

  // Authorization is bound to the content version the rows were served for.
  // No rows and no verification requirement leaves the parent's
  // edit-without-prior-read path; rows for another version are stale for
  // every owner and authorize nothing (an empty set verifies no range, so
  // the refusal carries the current range with fresh anchors for the
  // immediate retry).
  const servedLookup = hashStore.getServedState(absolutePath, originalNormalized);
  let served: Set<string> | undefined;
  if (servedLookup !== undefined && "served" in servedLookup) {
    served = servedLookup.served;
  } else if (servedLookup !== undefined) {
    served = new Set<string>();
  } else if (options.requireServed === true) {
    served = new Set<string>();
  }
  let anchorResult;
  try {
    anchorResult = applyEdit(
      originalNormalized,
      edit,
      options.signal,
      originalHashes,
      path,
      served,
    );
  } catch (error) {
    if (error instanceof RangeStaleError || error instanceof AnchorMismatchError) {
      // The refusal's feedback rows were observed under the operation
      // boundary; wrapping them with the exact content they belong to lets
      // the coordinator publish them version-bound so the immediate retry is
      // authorized while any older version stays unusable.
      throw new ReplaceValidationError(error, originalNormalized);
    }
    throw error;
  }

  const result = anchorResult.content;
  const isNoop = result === originalNormalized;

  const removedHashes = isNoop
    ? undefined
    : collectRemovedHashes(edit, originalHashes);
  const resultHashes = isNoop
    ? originalHashes
    : await lineHashes(result, absolutePath, {
        content: originalNormalized,
        hashes: originalHashes,
        removedHashes,
      }, hashStore, false);
  const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])];
  const { totalAddedLines, totalRemovedLines } = countLineChanges(
    edit, originalHashes, isNoop, anchorResult.autoFixes?.length ?? 0,
  );

  return {
    path,
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    noopEdit: anchorResult.noopEdit,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    resultHashes,
    originalHashes,
    totalAddedLines,
    totalRemovedLines,
  };
}

/**
 * Validation failure carrying the exact content the feedback rows were
 * observed for. The operation coordinator catches it inside the target
 * boundary and publishes the feedback hashes version-bound (see
 * `runAnchoredReplace`), so the model's immediate retry with the fresh
 * anchors verifies while rows recorded for any other content version do not.
 */
export class ReplaceValidationError extends Error {
  readonly anchorError: RangeStaleError | AnchorMismatchError;
  readonly content: string;
  constructor(cause: RangeStaleError | AnchorMismatchError, content: string) {
    super(cause.message, { cause });
    this.name = "ReplaceValidationError";
    this.anchorError = cause;
    this.content = content;
  }
  get feedbackHashes(): string[] {
    return this.anchorError instanceof RangeStaleError ? this.anchorError.rangeHashes : this.anchorError.feedbackHashes;
  }
}

export { RangeStaleError, AnchorMismatchError } from "./hashline";
