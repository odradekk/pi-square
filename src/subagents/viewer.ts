import { openSync, readSync, closeSync, statSync } from "node:fs";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  parseSessionEntries,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import { resolveChildSessionFile } from "./artifacts";
import { clipWithHeadTail } from "./confirmed-delivery";
import { sanitizeSubagentDisplay } from "./display";

/**
 * Read-only child transcript viewer (odradekk/pi-square#304).
 *
 * The viewer is one presentation-only projection of a background child. It
 * reads the child's validated native session artifacts through the same
 * identity checks resume uses, renders a bounded recent transcript with Pi's
 * public message components, and never mutates lifecycle, result ownership,
 * delivery, waiting, aborting, resume eligibility, persisted artifacts, or the
 * main transcript. The basic path here is deliberately static: the model is
 * frozen when the overlay opens; live streaming, older-history paging, and
 * cross-child navigation are later slices of #302.
 */

/** Bytes read from the tail of the native session file. */
const MAX_TRANSCRIPT_READ_BYTES = 262_144;
/** Bytes read from the head just to validate the session header line. */
const MAX_HEADER_READ_BYTES = 4_096;
/** Renderable items kept in the recent-transcript window. */
const MAX_TRANSCRIPT_ITEMS = 24;
/** Per-item text budget through the shared head/tail clipper. */
const MAX_ENTRY_TEXT = 2_000;
/** Single-line budget for generic fallback rows. */
const MAX_GENERIC_LINE = 200;
/** Overlay rows that are chrome: title, two rules, and the help row. */
const OVERLAY_CHROME_ROWS = 4;
/** Terminal size under which the overlay degrades to a one-cell-margin panel. */
const SMALL_TERMINAL_COLUMNS = 60;
const SMALL_TERMINAL_ROWS = 16;

export type ChildLifecycle = "queued" | "running" | "cancelling" | "completed" | "failed" | "aborted";

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; message: Record<string, unknown> }
  | { kind: "toolCall"; callId: string; name: string; args: unknown; result?: { text: string; isError: boolean } }
  | { kind: "generic"; text: string };

export interface ChildTranscriptProjection {
  items: TranscriptItem[];
  /** Items older than the bounded window that exist in the read tail. */
  omitted: number;
}

export type ChildTranscript =
  | ({ ok: true } & ChildTranscriptProjection)
  | { ok: false; reason: string };

function firstLine(raw: string): string {
  const cut = raw.indexOf("\n");
  return cut === -1 ? raw : raw.slice(0, cut);
}

function textFromParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n");
}

function genericLine(text: string): TranscriptItem {
  const clean = sanitizeSubagentDisplay(text).replace(/\s+/g, " ").trim();
  return { kind: "generic", text: clean.slice(0, MAX_GENERIC_LINE) };
}

function clipEntryText(text: unknown): string {
  return clipWithHeadTail(text, MAX_ENTRY_TEXT);
}

/**
 * Projects parsed native session entries into the ordered bounded transcript.
 * System material never enters: the session header, plain custom state
 * entries, labels, and metadata entries are ignored, and every rendered text
 * passes the shared credential-neutral sanitizer or Pi's own components.
 */
export function projectSessionEntries(
  entries: readonly unknown[],
  windowSize = MAX_TRANSCRIPT_ITEMS,
): ChildTranscriptProjection {
  const projected: TranscriptItem[] = [];
  const openCalls = new Map<string, TranscriptItem & { kind: "toolCall" }>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown };

    if (record.type === "session") continue;

    if (record.type === "compaction") {
      projected.push(genericLine("context compacted"));
      continue;
    }
    if (record.type === "branch_summary") {
      projected.push(genericLine("branch summary recorded"));
      continue;
    }
    if (record.type === "custom_message") {
      const custom = entry as { display?: unknown; content?: unknown };
      if (custom.display === true) projected.push(genericLine(textFromParts(custom.content)));
      continue;
    }
    if (record.type !== "message") continue;

    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;

    if (role === "user") {
      const text = clipEntryText(textFromParts((message as { content?: unknown }).content));
      if (text) projected.push({ kind: "user", text });
      continue;
    }

    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const boundedContent = content.map((part) => {
          if (!part || typeof part !== "object") return part;
          if (part.type === "text") return { ...part, text: clipEntryText(part.text) };
          if (part.type === "thinking") return { ...part, thinking: clipEntryText(part.thinking) };
          return part;
        });
        const speaks = boundedContent.some((part) => (
          part
          && typeof part === "object"
          && ((part.type === "text" && String(part.text).trim() !== "")
            || (part.type === "thinking" && String(part.thinking).trim() !== ""))
        ));
        if (speaks) projected.push({ kind: "assistant", message: { ...(message as object), content: boundedContent } });
        for (const part of boundedContent) {
          if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
          const call = {
            kind: "toolCall",
            callId: String(part.id ?? ""),
            name: sanitizeSubagentDisplay(part.name).slice(0, 64) || "tool",
            args: part.arguments,
          } as TranscriptItem & { kind: "toolCall" };
          projected.push(call);
          if (call.callId) openCalls.set(call.callId, call);
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const result = message as { toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown };
      const text = clipEntryText(textFromParts(result.content));
      const callId = typeof result.toolCallId === "string" ? result.toolCallId : "";
      const open = callId ? openCalls.get(callId) : undefined;
      if (open) {
        open.result = { text, isError: result.isError === true };
      } else {
        projected.push(genericLine(`tool result: ${typeof result.toolName === "string" ? result.toolName : "tool"}`));
      }
    }
  }

  if (projected.length <= windowSize) return { items: projected, omitted: 0 };
  return { items: projected.slice(projected.length - windowSize), omitted: projected.length - windowSize };
}

/**
 * Reads a bounded recent transcript from the child's native session file.
 * Reuses the shared artifact identity checks, then tolerates the running
 * child's mid-append tail: the head slice only validates the session header,
 * the tail slice drops its own torn first line, and Pi's public tolerant
 * parser skips any other malformed line. Failures surface as a bounded
 * `ok: false` reason for the overlay's explicit read-error state.
 */
export function readChildTranscript(id: string): ChildTranscript {
  try {
    const { details, sessionFile } = resolveChildSessionFile(id, "view");
    const size = statSync(sessionFile).size;

    const headerBuffer = Buffer.alloc(Math.min(size, MAX_HEADER_READ_BYTES));
    const descriptor = openSync(sessionFile, "r");
    try {
      readSync(descriptor, headerBuffer, 0, headerBuffer.length, 0);
    } finally {
      closeSync(descriptor);
    }
    const header = JSON.parse(firstLine(headerBuffer.toString("utf8"))) as { type?: unknown; id?: unknown };
    if (header?.type !== "session" || header.id !== details.sessionId) {
      throw new Error("native session header does not match run.json");
    }

    const tailStart = Math.max(0, size - MAX_TRANSCRIPT_READ_BYTES);
    const tailBuffer = Buffer.alloc(size - tailStart);
    const tailDescriptor = openSync(sessionFile, "r");
    try {
      readSync(tailDescriptor, tailBuffer, 0, tailBuffer.length, tailStart);
    } finally {
      closeSync(tailDescriptor);
    }
    let tail = tailBuffer.toString("utf8");
    if (tailStart > 0) {
      const lineBreak = tail.indexOf("\n");
      if (lineBreak !== -1) tail = tail.slice(lineBreak + 1);
    }

    return { ok: true, ...projectSessionEntries(parseSessionEntries(tail)) };
  } catch (error) {
    const reason = sanitizeSubagentDisplay(
      error instanceof Error && error.message ? error.message : "child history could not be read",
    ).replace(/\s+/g, " ").trim();
    return { ok: false, reason: reason.slice(0, MAX_GENERIC_LINE) || "child history could not be read" };
  }
}

export type ViewerInput =
  | { kind: "close" }
  | { kind: "replay"; text: string }
  | { kind: "ignore" };

/**
 * Classifies one raw terminal input event for the capturing overlay. Escape
 * closes; complete printable, paste, and composed-IME content replays into
 * the main editor; Backspace and Delete against the empty editor stay no-ops,
 * and every other key (arrows, Enter, shortcuts, modified keys) is suppressed
 * so no Pi application shortcut fires through the overlay.
 */
export function classifyViewerInput(data: string): ViewerInput {
  if (data === "" || isKeyRelease(data)) return { kind: "ignore" };
  const paste = /\x1b\[200~([\s\S]*?)(?:\x1b\[201~|$)/.exec(data);
  if (paste) {
    const text = paste[1] ?? "";
    return text === "" ? { kind: "ignore" } : { kind: "replay", text };
  }
  if (matchesKey(data, "escape")) return { kind: "close" };
  if (matchesKey(data, "backspace") || matchesKey(data, "delete")) return { kind: "ignore" };
  if (
    matchesKey(data, "up") || matchesKey(data, "down")
    || matchesKey(data, "left") || matchesKey(data, "right")
  ) return { kind: "ignore" };
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined && kitty !== "") return { kind: "replay", text: kitty };
  if (!data.includes("\x1b") && data.charCodeAt(0) >= 32) return { kind: "replay", text: data };
  return { kind: "ignore" };
}

export interface ChildOverlayPlan {
  overlay: OverlayOptions;
  /** Overlay rows available to the body after chrome. */
  bodyRows: number;
  small: boolean;
}

/**
 * Responsive overlay geometry. Normal terminals target 80% width and 75%
 * height centered; small terminals degrade to a near-fullscreen panel with a
 * one-cell margin. Percentages re-resolve on every Pi render, so a resize
 * keeps the overlay proportional; the small/normal mode is chosen when the
 * overlay opens, which is as dynamic as Pi 0.84.2's public overlay options
 * allow.
 */
export function childOverlayPlan(columns: number, rows: number): ChildOverlayPlan {
  const small = columns < SMALL_TERMINAL_COLUMNS || rows < SMALL_TERMINAL_ROWS;
  const totalRows = small
    ? Math.max(OVERLAY_CHROME_ROWS + 1, rows - 2)
    : Math.max(OVERLAY_CHROME_ROWS + 1, Math.floor(rows * 0.75));
  return {
    overlay: small
      ? { width: "100%", maxHeight: "100%", margin: 1, anchor: "center" }
      : { width: "80%", maxHeight: "75%", anchor: "center" },
    bodyRows: totalRows - OVERLAY_CHROME_ROWS,
    small,
  };
}

export interface ChildOverlayModel {
  role: string;
  /** Collision-safe public-ID prefix computed for the current roster. */
  idLabel: string;
  lifecycleLabel: string;
  lifecycleTone: ThemeColor;
  status: ChildLifecycle;
  durationText: string;
  /** Cleaned failure/abort evidence for terminal runs with no transcript. */
  failureReason?: string;
  transcript: ChildTranscript;
  cwd: string;
}

export interface ChildOverlayInput {
  tui: TUI;
  theme: Theme;
  model: ChildOverlayModel;
  /** Escape path: close, clear selection, and return focus to main. */
  onClose(): void;
  /** Replay path: close, then place the complete text in the empty editor. */
  onReplay(text: string): void;
}

function emptyStateLine(model: ChildOverlayModel): { text: string; tone: ThemeColor } {
  const transcript = model.transcript;
  if (!transcript.ok) return { text: `Transcript unavailable: ${transcript.reason}`, tone: "error" };
  if (transcript.items.length > 0) return { text: "", tone: "muted" };
  switch (model.status) {
    case "queued":
      return { text: "Waiting to start", tone: "muted" };
    case "running":
    case "cancelling":
      return { text: "Starting…", tone: "muted" };
    case "failed":
      return { text: model.failureReason ? `Failed: ${model.failureReason}` : "Failed", tone: "error" };
    case "aborted":
      return { text: model.failureReason ? `Aborted: ${model.failureReason}` : "Aborted", tone: "warning" };
    default:
      return { text: "No transcript recorded.", tone: "muted" };
  }
}

/**
 * The capturing overlay component: one title row, one bounded transcript
 * body, and one help row between quiet rules. All content is frozen when the
 * component is built, so rendered lines cache by width and terminal size like
 * the other pi-square frame components.
 */
export class ChildTranscriptOverlay implements Component {
  private readonly input: ChildOverlayInput;
  private readonly theme: Theme;
  private readonly markdown = getMarkdownTheme();
  private readonly bodyComponents: Component[] = [];
  private readonly state: { text: string; tone: ThemeColor };
  private readonly omitted: number;
  private cache: { width: number; rows: number; lines: string[] } | undefined;

  constructor(input: ChildOverlayInput) {
    this.input = input;
    this.theme = input.theme;
    this.state = emptyStateLine(input.model);
    this.omitted = input.model.transcript.ok ? input.model.transcript.omitted : 0;

    if (input.model.transcript.ok) {
      for (const item of input.model.transcript.items) {
        try {
          this.bodyComponents.push(...this.componentsFor(item));
        } catch {
          // A single entry that Pi's components cannot build renders through
          // the sanitized generic fallback; the view never throws.
          this.bodyComponents.push(this.genericTextComponent(this.describeItem(item)));
        }
      }
    }
  }

  private genericTextComponent(text: string): Component {
    const line = truncateToWidth(this.theme.fg("muted", text), 512, "…");
    return { render: () => [line], invalidate: () => {} };
  }

  private describeItem(item: TranscriptItem): string {
    switch (item.kind) {
      case "user": return "unsupported user message";
      case "assistant": return "unsupported assistant message";
      case "toolCall": return `unsupported tool call: ${item.name}`;
      default: return item.text || "unsupported entry";
    }
  }

  private componentsFor(item: TranscriptItem): Component[] {
    switch (item.kind) {
      case "user":
        return [new UserMessageComponent(item.text, this.markdown)];
      case "assistant":
        return [new AssistantMessageComponent(
          item.message as never,
          false,
          this.markdown,
        )];
      case "toolCall": {
        const tool = new ToolExecutionComponent(
          item.name,
          item.callId,
          item.args,
          { showImages: false },
          undefined,
          this.input.tui,
          this.input.model.cwd,
        );
        tool.setExpanded(false);
        tool.markExecutionStarted();
        tool.setArgsComplete();
        if (item.result) {
          tool.updateResult({ content: [{ type: "text", text: item.result.text }], isError: item.result.isError }, false);
        }
        return [tool];
      }
      default:
        return [this.genericTextComponent(item.text)];
    }
  }

  handleInput(data: string): void {
    const classified = classifyViewerInput(data);
    if (classified.kind === "close") this.input.onClose();
    else if (classified.kind === "replay") this.input.onReplay(classified.text);
  }

  invalidate(): void {
    this.cache = undefined;
    for (const component of this.bodyComponents) component.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const terminal = this.input.tui.terminal;
    const plan = childOverlayPlan(terminal.columns, terminal.rows);
    if (this.cache && this.cache.width === safeWidth && this.cache.rows === terminal.rows) return this.cache.lines;

    const model = this.input.model;
    const title = truncateToWidth(
      [
        this.theme.fg("accent", model.role),
        this.theme.fg("dim", model.idLabel),
        this.theme.fg(model.lifecycleTone, model.lifecycleLabel),
        this.theme.fg("dim", model.durationText),
      ].join(" "),
      safeWidth,
      "…",
    );
    const rule = this.theme.fg("border", "─".repeat(safeWidth));
    const help = truncateToWidth(
      this.theme.fg("muted", "esc close · type or paste to return to the main editor"),
      safeWidth,
      "…",
    );

    const body = this.renderBody(safeWidth, plan.bodyRows);
    const lines = [title, rule, ...body, rule, help];
    this.cache = { width: safeWidth, rows: terminal.rows, lines };
    return lines;
  }

  private renderBody(width: number, budget: number): string[] {
    if (this.state.text !== "") {
      return [truncateToWidth(this.theme.fg(this.state.tone, `  ${this.state.text}`), width, "…")];
    }

    const indent = "  ";
    const contentWidth = Math.max(1, width - visibleWidth(indent));
    const rendered: string[] = [];
    for (const component of this.bodyComponents) {
      for (const line of component.render(contentWidth)) {
        rendered.push(indent + line);
      }
    }

    if (rendered.length <= budget) {
      const lead = this.omitted > 0
        ? [truncateToWidth(this.theme.fg("dim", `  … +${this.omitted} earlier entries`), width, "…")]
        : [];
      return [...lead, ...rendered];
    }
    // Keep the recent tail inside the budget and state the cut once. The lead
    // line replaces the entries marker when both would show.
    const lead = [truncateToWidth(
      this.theme.fg("dim", `  … +${rendered.length - budget + 1} earlier lines`),
      width,
      "…",
    )];
    return [...lead, ...rendered.slice(rendered.length - budget + 1)];
  }
}
