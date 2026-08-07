import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCatalogEntry } from "./catalog";
import { createExecutionAdapter } from "./execution-adapters";
import { createRemoteAdapter } from "./remote-adapters";
import { createWorkflowAdapter } from "./workflow-adapters";
import { createSearchAdapter } from "./search-adapters";
import { decorateToolDefinition, type DisplayRuntimeProvider, type InternalToolDisplayAdapter } from "./tool-renderer";
import type { DisplayFamily, DisplayMetadataEntry, DisplayStatus } from "./types";

const ARG_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  rg: ["pattern", "path", "case", "literal", "word", "offset", "limit"],
  fd: ["pattern", "path", "matchMode", "offset", "limit", "maxDepth"],
  sg: ["pattern", "kind", "path", "language", "selector", "strictness", "offset", "limit"],
  pdf_search: ["path", "query", "limit"],
  codegraph: ["operation", "projectPath", "query", "maxFiles"],
  time: [],
  bash: ["command", "timeout"],
  pwsh: ["command", "cwd", "timeoutMs"],
  scheme: ["access", "timeoutMs", "code"],
  ssh: ["operation", "profile", "target", "label", "session", "command", "prompt", "cursor", "waitMs", "newline"],
  search: ["queries", "sites", "language", "country", "limit", "no_cache"],
  fetch: ["urls", "mode", "include_links", "describe_images", "max_tokens", "no_cache"],
  libs: ["libraryName", "query", "mode", "limit"],
  docs: ["libraryId", "query", "mode", "kind", "max_tokens"],
  parse: ["path", "pages", "mode", "max_tokens", "timeout"],
  github_search: ["kind", "query", "page", "limit"],
  github_read: ["repo", "path", "ref", "line", "limit"],
  github_tree: ["repo", "path", "ref", "depth", "offset", "limit"],
  github_commit: ["repo", "ref", "page", "limit"],
  ask: ["questions"],
  todo: ["action", "id", "ids", "advance"],
  subagent_delegate: ["agent", "mode", "task", "cwd", "model", "thinkingLevel", "context"],
  subagent_resume: ["id", "task", "context"],
});

const TARGET_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  rg: ["pattern"], fd: ["pattern"], sg: ["pattern", "kind"], pdf_search: ["query"],
  codegraph: ["operation"], bash: ["command"], pwsh: ["command"], scheme: ["access"],
  ssh: ["operation"], search: ["queries"], fetch: ["urls"], libs: ["libraryName"],
  docs: ["libraryId"], parse: ["path"], github_search: ["query"], github_read: ["path"],
  github_tree: ["path"], github_commit: ["ref"], ask: [], todo: ["action"],
  subagent_delegate: ["agent"], subagent_resume: ["id"],
});

const TITLES: Readonly<Record<string, string>> = Object.freeze({
  rg: "Text search", fd: "File search", sg: "Structure search", pdf_search: "PDF search",
  codegraph: "CodeGraph", time: "Local time", bash: "$ ❯", pwsh: "PS ❯",
  scheme: "λ ❯", ssh: "SSH", search: "Web search", fetch: "Web fetch", libs: "Library search",
  docs: "Documentation", parse: "PDF parse", github_search: "GitHub search", github_read: "GitHub read",
  github_tree: "GitHub tree", github_commit: "GitHub commit", ask: "Questions", todo: "Tasks",
  subagent_delegate: "Subagent", subagent_resume: "Resume subagent",
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

function statusFor(result: AgentToolResult<unknown>, partial: boolean): DisplayStatus {
  if (partial) return "partial";
  if ((result as AgentToolResult<unknown> & { isError?: boolean }).isError) return "error";
  const details = record(result.details);
  const value = String(details.status ?? details.phase ?? "").toLowerCase();
  if (value === "error" || value === "failed") return "error";
  if (value === "aborted" || value === "cancelled" || value === "canceled") return "aborted";
  if (value === "warning" || value === "incomplete") return "warning";
  return "success";
}

function metadataForArgs(name: string, args: unknown): DisplayMetadataEntry[] {
  const source = record(args);
  return (ARG_FIELDS[name] ?? []).flatMap((key) => {
    if (!Object.hasOwn(source, key) || source[key] === undefined) return [];
    if (name === "ssh" && key === "prompt") return [{ label: key, value: "secure input requested", tone: "warning" as const }];
    if ((name === "bash" || name === "pwsh") && key === "command") return [];
    if (name === "scheme" && key === "code") return [];
    if ((name === "subagent_delegate" || name === "subagent_resume") && key === "task") return [];
    if (name === "ask" && key === "questions") {
      return [{ label: "questions", value: String(Array.isArray(source[key]) ? source[key].length : 0) }];
    }
    return [{ label: key, value: textValue(source[key], 180) }];
  });
}

function targetFor(name: string, args: unknown): string | undefined {
  const source = record(args);
  for (const key of TARGET_FIELDS[name] ?? []) {
    if (source[key] !== undefined) return textValue(source[key], 160) || undefined;
  }
  return undefined;
}

function callPreview(name: string, args: unknown): string | undefined {
  const source = record(args);
  if ((name === "bash" || name === "pwsh") && typeof source.command === "string") return source.command;
  if (name === "scheme" && typeof source.code === "string") return source.code;
  if ((name === "subagent_delegate" || name === "subagent_resume") && typeof source.task === "string") return source.task;
  return undefined;
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
    if (returned === 0) rows.push({ text: "No results" });
    else if (terminal || (!phase && returned !== undefined)) rows.push({ text: "Completed" });
  }
  return { rows, metadata };
}

function createAdapter(name: string, family: DisplayFamily): InternalToolDisplayAdapter<any, unknown, unknown> {
  const title = TITLES[name] ?? name;
  return {
    describeCall(args, context) {
      const preview = callPreview(name, args);
      return {
        version: 1,
        tool: name,
        family,
        status: "pending",
        title,
        target: targetFor(name, args) ?? (context.argsComplete ? undefined : "building arguments"),
        metadata: metadataForArgs(name, args),
        ...(preview ? { preview: { text: preview } } : {}),
      };
    },
    describeResult(result, options, context) {
      const text = firstText(result);
      const summary = summaryRows(result.details);
      const status = statusFor(result, options.isPartial);
      const details = record(result.details);
      const durationMs = typeof details.durationMs === "number" ? details.durationMs : undefined;
      return {
        version: 1,
        tool: name,
        family,
        status,
        title,
        target: targetFor(name, context.args),
        metadata: [...metadataForArgs(name, context.args), ...summary.metadata],
        rows: summary.rows,
        durationMs,
        ...(text ? { preview: { text } } : {}),
        ...((result as AgentToolResult<unknown> & { isError?: boolean }).isError
          ? { error: text || textValue(details.error ?? details.message ?? "Tool failed", 2_000) }
          : {}),
        truncated: Boolean(details.truncated || record(details.truncation).truncated),
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
  const adapter = definition.name === "rg"
    || definition.name === "fd"
    || definition.name === "sg"
    || definition.name === "pdf_search"
    || definition.name === "codegraph"
    ? createSearchAdapter(definition.name, base)
    : definition.name === "bash" || definition.name === "pwsh" || definition.name === "scheme"
      ? createExecutionAdapter(definition.name, base)
      : definition.name === "search"
        || definition.name === "fetch"
        || definition.name === "libs"
        || definition.name === "docs"
        || definition.name === "parse"
        || definition.name === "github_search"
        || definition.name === "github_read"
        || definition.name === "github_tree"
        || definition.name === "github_commit"
        || definition.name === "ssh"
        ? createRemoteAdapter(definition.name, base)
        : definition.name === "ask" || definition.name === "todo" || definition.name === "time"
          ? createWorkflowAdapter(definition.name, base)
          : base;
  return decorateToolDefinition(definition, runtime, adapter) as T;
}
