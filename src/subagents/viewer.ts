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
  assistantContentKey,
  callKeyOf,
  type AssistantTextPart,
  type ChildHistorySnapshot,
  type ChildHistoryView,
  type TranscriptItem,
} from "./child-history";
import {
  MAX_LIVE_ITEMS,
  type ChildViewEvent,
  type DroppedEventFingerprint,
} from "./live-events";

/**
 * Read-only child transcript viewer (odradekk/pi-square#304, #305, #306, #307).
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
 * window, live tool rows show running and immediately terminal states, and
 * lifecycle transitions update the open view (`updateLifecycle`). A completed
 * message is confirmed only by the persisted occurrence carrying the same
 * content projection and native timestamp whose JSONL line begins exactly at
 * the file-size floor captured immediately before Pi appends that message.
 * Pi persists each message-end before emitting the next one, so these floors
 * advance without a lifetime occurrence ledger: delayed delivery, terminal
 * reconciles that load the final entry first, pre-existing identical history,
 * repeated identical completions, and demand paging can neither duplicate nor
 * strand live content. Overflow of the bounded tail or the feed sheds oldest-
 * first with fingerprints the omission state keeps visible until persisted
 * history actually recovers them. The overlay owns no
 * timer and never repaints on its own for live events — the controller owns
 * the one coalesced repaint timer.
 *
 * Since #307 the overlay also carries the cross-child reading experience:
 * Up/Down move a roster candidate, Enter re-points this same overlay at the
 * candidate child without stacking or returning to main, and Escape cancels a
 * changed candidate before it ever closes the overlay. Transcript scrolling
 * (PageUp/PageDown/Home/End and the mouse wheel) stays separate from roster
 * navigation. Tail-following is an explicit per-child flag no render
 * overwrites with a finite offset: the first open follows sustained live and
 * persisted growth, an upward scroll suspends following with the position
 * anchored on its stable transcript entry (width changes re-wrap without
 * jumping to another entry), unseen growth below sets a visible new-output
 * state that only End clears, and Pi's effective expand-tools shortcut
 * toggles only this overlay's tool rows — a collapsed row stays one line
 * while an expanded row reveals its bounded sanitized result projection.
 * Scroll, follow, notice, and tool-expansion state are per-child controller
 * state restored across direct switches. The overlay remains a plugin
 * projection — not Pi's private native transcript pipeline.
 */

/** Lines one mouse-wheel notch scrolls; terminals commonly report three per notch. */
const WHEEL_SCROLL_LINES = 3;

/** Overlay rows that are chrome: title, two rules, and the help row. */
const OVERLAY_CHROME_ROWS = 4;
/** Terminal size under which the overlay degrades to a one-cell-margin panel. */
const SMALL_TERMINAL_COLUMNS = 60;
const SMALL_TERMINAL_ROWS = 16;
/** Bounded page loads one Home/End press may chain toward a file edge. */
const EDGE_LOAD_PAGES_PER_PRESS = 8;

/**
 * SGR/X10 mouse-wheel sequences, the same shapes pi-tui's alt-screen viewport
 * parses. In fullscreen TUI mode the alt screen defers wheel events to the
 * focused overlay; inline regular mode enables no mouse tracking, so the
 * wheel keeps scrolling the native scrollback there.
 */
const SGR_MOUSE_WHEEL = /^\x1b\[<(64|65);\d+;\d+[Mm]$/;

function wheelDelta(data: string): -1 | 1 | undefined {
  const sgr = SGR_MOUSE_WHEEL.exec(data);
  if (sgr) return sgr[1] === "64" ? -1 : 1;
  if (data.length === 6 && data.startsWith("\x1b[M")) {
    const button = data.charCodeAt(3) - 32;
    if (button === 64) return -1;
    if (button === 65) return 1;
  }
  return undefined;
}

export type { ChildHistoryView, ChildHistorySnapshot, TranscriptItem } from "./child-history";
export { createChildHistory, projectSessionEntries, staticChildHistory } from "./child-history";

export type ChildLifecycle = "queued" | "running" | "cancelling" | "completed" | "failed" | "aborted";

export type ViewerInput =
  | { kind: "close" }
  | { kind: "replay"; text: string }
  | { kind: "scroll"; delta: -1 | 1 }
  | { kind: "wheel"; delta: -1 | 1 }
  | { kind: "jump"; to: "start" | "end" }
  | { kind: "candidate"; delta: -1 | 1 }
  | { kind: "confirm" }
  | { kind: "expand" }
  | { kind: "ignore" };

/** The slice of Pi's keybinding manager the overlay consumes. */
export interface ViewerKeybindings {
  matches(data: string, keybinding: string): boolean;
  /** Effective key labels for help text, when the manager exposes them. */
  getKeys?(keybinding: string): string[];
}

/**
 * Classifies one raw terminal input event for the capturing overlay. Escape
 * closes; complete printable, paste, and composed-IME content replays into
 * the main editor; Backspace and Delete against the empty editor stay no-ops;
 * PageUp/PageDown/Home/End and the mouse wheel scroll the bounded transcript;
 * Up/Down move the roster candidate and Enter confirms it; Pi's effective
 * expand-tools shortcut toggles this overlay's tool rows; and every other key
 * (left/right, shortcuts, modified keys) is suppressed so no Pi application
 * shortcut fires through the overlay.
 */
export function classifyViewerInput(data: string, keybindings?: ViewerKeybindings): ViewerInput {
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
  if (matchesKey(data, "up")) return { kind: "candidate", delta: -1 };
  if (matchesKey(data, "down")) return { kind: "candidate", delta: 1 };
  if (matchesKey(data, "enter")) return { kind: "confirm" };
  if (keybindings !== undefined && keybindings.matches(data, "app.tools.expand")) return { kind: "expand" };
  if (matchesKey(data, "left") || matchesKey(data, "right")) return { kind: "ignore" };
  const wheel = wheelDelta(data);
  if (wheel !== undefined) return { kind: "wheel", delta: wheel };
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
  /** Complete public child ID; identity for per-child reading state. */
  id: string;
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

export interface ChildOverlayCandidate {
  /** Complete public ID of the tentative roster candidate. */
  id: string;
  role: string;
  /** Collision-safe public-ID prefix computed for the current roster. */
  idLabel: string;
}

/**
 * One child's retained reading state (#307). `following` is the explicit
 * tail-follow flag, decoupled from the numeric visual-line offset: the offset
 * alone cannot represent "keep following new content" once a render resolves
 * the tail to a finite position, and growth must not silently strand a
 * following view at a stale offset.
 */
export interface ChildReadingState {
  /** Visual-line offset; `Number.POSITIVE_INFINITY` while following the tail. */
  scrollTop: number;
  following: boolean;
  toolsExpanded: boolean;
  /** Unseen output below a suspended viewport; restored across switches. */
  newOutput: boolean;
}

export interface ChildOverlayInput {
  tui: TUI;
  theme: Theme;
  model: ChildOverlayModel;
  /** Clock for live tool-row durations; defaults to the wall clock. */
  now?: () => number;
  /** Active display runtime; absent only in isolated fallback/test rendering. */
  display?: Pick<DisplayRuntime, "createComponent" | "subscribeMotion">;
  /**
   * Pi's effective keybindings from the custom-overlay factory; supplies the
   * expand-tools shortcut (#307). Absent in isolated component tests.
   */
  keybindings?: ViewerKeybindings;
  /** Escape path: close, clear selection, and return focus to main. */
  onClose(): void;
  /** Replay path: close, then place the complete text in the empty editor. */
  onReplay(text: string): void;
  /** Roster navigation (#307): move the tentative candidate one row. */
  onNavigate?(delta: -1 | 1): void;
  /** Enter with a tentative candidate (#307): re-point this overlay at it. */
  onConfirm?(): void;
  /** Escape with a changed candidate (#307): cancel it and keep this overlay. */
  onCancelCandidate?(): void;
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
  /** Non-reversible identity shared with the persisted tool row. */
  callKey: string;
  name: string;
  summary: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
}

/** One entry of the ordered live tail; arrival order mirrors the native stream. */
type LiveItem =
  | {
    kind: "message";
    content: AssistantTextPart[];
    /**
     * Native message timestamp recorded when the completion was published —
     * the identical value its persisted entry carries. Together with the
     * pre-append history floor this identifies the completion's own persisted
     * occurrence no matter when delivery or appends land.
     */
    timestamp?: number;
    /** Native JSONL size captured immediately before Pi persisted this message. */
    historyFloor?: number;
  }
  | { kind: "tool"; tool: LiveToolState };

/** Hard bound on tracked drop fingerprints before the marker stops clearing. */
const MAX_DROPPED_FINGERPRINTS = 64;

/**
 * Anchor for width-change remapping (#307): the stable item key containing a
 * visual-line offset plus the offset within that item's rendered block.
 */
function anchorForScroll(model: LineModel, scrollTop: number): { key: string; offset: number } | undefined {
  if (model.keys.length === 0) return undefined;
  let index = model.starts.findIndex((start) => start > scrollTop) - 1;
  if (index < 0) index = 0; // the offset sits in the leading edge indicator: anchor the first item
  return { key: model.keys[index]!, offset: Math.max(0, scrollTop - model.starts[index]!) };
}

/** Resolves an anchor inside a rebuilt model; undefined when its item left the window. */
function scrollForAnchor(model: LineModel, anchor: { key: string; offset: number }): number | undefined {
  const index = model.keys.indexOf(anchor.key);
  if (index < 0) return undefined;
  const start = model.starts[index]!;
  const end = index + 1 < model.starts.length ? model.starts[index + 1]! : model.lines.length;
  return start + Math.min(anchor.offset, Math.max(0, end - start - 1));
}

/** Stable identity of one persisted transcript item inside the loaded window. */
function persistedItemIdentity(item: TranscriptItem, index: number): string {
  return item.entryId !== undefined && item.entryId !== ""
    ? `${callKeyOf(item.entryId)}#${item.entryItemIndex ?? 0}`
    : `@${index}`;
}

function messageTimestamp(message: unknown): number | undefined {
  const value = (message as { timestamp?: unknown })?.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Live tail state (#306): bounded ephemeral projection below the persisted window. */
interface LiveTail {
  /** Ordered live entries (message completions and tool rows), bounded. */
  items: LiveItem[];
  /** Cumulative ordered streaming partial of the in-flight assistant message. */
  streaming: AssistantTextPart[] | undefined;
  /** Bounded diagnostic for a contained live-subscriber failure. */
  diagnostic: string | undefined;
  /** Fingerprints of dropped entries not yet recovered from persisted history. */
  dropped: DroppedEventFingerprint[];
  /** Set when fingerprint tracking overflows: the omission state stops clearing. */
  droppedUnknown: boolean;
}

function emptyLiveTail(): LiveTail {
  return { items: [], streaming: undefined, diagnostic: undefined, dropped: [], droppedUnknown: false };
}

/** Fingerprint of one live entry for the omission-recovery gate. */
function fingerprintOf(item: LiveItem): DroppedEventFingerprint | undefined {
  if (item.kind === "message") {
    if (item.content.length === 0) return undefined;
    const key = contentKey(item.content);
    if (key === "") return undefined;
    return {
      kind: "message",
      key,
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
      ...(item.historyFloor !== undefined ? { historyFloor: item.historyFloor } : {}),
    };
  }
  if (item.tool.callKey === "") return undefined;
  return {
    kind: "tool",
    name: item.tool.name,
    terminal: item.tool.endedAt !== undefined,
    callKey: item.tool.callKey,
  };
}

function contentKey(content: unknown): string {
  return Array.isArray(content) ? assistantContentKey(content as AssistantTextPart[]) : "";
}

/**
 * Composes the tentative-candidate footer (#307) under explicit budgets: the
 * hints drop first, then the candidate role truncates, and the unique ID is
 * the last thing to shrink — a narrow width with a long role can never hide
 * which child Enter would open.
 */
function candidateFooterText(
  candidate: ChildOverlayCandidate,
  openRole: string,
  width: number,
): string {
  const prefix = "candidate ";
  const identity = `${prefix}${candidate.role} ${candidate.idLabel}`;
  const hints = [
    ` · enter opens · esc keeps ${openRole}`,
    " · enter opens · esc",
    " · enter",
    "",
  ];
  for (const hint of hints) {
    if (visibleWidth(identity) + visibleWidth(hint) <= width) return identity + hint;
  }
  const floor = `${prefix}${candidate.idLabel} · enter`;
  // The role sits before the ID with one separator space; the floor form
  // already accounts for every other column.
  const roleBudget = width - visibleWidth(floor) - 1;
  if (roleBudget >= 1) {
    return `${prefix}${truncateToWidth(candidate.role, roleBudget, "…")} ${candidate.idLabel} · enter`;
  }
  const bare = `${prefix}${candidate.idLabel}`;
  return visibleWidth(bare) <= width ? bare : candidate.idLabel;
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
  /** Highest pre-append history floor received; duplicate/stale events fail closed. */
  private latestMessageFloor = -1;
  /** Tentative roster candidate while the overlay owns input (#307). */
  private candidate: ChildOverlayCandidate | undefined;
  /** Unseen live or persisted output below a suspended-tail viewport (#307). */
  private newOutput = false;
  /** Tool-row expansion state for this overlay; controller state per child. */
  private toolsExpanded = false;
  /**
   * Explicit tail-follow state (#307): true while the view pins to the newest
   * content. Renders never write a finite offset back while it is set, so
   * growth keeps a following view at the tail instead of stranding it.
   */
  private following = true;
  private cache: {
    width: number;
    columns: number;
    rows: number;
    scrollTop: number;
    following: boolean;
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
          // Expanded evidence through the public adapter contract (#307): the
          // bounded sanitized result projection renders as evidence rows only
          // while the row is expanded — the collapsed row stays exactly one
          // line. The display module owns wrapping, indent, and budgets.
          ...(item.output !== undefined && item.output !== ""
            ? { rows: [{ text: item.output }] }
            : {}),
        };
        return [this.input.display?.createComponent(description, this.theme, { expanded: this.toolsExpanded })
          ?? new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, this.theme, { expanded: this.toolsExpanded })];
      }
      default:
        return [this.genericTextComponent(item.text)];
    }
  }

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

    // A persisted tool row whose call also has a live row stays hidden: the
    // live row is the newer, authoritative state for that call (immediate
    // terminal state, no duplicate row) until its own result lands and the
    // live row sheds.
    const liveCallKeys = new Set(
      this.live.items
        .filter((item): item is Extract<LiveItem, { kind: "tool" }> => item.kind === "tool" && item.tool.callKey !== "")
        .map((item) => item.tool.callKey),
    );

    const occurrences = new Map<string, number>();
    for (const [index, item] of snapshot.items.entries()) {
      if (item.kind === "toolCall" && item.callKey !== undefined && liveCallKeys.has(item.callKey)) continue;
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
    if (this.live.dropped.length > 0 || this.live.droppedUnknown) {
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
    // A width change re-wraps every item, so a numeric visual-line offset can
    // land on a different transcript entry. Re-anchor the offset on the stable
    // item identity first (#307): the entry at the viewport top stays at the
    // top across narrow/wide round trips.
    const previous = this.lineModel;
    const anchor = previous !== undefined && previous.width !== width && !this.following
      && Number.isFinite(this.scrollTop)
      ? anchorForScroll(previous.model, this.scrollTop)
      : undefined;
    const model = this.buildLineModel(width);
    this.lineModel = { width, version: this.version, model };
    if (anchor !== undefined) {
      const remapped = scrollForAnchor(model, anchor);
      if (remapped !== undefined) this.scrollTop = remapped;
    }
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
    this.confirmLive();
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
    if (
      this.live.items.length > 0
      || this.live.diagnostic !== undefined
      || this.live.dropped.length > 0
      || this.live.droppedUnknown
    ) return true;
    const streaming = this.live.streaming;
    return streaming !== undefined && streaming.length > 0;
  }

  /** Whether the viewport currently sits at the bottom of the scroll space. */
  private isAtTail(): boolean {
    if (this.following) return true;
    if (!Number.isFinite(this.scrollTop) || this.lastWidth === undefined) return true;
    try {
      const model = this.lineModelFor(this.lastWidth);
      return this.scrollTop >= this.resolveViewport(model, this.bodyBudget()).maxScroll;
    } catch {
      return true;
    }
  }

  /**
   * Content arrived (#307). The follow flag alone decides: a following view
   * renders the new tail, so no notice appears; a suspended view has unseen
   * output below and the footer states it. This never consults the line-model
   * cache — the arriving event may not have invalidated it yet.
   */
  private markNewOutput(): void {
    this.newOutput = !this.following;
  }

  /** Position changes clear the state only once the tail is visible again. */
  private syncNewOutput(): void {
    if (this.newOutput && this.isAtTail()) this.newOutput = false;
  }

  /** One step of explicit suspension: the view stops following the tail. */
  private suspendFollow(): void {
    this.following = false;
  }

  /**
   * Confirms pending message completions against their own persisted
   * occurrences. A completion matches a persisted assistant item only when
   * both carry the same bounded content projection and the same native
   * message timestamp and begins exactly at the JSONL size captured before
   * Pi appended that message. Adjacent completions receive increasing floors
   * because Pi persists each `message_end` before emitting the next one. The
   * bounded live entries therefore need no lifetime consumption ledger, and
   * paging an old row back in cannot make it eligible for a newer completion.
   */
  private confirmLiveMessages(): void {
    if (this.live.items.length === 0) return;
    const drop = new Set<LiveItem>();
    const used = new Set<string>();
    for (const item of this.live.items) {
      if (item.kind !== "message" || drop.has(item)) continue;
      if (item.timestamp === undefined || item.historyFloor === undefined) continue;
      const key = contentKey(item.content);
      if (key === "") continue;
      const match = this.current.items.findIndex((persisted, index) => {
        if (persisted.kind !== "assistant") return false;
        if (contentKey(persisted.message.content) !== key) return false;
        const persistedTimestamp = messageTimestamp(persisted.message);
        if (persistedTimestamp === undefined || item.timestamp !== persistedTimestamp) return false;
        const identity = persistedItemIdentity(persisted, index);
        return persisted.entryByteOffset !== undefined
          && persisted.entryByteOffset === item.historyFloor
          && !used.has(identity);
      });
      if (match < 0) continue;
      const persisted = this.current.items[match]!;
      used.add(persistedItemIdentity(persisted, match));
      drop.add(item);
    }
    if (drop.size === 0) return;
    this.live.items = this.live.items.filter((item) => !drop.has(item));
  }

  /**
   * Whether persisted history now covers one live tool row. The
   * non-reversible key of the native call id is exact per-call identity,
   * including several same-name calls inside one assistant message, so a
   * running row drops only when its own call row is loaded and a finished row
   * only when that row carries its result; the visible terminal state never
   * regresses to running. A malformed event without the native identity is
   * never matched by tool name.
   */
  private toolCovered(tool: LiveToolState): boolean {
    if (tool.callKey !== "") {
      const match = this.current.items.find(
        (item): item is TranscriptItem & { kind: "toolCall" } => item.kind === "toolCall" && item.callKey === tool.callKey,
      );
      if (match === undefined) return false;
      return tool.endedAt === undefined || match.result !== undefined;
    }
    return false;
  }

  private reconcileLiveTools(): void {
    if (this.live.items.length === 0) return;
    this.live.items = this.live.items.filter((item) => item.kind !== "tool" || !this.toolCovered(item.tool));
  }

  /**
   * Clears drop fingerprints only for entries persisted history has actually
   * recovered on screen: a message fingerprint clears when a matching
   * occurrence (same content projection, timestamp, and eligible pre-append
   * floor) is loaded, a tool
   * fingerprint when its own call row is loaded (and, for a dropped terminal
   * event, only once that row has a result). Persisted message occurrences are
   * consumed one-for-one across equal fingerprints. An unrelated append
   * recovers nothing; unknown drops keep the marker visible permanently.
   */
  private recoverDropped(): void {
    if (this.live.dropped.length === 0) return;
    const availableMessages = new Map<string, Array<{ identity: string; byteOffset: number }>>();
    for (const [index, item] of this.current.items.entries()) {
      if (item.kind !== "assistant") continue;
      const timestamp = messageTimestamp(item.message);
      if (timestamp === undefined || item.entryByteOffset === undefined) continue;
      const identity = persistedItemIdentity(item, index);
      const key = `${contentKey(item.message.content)}\u0000${timestamp}`;
      const identities = availableMessages.get(key) ?? [];
      identities.push({ identity, byteOffset: item.entryByteOffset });
      availableMessages.set(key, identities);
    }
    this.live.dropped = this.live.dropped.filter((fingerprint) => {
      if (fingerprint.kind === "message") {
        if (fingerprint.timestamp === undefined || fingerprint.historyFloor === undefined) return true;
        const key = `${fingerprint.key}\u0000${fingerprint.timestamp}`;
        const identities = availableMessages.get(key);
        const match = identities?.findIndex((candidate) => candidate.byteOffset === fingerprint.historyFloor);
        if (match === undefined || match < 0) return true;
        identities!.splice(match, 1);
        return false;
      }
      return !this.current.items.some(
        (item) => item.kind === "toolCall"
          && item.callKey === fingerprint.callKey
          && (!fingerprint.terminal || item.result !== undefined),
      );
    });
  }

  /**
   * Reconciles the persisted window with the session file: retries the initial
   * tail while it has never loaded, otherwise reads bounded newer pages the
   * child appended. A view that was at the tail stays pinned to it; a scrolled
   * position is preserved — live growth never pulls an older position away.
   * A successful load also confirms live entries against their own persisted
   * occurrences and clears exactly the drop fingerprints history recovered.
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
      this.confirmLive();
    }
    if (follow) {
      this.following = true;
      this.scrollTop = Number.POSITIVE_INFINITY;
    } else if (changed) {
      this.newOutput = true;
    }
    this.refreshHistory();
  }

  /**
   * Appends one live entry. Overflow sheds the oldest — never the newest —
   * and records the shed entry's fingerprint so the omission state stays
   * visible until persisted history actually recovers it; if fingerprint
   * tracking itself overflows, the omission state stops clearing entirely.
   */
  private pushLiveItem(item: LiveItem): void {
    this.live.items.push(item);
    while (this.live.items.length > MAX_LIVE_ITEMS) {
      const shed = this.live.items.shift();
      if (shed === undefined) break;
      const fingerprint = fingerprintOf(shed);
      if (fingerprint === undefined) {
        this.live.droppedUnknown = true;
        continue;
      }
      if (this.live.dropped.length >= MAX_DROPPED_FINGERPRINTS) {
        this.live.droppedUnknown = true;
        break;
      }
      this.live.dropped.push(fingerprint);
    }
  }

  /**
   * Confirms live entries against the already-loaded window. Called after
   * every successful load and after a completion arrives: its own persisted
   * occurrence may have been loaded earlier (for example by the terminal
   * lifecycle reconcile that ran before the scheduled feed flush delivered
   * the completion), so confirmation must never require a fresh read.
   */
  private confirmLive(): void {
    this.confirmLiveMessages();
    this.reconcileLiveTools();
    this.recoverDropped();
  }

  /** Records externally dropped events (feed overflow) for the recovery gate. */
  private recordDropped(fingerprints: readonly DroppedEventFingerprint[], unknown: boolean): void {
    if (unknown) this.live.droppedUnknown = true;
    for (const fingerprint of fingerprints) {
      if (fingerprint.kind === "message" && fingerprint.historyFloor !== undefined) {
        this.latestMessageFloor = Math.max(this.latestMessageFloor, fingerprint.historyFloor);
      }
      if (this.live.dropped.length >= MAX_DROPPED_FINGERPRINTS) {
        this.live.droppedUnknown = true;
        return;
      }
      this.live.dropped.push(fingerprint);
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
        this.markNewOutput();
        this.syncState();
        this.invalidate();
        return;
      case "tool_updated":
        return;
      case "message_completed": {
        this.live.streaming = undefined;
        if (event.content.length > 0) {
          if (event.historyFloor !== undefined && event.historyFloor <= this.latestMessageFloor) {
            this.reconcileNow(1);
            return;
          }
          if (event.historyFloor !== undefined) this.latestMessageFloor = event.historyFloor;
          this.pushLiveItem({
            kind: "message",
            content: event.content,
            ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
            ...(event.historyFloor !== undefined ? { historyFloor: event.historyFloor } : {}),
          });
          this.confirmLiveMessages();
          this.markNewOutput();
        }
        break;
      }
      case "tool_started": {
        if (event.callKey === "") {
          this.live.droppedUnknown = true;
          this.refreshLiveShape();
          return;
        }
        // When the reconcile loads the call's own row by its non-reversible
        // call key, the persisted running row already shows the call and no
        // live row is added.
        const running: LiveToolState = {
          callKey: event.callKey,
          name: event.name,
          summary: event.summary,
          startedAt: event.startedAt,
        };
        this.reconcileNow(1);
        if (this.toolCovered(running)) return;
        this.pushLiveItem({ kind: "tool", tool: running });
        this.markNewOutput();
        this.refreshLiveShape();
        return;
      }
      case "tool_finished": {
        if (event.callKey === "") {
          this.live.droppedUnknown = true;
          this.refreshLiveShape();
          return;
        }
        // The end state must show without waiting for the toolResult append:
        // a live row that survived the reconcile flips immediately; otherwise
        // a fresh finished row appears whenever the call's own persisted row
        // has not loaded with its result yet.
        const existing = this.live.items.find(
          (item): item is Extract<LiveItem, { kind: "tool" }> => item.kind === "tool" && item.tool.callKey === event.callKey,
        );
        this.reconcileNow(1);
        const stillLive = existing !== undefined && this.live.items.includes(existing);
        if (stillLive) {
          existing.tool.endedAt = this.now();
          existing.tool.isError = event.isError;
          this.markNewOutput();
        } else {
          const finished: LiveToolState = {
            callKey: event.callKey,
            name: event.name,
            summary: "called",
            endedAt: this.now(),
            isError: event.isError,
          };
          if (this.toolCovered(finished)) {
            this.refreshLiveShape();
            return; // the call's own persisted row already carries the terminal state
          }
          this.pushLiveItem({ kind: "tool", tool: finished });
          this.markNewOutput();
        }
        this.refreshLiveShape();
        return;
      }
      case "live_events_dropped":
        this.recordDropped(event.dropped ?? [], event.droppedUnknown === true);
        this.markNewOutput();
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
      this.suspendFollow();
      if (this.scrollTop > 0) {
        this.scrollTop = Math.max(0, this.scrollTop - budget);
        this.syncNewOutput();
        return;
      }
      // At the loaded top: request one bounded older page and reveal it, so
      // repeated presses walk the complete history until the earliest entry.
      this.pageOlder(model, budget);
    } else {
      if (this.scrollTop < view.maxScroll) {
        this.scrollTop = Math.min(view.maxScroll, this.scrollTop + budget);
        this.syncNewOutput();
        return;
      }
      // At the loaded bottom: attempt one bounded newer page (evicted pages,
      // or a concurrent append completing the tail) and follow to the edge.
      this.pageNewer();
    }
    this.syncNewOutput();
  }

  /**
   * Wheel scrolling (#307) moves within the loaded window by a small line
   * count — no page loads, so a notch never demands history work.
   */
  private scrollLines(lines: number): void {
    if (this.lastWidth === undefined) return;
    if (lines < 0) this.suspendFollow();
    const model = this.lineModelFor(this.lastWidth);
    const view = this.resolveViewport(model, this.bodyBudget());
    const base = Number.isFinite(this.scrollTop) ? this.scrollTop : view.maxScroll;
    this.scrollTop = Math.min(view.maxScroll, Math.max(0, base + lines));
    this.syncNewOutput();
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
    // Follow to the newest edge (the #305 PageDown contract).
    this.following = true;
    this.scrollTop = Number.POSITIVE_INFINITY;
    this.syncNewOutput();
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
      this.suspendFollow();
      for (let page = 0; page < EDGE_LOAD_PAGES_PER_PRESS; page += 1) {
        if (!this.current.moreBefore) break;
        if (!this.input.model.history.loadOlder()) break;
        this.refreshHistory();
      }
      this.scrollTop = 0;
      this.syncNewOutput();
      return;
    }
    // End follows the newest edge: the bounded loads catch up with any
    // evicted or concurrently appended pages, and the follow state resumes
    // even when the newest page was already loaded (#307).
    for (let page = 0; page < EDGE_LOAD_PAGES_PER_PRESS; page += 1) {
      if (!this.input.model.history.loadNewer()) break;
      this.refreshHistory();
    }
    this.following = true;
    this.scrollTop = Number.POSITIVE_INFINITY;
    this.syncNewOutput();
  }

  /**
   * Publishes the controller's current roster candidate (#307). The overlay
   * renders it in the footer — an off-screen candidate stays identifiable
   * while the overlay covers the roster — and Escape cancels it instead of
   * closing while it differs from the open child.
   */
  updateCandidate(candidate: ChildOverlayCandidate | undefined): void {
    const previous = this.candidate;
    this.candidate = candidate;
    // The controller re-derives the candidate on every roster refresh; only a
    // real change may drop the render caches.
    if (previous?.id === candidate?.id && previous?.idLabel === candidate?.idLabel) return;
    this.invalidate();
  }

  /** The per-child reading state the controller restores on a later switch (#307). */
  captureViewState(): ChildReadingState {
    return {
      scrollTop: this.following ? Number.POSITIVE_INFINITY : this.scrollTop,
      following: this.following,
      toolsExpanded: this.toolsExpanded,
      newOutput: this.newOutput,
    };
  }

  /**
   * Re-points this same overlay at another child (#307): one handle, no
   * stacking, no return to main. The live tail starts fresh (an unobserved
   * child retained no events), the persisted window is the child's own
   * retained view, and the controller's captured scroll and expansion state
   * for that child are restored.
   */
  switchChild(model: ChildOverlayModel, restore: ChildReadingState): void {
    this.input.model = model;
    this.current = model.history.snapshot();
    this.live = emptyLiveTail();
    this.latestMessageFloor = -1;
    this.candidate = undefined;
    this.toolsExpanded = restore.toolsExpanded;
    this.following = restore.following;
    this.newOutput = restore.newOutput;
    this.scrollTop = restore.following ? Number.POSITIVE_INFINITY : restore.scrollTop;
    this.syncState();
    this.version += 1;
    this.invalidate();
    this.syncMotionSubscription();
  }

  /** Toggles this overlay's tool-row expansion (#307); state is per child. */
  private toggleTools(): void {
    this.toolsExpanded = !this.toolsExpanded;
    this.invalidate();
  }

  handleInput(data: string): void {
    const classified = classifyViewerInput(data, this.input.keybindings);
    switch (classified.kind) {
      case "close":
        // Escape first cancels a changed candidate and restores the open
        // child; only a second Escape closes (#307).
        if (this.candidate !== undefined && this.candidate.id !== this.input.model.id) {
          this.candidate = undefined;
          this.invalidate();
          this.input.onCancelCandidate?.();
          return;
        }
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
      case "wheel":
        this.scrollLines(classified.delta * WHEEL_SCROLL_LINES);
        return;
      case "jump":
        this.jump(classified.to);
        return;
      case "candidate":
        this.input.onNavigate?.(classified.delta);
        return;
      case "confirm":
        this.input.onConfirm?.();
        return;
      case "expand":
        this.toggleTools();
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
      && this.cache.scrollTop === this.scrollTop
      && this.cache.following === this.following
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
    // The footer row is the overlay's one status surface (#307): a tentative
    // roster candidate an off-screen roster cannot show, then the new-output
    // notice, then the default key hints — never more than one row.
    const expandKeys = this.input.keybindings?.getKeys?.("app.tools.expand") ?? ["ctrl+o"];
    const helpText = this.candidate !== undefined
      ? candidateFooterText(this.candidate, model.role, safeWidth)
      : this.newOutput
        ? "new output below · end resumes following · esc close"
        : `esc close · up/down switch child · pgup/pgdn/home/end scroll · ${expandKeys.join("/") || "ctrl+o"} expand tools · type or paste to return`;
    const help = truncateToWidth(this.theme.fg("muted", helpText), safeWidth, "…");

    const body = this.renderBody(safeWidth, plan.bodyRows);
    const lines = [title, rule, ...body, rule, help];
    this.cache = {
      width: safeWidth,
      columns: terminal.columns,
      rows: terminal.rows,
      scrollTop: Number.isFinite(this.scrollTop) ? this.scrollTop : Number.POSITIVE_INFINITY,
      following: this.following,
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
    // A following view keeps its sentinel: growth re-resolves to the new tail
    // on every render instead of pinning to the offset this one resolved to.
    if (!this.following) this.scrollTop = view.scrollTop;

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
