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
  type ChildHistorySnapshot,
  type ChildHistoryView,
  type TranscriptItem,
} from "./child-history";

/**
 * Read-only child transcript viewer (odradekk/pi-square#304, #305).
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
 * The model is still frozen when the overlay opens; live streaming,
 * cross-child navigation, and per-child reading state are later slices of
 * #302, and the overlay remains a plugin projection — not Pi's private native
 * transcript pipeline.
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
  /** Active display runtime; absent only in isolated fallback/test rendering. */
  display?: Pick<DisplayRuntime, "createComponent" | "subscribeMotion">;
  /** Escape path: close, clear selection, and return focus to main. */
  onClose(): void;
  /** Replay path: close, then place the complete text in the empty editor. */
  onReplay(text: string): void;
}

function emptyStateLine(model: ChildOverlayModel, snapshot: ChildHistorySnapshot): { text: string; tone: ThemeColor } {
  if (snapshot.initialError !== undefined) {
    return { text: `Transcript unavailable: ${snapshot.initialError}`, tone: "error" };
  }
  if (snapshot.items.length > 0) return { text: "", tone: "muted" };
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

/** One item's stable identity: native entry id plus ordinal within the entry. */
function itemKey(item: TranscriptItem, index: number, occurrences: Map<string, number>): string {
  const base = item.entryId !== undefined && item.entryId !== "" ? item.entryId : `@${index}`;
  const occurrence = occurrences.get(base) ?? 0;
  occurrences.set(base, occurrence + 1);
  return `${base}#${occurrence}`;
}

interface LineModel {
  lines: string[];
  /** Scroll-space line index where each item's rendered block starts. */
  starts: number[];
  /** Rendered line count per item. */
  counts: number[];
  /** Stable per-item keys, parallel to the snapshot items. */
  keys: string[];
}

/**
 * The capturing overlay component: one title row, one bounded scrollable
 * transcript body, and one help row between quiet rules. Item components and
 * the flattened scroll space are cached by width and history version; the
 * final viewport is cached additionally by terminal size and scroll position,
 * so a running tool still refreshes its duration at the motion interval while
 * scrolling re-slices cached lines.
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
   * Builds the flattened scroll space for one width: an optional older-history
   * edge (or the bounded retryable page error), every loaded item's rendered
   * lines, and an optional newer-history edge. Markers and items share the
   * same scroll space so the body budget always bounds the viewport exactly.
   */
  private buildLineModel(width: number): LineModel {
    const snapshot = this.current;
    const indent = "  ";
    const contentWidth = Math.max(1, width - visibleWidth(indent));
    const lines: string[] = [];
    const starts: number[] = [];
    const counts: number[] = [];
    const keys: string[] = [];

    if (snapshot.pageError !== undefined || snapshot.moreBefore) {
      lines.push(snapshot.pageError !== undefined
        ? this.theme.fg("error", `${indent}older ${CHILD_HISTORY_READ_ERROR} — page up retries`)
        : this.theme.fg("dim", `${indent}… earlier history (page up)`));
    }

    const occurrences = new Map<string, number>();
    for (const [index, item] of snapshot.items.entries()) {
      let rendered: string[];
      try {
        rendered = this.componentsFor(item).flatMap((component) => component.render(contentWidth));
      } catch {
        // A single entry that Pi's components cannot build renders through
        // the sanitized generic fallback; the view never throws.
        rendered = this.componentsFor({ kind: "generic", text: this.describeItem(item) })[0]!
          .render(contentWidth);
      }
      starts.push(lines.length);
      counts.push(rendered.length);
      keys.push(itemKey(item, index, occurrences));
      lines.push(...rendered.map((line) => indent + line));
    }

    if (snapshot.moreAfter) {
      lines.push(this.theme.fg("dim", `${indent}… newer history (page down)`));
    }
    return { lines, starts, counts, keys };
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
    this.version += 1;
    this.lineModel = undefined;
    this.cache = undefined;
    this.state = emptyStateLine(this.input.model, this.current);
    this.syncMotionSubscription();
  }

  /** Subscribes to motion only while an unresolved tool call is loaded. */
  private syncMotionSubscription(): void {
    const wantsMotion = this.current.items.some((item) => item.kind === "toolCall" && !item.result);
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
