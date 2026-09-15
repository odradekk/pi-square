/** Manager-grade tool-activity projections: the wide, explicitly opt-in tier.
 *  Only manager surfaces import this module — the `/subagent` manager detail
 *  rows and the completion-message Activity section the display adapter
 *  builds. Every roster-grade surface (roster, viewer, live events, history
 *  paging) reads the default safe projection in `./tool-display`, which omits
 *  free-form argument values entirely; this module is the only place bounded
 *  free-form summaries (paths, patterns, commands, query text) are built. The
 *  import site declares the grade. */

import type { SubagentTimelineItem } from "./run-types";
import { clipInline, shortenPath, toolArgListCount, toolArgListFirst, type ToolEventDisplay } from "./tool-display";

/** Bounded summary for one call of a cataloged tool: free-form argument
 *  values render here (paths, patterns, commands) after sanitizing and
 *  clipping. Manager-grade only — every roster-grade surface uses the default
 *  safe projection `rosterToolArgsDisplay` instead; unknown tool names render
 *  as `called`. */
export function managerToolArgsDisplay(toolName: string, args: any): ToolEventDisplay {
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
      const count = toolArgListCount(args?.queries) ?? 0;
      summary = `${count} quer${count === 1 ? "y" : "ies"}: ${clipInline(toolArgListFirst(args?.queries) || "...", 50)}`;
      break;
    }
    case "web_fetch": {
      const count = toolArgListCount(args?.urls) ?? 0;
      summary = `${count} URL${count === 1 ? "" : "s"}`;
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

/** Bounded human line for one tool call, written into the timeline entry's
 *  `text` for run.json readability and `lastEvent`. Manager-grade, like the
 *  wide projection it builds on; display projections read the structured
 *  `tool`/`args` fields instead. */
export function managerToolCallText(toolName: string, args: any): string {
  const display = managerToolArgsDisplay(toolName, args);
  return `${display.tool}${display.summary ? ` ${display.summary}` : ""}`;
}

/** Manager-grade wide summary of the latest started tool call — the
 *  explicitly named opt-in read that free-form bounded summaries render
 *  through. Only manager surfaces (`/subagent` detail rows) may call this;
 *  every other surface uses the default `latestRosterToolCallSummary`. */
export function latestManagerToolCallSummary(timeline: SubagentTimelineItem[] | undefined): string {
  const item = [...(timeline ?? [])].reverse().find((entry) => entry?.kind === "tool" && entry.phase === "start");
  if (!item) return "working";
  const display = managerToolArgsDisplay(String(item.tool ?? ""), item.args);
  const summary = clipInline(display.summary, 120);
  return `${display.tool}${summary ? ` ${summary}` : ""}`;
}
