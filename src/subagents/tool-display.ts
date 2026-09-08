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

/**
 * Closed vocabulary of tool identities a timeline entry may claim: Pi
 * built-ins and cataloged pi-square tools, whose names come from the tool
 * registries rather than model-authored text. A tool-name-shaped head in
 * arbitrary timeline text proves nothing and never displays as an identity.
 */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Pi built-ins (both shell names so a cross-platform timeline reparses).
  "read", "grep", "find", "ls", "edit", "write", "bash", "pwsh",
  // Anchored mutations.
  "replace", "insert",
  // Cataloged extension tools.
  "web_search", "web_fetch", "library_search", "library_docs",
  // Parent-only subagent tools and other pi-square model-callable tools.
  "delegate_subagent", "resume_subagent", "wait_subagent", "abort_subagent",
  "ask", "todo",
  // Shadow Minds' fixed child tool.
  "submit_shadow_result",
]);

/**
 * The closed summary grammar that survives a timeline reparse: only the
 * forms the producer emits from structured arguments (numeric line ranges
 * and counts). No free-form text passes.
 */
const SAFE_SUMMARY_PATTERN = /^(?:called|lines \d+(?:-\d+)?|\d+ quer(?:y|ies)|\d+ URLs?)$/;

function isKnownTool(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(name);
}

export function toolEventDisplay(item: SubagentTimelineItem): ToolEventDisplay {
  const original = sanitizeSubagentDisplay(item.text).trim();
  if (item.phase === "start") {
    const jsonCall = /^([A-Za-z0-9_.-]+)\s+(\{.*\})$/s.exec(original);
    if (jsonCall) {
      const toolName = jsonCall[1] ?? "";
      if (isKnownTool(toolName)) {
        try {
          return toolDisplayFromArgs(toolName, JSON.parse(jsonCall[2] ?? "{}"));
        } catch {
          // A malformed envelope falls through to the generic identity.
        }
      }
      return { tool: "tool", summary: "called" };
    }
  }

  // Free-form text: only a cataloged identity displays, and only the closed
  // numeric/count grammar survives as its summary. Everything else is the
  // fixed generic label, so arbitrary timeline text can never surface a
  // credential-shaped token as a tool identity or summary.
  const head = /^([A-Za-z0-9_.-]+)(?=[\s:]|$)/.exec(original)?.[1];
  if (head !== undefined && isKnownTool(head)) {
    const rest = original.slice(head.length).replace(/^[\s:]+/, "");
    return { tool: head, summary: SAFE_SUMMARY_PATTERN.test(rest) ? rest : "called" };
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
