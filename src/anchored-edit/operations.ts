import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { _lineHashesPure } from "./hashline/index.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import type { HashStoreHandle } from "./hash-store.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { AnchorMismatchError, RangeStaleError } from "./hashline/index.ts";
import { anchoredStoreDir, toCwd } from "./paths.ts";
import { fmtReadPreview, fmtReadPreviewSync } from "./read.ts";
import { prepareReplace, ReplaceValidationError, type PipelineResult, type ReplaceDetails, type ReqParams } from "./replace.ts";
import { buildChanged, buildNoop, type RMeta } from "./replace-response.ts";
import { restoreEndings } from "./replace-diff.ts";
import { servedHashesFromDiff } from "./served.ts";
import { loadAnchoredHashStore } from "./workspace-support.ts";
import { stripBOM, toLF } from "./replace-diff.ts";
import { AUTO_READ_MAX } from "./constants.ts";
import { errCode, visLines } from "./utils.ts";

/**
 * The anchored per-target operation boundary (odradekk/pi-square#264).
 *
 * One coordinator owns target resolution, in-process queue participation,
 * cross-process exclusion, disk observation or mutation, and the matching
 * owner-scoped store transaction for parent and writable-child reads,
 * replaces, and writes. Tool integrations delegate canonicalization to this
 * module and never implement lock files, queue ordering, filesystem mechanics,
 * cache ownership, or database transactions directly.
 *
 * Ordering is fixed for every mutation: Pi's per-file mutation queue is the
 * outer in-process serializer and the anchored cross-process lock is the
 * inner serializer — replace enters the queue explicitly, and the writes
 * join the same order through the public write factory's injected
 * filesystem-operation seam. Anchored reads hold the same target exclusion
 * from the byte read through snapshot and served-state publication.
 * `E_FILE_LOCKED` reports failure to enter the operation boundary (bounded
 * wait exhausted *or cancelled*); `E_RANGE_STALE` is reserved for validation
 * performed after the lock is acquired against a file that no longer matches
 * the served range.
 *
 * Authorization is version-bound: served rows authorize only the exact
 * content version they were recorded for, so a mutation whose post-commit
 * publication failed (or a process that died at that boundary) leaves the
 * previous version unable to authorize any replace until a fresh read
 * republishes current rows.
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
 * null when the bounded wait ended or was cancelled — the caller reports the
 * classified contention (`E_FILE_LOCKED`) and changes nothing. Release is
 * best-effort after committed work: a release failure is logged, never
 * thrown into a caller whose filesystem operation already succeeded.
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

/**
 * Carries the executing tool call's AbortSignal into an injected write
 * operation. The public `WriteOperations` seam has no signal parameter, and
 * the parent write must not wrap the factory's execution (ADR-0014), so only
 * the child anchored write composition — a declared exception to that rule —
 * runs the factory execution inside this context. The parent write's lock
 * wait is bounded and its failures classify as `E_FILE_LOCKED`; its
 * cancellation responsiveness stays the factory's own abort checks.
 */
const writeSignalContext = new AsyncLocalStorage<{ signal?: AbortSignal }>;

/** Runs `fn` with the executing tool call's AbortSignal visible to the
 *  injected write operation. Used by the child anchored write composition
 *  around the public factory execution so cancellation reaches the child's
 *  lock wait. */
export function runWithWriteSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return writeSignalContext.run({ signal }, fn);
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
  /** Cancellation for the lock wait; an aborted wait is classified
   *  contention, never an unclassified throw. */
  signal?: AbortSignal;
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
export const readBarrier: {
  /** Fired inside the target boundary before the file bytes are observed —
   *  the seam that proves the boundary covers the byte read. */
  locked?: (info: { canonicalPath: string }) => Promise<void>;
  onBytes?: (content: string) => Promise<void>;
} = {};

/**
 * One anchored read as a single operation: the target exclusion is held from
 * reading the file bytes through committing the matching snapshot and served
 * hashes — both published in one repository transaction, so the read either
 * publishes state for exactly the bytes it observed or publishes nothing.
 * A read that cannot enter the boundary returns classified contention
 * instead of unanchored content presented as anchored evidence.
 */
export async function runAnchoredRead(input: AnchoredReadInput): Promise<AnchoredReadResult> {
  const target = await resolveAnchoredTarget(input.cwd, input.requestedPath);
  const session = sessionContextFor(input.cwd, input.sessionDir);
  const boundary = await enterTargetBoundary(session.storeDir, target, { signal: input.signal });
  if (!boundary) {
    return {
      status: "locked",
      message: anchoredReadLockedMessage(input.requestedPath),
    };
  }
  try {
    await readBarrier.locked?.({ canonicalPath: target.canonicalPath });
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
      // Hash computation is pure: the snapshot cache is read, never written,
      // before the publication below.
      // The boundary locked the canonical target; the byte read, hashing,
      // and publication all observe that same frozen target, so a symlink
      // retargeted after acquisition cannot redirect the operation.
      const normalized = await readNormFile(target.canonicalPath, session.workspaceRoot, {
        preloadedFile: file,
        maxLines: MAX_HASH_LINES,
        store,
        noPersist: true,
      });
      await readBarrier.onBytes?.(normalized.normalized);
      const preview = await fmtReadPreview(
        normalized.normalized,
        { offset: input.offset, limit: input.limit },
        normalized.fileHashes,
      );
      store.publishRead({
        path: normalized.absolutePath,
        content: normalized.normalized,
        hashes: normalized.fileHashes,
        servedHashes: preview.servedHashes,
      });
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
 * @internal Deterministic test seam: awaited inside the boundary immediately
 * before the replace's irreversible filesystem commit, so tests can hold a
 * replace at the commit point and prove ordering against other operations
 * without sleeps. Production never sets it.
 */
export const replaceBarrier: {
  /** Fired inside the target boundary before the replace pipeline reads and
   *  validates the file — the seam that proves the boundary covers the read
   *  and authorization. */
  beforePrepare?: (info: { canonicalPath: string }) => Promise<void>;
  beforeCommit?: (info: { canonicalPath: string }) => Promise<void>;
} = {};

/**
 * One anchored replace as a single operation: Pi's mutation queue, then the
 * cross-process target lock, then pure preparation, then the filesystem
 * commit, then the store publication — all before the boundary releases.
 *
 * Preparation performs no cache or database mutations. After a successful
 * file commit the candidate snapshot and the diff's served rows are
 * published in one transaction while the lock is still held; if that
 * publication fails, the result still reports the truthful mutation success,
 * suppresses fresh anchors, emits a bounded actionable warning, and — because
 * served authorization is bound to the content version — leaves the previous
 * version unable to authorize another replace until a fresh read republishes
 * current rows.
 */
export async function runAnchoredReplace(input: AnchoredReplaceInput): Promise<AnchoredReplaceResult> {
  const session = sessionContextFor(input.cwd, input.sessionDir);
  const store = await loadAnchoredHashStore(session.storeDir, input.owner);
  try {
    const target = await resolveAnchoredTarget(input.cwd, input.params.path);
    return await withTargetMutationQueue(target, async () => {
      const lockedRefusal = (): AnchoredReplaceResult => ({
        content: [{ type: "text", text: fileLockedMessage(input.params.path, "replace") }],
        details: {
          diff: "",
          status: "warning",
          errorCode: "E_FILE_LOCKED",
        } satisfies ReplaceDetails,
      });
      if (input.signal?.aborted) return lockedRefusal();
      const boundary = await enterTargetBoundary(session.storeDir, target, { signal: input.signal });
      if (!boundary) return lockedRefusal();
      try {
        await replaceBarrier.beforePrepare?.({ canonicalPath: target.canonicalPath });
        let prep: PipelineResult;
        try {
          prep = await prepareReplace(input.params, input.cwd, {
            accessMode: fsConstants.R_OK | fsConstants.W_OK,
            signal: input.signal,
            store,
            requireServed: input.requireServed,
            canonicalPath: target.canonicalPath,
          });
        } catch (error) {
          if (error instanceof ReplaceValidationError) {
            // The refusal's fresh rows were observed under the boundary;
            // publishing them for exactly the current content version keeps
            // the immediate retry authorized.
            store.mergeServed(target.canonicalPath, error.feedbackHashes, error.content);
            return anchorWarning(error.anchorError);
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

        await replaceBarrier.beforeCommit?.({ canonicalPath: target.canonicalPath });
        if (input.signal?.aborted) return lockedRefusal();
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
            store.publishMutation({
              path: target.canonicalPath,
              content: prep.result,
              hashes: prep.resultHashes,
              ...(input.autoRead() ? { servedHashes: servedHashesFromDiff(diff) } : {}),
            });
          } catch (error) {
            // The file changed; never report otherwise. Suppress fresh
            // anchors, surface a bounded actionable warning, and leave the
            // pre-mutation state unable to authorize another replace: its
            // served rows are bound to the previous content version.
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
  store: HashStoreHandle;
}

/** Pure auto-read render result: the appendix text plus the exact store
 *  publication pieces for the written content. The caller publishes them as
 *  one repository transaction. */
export interface AutoReadRender {
  text: string;
  content: string;
  hashes: string[];
  servedHashes: string[];
}

/**
 * Renders the bounded auto-read anchor appendix for one written file without
 * publishing anything: hash computation reads the store-owned snapshot cache
 * and never mutates it. The write operation inside the target boundary
 * publishes the returned pieces as one repository transaction, so the parent
 * write and every writable-child anchored write append byte-identical
 * anchors. Returns undefined when the target is not supported bounded UTF-8
 * text (binary, image, oversized, non-regular); the caller then keeps the
 * native factory result unchanged.
 */
export async function renderAutoReadAnchors(input: AutoReadAnchorsInput): Promise<AutoReadRender | undefined> {
  try {
    const file = await loadFileKindAndText(input.path, {
      maxLines: MAX_HASH_LINES,
      displayPath: input.displayPath,
    });
    if (file.kind !== "text") return undefined;
    // Read through the boundary-locked canonical target, never through the
    // display path: a retargeted symlink must not redirect the appendix.
    const normalized = await readNormFile(input.path, input.workspaceRoot, {
      maxLines: MAX_HASH_LINES,
      preloadedFile: file,
      store: input.store,
      noPersist: true,
    });
    const preview = await fmtReadPreview(
      normalized.normalized,
      {},
      normalized.fileHashes,
      DEFAULT_MAX_BYTES,
      AUTO_READ_MAX,
    );
    const skipped = preview.nextOffset === undefined
      ? ""
      : `\n[${visLines(normalized.normalized).length - preview.nextOffset + 1} lines skipped; call read with offset=${preview.nextOffset} for more anchors.]`;
    const warning = normalized.hadUtf8DecodeErrors
      ? "\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]"
      : "";
    return {
      text: `--- Auto-read (hashline anchors) ---\n${preview.text}${skipped}${warning}`,
      content: normalized.normalized,
      hashes: normalized.fileHashes,
      servedHashes: preview.servedHashes,
    };
  } catch (error) {
    if (errCode(error) === "E_FILE_TOO_LARGE" || String(error).includes("[E_FILE_TOO_LARGE]")) return undefined;
    throw error;
  }
}

/** Pure auto-read render for an anchored write operation.
 *  The written bytes are exactly `content` (the factory writes it verbatim as
 *  UTF-8), so the normalized content, hashes, and preview rows are computed
 *  from that string — with the same normalization, bounds, and text shape as
 *  {@link renderAutoReadAnchors} — without any post-commit filesystem read.
 *  Unsupported content (over the line bound) yields `undefined`, and the
 *  caller then publishes the clearing transaction alone. */
function renderAutoReadFromContent(content: string): AutoReadRender | undefined {
  const { text: raw } = stripBOM(content);
  const normalized = toLF(raw);
  const lines = visLines(normalized);
  if (lines.length > MAX_HASH_LINES) return undefined;
  const hashes = _lineHashesPure(normalized);
  const preview = fmtReadPreviewSync(normalized, {}, hashes, DEFAULT_MAX_BYTES, AUTO_READ_MAX);
  const skipped = preview.nextOffset === undefined
    ? ""
    : `\n[${lines.length - preview.nextOffset + 1} lines skipped; call read with offset=${preview.nextOffset} for more anchors.]`;
  return {
    text: `--- Auto-read (hashline anchors) ---\n${preview.text}${skipped}`,
    content: normalized,
    hashes,
    servedHashes: preview.servedHashes,
  };
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
  /** Operations for Pi's public write factory. The caller must pass the
   *  canonical path returned by {@link resolveAnchoredTarget} to the factory,
   *  so Pi's queue and this operation act on the same target. */
  readonly operations: WriteOperations;
  /** Takes the oldest completed outcome for this canonical path/content pair.
   *  Pi serializes calls to one target, so completion and result delivery have
   *  the same order. Anchored write definitions additionally declare
   *  sequential execution so a failed pre-write call cannot consume a later
   *  call's outcome. */
  takeOutcome(canonicalPath: string, content: string): AnchoredWriteOutcome | undefined;
}

export interface AnchoredWriteSessionInput {
  cwd: string;
  owner: string;
  sessionDir?: string;
  autoRead: () => boolean;
  /**
   * Anchored-surface availability, read at operation time. When false, the
   * injected write operation performs Pi's plain filesystem write with no
   * anchored lock, no store mutation, and no recorded outcome — the
   * incomplete-surface write cannot be half-activated (#264). The parent
   * registration wires this to the full anchored surface (anchor store
   * initialized and both built-in ownership checks won); writable-child
   * compositions leave it unset.
   */
  available?: () => boolean;
  /** Bounded lock-wait budget for the write's target boundary (default: the
   *  lock module's). A failed wait classifies as `E_FILE_LOCKED`. */
  lockWaitMs?: number;
}

/**
 * @internal Deterministic test seam for parent and child writes: awaited
 * inside the target boundary immediately before the
 * irreversible filesystem write, so tests can hold a write at the commit
 * point and prove ordering against other operations without sleeps.
 * Production never sets it.
 */
export const writeBarrier: { beforeWrite?: (info: { canonicalPath: string }) => Promise<void> } = {};

function writeIdentity(canonicalPath: string, content: string): string {
  return `${canonicalPath}\0${createHash("sha256").update(content).digest("hex")}`;
}

/** Unified bounded actionable note for any post-commit state failure. The
 *  platform error is logged, never leaked into model-visible text: the note
 *  stays stable so it can be asserted and acted on. */
const ANCHORED_STATE_NOTE =
  "--- [E_STATE_UNAVAILABLE] The file was written, but updating anchored state failed; call read to get fresh anchors before the next replace. ---";

/**
 * Creates the write-side operation session for one acting owner. The parent
 * session shares one instance between the registered write definition and
 * the result-presentation handlers; each writable child creates its own.
 */
export function createAnchoredWriteSession(input: AnchoredWriteSessionInput): AnchoredWriteSession {
  const outcomes = new Map<string, AnchoredWriteOutcome[]>();
  const session = sessionContextFor(input.cwd, input.sessionDir);

  const recordOutcome = (key: string, outcome: AnchoredWriteOutcome): void => {
    const queued = outcomes.get(key);
    if (queued) queued.push(outcome);
    else outcomes.set(key, [outcome]);
  };

  const operations: WriteOperations = {
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
    writeFile: async (absolutePath: string, content: string) => {
      const signal = writeSignalContext.getStore()?.signal;
      const available = input.available !== undefined ? input.available() : true;
      if (!available) {
        await writeFile(absolutePath, content, "utf-8");
        return;
      }
      // Parent tool_call interception and the child composition both replace
      // the factory argument with this canonical path before execution. Pi's
      // queue therefore resolved the same path this operation locks/writes.
      const target = await resolveAnchoredTarget(input.cwd, absolutePath);
      const outcomeKey = writeIdentity(target.canonicalPath, content);
      const boundary = await enterTargetBoundary(
        session.storeDir,
        target,
        { signal, ...(input.lockWaitMs !== undefined ? { waitMs: input.lockWaitMs } : {}) },
      );
      if (!boundary) {
        throw new Error(fileLockedMessage(absolutePath, "write"));
      }
      try {
        if (signal?.aborted) {
          throw new Error(fileLockedMessage(absolutePath, "write"));
        }
        let changed = true;
        try {
          changed = !Buffer.from(content, "utf8").equals(await readFile(target.canonicalPath));
        } catch {
          // ENOENT (creation) or an unreadable target: changed.
        }
        await writeBarrier.beforeWrite?.({ canonicalPath: target.canonicalPath });
        if (signal?.aborted) {
          throw new Error(fileLockedMessage(absolutePath, "write"));
        }
        await writeFile(target.canonicalPath, content, "utf-8");
        let appendix: string | undefined;
        try {
          const store = await loadAnchoredHashStore(session.storeDir, input.owner);
          try {
            const rendered = input.autoRead() && changed ? renderAutoReadFromContent(content) : undefined;
            if (rendered !== undefined) {
              appendix = rendered.text;
              store.publishWrite({
                kind: "publish",
                path: target.canonicalPath,
                snapshot: { content: rendered.content, hashes: rendered.hashes },
                ...(rendered.servedHashes.length > 0 ? { servedHashes: rendered.servedHashes } : {}),
              });
            } else {
              store.publishWrite({ kind: "clear", path: target.canonicalPath });
            }
          } finally {
            store.release();
          }
        } catch (error) {
          console.error("Anchored write state update failed:", error);
          appendix = ANCHORED_STATE_NOTE;
        }
        recordOutcome(outcomeKey, {
          canonicalPath: target.canonicalPath,
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
    takeOutcome(canonicalPath: string, content: string): AnchoredWriteOutcome | undefined {
      const key = writeIdentity(canonicalPath, content);
      const queued = outcomes.get(key);
      const outcome = queued?.shift();
      if (queued?.length === 0) outcomes.delete(key);
      return outcome;
    },
  };
}
