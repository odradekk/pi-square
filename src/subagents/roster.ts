import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isOwnedInputSurfaceActive } from "../core/input-surface";
import type { DisplayRuntime } from "../display/runtime";
import { listBackgroundJobs, subscribeBackgroundState, type BackgroundState } from "./background";
import { createChildHistory } from "./child-history";
import { sanitizeSubagentDisplay } from "./display";
import {
  defaultPaintTimers,
  isStructuralViewEvent,
  LIVE_REPAINT_COALESCE_MS,
  type ChildViewEvent,
  type PaintTimers,
} from "./live-events";
import { latestRosterToolCallSummary } from "./tool-display";
import type { BackgroundJobSnapshot } from "./types";
import {
  childOverlayOptions,
  type ChildOverlayModel,
  ChildTranscriptOverlay,
} from "./viewer";

export const SUBAGENT_ROSTER_KEY = "pi-square.subagents.roster";

/** Public-ID prefixes start at eight characters and extend only to disambiguate. */
const MIN_ID_PREFIX = 8;
/** Child rows shown at normal terminal heights. */
const MAX_ROSTER_ROWS = 10;
/** Floor for the row budget so even very short terminals keep the roster legible. */
const MIN_ROSTER_ROWS = 2;
/**
 * Duration refresh cadence while any current-parent child is still active.
 * Ticks come from the display runtime's session motion scheduler, so `off`
 * motion and downgraded environments never tick at all; a `full`-motion
 * scheduler fires faster and the roster throttles its publishes to this rate.
 */
const ROSTER_TICK_MS = 1_000;

const ACTIVE_STATUSES = new Set<BackgroundJobSnapshot["status"]>(["queued", "running", "cancelling"]);

/** Motion source the roster subscribes to; satisfied by the display runtime. */
export interface RosterMotion {
  readonly subscribe: (listener: () => void) => () => void;
}

interface WidgetTui {
  terminal: { rows: number };
}

/** One projected roster row: a sanitized, read-only view of a background child. */
export interface RosterRow {
  id: string;
  role: string;
  status: BackgroundJobSnapshot["status"];
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  activity: string;
}

export function rosterRowBudget(terminalRows: number): number {
  return Math.min(MAX_ROSTER_ROWS, Math.max(MIN_ROSTER_ROWS, Math.floor(Math.max(1, terminalRows) * 0.3)));
}

export function formatRosterDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function rosterId(id: string): string {
  return sanitizeSubagentDisplay(id).replace(/^subagent_/, "");
}

/**
 * Collision-safe ID prefixes for the current roster: eight characters by
 * default, extended to the shortest value that is unique among the displayed
 * set. Selection and ordering stay keyed by the complete public ID; the prefix
 * is presentation only.
 */
export function uniqueRosterIdPrefixes(ids: readonly string[]): Map<string, string> {
  const entries = ids.map((id) => ({ id, clean: rosterId(id) }));
  const prefixes = new Map<string, string>();
  for (const entry of entries) {
    const others = entries.filter((candidate) => candidate.id !== entry.id);
    let length = MIN_ID_PREFIX;
    while (length < entry.clean.length
      && others.some((other) => other.clean.slice(0, length) === entry.clean.slice(0, length))) {
      length += 1;
    }
    prefixes.set(entry.id, entry.clean.slice(0, length));
  }
  return prefixes;
}

/**
 * Candidate labels for one over-budget prefix, most descriptive first. The
 * conventional head/tail forms win when they distinguish the row; raw slices
 * are a narrow-width fallback for peers whose visible heads and tails match.
 */
function candidateLabels(points: readonly string[], budget: number): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (label: string) => {
    if (label !== "" && visibleWidth(label) <= budget && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  };
  const maxHead = Math.min(MIN_ID_PREFIX, budget - 1);
  for (let head = maxHead; head >= 1; head -= 1) {
    const tail = budget - head - 1;
    add(`${points.slice(0, head).join("")}…${points.slice(Math.max(0, points.length - tail)).join("")}`);
  }
  for (let tail = budget - 1; tail >= 1; tail -= 1) {
    add(`…${points.slice(points.length - tail).join("")}`);
  }
  for (let start = 0; start < points.length; start += 1) {
    add(points.slice(start, start + budget).join(""));
  }
  return labels;
}

/**
 * Fits all visible prefixes together. A small augmenting-path assignment
 * avoids a greedy early choice taking the only distinguishing label available
 * to a later peer. Full prefixes that already fit are kept verbatim.
 */
function fitRosterIdLabels(prefixes: readonly string[], budgets: readonly number[]): string[] {
  const labels = new Array<string>(prefixes.length);
  const owners = new Map<string, number>();
  const locked = new Set<number>();

  for (const [index, prefix] of prefixes.entries()) {
    if (visibleWidth(prefix) <= budgets[index]!) {
      labels[index] = prefix;
      owners.set(prefix, index);
      locked.add(index);
    }
  }

  const candidates = prefixes.map((prefix, index) => (
    candidateLabels(Array.from(prefix), budgets[index]!)
      .filter((candidate) => !owners.has(candidate))
  ));
  const claim = (index: number, visited: Set<string>): boolean => {
    for (const candidate of candidates[index]!) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const owner = owners.get(candidate);
      if (owner === undefined || (!locked.has(owner) && claim(owner, visited))) {
        owners.set(candidate, index);
        labels[index] = candidate;
        return true;
      }
    }
    return false;
  };

  for (const [index, prefix] of prefixes.entries()) {
    if (locked.has(index)) continue;
    if (!claim(index, new Set())) labels[index] = truncateToWidth(prefix, budgets[index]!, "…");
  }
  return labels;
}

const LIFECYCLE_TONES: Record<BackgroundJobSnapshot["status"], ThemeColor> = {
  queued: "muted",
  running: "accent",
  cancelling: "warning",
  completed: "success",
  failed: "error",
  aborted: "muted",
};

const LIFECYCLE_LABELS: Record<BackgroundJobSnapshot["status"], string> = {
  queued: "– queued",
  running: "● running",
  cancelling: "× cancelling",
  completed: "✓ completed",
  failed: "✗ failed",
  aborted: "× aborted",
};

function lifecycleText(theme: Theme, status: BackgroundJobSnapshot["status"]): string {
  return theme.fg(LIFECYCLE_TONES[status], LIFECYCLE_LABELS[status]);
}

/**
 * One physical roster row. Width pressure removes the latest activity, then
 * the duration, then truncates the role, while the selection marker, the
 * unique ID label, and the lifecycle always survive — the ID label is fitted
 * to the row's own budget before composition, so the lifecycle can never be
 * squeezed off the line.
 */
function renderRosterRow(
  theme: Theme,
  row: RosterRow,
  idPrefix: string,
  width: number,
  now: number,
  focused: boolean,
): string {
  const safeWidth = Math.max(1, width);
  const marker = theme.fg("muted", "○");
  const lifecycle = LIFECYCLE_LABELS[row.status];
  const roleWidth = visibleWidth(row.role);
  const idWidth = visibleWidth(idPrefix);
  const lifecycleWidth = visibleWidth(lifecycle);
  const separatorWidth = visibleWidth(" · ");

  const coreWidth = visibleWidth("○ ") + roleWidth + visibleWidth(" ") + idWidth + visibleWidth(" ") + lifecycleWidth;
  const duration = row.status === "queued" || row.status === "running" || row.status === "cancelling"
    ? formatRosterDuration(now - row.startedAt)
    : formatRosterDuration((row.endedAt ?? row.startedAt) - row.startedAt);
  const durationWidth = duration ? separatorWidth + visibleWidth(duration) : 0;
  const activityWidth = row.activity ? separatorWidth + visibleWidth(row.activity) : 0;

  let showDuration = durationWidth > 0;
  let showActivity = activityWidth > 0;
  if (coreWidth + durationWidth + activityWidth > safeWidth) showActivity = false;
  if (showDuration && coreWidth + durationWidth > safeWidth) showDuration = false;

  let role = row.role;
  if (coreWidth > safeWidth) {
    const roleBudget = safeWidth
      - (visibleWidth("○ ") + visibleWidth(" ") + idWidth + visibleWidth(" ") + lifecycleWidth);
    role = roleBudget >= 1 ? truncateToWidth(row.role, roleBudget, "…") : "";
  }

  const parts = [focused ? theme.fg("accent", "●") : marker];
  if (role) parts.push(theme.fg("accent", role));
  parts.push(theme.fg("dim", idPrefix), lifecycleText(theme, row.status));
  let line = parts.join(" ");
  if (showDuration) line += theme.fg("dim", ` · ${duration}`);
  if (showActivity) line += theme.fg("dim", " · ") + theme.fg("text", row.activity);
  return truncateToWidth(line, safeWidth, "…");
}

export interface RosterRenderOptions {
  width: number;
  rowBudget: number;
  now: number;
  /** Complete public ID of the keyboard candidate or open child, if any. */
  focusId?: string;
  /** First visible row index; the controller keeps the focus row on screen. */
  start?: number;
}

/** Renders the vertical child roster: one line per visible row plus accounting. */
export function renderSubagentRoster(
  theme: Theme,
  rows: readonly RosterRow[],
  options: RosterRenderOptions,
): string[] {
  if (rows.length === 0) return [];
  const safeWidth = Math.max(1, options.width);
  const budget = Math.max(1, options.rowBudget);
  const prefixes = uniqueRosterIdPrefixes(rows.map((row) => row.id));
  const maxStart = Math.max(0, rows.length - budget);
  const start = Math.min(Math.max(0, options.start ?? 0), maxStart);
  const visibleRows = rows.slice(start, start + budget);
  const fullPrefixes = visibleRows.map((row) => prefixes.get(row.id) ?? rosterId(row.id));
  const idBudgets = visibleRows.map((row) => {
    const lifecycleWidth = visibleWidth(LIFECYCLE_LABELS[row.status]);
    return Math.max(1, safeWidth - lifecycleWidth - visibleWidth("○ ") - visibleWidth(" "));
  });
  const labels = fitRosterIdLabels(fullPrefixes, idBudgets);

  const lines = visibleRows
    .map((row, index) => {
      // The ID label never widens past the space left beside the lifecycle,
      // so the core of the row always fits and the lifecycle survives. The
      // floor composition is marker + space + ID + space + lifecycle; a role
      // truncates away before the ID label does.
      return renderRosterRow(theme, row, labels[index]!, safeWidth, options.now, row.id === options.focusId);
    });
  // A scrolled window states what lies above it; the trailing line keeps the
  // established `… +N more` accounting for what lies below.
  if (start > 0) lines.unshift(truncateToWidth(theme.fg("dim", `… +${start} earlier`), safeWidth, "…"));
  const hidden = rows.length - Math.min(rows.length, start + budget);
  if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `… +${hidden} more`), safeWidth, "…"));
  return lines;
}

/**
 * The roster widget component. The projection is immutable per publication, so
 * rendered lines cache by width and terminal height like the other pi-square
 * frame components; the row budget shrinks on a height-only resize.
 */
export function createSubagentRosterWidget(
  tui: WidgetTui,
  theme: Theme,
  rows: readonly RosterRow[],
  now: number,
  focusId?: string,
  start?: number,
): Component {
  let cache: { width: number; rows: number; lines: string[] } | undefined;
  return {
    render(width: number): string[] {
      const terminalRows = Math.max(1, tui.terminal.rows);
      if (cache && cache.width === width && cache.rows === terminalRows) return cache.lines;
      const lines = renderSubagentRoster(theme, rows, {
        width,
        rowBudget: rosterRowBudget(terminalRows),
        now,
        ...(focusId !== undefined ? { focusId } : {}),
        ...(start !== undefined ? { start } : {}),
      });
      cache = { width, rows: terminalRows, lines };
      return lines;
    },
    invalidate(): void {
      cache = undefined;
    },
  };
}

function rosterRole(job: BackgroundJobSnapshot): string {
  return sanitizeSubagentDisplay(job.details.agent?.name ?? "generic").replace(/\s+/g, " ").trim() || "generic";
}

function rosterActivity(job: BackgroundJobSnapshot): string {
  // Latest activity is the shared allowlisted tool-call summary: argument
  // labels only, never tool-result bodies. A terminal child that never called
  // a tool has no activity to show — its lifecycle already tells the story.
  const terminal = !ACTIVE_STATUSES.has(job.status);
  return latestRosterToolCallSummary(job.details.timeline, terminal ? "" : "working");
}

/**
 * Error payloads can contain provider identifiers, credentials, or artifact
 * paths in shapes a best-effort text sanitizer cannot recognize. Empty
 * terminal views therefore derive their reason only from the closed error-code
 * vocabulary and lifecycle, never from `details.error`, `message`, or `cause`.
 */
function rosterFailureReason(job: BackgroundJobSnapshot): string {
  if (job.status === "aborted") return "Child run was aborted";
  switch (job.details.errorInfo?.code) {
    case "AUTH_FAILED": return "Child authentication failed";
    case "CONTEXT_TOO_LARGE": return "Child prompt exceeded the model context";
    case "RETRY_EXHAUSTED": return "Child model retries were exhausted";
    case "PERSISTENCE_FAILED": return "Child run state could not be saved";
    case "SESSION_HISTORY_UNAVAILABLE": return "Child session history was unavailable";
    default: return "Child execution failed";
  }
}

export interface SubagentRosterController {
  start(ctx: ExtensionContext): void;
  stop(): void;
  refresh(): void;
}

export interface SubagentRosterOptions {
  readonly now?: () => number;
  /** Display runtime used by transcript tool rows and, by default, ticking. */
  readonly display?: () => Pick<DisplayRuntime, "createComponent" | "subscribeMotion"> | undefined;
  /**
   * Session motion source, resolved at each start so a session replacement
   * that rebuilds the display runtime is followed; when absent or undefined
   * the roster never ticks on its own.
   */
  readonly motion?: () => RosterMotion | undefined;
  /**
   * Timer seam for the live overlay repaint (#306): one pending coalesced
   * repaint at most, injected as a clock in tests.
   */
  readonly timers?: PaintTimers;
}

/**
 * Session-scoped projection of the background job store into the roster
 * widget, plus the keyboard seam over it: exact-empty-editor Up/Down select a
 * read-only child candidate, Enter opens the child transcript overlay, and
 * ordinary input returns to the native editor untouched (#304). The store
 * stays the lifecycle source of truth: the controller adds no durable state,
 * no retention exemption, and no delivery interaction, and opening or viewing
 * a child is observational only.
 *
 * Since #306 an open overlay is live: the controller subscribes that child's
 * ephemeral view feed while the overlay is open, forwards events into the
 * overlay, repaints structural events immediately and ordinary streaming
 * deltas through the one coalesced repaint timer it owns, keeps the open
 * title's lifecycle truthful across transitions, and unsubscribes plus cancels
 * the timer on overlay close and session teardown. A subscriber defect is
 * contained as one bounded overlay diagnostic and never reaches the child.
 */
export function createSubagentRosterController(
  state: BackgroundState,
  options: SubagentRosterOptions = {},
): SubagentRosterController {
  const now = options.now ?? Date.now;
  let display: Pick<DisplayRuntime, "createComponent" | "subscribeMotion"> | undefined;
  let motion: RosterMotion | undefined;
  let context: ExtensionContext | undefined;
  let parentSessionId = "";
  let unsubscribe: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let motionUnsubscribe: (() => void) | undefined;
  let lastPublishAt = -Infinity;
  /** Unconfirmed keyboard candidate over the roster; keyed by complete public ID. */
  let candidateId: string | undefined;
  /** Child whose transcript overlay currently owns input; keyed by public ID. */
  let openId: string | undefined;
  /** Resolves the pending `ui.custom` promise and removes the overlay. */
  let closeOverlay: (() => void) | undefined;
  /** Component reference retained independently so a rejected custom promise can dispose it. */
  let activeOverlay: ChildTranscriptOverlay | undefined;
  /** TUI of the open overlay, used only to request coalesced live repaints. */
  let openTui: { requestRender(): void } | undefined;
  /** Live view feed subscription for the open child (#306). */
  let unsubscribeLive: (() => void) | undefined;
  /** Lifecycle status last pushed into the open overlay, to detect transitions. */
  let openModelStatus: BackgroundJobSnapshot["status"] | undefined;
  const timers = options.timers ?? defaultPaintTimers;
  /** The one session-owned live repaint timer; at most one is ever pending. */
  let paintTimer: unknown;
  let lastPaintAt = -Infinity;

  const cancelLivePaint = () => {
    if (paintTimer !== undefined) {
      timers.clearTimeout(paintTimer);
      paintTimer = undefined;
    }
  };

  const paintOpenOverlay = () => {
    lastPaintAt = now();
    try {
      openTui?.requestRender();
    } catch {
      // Repaint requests are best-effort; the next frame retries.
    }
  };

  /**
   * Live repaint scheduling (#306): structural events render immediately,
   * ordinary streaming deltas coalesce to at most one repaint per window and
   * share the single pending timer with any structural flush.
   */
  const scheduleLivePaint = (structural: boolean) => {
    if (structural) {
      cancelLivePaint();
      paintOpenOverlay();
      return;
    }
    if (paintTimer !== undefined) return;
    const remaining = LIVE_REPAINT_COALESCE_MS - (now() - lastPaintAt);
    if (remaining <= 0) {
      paintOpenOverlay();
      return;
    }
    paintTimer = timers.setTimeout(() => {
      paintTimer = undefined;
      paintOpenOverlay();
    }, remaining);
  };

  const detachLiveView = () => {
    unsubscribeLive?.();
    unsubscribeLive = undefined;
    cancelLivePaint();
    openTui = undefined;
    openModelStatus = undefined;
  };
  let viewportStart = 0;
  let tuiRef: WidgetTui | undefined;
  const stopMotion = () => {
    motionUnsubscribe?.();
    motionUnsubscribe = undefined;
  };

  const ensureMotion = () => {
    if (motionUnsubscribe !== undefined || !motion) return;
    motionUnsubscribe = motion.subscribe(() => {
      try {
        // A full-motion scheduler fires at 120 ms; the roster republishes at
        // most once per duration cadence. An off-motion scheduler never fires.
        if (now() - lastPublishAt < ROSTER_TICK_MS) return;
        refresh();
      } catch {
        // A presentation refresh defect must never escape the scheduler.
      }
    });
  };

  // Only children of the current parent session: jobs an earlier parent
  // session left in-process are as foreign as persisted history on disk.
  const rosterJobs = () => listBackgroundJobs(state)
    .filter((job) => parentSessionId !== "" && job.details.lastParentSessionId === parentSessionId);

  // The background store owns immutable creation time for every retained
  // public ID; the full ID only breaks an exact tie.
  const rosterRows = (jobs: readonly BackgroundJobSnapshot[]): RosterRow[] => jobs
    .map((job): RosterRow => ({
      id: job.id,
      role: rosterRole(job),
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.details.startedAt,
      endedAt: job.details.endedAt,
      activity: rosterActivity(job),
    }))
    .sort((left, right) => (
      left.createdAt - right.createdAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    ));

  const focusId = () => openId ?? candidateId;

  /** Shifts the visible window the minimum needed to keep the focus row on screen. */
  const followViewport = (rows: readonly RosterRow[]) => {
    const terminalRows = tuiRef ? Math.max(1, tuiRef.terminal.rows) : 0;
    if (terminalRows < 1) {
      viewportStart = 0;
      return;
    }
    const budget = rosterRowBudget(terminalRows);
    const maxStart = Math.max(0, rows.length - budget);
    const focus = focusId();
    const focusIndex = focus === undefined ? undefined : rows.findIndex((row) => row.id === focus);
    if (focusIndex !== undefined) {
      if (focusIndex < viewportStart) viewportStart = focusIndex;
      else if (focusIndex >= viewportStart + budget) viewportStart = focusIndex - budget + 1;
    }
    viewportStart = Math.min(Math.max(0, viewportStart), maxStart);
  };

  /**
   * Keeps the open overlay's lifecycle truthful while it stays open (#306):
   * every transition of the viewed child — including terminalization — updates
   * the title and state line, a terminal transition performs one final
   * bounded history reconciliation, and the change renders immediately. A
   * presentation defect here is contained like every refresh failure.
   */
  const pushOpenOverlayLifecycle = (jobs: readonly BackgroundJobSnapshot[]) => {
    const overlay = activeOverlay;
    if (overlay === undefined || openId === undefined) return;
    const job = jobs.find((candidate) => candidate.id === openId);
    if (!job || openModelStatus === job.status) return;
    openModelStatus = job.status;
    const status = job.status;
    const failureReason = status === "failed" || status === "aborted" ? rosterFailureReason(job) : undefined;
    try {
      overlay.updateLifecycle({
        status,
        lifecycleLabel: LIFECYCLE_LABELS[status],
        lifecycleTone: LIFECYCLE_TONES[status],
        durationText: formatRosterDuration(
          ACTIVE_STATUSES.has(status)
            ? now() - job.details.startedAt
            : (job.details.endedAt ?? job.details.startedAt) - job.details.startedAt,
        ),
        ...(failureReason ? { failureReason } : {}),
      });
      if (!ACTIVE_STATUSES.has(status)) overlay.reconcileNow(8);
    } catch {
      // The overlay stays observational; a rendering defect stays contained.
    }
    scheduleLivePaint(true);
  };

  const refresh = () => {
    if (!context?.hasUI || context.mode !== "tui") return;
    const jobs = rosterJobs();
    const rows = rosterRows(jobs);

    if (rows.length === 0) {
      stopMotion();
      candidateId = undefined;
      context.ui.setWidget(SUBAGENT_ROSTER_KEY, undefined);
      return;
    }

    followViewport(rows);
    pushOpenOverlayLifecycle(jobs);
    const focus = focusId();
    const snapshotAt = now();
    lastPublishAt = snapshotAt;
    context.ui.setWidget(
      SUBAGENT_ROSTER_KEY,
      (tui, theme) => {
        tuiRef = tui;
        return createSubagentRosterWidget(tui, theme, rows, snapshotAt, focus, viewportStart);
      },
      { placement: "aboveEditor" },
    );
    // Only still-active children have a moving duration; a settled roster
    // keeps its final timestamps without ticking.
    if (jobs.some((job) => ACTIVE_STATUSES.has(job.status))) ensureMotion();
    else stopMotion();
  };

  const editorText = (): string => {
    if (!context || typeof context.ui.getEditorText !== "function") return "\u0000";
    return context.ui.getEditorText();
  };

  const clearCandidate = () => {
    if (candidateId === undefined) return;
    candidateId = undefined;
    refresh();
  };

  const moveCandidate = (delta: number, rows: readonly RosterRow[]) => {
    if (rows.length === 0) return;
    // A candidate that no longer has a row (the child left the store between
    // key presses) counts as no candidate, so entry semantics apply again:
    // first Down selects the first child, first Up the last. Movement clamps
    // at both ends and never wraps.
    const found = candidateId === undefined ? -1 : rows.findIndex((row) => row.id === candidateId);
    const next = found < 0
      ? (delta > 0 ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, found + delta));
    candidateId = rows[next]?.id ?? candidateId;
    refresh();
  };

  const openChildOverlay = (id: string) => {
    if (!context?.hasUI || context.mode !== "tui") return;
    if (openId !== undefined || closeOverlay !== undefined) return;
    const jobs = rosterJobs();
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) return;

    const rows = rosterRows(jobs);
    const prefixes = uniqueRosterIdPrefixes(rows.map((row) => row.id));
    const idLabel = prefixes.get(job.id) ?? rosterId(job.id);
    const durationText = formatRosterDuration(
      ACTIVE_STATUSES.has(job.status)
        ? now() - job.details.startedAt
        : (job.details.endedAt ?? job.details.startedAt) - job.details.startedAt,
    );
    const failureReason = job.status === "failed" || job.status === "aborted"
      ? rosterFailureReason(job)
      : "";

    // The model opens with role, identity, lifecycle, duration, and the
    // initial bounded tail page of the child's native history (#305); the
    // overlay pages the rest on demand from the validated session file, and
    // live view events and store transitions keep the open view current
    // (#306).
    const model: ChildOverlayModel = {
      role: rosterRole(job),
      idLabel,
      lifecycleLabel: LIFECYCLE_LABELS[job.status],
      lifecycleTone: LIFECYCLE_TONES[job.status],
      status: job.status,
      durationText,
      ...(failureReason ? { failureReason } : {}),
      history: createChildHistory(job.id, { observedAt: now() }),
    };

    candidateId = undefined;
    openId = job.id;
    openModelStatus = job.status;

    const settle = () => {
      if (closeOverlay !== undefined) {
        const close = closeOverlay;
        closeOverlay = undefined;
        try {
          close();
        } catch {
          // Closing an already-closed overlay is harmless.
        }
      }
      detachLiveView();
      openId = undefined;
      candidateId = undefined;
      refresh();
    };

    let overlayOptions: ReturnType<typeof childOverlayOptions> | undefined;
    try {
      void context.ui.custom<void>((tui, theme, _keybindings, done) => {
        // Live getters: the TUI re-reads these options every render, so the
        // outer geometry follows terminal resizes across the small/normal
        // threshold for as long as the overlay stays open.
        overlayOptions = childOverlayOptions(tui);
        openTui = tui;
        const overlay = new ChildTranscriptOverlay({
          tui,
          theme,
          model,
          now: () => now(),
          ...(display ? { display } : {}),
          onClose: settle,
          onReplay: (text) => {
            settle();
            try {
              context?.ui.pasteToEditor(text);
            } catch {
              // Replay stays best-effort; the overlay still closed and the
              // user keeps the native editor.
            }
          },
        });
        activeOverlay = overlay;
        // Live view events (#306): the feed's subscriber isolation keeps a
        // broken listener from the child run; this guard keeps the overlay's
        // own failures from escaping too, as one bounded diagnostic row.
        unsubscribeLive = state.viewFeed?.subscribe(job.id, (event: ChildViewEvent) => {
          const target = activeOverlay;
          if (target === undefined || openId !== job.id) return;
          try {
            target.applyLiveEvent(event);
          } catch {
            try {
              target.setLiveDiagnostic();
            } catch {
              // Contained: the persisted view stays usable.
            }
          }
          scheduleLivePaint(isStructuralViewEvent(event));
        });
        closeOverlay = () => {
          overlay.dispose();
          if (activeOverlay === overlay) activeOverlay = undefined;
          done(undefined);
        };
        return overlay;
      }, {
        overlay: true,
        overlayOptions: () => overlayOptions ?? { width: "80%", maxHeight: "75%", anchor: "center" },
      }).catch(() => {
        if (openId === job.id) {
          activeOverlay?.dispose();
          activeOverlay = undefined;
          closeOverlay = undefined;
          detachLiveView();
          openId = undefined;
          refresh();
        }
      });
    } catch {
      activeOverlay?.dispose();
      activeOverlay = undefined;
      closeOverlay = undefined;
      detachLiveView();
      openId = undefined;
      refresh();
      return;
    }
    refresh();
  };

  /**
   * The accepted global terminal-input listener. Roster navigation runs only
   * while the native editor holds exactly zero content and no pi-square-owned
   * modal has focus; everything else reaches Pi unchanged. Pi 0.84.2 exposes
   * no focus query, so a third-party capturing overlay cannot be detected —
   * a documented limitation of this seam, not a replaced editor.
   */
  const handleTerminalInput = (data: string): { consume?: boolean; data?: string } | undefined => {
    if (context === undefined || openId !== undefined || closeOverlay !== undefined || data === "") return undefined;
    if (isOwnedInputSurfaceActive()) {
      clearCandidate();
      return undefined;
    }
    const up = matchesKey(data, "up");
    const down = matchesKey(data, "down");
    if (up || down) {
      const rows = rosterRows(rosterJobs());
      if (editorText() !== "" || rows.length === 0) {
        clearCandidate();
        return undefined;
      }
      moveCandidate(up ? -1 : 1, rows);
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      const rows = rosterRows(rosterJobs());
      const editorEmpty = editorText() === "";
      const candidate = candidateId !== undefined && editorEmpty && rows.some((row) => row.id === candidateId)
        ? candidateId
        : undefined;
      if (candidate === undefined) {
        // Enter without an explicit candidate keeps Pi's native behavior.
        clearCandidate();
        return undefined;
      }
      openChildOverlay(candidate);
      return { consume: true };
    }
    // Beginning to edit (text, whitespace, paste, IME composition) clears an
    // unopened candidate and passes the input through unchanged.
    clearCandidate();
    return undefined;
  };

  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    stopMotion();
    display = undefined;
    motion = undefined;
    lastPublishAt = -Infinity;
    if (closeOverlay !== undefined) {
      const close = closeOverlay;
      closeOverlay = undefined;
      try {
        close();
      } catch {
        // Closing an already-closed overlay is harmless.
      }
    }
    detachLiveView();
    activeOverlay?.dispose();
    activeOverlay = undefined;
    openId = undefined;
    candidateId = undefined;
    viewportStart = 0;
    tuiRef = undefined;
    if (context?.hasUI) context.ui.setWidget(SUBAGENT_ROSTER_KEY, undefined);
    context = undefined;
    parentSessionId = "";
  };

  return {
    start(ctx) {
      stop();
      // Interactive TUI only: print, JSON, RPC, and headless sessions create
      // no roster, no subscription, and hold no context.
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      context = ctx;
      display = options.display?.();
      const activeDisplay = display;
      motion = options.motion?.()
        ?? (activeDisplay ? { subscribe: (listener) => activeDisplay.subscribeMotion(listener) } : undefined);
      parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
      unsubscribe = subscribeBackgroundState(state, refresh);
      if (typeof ctx.ui.onTerminalInput === "function") {
        unsubscribeInput = ctx.ui.onTerminalInput(handleTerminalInput);
      }
      refresh();
    },
    stop,
    refresh,
  };
}
