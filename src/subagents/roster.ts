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

function elidedPrefix(points: readonly string[], head: number, budget: number): string {
  const tail = Math.max(1, budget - head - 1);
  return `${points.slice(0, head).join("")}…${points.slice(Math.max(0, points.length - tail)).join("")}`;
}

/**
 * Fits one unique prefix into the row's ID budget. A prefix that is longer
 * than the budget keeps a distinguishable identity through middle elision —
 * head plus tail — choosing the split so no two roster rows render the same
 * label, mirroring the display grammar's path elision.
 */
export function fitRosterIdPrefix(prefix: string, budget: number, peers: readonly string[]): string {
  const points = Array.from(prefix);
  if (points.length <= budget) return prefix;
  if (budget >= 3) {
    // Prefer the conventional eight-character head, then walk the split
    // toward a longer tail so a distinguishing character anywhere in the ID
    // can keep two colliding labels apart, down to three cells.
    const peerPoints = peers
      .filter((peer) => peer !== prefix)
      .map((peer) => Array.from(peer));
    const firstHead = Math.min(MIN_ID_PREFIX, budget - 2);
    for (let head = firstHead; head >= 1; head -= 1) {
      const candidate = elidedPrefix(points, head, budget);
      if (!peerPoints.some((peer) => elidedPrefix(peer, head, budget) === candidate)) return candidate;
    }
    return elidedPrefix(points, budget - 2, budget);
  }
  // Below three cells no head-ellipsis-tail label fits: identity degrades to
  // a truncated label by definition, while the row keeps marker and lifecycle.
  return truncateToWidth(prefix, budget, "…");
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
  const fullPrefixes = rows.map((row) => prefixes.get(row.id) ?? rosterId(row.id));

  const lines = rows
    .slice(0, budget)
    .map((row, index) => {
      // The ID label never widens past the space left beside the lifecycle,
      // so the core of the row always fits and the lifecycle survives. The
      // floor composition is marker + space + ID + space + lifecycle; a role
      // truncates away before the ID label does.
      const lifecycleWidth = visibleWidth(LIFECYCLE_LABELS[row.status]);
      const idBudget = Math.max(1, safeWidth - lifecycleWidth - visibleWidth("○ ") - visibleWidth(" "));
      return renderRosterRow(
        theme,
        row,
        fitRosterIdPrefix(fullPrefixes[index]!, idBudget, fullPrefixes),
        safeWidth,
        options.now,
      );
    });
  const hidden = rows.length - Math.min(rows.length, budget);
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
  return latestToolCallSummary(job.details.timeline, terminal ? "" : "working");
}

export interface SubagentRosterController {
  start(ctx: ExtensionContext): void;
  stop(): void;
  refresh(): void;
}

export interface SubagentRosterOptions {
  readonly now?: () => number;
  /**
   * Session motion source, resolved at each start so a session replacement
   * that rebuilds the display runtime is followed; when absent or undefined
   * the roster never ticks on its own.
   */
  readonly motion?: () => RosterMotion | undefined;
}

/**
 * Session-scoped projection of the background job store into the roster
 * widget. The store stays the lifecycle source of truth: the controller adds
 * no durable state, no retention exemption, and no delivery interaction.
 */
export function createSubagentRosterController(
  state: BackgroundState,
  options: SubagentRosterOptions = {},
): SubagentRosterController {
  const now = options.now ?? Date.now;
  let motion: RosterMotion | undefined;
  let context: ExtensionContext | undefined;
  let parentSessionId = "";
  let unsubscribe: (() => void) | undefined;
  let motionUnsubscribe: (() => void) | undefined;
  let lastPublishAt = -Infinity;
  /**
   * Original creation timestamp per public ID, captured at first observation
   * and never overwritten: rows sort by this key with the full public ID as
   * the tie-break, so arrival order across separate notifications never
   * matters and a resumed ID keeps its original slot.
   */
  const creationKeys = new Map<string, number>();

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

  const refresh = () => {
    if (!context?.hasUI || context.mode !== "tui") return;
    // Only children of the current parent session: jobs an earlier parent
    // session left in-process are as foreign as persisted history on disk.
    const jobs = listBackgroundJobs(state)
      .filter((job) => parentSessionId !== "" && job.details.lastParentSessionId === parentSessionId);

    for (const job of jobs) {
      if (!creationKeys.has(job.id)) creationKeys.set(job.id, job.createdAt);
    }

    // Immutable creation time orders the roster; the full public ID only
    // breaks an exact tie, independent of how the jobs arrived.
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
        (creationKeys.get(left.id) ?? 0) - (creationKeys.get(right.id) ?? 0)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      ));

    if (rows.length === 0) {
      stopMotion();
      context.ui.setWidget(SUBAGENT_ROSTER_KEY, undefined);
      return;
    }

    const snapshotAt = now();
    lastPublishAt = snapshotAt;
    context.ui.setWidget(
      SUBAGENT_ROSTER_KEY,
      (tui, theme) => createSubagentRosterWidget(tui, theme, rows, snapshotAt),
      { placement: "aboveEditor" },
    );
    // Only still-active children have a moving duration; a settled roster
    // keeps its final timestamps without ticking.
    if (jobs.some((job) => ACTIVE_STATUSES.has(job.status))) ensureMotion();
    else stopMotion();
  };

  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    stopMotion();
    motion = undefined;
    lastPublishAt = -Infinity;
    if (context?.hasUI) context.ui.setWidget(SUBAGENT_ROSTER_KEY, undefined);
    context = undefined;
    parentSessionId = "";
    creationKeys.clear();
  };

  return {
    start(ctx) {
      stop();
      // Interactive TUI only: print, JSON, RPC, and headless sessions create
      // no roster, no subscription, and hold no context.
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      context = ctx;
      motion = options.motion?.() ?? undefined;
      parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
      unsubscribe = subscribeBackgroundState(state, refresh);
      refresh();
    },
    stop,
    refresh,
  };
}
