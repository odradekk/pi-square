// Lightweight session-entry analysis for Prompt Manager views.
//
// We mirror the loose runtime shape of session entries rather than
// importing Pi's types — this keeps the module pure-loadable for tests
// and avoids coupling to Pi internals.

export interface MessageEntrySummary {
  index: number;
  role: string;          // user/assistant/toolResult/custom/compaction OR raw entry.type
  charCount: number;
  brief: string;        // one-line summary, no newlines
  hasThinking: boolean;
  toolCalls: string[];
  // Whether this entry contributes to the LLM-visible context.
  // Session meta entries (session_info, model_change, thinking_level_change,
  // label, custom) are persisted but NOT sent to the LLM.
  inLlmContext: boolean;
}

type LooseContentPart = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  data?: string;
} & Record<string, unknown>;

type LooseMessage = {
  role?: string;
  content?: string | LooseContentPart[];
};

type LooseEntry = {
  type?: string;
  message?: LooseMessage;
  content?: string | LooseContentPart[];
  summary?: string;
  customType?: string;
};

function charCount(s: string): number {
  return Array.from(s).length;
}

function partsLength(parts: LooseContentPart[]): number {
  let total = 0;
  for (const part of parts) {
    if (typeof part?.text === "string") total += charCount(part.text);
    if (typeof part?.thinking === "string") total += charCount(part.thinking);
    if (typeof part?.data === "string") total += 24; // image placeholder
  }
  return total;
}

function textPreview(parts: LooseContentPart[] | string | undefined, limit: number): string {
  if (!parts) return "";
  let text = "";
  if (typeof parts === "string") {
    text = parts;
  } else {
    for (const p of parts) {
      if (typeof p?.text === "string" && p.text.trim()) {
        text = p.text;
        break;
      }
    }
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return collapsed.slice(0, limit - 1) + "…";
}

function classifyRole(entry: LooseEntry): { role: string; inLlmContext: boolean } {
  if (entry.type === "compaction") return { role: "compaction", inLlmContext: true };
  if (entry.type === "custom_message") return { role: "custom_message", inLlmContext: true };
  if (entry.type === "message") {
    const r = entry.message?.role;
    if (r === "user" || r === "assistant" || r === "toolResult") {
      return { role: r, inLlmContext: true };
    }
    return { role: `message(${r ?? "?"})`, inLlmContext: true };
  }
  // Meta entries: persisted in session file but NOT in LLM context.
  // Keep them visible so Prompt Manager accounts for every entry.
  return { role: entry.type ?? "unknown", inLlmContext: false };
}

export function summarizeEntries(entries: unknown[]): MessageEntrySummary[] {
  const result: MessageEntrySummary[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LooseEntry;
    const { role, inLlmContext } = classifyRole(entry);

    let parts: LooseContentPart[] = [];
    let summaryText = "";
    if (entry.type === "compaction") {
      summaryText = entry.summary ?? "";
    } else if (entry.type === "custom_message") {
      if (Array.isArray(entry.content)) parts = entry.content;
      else if (typeof entry.content === "string") summaryText = entry.content;
    } else if (entry.message) {
      const c = entry.message.content;
      if (Array.isArray(c)) parts = c;
      else if (typeof c === "string") summaryText = c;
    }

    const bytes = parts.length > 0
      ? partsLength(parts)
      : charCount(summaryText);

    const hasThinking = parts.some((p) => p?.type === "thinking");
    const toolCalls: string[] = parts
      .filter((p) => p?.type === "toolCall")
      .map((p) => (typeof p?.name === "string" ? p.name : "unknown"));

    const brief = parts.length > 0
      ? textPreview(parts, 48)
      : textPreview(summaryText, 48);

    result.push({
      index: i,
      role,
      charCount: bytes,
      brief,
      hasThinking,
      toolCalls,
      inLlmContext,
    });
  }
  return result;
}

/** Aggregate LLM-visible entry char counts by message role. */
export interface ByRoleChars {
  user: number;
  assistant: number;
  toolResult: number;
}

export function byRoleChars(summarized: MessageEntrySummary[]): ByRoleChars {
  let user = 0;
  let assistant = 0;
  let toolResult = 0;
  for (const e of summarized) {
    if (!e.inLlmContext) continue;
    if (e.role === "user") user += e.charCount;
    else if (e.role === "assistant") assistant += e.charCount;
    else if (e.role === "toolResult") toolResult += e.charCount;
  }
  return { user, assistant, toolResult };
}

export interface CollapsedEntries {
  rows: MessageEntrySummary[];
  hiddenCount: number;
  hiddenChars: number;
  hiddenStart: number;      // index in original where the gap begins
}

/**
 * Collapse a long entry list: keep first `headCount` and last `tailCount`,
 * insert a gap marker in the middle. If the total is short enough, no
 * collapsing happens.
 */
export function collapseEntries(
  entries: MessageEntrySummary[],
  headCount: number,
  tailCount: number,
): CollapsedEntries {
  if (entries.length <= headCount + tailCount) {
    return { rows: entries, hiddenCount: 0, hiddenChars: 0, hiddenStart: -1 };
  }
  const head = entries.slice(0, headCount);
  const tail = entries.slice(entries.length - tailCount);
  const hidden = entries.slice(headCount, entries.length - tailCount);
  const hiddenChars = hidden.reduce((sum, e) => sum + e.charCount, 0);
  return {
    rows: [...head, ...tail],
    hiddenCount: hidden.length,
    hiddenChars,
    hiddenStart: headCount,
  };
}
