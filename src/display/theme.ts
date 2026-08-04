import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { DisplayStatus, DisplayTone } from "./types";

const TONE_TOKENS: Readonly<Record<DisplayTone, ThemeColor>> = Object.freeze({
  default: "toolOutput",
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
});

const STATUS_TOKENS: Readonly<Record<DisplayStatus, ThemeColor>> = Object.freeze({
  pending: "accent",
  partial: "accent",
  success: "success",
  warning: "warning",
  error: "error",
  aborted: "warning",
});

export function styleTone(theme: Theme, tone: DisplayTone | undefined, text: string): string {
  return theme.fg(TONE_TOKENS[tone ?? "default"], text);
}

export function styleStatus(theme: Theme, status: DisplayStatus, text: string): string {
  return theme.fg(STATUS_TOKENS[status], text);
}

export function styleTitle(theme: Theme, text: string): string {
  return theme.fg("toolTitle", theme.bold(text));
}

export function styleRule(theme: Theme, text: string): string {
  return theme.fg("borderMuted", text);
}

export function styleDiffLine(
  theme: Theme,
  kind: "added" | "removed" | "context" | "header",
  text: string,
  emphasize = false,
): string {
  const token: ThemeColor = kind === "added"
    ? "toolDiffAdded"
    : kind === "removed"
      ? "toolDiffRemoved"
      : kind === "header"
        ? "muted"
        : "toolDiffContext";
  const styled = emphasize ? theme.inverse(text) : text;
  return theme.fg(token, styled);
}
