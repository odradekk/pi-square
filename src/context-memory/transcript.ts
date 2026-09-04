import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isEligibleContentPart } from "./derive";

/**
 * The versioned source transcript renderer and fixed paging contract
 * (odradekk/pi-square#215, #217).
 *
 * The same renderer and paging serve the model tool (`read_memory_source`)
 * and the human `/context memory <block> [page]` inspection. The transcript
 * preserves source chronology and roles — user, assistant, assistant
 * thinking, tool call, tool result, custom message, and branch summary — with
 * exact textual content, tool name/call pairing, and error state. It never
 * contains storage paths, session/header data, entry or parent IDs,
 * timestamps, provider usage or metadata, extension details, hashes, raw JSON
 * envelopes, or binary payloads; image parts become deterministic
 * type/MIME/size placeholders.
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
 * Render one entry's eligible content parts under role labels. Protocol
 * artifacts (`submit_memory`, `read_memory_source` tool calls and paired
 * results) never enter the transcript; ordinary parts in the same message are
 * preserved (#215).
 */
function renderEntryLines(entry: SessionEntry): string[] {
  const lines: string[] = [];
  switch (entry.type) {
    case "message": {
      const message = (entry as { message: { role?: unknown; content?: unknown } }).message;
      if (message.role === "toolResult") {
        const toolName = (message as { toolName?: unknown }).toolName;
        const name = typeof toolName === "string" && toolName ? toolName : "tool";
        const error = (message as { isError?: unknown }).isError === true;
        lines.push(`[tool result] ${name}${error ? " · error" : " · ok"}`);
        const content = message.content;
        if (typeof content === "string") {
          lines.push(textPart(content));
        } else if (Array.isArray(content)) {
          const rendered = content.filter(isEligibleContentPart).map((part) => {
            const candidate = part as ContentPart;
            if (candidate.type === "image") return imagePlaceholder(candidate.mimeType, partByteNote(candidate));
            return textPart(typeof candidate.text === "string" ? candidate.text : "");
          });
          lines.push(...(rendered.length > 0 ? rendered : ["(empty)"]));
        } else {
          lines.push("(empty)");
        }
        break;
      }
      const label = message.role === "assistant" ? "assistant" : "user";
      if (typeof message.content === "string") {
        lines.push(`[${label}]`);
        lines.push(textPart(message.content));
        break;
      }
      const parts = (Array.isArray(message.content) ? message.content : []).filter(isEligibleContentPart);
      const groups: string[] = [];
      let plain: string[] | null = null;
      for (const part of parts) {
        const candidate = part as ContentPart;
        if (candidate.type === "text") {
          plain ??= [];
          plain.push(textPart(typeof candidate.text === "string" ? candidate.text : ""));
        } else {
          if (plain) {
            groups.push(`[${label}]`, ...plain);
            plain = null;
          }
          if (candidate.type === "thinking") {
            groups.push(`[${label} · thinking]`);
            groups.push(candidate.redacted === true
              ? "(redacted thinking)"
              : textPart(typeof candidate.thinking === "string" ? candidate.thinking : ""));
          } else if (candidate.type === "image") {
            groups.push(`[${label} · image] ${imagePlaceholder(candidate.mimeType, partByteNote(candidate))}`);
          } else if (candidate.type === "toolCall") {
            const name = typeof candidate.name === "string" && candidate.name ? candidate.name : "tool";
            groups.push(`[${label} · tool call] ${name}`);
            groups.push(safeText(partArguments(candidate)));
          }
        }
      }
      if (plain) groups.push(`[${label}]`, ...plain);
      lines.push(...(groups.length > 0 ? groups : [`[${label}]`, "(empty)"]));
      break;
    }
    case "custom_message": {
      lines.push("[custom message]");
      const content = (entry as { content?: unknown }).content;
      if (typeof content === "string") {
        lines.push(textPart(content));
      } else if (Array.isArray(content)) {
        const rendered = content.filter(isEligibleContentPart).map((part) => {
          const candidate = part as ContentPart;
          if (candidate.type === "image") {
            return imagePlaceholder(candidate.mimeType, partByteNote(candidate));
          }
          return textPart(typeof candidate.text === "string" ? candidate.text : "");
        });
        lines.push(...(rendered.length > 0 ? rendered : ["(empty)"]));
      } else {
        lines.push("(empty)");
      }
      break;
    }
    case "branch_summary": {
      lines.push("[branch summary]");
      lines.push(textPart((entry as { summary?: unknown }).summary as string));
      break;
    }
    default:
      break;
  }
  return lines;
}

/**
 * Deterministically render one block's complete eligible source range into
 * the versioned readable transcript, in source chronology.
 */
export function renderSourceTranscript(entries: readonly SessionEntry[]): string {
  const lines: string[] = [MEMORY_TRANSCRIPT_HEADER];
  for (const entry of entries) {
    lines.push("");
    lines.push(...renderEntryLines(entry));
  }
  return lines.join("\n") + "\n";
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
