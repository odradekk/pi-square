import { catalogToolNames } from "../display/catalog";
import { sanitizeSubagentDisplay } from "./display";
import type { SubagentTimelineItem } from "./run-types";

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

// ─── Construction-point sanitizing ─────────────────────────────────

/** Codepoints kept per string argument value. The widest summary read is the
 *  80-codepoint command, so 200 leaves every projection its full input. */
const MAX_TOOL_ARG_STRING = 200;
/** Nesting depth for argument containers. */
const MAX_TOOL_ARG_DEPTH = 4;
/** Object entries kept per container level. */
const MAX_TOOL_ARG_KEYS = 32;
/** Array items kept per container level. */
const MAX_TOOL_ARG_ITEMS = 32;
/** Total characters kept across one entry's arguments. */
const MAX_TOOL_ARG_TOTAL = 1600;

interface SanitizeBudget {
  chars: number;
}

function sanitizeArgValue(value: unknown, depth: number, budget: SanitizeBudget): unknown {
  if (budget.chars <= 0) return undefined;
  if (typeof value === "string") {
    const clean = sanitizeSubagentDisplay(value);
    const codePoints = Array.from(clean);
    const clipped = codePoints.length <= MAX_TOOL_ARG_STRING
      ? clean
      : `${codePoints.slice(0, MAX_TOOL_ARG_STRING).join("")}...`;
    budget.chars -= clipped.length;
    return clipped;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  if (depth >= MAX_TOOL_ARG_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_TOOL_ARG_ITEMS)) {
      if (budget.chars <= 0) break;
      const cleaned = sanitizeArgValue(item, depth + 1, budget);
      if (cleaned !== undefined) out.push(cleaned);
    }
    return Object.freeze(out);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_TOOL_ARG_KEYS)) {
      if (budget.chars <= 0) break;
      const cleaned = sanitizeArgValue(entry, depth + 1, budget);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.freeze(out);
  }
  return undefined;
}

/** Deep-clean one tool-call argument payload into the structured, bounded
 *  fields a timeline entry persists. Strings pass the shared display
 *  sanitizer; finite numbers and booleans keep their type; containers stay
 *  within fixed depth/entry budgets; one shared character budget prunes the
 *  remainder deterministically. The result is frozen: the run record's
 *  update snapshots share this object by reference across shallow clones.
 *  This is the single construction point for stored tool activity — every
 *  projection reads these fields and never re-parses rendered text. */
export function sanitizeToolActivityArgs(args: unknown): Record<string, unknown> {
  const budget: SanitizeBudget = { chars: MAX_TOOL_ARG_TOTAL };
  if (!args || typeof args !== "object" || Array.isArray(args)) return Object.freeze({});
  const cleaned = sanitizeArgValue(args, 0, budget);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) return Object.freeze({});
  return cleaned as Record<string, unknown>;
}

// ─── Manager-grade wide projection (explicit opt-in) ───────────────

/** Bounded summary for one call of a cataloged tool: free-form argument
 *  values render here (paths, patterns, commands) after sanitizing and
 *  clipping. This is the WIDE projection, for manager-grade surfaces only —
 *  the `/subagent` manager detail rows and the completion-message Activity
 *  section. Every roster-grade surface uses the default safe projection
 *  `rosterToolArgsDisplay` instead; unknown tool names render as `called`. */
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

/** Bounded human line for one tool call, written into the timeline entry's
 *  `text` for run.json readability and `lastEvent`. Manager-grade, like the
 *  wide projection it builds on; display projections read the structured
 *  `tool`/`args` fields instead. */
export function formatToolCall(toolName: string, args: any): string {
  const display = managerToolArgsDisplay(toolName, args);
  return `${display.tool}${display.summary ? ` ${display.summary}` : ""}`;
}

// ─── Default safe projection ───────────────────────────────────────

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

/** THE DEFAULT tool-activity projection — the roster-grade allowlisted shape
 *  every roster, viewer, live-event, and history surface consumes. Identity
 *  comes from the closed known-tool registry and the summary carries only
 *  structural counts and numeric ranges: every free-form path, pattern,
 *  query, command, or identifier is omitted, and an unknown name renders as
 *  an anonymous tool. It is self-defending — its output is sanitized and
 *  bounded for any input — so callers pass raw session arguments here with
 *  no construction-side cleaning. The manager's broader bounded-summary
 *  formatter is the explicitly named `managerToolArgsDisplay` opt-in. */
export function rosterToolArgsDisplay(toolName: string, args: unknown): ToolEventDisplay {
  if (!isKnownTool(toolName)) return { tool: "tool", summary: "called" };
  const parsed = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (toolName === "read") {
    const finite = (value: unknown): number | undefined => (
      typeof value === "number" && Number.isFinite(value) ? value : undefined
    );
    const offset = finite(parsed.offset);
    const limit = finite(parsed.limit);
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : undefined;
      return { tool: toolName, summary: `lines ${start}${end !== undefined && end >= start ? `-${end}` : ""}` };
    }
  }
  if (toolName === "web_search") {
    const count = Array.isArray(parsed.queries) ? parsed.queries.length : 0;
    return { tool: toolName, summary: `${count} quer${count === 1 ? "y" : "ies"}` };
  }
  if (toolName === "web_fetch") {
    const count = Array.isArray(parsed.urls) ? parsed.urls.length : 0;
    return { tool: toolName, summary: `${count} URL${count === 1 ? "" : "s"}` };
  }
  return { tool: toolName, summary: "called" };
}

// ─── Structured timeline readers ───────────────────────────────────

function lastToolStart(timeline: SubagentTimelineItem[] | undefined): SubagentTimelineItem | undefined {
  return [...(timeline ?? [])].reverse().find((entry) => entry?.kind === "tool" && entry.phase === "start");
}

/** Roster-grade summary of the latest started tool call — the DEFAULT read
 *  of timeline activity for roster-level surfaces. Reads the structured
 *  fields recorded at the construction point; entries that carry no
 *  structure render as an anonymous `tool called`. */
export function latestRosterToolCallSummary(
  timeline: SubagentTimelineItem[] | undefined,
  fallback = "working",
): string {
  const item = lastToolStart(timeline);
  if (!item) return fallback;
  const display = rosterToolArgsDisplay(String(item.tool ?? ""), item.args);
  const summary = clipInline(display.summary, 120);
  return `${display.tool}${summary ? ` ${summary}` : ""}`;
}

/** MANAGER-GRADE wide summary of the latest started tool call — the
 *  explicitly named opt-in read that free-form bounded summaries render
 *  through. Only manager surfaces (`/subagent` detail rows) may call this;
 *  every other surface uses the default `latestRosterToolCallSummary`. */
export function latestManagerToolCallSummary(timeline: SubagentTimelineItem[] | undefined): string {
  const item = lastToolStart(timeline);
  if (!item) return "working";
  const display = managerToolArgsDisplay(String(item.tool ?? ""), item.args);
  const summary = clipInline(display.summary, 120);
  return `${display.tool}${summary ? ` ${summary}` : ""}`;
}
