import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
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
 * describing that directory, and the session file inside it, and requires the
 * recorded path to name a regular file directly — and pages that file
 * tail-first in bounded byte ranges. It creates no second transcript store: no cache file,
 * index, sidecar, writer, lock, journal, migration, or artifact version
 * exists beside the native session file, and every read is stateless against
 * it.
 *
 * Page boundaries are byte offsets, but entries are only ever parsed from
 * newline-terminated byte ranges, stitched at the byte level in both paging
 * directions, so a multibyte UTF-8 sequence or a JSON line split across two
 * pages is decoded exactly once — never split, duplicated, or silently
 * omitted. Every parsed line must carry the minimal native envelope (a
 * non-empty string `type` and a non-empty string `id`), and entry ids must be
 * unique within a load and across the loaded window; a line that is not a
 * valid native record — malformed JSON, a scalar, an invalid or duplicate
 * identity, or past the per-entry cap — fails that one page load with one
 * bounded reason while every previously validated page stays visible and the
 * same request can be retried. An unterminated final line is the running
 * child's mid-append input and is never parsed as history.
 *
 * Every read opens the file once, verifies the opened descriptor's dev/ino
 * identity through `fstat`, checks that the path before and after opening names
 * that same regular node, and reads bytes from the descriptor. Reads in each
 * direction carry their own bounded retryable error, so an older failure never
 * masks or mislabels a newer one.
 *
 * Memory stays explicitly bounded: the snapshot never exposes more than
 * {@link MAX_LOADED_ITEMS} projected items (each already text-budgeted by the
 * projection), and the pager retains at most {@link MAX_LOADED_PAGES} parsed
 * pages even when internal metadata produces no visible item. A page whose
 * parse exceeds the item bound keeps a window into its own projection, and
 * trimming drops windows from the end opposite the paging direction, so
 * trimmed history remains reachable on demand in both directions — nothing
 * is silently discarded. One stitched entry may never exceed
 * {@link DEFAULT_MAX_ENTRY_BYTES}. A failure here is a viewer error only:
 * paging never touches the child lifecycle, abort signal, persistence,
 * delivery, wait ownership, or resume eligibility.
 */

/** Bytes read per bounded page, tail-first. */
const DEFAULT_PAGE_BYTES = 131_072;
/** Hard cap on one stitched JSONL entry; a larger line fails the page load. */
const DEFAULT_MAX_ENTRY_BYTES = 1_048_576;
/** Hard cap on retained projected items — the in-memory window. */
export const MAX_LOADED_ITEMS = 480;
/** Hard cap on retained parsed pages, including pages with no projected item. */
export const MAX_LOADED_PAGES = 64;
/** Bytes read from the head just to validate the session header line. */
const MAX_HEADER_READ_BYTES = 4_096;
/** The one bounded reason every read, parse, and identity failure surfaces. */
export const CHILD_HISTORY_READ_ERROR = "child history could not be read";

const NEWLINE = 0x0a;
const EMPTY_BUFFER = Buffer.alloc(0);

interface TranscriptIdentity {
  entryId?: string;
  /** Native JSONL byte offset; internal ordering identity, never rendered. */
  entryByteOffset?: number;
  /** Stable ordinal of this projected item inside its native session entry. */
  entryItemIndex?: number;
}

export type TranscriptItem = (
  | { kind: "user"; text: string }
  | { kind: "assistant"; message: Record<string, unknown> }
  | {
    kind: "toolCall";
    name: string;
    summary: string;
    /**
     * Non-reversible key of the native tool-call id for live/persisted
     * reconciliation; internal identity only, never rendered, and the raw id
     * never enters the projection.
     */
    callKey?: string;
    durationMs?: number;
    result?: { isError: boolean };
    /**
     * Bounded, sanitized result evidence for the expanded tool row (#307):
     * the shared credential-neutral sanitizer plus an explicit head/tail
     * budget, projected from the tool-result entry's text parts. The collapsed
     * row never shows it, raw arguments never enter, and no unbounded payload
     * crosses the projection boundary.
     */
    output?: string;
  }
  | { kind: "generic"; text: string }
) & TranscriptIdentity;

export interface ChildTranscriptProjection {
  items: TranscriptItem[];
  /** Items older than the bounded window that exist in the projected input. */
  omitted: number;
  /** Calls these entries opened, retained so page seams can be replayed. */
  openToolCalls: Map<string, OpenToolCallRef>;
  /** Tool results whose calls live before these entries, in entry order. */
  orphanResults: OrphanToolResultRef[];
}

/** One unresolved call opened by the projected entries, for page stitching. */
export interface OpenToolCallRef {
  item: TranscriptItem & { kind: "toolCall" };
  startedAt?: number;
}

/** Bounded terminal evidence retained while a result crosses a page seam. */
interface ToolResultProjection {
  isError: boolean;
  endedAt?: number;
  output?: string;
}

/** One unpaired tool result in entry order, for page stitching. */
export interface OrphanToolResultRef extends ToolResultProjection {
  callKey: string;
  /** Index into the projected items of the orphan's generic row. */
  index: number;
}

/** Per-item text budget through the shared head/tail clipper. */
const MAX_ENTRY_TEXT = 2_000;
/** Head/tail budget for one tool call's expanded result evidence (#307). */
const MAX_TOOL_OUTPUT = 600;

/**
 * Bounded sanitized result evidence for the expanded tool row: only text
 * parts of the tool-result content cross, through the shared sanitizer and
 * a hard-total head/tail clip. Anything else (images, structured payloads,
 * unbounded text) stays out of the projection entirely.
 */
function boundedToolOutput(content: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { type?: unknown; text?: unknown }).text;
      if ((part as { type?: unknown }).type === "text" && typeof text === "string") parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  const clean = sanitizeSubagentDisplay(parts.join("\n")).trim();
  if (clean === "") return undefined;
  if (clean.length <= MAX_TOOL_OUTPUT) return clean;
  // The shared delivery clipper excludes its omission marker from the caller's
  // budget. Viewer evidence instead has a hard total projection cap, so choose
  // the largest 70/30 head-tail split whose marker also fits inside 600 chars.
  let clipped = "";
  for (let retained = MAX_TOOL_OUTPUT; retained >= 0; retained -= 1) {
    const head = Math.floor(retained * 0.7);
    const tail = retained - head;
    const omitted = clean.length - retained;
    const marker = `\n... [omitted ${omitted} characters] ...\n`;
    if (retained + marker.length > MAX_TOOL_OUTPUT) continue;
    clipped = `${clean.slice(0, head)}${marker}${clean.slice(clean.length - tail)}`;
    break;
  }
  return clipped === "" ? undefined : clipped;
}
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


/** One bounded display-safe assistant content part. */
export type AssistantTextPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

/** Hard part-count bound of the shared assistant projection, both sides. */
export const MAX_ASSISTANT_PARTS = 512;

/**
 * Non-reversible identity of one native tool-call id, shared by the persisted
 * projection and the live viewer tail so live tool rows reconcile against
 * their own persisted call rows without the raw id ever entering a projected
 * item or a rendered line.
 */
export function callKeyOf(nativeCallId: string): string {
  return createHash("sha256").update(nativeCallId).digest("hex");
}

/**
 * Bounded non-reversible identity of one already-bounded assistant content
 * projection. Live events and persisted rows use this instead of retaining a
 * second copy of the projected text in omission bookkeeping.
 */
export function assistantContentKey(content: readonly AssistantTextPart[]): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * The ordered bounded text/thinking projection of assistant message content,
 * shared by the persisted transcript projection and the live viewer tail so a
 * message rendered live matches its persisted counterpart exactly — the
 * equality the live/persisted reconciliation confirms against. Both sides
 * carry the same per-part budget and the same part-count bound, so the
 * projection of one message is always finite and identical everywhere.
 */
export function boundedAssistantTextParts(content: unknown): AssistantTextPart[] {
  const parts: AssistantTextPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (parts.length >= MAX_ASSISTANT_PARTS) break;
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      const text = safeEntryText(part.text);
      if (text) parts.push({ type: "text", text });
    } else if (part.type === "thinking") {
      const thinking = safeEntryText(part.thinking);
      if (thinking) parts.push({ type: "thinking", thinking });
    }
  }
  return parts;
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
 * entry id (`entryId`) and, for native paged reads, their exact JSONL line-start
 * offset, so callers can key positions and reconcile live completions without
 * holding raw history. Tool calls keep their conversational order and state but
 * project only through the roster-grade allowlisted identity/summary seam the
 * roster rows share. Raw arguments and call IDs never enter an item a renderer
 * can show; a paired result may add one bounded, sanitized text projection for
 * the expanded evidence body. A bounded non-reversible call key pairs a result
 * with its call and is never rendered. Content that is out of scope but
 * conversationally meaningful becomes one non-empty sanitized generic line
 * instead of silently disappearing.
 */
export function projectSessionEntries(
  entries: readonly unknown[],
  windowSize = 24,
  observedAt?: number,
  entryByteOffsets: ReadonlyMap<string, number> = new Map(),
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
      const boundedContent = boundedAssistantTextParts(content);
      const assistantItems: Array<TranscriptItem & { kind: "assistant" }> = [];
      const calls: Array<TranscriptItem & { kind: "toolCall" }> = [];
      const unsupported: TranscriptItem[] = [];
      const startedAt = entryTimestamp;
      for (const part of content) {
        if (!part || typeof part !== "object") {
          unsupported.push(genericLine("unsupported assistant content", entryId));
          continue;
        }
        if (part.type === "toolCall") {
          // The roster-grade shared projection: cataloged identity plus
          // structural counts/ranges only; free-form paths, patterns, queries,
          // and commands never project, and unknown names stay anonymous.
          const display = rosterToolArgsDisplay(String(part.name ?? ""), part.arguments);
          // The native call id travels only as a non-reversible key so live
          // tool rows reconcile against their own persisted call and result;
          // the raw id never enters the projection anywhere.
          const nativeCallId = typeof part.id === "string" ? part.id : undefined;
          const call = {
            kind: "toolCall",
            name: display.tool,
            summary: display.summary,
            ...(nativeCallId !== undefined && nativeCallId !== "" ? { callKey: callKeyOf(nativeCallId) } : {}),
            ...(startedAt !== undefined && observedAt !== undefined
              ? { durationMs: Math.max(0, observedAt - startedAt) }
              : {}),
            ...(entryId !== undefined ? { entryId } : {}),
          } as TranscriptItem & { kind: "toolCall" };
          calls.push(call);
          if (nativeCallId !== undefined && nativeCallId !== "") {
            openCalls.set(callKeyOf(nativeCallId), { item: call, startedAt });
          }
        } else if (part.type !== "text" && part.type !== "thinking") {
          // Text and thinking parts already entered the bounded content
          // projection above; only genuinely unsupported parts fall through.
          unsupported.push(genericLine("unsupported assistant content", entryId));
        }
      }
      if (boundedContent.length > 0) {
        // The message timestamp travels with the projection as internal
        // identity for live/persisted reconciliation; no renderer shows it.
        const messageTimestamp = timestamp((message as { timestamp?: unknown }).timestamp);
        const item = {
          kind: "assistant",
          message: {
            role: "assistant",
            content: boundedContent,
            ...(messageTimestamp !== undefined ? { timestamp: messageTimestamp } : {}),
          },
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
      // A result contributes terminal state plus one bounded, sanitized text
      // projection for expanded evidence; raw and unbounded payloads never
      // enter the transcript projection.
      const result = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; content?: unknown };
      const callId = typeof result.toolCallId === "string" ? result.toolCallId : "";
      const callKey = callId ? callKeyOf(callId) : "";
      const open = callKey ? openCalls.get(callKey) : undefined;
      const output = boundedToolOutput(result.content);
      if (open) {
        open.item.result = { isError: result.isError === true };
        if (output !== undefined) open.item.output = output;
        const endedAt = entryTimestamp;
        if (open.startedAt !== undefined && endedAt !== undefined) {
          open.item.durationMs = Math.max(0, endedAt - open.startedAt);
        }
      } else {
        // An orphan result still shows in order through the same cataloged-
        // identity gate as its call: an untrusted name stays anonymous, and
        // its bounded sanitized output is retained only for a later adjacent-
        // page pairing. Until then no result evidence renders. A gap wider
        // than one page keeps the bounded orphan row.
        const name = typeof result.toolName === "string" ? result.toolName : "";
        projected.push(genericLine(`tool result: ${rosterToolArgsDisplay(name, undefined).tool}`, entryId));
        orphanResults.push({
          callKey,
          isError: result.isError === true,
          ...(entryTimestamp !== undefined ? { endedAt: entryTimestamp } : {}),
          ...(output !== undefined ? { output } : {}),
          index: projected.length - 1,
        });
      }
      continue;
    }

    // A message role outside the supported vocabulary is conversationally
    // meaningful: it becomes one non-empty generic line, never a silent gap.
    projected.push(genericLine("unsupported message entry", entryId));
  }

  // Assign ordinals before slicing so a retained part of one native entry
  // keeps the same identity when its page window moves.
  const entryOccurrences = new Map<string, number>();
  for (const item of projected) {
    if (item.entryId === undefined) continue;
    const entryByteOffset = entryByteOffsets.get(item.entryId);
    if (entryByteOffset !== undefined) item.entryByteOffset = entryByteOffset;
    const occurrence = entryOccurrences.get(item.entryId) ?? 0;
    item.entryItemIndex = occurrence;
    entryOccurrences.set(item.entryId, occurrence + 1);
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

/** Read-only view of one paging state; page errors are observable only. */
export interface ChildHistorySnapshot {
  items: TranscriptItem[];
  /** Older unread history remains before the loaded window. */
  moreBefore: boolean;
  /** Newer unread history remains after the loaded window (trim or appends). */
  moreAfter: boolean;
  /** Bounded retryable error for the last older page attempt. */
  olderError?: string;
  /** Bounded retryable error for the last newer page attempt. */
  newerError?: string;
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

/**
 * Injectable filesystem seam. One call opens the file once, reads the bytes
 * from that same descriptor, and reports the descriptor's own `fstat`
 * identity. Production binds the pre-open path, opened descriptor, and
 * post-open path to one regular-file identity. The final path component is
 * never followed through a symlink.
 */
export interface ChildHistoryIo {
  readRange(
    file: string,
    start: number,
    end: number,
  ): { stat: { size: number; dev: number; ino: number }; data: Buffer };
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const defaultIo: ChildHistoryIo = {
  readRange(file, start, end) {
    // O_NOFOLLOW rejects a final symlink where available; O_NONBLOCK prevents
    // a raced FIFO replacement from hanging the UI. The pre/open/post identity
    // checks bind fallback platforms to one unchanged regular path.
    const before = lstatSync(file);
    if (!before.isFile()) throw new Error("session path is not a regular file");
    const descriptor = openSync(file, OPEN_FLAGS);
    try {
      const stats = fstatSync(descriptor);
      const after = lstatSync(file);
      if (
        !stats.isFile() || !after.isFile()
        || before.dev !== stats.dev || before.ino !== stats.ino
        || after.dev !== stats.dev || after.ino !== stats.ino
      ) {
        throw new Error("session path changed while opening");
      }
      if (end <= start) {
        return { stat: { size: stats.size, dev: stats.dev, ino: stats.ino }, data: EMPTY_BUFFER };
      }
      const length = Math.min(end, stats.size) - start;
      if (length <= 0) {
        return { stat: { size: stats.size, dev: stats.dev, ino: stats.ino }, data: EMPTY_BUFFER };
      }
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < buffer.length) {
        const bytes = readSync(descriptor, buffer, read, buffer.length - read, start + read);
        if (bytes <= 0) break;
        read += bytes;
      }
      return {
        stat: { size: stats.size, dev: stats.dev, ino: stats.ino },
        data: read === buffer.length ? buffer : buffer.subarray(0, read),
      };
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

/** Pairing state for one page's window, re-playable across window moves. */
interface PagePairing {
  openCalls: Map<string, OpenToolCallRef>;
  /**
   * Unpaired results by non-reversible call key. `itemIndex` is stable within
   * the full page projection; `index` locates the row inside the retained
   * window or is null while that row lies outside it.
   */
  results: Map<string, ToolResultProjection & { index: number | null; itemIndex: number }>;
}

interface HistoryPage {
  /** Byte offset where this page's read slice began (its unparsed head lives here). */
  readStart: number;
  /** Byte offset of the page group's first parsed line; window re-reads start here. */
  parsedStart: number;
  /** Byte offset just past the page group's newest terminated line. */
  lineEnd: number;
  /**
   * The slice's leading bytes, whose line began in older unread bytes. This is
   * the live stitch for the next older byte load and is restored from the new
   * oldest page whenever trimming removes the page above it.
   */
  head: Buffer;
  /** The page's retained window into its group projection. */
  items: TranscriptItem[];
  /** Window start within the group projection; `0` when nothing was trimmed. */
  itemFrom: number;
  /** Total items the group projection produced. */
  groupCount: number;
  /** Entry ids this page parsed, for duplicate-identity detection. */
  entryIds: Set<string>;
  /** Cross-page results already folded into their older tool-call row. */
  consumedResults: Map<string, ToolResultProjection>;
  pairing: PagePairing;
}

/**
 * Byte-anchored pager over the native session file, oldest page first in
 * `pages`. Every parsed entry's terminating newline has been read; the oldest
 * page's `head` holds bytes awaiting that terminator from the next older
 * slice, the forward fragment holds bytes past the newest page's `lineEnd`
 * whose terminator lies in unread newer bytes, and while `floorUnterminated`
 * is set the bytes at the oldest read position belong to the file's
 * unterminated final append and are never parsed as history.
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
  /** Forward stitch: bytes past the newest page's lineEnd, not yet terminated. */
  private forwardFragment: Buffer = EMPTY_BUFFER;
  private theInitialError: string | undefined;
  private theOlderError: string | undefined;
  private theNewerError: string | undefined;

  constructor(id: string, options: ChildHistoryOptions = {}) {
    this.id = id;
    this.pageBytes = Math.max(16, Math.floor(options.pageBytes ?? DEFAULT_PAGE_BYTES));
    this.maxEntryBytes = Math.max(32, Math.floor(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES));
    this.io = options.io ?? defaultIo;
    this.observedAt = options.observedAt ?? Date.now();
    this.loadInitial();
  }

  snapshot(): ChildHistorySnapshot {
    const oldest = this.pages[0];
    const newest = this.pages[this.pages.length - 1];
    return {
      items: this.pages.flatMap((page) => page.items),
      moreBefore: this.pages.length > 0
        ? oldest!.itemFrom > 0 || oldest!.readStart > 0
        : this.walkFloor > 0,
      moreAfter: this.pages.length > 0
        && (newest!.itemFrom + newest!.items.length < newest!.groupCount || newest!.lineEnd < this.lastSize),
      ...(this.theOlderError !== undefined ? { olderError: this.theOlderError } : {}),
      ...(this.theNewerError !== undefined ? { newerError: this.theNewerError } : {}),
      ...(this.theInitialError !== undefined ? { initialError: this.theInitialError } : {}),
    };
  }

  loadOlder(): boolean {
    if (this.theInitialError !== undefined) return false;
    if (this.pages.length > 0 && this.pages[0]!.itemFrom > 0) {
      return this.shiftWindowOlder();
    }
    if (this.oldestReadStart() === 0) return false;
    try {
      const loaded = this.floorUnterminated ? this.loadOlderUnterminated() : this.loadOlderStitched();
      this.theOlderError = undefined;
      if (loaded) {
        this.compactEmptyPages();
        this.trimToBound("newest");
      }
      return loaded;
    } catch {
      // A malformed, invalid, or oversized record fails this page only; every
      // previously validated page stays visible and the request is retryable.
      this.theOlderError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
  }

  loadNewer(): boolean {
    if (this.theInitialError !== undefined) return false;
    if (this.pages.length === 0) return false;
    const newest = this.pages[this.pages.length - 1]!;
    if (newest.itemFrom + newest.items.length < newest.groupCount) {
      return this.shiftWindowNewer();
    }
    try {
      const loaded = this.readForward();
      this.theNewerError = undefined;
      if (loaded) {
        this.compactEmptyPages();
        this.trimToBound("oldest");
      }
      return loaded;
    } catch {
      this.forwardFragment = EMPTY_BUFFER;
      this.theNewerError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
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
    this.forwardFragment = EMPTY_BUFFER;
    this.theInitialError = undefined;
    this.theOlderError = undefined;
    this.theNewerError = undefined;
    this.identity = undefined;
    try {
      const { details, sessionFile } = resolveChildSessionFile(this.id, "view");
      this.sessionFile = sessionFile;
      const headerRead = this.io.readRange(sessionFile, 0, MAX_HEADER_READ_BYTES);
      if (headerRead.stat.size <= 0) throw new Error("empty session file");
      this.identity = { dev: headerRead.stat.dev, ino: headerRead.stat.ino };
      this.lastSize = headerRead.stat.size;

      const headerText = headerRead.data.toString("utf8");
      const cut = headerText.indexOf("\n");
      const headerLine = JSON.parse(cut === -1 ? headerText : headerText.slice(0, cut)) as { type?: unknown; id?: unknown };
      if (headerLine?.type !== "session" || headerLine.id !== details.sessionId) {
        throw new Error("native session header does not match run.json");
      }

      const size = headerRead.stat.size;
      const tailStart = Math.max(0, size - this.pageBytes);
      const tailRead = this.io.readRange(sessionFile, tailStart, size);
      this.verifyDescriptor(tailRead.stat, tailStart);
      const tail = tailRead.data;
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
      const group = this.parseGroup(
        tail,
        collectCompleteLines(tail, startAt),
        this.pages,
        { sliceStart: tailStart },
      );
      this.pages.push({
        readStart: tailStart,
        parsedStart: tailStart + startAt,
        lineEnd: tailStart + lastNewline + 1,
        head: tailStart > 0 ? tail.subarray(0, firstNewline) : EMPTY_BUFFER,
        items: group.items,
        itemFrom: group.itemFrom,
        groupCount: group.groupCount,
        entryIds: group.entryIds,
        consumedResults: new Map(),
        pairing: group.pairing,
      });
    } catch {
      // Filesystem, identity, and parser failures may quote session paths,
      // malformed fragments, or provider identifiers; the viewer exposes only
      // the bounded read state and nothing else.
      this.pages = [];
      this.walkFloor = 0;
      this.floorUnterminated = false;
      this.identity = undefined;
      this.forwardFragment = EMPTY_BUFFER;
      this.theInitialError = CHILD_HISTORY_READ_ERROR;
    }
  }

  private oldestReadStart(): number {
    return this.pages.length > 0 ? this.pages[0]!.readStart : this.walkFloor;
  }

  /** Verifies a completed read's descriptor identity against the opened one. */
  private verifyDescriptor(stat: { size: number; dev: number; ino: number }, minLoadedByte: number): void {
    if (this.identity !== undefined && (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)) {
      throw new Error("session file identity changed");
    }
    if (stat.size < minLoadedByte) throw new Error("session file shrank below the loaded window");
    this.lastSize = stat.size;
  }

  /**
   * Forward byte-stitched read from the newest loaded line boundary. The
   * retained fragment carries bytes whose terminating newline lies ahead, so
   * a complete entry larger than one page — up to the per-entry cap — stitches
   * across as many forward reads as it needs instead of stalling.
   */
  private readForward(): boolean {
    const start = this.pages[this.pages.length - 1]!.lineEnd;
    let fragment = this.forwardFragment;
    let cursor = start + fragment.length;
    for (;;) {
      const read = this.io.readRange(this.sessionFile, cursor, cursor + this.pageBytes);
      this.verifyDescriptor(read.stat, start);
      if (read.data.length === 0) {
        // At or past EOF: any fragment is the running child's incomplete
        // final append — retained, never parsed, never an error.
        this.forwardFragment = fragment;
        return false;
      }
      const data = read.data;
      const end = cursor + data.length;
      const firstNewline = data.indexOf(NEWLINE);
      if (firstNewline === -1) {
        fragment = Buffer.concat([fragment, data]);
        if (fragment.length > this.maxEntryBytes) {
          this.forwardFragment = EMPTY_BUFFER;
          throw new Error("forward fragment exceeds the entry cap");
        }
        cursor = end;
        continue;
      }
      const lastNewline = data.lastIndexOf(NEWLINE);
      const firstLine = Buffer.concat([fragment, data.subarray(0, firstNewline)]);
      // The slice's first complete line belongs to the stitched fragment; the
      // interior lines after it parse in place, newest last.
      const interior = collectCompleteLines(data, firstNewline + 1);
      const group = this.parseGroup(
        data,
        [...(firstLine.length > 0 ? [{ start: -1, end: firstLine.length }] : []), ...interior],
        this.pages,
        { sliceStart: cursor, stitchedStart: start },
        firstLine,
      );
      const trailing = data.subarray(lastNewline + 1);
      this.forwardFragment = end < read.stat.size ? trailing : EMPTY_BUFFER;
      this.pages.push({
        readStart: start,
        parsedStart: start,
        lineEnd: cursor + lastNewline + 1,
        head: EMPTY_BUFFER,
        items: group.items,
        itemFrom: group.itemFrom,
        groupCount: group.groupCount,
        entryIds: group.entryIds,
        consumedResults: new Map(),
        pairing: group.pairing,
      });
      stitchSeam(this.pages[this.pages.length - 2]!, this.pages[this.pages.length - 1]!);
      return true;
    }
  }

  /** Slide the oldest page's window back through its own parsed group. */
  private shiftWindowOlder(): boolean {
    const page = this.pages[0]!;
    const windowEnd = page.itemFrom;
    try {
      const group = this.rereadGroup(page, this.pages.slice(1));
      const from = Math.max(0, windowEnd - MAX_LOADED_ITEMS);
      const items = group.allItems.slice(from, windowEnd);
      this.pages[0] = {
        ...page,
        items,
        itemFrom: from,
        entryIds: group.entryIds,
        pairing: windowPairing(group.full, from, items),
      };
      this.restitchAround(0);
      this.theOlderError = undefined;
      this.trimToBound("newest");
      return items.length > 0;
    } catch {
      this.theOlderError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
  }

  /** Slide the newest page's window forward through its own parsed group. */
  private shiftWindowNewer(): boolean {
    const page = this.pages[this.pages.length - 1]!;
    const windowEnd = page.itemFrom + page.items.length;
    try {
      const group = this.rereadGroup(page, this.pages.slice(0, -1));
      // Extend the window forward, keeping what it already holds.
      const to = Math.min(page.groupCount, windowEnd + MAX_LOADED_ITEMS);
      const items = group.allItems.slice(page.itemFrom, to);
      this.pages[this.pages.length - 1] = {
        ...page,
        items,
        entryIds: group.entryIds,
        pairing: windowPairing(group.full, page.itemFrom, items),
      };
      this.restitchAround(this.pages.length - 1);
      this.theNewerError = undefined;
      const added = items.length > page.items.length;
      this.trimToBound("oldest");
      return added;
    } catch {
      this.theNewerError = CHILD_HISTORY_READ_ERROR;
      return false;
    }
  }

  /** Re-reads one page's own parsed byte range and re-projects its group. */
  private rereadGroup(
    page: HistoryPage,
    others: readonly HistoryPage[],
  ): { allItems: TranscriptItem[]; entryIds: Set<string>; full: ChildTranscriptProjection } {
    const read = this.io.readRange(this.sessionFile, page.parsedStart, page.lineEnd);
    this.verifyDescriptor(read.stat, page.parsedStart);
    const group = this.parseGroup(
      read.data,
      collectCompleteLines(read.data, 0),
      others,
      { sliceStart: page.parsedStart },
      undefined,
      page.consumedResults,
    );
    return { allItems: group.allItems, entryIds: group.entryIds, full: group.full };
  }

  private loadOlderStitched(): boolean {
    const floor = this.pages[0]!.readStart;
    const stitch = this.pages[0]!.head;
    const target = Math.max(0, floor - this.pageBytes);
    const read = this.io.readRange(this.sessionFile, target, floor);
    this.verifyDescriptor(read.stat, floor);
    const slice = read.data;

    const firstNewline = slice.indexOf(NEWLINE);
    if (firstNewline === -1) {
      // The whole slice continues the stitched line, whose terminator lies in
      // already-loaded newer bytes. Extend the live stitch and stop; the line
      // parses when a slice containing its beginning arrives.
      if (slice.length + stitch.length > this.maxEntryBytes) {
        throw new Error("stitch exceeds the entry cap");
      }
      this.pages[0] = {
        ...this.pages[0]!,
        readStart: target,
        head: Buffer.concat([slice, stitch]),
      };
      return true;
    }
    const lastNewline = slice.lastIndexOf(NEWLINE);
    const startAt = target === 0 ? 0 : firstNewline + 1;
    const lines = collectCompleteLines(slice, startAt);
    const straddle = Buffer.concat([slice.subarray(lastNewline + 1), stitch]);
    const ordered = [...lines, ...(straddle.length > 0 ? [{ start: -1, end: straddle.length }] : [])];
    const group = this.parseGroup(
      slice,
      ordered,
      this.pages,
      { sliceStart: target, stitchedStart: target + lastNewline + 1 },
      straddle,
    );
    this.pages.unshift({
      readStart: target,
      parsedStart: target + startAt,
      // The straddle's terminating newline sits at `floor + stitch.length`;
      // lineEnd passes it so window re-reads cover the whole group.
      lineEnd: floor + stitch.length + 1,
      head: target > 0 ? slice.subarray(0, firstNewline) : EMPTY_BUFFER,
      items: group.items,
      itemFrom: group.itemFrom,
      groupCount: group.groupCount,
      entryIds: group.entryIds,
      consumedResults: new Map(),
      pairing: group.pairing,
    });
    if (this.pages.length > 1) stitchSeam(this.pages[0]!, this.pages[1]!);
    return true;
  }

  private loadOlderUnterminated(): boolean {
    let floor = this.walkFloor;
    let walked = Math.max(0, this.lastSize - floor);
    for (;;) {
      const target = Math.max(0, floor - this.pageBytes);
      const read = this.io.readRange(this.sessionFile, target, floor);
      this.verifyDescriptor(read.stat, floor);
      const slice = read.data;
      const firstNewline = slice.indexOf(NEWLINE);
      if (firstNewline === -1) {
        walked += slice.length;
        if (walked > this.maxEntryBytes) throw new Error("unterminated line exceeds the entry cap");
        this.walkFloor = target;
        if (target === 0) return false;
        floor = target;
        continue;
      }
      // The final line stays unterminated above the last terminator in this
      // slice; its leading bytes here are dropped, never parsed as history.
      const lastNewline = slice.lastIndexOf(NEWLINE);
      const startAt = target === 0 ? 0 : firstNewline + 1;
      const group = this.parseGroup(
        slice,
        collectCompleteLines(slice, startAt),
        this.pages,
        { sliceStart: target },
      );
      this.pages.unshift({
        readStart: target,
        parsedStart: target + startAt,
        lineEnd: target + lastNewline + 1,
        head: target > 0 ? slice.subarray(0, firstNewline) : EMPTY_BUFFER,
        items: group.items,
        itemFrom: group.itemFrom,
        groupCount: group.groupCount,
        entryIds: group.entryIds,
        consumedResults: new Map(),
        pairing: group.pairing,
      });
      if (this.pages.length > 1) stitchSeam(this.pages[0]!, this.pages[1]!);
      this.floorUnterminated = false;
      return true;
    }
  }

  /**
   * Parses, envelope-validates, and projects one page's complete lines. A
   * line must be valid JSON, a non-null object carrying the minimal native
   * envelope (non-empty string `type` and `id`), and its identity must be
   * unique within the load and across the loaded window. The returned window
   * keeps at most {@link MAX_LOADED_ITEMS} items of the group's projection —
   * the newest ones — so a single oversized group still yields a bounded page
   * whose trimmed head stays reachable through window shifts.
   */
  private parseGroup(
    slice: Buffer,
    lines: ReadonlyArray<{ start: number; end: number }>,
    others: readonly HistoryPage[],
    locations: { sliceStart: number; stitchedStart?: number },
    stitchedFirstLine?: Buffer,
    consumedResults: ReadonlyMap<string, ToolResultProjection> = new Map(),
  ): {
    items: TranscriptItem[];
    itemFrom: number;
    groupCount: number;
    entryIds: Set<string>;
    pairing: PagePairing;
    allItems: TranscriptItem[];
    full: ChildTranscriptProjection;
  } {
    const entries: unknown[] = [];
    const entryIds = new Set<string>();
    const entryByteOffsets = new Map<string, number>();
    for (const line of lines) {
      let entry: unknown;
      if (line.start === -1) {
        if (stitchedFirstLine === undefined || stitchedFirstLine.length === 0) continue;
        entry = this.parseEntry(stitchedFirstLine);
      } else {
        if (line.end <= line.start) continue;
        entry = this.parseEntry(slice.subarray(line.start, line.end));
      }
      const id = (entry as { id: string }).id;
      if (entryIds.has(id)) throw new Error("duplicate entry id in page");
      for (const page of others) {
        if (page.entryIds.has(id)) throw new Error("duplicate entry id across pages");
      }
      entryIds.add(id);
      const entryByteOffset = line.start === -1 ? locations.stitchedStart : locations.sliceStart + line.start;
      if (entryByteOffset === undefined) throw new Error("stitched entry has no byte offset");
      entryByteOffsets.set(id, entryByteOffset);
      entries.push(entry);
    }
    const full = projectSessionEntries(entries, Number.POSITIVE_INFINITY, this.observedAt, entryByteOffsets);
    suppressConsumedResults(full, consumedResults);
    const groupCount = full.items.length;
    if (groupCount <= MAX_LOADED_ITEMS) {
      return {
        items: full.items,
        itemFrom: 0,
        groupCount,
        entryIds,
        pairing: pagePairing(full, 0),
        allItems: full.items,
        full,
      };
    }
    const from = groupCount - MAX_LOADED_ITEMS;
    const items = full.items.slice(from);
    return {
      items,
      itemFrom: from,
      groupCount,
      entryIds,
      pairing: pagePairing(full, from),
      allItems: full.items,
      full,
    };
  }

  /** Minimal native envelope every historical record must carry. */
  private parseEntry(line: Buffer): unknown {
    if (line.length > this.maxEntryBytes) throw new Error("session entry exceeds the size cap");
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      throw new Error("session entry is not valid JSON");
    }
    if (!entry || typeof entry !== "object") throw new Error("session entry is not an object");
    const record = entry as { type?: unknown; id?: unknown };
    if (typeof record.type !== "string" || record.type === "") {
      throw new Error("session entry has no valid type");
    }
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error("session entry has no valid id");
    }
    return entry;
  }

  /**
   * Enforces the in-memory window from the end opposite the paging direction:
   * older loads trim from the newest end, newer loads from the oldest end.
   * Trimming shrinks page windows — the trimmed items stay inside their
   * group's projection and are reloaded on demand by shifting the window back
   * — so the bound never silently discards history.
   */
  private trimToBound(end: "newest" | "oldest"): void {
    while (this.totalItems() > MAX_LOADED_ITEMS || this.pages.length > MAX_LOADED_PAGES) {
      const overflow = this.totalItems() - MAX_LOADED_ITEMS;
      if (overflow <= 0 && this.pages.length > MAX_LOADED_PAGES) {
        if (end === "newest") {
          this.pages.pop();
          this.forwardFragment = EMPTY_BUFFER;
        } else {
          this.pages.shift();
        }
        continue;
      }
      if (end === "newest") {
        const last = this.pages[this.pages.length - 1]!;
        const drop = Math.min(overflow, last.items.length);
        if (drop > 0) {
          last.items = last.items.slice(0, last.items.length - drop);
          trimPairingFromEnd(last.pairing, last.items);
        } else if (this.pages.length > 1) {
          this.pages.pop();
          this.forwardFragment = EMPTY_BUFFER;
        } else {
          return;
        }
      } else {
        const first = this.pages[0]!;
        const drop = Math.min(overflow, first.items.length);
        if (drop > 0) {
          first.items = first.items.slice(drop);
          first.itemFrom += drop;
          trimPairingFromStart(first.pairing, drop);
        } else if (this.pages.length > 1) {
          this.pages.shift();
        } else {
          return;
        }
      }
    }
  }

  /**
   * Metadata-only pages carry no transcript position. Fold every such page
   * except a newest forward cursor into the following page's older byte
   * boundary, so long metadata runs cannot evict the visible row anchoring
   * the overlay while the parsed-page bound remains hard.
   */
  private compactEmptyPages(): void {
    for (let index = 0; index + 1 < this.pages.length;) {
      const page = this.pages[index]!;
      if (
        page.groupCount !== 0 || page.items.length !== 0
        || page.pairing.openCalls.size !== 0 || page.pairing.results.size !== 0
        || page.consumedResults.size !== 0
      ) {
        index += 1;
        continue;
      }
      const newer = this.pages[index + 1]!;
      newer.readStart = page.readStart;
      newer.head = page.head;
      this.pages.splice(index, 1);
      this.restitchAround(index);
    }
  }

  private totalItems(): number {
    let total = 0;
    for (const page of this.pages) total += page.items.length;
    return total;
  }

  private restitchAround(index: number): void {
    if (index > 0) stitchSeam(this.pages[index - 1]!, this.pages[index]!);
    if (index + 1 < this.pages.length) stitchSeam(this.pages[index]!, this.pages[index + 1]!);
  }
}

/**
 * Pairs a page boundary back together: the newer page's leading orphan
 * results resolve the older page's still-open calls, updating each call in
 * place and dropping the orphan's generic row. The newer page retains bounded
 * consumed-result metadata so re-windowing either page can replay the pairing
 * without restoring or duplicating the orphan row. A gap wider than one page
 * keeps its bounded orphan rows.
 */
function stitchSeam(older: HistoryPage, newer: HistoryPage): void {
  if (older.pairing.openCalls.size === 0) return;
  for (const [callId, result] of newer.consumedResults) {
    const open = older.pairing.openCalls.get(callId);
    if (open === undefined) continue;
    resolveOpenCall(open, result);
  }
  for (const [callId, result] of newer.pairing.results) {
    const open = older.pairing.openCalls.get(callId);
    if (open === undefined) continue;
    resolveOpenCall(open, result);
    newer.consumedResults.set(callId, {
      isError: result.isError,
      ...(result.endedAt !== undefined ? { endedAt: result.endedAt } : {}),
      ...(result.output !== undefined ? { output: result.output } : {}),
    });
    newer.groupCount = Math.max(0, newer.groupCount - 1);
    if (result.itemIndex < newer.itemFrom) newer.itemFrom = Math.max(0, newer.itemFrom - 1);
    if (result.index !== null) newer.items.splice(result.index, 1);
    for (const other of newer.pairing.results.values()) {
      if (other === result) continue;
      if (other.itemIndex > result.itemIndex) other.itemIndex -= 1;
      if (result.index !== null && other.index !== null && other.index > result.index) other.index -= 1;
    }
    newer.pairing.results.delete(callId);
  }
}

function resolveOpenCall(
  open: OpenToolCallRef,
  result: ToolResultProjection,
): void {
  open.item.result = { isError: result.isError };
  if (result.output !== undefined) open.item.output = result.output;
  else delete open.item.output;
  if (open.startedAt !== undefined && result.endedAt !== undefined) {
    open.item.durationMs = Math.max(0, result.endedAt - open.startedAt);
  } else {
    delete open.item.durationMs;
  }
}

/** Removes result rows already folded into an older call before re-windowing. */
function suppressConsumedResults(
  full: ChildTranscriptProjection,
  consumed: ReadonlyMap<string, ToolResultProjection>,
): void {
  if (consumed.size === 0) return;
  const dropped = full.orphanResults
    .filter((orphan) => consumed.has(orphan.callKey))
    .map((orphan) => orphan.index)
    .sort((left, right) => left - right);
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    full.items.splice(dropped[index]!, 1);
  }
  let droppedBefore = 0;
  const remaining: OrphanToolResultRef[] = [];
  for (const orphan of full.orphanResults) {
    if (consumed.has(orphan.callKey)) {
      droppedBefore += 1;
      continue;
    }
    remaining.push({ ...orphan, index: orphan.index - droppedBefore });
  }
  full.orphanResults = remaining;
}

/** Pairing state for one window `[from, from + items.length)` of a projection. */
function pagePairing(full: ChildTranscriptProjection, from: number, length = full.items.length - from): PagePairing {
  const openCalls = new Map<string, OpenToolCallRef>();
  for (const [callId, ref] of full.openToolCalls) {
    if (full.items.indexOf(ref.item) >= from) openCalls.set(callId, ref);
  }
  const results = new Map<string, ToolResultProjection & { index: number | null; itemIndex: number }>();
  for (const orphan of full.orphanResults) {
    results.set(orphan.callKey, {
      isError: orphan.isError,
      ...(orphan.endedAt !== undefined ? { endedAt: orphan.endedAt } : {}),
      ...(orphan.output !== undefined ? { output: orphan.output } : {}),
      index: orphan.index >= from && orphan.index < from + length ? orphan.index - from : null,
      itemIndex: orphan.index,
    });
  }
  return { openCalls, results };
}

/** Pairing for an explicitly re-sliced window of a full projection. */
function windowPairing(full: ChildTranscriptProjection, from: number, items: TranscriptItem[]): PagePairing {
  const pairing = pagePairing(full, from, items.length);
  const keep = new Set(items);
  for (const [callId, ref] of [...pairing.openCalls]) {
    if (!keep.has(ref.item)) pairing.openCalls.delete(callId);
  }
  return pairing;
}

/** Drops pairing rows whose items fell off a window's newest end. */
function trimPairingFromEnd(pairing: PagePairing, keptItems: readonly TranscriptItem[]): void {
  const keep = new Set(keptItems);
  for (const [callId, ref] of [...pairing.openCalls]) {
    if (!keep.has(ref.item)) pairing.openCalls.delete(callId);
  }
  for (const result of pairing.results.values()) {
    if (result.index !== null && result.index >= keptItems.length) result.index = null;
  }
}

/** Re-indexes pairing rows after items fell off a window's oldest end. */
function trimPairingFromStart(pairing: PagePairing, dropped: number): void {
  for (const result of pairing.results.values()) {
    if (result.index === null) continue;
    if (result.index < dropped) result.index = null;
    else result.index -= dropped;
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
  options: {
    moreBefore?: boolean;
    moreAfter?: boolean;
    olderError?: string;
    newerError?: string;
    initialError?: string;
  } = {},
): ChildHistoryView {
  const snapshot: ChildHistorySnapshot = {
    items: [...items],
    moreBefore: options.moreBefore === true,
    moreAfter: options.moreAfter === true,
    ...(options.olderError !== undefined ? { olderError: options.olderError } : {}),
    ...(options.newerError !== undefined ? { newerError: options.newerError } : {}),
    ...(options.initialError !== undefined ? { initialError: options.initialError } : {}),
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
