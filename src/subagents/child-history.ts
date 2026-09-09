import { openSync, readSync, closeSync, statSync } from "node:fs";
import { resolveChildSessionFile } from "./artifacts";
import { clipWithHeadTail } from "./confirmed-delivery";
import { sanitizeSubagentDisplay } from "./display";
import { rosterToolArgsDisplay } from "./tool-display";

/**
 * Bounded, demand-paged reading of a child's complete persisted native
 * session history (odradekk/pi-square#305).
 *
 * The pager is the single historical source behind the read-only child
 * transcript overlay. It reads the validated native session file through the
 * same child-artifact identity boundary resume uses — `resolveChildSessionFile`
 * keeps the artifacts directory inside the subagent state root, the run record
 * describing that directory, and the session file inside it — and pages that
 * file tail-first in bounded byte ranges. It creates no second transcript
 * store: no cache file, index, sidecar, writer, lock, journal, migration, or
 * artifact version exists beside the native session file, and every read is
 * stateless against it.
 *
 * Page boundaries are byte offsets, but entries are only ever parsed from
 * newline-terminated byte ranges, stitched at the byte level so a multibyte
 * UTF-8 sequence split across two pages is decoded exactly once. A terminated
 * line that is not a JSON object — malformed, truncated by tampering, or past
 * the per-entry cap — fails that page load with one bounded reason while
 * every previously validated page stays visible and the same request can be
 * retried. An unterminated final line is the running child's mid-append input
 * and is never parsed as history. Reads re-verify the file's dev/ino identity
 * and refuse a file that shrank below the loaded window, so a replaced or
 * truncated session file cannot be misread at stale offsets.
 *
 * Memory stays explicitly bounded: at most {@link MAX_LOADED_ITEMS} projected
 * items are retained (each already text-budgeted by the projection), paging
 * older evicts the newest loaded pages and paging newer reloads them on
 * demand, and one stitched entry may never exceed {@link MAX_ENTRY_LINE_BYTES}.
 * A failure here is a viewer error only: paging never touches the child
 * lifecycle, abort signal, persistence, delivery, wait ownership, or resume
 * eligibility.
 */

/** Bytes read per bounded page, tail-first. */
const DEFAULT_PAGE_BYTES = 131_072;
/** Hard cap on one stitched JSONL entry; a larger line fails the page load. */
const DEFAULT_MAX_ENTRY_BYTES = 1_048_576;
/** Explicit bound on retained projected items — the in-memory window. */
export const MAX_LOADED_ITEMS = 480;
/** Bytes read from the head just to validate the session header line. */
const MAX_HEADER_READ_BYTES = 4_096;
/** The one bounded reason every read, parse, and identity failure surfaces. */
export const CHILD_HISTORY_READ_ERROR = "child history could not be read";

const NEWLINE = 0x0a;
const EMPTY_BUFFER = Buffer.alloc(0);

export type TranscriptItem =
  | { kind: "user"; text: string; entryId?: string }
  | { kind: "assistant"; message: Record<string, unknown>; entryId?: string }
  | {
    kind: "toolCall";
    name: string;
    summary: string;
    durationMs?: number;
    result?: { isError: boolean };
    entryId?: string;
  }
  | { kind: "generic"; text: string; entryId?: string };

/** One unresolved call opened by the projected entries, for page stitching. */
export interface OpenToolCallRef {
  item: TranscriptItem & { kind: "toolCall" };
  startedAt?: number;
}

/** One unpaired tool result in entry order, for page stitching. */
export interface OrphanToolResultRef {
  callId: string;
  isError: boolean;
  endedAt?: number;
  /** Index into the projected items of the orphan's generic row. */
  index: number;
}

export interface ChildTranscriptProjection {
  items: TranscriptItem[];
  /** Items older than the bounded window that exist in the projected input. */
  omitted: number;
  /** Calls these entries opened but no entry in them resolved. */
  openToolCalls: Map<string, OpenToolCallRef>;
  /** Tool results whose calls live before these entries, in entry order. */
  orphanResults: OrphanToolResultRef[];
}

/** Per-item text budget through the shared head/tail clipper. */
const MAX_ENTRY_TEXT = 2_000;
/** Single-line budget for generic fallback rows. */
const MAX_GENERIC_LINE = 200;

function genericLine(text: string, entryId?: string): TranscriptItem {
  const clean = sanitizeSubagentDisplay(text).replace(/\s+/g, " ").trim();
  return { kind: "generic", text: clean.slice(0, MAX_GENERIC_LINE), ...(entryId !== undefined ? { entryId } : {}) };
}

/**
 * Display-safe entry text: the shared credential-neutral sanitizer strips
 * control sequences and redacts common credential forms first, then the shared
 * head/tail clipper bounds the length. Every user, assistant, and thinking
 * text passes here before any component can render it; provider errors never
 * cross into the projection and use fixed state text instead.
 */
function safeEntryText(text: unknown): string {
  return clipWithHeadTail(sanitizeSubagentDisplay(text), MAX_ENTRY_TEXT);
}

type TextContentPart = { kind: "text"; text: string } | { kind: "unsupported" };

/** Ordered text/fallback projection for user and visible custom content. */
function projectTextContent(content: unknown): TextContentPart[] {
  if (typeof content === "string") {
    const text = safeEntryText(content);
    return text ? [{ kind: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: TextContentPart[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      const text = safeEntryText(part.text);
      if (text) parts.push({ kind: "text", text });
    } else {
      parts.push({ kind: "unsupported" });
    }
  }
  return parts;
}

/**
 * Projects parsed native session entries into the ordered bounded transcript.
 * System material never enters: the session header, plain custom state
 * entries, labels, and metadata entries are ignored, and every rendered text
 * is a display-safe projection — sanitized, redacted, and clipped — before it
 * reaches Pi's components or a generic fallback. Entries carry their native
 * entry id (`entryId`) so callers can key positions by stable identity rather
 * than array offset. Tool calls keep their conversational order and state but
 * project only through the roster-grade allowlisted identity/summary seam the
 * roster rows share: raw arguments, result payloads, and call IDs never enter
 * an item a renderer can show (the call ID exists only to pair a result with
 * its call and is never rendered). Content that is out of scope but
 * conversationally meaningful becomes one non-empty sanitized generic line
 * instead of silently disappearing.
 */
export function projectSessionEntries(
  entries: readonly unknown[],
  windowSize = 24,
  observedAt?: number,
): ChildTranscriptProjection {
  const projected: TranscriptItem[] = [];
  const openCalls = new Map<string, OpenToolCallRef>();
  const orphanResults: OrphanToolResultRef[] = [];

  const timestamp = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; id?: unknown };
    const entryId = typeof record.id === "string" ? record.id : undefined;
    const entryTimestamp = timestamp((entry as { timestamp?: unknown }).timestamp);

    if (record.type === "session") continue;

    if (record.type === "compaction") {
      projected.push(genericLine("context compacted", entryId));
      continue;
    }
    if (record.type === "branch_summary") {
      projected.push(genericLine("branch summary recorded", entryId));
      continue;
    }
    if (record.type === "custom_message") {
      const custom = entry as { display?: unknown; content?: unknown };
      if (custom.display === true) {
        const parts = projectTextContent(custom.content);
        if (parts.length === 0) projected.push(genericLine("extension message (no readable text)", entryId));
        else for (const part of parts) {
          projected.push(genericLine(part.kind === "text" ? part.text : "unsupported extension message content", entryId));
        }
      }
      continue;
    }
    if (record.type !== "message") continue;

    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;

    if (role === "user") {
      const parts = projectTextContent((message as { content?: unknown }).content);
      if (parts.length === 0) projected.push(genericLine("user message (no readable text)", entryId));
      else for (const part of parts) {
        projected.push(part.kind === "text"
          ? { kind: "user", text: part.text, ...(entryId !== undefined ? { entryId } : {}) }
          : genericLine("unsupported user message content", entryId));
      }
      continue;
    }

    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      const stopReason = (message as { stopReason?: unknown }).stopReason;
      if (!Array.isArray(content)) {
        projected.push(genericLine("assistant message (no readable content)", entryId));
        continue;
      }
      const projectedBefore = projected.length;
      // Pi renders one assistant message component, then the message's tool
      // rows, whose later results update in place. Keep that native grouping;
      // unsupported provider parts remain visible as generic rows afterward.
      const boundedContent: Array<Record<string, unknown>> = [];
      const assistantItems: Array<TranscriptItem & { kind: "assistant" }> = [];
      const calls: Array<TranscriptItem & { kind: "toolCall" }> = [];
      const unsupported: TranscriptItem[] = [];
      const startedAt = entryTimestamp;
      for (const part of content) {
        if (!part || typeof part !== "object") {
          unsupported.push(genericLine("unsupported assistant content", entryId));
          continue;
        }
        if (part.type === "text") {
          const text = safeEntryText(part.text);
          if (text) boundedContent.push({ type: "text", text });
        } else if (part.type === "thinking") {
          const thinking = safeEntryText(part.thinking);
          if (thinking) boundedContent.push({ type: "thinking", thinking });
        } else if (part.type === "toolCall") {
          // The roster-grade shared projection: cataloged identity plus
          // structural counts/ranges only; free-form paths, patterns, queries,
          // and commands never project, and unknown names stay anonymous.
          const display = rosterToolArgsDisplay(String(part.name ?? ""), part.arguments);
          const call = {
            kind: "toolCall",
            name: display.tool,
            summary: display.summary,
            ...(startedAt !== undefined && observedAt !== undefined
              ? { durationMs: Math.max(0, observedAt - startedAt) }
              : {}),
            ...(entryId !== undefined ? { entryId } : {}),
          } as TranscriptItem & { kind: "toolCall" };
          calls.push(call);
          const callId = typeof part.id === "string" ? part.id : "";
          if (callId) openCalls.set(callId, { item: call, startedAt });
        } else {
          unsupported.push(genericLine("unsupported assistant content", entryId));
        }
      }
      if (boundedContent.length > 0) {
        const item = {
          kind: "assistant",
          message: { role: "assistant", content: boundedContent },
          ...(entryId !== undefined ? { entryId } : {}),
        } as const;
        projected.push(item);
        assistantItems.push(item);
      }
      projected.push(...calls, ...unsupported);

      // Only fixed state text crosses the assistant error boundary. Pi's
      // native transcript updates a tool call in place, so failed calls keep
      // that same one-row identity rather than gaining a second result row.
      if (stopReason === "error" || stopReason === "aborted") {
        if (calls.length > 0) {
          for (const call of calls) {
            call.result = { isError: true };
            // Without a tool-result entry there is no execution end boundary;
            // do not turn time spent before a later reopen into tool duration.
            delete call.durationMs;
          }
        } else if (assistantItems.length > 0) {
          const last = assistantItems.at(-1)!;
          last.message.stopReason = stopReason;
          last.message.errorMessage = stopReason === "error" ? "Child request failed" : "Child request aborted";
        } else {
          projected.push(genericLine(stopReason === "error" ? "assistant request failed" : "assistant request aborted", entryId));
        }
      } else if (stopReason === "length" && assistantItems.length > 0) {
        assistantItems.at(-1)!.message.stopReason = "length";
      }
      if (projected.length === projectedBefore) {
        projected.push(genericLine("assistant message (no readable content)", entryId));
      }
      continue;
    }

    if (role === "toolResult") {
      // Result payloads never render: the pairing keeps only the terminal
      // state so the ordered call/result conversation stays readable.
      const result = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
      const callId = typeof result.toolCallId === "string" ? result.toolCallId : "";
      const open = callId ? openCalls.get(callId) : undefined;
      if (open) {
        open.item.result = { isError: result.isError === true };
        const endedAt = entryTimestamp;
        if (open.startedAt !== undefined && endedAt !== undefined) {
          open.item.durationMs = Math.max(0, endedAt - open.startedAt);
        }
      } else {
        // An orphan result still shows in order, but through the same
        // cataloged-identity gate as its call: an untrusted name stays
        // anonymous and the payload never enters. The pager stitches a page
        // boundary that split the call from its result back together; a gap
        // wider than one page keeps the bounded orphan row.
        const name = typeof result.toolName === "string" ? result.toolName : "";
        projected.push(genericLine(`tool result: ${rosterToolArgsDisplay(name, undefined).tool}`, entryId));
        orphanResults.push({
          callId,
          isError: result.isError === true,
          ...(entryTimestamp !== undefined ? { endedAt: entryTimestamp } : {}),
          index: projected.length - 1,
        });
      }
      continue;
    }

    // A message role outside the supported vocabulary is conversationally
    // meaningful: it becomes one non-empty generic line, never a silent gap.
    projected.push(genericLine("unsupported message entry", entryId));
  }

  if (projected.length <= windowSize) {
    return { items: projected, omitted: 0, openToolCalls: openCalls, orphanResults };
  }
  const dropped = projected.length - windowSize;
  const items = projected.slice(dropped);
  return {
    items,
    omitted: dropped,
    openToolCalls: openCalls,
    orphanResults: orphanResults
      .map((orphan) => ({ ...orphan, index: orphan.index - dropped }))
      .filter((orphan) => orphan.index >= 0),
  };
}

/** Read-only view of one page-load attempt; page errors are observable only. */
export interface ChildHistorySnapshot {
  items: TranscriptItem[];
  /** Older unread bytes remain before the loaded window. */
  moreBefore: boolean;
  /** Newer unread bytes remain after the loaded window (eviction or appends). */
  moreAfter: boolean;
  /** Bounded retryable error for the last older/newer page attempt. */
  pageError?: string;
  /** Bounded reason the initial tail page could not be read at all. */
  initialError?: string;
}

/** The history surface the overlay consumes; strictly observational. */
export interface ChildHistoryView {
  snapshot(): ChildHistorySnapshot;
  /** Attempt one bounded older page; false when none loaded (exhausted or failed). */
  loadOlder(): boolean;
  /** Attempt one bounded newer page; false when none loaded. */
  loadNewer(): boolean;
  /** Retry a failed initial tail load; false when there was nothing to retry. */
  retryInitial(): boolean;
}

/** Injectable filesystem seam; production uses direct sync reads. */
export interface ChildHistoryIo {
  stat(file: string): { size: number; dev: number; ino: number };
  readRange(file: string, start: number, end: number): Buffer;
}

const defaultIo: ChildHistoryIo = {
  stat(file) {
    const stats = statSync(file);
    return { size: stats.size, dev: stats.dev, ino: stats.ino };
  },
  readRange(file, start, end) {
    if (end <= start) return EMPTY_BUFFER;
    const buffer = Buffer.alloc(end - start);
    const descriptor = openSync(file, "r");
    try {
      let read = 0;
      while (read < buffer.length) {
        const bytes = readSync(descriptor, buffer, read, buffer.length - read, start + read);
        if (bytes <= 0) break;
        read += bytes;
      }
      return read === buffer.length ? buffer : buffer.subarray(0, read);
    } finally {
      closeSync(descriptor);
    }
  },
};

export interface ChildHistoryOptions {
  /** Clock for unresolved tool-call durations; defaults to now. */
  observedAt?: number;
  /** Page size override for focused tests; defaults to 128 KiB. */
  pageBytes?: number;
  /** Per-entry byte cap override for focused tests; defaults to 1 MiB. */
  maxEntryBytes?: number;
  /** Filesystem seam override for focused tests. */
  io?: ChildHistoryIo;
}

interface HistoryPage {
  /** Byte offset where this page's read slice began (its unparsed head lives here). */
  readStart: number;
  /** Byte offset of this page's first parsed line (= readStart + head length). */
  parsedStart: number;
  /** Byte offset just past this page's newest terminated line. */
  lineEnd: number;
  /**
   * The slice's leading bytes, whose line began in older unread bytes. This is
   * the live stitch for the next older load and is restored from the new
   * oldest page whenever older eviction removes the page above it.
   */
  head: Buffer;
  items: TranscriptItem[];
  /** Calls this page left unresolved and results it could not pair. */
  pairing: {
    openCalls: Map<string, OpenToolCallRef>;
    /**
     * Unpaired results by call ID. `index` is the orphan's generic row while
     * it still renders, or null once a seam stitch removed the row — the
     * pairing stays re-playable if far-end eviction ever discards and reloads
     * the page that consumed it.
     */
    results: Map<string, { isError: boolean; endedAt?: number; index: number | null }>;
  };
}

/**
 * Pairs a page boundary back together: the newer page's leading orphan
 * results resolve the older page's still-open calls, updating each call in
 * place and dropping the orphan's generic row. The consumed result keeps its
 * call-id key with a null index, so a far-end eviction that later discards
 * and reloads the call's page can pair it again without duplicating a row. A
 * gap wider than one page keeps its bounded orphan rows.
 */
function stitchSeam(older: HistoryPage, newer: HistoryPage): void {
  if (older.pairing.openCalls.size === 0 || newer.pairing.results.size === 0) return;
  for (const [callId, result] of newer.pairing.results) {
    const open = older.pairing.openCalls.get(callId);
    if (open === undefined) continue;
    open.item.result = { isError: result.isError };
    if (open.startedAt !== undefined && result.endedAt !== undefined) {
      open.item.durationMs = Math.max(0, result.endedAt - open.startedAt);
    } else {
      delete open.item.durationMs;
    }
    older.pairing.openCalls.delete(callId);
    if (result.index === null) continue;
    newer.items.splice(result.index, 1);
    for (const other of newer.pairing.results.values()) {
      if (other !== result && other.index !== null && other.index > result.index) other.index -= 1;
    }
    result.index = null;
  }
}

/** Shared projection wrapper recording the pairing state alongside items. */
function projectPage(
  entries: readonly unknown[],
  observedAt: number,
): { items: TranscriptItem[]; pairing: HistoryPage["pairing"] } {
  const projection = projectSessionEntries(entries, Number.POSITIVE_INFINITY, observedAt);
  const results = new Map<string, { isError: boolean; endedAt?: number; index: number | null }>();
  for (const orphan of projection.orphanResults) {
    results.set(orphan.callId, {
      isError: orphan.isError,
      ...(orphan.endedAt !== undefined ? { endedAt: orphan.endedAt } : {}),
      index: orphan.index,
    });
  }
  return {
    items: projection.items,
    pairing: { openCalls: projection.openToolCalls, results },
  };
}

/**
 * Byte-anchored pager over the native session file, oldest page first in
 * `pages`. Every parsed entry's terminating newline has been read; the oldest
 * page's `head` holds bytes awaiting that terminator from the next older
 * slice, and while `floorUnterminated` is set the bytes at the oldest read
 * position belong to the file's unterminated final append and are never
 * parsed as history.
 */
export class ChildHistoryPager implements ChildHistoryView {
  private readonly id: string;
  private readonly pageBytes: number;
  private readonly maxEntryBytes: number;
  private readonly io: ChildHistoryIo;
  private readonly observedAt: number;

  private sessionFile = "";
  private identity: { dev: number; ino: number } | undefined;
  private pages: HistoryPage[] = [];
  /** Oldest byte ever read while no parsed page exists yet (starts at the tail read start). */
  private walkFloor = 0;
  /** The bytes at the loaded floor continue into the file's unterminated final line. */
  private floorUnterminated = false;
  private lastSize = 0;
  private theInitialError: string | undefined;
  private thePageError: string | undefined;

  constructor(id: string, options: ChildHistoryOptions = {}) {
    this.id = id;
    this.pageBytes = Math.max(16, Math.floor(options.pageBytes ?? DEFAULT_PAGE_BYTES));
    this.maxEntryBytes = Math.max(32, Math.floor(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES));
    this.io = options.io ?? defaultIo;
    this.observedAt = options.observedAt ?? Date.now();
    this.loadInitial();
  }

  snapshot(): ChildHistorySnapshot {
    return {
      items: this.pages.flatMap((page) => page.items),
      moreBefore: this.oldestReadStart() > 0,
      moreAfter: this.pages.length > 0 && this.pages[this.pages.length - 1]!.lineEnd < this.lastSize,
      ...(this.thePageError !== undefined ? { pageError: this.thePageError } : {}),
      ...(this.theInitialError !== undefined ? { initialError: this.theInitialError } : {}),
    };
  }

  loadOlder(): boolean {
    if (this.theInitialError !== undefined) return false;
    if (this.oldestReadStart() === 0) return false;
    try {
      const loaded = this.floorUnterminated ? this.loadOlderUnterminated() : this.loadOlderStitched();
      if (loaded) {
        this.thePageError = undefined;
        this.evictOverBound("newest");
      }
      return loaded;
    } catch {
      // A malformed or oversized line fails this page only; every previously
      // validated page stays visible and the request can be retried.
      this.thePageError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
  }

  loadNewer(): boolean {
    if (this.theInitialError !== undefined) return false;
    if (this.pages.length === 0) return false;
    const start = this.pages[this.pages.length - 1]!.lineEnd;
    const guard = this.guardFile(start);
    if (!guard) return false;
    if (start >= guard.size) return false;
    const end = Math.min(guard.size, start + this.pageBytes);
    let slice: Buffer;
    try {
      slice = this.io.readRange(this.sessionFile, start, end);
    } catch {
      this.thePageError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
    const lines = collectCompleteLines(slice, 0);
    if (lines.length === 0) return false;
    const lastNewline = slice.lastIndexOf(NEWLINE);
    let entries: unknown[];
    try {
      entries = this.parseLineBuffers(slice, lines);
    } catch {
      this.thePageError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
    const page = projectPage(entries, this.observedAt);
    this.pages.push({
      readStart: start,
      parsedStart: start,
      lineEnd: start + lastNewline + 1,
      head: EMPTY_BUFFER,
      items: page.items,
      pairing: page.pairing,
    });
    stitchSeam(this.pages[this.pages.length - 2]!, this.pages[this.pages.length - 1]!);
    this.thePageError = undefined;
    this.evictOverBound("oldest");
    return true;
  }

  retryInitial(): boolean {
    if (this.theInitialError === undefined) return false;
    this.loadInitial();
    return this.theInitialError === undefined;
  }

  private loadInitial(): void {
    this.pages = [];
    this.walkFloor = 0;
    this.floorUnterminated = false;
    this.theInitialError = undefined;
    this.thePageError = undefined;
    this.identity = undefined;
    try {
      const { details, sessionFile } = resolveChildSessionFile(this.id, "view");
      this.sessionFile = sessionFile;
      const { size, dev, ino } = this.io.stat(sessionFile);
      if (size <= 0) throw new Error("empty session file");
      this.identity = { dev, ino };
      this.lastSize = size;

      const header = this.io.readRange(sessionFile, 0, Math.min(size, MAX_HEADER_READ_BYTES));
      const headerText = header.toString("utf8");
      const cut = headerText.indexOf("\n");
      const headerLine = JSON.parse(cut === -1 ? headerText : headerText.slice(0, cut)) as { type?: unknown; id?: unknown };
      if (headerLine?.type !== "session" || headerLine.id !== details.sessionId) {
        throw new Error("native session header does not match run.json");
      }

      const tailStart = Math.max(0, size - this.pageBytes);
      const tail = this.io.readRange(sessionFile, tailStart, size);
      this.walkFloor = tailStart;
      const firstNewline = tail.indexOf(NEWLINE);
      if (firstNewline === -1) {
        // No terminated line exists in the read tail: every byte belongs to
        // the file's unterminated final line (a very large mid-append entry,
        // or a file that is only its header without a trailing newline).
        this.floorUnterminated = true;
        return;
      }
      const lastNewline = tail.lastIndexOf(NEWLINE);
      const startAt = tailStart === 0 ? 0 : firstNewline + 1;
      const entries = this.parseLineBuffers(tail, collectCompleteLines(tail, startAt));
      const page = projectPage(entries, this.observedAt);
      this.pages.push({
        readStart: tailStart,
        parsedStart: tailStart + startAt,
        lineEnd: tailStart + lastNewline + 1,
        head: tailStart > 0 ? tail.subarray(0, firstNewline) : EMPTY_BUFFER,
        items: page.items,
        pairing: page.pairing,
      });
    } catch {
      // Filesystem, identity, and parser failures may quote session paths,
      // malformed fragments, or provider identifiers; the viewer exposes only
      // the bounded read state and nothing else.
      this.pages = [];
      this.walkFloor = 0;
      this.floorUnterminated = false;
      this.identity = undefined;
      this.theInitialError = CHILD_HISTORY_READ_ERROR;
    }
  }

  private oldestReadStart(): number {
    return this.pages.length > 0 ? this.pages[0]!.readStart : this.walkFloor;
  }

  /** Re-verifies file identity and that the loaded window still fits the file. */
  private guardFile(minLoadedByte: number): { size: number } | undefined {
    try {
      const { size, dev, ino } = this.io.stat(this.sessionFile);
      if (this.identity !== undefined && (dev !== this.identity.dev || ino !== this.identity.ino)) {
        throw new Error("session file identity changed");
      }
      if (size < minLoadedByte) throw new Error("session file shrank below the loaded window");
      this.lastSize = size;
      return { size };
    } catch {
      this.thePageError = CHILD_HISTORY_READ_ERROR;
      return undefined;
    }
  }

  private loadOlderStitched(): boolean {
    const floor = this.pages[0]!.readStart;
    const stitch = this.pages[0]!.head;
    const target = Math.max(0, floor - this.pageBytes);
    if (!this.guardFile(floor)) return false;
    let slice: Buffer;
    try {
      slice = this.io.readRange(this.sessionFile, target, floor);
    } catch {
      this.thePageError = CHILD_HISTORY_READ_ERROR;
      return false;
    }

    const firstNewline = slice.indexOf(NEWLINE);
    if (firstNewline === -1) {
      // The whole slice continues the stitched line, whose terminator lies in
      // already-loaded newer bytes. Extend the live stitch and stop; the line
      // parses when a slice containing its beginning arrives.
      if (slice.length + stitch.length > this.maxEntryBytes) {
        this.thePageError = CHILD_HISTORY_READ_ERROR;
        return false;
      }
      this.pages[0] = {
        ...this.pages[0]!,
        readStart: target,
        parsedStart: target + slice.length + stitch.length,
        head: Buffer.concat([slice, stitch]),
      };
      return true;
    }
    const lastNewline = slice.lastIndexOf(NEWLINE);
    const startAt = target === 0 ? 0 : firstNewline + 1;
    const lines = collectCompleteLines(slice, startAt);
    const straddle = Buffer.concat([slice.subarray(lastNewline + 1), stitch]);
    const ordered = [...lines, ...(straddle.length > 0 ? [{ start: -1, end: straddle.length }] : [])];
    const entries = this.parseStitched(slice, ordered, straddle);
    const page = projectPage(entries, this.observedAt);
    this.pages.unshift({
      readStart: target,
      parsedStart: target + startAt,
      lineEnd: floor + stitch.length,
      head: target > 0 ? slice.subarray(0, firstNewline) : EMPTY_BUFFER,
      items: page.items,
      pairing: page.pairing,
    });
    if (this.pages.length > 1) stitchSeam(this.pages[0]!, this.pages[1]!);
    return true;
  }

  private loadOlderUnterminated(): boolean {
    let floor = this.walkFloor;
    let walked = Math.max(0, this.lastSize - floor);
    for (;;) {
      const target = Math.max(0, floor - this.pageBytes);
      if (!this.guardFile(floor)) return false;
      let slice: Buffer;
      try {
        slice = this.io.readRange(this.sessionFile, target, floor);
      } catch {
        this.thePageError = CHILD_HISTORY_READ_ERROR;
        return false;
      }
      const firstNewline = slice.indexOf(NEWLINE);
      if (firstNewline === -1) {
        walked += slice.length;
        if (walked > this.maxEntryBytes) {
          this.thePageError = CHILD_HISTORY_READ_ERROR;
          return false;
        }
        this.walkFloor = target;
        if (target === 0) return false;
        floor = target;
        continue;
      }
      // The final line stays unterminated above the last terminator in this
      // slice; its leading bytes here are dropped, never parsed as history.
      const lastNewline = slice.lastIndexOf(NEWLINE);
      const startAt = target === 0 ? 0 : firstNewline + 1;
      const entries = this.parseLineBuffers(slice, collectCompleteLines(slice, startAt));
      const page = projectPage(entries, this.observedAt);
      this.pages.unshift({
        readStart: target,
        parsedStart: target + startAt,
        lineEnd: target + lastNewline + 1,
        head: target > 0 ? slice.subarray(0, firstNewline) : EMPTY_BUFFER,
        items: page.items,
        pairing: page.pairing,
      });
      if (this.pages.length > 1) stitchSeam(this.pages[0]!, this.pages[1]!);
      this.floorUnterminated = false;
      return true;
    }
  }

  /** Parses complete in-slice lines; a malformed or oversized line fails the page. */
  private parseLineBuffers(
    slice: Buffer,
    lines: ReadonlyArray<{ start: number; end: number }>,
  ): unknown[] {
    const entries: unknown[] = [];
    for (const line of lines) {
      if (line.end <= line.start) continue;
      entries.push(this.parseEntry(slice.subarray(line.start, line.end)));
    }
    return entries;
  }

  /** Parses in-slice lines plus the byte-stitched straddle line (`start: -1`). */
  private parseStitched(
    slice: Buffer,
    ordered: ReadonlyArray<{ start: number; end: number }>,
    straddle: Buffer,
  ): unknown[] {
    const entries: unknown[] = [];
    for (const line of ordered) {
      if (line.start === -1) {
        entries.push(this.parseEntry(straddle));
        continue;
      }
      if (line.end <= line.start) continue;
      entries.push(this.parseEntry(slice.subarray(line.start, line.end)));
    }
    return entries;
  }

  private parseEntry(line: Buffer): unknown {
    if (line.length > this.maxEntryBytes) throw new Error("session entry exceeds the size cap");
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      throw new Error("session entry is not valid JSON");
    }
    if (!entry || typeof entry !== "object") throw new Error("session entry is not an object");
    return entry;
  }

  /**
   * Enforces the in-memory window. Older loads evict from the newest end and
   * newer loads from the oldest end, always keeping at least one page so the
   * loaded window never empties itself; evicted bytes stay reachable through
   * the opposite load direction.
   */
  private evictOverBound(end: "newest" | "oldest"): void {
    while (this.totalItems() > MAX_LOADED_ITEMS && this.pages.length > 1) {
      if (end === "newest") this.pages.pop();
      else this.pages.shift();
    }
  }

  private totalItems(): number {
    let total = 0;
    for (const page of this.pages) total += page.items.length;
    return total;
  }
}

/** Line ranges of `buffer` whose terminating newline it contains, from `startAt`. */
function collectCompleteLines(
  buffer: Buffer,
  startAt: number,
): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = startAt;
  for (let index = startAt; index < buffer.length; index += 1) {
    if (buffer[index] === NEWLINE) {
      lines.push({ start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

/** Fixed history for tests and static fallbacks; loads never add anything. */
export function staticChildHistory(
  items: readonly TranscriptItem[],
  options: { moreBefore?: boolean; moreAfter?: boolean } = {},
): ChildHistoryView {
  const snapshot: ChildHistorySnapshot = {
    items: [...items],
    moreBefore: options.moreBefore === true,
    moreAfter: options.moreAfter === true,
  };
  return {
    snapshot: () => snapshot,
    loadOlder: () => false,
    loadNewer: () => false,
    retryInitial: () => false,
  };
}

/** Opens a pager over the child's validated native session file. */
export function createChildHistory(id: string, options: ChildHistoryOptions = {}): ChildHistoryPager {
  return new ChildHistoryPager(id, options);
}
