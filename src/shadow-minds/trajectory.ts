/**
 * Deterministic bounded parent trajectory (odradekk/pi-square#155, #156).
 *
 * The parent Agent's currently visible branch as reference-only text.
 * Parent reasoning/thinking is removed; visible user/assistant text and
 * compaction summaries are retained; only delivered Shadow evidence is
 * included. Tool activity is reduced to known-tool summaries from a closed
 * field registry with mandatory bounded credential cleaning, and unknown
 * tools expose only name, outcome, and scale — never raw arguments or result
 * bodies. The total is deterministically bounded with a visible truncation
 * mode that retains delivered evidence, compaction summaries, and the most
 * recent history first; identical entries always produce identical bytes.
 */

import { sanitizeDisplayLine, sanitizeDisplayText } from "../display/sanitize";
import type { ShadowTrajectory } from "./prompt";

export const SHADOW_TRAJECTORY_MAX_CHARS = 24_000;
export const SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS = 4_000;

/** Delivered evidence share of the total budget; summaries share the rest of the remainder. */
const SUMMARY_BUDGET_SHARE = 0.5;
/** Cap on delivered Shadow evidence lines rendered into one trajectory. */
const EVIDENCE_MAX = 20;
/** Cap on rendered characters of one known-tool argument field. */
const FIELD_MAX_CHARS = 80;
/** Cap on known-tool fields rendered on one tool line. */
const FIELD_MAX_COUNT = 3;
/** Cap on the complete tool one-liner including name, outcome, and scale. */
const TOOL_LINE_MAX_CHARS = 240;

/**
 * Closed known-tool registry: the bounded argument fields each tool may
 * expose. Every rendered value passes the shared credential cleaner; tools
 * absent from this registry expose only name, outcome, and scale.
 */
const KNOWN_TOOL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ["path"],
  grep: ["pattern", "path"],
  find: ["pattern", "path"],
  ls: ["path"],
  bash: ["command"],
  pwsh: ["command"],
  edit: ["path"],
  write: ["path"],
  replace: ["path"],
  revert: ["path"],
  codegraph: ["operation", "query"],
  pdf_search: ["query", "path"],
  search: ["queries"],
  fetch: ["urls"],
  libs: ["libraryName", "query"],
  docs: ["libraryId", "query"],
  github: ["operation", "repo"],
  delegate: ["agent", "mode"],
  resume: ["id"],
  todo: ["action"],
  parse: ["path", "pages"],
});

/** One Shadow result as trajectory evidence; only delivered evidence renders. */
export interface ShadowTrajectoryEvidence {
  shadowId: string;
  shadowName: string;
  summary: string;
  deliveredAt: number;
  delivery: "notified" | "pending" | "delivered";
}

export interface BuildTrajectoryOptions {
  /** Shadow results eligible as evidence; only `delivered` entries render. */
  evidence?: readonly ShadowTrajectoryEvidence[];
}

interface LoosePart {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
}

interface LooseEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
  };
  summary?: string;
  /** Attached by the builder: tool-call ids that already have results. */
  resultIds?: Set<string>;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is LoosePart => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
}

function clip(text: string, max: number): string {
  const sanitized = sanitizeDisplayText(text);
  return sanitized.length <= max ? sanitized : `${sanitized.slice(0, max - 1)}…`;
}

function clipLine(text: string, max: number): string {
  const sanitized = sanitizeDisplayLine(text);
  return sanitized.length <= max ? sanitized : `${sanitized.slice(0, max - 1)}…`;
}

/** Renders one known-tool argument value with mandatory credential cleaning. */
function renderFieldValue(value: unknown): string {
  const flattened = Array.isArray(value) ? value.map((item) => renderFieldValue(item)).join(", ") : String(value ?? "");
  return clipLine(flattened.replace(/\s+/g, " ").trim(), FIELD_MAX_CHARS);
}

/** Deterministic bounded scale descriptor for one tool-result content. */
function renderScale(content: unknown): string {
  if (typeof content === "string") {
    const lines = content.split("\n").length;
    return lines > 1 ? `${lines} lines` : `${content.length} chars`;
  }
  if (!Array.isArray(content)) return "empty";
  const parts = content.filter((part): part is LoosePart => Boolean(part) && typeof part === "object");
  const images = parts.filter((part) => part.type === "image").length;
  const text = parts.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string).join("\n");
  if (!text) return images > 0 ? `${images} image` : "empty";
  const lines = text.split("\n").length;
  if (images > 0) return lines > 1 ? `${lines} lines + ${images} image` : `${text.length} chars + ${images} image`;
  return lines > 1 ? `${lines} lines` : `${text.length} chars`;
}

/** Renders one known-tool one-liner from the closed field registry. */
function renderToolLine(
  toolName: string,
  outcome: "ok" | "error",
  argumentsObject: Record<string, unknown> | undefined,
  content: unknown,
): string {
  const fields = KNOWN_TOOL_FIELDS[toolName];
  const segments = [`tool ${sanitizeDisplayLine(toolName)} ${outcome}`];
  if (fields) {
    for (const field of fields.slice(0, FIELD_MAX_COUNT)) {
      const value = argumentsObject?.[field];
      if (value === undefined || value === null || value === "") continue;
      segments.push(`${field}=${renderFieldValue(value)}`);
    }
  }
  segments.push(renderScale(content));
  const line = segments.join(" · ");
  return line.length <= TOOL_LINE_MAX_CHARS ? line : `${line.slice(0, TOOL_LINE_MAX_CHARS - 1)}…`;
}

/** Collects assistant tool-call arguments by call id across the branch. */
function collectToolCalls(entries: readonly LooseEntry[]): Map<string, { name: string; arguments?: Record<string, unknown> }> {
  const calls = new Map<string, { name: string; arguments?: Record<string, unknown> }>();
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as LoosePart[]) {
      if (part?.type === "toolCall" && typeof part.name === "string" && typeof part.id === "string") {
        const args = part.arguments;
        calls.set(part.id, {
          name: part.name,
          ...(args && typeof args === "object" && !Array.isArray(args) ? { arguments: args as Record<string, unknown> } : {}),
        });
      }
    }
  }
  return calls;
}

/** Renders one visible branch entry as trajectory lines, or none. */
function renderEntry(entry: LooseEntry, toolCalls: Map<string, { name: string; arguments?: Record<string, unknown> }>): { lines: string[]; clipped: boolean; summary: boolean } {
  if (entry.type === "compaction") {
    const raw = typeof entry.summary === "string" ? sanitizeDisplayLine(entry.summary).replace(/\s+/g, " ").trim() : "";
    if (!raw) return { lines: [], clipped: false, summary: false };
    const clippedSummary = clip(raw, SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS);
    return { lines: [`[summary] ${clippedSummary}`], clipped: clippedSummary !== raw, summary: true };
  }
  if (entry.type !== "message" || !entry.message) return { lines: [], clipped: false, summary: false };
  const role = entry.message.role;
  const content = entry.message.content;

  // Pi 0.84.2 toolResult messages carry toolName, toolCallId, and isError at
  // the message top level; the content is text/image parts and only ever
  // reaches the trajectory as a scale descriptor.
  if (role === "toolResult") {
    const toolName = entry.message.toolName;
    if (typeof toolName !== "string") return { lines: [], clipped: false, summary: false };
    const call = typeof entry.message.toolCallId === "string" ? toolCalls.get(entry.message.toolCallId) : undefined;
    const line = renderToolLine(
      toolName,
      entry.message.isError ? "error" : "ok",
      call?.arguments,
      content,
    );
    return { lines: [line], clipped: false, summary: false };
  }

  if (role === "user" || role === "assistant") {
    const lines: string[] = [];
    // Assistant tool calls are content parts of type "toolCall"; calls whose
    // results are not on the visible branch yet still surface as requests.
    const raw = Array.isArray(content) ? (content.filter((part) => part && typeof part === "object") as LoosePart[]) : [];
    for (const part of raw) {
      // Calls whose results are not on the visible branch yet still surface
      // as requests; paired calls are represented by their result line.
      if (part.type === "toolCall" && typeof part.name === "string") {
        if (typeof part.id !== "string" || !entry.resultIds?.has(part.id)) {
          lines.push(`[${role}] requests ${sanitizeDisplayLine(part.name)}`);
        }
      }
    }
    const text = textParts(content).join("\n").trim();
    let clipped = false;
    if (text) {
      const clippedText = clip(text, SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS);
      clipped = clippedText !== text;
      lines.unshift(`[${role}] ${clippedText}`);
    }
    return { lines, clipped, summary: false };
  }

  return { lines: [], clipped: false, summary: false };
}

/**
 * Builds the bounded trajectory view of the parent's visible branch.
 * Delivered Shadow evidence renders in delivery order; compaction summaries
 * and the newest history are retained when the total bound forces drops,
 * and the truncation mode is reported for cache hashing.
 */
export function buildTrajectory(entries: readonly unknown[], options: BuildTrajectoryOptions = {}): ShadowTrajectory {
  const loose = entries.filter((entry): entry is LooseEntry => Boolean(entry) && typeof entry === "object");
  const toolCalls = collectToolCalls(loose);
  const resultIds = collectResultIds(loose);
  for (const entry of loose) entry.resultIds = resultIds;

  const evidenceLines = renderEvidence(options.evidence);
  const evidenceCost = evidenceLines.length > 0 ? evidenceLines.join("\n").length + 1 : 0;
  const summaryBudget = Math.floor((SHADOW_TRAJECTORY_MAX_CHARS - evidenceCost) * SUMMARY_BUDGET_SHARE);

  // Render once, then retain newest-first within each priority class:
  // delivered evidence (already charged), compaction summaries, then the
  // remaining visible history. Identical entries produce identical bytes.
  const keptSummaries: Array<{ index: number; rendered: ReturnType<typeof renderEntry> }> = [];
  const keptOthers: Array<{ index: number; rendered: ReturnType<typeof renderEntry> }> = [];
  let summaryUsed = 0;
  let otherUsed = 0;
  let anyClipped = false;
  let droppedCount = 0;
  for (let index = loose.length - 1; index >= 0; index -= 1) {
    const rendered = renderEntry(loose[index]!, toolCalls);
    if (rendered.lines.length === 0) continue;
    // One separator character is charged per entry so the final join can
    // never exceed the total bound.
    const cost = rendered.lines.join("\n").length + 1;
    if (rendered.summary) {
      if (summaryUsed + cost > summaryBudget) {
        droppedCount += 1;
        continue;
      }
      summaryUsed += cost;
      keptSummaries.push({ index, rendered });
    } else {
      const remaining = SHADOW_TRAJECTORY_MAX_CHARS - evidenceCost - summaryUsed - otherUsed;
      if (cost > remaining) {
        droppedCount += 1;
        continue;
      }
      otherUsed += cost;
      keptOthers.push({ index, rendered });
    }
    anyClipped ||= rendered.clipped;
  }

  const kept = [...keptSummaries, ...keptOthers]
    .sort((left, right) => left.index - right.index)
    .flatMap((entry) => entry.rendered.lines);
  const text = [...kept, ...evidenceLines].join("\n");

  const totalMessages = loose.filter((entry) => entry.type === "message" || entry.type === "compaction").length;
  const includedMessages = keptSummaries.length + keptOthers.length;
  return {
    text,
    includedMessages,
    totalMessages,
    truncated: anyClipped || droppedCount > 0,
    truncation: anyClipped || droppedCount > 0 ? "dropped" : "none",
  };
}

/** Renders delivered Shadow evidence lines in delivery order. */
function renderEvidence(evidence: readonly ShadowTrajectoryEvidence[] | undefined): string[] {
  if (!evidence || evidence.length === 0) return [];
  const delivered = evidence
    .filter((item) => item.delivery === "delivered")
    .sort((left, right) => left.deliveredAt - right.deliveredAt)
    .slice(-EVIDENCE_MAX);
  return delivered.map((item) => `[shadow] ${sanitizeDisplayLine(item.shadowName)}: ${clipLine(item.summary, 300)}`);
}

/** Tool-call ids that already have a toolResult on the visible branch. */
function collectResultIds(entries: readonly LooseEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role !== "toolResult") continue;
    if (typeof entry.message.toolCallId === "string") ids.add(entry.message.toolCallId);
  }
  return ids;
}
