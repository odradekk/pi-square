import { catalogToolNames } from "../display/catalog";
import { sanitizeSubagentDisplay } from "./display";
import type { SubagentTimelineItem } from "./run-types";

export interface ToolEventDisplay {
  tool: string;
  summary: string;
}

export function clipInline(value: unknown, max: number): string {
  const clean = sanitizeSubagentDisplay(value).replace(/\s+/g, " ").trim();
  const codePoints = Array.from(clean);
  return codePoints.length <= max
    ? codePoints.join("")
    : `${codePoints.slice(0, Math.max(0, max - 3)).join("")}...`;
}

export function shortenPath(value: unknown): string {
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
 *  projection reads these fields and never re-parses rendered text. True
 *  list cardinalities are NOT stored here: they live in the timeline item's
 *  parent-authored `listCounts` field, because anything inside the argument
 *  object can be authored by the child and must never be trusted as a
 *  number to display. */
export function sanitizeToolActivityArgs(args: unknown): Record<string, unknown> {
  const budget: SanitizeBudget = { chars: MAX_TOOL_ARG_TOTAL };
  if (!args || typeof args !== "object" || Array.isArray(args)) return Object.freeze({});
  const cleaned = sanitizeArgValue(args, 0, budget);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) return Object.freeze({});
  return cleaned as Record<string, unknown>;
}

// ─── Construction-point list counts ────────────────────────────────

/** True cardinalities of the list-valued argument fields one tool call
 *  counted at the timeline construction point, computed from the raw event
 *  arguments BEFORE sanitizing truncation. Parent-authored: the child
 *  influences these only through the real array lengths it sent, so a
 *  model-crafted `{ count, items }` object can never project a fabricated
 *  number. Only the fields the projections count are recorded. */
export function toolArgCounts(toolName: string, args: unknown): Record<string, number> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const fields = toolName === "web_search" ? ["queries"] : toolName === "web_fetch" ? ["urls"] : [];
  if (fields.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const field of fields) {
    const value = (args as Record<string, unknown>)[field];
    if (Array.isArray(value)) counts[field] = value.length;
  }
  return Object.keys(counts).length > 0 ? Object.freeze(counts) : undefined;
}

// ─── Shared list-field readers ─────────────────────────────────────

/** Cardinality of one list-valued argument field. Only two sources are
 *  trusted: the parent-authored `truthfulCount` recorded at the construction
 *  point (pre-truncation), and a plain array's own length (raw session
 *  arguments, as the transcript paging and live events pass). Any other
 *  shape — in particular a model-crafted `{ count, items }` object — yields
 *  undefined and the projections fall back to their anonymous rendering. */
export function toolArgListCount(value: unknown, truthfulCount?: number): number | undefined {
  if (typeof truthfulCount === "number" && Number.isFinite(truthfulCount) && truthfulCount >= 0) {
    return truthfulCount;
  }
  if (Array.isArray(value)) return value.length;
  return undefined;
}

/** First item of one list-valued argument field, for summaries that preview
 *  it. Anything but a plain array yields undefined and the summaries fall
 *  back to their placeholder. */
export function toolArgListFirst(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  return undefined;
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

/** Bounded identity string for one timeline item's stored tool name, as the
 *  manager-grade projection renders it. The safe projection gates the raw
 *  name against the closed registry before use instead. */
export function timelineToolIdentity(item: Pick<SubagentTimelineItem, "tool">): string {
  return clipInline(String(item.tool ?? ""), 64) || "tool";
}

/** The default tool-activity projection — the roster-grade allowlisted shape
 *  every roster, viewer, live-event, and history surface consumes. Identity
 *  comes from the closed known-tool registry and the summary carries only
 *  structural counts and numeric ranges: every free-form path, pattern,
 *  query, command, or identifier is omitted, and an unknown name renders as
 *  an anonymous tool. It is self-defending — its output is sanitized and
 *  bounded for any input — so callers pass raw session arguments here with
 *  no construction-side cleaning. The manager's broader bounded-summary
 *  formatter is the explicitly named opt-in in `manager-tool-display.ts`. */
export function rosterToolArgsDisplay(
  toolName: string,
  args: unknown,
  listCounts?: Record<string, number>,
): ToolEventDisplay {
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
    const count = toolArgListCount(parsed.queries, listCounts?.queries);
    if (count === undefined) return { tool: toolName, summary: "called" };
    return { tool: toolName, summary: `${count} quer${count === 1 ? "y" : "ies"}` };
  }
  if (toolName === "web_fetch") {
    const count = toolArgListCount(parsed.urls, listCounts?.urls);
    if (count === undefined) return { tool: toolName, summary: "called" };
    return { tool: toolName, summary: `${count} URL${count === 1 ? "" : "s"}` };
  }
  return { tool: toolName, summary: "called" };
}

// ─── Structured timeline readers ───────────────────────────────────

function lastToolStart(timeline: SubagentTimelineItem[] | undefined): SubagentTimelineItem | undefined {
  return [...(timeline ?? [])].reverse().find((entry) => entry?.kind === "tool" && entry.phase === "start");
}

/** Roster-grade summary of the latest started tool call — the default read
 *  of timeline activity for roster-level surfaces. Reads the structured
 *  fields recorded at the construction point; entries that carry no
 *  structure render as an anonymous `tool called`. */
export function latestRosterToolCallSummary(
  timeline: SubagentTimelineItem[] | undefined,
  fallback = "working",
): string {
  const item = lastToolStart(timeline);
  if (!item) return fallback;
  const display = rosterToolArgsDisplay(String(item.tool ?? ""), item.args, item.listCounts);
  const summary = clipInline(display.summary, 120);
  return `${display.tool}${summary ? ` ${summary}` : ""}`;
}
