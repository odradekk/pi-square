import { Type } from "typebox";
import {
  type LineEnding,
} from "./replace-diff";
import { readNormFile } from "./file-reader";
import { isRec, rejectUnknownFields } from "./utils";
import { applyEdit,
  lineHashes,
  resEdit,
  parseHashRef,
  MAX_HASH_LINES,
  RangeStaleError,
  AnchorMismatchError,
  type HEdit,
  type NEdit,
} from "./hashline";
import {
  type RMetrics,
} from "./replace-response";
import { findSnapshotPaths, type HashStore } from "./hash-store";
import { getServed, recordServedSafe } from "./served";

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
};

interface PipelineResult {
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
  store: HashStore,
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
  const matches = findSnapshotPaths(store, hashes);
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

export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  /** Explicit anchor store; required so no call site falls back to an implicit global store. */
  store: HashStore;
  noPersist?: boolean;
  /**
   * Forces the range-served verification even when the calling owner has no
   * served record for the path. A missing record then behaves as an empty set,
   * so a child that names anchors it never read for itself is refused and
   * receives the current range with fresh anchors. The parent leaves this off
   * to preserve its existing edit-without-prior-read behaviour.
   */
  requireServed?: boolean;
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

export async function execPipeline(
  params: ReqParams,
  cwd: string,
  options: ExecPipelineOptions,
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
    path, cwd, { signal: options.signal, accessMode: options.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: options.noPersist },
  );

  const servedRow = await getServed(hashStore, absolutePath);
  const served = options.requireServed === true && servedRow === undefined
    ? new Set<string>()
    : servedRow;
  let anchorResult: ReturnType<typeof applyEdit>;
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
    if (options.noPersist !== true) {
      if (error instanceof RangeStaleError) {
        await recordServedSafe(absolutePath, error.rangeHashes, "range-stale feedback", hashStore);
      } else if (error instanceof AnchorMismatchError) {
        await recordServedSafe(absolutePath, error.feedbackHashes, "anchor-mismatch feedback", hashStore);
      }
    }
    throw error;
  }

  const result = anchorResult.content;
  const isNoop = result === originalNormalized;

  const noPersist = options.noPersist;
  const removedHashes = isNoop
    ? undefined
    : collectRemovedHashes(edit, originalHashes);
  const resultHashes = isNoop
    ? originalHashes
    : await lineHashes(result, absolutePath, {
        content: originalNormalized,
        hashes: originalHashes,
        removedHashes,
      }, hashStore, noPersist !== true);
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

