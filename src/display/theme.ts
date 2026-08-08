import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
  DisplayTone,
  OperationalLifecycle,
  OperationalQualifier,
} from "./types";

const TONE_TOKENS: Readonly<Record<DisplayTone, ThemeColor>> = Object.freeze({
  default: "toolOutput",
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
});

// Lifecycle theme tokens — the canonical operational-state color contract.
// `aborted` uses the muted token because cancellation is a quiet terminal
// state rather than a failure; Pi exposes no muted-error token.
const LIFECYCLE_TOKENS: Readonly<Record<OperationalLifecycle, ThemeColor>> =
  Object.freeze({
    queued: "muted",
    pending: "accent",
    running: "accent",
    completed: "success",
    failed: "error",
    aborted: "muted",
  });

// Qualifier badge tokens. Action-critical qualifiers use the warning token so
// that required user action stays visible in a collapsed header.
const QUALIFIER_TOKENS: Readonly<Record<OperationalQualifier, ThemeColor>> =
  Object.freeze({
    warning: "warning",
    partial: "muted",
    retrying: "warning",
    cancelling: "warning",
    truncated: "warning",
    projected: "warning",
    "needs-input": "warning",
  });

export function operationalToken(
  lifecycle: OperationalLifecycle,
  qualifiers: readonly OperationalQualifier[],
): ThemeColor {
  if (lifecycle === "completed" && qualifiers.includes("warning")) return "warning";
  return LIFECYCLE_TOKENS[lifecycle];
}

export function styleOperational(
  theme: Theme,
  lifecycle: OperationalLifecycle,
  qualifiers: readonly OperationalQualifier[],
  text: string,
): string {
  return theme.fg(operationalToken(lifecycle, qualifiers), text);
}

export function styleTone(theme: Theme, tone: DisplayTone | undefined, text: string): string {
  return theme.fg(TONE_TOKENS[tone ?? "default"], text);
}

export function styleBadge(
  theme: Theme,
  qualifier: OperationalQualifier,
  text: string,
): string {
  return theme.fg(QUALIFIER_TOKENS[qualifier], text);
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
