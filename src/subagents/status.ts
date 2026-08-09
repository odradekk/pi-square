import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { listBackgroundJobs, subscribeBackgroundState, type BackgroundState } from "./background";
import { sanitizeSubagentDisplay } from "./display";
import { latestToolCallSummary } from "./tool-display";
import type { BackgroundJobSnapshot } from "./types";

export const STALE_RUNNING_THRESHOLD_MS = 60 * 60 * 1000;

export function isStaleRunning(
  persisted: { phase?: string },
  mtimeMs: number,
  now: number = Date.now(),
): boolean {
  return persisted.phase === "running" && now - mtimeMs > STALE_RUNNING_THRESHOLD_MS;
}

export const SUBAGENT_STATUS_KEY = "pi-square.subagents";

const MAX_VISIBLE_JOBS = 2;
const MAX_CALL_WIDTH = 48;
const MAX_STATUS_WIDTH = 180;
const ACTIVE_STATUSES = new Set<BackgroundJobSnapshot["status"]>(["queued", "running", "cancelling"]);
const STATUS_PRIORITY: Record<"queued" | "running" | "cancelling", number> = {
  cancelling: 0,
  running: 1,
  queued: 2,
};

function shortId(id: string): string {
  return id.replace(/^subagent_/, "").slice(0, 8);
}

function activeJobs(jobs: BackgroundJobSnapshot[]): BackgroundJobSnapshot[] {
  return jobs
    .filter((job) => ACTIVE_STATUSES.has(job.status))
    .sort((left, right) => {
      const priority = STATUS_PRIORITY[left.status as keyof typeof STATUS_PRIORITY]
        - STATUS_PRIORITY[right.status as keyof typeof STATUS_PRIORITY];
      return priority || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    });
}

function statusText(theme: Theme, status: BackgroundJobSnapshot["status"]): string {
  if (status === "queued") return theme.fg("muted", "– queued");
  if (status === "cancelling") return theme.fg("warning", "× cancelling");
  return theme.fg("accent", "● running");
}

function jobText(theme: Theme, job: BackgroundJobSnapshot): string {
  const role = sanitizeSubagentDisplay(job.details.agent?.name ?? "generic").replace(/\s+/g, " ").trim() || "generic";
  const identity = theme.fg("accent", role) + theme.fg("dim", ` ${shortId(job.id)}`);
  const call = truncateToWidth(latestToolCallSummary(job.details.timeline), MAX_CALL_WIDTH, "...");
  return `${identity} ${statusText(theme, job.status)}${theme.fg("dim", " · ")}${theme.fg("text", call)}`;
}

export function renderNativeSubagentStatus(
  theme: Theme,
  jobs: BackgroundJobSnapshot[],
): string | undefined {
  const active = activeJobs(jobs);
  if (active.length === 0) return undefined;

  const separator = theme.fg("dim", " │ ");
  const parts = [theme.fg("muted", `subagents ${active.length}`)];
  for (const job of active.slice(0, MAX_VISIBLE_JOBS)) parts.push(jobText(theme, job));
  if (active.length > MAX_VISIBLE_JOBS) parts.push(theme.fg("dim", `+${active.length - MAX_VISIBLE_JOBS}`));

  return truncateToWidth(parts.join(separator), MAX_STATUS_WIDTH, theme.fg("dim", "..."));
}

export interface NativeSubagentStatusController {
  start(ctx: ExtensionContext): void;
  stop(): void;
  refresh(): void;
}

export function createNativeSubagentStatusController(
  state: BackgroundState,
): NativeSubagentStatusController {
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;

  const refresh = () => {
    if (!context?.hasUI) return;
    const jobs = listBackgroundJobs(state);
    context.ui.setStatus(
      SUBAGENT_STATUS_KEY,
      renderNativeSubagentStatus(context.ui.theme, jobs),
    );
  };

  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (context?.hasUI) context.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
    context = undefined;
  };

  return {
    start(ctx) {
      stop();
      context = ctx;
      if (!ctx.hasUI) return;
      unsubscribe = subscribeBackgroundState(state, refresh);
      refresh();
    },
    stop,
    refresh,
  };
}
