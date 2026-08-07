import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asRecord,
  baseDescription,
  codeSection,
  field,
  metadata,
  numberOf,
  sections,
  stringOf,
  summarySection,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMetadataEntry, DisplaySection, OperationalLifecycle, OperationalQualifier } from "./types";

function shellCommand(args: UnknownRecord): string | undefined {
  return stringOf(args.command);
}

function schemeCode(args: UnknownRecord): string | undefined {
  return stringOf(args.code);
}

function identityMetadata(name: string, args: UnknownRecord, details: UnknownRecord): DisplayMetadataEntry[] {
  if (name === "scheme") {
    return metadata([
      field("access", args.access ?? details.access),
      field("timeoutMs", args.timeoutMs),
      field("exit", details.exitCode),
      field("durationMs", details.durationMs),
    ]);
  }
  return metadata([
    field("timeout", args.timeout),
    field("timeoutMs", args.timeoutMs),
    field("cwd", args.cwd),
    field("exit", details.exitCode),
    field("durationMs", details.durationMs),
    field("flavor", details.flavor),
    field("version", details.version),
  ]);
}

/**
 * Status fields that carry actionable or diagnostic meaning: timeout,
 * abort, truncation, and PowerShell unavailability. Exit code, flavor, and
 * version already appear in the header identity metadata, so the Status
 * section surfaces only what the header does not.
 */
function statusFields(name: string, details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  return [
    numberOf(details.exitCode) !== undefined ? field("exit", details.exitCode, details.exitCode !== 0 ? "error" : undefined) : undefined,
    numberOf(details.durationMs) !== undefined ? field("duration", `${details.durationMs}ms`) : undefined,
    details.timedOut === true ? field("timeout", "yes", "warning") : undefined,
    details.aborted === true ? field("aborted", "yes", "warning") : undefined,
    details.truncated === true ? field("output", "truncated", "warning") : undefined,
    name === "pwsh" && details.unavailable === true ? field("unavailable", "yes", "error") : undefined,
  ];
}

function splitSchemeOutput(text: string): { stdout: string; stderr?: string } {
  const marker = "\n[stderr]\n";
  const index = text.indexOf(marker);
  if (index < 0) return { stdout: text };
  return { stdout: text.slice(0, index), stderr: text.slice(index + marker.length) };
}

/**
 * Derive an explicit lifecycle for the execution-family tools that share
 * this adapter (pwsh, scheme). Bash goes through a separate adapter path
 * (builtins.ts) with its own lifecycle; see builtinLifecycle there.
 *
 * Pwsh and scheme mark aborted results as isError (matching a genuine
 * failure), so the explicit aborted check must precede the isError check
 * to render the distinct × marker — the same override pattern already
 * used by pdf_search and CodeGraph.
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

function commandLanguage(name: string): string | undefined {
  if (name === "scheme") return "scheme";
  if (name === "pwsh") return "powershell";
  return "bash";
}

function commandSectionTitle(name: string): string {
  return name === "scheme" ? "Code" : "Command";
}

/**
 * Merge identity metadata on top of the base adapter's generic metadata,
 * replacing any duplicate labels. Prevents the same fields (exit,
 * durationMs, flavor, version) from appearing twice in the header.
 */
function mergeIdentity(
  base: readonly DisplayMetadataEntry[],
  fresh: readonly DisplayMetadataEntry[],
): DisplayMetadataEntry[] {
  const freshLabels = new Set(fresh.map((entry) => entry.label));
  return [...base.filter((entry) => !freshLabels.has(entry.label)), ...fresh].slice(0, 16);
}

function markCompact(section: DisplaySection | undefined): DisplaySection | undefined {
  return section && section.compact === false ? { ...section, compact: true } : section;
}

export function createExecutionAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      const source = asRecord(args);
      const command = name === "scheme" ? schemeCode(source) : shellCommand(source);
      const identMeta = identityMetadata(name, source, {});
      return baseDescription(description, {
        ...executionLifecycle(context, false, false, {}, "call"),
        metadata: mergeIdentity(description.metadata ?? [], identMeta),
        sections: sections(
          codeSection(commandSectionTitle(name), command, commandLanguage(name), false),
        ).map((section) => ({ ...section, compact: true })),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const isError = Boolean((result as { isError?: boolean }).isError);
      const text = textOf(result);
      const output = name === "scheme" ? splitSchemeOutput(text) : { stdout: text, stderr: stringOf(details.stderr) };
      const identMeta = identityMetadata(name, args, details);
      const reason = stringOf(details.reason) ?? stringOf(details.error);

      const statusSection = summarySection("Status", statusFields(name, details));
      const diagnostics = reason && reason !== text
        ? textSection("Diagnostics", reason, "warning")
        : undefined;
      const structured = sections(
        markCompact(codeSection(commandSectionTitle(name), name === "scheme" ? schemeCode(args) : shellCommand(args), commandLanguage(name), false)),
        markCompact(codeSection("Output", output.stdout, "text", false)),
        markCompact(codeSection("Stderr", output.stderr, "text", false)),
        statusSection,
        diagnostics,
      );
      const hasOutput = Boolean(output.stdout) || Boolean(output.stderr);

      return baseDescription(description, {
        ...executionLifecycle(context, options.isPartial, isError, details, "result"),
        metadata: mergeIdentity(description.metadata ?? [], identMeta),
        sections: options.expanded
          ? structured
          : structured.filter((section) => section.compact === true),
        // Structured sections (Command, Output, Stderr) carry the content;
        // the raw text preview would only duplicate them. When there's no
        // structured output (e.g. unavailable probe), the preview remains.
        preview: hasOutput || structured.some((s) => s.compact === true) ? undefined : description.preview,
        rows: [],
        // description.error (already set by the base adapter for isError
        // results) is the sole error carrier; a separate ERROR section
        // would only duplicate it.
      });
    },
  };
}
