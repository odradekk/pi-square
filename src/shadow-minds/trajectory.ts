/**
 * Deterministic bounded parent trajectory (odradeck/pi-square#155).
 *
 * V1 manual-run trajectory: the parent Agent's currently visible branch as
 * reference-only text. Parent reasoning/thinking is removed, tool activity
 * is reduced to name-plus-outcome one-liners, raw tool arguments and result
 * bodies are never exposed, compaction summaries are retained, and the
 * total is deterministically bounded by dropping the oldest messages
 * first. The full known-tool summary registry, credential cleaning, and
 * context-window-aware truncation modes arrive with the evidence-grounded
 * slice (#156) and will replace this serializer's internals.
 */

import type { ShadowTrajectory } from "./prompt";

export const SHADOW_TRAJECTORY_MAX_CHARS = 24_000;
export const SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS = 4_000;

interface LoosePart {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  toolName?: string;
  isError?: boolean;
}

interface LooseEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
  summary?: string;
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
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Renders one visible branch entry as trajectory lines, or none. */
function renderEntry(entry: LooseEntry): { lines: string[]; clipped: boolean } {
  if (entry.type === "compaction") {
    const raw = typeof entry.summary === "string" ? entry.summary.replace(/\s+/g, " ").trim() : "";
    if (!raw) return { lines: [], clipped: false };
    const clippedSummary = clip(raw, SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS);
    return { lines: [`[summary] ${clippedSummary}`], clipped: clippedSummary !== raw };
  }
  if (entry.type !== "message" || !entry.message) return { lines: [], clipped: false };
  const role = entry.message.role;
  const content = entry.message.content;

  if (role === "toolResult") {
    const parts = Array.isArray(content) ? (content.filter((part) => part && typeof part === "object") as LoosePart[]) : [];
    return {
      lines: parts
        .filter((part) => part.type === "tool_result" && typeof (part.toolName ?? part.name) === "string")
        .map((part) => `tool ${String(part.toolName ?? part.name)} ${part.isError ? "error" : "ok"}`),
      clipped: false,
    };
  }

  if (role === "user" || role === "assistant") {
    const lines: string[] = [];
    const raw = Array.isArray(content) ? (content.filter((part) => part && typeof part === "object") as LoosePart[]) : [];
    for (const part of raw) {
      if (part.type === "tool_call" && typeof (part.name ?? part.toolName) === "string") {
        lines.push(`[${role}] requests ${String(part.name ?? part.toolName)}`);
      }
    }
    const text = textParts(content).join("\n").trim();
    let clipped = false;
    if (text) {
      const clippedText = clip(text, SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS);
      clipped = clippedText !== text;
      lines.unshift(`[${role}] ${clippedText}`);
    }
    return { lines, clipped };
  }

  return { lines: [], clipped: false };
}

/**
 * Builds the bounded trajectory view of the parent's visible branch.
 * Deterministic for identical entries; the newest messages are retained
 * when the total bound forces drops.
 */
export function buildTrajectory(entries: readonly unknown[]): ShadowTrajectory {
  const loose = entries.filter((entry): entry is LooseEntry => Boolean(entry) && typeof entry === "object");
  const totalMessages = loose.filter((entry) => entry.type === "message" || entry.type === "compaction").length;

  // Single deterministic pass from the newest entry backward: the latest
  // activity is retained first, and the oldest entries are dropped when the
  // total bound is reached. Identical entries always produce identical bytes.
  const kept: string[][] = [];
  let budget = SHADOW_TRAJECTORY_MAX_CHARS;
  let includedMessages = 0;
  let anyClipped = false;
  for (let index = loose.length - 1; index >= 0; index -= 1) {
    const rendered = renderEntry(loose[index]!);
    if (rendered.lines.length === 0) continue;
    const cost = rendered.lines.join("\n").length + (kept.length > 0 ? 1 : 0);
    if (cost > budget) break;
    kept.unshift(rendered.lines);
    budget -= cost;
    includedMessages += 1;
    anyClipped ||= rendered.clipped;
  }

  const text = kept.flat().join("\n");
  return {
    text,
    includedMessages,
    totalMessages,
    truncated: anyClipped || includedMessages < countRenderableEntries(loose),
  };
}

function countRenderableEntries(entries: readonly LooseEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (renderEntry(entry).lines.length > 0) count += 1;
  }
  return count;
}
