import { constants as fsConstants, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  DEFAULT_MAX_BYTES,
  type AgentToolResult,
  type WriteOperations,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile, safeSnapId } from "./file-reader.ts";
import { acquireFileLock, fileLockedMessage, lockFilePath, type AcquireLockOptions } from "./file-lock.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import { publishMutation } from "./hash-store.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { AnchorMismatchError, RangeStaleError } from "./hashline/index.ts";
import { anchoredStoreDir, toCwd } from "./paths.ts";
import { fmtReadPreview } from "./read.ts";
import { prepareReplace, type PipelineResult, type ReplaceDetails, type ReqParams } from "./replace.ts";
import { buildChanged, buildNoop, type RMeta } from "./replace-response.ts";
import { restoreEndings } from "./replace-diff.ts";
import { recordServedSafe, servedHashesFromDiff } from "./served.ts";
import { loadAnchoredHashStore } from "./workspace-support.ts";
import { AUTO_READ_MAX } from "./constants.ts";
import { abortIf, errCode, visLines } from "./utils.ts";

/**
 * The anchored per-target operation boundary (odradekk/pi-square#264).
 *
 * One coordinator owns target resolution, in-process queue participation,
 * cross-process exclusion, disk observation or mutation, and the matching
 * owner-scoped store transaction for parent and writable-child reads,
 * replaces, and writes. Tool registration never touches lock files, queue
 * ordering, filesystem mechanics, cache ownership, or database transactions
 * directly.
 *
 * Ordering is fixed for every mutation: Pi's per-file mutation queue is the
 * outer in-process serializer and the anchored cross-process lock is the
 * inner serializer — replace enters the queue explicitly, and the writes
 * join the same order through the public write factory's injected
 * filesystem-operation seam. Anchored reads hold the same target exclusion
 * from the byte read through snapshot and served-state publication.
 * `E_FILE_LOCKED` reports failure to enter the boundary; `E_RANGE_STALE` is
 * reserved for validation performed after the lock is acquired against a
 * file that no longer matches the served range.
 */

export type ReadModelContent = AgentToolResult<unknown>["content"];

/** A resolved anchored target: the canonical path plus the operation key that
 *  aliases an existing multi-link file's hard-link names onto one lock. */
export interface AnchoredTarget {
  readonly canonicalPath: string;
  readonly opKey: string;
}

/**
 * Operation key for one canonical target. The canonical path is the normal
 * key. For an already-existing file with multiple hard links the stable file
 * identity (dev/ino) is used instead, so two hard-link names of one file
 * inside one workspace lock area coordinate instead of racing. Different
 * initiating workspaces keep separate lock areas by construction, preserving
 * the documented cross-workspace separation for external targets.
 */
async function operationKeyFor(canonicalPath: string): Promise<string> {
  try {
    const stats = await stat(canonicalPath);
    if (stats.isFile() && stats.nlink > 1 && (stats.dev !== 0 || stats.ino !== 0)) {
      return `inode:${stats.dev}:${stats.ino}`;
    }
  } catch {
    // Missing or unstatable target: the operation itself surfaces the error;
    // the canonical path is the key.
  }
  return canonicalPath;
}

/** Resolves a requested path with Pi's native authority and derives its
 *  operation key. Mirrors exactly what the Pi factories resolve. */
export async function resolveAnchoredTarget(
  cwd: string,
  requestedPath: string,
): Promise<AnchoredTarget> {
  const canonicalPath = await resolveTarget(toCwd(requestedPath, cwd));
  return { canonicalPath, opKey: await operationKeyFor(canonicalPath) };
}

interface SessionContext {
  readonly workspaceRoot: string;
  readonly storeDir: string;
}

function sessionContextFor(cwd: string, sessionDir: string | undefined): SessionContext {
  const workspaceRoot = realpathSync(cwd);
  return {
    workspaceRoot,
    storeDir: anchoredStoreDir(sessionDir, workspaceRoot),
  };
}

export type EnterBoundaryOptions = AcquireLockOptions;

/**
 * Enters the per-target cross-process exclusion. Returns a release handle, or
 * null when the bounded wait ended without the lock — the caller reports the
 * classified contention (`E_FILE_LOCKED`) and changes nothing.
 */
export async function enterTargetBoundary(
  storeDir: string,
  target: AnchoredTarget,
  options?: EnterBoundaryOptions,
): Promise<{ release(): Promise<void> } | null> {
  return acquireFileLock(lockFilePath(storeDir, target.opKey), options);
}

/** Runs `fn` inside Pi's per-file mutation queue for the canonical target —
 *  the outer in-process serializer every mutation shares. */
export function withTargetMutationQueue<T>(
  target: AnchoredTarget,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileMutationQueue(target.canonicalPath, fn);
}

// ---------------------------------------------------------------------------
// Read operation
// ---------------------------------------------------------------------------

export type AnchoredReadResult =
  | { status: "ok"; content: ReadModelContent }
  /** The factory result passes through unchanged (image targets and native
   *  not-found failures keep Pi's own result). */
  | { status: "passthrough" }
  | { status: "locked"; message: string };

export interface AnchoredReadInput {
  cwd: string;
  requestedPath: string;
  offset?: number;
  limit?: number;
  owner: string;
  sessionDir?: string;
}

function anchoredReadLockedMessage(path: string): string {
  return `[E_FILE_LOCKED] Another editor holds the write lock on ${path}; the anchored read was not performed and no anchors were served. Retry the read.`;
}

/**
 * @internal Deterministic test seam: awaited between the locked byte read and
 * the snapshot/served publication of one anchored read, so tests can pause an
 * operation at the byte-read/store-publication boundary without sleeps.
 * Production never sets it.
 */
export const readBarrier: { onBytes?: (content: string) => Promise<void> } = {};

/**
 * One anchored read as a single operation: the target exclusion is held from
 * reading the file bytes through committing the matching snapshot and served
 * hashes, so the anchors shown describe exactly the bytes read and cannot
 * straddle a concurrent writer. A read that cannot enter the boundary
 * returns classified contention instead of unanchored content presented as
 * anchored evidence.
 */
export async function runAnchoredRead(input: AnchoredReadInput): Promise<AnchoredReadResult> {
  const target = await resolveAnchoredTarget(input.cwd, input.requestedPath);
  const session = sessionContextFor(input.cwd, input.sessionDir);
  const boundary = await enterTargetBoundary(session.storeDir, target);
  if (!boundary) {
    return {
      status: "locked",
      message: anchoredReadLockedMessage(input.requestedPath),
    };
  }
  try {
    let file;
    try {
      file = await loadFileKindAndText(target.canonicalPath, {
        maxLines: MAX_HASH_LINES,
        displayPath: input.requestedPath,
      });
    } catch (error) {
      // The factory already produced its own native not-found result; pass it
      // through unchanged instead of replacing it with anchored wording.
      if (errCode(error) === "ENOENT") return { status: "passthrough" };
      throw error;
    }
    if (file.kind === "image") return { status: "passthrough" };
    const store = await loadAnchoredHashStore(session.storeDir, input.owner);
    try {
      const normalized = await readNormFile(input.requestedPath, session.workspaceRoot, {
        preloadedFile: file,
        maxLines: MAX_HASH_LINES,
        store,
      });
      await readBarrier.onBytes?.(normalized.normalized);
      const preview = await fmtReadPreview(
        normalized.normalized,
        { offset: input.offset, limit: input.limit },
        normalized.fileHashes,
      );
      store.mergeServed(normalized.absolutePath, preview.servedHashes);
      const text = normalized.hadUtf8DecodeErrors
        ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
        : preview.text;
      return { status: "ok", content: [{ type: "text", text }] };
    } finally {
      store.release();
    }
  } finally {
    await boundary.release();
  }
}

// ---------------------------------------------------------------------------
// Replace operation
// ---------------------------------------------------------------------------

export type AnchoredReplaceResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ReplaceDetails;
};

export interface AnchoredReplaceInput {
  cwd: string;
  params: ReqParams;
  owner: string;
  requireServed: boolean;
  autoRead: () => boolean;
  sessionDir?: string;
  signal?: AbortSignal;
  /** Warnings discovered before the boundary (path autocorrect); prepended. */
  leadingWarnings?: string[];
}

function errorCode(error: Error): string {
  return /^\[([A-Z_]+)\]/.exec(error.message)?.[1] ?? "E_ANCHOR_REFUSED";
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function anchorWarning(error: RangeStaleError | AnchorMismatchError): AnchoredReplaceResult {
  return {
    content: [{ type: "text", text: error.message }],
    details: {
      diff: "",
      status: "warning",
      errorCode: errorCode(error),
    },
  };
}

/** Success text composed from structured pieces only; identical to the
 *  pre-refactor model-visible wording for both auto-read states, including
 *  the authoritative diff rows the model consumes for a follow-up edit. */
function appliedText(prep: PipelineResult, warnings: string[], diff: string): string {
  const warningBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
  if (visLines(prep.result).length === 0) {
    return `File is empty. Use replace to insert content.${warningBlock}`;
  }
  if (diff) {
    return `${diff}${warningBlock}`;
  }
  const lineSummary = prep.totalAddedLines > 0 || prep.totalRemovedLines > 0
    ? ` Added ${prep.totalAddedLines} line(s), removed ${prep.totalRemovedLines} line(s).`
    : "";
  return `Successfully replaced in ${prep.path}.${lineSummary}${warningBlock}`;
}

/**
 * One anchored replace as a single operation: Pi's mutation queue, then the
 * cross-process target lock, then pure preparation, then the filesystem
 * commit, then the store publication — all before the boundary releases.
 *
 * Preparation performs no cache or database mutations. After a successful
 * file commit the candidate snapshot and the diff's served rows are
 * published in one transaction while the lock is still held; if that
 * publication fails, the result still reports the truthful mutation success,
 * suppresses fresh anchors, emits a bounded actionable warning, and leaves
 * stale state unable to authorize another replace — a new anchored read
 * repairs the state.
 */
export async function runAnchoredReplace(input: AnchoredReplaceInput): Promise<AnchoredReplaceResult> {
  const session = sessionContextFor(input.cwd, input.sessionDir);
  const store = await loadAnchoredHashStore(session.storeDir, input.owner);
  try {
    const target = await resolveAnchoredTarget(input.cwd, input.params.path);
    return await withTargetMutationQueue(target, async () => {
      abortIf(input.signal);
      const boundary = await enterTargetBoundary(session.storeDir, target, { signal: input.signal });
      if (!boundary) {
        return {
          content: [{ type: "text", text: fileLockedMessage(input.params.path, "replace") }],
          details: {
            diff: "",
            status: "warning",
            errorCode: "E_FILE_LOCKED",
          } satisfies ReplaceDetails,
        };
      }
      try {
        abortIf(input.signal);
        let prep: PipelineResult;
        try {
          prep = await prepareReplace(input.params, input.cwd, {
            accessMode: fsConstants.R_OK | fsConstants.W_OK,
            signal: input.signal,
            store,
            requireServed: input.requireServed,
          });
        } catch (error) {
          if (error instanceof RangeStaleError || error instanceof AnchorMismatchError) {
            // The refusal's fresh rows were observed under the boundary;
            // publishing them keeps the immediate retry authorized.
            const hashes = error instanceof RangeStaleError
              ? error.rangeHashes
              : error.feedbackHashes;
            await recordServedSafe(target.canonicalPath, hashes, "range feedback", store);
            return anchorWarning(error);
          }
          throw error;
        }

        const warnings = [...(input.leadingWarnings ?? []), ...prep.warnings];
        const editsAttempted = 1;
        if (prep.originalNormalized === prep.result) {
          const snapshotId = await safeSnapId(target.canonicalPath, "noop anchored replace");
          const noop = buildNoop({
            path: input.params.path,
            noopEdit: prep.noopEdit,
            snapshotId,
            editMeta: {
              editsAttempted,
              noopEditsCount: prep.noopEdit ? 1 : 0,
              addedLines: 0,
              removedLines: 0,
            },
            warnings,
          });
          noop.details.warnings = warnings.slice();
          return noop;
        }

        if (prep.hadUtf8DecodeErrors) {
          warnings.push(
            "Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
          );
        }

        abortIf(input.signal);
        // The filesystem commit is the irreversible point.
        await writeAtomic(target.canonicalPath, prep.bom + restoreEndings(prep.result, prep.originalEnding));
        const snapshotId = await safeSnapId(target.canonicalPath, "post-anchored-replace");
        const editMeta: RMeta = {
          editsAttempted,
          noopEditsCount: prep.noopEdit ? 1 : 0,
          firstChangedLine: prep.firstChangedLine,
          lastChangedLine: prep.lastChangedLine,
          addedLines: prep.totalAddedLines,
          removedLines: prep.totalRemovedLines,
        };
        const changed = buildChanged({
          path: input.params.path,
          originalNormalized: prep.originalNormalized,
          originalHashes: prep.originalHashes,
          result: prep.result,
          resultHashes: prep.resultHashes,
          warnings,
          snapshotId,
          editMeta,
        });
        const diff = changed.details.diff;
        if (diff) {
          try {
            publishMutation(store, {
              path: target.canonicalPath,
              content: prep.result,
              hashes: prep.resultHashes,
              ...(input.autoRead() ? { servedHashes: servedHashesFromDiff(diff) } : {}),
            });
          } catch (error) {
            // The file changed; never report otherwise. Suppress fresh
            // anchors, surface a bounded actionable warning, and leave the
            // pre-mutation state unable to authorize another replace.
            store.invalidateSnapshotCache(target.canonicalPath);
            changed.details.diff = "";
            warnings.push(
              `[E_STATE_UNAVAILABLE] The file was changed, but recording fresh anchors failed (${boundedReason(error)}). The edit is applied; call read to get fresh anchors before the next replace.`,
            );
            changed.content = [{
              type: "text",
              text: appliedText(prep, warnings, ""),
            }];
          }
        }
        changed.details.warnings = warnings.slice();
        if (!input.autoRead()) changed.details.diff = "";
        else if (changed.details.diff) {
          changed.content = [{
            type: "text",
            text: appliedText(prep, warnings, changed.details.diff),
          }];
        }
        return changed;
      } finally {
        await boundary.release();
      }
    });
  } finally {
    store.release();
  }
}

// ---------------------------------------------------------------------------
// Auto-read appendix (shared by the write operations)
// ---------------------------------------------------------------------------

export interface AutoReadAnchorsInput {
  /** Canonical target path. */
  path: string;
  /** Model-visible path string used for display and anchored-row text. */
  displayPath: string;
  /** Initiating workspace root owning the store. */
  workspaceRoot: string;
  /** Loaded anchored hash store under the acting owner; the caller releases it. */
  store: import("./hash-store.ts").HashStoreHandle;
}

/**
 * Renders the bounded auto-read anchor appendix for one written file and
 * records its rows as served under the acting owner. Shared by the write
 * operation inside the target boundary, so the parent write hook and every
 * writable-child anchored write append byte-identical anchors. Returns
 * undefined when the target is not supported bounded UTF-8 text (binary,
 * image, oversized, non-regular); the caller then keeps the native factory
 * result unchanged.
 */
export async function renderAutoReadAnchors(input: AutoReadAnchorsInput): Promise<string | undefined> {
  try {
    const file = await loadFileKindAndText(input.path, {
      maxLines: MAX_HASH_LINES,
      displayPath: input.displayPath,
    });
    if (file.kind !== "text") return undefined;
    const normalized = await readNormFile(input.displayPath, input.workspaceRoot, {
      maxLines: MAX_HASH_LINES,
      preloadedFile: file,
      store: input.store,
    });
    const preview = await fmtReadPreview(
      normalized.normalized,
      {},
      normalized.fileHashes,
      DEFAULT_MAX_BYTES,
      AUTO_READ_MAX,
    );
    input.store.mergeServed(normalized.absolutePath, preview.servedHashes);
    const skipped = preview.nextOffset === undefined
      ? ""
      : `\n[${visLines(normalized.normalized).length - preview.nextOffset + 1} lines skipped; call read with offset=${preview.nextOffset} for more anchors.]`;
    const warning = normalized.hadUtf8DecodeErrors
      ? "\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]"
      : "";
    return `--- Auto-read (hashline anchors) ---\n${preview.text}${skipped}${warning}`;
  } catch (error) {
    if (errCode(error) === "E_FILE_TOO_LARGE" || String(error).includes("[E_FILE_TOO_LARGE]")) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Write operation (Pi public-factory filesystem seam)
// ---------------------------------------------------------------------------

export interface AnchoredWriteOutcome {
  readonly canonicalPath: string;
  readonly changed: boolean;
  readonly appendix?: string;
}

export interface AnchoredWriteSession {
  /** Operations for Pi's public write factory. `writeFile` joins the fixed
   *  queue-then-lock protocol — the factory enters the per-file mutation
   *  queue, and the operation acquires the target lock inside it — and
   *  publishes the owner's store state before the lock releases. */
  readonly operations: WriteOperations;
  /** Records the model-visible request path for the next write under the
   *  canonical path, used for appendix display text. */
  noteRequest(canonicalPath: string, displayPath: string): void;
  /** Takes (consumes) the outcome of the most recent completed write under
   *  the canonical path, when one is pending. */
  takeOutcome(canonicalPath: string): AnchoredWriteOutcome | undefined;
}

export interface AnchoredWriteSessionInput {
  cwd: string;
  owner: string;
  sessionDir?: string;
  autoRead: () => boolean;
}

/**
 * Creates the write-side operation session for one acting owner. The parent
 * session shares one instance between the registered write definition (its
 * `operations`) and the result-presentation handlers (`noteRequest` /
 * `takeOutcome`); each writable child creates its own.
 */
export function createAnchoredWriteSession(input: AnchoredWriteSessionInput): AnchoredWriteSession {
  const outcomes = new Map<string, AnchoredWriteOutcome>();
  const requests = new Map<string, string>();
  const session = sessionContextFor(input.cwd, input.sessionDir);
  const operations: WriteOperations = {
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
    writeFile: async (absolutePath: string, content: string) => {
      const canonicalPath = await resolveTarget(absolutePath);
      const opKey = await operationKeyFor(canonicalPath);
      const displayPath = requests.get(canonicalPath) ?? absolutePath;
      const boundary = await enterTargetBoundary(session.storeDir, { canonicalPath, opKey });
      if (!boundary) {
        throw new Error(fileLockedMessage(displayPath, "write"));
      }
      try {
        // Pre-write comparison inside the boundary decides whether the write
        // is a change for auto-read; a missing file counts as changed
        // (creation), as does an unreadable one.
        let changed = true;
        try {
          changed = !Buffer.from(content, "utf8").equals(await readFile(canonicalPath));
        } catch {
          // ENOENT (creation) or an unreadable target: the appendix render
          // applies its own bounds after the write.
        }
        // Ordinary factory filesystem semantics: the write, and any error it
        // produces, is exactly Pi's own.
        await writeFile(absolutePath, content, "utf-8");
        // Publication happens while the boundary is still held.
        let appendix: string | undefined;
        const store = await loadAnchoredHashStore(session.storeDir, input.owner);
        try {
          store.clearServed(canonicalPath);
          if (input.autoRead() && changed) {
            try {
              appendix = await renderAutoReadAnchors({
                path: canonicalPath,
                displayPath,
                workspaceRoot: session.workspaceRoot,
                store,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error("Auto-read after anchored write failed:", error);
              appendix = `--- Auto-read failed: ${message} ---`;
            }
          }
        } finally {
          store.release();
        }
        outcomes.set(canonicalPath, {
          canonicalPath,
          changed,
          ...(appendix !== undefined ? { appendix } : {}),
        });
      } finally {
        await boundary.release();
      }
    },
  };
  return {
    operations,
    noteRequest(canonicalPath: string, displayPath: string): void {
      requests.set(canonicalPath, displayPath);
    },
    takeOutcome(canonicalPath: string): AnchoredWriteOutcome | undefined {
      const outcome = outcomes.get(canonicalPath);
      if (outcome !== undefined) outcomes.delete(canonicalPath);
      requests.delete(canonicalPath);
      return outcome;
    },
  };
}
