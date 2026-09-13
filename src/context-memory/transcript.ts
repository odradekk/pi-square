import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isEligibleContentPart } from "./derive";

/**
 * The versioned source transcript renderer and fixed paging contract
 * (odradekk/pi-square#215, #217, #339).
 *
 * The same renderer and paging serve the model tools (`read_memory_source`,
 * `search_memory_source`) and the human `/context memory <block> [page]`
 * inspection. The transcript preserves source chronology and roles — user,
 * assistant, assistant thinking, tool call, tool result, custom message, and
 * branch summary — with exact textual content, tool name/call pairing, and
 * error state. It never contains storage paths, session/header data, entry or
 * parent IDs, timestamps, provider usage or metadata, extension details,
 * hashes, raw JSON envelopes, or binary payloads; image parts become
 * deterministic type/MIME/size placeholders.
 *
 * Since #339 the renderer also reports non-crossable source boundaries for
 * literal search: every entry join, and every join where an ineligible
 * (protocol) part was omitted between two rendered pieces, is a boundary no
 * search match may span, so no phrase is manufactured over removed content or
 * across renderer framing. The rendered text itself is byte-identical to the
 * pre-#339 renderer; `read_memory_source` keeps consuming only the text.
 */

/** Fixed source page size: at most 16 KiB UTF-8 per page (#215). */
export const MEMORY_SOURCE_PAGE_MAX_BYTES = 16 * 1024;

/** The transcript version marker opening every rendered source transcript. */
export const MEMORY_TRANSCRIPT_HEADER = "context-memory source transcript v1";

const CONTROL_REPLACEMENT = "�";

/**
 * Map prohibited control characters (C0 except tab/newline/carriage return,
 * plus DEL) to U+FFFD so transcript text stays safe for terminal rendering
 * while remaining deterministic. Everything else is preserved exactly.
 */
function safeText(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const prohibited = (code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r") || code === 0x7f;
    result += prohibited ? CONTROL_REPLACEMENT : char;
  }
  return result;
}

function textPart(text: string): string {
  const safe = safeText(text);
  return safe.length > 0 ? safe : "(empty)";
}

/** Decoded byte size of a base64 image payload, without copying the payload. */
function imageByteSize(data: string): number {
  let length = data.length;
  while (length > 0 && data[length - 1] === "=") length -= 1;
  return Math.floor((length * 3) / 4);
}

function imagePlaceholder(mimeType: unknown, byteNote: string): string {
  const type = typeof mimeType === "string" && mimeType.length > 0 ? mimeType : "unknown type";
  return `[image · ${type}${byteNote}]`;
}

interface ContentPart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly redacted?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
}

function partArguments(part: ContentPart): string {
  try {
    return JSON.stringify(part.arguments ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function partByteNote(part: ContentPart): string {
  const data = part.data;
  if (typeof data !== "string" || data.length === 0) return "";
  return ` · ${imageByteSize(data)} B`;
}

/**
 * One rendered transcript line plus the search-boundary flag (#339):
 * `cutBefore` marks that at least one ineligible (protocol) part was omitted
 * between this line's rendering and the previous rendered piece, so literal
 * search must never manufacture a match across that join.
 */
interface RenderedPiece {
  line: string;
  cutBefore: boolean;
}

function piece(line: string, cutBefore: boolean): RenderedPiece {
  return { line, cutBefore };
}

/**
 * Render one entry's eligible content parts under role labels. Protocol
 * artifacts (`submit_memory`, `compact_to_memory_block`, `read_memory_source`,
 * and `search_memory_source` tool calls and paired results) never enter the
 * transcript; ordinary parts in the same message are preserved (#215). Where
 * such a part was omitted between two rendered pieces, the following piece is
 * marked as a non-crossable join (#339).
 */
function renderEntryPieces(entry: SessionEntry): RenderedPiece[] {
  const pieces: RenderedPiece[] = [];
  switch (entry.type) {
    case "message": {
      const message = (entry as { message: { role?: unknown; content?: unknown } }).message;
      if (message.role === "toolResult") {
        const toolName = (message as { toolName?: unknown }).toolName;
        const name = typeof toolName === "string" && toolName ? toolName : "tool";
        const error = (message as { isError?: unknown }).isError === true;
        pieces.push(piece(`[tool result] ${name}${error ? " · error" : " · ok"}`, false));
        const content = message.content;
        if (typeof content === "string") {
          pieces.push(piece(textPart(content), false));
        } else if (Array.isArray(content)) {
          let omitted = false;
          let renderedAny = false;
          for (const raw of content) {
            if (!isEligibleContentPart(raw)) {
              omitted = true;
              continue;
            }
            const candidate = raw as ContentPart;
            if (candidate.type === "image") {
              pieces.push(piece(imagePlaceholder(candidate.mimeType, partByteNote(candidate)), omitted && renderedAny));
            } else {
              pieces.push(piece(textPart(typeof candidate.text === "string" ? candidate.text : ""), omitted && renderedAny));
            }
            omitted = false;
            renderedAny = true;
          }
          if (!renderedAny) pieces.push(piece("(empty)", false));
        } else {
          pieces.push(piece("(empty)", false));
        }
        break;
      }
      const label = message.role === "assistant" ? "assistant" : "user";
      if (typeof message.content === "string") {
        pieces.push(piece(`[${label}]`, false));
        pieces.push(piece(textPart(message.content), false));
        break;
      }
      const parts = Array.isArray(message.content) ? message.content : [];
      let plain: RenderedPiece[] | null = null;
      let pendingOmission = false;
      // The next rendered line consumes a pending omission as a cut whenever
      // rendered content already precedes it inside this entry.
      const takeCut = () => {
        const cut = pendingOmission && (pieces.length > 0 || (plain !== null && plain.length > 0));
        pendingOmission = false;
        return cut;
      };
      const flushPlain = () => {
        if (!plain) return;
        // A cut pending on the plain run's first piece belongs on the label
        // line that introduces it.
        const cut = plain[0].cutBefore;
        if (cut) plain[0].cutBefore = false;
        pieces.push(piece(`[${label}]`, cut), ...plain);
        plain = null;
      };
      for (const raw of parts) {
        if (!isEligibleContentPart(raw)) {
          pendingOmission = true;
          continue;
        }
        const candidate = raw as ContentPart;
        if (candidate.type === "text") {
          plain ??= [];
          plain.push(piece(textPart(typeof candidate.text === "string" ? candidate.text : ""), takeCut()));
        } else {
          flushPlain();
          const cut = takeCut();
          if (candidate.type === "thinking") {
            pieces.push(piece(`[${label} · thinking]`, cut));
            pieces.push(piece(candidate.redacted === true
              ? "(redacted thinking)"
              : textPart(typeof candidate.thinking === "string" ? candidate.thinking : ""), false));
          } else if (candidate.type === "image") {
            pieces.push(piece(`[${label} · image] ${imagePlaceholder(candidate.mimeType, partByteNote(candidate))}`, cut));
          } else if (candidate.type === "toolCall") {
            const name = typeof candidate.name === "string" && candidate.name ? candidate.name : "tool";
            pieces.push(piece(`[${label} · tool call] ${name}`, cut));
            pieces.push(piece(safeText(partArguments(candidate)), false));
          }
        }
      }
      flushPlain();
      if (pieces.length === 0) {
        pieces.push(piece(`[${label}]`, false), piece("(empty)", false));
      }
      break;
    }
    case "custom_message": {
      pieces.push(piece("[custom message]", false));
      const content = (entry as { content?: unknown }).content;
      if (typeof content === "string") {
        pieces.push(piece(textPart(content), false));
      } else if (Array.isArray(content)) {
        let omitted = false;
        let renderedAny = false;
        for (const raw of content) {
          if (!isEligibleContentPart(raw)) {
            omitted = true;
            continue;
          }
          const candidate = raw as ContentPart;
          if (candidate.type === "image") {
            pieces.push(piece(imagePlaceholder(candidate.mimeType, partByteNote(candidate)), omitted && renderedAny));
          } else {
            pieces.push(piece(textPart(typeof candidate.text === "string" ? candidate.text : ""), omitted && renderedAny));
          }
          omitted = false;
          renderedAny = true;
        }
        if (!renderedAny) pieces.push(piece("(empty)", false));
      } else {
        pieces.push(piece("(empty)", false));
      }
      break;
    }
    case "branch_summary": {
      pieces.push(piece("[branch summary]", false));
      pieces.push(piece(textPart((entry as { summary?: unknown }).summary as string), false));
      break;
    }
    default:
      break;
  }
  return pieces;
}

/** The rendered transcript plus its non-crossable search boundaries (#339). */
export interface SourceTranscriptRender {
  /** Byte-identical to the pre-#339 `renderSourceTranscript` output. */
  readonly text: string;
  /**
   * Sorted code-unit offsets of separator newlines that join two rendered
   * pieces across an entry boundary or an omitted protocol part. A literal
   * search match may not include any of these units, and an excerpt may not
   * extend across one, so no phrase is manufactured over removed content.
   */
  readonly boundaries: readonly number[];
}

/**
 * Deterministically render one block's complete eligible source range into
 * the versioned readable transcript, in source chronology, together with the
 * non-crossable source boundaries literal search must respect (#339).
 */
export function renderSourceTranscriptWithBoundaries(entries: readonly SessionEntry[]): SourceTranscriptRender {
  const lines: string[] = [MEMORY_TRANSCRIPT_HEADER];
  const cutLines = new Set<number>();
  for (const entry of entries) {
    // Every entry join is a boundary: original conversation text never spans
    // entries, and an ineligible protocol exchange between two eligible
    // entries is invisible here, so join points are never treated as
    // continuous original text.
    cutLines.add(lines.length);
    lines.push("");
    for (const rendered of renderEntryPieces(entry)) {
      if (rendered.cutBefore) cutLines.add(lines.length);
      lines.push(rendered.line);
    }
  }
  const boundaries: number[] = [];
  let cursor = 0;
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && cutLines.has(index)) boundaries.push(cursor - 1);
    cursor += lines[index]!.length + 1;
  }
  return { text: `${lines.join("\n")}\n`, boundaries };
}

/**
 * Deterministically render one block's complete eligible source range into
 * the versioned readable transcript, in source chronology. The reading
 * surface's fixed contract (#215, #217): text only, no boundaries.
 */
export function renderSourceTranscript(entries: readonly SessionEntry[]): string {
  return renderSourceTranscriptWithBoundaries(entries).text;
}

/**
 * Fixed code-point-safe paging: pages of at most 16 KiB UTF-8, cut on byte
 * boundaries that never split a code point. No cursor, offset, configurable
 * limit, truncation, cache, or persisted read state (#215).
 */
export function paginateTranscript(transcript: string): string[] {
  const bytes = Buffer.from(transcript, "utf8");
  if (bytes.length === 0) return [];
  const pages: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + MEMORY_SOURCE_PAGE_MAX_BYTES, bytes.length);
    // Back off while the cut would land inside a multi-byte code point
    // (a continuation byte marks an incomplete sequence at the boundary).
    while (end > offset + 1 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    pages.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return pages;
}
