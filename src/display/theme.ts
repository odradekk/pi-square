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
    pending: "muted",
    running: "accent",
    completed: "success",
    failed: "error",
    aborted: "muted",
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

const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

/**
 * Running pulse: a slow three-level brightness wave on the accent token. The
 * marker never disappears; ANSI dim approximates the 45% brightness floor and
 * bold forms the bright crest. The caller enables this only for color-capable
 * full-motion sessions, so reduced/off/no-color output stays static.
 */
export function styleRunningPulse(theme: Theme, text: string, phase: number): string {
  // Minimal test doubles may implement only fg(); they receive the static
  // running marker rather than raw ANSI pulse codes.
  if (typeof theme.getFgAnsi !== "function") return theme.fg("accent", text);
  const color = theme.getFgAnsi("accent");
  const normalized = ((phase % 1) + 1) % 1;
  const wave = (1 - Math.cos(normalized * Math.PI * 2)) / 2;
  if (wave < 0.34) return `${color}${ANSI_DIM}${text}${ANSI_RESET}`;
  if (wave > 0.82) return `${color}${ANSI_BOLD}${text}${ANSI_RESET}`;
  return `${color}${text}${ANSI_RESET}`;
}

export function styleTone(theme: Theme, tone: DisplayTone | undefined, text: string): string {
  return theme.fg(TONE_TOKENS[tone ?? "default"], text);
}

export function styleTitle(theme: Theme, text: string): string {
  // State-only hue: tool titles move to the neutral text token so color
  // marks operational state only (marker and diff added/removed lines).
  return theme.fg("text", theme.bold(text));
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
