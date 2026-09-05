import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { LineEnding } from "./replace-diff";
import { readNormFile } from "./file-reader";
import { HASH_CLASS, HASH_SEP, MAX_HASH_LINES } from "./hashline";
import { AnchorMismatchError, RangeStaleError } from "./hashline";
import { lineHashes } from "./hashline";
import { buildMetrics, type RMetrics } from "./replace-response";
import { genDiff } from "./replace-diff";
import { isRec, rejectUnknownFields, splitLines, clipLine } from "./utils";
import type { HashStoreHandle } from "./hash-store";

const INSERT_DIRECTIONS = ["before", "after"] as const;
export type InsertDirection = (typeof INSERT_DIRECTIONS)[number];

const anchorSchema = Type.String({
  description:
    "Bare 3-char HASH only (e.g. \"aB3\") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. The line keeps its content; the new lines are inserted immediately before or after it",
});

const directionSchema = StringEnum(INSERT_DIRECTIONS, {
  description: "Whether the new lines are inserted immediately before or immediately after the anchor line",
});

const linesSchema = Type.Array(Type.String(), {
  description:
    "One or more literal lines to insert, in order. Each item is exactly one logical line: no \\n or \\r inside an item (use separate items instead). Every item must be non-empty — to add a blank line use replace. Lines are inserted literally: no read/diff prefixes are stripped and duplicates are kept",
  minItems: 1,
});

export const insertToolSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchor as a fallback when omitted by mistake." })),
    anchor: anchorSchema,
    direction: directionSchema,
    lines: linesSchema,
  },
  { additionalProperties: false },
);
export type InsertParams = {
  path: string;
  anchor: string;
  direction: InsertDirection;
  lines: string[];
};

type InsertParamsWithOptionalPath = Omit<InsertParams, "path"> & { path?: string };

export type InsertDetails = {
  diff: string;
  firstChangedLine?: number;
  snapshotId?: string;
  metrics?: RMetrics;
  status?: "warning";
  errorCode?: string;
  /** Structured warnings from the executor; the model result and operational
   *  display consume this instead of parsing rendered prose. */
  warnings?: string[];
};

export interface InsertPipelineResult {
  path: string;
  anchorLine: number;
  direction: InsertDirection;
  insertedLines: string[];
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  firstChangedLine: number;
  lastChangedLine: number;
  originalHashes: string[];
  resultHashes: string[];
}

const ROOT_KS = new Set(["path", "anchor", "direction", "lines"]);

const isInsertDirection = (value: unknown): value is InsertDirection =>
  (INSERT_DIRECTIONS as readonly string[]).includes(value as string);

export function assertInsertReq(request: unknown): asserts request is InsertParams;
export function assertInsertReq(
  request: unknown,
  options: { allowMissingPath: true },
): asserts request is InsertParamsWithOptionalPath;
export function assertInsertReq(
  request: unknown,
  { allowMissingPath = false }: { allowMissingPath?: boolean } = {},
): void {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Insert request must be an object.");
  }

  rejectUnknownFields(request, ROOT_KS, "Insert request");

  const hasPath = Object.hasOwn(request, "path");
  if (
    (hasPath && (typeof request.path !== "string" || request.path.length === 0))
    || (!hasPath && !allowMissingPath)
  ) {
    throw new Error('[E_BAD_SHAPE] Insert request requires a non-empty "path" string.');
  }

  if (typeof request.anchor !== "string") {
    throw new Error(
      '[E_BAD_SHAPE] Insert request requires "anchor", "direction", and "lines" at the top level.',
    );
  }
  if (!isInsertDirection(request.direction)) {
    throw new Error(
      '[E_BAD_SHAPE] Insert request "direction" must be one of: before, after.',
    );
  }
  if (!Array.isArray(request.lines)) {
    throw new Error(
      '[E_BAD_SHAPE] Insert request "lines" must be an array of one or more non-empty strings.',
    );
  }
  if (request.lines.length === 0) {
    throw new Error(
      '[E_BAD_SHAPE] Insert request "lines" must contain at least one line; an empty insert would change nothing.',
    );
  }
  for (const [index, line] of request.lines.entries()) {
    if (typeof line !== "string") {
      throw new Error(
        `[E_BAD_SHAPE] Insert request "lines" item ${index + 1} must be a string, not ${typeof line}.`,
      );
    }
    if (line.length === 0) {
      throw new Error(
        `[E_BAD_SHAPE] Insert request "lines" item ${index + 1} is empty. Blank-line insertion is not supported by insert in this version; every item must be one non-empty logical line (use replace to add blank lines).`,
      );
    }
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error(
        `[E_BAD_SHAPE] Insert request "lines" item ${index + 1} contains an embedded newline. Each item is exactly one logical line; pass additional items instead of a multi-line string.`,
      );
    }
  }
}

/** The recognized anchor forms: a bare hash, a copied read row `HASH│…`, or a
 *  copied added diff row `+HASH│…`. A removed diff row is not a recognized
 *  insert anchor form: its line no longer exists in the file. */
const ANCHOR_ROW_RE = new RegExp(`^(\\+?)(${HASH_CLASS})│`);

/** Resolves the public anchor form to a bare 3-char hash. A recognized read
 *  row or added-diff prefix is stripped with an `[E_BAD_REF]` warning; any
 *  other shape is rejected. Pure: performs no file I/O. */
export function resInsertAnchor(anchor: string, warnings?: string[]): string {
  const trimmed = anchor.trim();
  const match = trimmed.match(ANCHOR_ROW_RE);
  if (match) {
    warnings?.push(
      match[1]
        ? `[E_BAD_REF] Autocorrected: stripped diff-preview marker copied from the diff preview in the anchor entry "${trimmed}".`
        : `[E_BAD_REF] Autocorrected: stripped "HASH│" prefix copied from read output in the anchor entry "${trimmed}".`,
    );
    return match[2]!;
  }
  if (trimmed.length === 3 && new RegExp(`^${HASH_CLASS}$`).test(trimmed)) {
    return trimmed;
  }
  if (/^\d+/.test(trimmed)) {
    throw new Error(
      `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`,
    );
  }
  if (trimmed.includes("│")) {
    throw new Error(
      `[E_BAD_REF] Invalid anchor "${trimmed}". The anchor must contain the 3-char hash only — remove everything from "│" onward, and do not copy removed "-" diff rows.`,
    );
  }
  throw new Error(
    `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-char alphanumeric anchor (e.g. "aB3").`,
  );
}

/** Tolerant anchor parse for the omitted-path recovery: a malformed anchor
 *  yields undefined instead of throwing, so the caller falls through to the
 *  ordinary missing-path refusal. */
function tryAnchorHash(anchor: unknown): string | undefined {
  if (typeof anchor !== "string") return undefined;
  try {
    return resInsertAnchor(anchor);
  } catch {
    return undefined;
  }
}

export async function resolveMissingInsertPath(
  request: Record<string, unknown>,
  store: HashStoreHandle,
): Promise<{ path: string; warning: string } | undefined> {
  if (Object.hasOwn(request, "path")) return undefined;
  const hash = tryAnchorHash(request.anchor);
  if (hash === undefined) return undefined;
  const matches = store.findSnapshotPaths([hash]);
  if (matches.length === 1) {
    return {
      path: matches[0]!,
      warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain the anchor.`,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `[E_BAD_SHAPE] Insert request requires a non-empty "path" string; the anchor matches multiple known files: ${matches.join(", ")}. Include the intended path.`,
    );
  }
  return undefined;
}

export interface InsertPrepareOptions {
  accessMode?: number;
  signal?: AbortSignal;
  /** Explicit anchor store; required so no call site falls back to an implicit global store. */
  store: HashStoreHandle;
  /**
   * The boundary-locked canonical target for `path`; see prepareReplace for
   * the frozen-target contract.
   */
  canonicalPath?: string;
}

/** Bounded anchored context rows around one resolved line, in read-row shape
 *  so the model can copy them directly into a retry. */
function contextRows(
  centerLine: number,
  fileLines: string[],
  fileHashes: string[],
  span = 1,
): { rows: string[]; hashes: string[] } {
  const from = Math.max(1, centerLine - span);
  const to = Math.min(fileLines.length, centerLine + span);
  const rows: string[] = [];
  const hashes: string[] = [];
  for (let line = from; line <= to; line++) {
    hashes.push(fileHashes[line - 1]!);
    rows.push(`${fileHashes[line - 1]}${HASH_SEP}${clipLine(fileLines[line - 1] ?? "")}`);
  }
  return { rows, hashes };
}

/**
 * Validation failure carrying the exact content the feedback rows were
 * observed for. The operation coordinator catches it inside the target
 * boundary and publishes the feedback hashes version-bound (see
 * `runAnchoredInsert`), so the model's immediate retry with the fresh
 * anchors verifies while rows recorded for any other content version do not.
 */
export class InsertValidationError extends Error {
  readonly anchorError: RangeStaleError | AnchorMismatchError;
  readonly content: string;
  constructor(cause: RangeStaleError | AnchorMismatchError, content: string) {
    super(cause.message, { cause });
    this.name = "InsertValidationError";
    this.anchorError = cause;
    this.content = content;
  }
  get feedbackHashes(): string[] {
    return this.anchorError instanceof RangeStaleError ? this.anchorError.rangeHashes : this.anchorError.feedbackHashes;
  }
}

/**
 * Pure insert preparation: resolves and validates the anchor against the
 * current file and computes the inserted content and hashes without changing
 * persistent or cached state. The candidate snapshot is committed only after
 * the filesystem write succeeds (see `publishMutation`, called from the
 * operation boundary while the target exclusion is still held).
 *
 * Authorization is mandatory for every owner, the parent included: the target
 * anchor must be served for the exact current content version. Unlike
 * `prepareReplace` there is no edit-without-prior-read path, because an
 * insert adds content adjacent to a line the caller must have observed.
 */
export async function prepareInsert(
  params: InsertParams,
  cwd: string,
  options: InsertPrepareOptions,
): Promise<InsertPipelineResult> {
  const path = params.path;

  const warnings: string[] = [];
  const anchorHash = resInsertAnchor(params.anchor, warnings);

  const hashStore = options.store;
  const {
    normalized: originalNormalized,
    bom,
    originalEnding,
    fileHashes: originalHashes,
    hadUtf8DecodeErrors,
    absolutePath,
  } = await readNormFile(
    options.canonicalPath ?? path, cwd, { signal: options.signal, accessMode: options.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: true },
  );

  if (originalNormalized.length === 0) {
    throw new Error(
      `[E_BAD_OP] Cannot insert into ${path}: the file is empty. Insertion into an empty file is not supported; use write to create initial content.`,
    );
  }

  const fileLines = splitLines(originalNormalized);

  // Anchor resolution: exactly one current line must carry the hash.
  const candidates: number[] = [];
  for (let i = 0; i < originalHashes.length; i++) {
    if (originalHashes[i] === anchorHash) candidates.push(i + 1);
  }
  if (candidates.length === 0) {
    throw new InsertValidationError(
      new AnchorMismatchError(
        `[E_STALE_ANCHOR] 1 stale anchor in ${path}: "${anchorHash}". The file content has changed since that anchor was read. Nothing was inserted. Call read to get fresh anchors, then copy the 3-char HASH of an adjacent line into the anchor field of your next insert call.`,
        [],
      ),
      originalNormalized,
    );
  }
  if (candidates.length > 1) {
    const sample = candidates.slice(0, 5);
    const more = candidates.length > sample.length ? `, ... (+${candidates.length - sample.length} more)` : "";
    const rows = sample
      .map((line) => `    ${line}: ${originalHashes[line - 1]}${HASH_SEP}${clipLine(fileLines[line - 1] ?? "")}`)
      .join("\n");
    throw new InsertValidationError(
      new AnchorMismatchError(
        `[E_AMBIGUOUS_ANCHOR] 1 ambiguous anchor in ${path}. The anchor hash matches lines ${sample.join(", ")}${more}; insertion never guesses a location. Nothing was inserted. Call read to get fresh anchors, then anchor a single unambiguous line.\n${rows}`,
        sample.map((line) => originalHashes[line - 1]!),
      ),
      originalNormalized,
    );
  }
  const anchorLine = candidates[0]!;

  // Authorization is bound to the content version the rows were served for.
  // Insert has no unserved path: rows for another version — or no rows at all
  // — authorize nothing, for the parent included.
  const servedLookup = hashStore.getServedState(absolutePath, originalNormalized);
  const served = servedLookup !== undefined && "served" in servedLookup
    ? servedLookup.served
    : new Set<string>();
  if (!served.has(anchorHash)) {
    const context = contextRows(anchorLine, fileLines, originalHashes);
    throw new InsertValidationError(
      new RangeStaleError(
        `[E_RANGE_STALE] The anchor (line ${anchorLine}) in ${path} does not match what was previously shown: the file changed on disk after the anchor was read, or the line was never shown. Nothing was inserted. Current context with fresh anchors:\n\n${context.rows.join("\n")}`,
        anchorLine,
        context.hashes,
      ),
      originalNormalized,
    );
  }

  // First-class insertion: the anchor line is preserved and the literal block
  // is spliced at one adjacent position. No replacement containing the anchor
  // line is constructed, and the file's terminal-newline state is preserved.
  const insertAt = params.direction === "before" ? anchorLine - 1 : anchorLine;
  const newLines = [
    ...fileLines.slice(0, insertAt),
    ...params.lines,
    ...fileLines.slice(insertAt),
  ];
  const terminated = originalNormalized.endsWith("\n");
  const result = newLines.join("\n") + (terminated ? "\n" : "");

  const resultHashes = await lineHashes(result, absolutePath, {
    content: originalNormalized,
    hashes: originalHashes,
  }, hashStore, false);

  const firstChangedLine = insertAt + 1;
  return {
    path,
    anchorLine,
    direction: params.direction,
    insertedLines: params.lines.slice(),
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    firstChangedLine,
    lastChangedLine: firstChangedLine + params.lines.length - 1,
    originalHashes,
    resultHashes,
  };
}

export interface InsertSuccessInput {
  path: string;
  prep: InsertPipelineResult;
  warnings: string[];
  snapshotId?: string;
}

/** Builds the structured success result: the authoritative anchored diff and
 *  accurate metrics — the number of inserted logical lines added and zero
 *  removed. The executor owns the auto-read presentation of the diff text. */
export function buildInserted(input: InsertSuccessInput): {
  content: Array<{ type: "text"; text: string }>;
  details: InsertDetails;
} {
  const { path, prep, warnings, snapshotId } = input;
  const diffResult = genDiff(prep.originalNormalized, prep.result, 1, prep.resultHashes, prep.originalHashes);
  const addedLines = prep.insertedLines.length;
  const metrics = buildMetrics({
    classification: "applied",
    editsAttempted: 1,
    noopEditsCount: 0,
    warningsCount: warnings.length,
    firstChangedLine: prep.firstChangedLine,
    lastChangedLine: prep.lastChangedLine,
    addedLines,
    removedLines: 0,
  });
  const warningBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
  return {
    content: [{
      type: "text",
      text: `Successfully inserted into ${path}. Added ${addedLines} line(s), removed 0 line(s).${warningBlock}`,
    }],
    details: {
      diff: diffResult.diff,
      firstChangedLine: prep.firstChangedLine,
      snapshotId,
      metrics,
    },
  };
}
