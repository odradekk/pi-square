import {
  AssistantMessageComponent,
  getMarkdownTheme,
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
import {
  CHILD_HISTORY_READ_ERROR,
  type AssistantTextPart,
  type ChildHistorySnapshot,
  type ChildHistoryView,
  type TranscriptItem,
} from "./child-history";
import { MAX_LIVE_ITEMS, type ChildViewEvent } from "./live-events";

/**
 * Read-only child transcript viewer (odradekk/pi-square#304, #305, #306).
 *
 * The viewer is one presentation-only projection of a background child. It
 * reads the child's validated native session artifacts through the same
 * identity checks resume uses, renders a bounded transcript with Pi's public
 * message components, and never mutates lifecycle, result ownership,
 * delivery, waiting, aborting, resume eligibility, persisted artifacts, or the
 * main transcript. Every rendered text is a display-safe projection first:
 * user and assistant text pass the shared credential-neutral sanitizer and an
 * explicit budget before any component sees them, and tool calls render
 * through the same roster-grade allowlisted identity/summary seam the roster
 * rows share — never raw arguments, result payloads, call IDs, or internal
 * fields.
 *
 * Since #305 the body is a demand-paged view of the child's complete
 * persisted history: PageUp walks bounded older pages of the native session
 * file (original delegation and every same-ID resume, in native order) until
 * the earliest entry is reachable, PageDown reloads evicted newer pages, and
 * Home/End jump in bounded steps. The loaded window, every read, and every
 * rendered line stay explicitly bounded, positions are anchored by stable
 * native entry identity rather than array offsets, and page failures render
 * one bounded retryable error while previously validated pages stay visible.
 *
 * Since #306 the overlay is live while the child runs: the roster controller
 * forwards the child's ephemeral view events (`applyLiveEvent`) so streaming
 * assistant text and thinking render as a bounded tail below the persisted
 * window, completed messages reconcile against the session file as Pi appends
 * them (a live entry drops only when its exact persisted counterpart is
 * loaded, so nothing is duplicated, reordered, or lost), and lifecycle
 * transitions update the open view (`updateLifecycle`). The overlay owns no
 * timer and never repaints on its own for live events — the controller owns
 * the one coalesced repaint timer. Cross-child navigation and per-child
 * reading state remain later slices of #302, and the overlay remains a plugin
 * projection — not Pi's private native transcript pipeline.
 */

/** Overlay rows that are chrome: title, two rules, and the help row. */
const OVERLAY_CHROME_ROWS = 4;
/** Terminal size under which the overlay degrades to a one-cell-margin panel. */
const SMALL_TERMINAL_COLUMNS = 60;
const SMALL_TERMINAL_ROWS = 16;
/** Bounded page loads one Home/End press may chain toward a file edge. */
const EDGE_LOAD_PAGES_PER_PRESS = 8;

export type { ChildHistoryView, ChildHistorySnapshot, TranscriptItem } from "./child-history";
export { createChildHistory, projectSessionEntries, staticChildHistory } from "./child-history";

export type ChildLifecycle = "queued" | "running" | "cancelling" | "completed" | "failed" | "aborted";

export type ViewerInput =
  | { kind: "close" }
  | { kind: "replay"; text: string }
  | { kind: "scroll"; delta: -1 | 1 }
  | { kind: "jump"; to: "start" | "end" }
  | { kind: "ignore" };

/**
 * Classifies one raw terminal input event for the capturing overlay. Escape
 * closes; complete printable, paste, and composed-IME content replays into
 * the main editor; Backspace and Delete against the empty editor stay no-ops;
 * PageUp/PageDown/Home/End scroll the bounded transcript; and every other key
 * (arrows, Enter, shortcuts, modified keys) is suppressed so no Pi
 * application shortcut fires through the overlay.
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
  if (matchesKey(data, "pageUp")) return { kind: "scroll", delta: -1 };
  if (matchesKey(data, "pageDown")) return { kind: "scroll", delta: 1 };
  if (matchesKey(data, "home")) return { kind: "jump", to: "start" };
  if (matchesKey(data, "end")) return { kind: "jump", to: "end" };
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
  /** Bounded demand-paged history over the child's native session file. */
  history: ChildHistoryView;
}

export interface ChildOverlayInput {
  tui: TUI;
  theme: Theme;
  model: ChildOverlayModel;
  /** Clock for live tool-row durations; defaults to the wall clock. */
  now?: () => number;
  /** Active display runtime; absent only in isolated fallback/test rendering. */
  display?: Pick<DisplayRuntime, "createComponent" | "subscribeMotion">;
  /** Escape path: close, clear selection, and return focus to main. */
  onClose(): void;
  /** Replay path: close, then place the complete text in the empty editor. */
  onReplay(text: string): void;
}

function emptyStateLine(
  model: ChildOverlayModel,
  snapshot: ChildHistorySnapshot,
  hasLive = false,
): { text: string; tone: ThemeColor } {
  // A queued child has no session file yet — that is the expected waiting
  // state, not a read failure, so it outranks the initial error.
  if (model.status === "queued") return { text: "Waiting to start", tone: "muted" };
  if (snapshot.initialError !== undefined) {
    return { text: `Transcript unavailable: ${snapshot.initialError}`, tone: "error" };
  }
  if (hasLive || snapshot.items.length > 0 || snapshot.olderError !== undefined || snapshot.newerError !== undefined) {
    return { text: "", tone: "muted" };
  }
  switch (model.status) {
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
/** One item's stable identity: native entry id plus ordinal within the entry. */
function itemKey(item: TranscriptItem, index: number, occurrences: Map<string, number>): string {
  const base = item.entryId !== undefined && item.entryId !== "" ? item.entryId : `@${index}`;
  const fallback = occurrences.get(base) ?? 0;
  const occurrence = item.entryItemIndex ?? fallback;
  occurrences.set(base, Math.max(fallback, occurrence + 1));
  return `${base}#${occurrence}`;
}

interface LineModel {
  lines: string[];
  /** Scroll-space line index where each item's rendered block starts. */
  starts: number[];
  /** Stable per-item keys, parallel to the snapshot items. */
  keys: string[];
}

/** One live tool call rendered as an operational row until history covers it. */
interface LiveToolState {
  toolCallId: string;
  name: string;
  summary: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  /** Same-name persisted toolCall rows when the live row was created. */
  baselineRows: number;
  /** Same-name resolved persisted toolCall rows when the live row was created. */
  baselineResolved: number;
}

/** One entry of the ordered live tail; arrival order mirrors the native stream. */
type LiveItem =
  | {
    kind: "message";
    content: AssistantTextPart[];
    /**
     * Identities of the persisted assistant items with exactly equal content
     * at the moment this completion arrived. Reconciliation confirms only
     * against equal-content occurrences that appear beyond this set, so a
     * pre-existing identical message can never consume a new completion whose
     * own native entry has not appended yet.
     */
    known: ReadonlySet<string>;
  }
  | { kind: "tool"; tool: LiveToolState };

/** Stable identity of one persisted transcript item inside the loaded window. */
function persistedItemIdentity(item: TranscriptItem, index: number): string {
  return item.entryId !== undefined && item.entryId !== ""
    ? `${item.entryId}#${item.entryItemIndex ?? 0}`
    : `@${index}`;
}

/** Live tail state (#306): bounded ephemeral projection below the persisted window. */
interface LiveTail {
  /** Ordered live entries (message completions and tool rows), bounded. */
  items: LiveItem[];
  /** Cumulative ordered streaming partial of the in-flight assistant message. */
  streaming: AssistantTextPart[] | undefined;
  /** Bounded diagnostic for a contained live-subscriber failure. */
  diagnostic: string | undefined;
  /** Explicit omission state after a bounded drop; cleared by recovery reads. */
  omitted: boolean;
}

function emptyLiveTail(): LiveTail {
  return { items: [], streaming: undefined, diagnostic: undefined, omitted: false };
}

function contentKey(content: unknown): string {
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}

/**
 * The capturing overlay component: one title row, one bounded scrollable
 * transcript body, and one help row between quiet rules. Item components and
 * the flattened scroll space are cached by width and history version; the
 * final viewport is cached additionally by terminal size and scroll position,
 * so a running tool still refreshes its duration at the motion interval while
 * scrolling re-slices cached lines. Live events drop the caches through
 * `applyLiveEvent`; the roster controller owns when a frame actually repaints.
 */
export class ChildTranscriptOverlay implements Component {
  private readonly input: ChildOverlayInput;
  private readonly theme: Theme;
  private readonly markdown = getMarkdownTheme();
  private state: { text: string; tone: ThemeColor };
  private current: ChildHistorySnapshot;
  private version = 0;
  private scrollTop = Number.POSITIVE_INFINITY;
  private lastWidth: number | undefined;
  private lineModel: { width: number; version: number; model: LineModel } | undefined;
  private live = emptyLiveTail();
  private cache: {
    width: number;
    columns: number;
    rows: number;
    scrollTop: number;
    version: number;
    lines: string[];
  } | undefined;
  private motionUnsubscribe: (() => void) | undefined;

  constructor(input: ChildOverlayInput) {
    this.input = input;
    this.theme = input.theme;
    this.current = input.model.history.snapshot();
    this.state = emptyStateLine(input.model, this.current);
    this.syncMotionSubscription();
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

  /**
  /** One item's rendered lines, falling back to the sanitized generic row. */
  private renderedItemLines(item: TranscriptItem, contentWidth: number): string[] {
    try {
      return this.componentsFor(item).flatMap((component) => component.render(contentWidth));
    } catch {
      // A single entry that Pi's components cannot build renders through
      // the sanitized generic fallback; the view never throws.
      return this.componentsFor({ kind: "generic", text: this.describeItem(item) })[0]!
        .render(contentWidth);
    }
  }

  /**
   * Builds the flattened scroll space for one width: an optional older-history
   * edge (or the bounded retryable page error), every loaded item's rendered
   * lines, an optional newer-history edge, and the bounded live tail (#306) —
   * the ordered live entries (completed-but-unconfirmed messages and live
   * tool rows, in native stream order), the streaming partial, and the
   * trailing diagnostic and omission states, always below the persisted
   * window.
   * Markers and items share the same scroll space so the body budget always
   * bounds the viewport exactly.
   */
  private buildLineModel(width: number): LineModel {
    const snapshot = this.current;
    const indent = "  ";
    const contentWidth = Math.max(1, width - visibleWidth(indent));
    const lines: string[] = [];
    const starts: number[] = [];
    const keys: string[] = [];

    if (snapshot.olderError !== undefined || snapshot.moreBefore) {
      lines.push(snapshot.olderError !== undefined
        ? this.theme.fg("error", `${indent}older ${CHILD_HISTORY_READ_ERROR} — page up retries`)
        : this.theme.fg("dim", `${indent}… earlier history (page up)`));
    }

    const occurrences = new Map<string, number>();
    for (const [index, item] of snapshot.items.entries()) {
      const rendered = this.renderedItemLines(item, contentWidth);
      starts.push(lines.length);
      keys.push(itemKey(item, index, occurrences));
      lines.push(...rendered.map((line) => indent + line));
    }

    if (snapshot.newerError !== undefined || snapshot.moreAfter) {
      lines.push(snapshot.newerError !== undefined
        ? this.theme.fg("error", `${indent}newer ${CHILD_HISTORY_READ_ERROR} — page down retries`)
        : this.theme.fg("dim", `${indent}… newer history (page down)`));
    }

    const liveItems: TranscriptItem[] = [];
    for (const entry of this.live.items) {
      if (entry.kind === "message") {
        liveItems.push({ kind: "assistant", message: { role: "assistant", content: entry.content } });
      } else {
        const tool = entry.tool;
        liveItems.push({
          kind: "toolCall",
          name: tool.name,
          summary: tool.summary,
          ...(tool.startedAt !== undefined
            ? { durationMs: Math.max(0, (tool.endedAt ?? this.now()) - tool.startedAt) }
            : {}),
          ...(tool.endedAt !== undefined ? { result: { isError: tool.isError === true } } : {}),
        });
      }
    }
    if (this.live.streaming !== undefined && this.live.streaming.length > 0) {
      liveItems.push({ kind: "assistant", message: { role: "assistant", content: this.live.streaming } });
    }
    // Status rows close the tail so a tail-following view always shows them.
    if (this.live.diagnostic !== undefined) {
      liveItems.push({ kind: "generic", text: this.live.diagnostic });
    }
    if (this.live.omitted) {
      liveItems.push({ kind: "generic", text: "… older live updates were dropped; persisted history recovers them" });
    }
    for (const [index, item] of liveItems.entries()) {
      const rendered = this.renderedItemLines(item, contentWidth);
      starts.push(lines.length);
      keys.push(`live#${index}`);
      lines.push(...rendered.map((line) => indent + line));
    }
    return { lines, starts, keys };
  }

  private lineModelFor(width: number): LineModel {
    if (this.lineModel !== undefined && this.lineModel.width === width && this.lineModel.version === this.version) {
      return this.lineModel.model;
    }
    const model = this.buildLineModel(width);
    this.lineModel = { width, version: this.version, model };
    return model;
  }

  private bodyBudget(): number {
    const terminal = this.input.tui.terminal;
    return childOverlayPlan(Math.max(1, terminal.columns), Math.max(1, terminal.rows)).bodyRows;
  }

  /**
   * Resolves the viewport for the current scroll space and budget. The
   * leading indicator consumes one row only while content lies above, so the
   * bottom-most line stays visible at the bottom and the whole body fits
   * `budget` rows exactly.
   */
  private resolveViewport(model: LineModel, budget: number): {
    scrollTop: number;
    maxScroll: number;
    head: boolean;
    tail: boolean;
    count: number;
  } {
    const head = this.scrollTop > 0 || !Number.isFinite(this.scrollTop);
    const avail = Math.max(1, budget - (head ? 1 : 0));
    const maxScroll = Math.max(0, model.lines.length - avail);
    const scrollTop = Number.isFinite(this.scrollTop)
      ? Math.min(Math.max(0, this.scrollTop), maxScroll)
      : maxScroll;
    const effectiveHead = head && scrollTop > 0;
    const tail = scrollTop + avail < model.lines.length;
    return {
      scrollTop,
      maxScroll,
      head: effectiveHead,
      tail,
      count: Math.max(0, avail - (tail ? 1 : 0)),
    };
  }

  private refreshHistory(): void {
    this.current = this.input.model.history.snapshot();
    this.syncState();
    this.version += 1;
    this.lineModel = undefined;
    this.cache = undefined;
    this.syncMotionSubscription();
  }

  private syncState(): void {
    this.state = emptyStateLine(this.input.model, this.current, this.hasLiveContent());
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private hasLiveContent(): boolean {
    if (this.live.items.length > 0 || this.live.diagnostic !== undefined || this.live.omitted) return true;
    const streaming = this.live.streaming;
    return streaming !== undefined && streaming.length > 0;
  }

  /** Whether the viewport currently sits at the bottom of the scroll space. */
  private isAtTail(): boolean {
    if (!Number.isFinite(this.scrollTop) || this.lastWidth === undefined) return true;
    try {
      const model = this.lineModelFor(this.lastWidth);
      return this.scrollTop >= this.resolveViewport(model, this.bodyBudget()).maxScroll;
    } catch {
      return true;
    }
  }

  /** Persisted toolCall rows for one tool name: total and resolved counts. */
  private persistedToolCounts(name: string): { rows: number; resolved: number } {
    let rows = 0;
    let resolved = 0;
    for (const item of this.current.items) {
      if (item.kind !== "toolCall" || item.name !== name) continue;
      rows += 1;
      if (item.result !== undefined) resolved += 1;
    }
    return { rows, resolved };
  }

  /**
   * Confirms pending message completions against equal-content persisted
   * occurrences that appeared after each completion arrived. Confirmation is
   * per occurrence identity and oldest-first within a content key: a
   * pre-existing identical message (recorded in the entry's known set at
   * arrival) can never consume a newer completion, and repeated identical
   * completions each consume their own appended occurrence.
   */
  private confirmLiveMessages(): void {
    if (this.live.items.length === 0) return;
    const equalContent = new Map<string, string[]>();
    this.current.items.forEach((item, index) => {
      if (item.kind !== "assistant") return;
      const key = contentKey(item.message.content);
      const bucket = equalContent.get(key) ?? [];
      bucket.push(persistedItemIdentity(item, index));
      equalContent.set(key, bucket);
    });
    const drop = new Set<LiveItem>();
    for (const [key, identities] of equalContent) {
      const consumed = new Set<string>();
      for (const item of this.live.items) {
        if (item.kind !== "message" || drop.has(item)) continue;
        if (contentKey(item.content) !== key) continue;
        const fresh = identities.find((identity) => !item.known.has(identity) && !consumed.has(identity));
        if (fresh === undefined) continue;
        consumed.add(fresh);
        drop.add(item);
      }
    }
    if (drop.size === 0) return;
    this.live.items = this.live.items.filter((item) => !drop.has(item));
  }

  /**
   * Drops live tool rows their own persisted occurrences now cover. A running
   * row drops when its own call row appears beyond its baseline; a finished
   * row waits for a resolved one so the visible terminal state never
   * regresses to running.
   */
  private dropCoveredTools(): void {
    if (this.live.items.length === 0) return;
    this.live.items = this.live.items.filter((item) => {
      if (item.kind !== "tool") return true;
      const counts = this.persistedToolCounts(item.tool.name);
      return item.tool.endedAt !== undefined
        ? counts.resolved <= item.tool.baselineResolved
        : counts.rows <= item.tool.baselineRows;
    });
  }

  /**
   * Reconciles the persisted window with the session file: retries the initial
   * tail while it has never loaded, otherwise reads bounded newer pages the
   * child appended. A view that was at the tail stays pinned to it; a scrolled
   * position is preserved — live growth never pulls an older position away.
   * Loading new persisted content is also the recovery path that clears the
   * bounded omission state.
   */
  reconcileNow(pages = 1): void {
    const follow = this.isAtTail();
    let changed = false;
    if (this.current.initialError !== undefined) {
      changed = this.input.model.history.retryInitial();
    } else {
      for (let page = 0; page < Math.max(1, pages); page += 1) {
        if (!this.input.model.history.loadNewer()) break;
        changed = true;
      }
    }
    if (changed) {
      this.current = this.input.model.history.snapshot();
      if (this.live.omitted) this.live.omitted = false;
      this.confirmLiveMessages();
      this.dropCoveredTools();
    }
    if (follow) this.scrollTop = Number.POSITIVE_INFINITY;
    this.refreshHistory();
  }

  /** Appends one live entry, dropping the oldest with a visible marker at the bound. */
  private pushLiveItem(item: LiveItem): void {
    this.live.items.push(item);
    while (this.live.items.length > MAX_LIVE_ITEMS) {
      this.live.items.shift();
      // The newest entry never drops: overflow sheds the oldest, and the
      // explicit omission state says what was shed until history recovers it.
      this.live.omitted = true;
    }
  }

  /**
   * Applies one live child view event (#306). Streaming deltas update the
   * bounded ordered partial without touching the session file; structural
   * events reconcile the persisted window, confirming completed live entries
   * and shedding live tool rows that history now covers.
   */
  applyLiveEvent(event: ChildViewEvent): void {
    this.live.diagnostic = undefined;
    switch (event.kind) {
      case "message_delta":
        this.live.streaming = event.parts;
        this.syncState();
        this.invalidate();
        return;
      case "tool_updated":
        return;
      case "message_completed": {
        this.live.streaming = undefined;
        if (event.content.length > 0) {
          const key = contentKey(event.content);
          // Record every equal-content persisted item already visible: only
          // occurrences beyond this set can confirm this completion, so a
          // pre-existing identical message never consumes it.
          const known = new Set<string>();
          this.current.items.forEach((item, index) => {
            if (item.kind === "assistant" && contentKey(item.message.content) === key) {
              known.add(persistedItemIdentity(item, index));
            }
          });
          this.pushLiveItem({ kind: "message", content: event.content, known });
        }
        break;
      }
      case "tool_started": {
        // Baselines are captured before the reconcile so the call's own
        // assistant entry — appended right after its message_end — cannot
        // count as pre-existing. When the reconcile loads it, the persisted
        // running row already shows the call and no live row is added.
        const before = this.persistedToolCounts(event.name);
        this.reconcileNow(1);
        const after = this.persistedToolCounts(event.name);
        if (after.rows > before.rows) return;
        this.pushLiveItem({
          kind: "tool",
          tool: {
            toolCallId: event.toolCallId,
            name: event.name,
            summary: event.summary,
            startedAt: event.startedAt,
            baselineRows: before.rows,
            baselineResolved: before.resolved,
          },
        });
        this.refreshLiveShape();
        return;
      }
      case "tool_finished": {
        // The end state must show without waiting for the toolResult append:
        // a live row that survived the reconcile flips immediately; otherwise
        // a fresh finished row appears whenever the persisted projection has
        // not updated yet.
        const pre = this.persistedToolCounts(event.name);
        const existing = this.live.items.find(
          (item): item is Extract<LiveItem, { kind: "tool" }> => item.kind === "tool" && item.tool.toolCallId === event.toolCallId,
        );
        this.reconcileNow(1);
        const post = this.persistedToolCounts(event.name);
        const stillLive = existing !== undefined && this.live.items.includes(existing);
        if (stillLive) {
          existing.tool.endedAt = this.now();
          existing.tool.isError = event.isError;
        } else if (post.resolved > pre.resolved) {
          this.refreshLiveShape();
          return; // the persisted row already carries the terminal state
        } else {
          this.pushLiveItem({
            kind: "tool",
            tool: {
              toolCallId: event.toolCallId,
              name: event.name,
              summary: "called",
              endedAt: this.now(),
              isError: event.isError,
              baselineRows: pre.rows,
              baselineResolved: post.resolved,
            },
          });
        }
        this.refreshLiveShape();
        return;
      }
      case "live_events_dropped":
        this.live.omitted = true;
        this.syncState();
        this.invalidate();
        return;
      case "run_started":
      case "tool_result_completed":
        break;
      case "run_finished":
        // The streaming partial survives an aborted stream: a run that never
        // delivered its message completion keeps its last observed partial
        // visible rather than dropping it (no lost final content).
        this.reconcileNow(8);
        this.refreshLiveShape();
        return;
    }
    this.reconcileNow(1);
  }

  /** Recomputes state and caches after a direct live-items mutation. */
  private refreshLiveShape(): void {
    this.syncState();
    this.invalidate();
  }

  /** Updates the open view after a lifecycle transition of the child. */
  updateLifecycle(patch: {
    status: ChildLifecycle;
    lifecycleLabel: string;
    lifecycleTone: ThemeColor;
    durationText: string;
    failureReason?: string;
  }): void {
    const model = this.input.model;
    model.status = patch.status;
    model.lifecycleLabel = patch.lifecycleLabel;
    model.lifecycleTone = patch.lifecycleTone;
    model.durationText = patch.durationText;
    if (patch.failureReason !== undefined) model.failureReason = patch.failureReason;
    else delete model.failureReason;
    this.syncState();
    this.invalidate();
  }

  /**
   * Records one contained live failure as a bounded diagnostic row; the
   * persisted history stays visible and the next successful event clears it.
   */
  setLiveDiagnostic(text = "live updates paused after a viewer error"): void {
    this.live.diagnostic = text;
    this.syncState();
    this.invalidate();
  }

  /** Subscribes to motion only while a running tool row is visible. */
  private syncMotionSubscription(): void {
    const liveToolRunning = this.live.items.some((item) => item.kind === "tool" && item.tool.endedAt === undefined);
    const wantsMotion = liveToolRunning
      || this.current.items.some((item) => item.kind === "toolCall" && !item.result);
    if (wantsMotion && this.input.display && this.motionUnsubscribe === undefined) {
      this.motionUnsubscribe = this.input.display.subscribeMotion(() => {
        this.invalidate();
        this.input.tui.requestRender();
      });
    } else if (!wantsMotion && this.motionUnsubscribe !== undefined) {
      this.motionUnsubscribe();
      this.motionUnsubscribe = undefined;
    }
  }

  private scroll(delta: -1 | 1): void {
    if (this.current.initialError !== undefined) {
      this.input.model.history.retryInitial();
      this.refreshHistory();
      this.scrollTop = Number.POSITIVE_INFINITY;
      return;
    }
    // A state-line body (queued, starting, or an all-unterminated tail) can
    // still hold reachable older history, so paging stays available; empty
    // geometry makes the movement a harmless clamp.
    if (this.lastWidth === undefined) return;
    const width = this.lastWidth;
    const model = this.lineModelFor(width);
    const budget = this.bodyBudget();
    const view = this.resolveViewport(model, budget);
    this.scrollTop = view.scrollTop;

    if (delta < 0) {
      if (this.scrollTop > 0) {
        this.scrollTop = Math.max(0, this.scrollTop - budget);
        return;
      }
      // At the loaded top: request one bounded older page and reveal it, so
      // repeated presses walk the complete history until the earliest entry.
      this.pageOlder(model, budget);
    } else {
      if (this.scrollTop < view.maxScroll) {
        this.scrollTop = Math.min(view.maxScroll, this.scrollTop + budget);
        return;
      }
      // At the loaded bottom: attempt one bounded newer page (evicted pages,
      // or a concurrent append completing the tail) and follow to the edge.
      this.pageNewer();
    }
  }

  private pageOlder(model: LineModel, budget: number): void {
    const seamKey = model.keys[0];
    const loaded = this.input.model.history.loadOlder();
    this.refreshHistory();
    if (!loaded || seamKey === undefined) return;
    const next = this.lineModelFor(this.lastWidth ?? 64);
    const seamIndex = next.keys.indexOf(seamKey);
    if (seamIndex < 0) return;
    // Reveal the newly loaded older page: the previously top item closes the
    // viewport at its bottom edge, so nothing visible jumps or is skipped.
    // The one-step adjustment absorbs the indicator rows the viewport trades
    // for content.
    let target = Math.max(0, next.starts[seamIndex]! - budget + 2);
    this.scrollTop = target;
    const view = this.resolveViewport(next, budget);
    const lastVisible = view.scrollTop + view.count - 1;
    const seamLine = next.starts[seamIndex]!;
    if (lastVisible < seamLine) target = view.scrollTop + (seamLine - lastVisible);
    this.scrollTop = target;
  }

  private pageNewer(): void {
    const loaded = this.input.model.history.loadNewer();
    this.refreshHistory();
    if (!loaded) return;
    // Follow to the newest edge.
    this.scrollTop = Number.POSITIVE_INFINITY;
  }

  private jump(to: "start" | "end"): void {
    if (this.current.initialError !== undefined) {
      this.input.model.history.retryInitial();
      this.refreshHistory();
      this.scrollTop = Number.POSITIVE_INFINITY;
      return;
    }
    if (this.lastWidth === undefined) return;
    if (to === "start") {
      for (let page = 0; page < EDGE_LOAD_PAGES_PER_PRESS; page += 1) {
        if (!this.current.moreBefore) break;
        if (!this.input.model.history.loadOlder()) break;
        this.refreshHistory();
      }
      this.scrollTop = 0;
      return;
    }
    // End follows the newest edge; the first attempt always runs because the
    // snapshot's newer-edge flag only updates on a read.
    for (let page = 0; page < EDGE_LOAD_PAGES_PER_PRESS; page += 1) {
      if (!this.input.model.history.loadNewer()) break;
      this.refreshHistory();
      this.scrollTop = Number.POSITIVE_INFINITY;
    }
  }

  handleInput(data: string): void {
    const classified = classifyViewerInput(data);
    switch (classified.kind) {
      case "close":
        this.dispose();
        this.input.onClose();
        return;
      case "replay":
        this.dispose();
        this.input.onReplay(classified.text);
        return;
      case "scroll":
        this.scroll(classified.delta);
        return;
      case "jump":
        this.jump(classified.to);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.motionUnsubscribe?.();
    this.motionUnsubscribe = undefined;
    this.live = emptyLiveTail();
  }

  invalidate(): void {
    this.cache = undefined;
    this.lineModel = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const terminal = this.input.tui.terminal;
    const plan = childOverlayPlan(terminal.columns, terminal.rows);
    this.lastWidth = safeWidth;
    if (
      this.cache
      && this.cache.width === safeWidth
      && this.cache.columns === terminal.columns
      && this.cache.rows === terminal.rows
      && Number.isFinite(this.scrollTop) && this.cache.scrollTop === this.scrollTop
      && this.cache.version === this.version
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
      this.theme.fg("muted", "esc close · pgup/pgdn/home/end scroll · type or paste to return to the main editor"),
      safeWidth,
      "…",
    );

    const body = this.renderBody(safeWidth, plan.bodyRows);
    const lines = [title, rule, ...body, rule, help];
    this.cache = {
      width: safeWidth,
      columns: terminal.columns,
      rows: terminal.rows,
      scrollTop: Number.isFinite(this.scrollTop) ? this.scrollTop : Number.POSITIVE_INFINITY,
      version: this.version,
      lines,
    };
    return lines;
  }

  private renderBody(width: number, budget: number): string[] {
    if (this.state.text !== "") {
      return [truncateToWidth(this.theme.fg(this.state.tone, `  ${this.state.text}`), width, "…")];
    }

    const model = this.lineModelFor(width);
    const view = this.resolveViewport(model, budget);
    this.scrollTop = view.scrollTop;

    const viewport: string[] = [];
    if (view.head) {
      viewport.push(truncateToWidth(
        this.theme.fg("dim", `  … +${view.scrollTop} earlier lines`),
        width,
        "…",
      ));
    }
    viewport.push(...model.lines.slice(view.scrollTop, view.scrollTop + view.count));
    if (view.tail) {
      viewport.push(truncateToWidth(
        this.theme.fg("dim", `  … +${model.lines.length - (view.scrollTop + view.count)} later lines`),
        width,
        "…",
      ));
    }
    return viewport;
  }
}
