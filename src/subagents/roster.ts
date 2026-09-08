import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { listBackgroundJobs, subscribeBackgroundState, type BackgroundState } from "./background";
import { sanitizeSubagentDisplay } from "./display";
import { latestToolCallSummary } from "./tool-display";
import type { BackgroundJobSnapshot } from "./types";

export const SUBAGENT_ROSTER_KEY = "pi-square.subagents.roster";

/** Public-ID prefixes start at eight characters and extend only to disambiguate. */
const MIN_ID_PREFIX = 8;
/** Child rows shown at normal terminal heights. */
const MAX_ROSTER_ROWS = 10;
/** Floor for the row budget so even very short terminals keep the roster legible. */
const MIN_ROSTER_ROWS = 2;
/** Duration refresh cadence while any current-parent child is still active. */
const ROSTER_TICK_MS = 1_000;

const ACTIVE_STATUSES = new Set<BackgroundJobSnapshot["status"]>(["queued", "running", "cancelling"]);

/** Injectable clock for duration ticking; mirrors the display motion clock shape. */
export interface RosterClock {
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly unref?: (handle: unknown) => void;
}

const SYSTEM_ROSTER_CLOCK: RosterClock = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  unref: (handle) => (handle as NodeJS.Timeout).unref?.(),
};

interface WidgetTui {
  terminal: { rows: number };
}

/** One projected roster row: a sanitized, read-only view of a background child. */
export interface RosterRow {
  id: string;
  role: string;
  status: BackgroundJobSnapshot["status"];
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
 * unique ID prefix, and the lifecycle always survive.
 */
function renderRosterRow(theme: Theme, row: RosterRow, idPrefix: string, width: number, now: number): string {
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

  const parts = [marker];
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

  const lines = rows
    .slice(0, budget)
    .map((row) => renderRosterRow(theme, row, prefixes.get(row.id) ?? rosterId(row.id), safeWidth, options.now));
  const hidden = rows.length - Math.min(rows.length, budget);
  if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `… +${hidden} more`), safeWidth, "…"));
  return lines;
}

/**
 * The roster widget component. The projection is immutable per publication, so
 * rendered lines cache by width like the other pi-square frame components.
 */
export function createSubagentRosterWidget(
  tui: WidgetTui,
  theme: Theme,
  rows: readonly RosterRow[],
  now: number,
): Component {
  let cache: { width: number; lines: string[] } | undefined;
  return {
    render(width: number): string[] {
      if (cache && cache.width === width) return cache.lines;
      const lines = renderSubagentRoster(theme, rows, {
        width,
        rowBudget: rosterRowBudget(tui.terminal.rows),
        now,
      });
      cache = { width, lines };
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
  return latestToolCallSummary(job.details.timeline, terminal ? "" : "working");
}

export interface SubagentRosterController {
  start(ctx: ExtensionContext): void;
  stop(): void;
  refresh(): void;
}

/**
 * Session-scoped projection of the background job store into the roster
 * widget. The store stays the lifecycle source of truth: the controller adds
 * no durable state, no retention exemption, and no delivery interaction.
 */
export function createSubagentRosterController(
  state: BackgroundState,
  options: { now?: () => number; clock?: RosterClock } = {},
): SubagentRosterController {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? SYSTEM_ROSTER_CLOCK;
  let context: ExtensionContext | undefined;
  let parentSessionId = "";
  let unsubscribe: (() => void) | undefined;
  let tick: unknown;
  /** First-seen sequence per public ID; a resumed ID keeps its original slot. */
  const order = new Map<string, number>();
  let nextOrder = 0;

  const stopTick = () => {
    if (tick === undefined) return;
    clock.clearInterval(tick);
    tick = undefined;
  };

  const ensureTick = () => {
    if (tick !== undefined) return;
    tick = clock.setInterval(() => {
      try {
        refresh();
      } catch {
        // A presentation refresh defect must never escape the timer.
      }
    }, ROSTER_TICK_MS);
    clock.unref?.(tick);
  };

  const refresh = () => {
    if (!context?.hasUI || context.mode !== "tui") return;
    // Only children of the current parent session: jobs an earlier parent
    // session left in-process are as foreign as persisted history on disk.
    const jobs = listBackgroundJobs(state)
      .filter((job) => parentSessionId !== "" && job.details.lastParentSessionId === parentSessionId);

    const fresh = jobs
      .map((job) => job.id)
      .filter((id) => !order.has(id))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const id of fresh) order.set(id, nextOrder++);

    const rows = jobs
      .map((job): RosterRow => ({
        id: job.id,
        role: rosterRole(job),
        status: job.status,
        startedAt: job.details.startedAt,
        endedAt: job.details.endedAt,
        activity: rosterActivity(job),
      }))
      .sort((left, right) => (
        (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      ));

    if (rows.length === 0) {
      stopTick();
      context.ui.setWidget(SUBAGENT_ROSTER_KEY, undefined);
      return;
    }

    const snapshotAt = now();
    context.ui.setWidget(
      SUBAGENT_ROSTER_KEY,
      (tui, theme) => createSubagentRosterWidget(tui, theme, rows, snapshotAt),
      { placement: "aboveEditor" },
    );
    // Only still-active children have a moving duration; a settled roster
    // keeps its final timestamps without a timer.
    if (jobs.some((job) => ACTIVE_STATUSES.has(job.status))) ensureTick();
    else stopTick();
  };

  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    stopTick();
    if (context?.hasUI) context.ui.setWidget(SUBAGENT_ROSTER_KEY, undefined);
    context = undefined;
    parentSessionId = "";
    order.clear();
  };

  return {
    start(ctx) {
      stop();
      // Interactive TUI only: print, JSON, RPC, and headless sessions create
      // no roster, no subscription, and hold no context.
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      context = ctx;
      parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
      unsubscribe = subscribeBackgroundState(state, refresh);
      refresh();
    },
    stop,
    refresh,
  };
}
