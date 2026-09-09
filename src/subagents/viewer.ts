import { openSync, readSync, closeSync, statSync } from "node:fs";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  parseSessionEntries,
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
import { OperationalDisplayComponent } from "../display/components";
import { getCatalogEntry } from "../display/catalog";
import type { DisplayRuntime } from "../display/runtime";
import { DEFAULT_DISPLAY_POLICY, type DisplayDescriptionV1 } from "../display/types";
import { resolveChildSessionFile } from "./artifacts";
import { clipWithHeadTail } from "./confirmed-delivery";
import { sanitizeSubagentDisplay } from "./display";
import { rosterToolArgsDisplay } from "./tool-display";

/**
 * Read-only child transcript viewer (odradekk/pi-square#304).
 *
 * The viewer is one presentation-only projection of a background child. It
 * reads the child's validated native session artifacts through the same
 * identity checks resume uses, renders a bounded recent transcript with Pi's
 * public message components, and never mutates lifecycle, result ownership,
 * delivery, waiting, aborting, resume eligibility, persisted artifacts, or the
 * main transcript. Every rendered text is a display-safe projection first:
 * user and assistant text pass the shared credential-neutral sanitizer and
 * an explicit budget before any component sees it, and tool calls render
 * through the same roster-grade allowlisted identity/summary seam the
 * roster rows share — never raw arguments, result payloads, call IDs, or
 * internal fields.
 * The basic path here is deliberately static: the model is frozen when the
 * overlay opens; live streaming, older-history paging, and cross-child
 * navigation are later slices of #302.
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
  | { kind: "toolCall"; name: string; summary: string; durationMs?: number; result?: { isError: boolean } }
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

function genericLine(text: string): TranscriptItem {
  const clean = sanitizeSubagentDisplay(text).replace(/\s+/g, " ").trim();
  return { kind: "generic", text: clean.slice(0, MAX_GENERIC_LINE) };
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
 * reaches Pi's components or a generic fallback. Tool calls keep their
 * conversational order and state but project only through the roster-grade
 * allowlisted identity/summary seam the roster rows share: raw arguments, result
 * payloads, and call IDs never enter an item a renderer can show (the call ID
 * exists only to pair a result with its call and is never rendered). Content
 * that is out of scope but conversationally meaningful becomes one non-empty
 * sanitized generic line instead of silently disappearing.
 */
export function projectSessionEntries(
  entries: readonly unknown[],
  windowSize = MAX_TRANSCRIPT_ITEMS,
  observedAt?: number,
): ChildTranscriptProjection {
  const projected: TranscriptItem[] = [];
  const openCalls = new Map<string, {
    item: TranscriptItem & { kind: "toolCall" };
    startedAt?: number;
  }>();

  const timestamp = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown };
    const entryTimestamp = timestamp((entry as { timestamp?: unknown }).timestamp);

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
      if (custom.display === true) {
        const parts = projectTextContent(custom.content);
        if (parts.length === 0) projected.push(genericLine("extension message (no readable text)"));
        else for (const part of parts) {
          projected.push(genericLine(part.kind === "text" ? part.text : "unsupported extension message content"));
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
      if (parts.length === 0) projected.push(genericLine("user message (no readable text)"));
      else for (const part of parts) {
        projected.push(part.kind === "text"
          ? { kind: "user", text: part.text }
          : genericLine("unsupported user message content"));
      }
      continue;
    }

    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      const stopReason = (message as { stopReason?: unknown }).stopReason;
      if (!Array.isArray(content)) {
        projected.push(genericLine("assistant message (no readable content)"));
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
          unsupported.push(genericLine("unsupported assistant content"));
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
          } as TranscriptItem & { kind: "toolCall" };
          calls.push(call);
          const callId = typeof part.id === "string" ? part.id : "";
          if (callId) openCalls.set(callId, { item: call, startedAt });
        } else {
          unsupported.push(genericLine("unsupported assistant content"));
        }
      }
      if (boundedContent.length > 0) {
        const item = { kind: "assistant", message: { role: "assistant", content: boundedContent } } as const;
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
          projected.push(genericLine(stopReason === "error" ? "assistant request failed" : "assistant request aborted"));
        }
      } else if (stopReason === "length" && assistantItems.length > 0) {
        assistantItems.at(-1)!.message.stopReason = "length";
      }
      if (projected.length === projectedBefore) {
        projected.push(genericLine("assistant message (no readable content)"));
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
        // anonymous and the payload never enters.
        const name = typeof result.toolName === "string" ? result.toolName : "";
        projected.push(genericLine(`tool result: ${rosterToolArgsDisplay(name, undefined).tool}`));
      }
      continue;
    }

    // A message role outside the supported vocabulary is conversationally
    // meaningful: it becomes one non-empty generic line, never a silent gap.
    projected.push(genericLine("unsupported message entry"));
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
export function readChildTranscript(id: string, observedAt = Date.now()): ChildTranscript {
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

    return { ok: true, ...projectSessionEntries(parseSessionEntries(tail), MAX_TRANSCRIPT_ITEMS, observedAt) };
  } catch {
    // Filesystem and parser errors may quote a session path, a malformed JSON
    // fragment, or provider-owned identifiers. The overlay exposes only the
    // observable read state; detailed diagnostics remain outside this view.
    return { ok: false, reason: "child history could not be read" };
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
 * one-cell margin. Both the outer overlay options and the component's own
 * body budget re-resolve from the current terminal dimensions, so a resize
 * switches between the two layouts while the overlay stays open.
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

/**
 * Live overlay options for one open overlay. Pi 0.84.2 resolves the
 * `overlayOptions` extension value once, when the overlay is shown, but the
 * TUI re-reads every option property on each render while re-resolving layout
 * from the current terminal size. Property getters keep both facts true at
 * once: the object satisfies the static public `OverlayOptions` contract while
 * its geometry recomputes per render, so crossing the small/normal threshold
 * after opening switches the outer layout too.
 */
export function childOverlayOptions(tui: TUI): OverlayOptions {
  return {
    get width() { return childOverlayPlan(tui.terminal.columns, tui.terminal.rows).overlay.width; },
    get maxHeight() { return childOverlayPlan(tui.terminal.columns, tui.terminal.rows).overlay.maxHeight; },
    get margin() { return childOverlayPlan(tui.terminal.columns, tui.terminal.rows).overlay.margin; },
    anchor: "center",
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
  /** Closed failure/abort status sentence for terminal runs with no transcript. */
  failureReason?: string;
  transcript: ChildTranscript;
}

export interface ChildOverlayInput {
  tui: TUI;
  theme: Theme;
  model: ChildOverlayModel;
  /** Active display runtime; absent only in isolated fallback/test rendering. */
  display?: Pick<DisplayRuntime, "createComponent" | "subscribeMotion">;
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
  private motionUnsubscribe: (() => void) | undefined;
  private cache: { width: number; columns: number; rows: number; lines: string[] } | undefined;

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
      if (input.display && input.model.transcript.items.some((item) => item.kind === "toolCall" && !item.result)) {
        this.motionUnsubscribe = input.display.subscribeMotion(() => {
          this.invalidate();
          this.input.tui.requestRender();
        });
      }
    }
  }

  /** One static sanitized line, clipped to whatever width the renderer offers. */
  private lineComponent(line: string): Component {
    return {
      render: (width) => [truncateToWidth(line, Math.max(1, width), "…")],
      invalidate: () => {},
    };
  }

  private genericTextComponent(text: string): Component {
    return this.lineComponent(this.theme.fg("muted", text));
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
        // The display module owns title, lifecycle marker/fallback, hue,
        // duration, width pressure, and the one-row terminal outcome. This
        // caller contributes only the allowlisted identity and safe summary.
        const catalog = getCatalogEntry(item.name);
        const description: DisplayDescriptionV1 = {
          version: 1,
          tool: item.name,
          family: catalog?.family ?? "agent",
          lifecycle: item.result?.isError ? "failed" : item.result ? "completed" : "running",
          phase: item.result ? "result" : "call",
          title: catalog?.title ?? "Tool",
          ...(item.summary ? { target: item.summary } : {}),
          ...(item.result?.isError
            ? { error: "Tool failed" }
            : item.result
              ? { summary: "Completed" }
              : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
        };
        return [this.input.display?.createComponent(description, this.theme, { expanded: false })
          ?? new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, this.theme, { expanded: false })];
      }
      default:
        return [this.genericTextComponent(item.text)];
    }
  }

  handleInput(data: string): void {
    const classified = classifyViewerInput(data);
    if (classified.kind === "close") {
      this.dispose();
      this.input.onClose();
    } else if (classified.kind === "replay") {
      this.dispose();
      this.input.onReplay(classified.text);
    }
  }

  dispose(): void {
    this.motionUnsubscribe?.();
    this.motionUnsubscribe = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
    for (const component of this.bodyComponents) component.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const terminal = this.input.tui.terminal;
    const plan = childOverlayPlan(terminal.columns, terminal.rows);
    if (
      this.cache
      && this.cache.width === safeWidth
      && this.cache.columns === terminal.columns
      && this.cache.rows === terminal.rows
    ) return this.cache.lines;

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
    this.cache = { width: safeWidth, columns: terminal.columns, rows: terminal.rows, lines };
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

    // Markers count against the body budget, so the overlay never renders
    // more than `budget` body rows regardless of which marker shows.
    const entriesLead = this.omitted > 0
      ? [truncateToWidth(this.theme.fg("dim", `  … +${this.omitted} earlier entries`), width, "…")]
      : [];
    if (entriesLead.length + rendered.length <= budget) return [...entriesLead, ...rendered];
    // Keep the recent tail inside the budget and state the cut once; the
    // line-cut marker replaces the entries marker when both would show.
    const lead = [truncateToWidth(
      this.theme.fg("dim", `  … +${rendered.length - budget + 1} earlier lines`),
      width,
      "…",
    )];
    return [...lead, ...rendered.slice(rendered.length - budget + 1)];
  }
}
