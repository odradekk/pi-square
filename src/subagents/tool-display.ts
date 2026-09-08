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

export function toolDisplayFromArgs(toolName: string, args: any): ToolEventDisplay {
  // Activity renders tool identity plus structurally safe metadata only.
  // Every free-form argument value — a path, pattern, query, command, or
  // identifier — is omitted: any model-authored string can carry a
  // credential, so no bounded projection of it can be safe to display.
  let summary = "called";
  switch (toolName) {
    case "read": {
      const offset = args?.offset;
      const limit = args?.limit;
      if (Number.isFinite(offset) || Number.isFinite(limit)) {
        const start = Number.isFinite(offset) ? offset : 1;
        const end = Number.isFinite(limit) ? start + limit - 1 : undefined;
        summary = `lines ${start}${end !== undefined && end >= start ? `-${end}` : ""}`;
      }
      break;
    }
    case "web_search": {
      const queries = Array.isArray(args?.queries) ? args.queries : [];
      summary = `${queries.length} quer${queries.length === 1 ? "y" : "ies"}`;
      break;
    }
    case "web_fetch": {
      const urls = Array.isArray(args?.urls) ? args.urls : [];
      summary = `${urls.length} URL${urls.length === 1 ? "" : "s"}`;
      break;
    }
    default:
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

  // Legacy and free-form entries carry arbitrary text: only a bounded
  // tool-name-shaped head renders, never the remainder.
  const colon = /^([A-Za-z0-9_.-]+):/.exec(original);
  if (colon) return { tool: clipInline(colon[1], 64) || "tool", summary: "called" };
  const spaced = /^([A-Za-z0-9_.-]+)\s/.exec(original);
  if (spaced) return { tool: clipInline(spaced[1], 64) || "tool", summary: "called" };
  if (/^[A-Za-z0-9_.-]+$/.test(original)) {
    return { tool: clipInline(original, 64) || "tool", summary: "called" };
  }
  return { tool: "tool", summary: "called" };
}

export function latestToolCallSummary(
  timeline: SubagentTimelineItem[] | undefined,
  fallback = "working",
): string {
  const item = [...(timeline ?? [])].reverse().find((entry) => entry?.kind === "tool" && entry.phase === "start");
  if (!item) return fallback;
  const display = toolEventDisplay(item);
  return `${display.tool}${display.summary ? ` ${display.summary}` : ""}`;
}
