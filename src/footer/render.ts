import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EnhancedFooterSnapshot } from "./data";
import { sanitizeDisplayLine } from "../display/sanitize";

const WIDE_WIDTH = 100;
const MEDIUM_WIDTH = 64;
const SUBAGENT_STATUS_KEY = "pi-square.subagents";
const THINKING_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

export function formatFooterTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatFooterCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome = relativeToHome === ""
    || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function clean(value: unknown): string {
  return sanitizeDisplayLine(value).replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

function divider(theme: Theme): string {
  return theme.fg("borderMuted", " │ ");
}

function dot(theme: Theme): string {
  return theme.fg("dim", " · ");
}

function alignWithRightPriority(left: string, right: string, width: number): string {
  const safeWidth = Math.max(1, width);
  if (!right) return truncateToWidth(left, safeWidth, "...");
  const rightWidth = visibleWidth(right);
  if (!left || rightWidth + 2 >= safeWidth) return truncateToWidth(right, safeWidth, "...");
  const availableLeft = safeWidth - rightWidth - 2;
  const fittedLeft = truncateToWidth(left, availableLeft, "...");
  const padding = Math.max(2, safeWidth - visibleWidth(fittedLeft) - rightWidth);
  return `${fittedLeft}${" ".repeat(padding)}${right}`;
}

function projectName(cwd: string): string {
  return basename(cwd) || cwd || "/";
}

function projectSide(theme: Theme, snapshot: EnhancedFooterSnapshot, wide: boolean): string {
  const path = wide
    ? clean(formatFooterCwd(snapshot.cwd, process.env.HOME || process.env.USERPROFILE))
    : clean(projectName(snapshot.cwd));
  const parts = [theme.fg("accent", path)];
  if (snapshot.branch) parts.push(theme.fg("muted", clean(snapshot.branch)));
  if (wide && snapshot.sessionName) parts.push(theme.fg("muted", clean(snapshot.sessionName)));
  return parts.join(dot(theme));
}

function thinkingText(theme: Theme, snapshot: EnhancedFooterSnapshot, includeLabel: boolean): string {
  if (!snapshot.reasoning) return "";
  const level = (snapshot.thinkingLevel || "off").toLowerCase();
  const text = includeLabel && level === "off" ? "THINKING OFF" : level.toUpperCase();
  return theme.fg(THINKING_COLORS[level] ?? "muted", text);
}

function modelSide(theme: Theme, snapshot: EnhancedFooterSnapshot, wide: boolean): string {
  const identity = wide && snapshot.showProvider && snapshot.provider
    ? `${theme.fg("muted", clean(snapshot.provider))}${theme.fg("dim", " / ")}${theme.fg("text", clean(snapshot.modelName))}`
    : theme.fg("text", clean(snapshot.modelName));
  const thinking = thinkingText(theme, snapshot, true);
  return thinking ? `${identity}${dot(theme)}${thinking}` : identity;
}

function tokenUsage(theme: Theme, snapshot: EnhancedFooterSnapshot): string {
  const parts: string[] = [];
  if (snapshot.usage.input > 0) parts.push(`${theme.fg("muted", "↑")}${theme.fg("text", formatFooterTokens(snapshot.usage.input))}`);
  if (snapshot.usage.output > 0) parts.push(`${theme.fg("muted", "↓")}${theme.fg("text", formatFooterTokens(snapshot.usage.output))}`);
  return parts.join("  ");
}

function cacheUsage(theme: Theme, snapshot: EnhancedFooterSnapshot, compact: boolean): string {
  if (snapshot.usage.cacheRead <= 0 && snapshot.usage.cacheWrite <= 0) return "";
  const parts: string[] = [];
  if (!compact) parts.push(theme.fg("muted", "Cache"));
  if (snapshot.usage.cacheRead > 0) parts.push(theme.fg("text", `R${formatFooterTokens(snapshot.usage.cacheRead)}`));
  if (snapshot.usage.cacheWrite > 0) parts.push(theme.fg("text", `W${formatFooterTokens(snapshot.usage.cacheWrite)}`));
  if (snapshot.usage.latestCacheHitRate !== undefined) {
    parts.push(theme.fg("muted", `${snapshot.usage.latestCacheHitRate.toFixed(0)}%`));
  }
  return parts.join(" ");
}

function costUsage(theme: Theme, snapshot: EnhancedFooterSnapshot): string {
  if (snapshot.usage.cost <= 0 && !snapshot.subscription) return "";
  const suffix = snapshot.subscription ? " (sub)" : "";
  return theme.fg("muted", `$${snapshot.usage.cost.toFixed(3)}${suffix}`);
}

function contextColor(percent: number | null): ThemeColor {
  if (percent !== null && percent > 90) return "error";
  if (percent !== null && percent > 70) return "warning";
  return "accent";
}

function contextUsage(
  theme: Theme,
  snapshot: EnhancedFooterSnapshot,
  barWidth: number,
  showWindow: boolean,
): string {
  const percent = snapshot.contextPercent;
  const bounded = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((bounded / 100) * barWidth);
  const color = contextColor(percent);
  const bar = theme.fg(color, `${"━".repeat(filled)}${theme.fg("borderMuted", "─".repeat(barWidth - filled))}`);
  const percentText = percent === null ? "?" : `${percent.toFixed(0)}%`;
  const window = showWindow && snapshot.contextWindow > 0
    ? theme.fg("dim", ` / ${formatFooterTokens(snapshot.contextWindow)}`)
    : "";
  return `${theme.fg("muted", "Context")} ${bar} ${theme.fg(color, percentText)}${window}`;
}

function usageSide(theme: Theme, snapshot: EnhancedFooterSnapshot, wide: boolean): string {
  const groups = [
    tokenUsage(theme, snapshot),
    cacheUsage(theme, snapshot, !wide),
    costUsage(theme, snapshot),
  ].filter(Boolean);
  return groups.join(divider(theme));
}

function sanitizeExternalStatus(text: string): string {
  return clean(text);
}

function statusLine(theme: Theme, snapshot: EnhancedFooterSnapshot, width: number): string | undefined {
  if (snapshot.statuses.length === 0) return undefined;
  const ordered = [...snapshot.statuses].sort((left, right) => {
    if (left.key === SUBAGENT_STATUS_KEY) return -1;
    if (right.key === SUBAGENT_STATUS_KEY) return 1;
    return left.key.localeCompare(right.key);
  });
  const statuses = ordered
    .map((status) => status.key === SUBAGENT_STATUS_KEY
      ? status.text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()
      : theme.fg("muted", sanitizeExternalStatus(status.text)))
    .filter(Boolean);
  if (statuses.length === 0) return undefined;
  return truncateToWidth(statuses.join(divider(theme)), Math.max(1, width), theme.fg("dim", "..."));
}

export function renderEnhancedFooter(
  theme: Theme,
  width: number,
  snapshot: EnhancedFooterSnapshot,
): string[] {
  const safeWidth = Math.max(1, width);
  const wide = safeWidth >= WIDE_WIDTH;
  const medium = safeWidth >= MEDIUM_WIDTH;

  const identity = theme.fg("toolTitle", theme.bold("π²"));
  const project = projectSide(theme, snapshot, wide);
  const first = alignWithRightPriority(
    `${identity}${divider(theme)}${project}`,
    modelSide(theme, snapshot, wide),
    safeWidth,
  );

  let second: string;
  if (medium) {
    second = alignWithRightPriority(
      usageSide(theme, snapshot, wide),
      contextUsage(theme, snapshot, wide ? 10 : 8, wide),
      safeWidth,
    );
  } else {
    const context = contextUsage(theme, snapshot, 6, false);
    const thinking = thinkingText(theme, snapshot, false);
    second = truncateToWidth(
      thinking ? `${context}${dot(theme)}${thinking}` : context,
      safeWidth,
      theme.fg("dim", "..."),
    );
  }

  const lines = [
    truncateToWidth(first, safeWidth, theme.fg("dim", "...")),
    truncateToWidth(second, safeWidth, theme.fg("dim", "...")),
  ];
  const status = statusLine(theme, snapshot, Math.max(1, safeWidth - 2));
  if (status) lines.push(truncateToWidth(`${theme.fg("warning", "!")} ${status}`, safeWidth, theme.fg("dim", "...")));
  return lines;
}
