import { sanitizeSubagentDisplay } from "./display";
import type { SubagentTimelineItem } from "./types";

export interface ToolEventDisplay {
  tool: string;
  summary: string;
}

function clipInline(value: unknown, max: number): string {
  const clean = sanitizeSubagentDisplay(value).replace(/\s+/g, " ").trim();
  const codePoints = Array.from(clean);
  return codePoints.length <= max
    ? codePoints.join("")
    : `${codePoints.slice(0, Math.max(0, max - 3)).join("")}...`;
}

function shortenPath(value: unknown): string {
  return clipInline(value || ".", 48);
}

export function toolDisplayFromArgs(toolName: string, args: any): ToolEventDisplay {
  let summary: string;
  switch (toolName) {
    case "read": {
      const path = shortenPath(args?.path ?? args?.file_path ?? "...");
      const offset = args?.offset;
      const limit = args?.limit;
      if (typeof offset === "number" || typeof limit === "number") {
        const start = typeof offset === "number" ? offset : 1;
        const end = typeof limit === "number" ? start + limit - 1 : undefined;
        summary = `${path}:${start}${end ? `-${end}` : ""}`;
      } else summary = path;
      break;
    }
    case "grep":
      summary = `/${clipInline(args?.pattern || "...", 40)}/ in ${shortenPath(args?.path || ".")}`;
      break;
    case "find":
      summary = `${clipInline(args?.pattern || ".", 40)} in ${shortenPath(args?.path || ".")}`;
      break;
    case "pdf_search":
      summary = `${clipInline(args?.query || "...", 50)} in ${shortenPath(args?.path || "...")}`;
      break;
    case "ls":
      summary = shortenPath(args?.path || ".");
      break;
    case "bash":
    case "pwsh":
      summary = clipInline(args?.command, 80) || "called";
      break;
    case "edit":
    case "write":
    case "replace":
      summary = shortenPath(args?.path || "...");
      break;
    case "search": {
      const queries = Array.isArray(args?.queries) ? args.queries : [];
      summary = `${queries.length} quer${queries.length === 1 ? "y" : "ies"}: ${clipInline(queries[0] || "...", 50)}`;
      break;
    }
    case "fetch": {
      const urls = Array.isArray(args?.urls) ? args.urls : [];
      summary = `${urls.length} URL${urls.length === 1 ? "" : "s"}`;
      break;
    }
    case "libs":
      summary = clipInline(args?.libraryName || "...", 60);
      break;
    case "docs":
      summary = clipInline(args?.libraryId || "...", 60);
      break;
    default:
      summary = "called";
      break;
  }
  return {
    tool: clipInline(toolName, 64) || "tool",
    summary: clipInline(summary, 120),
  };
}

export function formatToolCall(toolName: string, args: any): string {
  const display = toolDisplayFromArgs(toolName, args);
  return `${display.tool}${display.summary ? ` ${display.summary}` : ""}`;
}

export function toolEventDisplay(item: SubagentTimelineItem): ToolEventDisplay {
  const original = sanitizeSubagentDisplay(item.text).trim();
  if (item.phase === "start") {
    const jsonCall = /^([A-Za-z0-9_.-]+)\s+(\{.*\})$/s.exec(original);
    if (jsonCall) {
      const toolName = jsonCall[1] ?? "tool";
      try {
        return toolDisplayFromArgs(toolName, JSON.parse(jsonCall[2] ?? "{}"));
      } catch {
        return { tool: clipInline(toolName, 64) || "tool", summary: "called" };
      }
    }
  }

  const colon = /^([A-Za-z0-9_.-]+):\s*(.*)$/s.exec(original);
  if (colon) return { tool: clipInline(colon[1], 64) || "tool", summary: clipInline(colon[2], 120) };
  const spaced = /^([A-Za-z0-9_.-]+)\s+(.*)$/s.exec(original);
  if (spaced) {
    const rawSummary = spaced[2] ?? "";
    return {
      tool: clipInline(spaced[1], 64) || "tool",
      summary: rawSummary.trimStart().startsWith("{") ? "called" : clipInline(rawSummary, 120),
    };
  }
  return { tool: clipInline(original, 64) || "tool", summary: "" };
}

export function latestToolCallSummary(timeline: SubagentTimelineItem[] | undefined): string {
  const item = [...(timeline ?? [])].reverse().find((entry) => entry?.kind === "tool" && entry.phase === "start");
  if (!item) return "working";
  const display = toolEventDisplay(item);
  return `${display.tool}${display.summary ? ` ${display.summary}` : ""}`;
}
