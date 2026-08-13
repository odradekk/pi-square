import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asRecord,
  baseDescription,
  codeSection,
  numberOf,
  plural,
  sections,
  stringOf,
  textOf,
  type UnknownRecord,
} from "./adapter-utils";
import { DEFAULT_DISPLAY_POLICY } from "./types";
import type { DisplaySection, OperationalLifecycle, OperationalQualifier } from "./types";

// ── Text cleaning ──────────────────────────────────────────────────

/**
 * Strip the exit/timeout/abort status line that pwsh and bash append to
 * their own text output. The summary row already states the exit code.
 */
function stripStatusLine(text: string): string {
  return text
    .replace(/\n+Command exited with code \d+\s*$/, "")
    .replace(/\n+Command timed out after [\d.]+ seconds\s*$/, "")
    .replace(/\n+Command aborted\s*$/, "")
    .replace(/\n+Execution aborted\s*$/, "")
    .replace(/\n+Execution timed out after [\d.]+(?:ms|s)\s*$/, "")
    .replace(/\n+pwsh execution failed: .+$/s, "")
    .trimEnd();
}

// ── Summary builders ───────────────────────────────────────────────

/** Build the host token: `pwsh 7.6.4` or `powershell 5.1`. */
function hostToken(details: UnknownRecord): string | undefined {
  const flavor = stringOf(details.flavor);
  if (!flavor) return undefined;
  const display = flavor === "windows-powershell" ? "powershell" : flavor;
  const version = stringOf(details.version);
  return version ? `${display} ${version}` : display;
}

function formatTimeout(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function countLines(text: string): number {
  const trimmed = text.trimEnd();
  return trimmed ? trimmed.split("\n").length : 0;
}

/**
 * Build the C4 summary row for the execution tools. The suffix is the
 * host token for pwsh.
 */
function executionSummary(
  args: UnknownRecord,
  details: UnknownRecord,
  outputText: string,
  isError: boolean,
  isAborted: boolean,
  isTimedOut: boolean,
  exitCode: number | undefined,
  unavailable: boolean,
): string {
  if (unavailable) return "PowerShell is not installed";
  if (isAborted) return "Cancelled";
  if (isTimedOut) {
    const timeoutMs = numberOf(args.timeoutMs) ?? numberOf(details.timeoutMs) ?? 30_000;
    return `Timed out after ${formatTimeout(timeoutMs)}`;
  }
  const suffix = hostToken(details);
  if (isError && exitCode !== undefined && exitCode !== 0) {
    return suffix ? `Exited with code ${exitCode} · ${suffix}` : `Exited with code ${exitCode}`;
  }
  const lines = countLines(outputText);
  if (lines === 0) return suffix ? `No output · ${suffix}` : "No output";
  return suffix ? `${plural(lines, "line")} · ${suffix}` : plural(lines, "line");
}

// ── Lifecycle ──────────────────────────────────────────────────────

/**
 * Derive an explicit lifecycle for pwsh. Bash goes through a
 * separate adapter path (builtins.ts).
 *
 * Aborted results take precedence over isError to render the distinct
 * aborted marker.
 */
function executionLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean },
  isPartial: boolean,
  isError: boolean,
  details: UnknownRecord,
  phase: "call" | "result",
): { lifecycle: OperationalLifecycle; qualifiers?: readonly OperationalQualifier[] } {
  if (phase === "result") {
    if (isPartial) return { lifecycle: "running" };
    if (details.aborted === true) return { lifecycle: "aborted" };
    if (isError) return { lifecycle: "failed" };
    return { lifecycle: "completed", ...(details.truncated === true ? { qualifiers: ["truncated"] } : {}) };
  }
  if (context.executionStarted) return { lifecycle: "running" };
  if (context.argsComplete) return { lifecycle: "pending" };
  return { lifecycle: "queued" };
}

// ── Section helpers ────────────────────────────────────────────────

function commandLanguage(name: string): string {
  if (name === "pwsh") return "powershell";
  return "bash";
}

/**
 * Whether the Command section should appear in the expanded body.
 * pwsh shows the Command section only when the command is long enough
 * that the header likely truncated it.
 */
function shouldShowCommandSection(args: UnknownRecord): boolean {
  const command = stringOf(args.command);
  if (!command) return false;
  return command.length > 60 || command.includes("\n");
}

// ── Adapter ────────────────────────────────────────────────────────

export function createExecutionAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      return baseDescription(description, {
        ...executionLifecycle(context, false, false, {}, "call"),
        metadata: [],
        sections: [],
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const isError = Boolean((result as { isError?: boolean }).isError);
      const isAborted = details.aborted === true;
      const isTimedOut = details.timedOut === true;
      const unavailable = name === "pwsh" && details.unavailable === true;
      const exitCode = numberOf(details.exitCode);
      const durationMs = numberOf(details.durationMs);
      const rawText = textOf(result);

      // ── Clean the display text ───────────────────────────────────
      let displayText = stripStatusLine(rawText);

      const outputLines = countLines(displayText);
      const isTruncated = details.truncated === true
        || outputLines > DEFAULT_DISPLAY_POLICY.previewLines;

      // ── Summary row ──────────────────────────────────────────────
      const summary = executionSummary(
        args, details, displayText,
        isError, isAborted, isTimedOut, exitCode, unavailable,
      );

      // ── Lifecycle ────────────────────────────────────────────────
      const lc = executionLifecycle(context, options.isPartial, isError, details, "result");

      // ── Unavailable host ─────────────────────────────────────────
      if (unavailable) {
        const reason = stringOf(details.reason) ?? rawText;
        return baseDescription(description, {
          ...lc,
          metadata: [],
          error: "PowerShell is not installed",
          ...(reason && reason !== "PowerShell is not installed" ? { errorRaw: reason } : {}),
          summary: undefined,
          preview: undefined,
          sections: [],
          rows: [],
        });
      }

      // ── Collapsed body: tail-bounded preview ─────────────────────
      // ── Expanded body: Command + Output sections ─────────────────
      let expandedSections: DisplaySection[] = [];
      if (options.expanded) {
        const showCommand = shouldShowCommandSection(args);
        const cmd = showCommand
          ? codeSection(
            "Command",
            stringOf(args.command),
            commandLanguage(name),
            false,
          )
          : undefined;
        const outputSection = displayText
          ? codeSection("Output", displayText, "text", false)
          : undefined;
        expandedSections = sections(cmd, outputSection);
      }

      return baseDescription(description, {
        ...lc,
        metadata: [],
        durationMs,
        truncated: (isTruncated && !isAborted) || undefined,
        ...(options.expanded
          ? { sections: expandedSections, rows: [], preview: undefined }
          : displayText ? { preview: { text: displayText, tailOnly: true }, rows: [] } : { rows: [] }
        ),
        summary,
        // Clear error/errorRaw from the base adapter: the output IS
        // the result, the summary row states the exit code, and no
        // separate error sentence renders.
        error: undefined,
        errorRaw: undefined,
      });
    },
  };
}
