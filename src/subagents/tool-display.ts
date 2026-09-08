import { catalogToolNames } from "../display/catalog";
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
    case "insert":
      summary = shortenPath(args?.path || "...");
      break;
    case "web_search": {
      const queries = Array.isArray(args?.queries) ? args.queries : [];
      summary = `${queries.length} quer${queries.length === 1 ? "y" : "ies"}: ${clipInline(queries[0] || "...", 50)}`;
      break;
    }
    case "web_fetch": {
      const urls = Array.isArray(args?.urls) ? args.urls : [];
      summary = `${urls.length} URL${urls.length === 1 ? "" : "s"}`;
      break;
    }
    case "library_search":
      summary = clipInline(args?.libraryName || "...", 60);
      break;
    case "library_docs":
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

/**
 * Closed vocabulary of tool identities a timeline entry may claim: Pi
 * built-ins and cataloged pi-square tools, whose names come from the tool
 * registries rather than model-authored text. A tool-name-shaped head in
 * arbitrary timeline text proves nothing and never displays as an identity.
 */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([...catalogToolNames(), "submit_shadow_result"]);

function isKnownTool(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(name);
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

function rosterToolEventDisplay(item: SubagentTimelineItem): ToolEventDisplay {
  const original = sanitizeSubagentDisplay(item.text).trim();
  const jsonCall = item.phase === "start"
    ? /^([A-Za-z0-9_.-]+)\s+(\{.*\})$/s.exec(original)
    : null;
  if (jsonCall) {
    const toolName = jsonCall[1] ?? "";
    if (!isKnownTool(toolName)) return { tool: "tool", summary: "called" };
    try {
      const args = JSON.parse(jsonCall[2] ?? "{}");
      if (toolName === "read") {
        const offset = args?.offset;
        const limit = args?.limit;
        if (Number.isFinite(offset) || Number.isFinite(limit)) {
          const start = Number.isFinite(offset) ? offset : 1;
          const end = Number.isFinite(limit) ? start + limit - 1 : undefined;
          return { tool: toolName, summary: `lines ${start}${end !== undefined && end >= start ? `-${end}` : ""}` };
        }
      }
      if (toolName === "web_search") {
        const count = Array.isArray(args?.queries) ? args.queries.length : 0;
        return { tool: toolName, summary: `${count} quer${count === 1 ? "y" : "ies"}` };
      }
      if (toolName === "web_fetch") {
        const count = Array.isArray(args?.urls) ? args.urls.length : 0;
        return { tool: toolName, summary: `${count} URL${count === 1 ? "" : "s"}` };
      }
      return { tool: toolName, summary: "called" };
    } catch {
      return { tool: toolName, summary: "called" };
    }
  }

  const head = /^([A-Za-z0-9_.-]+)(?=[\s:]|$)/.exec(original)?.[1];
  if (head === undefined || !isKnownTool(head)) return { tool: "tool", summary: "called" };
  const rest = original.slice(head.length).replace(/^[\s:]+/, "");
  if (head === "read") {
    const range = /:(\d+)(?:-(\d+))?$/.exec(rest);
    if (range) return { tool: head, summary: `lines ${range[1]}${range[2] ? `-${range[2]}` : ""}` };
  }
  const safeSummary = /^(?:\d+ quer(?:y|ies)|\d+ URLs?)/.exec(rest)?.[0];
  return { tool: head, summary: safeSummary ?? "called" };
}

/** Roster-only projection: trusted tool identity and structural counts/ranges. */
export function latestRosterToolCallSummary(
  timeline: SubagentTimelineItem[] | undefined,
  fallback = "working",
): string {
  const item = [...(timeline ?? [])].reverse().find((entry) => entry?.kind === "tool" && entry.phase === "start");
  if (!item) return fallback;
  const display = rosterToolEventDisplay(item);
  const summary = clipInline(display.summary, 120);
  return `${display.tool}${summary ? ` ${summary}` : ""}`;
}
