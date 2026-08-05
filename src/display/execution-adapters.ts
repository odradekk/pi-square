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
import type { DisplayMetadataEntry } from "./types";

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

function summaryFields(name: string, details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  return [
    field("phase", details.phase),
    field("exit", details.exitCode),
    field("flavor", details.flavor),
    field("version", details.version),
    field("access", details.access),
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
      return baseDescription(description, {
        metadata: [...(description.metadata ?? []), ...identityMetadata(name, source, {})].slice(0, 16),
        sections: sections(
          summarySection(name === "scheme" ? "Access" : "Command", identityMetadata(name, source, {})),
          codeSection(name === "scheme" ? "Code" : "Command", command, name === "scheme" ? "scheme" : name === "pwsh" ? "powershell" : "bash", false),
        ).map((section) => ({ ...section, compact: true })),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const args = asRecord(context.args);
      const details = asRecord(result.details);
      const text = textOf(result);
      const output = name === "scheme" ? splitSchemeOutput(text) : { stdout: text, stderr: stringOf(details.stderr) };
      const error = stringOf(details.error)
        ?? stringOf(details.reason)
        ?? ((result as { isError?: boolean }).isError ? text : undefined);
      const structured = sections(
        textSection("Error", error, "error"),
        summarySection(name === "scheme" ? "Access" : "Command", identityMetadata(name, args, details)),
        summarySection("Status", summaryFields(name, details)),
        codeSection(name === "scheme" ? "Code" : "Command", name === "scheme" ? schemeCode(args) : shellCommand(args), name === "scheme" ? "scheme" : name === "pwsh" ? "powershell" : "bash", false),
        codeSection("Output", output.stdout, "text", false),
        codeSection("Stderr", output.stderr, "text", false),
        textSection("Diagnostics", stringOf(details.reason) ?? stringOf(details.error), "warning"),
      );
      return baseDescription(description, {
        metadata: [...(description.metadata ?? []), ...identityMetadata(name, args, details)].slice(0, 16),
        sections: structured,
        ...(options.expanded ? { preview: undefined } : {}),
      });
    },
  };
}
