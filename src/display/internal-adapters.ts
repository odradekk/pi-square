import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { composeInternalSummary, formatDisplayPath, stringOf } from "./adapter-utils";
import { getCatalogEntry } from "./catalog";
import { createExecutionAdapter } from "./execution-adapters";
import { createRemoteAdapter } from "./remote-adapters";
import { createWorkflowAdapter } from "./workflow-adapters";
import { decorateToolDefinition, type DisplayRuntimeProvider, type InternalToolDisplayAdapter } from "./tool-renderer";
import type { DisplayFamily, DisplayMetadataEntry, OperationalLifecycle, OperationalQualifier } from "./types";

const ARG_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bash: ["command", "timeout"],
  pwsh: ["command", "cwd", "timeoutMs"],
  ssh: ["operation", "profile", "target", "label", "session", "command", "prompt", "cursor", "waitMs", "newline"],
  web_search: ["queries", "sites", "language", "country", "limit", "no_cache"],
  web_fetch: ["urls", "mode", "include_links", "describe_images", "max_tokens", "no_cache"],
  library_search: ["libraryName", "query", "mode", "limit"],
  library_docs: ["libraryId", "query", "mode", "kind", "max_tokens"],
  replace: ["path", "remove_from", "remove_to", "replacement_text"],
  insert: ["path", "anchor", "direction", "lines"],
  ask: ["questions"],
  todo: ["action", "id", "ids", "advance"],
  delegate_subagent: ["agent", "task", "cwd", "model", "thinkingLevel", "context"],
  resume_subagent: ["id", "task", "context"],
});

const TARGET_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bash: ["command"], pwsh: ["command"],
  ssh: ["operation"], web_search: ["queries"], web_fetch: ["urls"], library_search: ["libraryName"],
  library_docs: ["libraryId"], replace: ["path"], insert: ["path"],
  ask: [], todo: ["action"],
  delegate_subagent: ["agent"], resume_subagent: ["id"],
});

/** C1 sentence-case titles; unique within each family (`grep` is `Text search`). */
const TITLES: Readonly<Record<string, string>> = Object.freeze({
  bash: "Bash", pwsh: "PowerShell",
  ssh: "SSH", web_search: "Web search", web_fetch: "Web fetch", library_search: "Library search",
  library_docs: "Library docs", replace: "Replace", insert: "Insert",
  ask: "Questions", todo: "Tasks",
  delegate_subagent: "Subagent", resume_subagent: "Resume subagent",
});

/** Target fields that hold a local filesystem path and follow C2. */
const PATH_TARGET_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  replace: ["path"],
  insert: ["path"],
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown, maximum = 500): string {
  let text: string;
  if (Array.isArray(value)) text = value.map((item) => String(item)).join(", ");
  else if (value && typeof value === "object") text = JSON.stringify(value);
  else text = String(value ?? "");
  const points = Array.from(text.replace(/\s+/g, " ").trim());
  return points.length > maximum ? `${points.slice(0, maximum - 3).join("")}...` : points.join("");
}

function firstText(result: AgentToolResult<unknown>): string {
  return Array.isArray(result.content)
    ? result.content
      .filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof (item as { text?: unknown }).text === "string")
      .map((item) => item.text)
      .join("\n")
    : "";
}

function resolveResultLifecycle(
  result: AgentToolResult<unknown>,
  partial: boolean,
): { lifecycle: OperationalLifecycle; qualifiers: readonly OperationalQualifier[] } {
  if (partial) return { lifecycle: "running", qualifiers: ["partial"] };
  if ((result as AgentToolResult<unknown> & { isError?: boolean }).isError) return { lifecycle: "failed", qualifiers: [] };
  const details = record(result.details);
  const value = String(details.status ?? details.phase ?? "").toLowerCase();
  if (value === "error" || value === "failed") return { lifecycle: "failed", qualifiers: [] };
  if (value === "aborted" || value === "cancelled" || value === "canceled" || value === "declined") return { lifecycle: "aborted", qualifiers: [] };
  if (value === "warning" || value === "incomplete") return { lifecycle: "completed", qualifiers: ["warning"] };
  if (details.errorCode !== undefined && details.errorCode !== "") return { lifecycle: "failed", qualifiers: [] };
  return { lifecycle: "completed", qualifiers: [] };
}

function metadataForArgs(name: string, args: unknown): DisplayMetadataEntry[] {
  const source = record(args);
  const fields = ARG_FIELDS[name] ?? [];
  return fields.flatMap((key) => {
    if (!Object.hasOwn(source, key) || source[key] === undefined) return [];
    if (name === "ssh" && key === "prompt") return [{ label: key, value: "secure input requested", tone: "warning" as const }];
    if ((name === "bash" || name === "pwsh") && key === "command") return [];
    if ((name === "delegate_subagent" || name === "resume_subagent") && key === "task") return [];
    if (name === "ask" && key === "questions") {
      return [{ label: "questions", value: String(Array.isArray(source[key]) ? source[key].length : 0) }];
    }
    return [{ label: key, value: textValue(source[key], 180) }];
  });
}

function targetFor(name: string, args: unknown, cwd: string): { value?: string; isPath: boolean } {
  const source = record(args);
  const fields = TARGET_FIELDS[name] ?? [];
  for (const key of fields) {
    const raw = source[key];
    if (raw === undefined) continue;
    if ((PATH_TARGET_FIELDS[name] ?? []).includes(key) && typeof raw === "string" && raw) {
      // C2: a local path target is workspace-relative and elides in the middle.
      return { value: textValue(formatDisplayPath(raw, cwd), 160) || undefined, isPath: true };
    }
    const text = textValue(raw, 160);
    if (text) return { value: text, isPath: false };
  }
  return { isPath: false };
}

function callPreview(name: string, args: unknown): string | undefined {
  const source = record(args);
  if ((name === "bash" || name === "pwsh") && typeof source.command === "string") return source.command;
  if ((name === "delegate_subagent" || name === "resume_subagent") && typeof source.task === "string") return source.task;
  return undefined;
}

/**
 * C7 boundedness signals shared by the extension tools: an explicit
 * `truncated` flag, a truncation detail object (content budgets), a
 * truncated output or stderr stream, a paged result with more entries
 * available, and over-long truncated lines. Any of them raises the
 * `truncated` qualifier on the operational state; qualifiers refine the
 * state and never render header badges.
 */
function isBoundedResult(details: Record<string, unknown>): boolean {
  const truncation = record(details.truncation);
  const page = record(details.page);
  return details.truncated === true
    || truncation.truncated === true
    || truncation.contentBudgetReached === true
    || details.outputTruncated === true
    || details.stderrTruncated === true
    || details.hasMore === true
    || page.hasMore === true
    || (typeof details.truncatedLines === "number" && details.truncatedLines > 0);
}

function summaryRows(detailsValue: unknown): { rows: { text: string }[]; metadata: DisplayMetadataEntry[] } {
  const details = record(detailsValue);
  const rows: { text: string }[] = [];
  const metadata: DisplayMetadataEntry[] = [];
  const page = record(details.page);
  const counts = record(details.counts);
  const candidates: [string, unknown][] = [
    ["returned", page.returned ?? details.returned],
    ["total", page.total ?? details.total],
    ["status", details.status],
    ["phase", details.phase],
    ["code", details.code ?? details.errorCode],
    ["exit", details.exitCode],
  ];
  for (const [label, value] of candidates) {
    if (value !== undefined && value !== "") metadata.push({ label, value: textValue(value, 120) });
  }
  const countEntries = Object.entries(counts).slice(0, 8);
  if (countEntries.length > 0) rows.push({ text: countEntries.map(([key, value]) => `${key} ${textValue(value, 60)}`).join(" · ") });
  if (typeof details.message === "string" && details.message) rows.push({ text: textValue(details.message, 500) });
  if (rows.length === 0) {
    const returned = page.returned ?? details.returned;
    const phase = String(details.phase ?? details.status ?? "").toLowerCase();
    const terminal = ["success", "done", "completed", "ready"].includes(phase);
    const aborted = ["aborted", "cancelled", "canceled"].includes(phase);
    if (aborted) rows.push({ text: "Aborted" });
    else if (returned === 0) rows.push({ text: "No results" });
    else if (terminal || (!phase && returned !== undefined)) rows.push({ text: "Completed" });
  }
  return { rows, metadata };
}

function createAdapter(name: string, family: DisplayFamily): InternalToolDisplayAdapter<any, unknown, unknown> {
  const title = TITLES[name] ?? name;
  return {
    describeCall(args, context) {
      const preview = callPreview(name, args);
      const target = targetFor(name, args, context.cwd);
      const lifecycle: OperationalLifecycle = context.executionStarted
        ? "running"
        : context.argsComplete
          ? "pending"
          : "queued";
      return {
        version: 1,
        tool: name,
        family,
        lifecycle,
        title,
        target: target.value ?? (context.argsComplete ? undefined : "building arguments"),
        ...(target.isPath ? { targetKind: "path" as const } : {}),
        metadata: metadataForArgs(name, args),
        ...(preview ? { preview: { text: preview } } : {}),
      };
    },
    describeResult(result, options, context) {
      const text = firstText(result);
      const outcome = summaryRows(result.details);
      const lc = resolveResultLifecycle(result, options.isPartial);
      const details = record(result.details);
      const durationMs = typeof details.durationMs === "number" ? details.durationMs : undefined;
      const target = targetFor(name, context.args, context.cwd);
      const anchoredPath = record(context.args).path;
      const failed = (result as AgentToolResult<unknown> & { isError?: boolean }).isError === true;
      // C6: the error row states one human sentence; the raw platform text
      // moves to errorRaw and renders exactly once as an expanded ERROR section.
      const sentence = failed
        ? stringOf(details.error) ?? stringOf(details.message) ?? stringOf(text.split("\n", 1)[0]) ?? "Tool failed"
        : undefined;
      const outcomeSummary = failed ? undefined : composeInternalSummary(name, result.details, text);
      return {
        version: 1,
        tool: name,
        family,
        lifecycle: lc.lifecycle,
        ...(lc.qualifiers.length > 0 ? { qualifiers: lc.qualifiers } : {}),
        title,
        target: target.value,
        ...(target.isPath ? { targetKind: "path" as const } : {}),
        metadata: [...metadataForArgs(name, context.args), ...outcome.metadata],
        rows: outcome.rows,
        durationMs,
        ...(text ? { preview: { text } } : {}),
        ...((name === "replace" || name === "insert") && !failed && typeof details.diff === "string" && details.diff
          ? {
              diff: {
                path: typeof anchoredPath === "string" ? anchoredPath : undefined,
                patch: details.diff,
              },
            }
          : {}),
        ...(sentence ? { error: textValue(sentence, 2_000), ...(text && text !== sentence ? { errorRaw: text } : {}) } : {}),
        ...(outcomeSummary ? { summary: outcomeSummary } : {}),
        truncated: isBoundedResult(details),
      };
    },
  };
}

export function decorateInternalTool<T extends ToolDefinition<any, any, any>>(
  definition: T,
  runtime: DisplayRuntimeProvider,
): T {
  const entry = getCatalogEntry(definition.name);
  if (!entry) throw new Error(`Missing display catalog entry for '${definition.name}'`);
  const base = createAdapter(definition.name, entry.family);
  const adapter = definition.name === "bash" || definition.name === "pwsh"
    ? createExecutionAdapter(definition.name, base)
    : definition.name === "web_search"
        || definition.name === "web_fetch"
        || definition.name === "library_search"
        || definition.name === "library_docs"
        || definition.name === "ssh"
        ? createRemoteAdapter(definition.name, base)
        : definition.name === "ask"
          || definition.name === "todo"
          ? createWorkflowAdapter(definition.name, base)
          : base;
  return decorateToolDefinition(definition, runtime, adapter) as T;
}
