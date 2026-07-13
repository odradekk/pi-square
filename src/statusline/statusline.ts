import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitSnapshot, StatuslineState } from "./types.ts";

const GAUGE_WIDTH = 16;

const THINKING_COLORS: Record<string, [string, string]> = {
  off: ["thinkingOff", "muted"],
  minimal: ["thinkingMinimal", "dim"],
  low: ["thinkingLow", "dim"],
  medium: ["thinkingMedium", "success"],
  high: ["thinkingHigh", "accent"],
  xhigh: ["thinkingXhigh", "warning"],
};

export function updateLastUsage(state: StatuslineState, message: any): void {
  if (message?.role !== "assistant" || !message.usage) return;
  state.lastUsage = {
    input: message.usage.input ?? 0,
    output: message.usage.output ?? 0,
    cacheRead: message.usage.cacheRead ?? 0,
  };
}

function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function thinkingForeground(theme: any, pair: [string, string], text: string): string {
  const primary = theme.fg(pair[0], text);
  return primary !== text ? primary : theme.fg(pair[1], text);
}

function gaugeColor(percent: number): string {
  if (percent <= 50) return "success";
  if (percent <= 75) return "warning";
  return "error";
}

function renderGauge(theme: any, percent: number | null): string {
  if (percent === null || percent === undefined) {
    return theme.fg("dim", "─".repeat(GAUGE_WIDTH)) + " " + theme.fg("muted", "—");
  }

  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * GAUGE_WIDTH);
  const color = gaugeColor(clamped);
  return (
    theme.fg(color, "━".repeat(filled)) +
    theme.fg("dim", "─".repeat(GAUGE_WIDTH - filled)) +
    " " +
    theme.fg(color, `${clamped.toFixed(1)}%`)
  );
}

function cacheHitPercent(usage: { input: number; output: number; cacheRead: number }): number {
  const totalPromptTokens = usage.input + usage.cacheRead;
  if (totalPromptTokens <= 0) return 0;
  return Math.round((usage.cacheRead / totalPromptTokens) * 100);
}

function cacheHitColor(percent: number): string {
  if (percent >= 60) return "success";
  if (percent > 0) return "warning";
  return "dim";
}

function renderTokens(
  theme: any,
  separator: string,
  usage: { input: number; output: number; cacheRead: number } | null,
): string {
  if (!usage) return theme.fg("dim", "↑— ↓— ◇— ◌—");

  const hitPercent = cacheHitPercent(usage);
  const hitColor = cacheHitColor(hitPercent);
  return [
    theme.fg("toolTitle", "↑ ") + theme.fg("text", formatCount(usage.input)),
    theme.fg("accent", "↓ ") + theme.fg("text", formatCount(usage.output)),
    theme.fg("success", "◇ ") + theme.fg("text", formatCount(usage.cacheRead)),
    theme.fg(hitColor, "◌ ") + theme.fg(hitColor, `${hitPercent}%`),
  ].join(separator);
}

function renderProjectContext(theme: any, cwd: string, git: GitSnapshot): string {
  const directory = theme.fg("text", basename(cwd));
  if (!git.branch) return directory;

  const branch = theme.fg("accent", git.branch);
  if (!git.dirty) return directory + theme.fg("dim", ":") + branch + " " + theme.fg("success", "✓");

  const changes: string[] = [];
  if (git.staged > 0) changes.push(theme.fg("success", `+${git.staged}`));
  if (git.unstaged > 0) changes.push(theme.fg("warning", `~${git.unstaged}`));
  if (git.untracked > 0) changes.push(theme.fg("dim", `?${git.untracked}`));
  return directory + theme.fg("dim", ":") + branch + " " + changes.join(theme.fg("dim", "/"));
}

export function renderStatuslineContent(
  theme: any,
  width: number,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  state: StatuslineState,
): string {
  const outerSeparator = theme.fg("borderMuted", " │ ");
  const innerSeparator = theme.fg("borderMuted", " · ");
  const project = renderProjectContext(theme, state.cwd, state.git);

  const modelName = state.currentModelName || state.currentModelId || "—";
  const thinking = pi.getThinkingLevel();
  const colorPair = THINKING_COLORS[thinking] ?? THINKING_COLORS.off;
  const identity = theme.fg("text", modelName) + innerSeparator + thinkingForeground(theme, colorPair, thinking);

  const contextPercent = ctx.getContextUsage()?.percent ?? null;
  const gauge = renderGauge(theme, contextPercent);
  const tokens = renderTokens(theme, innerSeparator, state.lastUsage);

  const full = project + outerSeparator + identity + outerSeparator + gauge + outerSeparator + tokens;
  if (visibleWidth(full) <= width) return truncateToWidth(full, width);

  const wide = project + outerSeparator + identity + outerSeparator + gauge;
  if (visibleWidth(wide) <= width) return truncateToWidth(wide, width);

  const medium = project + outerSeparator + identity;
  if (visibleWidth(medium) <= width) return truncateToWidth(medium, width);

  return truncateToWidth(identity, width);
}

export function installStatusline(ctx: ExtensionContext, pi: ExtensionAPI, state: StatuslineState): void {
  ctx.ui.setFooter((tui: any, theme: any) => {
    state.tuiRef = tui;
    return {
      dispose() {
        if (state.tuiRef === tui) state.tuiRef = null;
      },
      invalidate() {},
      render(width: number): string[] {
        try {
          return [renderStatuslineContent(theme, width, ctx, pi, state)];
        } catch {
          return [truncateToWidth(theme.fg("dim", "—"), width)];
        }
      },
    };
  });
}
