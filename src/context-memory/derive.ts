import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseMemoryDetails, parseMemorySummary } from "./format";
import { READ_MEMORY_SOURCE_TOOL_NAME, SUBMIT_MEMORY_TOOL_NAME } from "./tools";

/**
 * Current-Memory derivation from the live session tree (odradekk/pi-square#215, #217).
 *
 * Current Memory comes only from the latest compaction on Pi's actual current
 * leaf ancestor path. A strictly valid entry yields the complete ordered block
 * list with each block's original same-branch source entries; a native,
 * unknown, malformed, or over-bound compaction stays opaque Pi context with
 * structured operations disabled. There is no fallback to older Memory
 * entries, no repair, and no cross-session lookup — every end entry resolves
 * only on the carrying compaction's own ancestor path.
 */

/** The minimal read-only Pi session surface derivation consumes. */
export interface MemorySessionReader {
  getLeafId?(): string | null;
  getBranch(fromId?: string): readonly SessionEntry[];
}

/** One derived Memory block: its exact Markdown plus its original source entries. */
export interface DerivedMemoryBlock {
  readonly markdown: string;
  readonly endEntryId: string;
  readonly sourceEntries: readonly SessionEntry[];
}

/** The derivation result for the current leaf. */
export type CurrentMemory =
  | { readonly kind: "none" }
  | { readonly kind: "opaque" }
  | {
    readonly kind: "valid";
    readonly compactionId: string;
    readonly firstKeptEntryId: string;
    readonly blocks: readonly DerivedMemoryBlock[];
  };

/** Context Memory protocol artifacts never participate in source streams (#215). */
const PROTOCOL_TOOL_NAMES: ReadonlySet<string> = new Set([
  SUBMIT_MEMORY_TOOL_NAME,
  READ_MEMORY_SOURCE_TOOL_NAME,
]);

interface MessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly toolName?: unknown;
}

function messageOf(entry: SessionEntry): MessageLike | undefined {
  return entry.type === "message" ? entry.message as MessageLike : undefined;
}

function isProtocolToolName(name: unknown): boolean {
  return typeof name === "string" && PROTOCOL_TOOL_NAMES.has(name);
}

/**
 * Whether a message content part survives Context Memory protocol filtering.
 * `submit_memory` and `read_memory_source` tool-call parts are excluded while
 * ordinary assistant text in the same message is preserved (#215).
 */
export function isEligibleContentPart(part: unknown): boolean {
  if (part === null || typeof part !== "object") return false;
  const candidate = part as { type?: unknown; name?: unknown };
  if (candidate.type === "toolCall") return !isProtocolToolName(candidate.name);
  return candidate.type === "text" || candidate.type === "thinking" || candidate.type === "image";
}

/**
 * Eligible source entries are current-path entries that project as
 * conversation content — ordinary messages, custom messages, and branch
 * summaries — excluding every compaction entry and Context Memory protocol
 * artifacts. Mirrors Pi's own context projection (`sessionEntryToContextMessages`
 * semantics) minus the protocol artifacts and storage-only entries.
 */
export function isEligibleSourceEntry(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "message": {
      const message = messageOf(entry);
      if (!message) return false;
      if (message.role === "toolResult") return !isProtocolToolName(message.toolName);
      if (message.role === "assistant") {
        const content = message.content;
        return Array.isArray(content) && content.some(isEligibleContentPart);
      }
      if (message.role === "user") return true;
      return false;
    }
    case "custom_message":
      return true;
    case "branch_summary":
      return Boolean(entry.summary);
    default:
      return false;
  }
}

/**
 * Derive current Memory from the session tree. Structural problems (missing
 * kept boundary, non-resolving or non-increasing directory ends, ends past the
 * kept boundary, malformed wrapper/directory) degrade to `opaque` — the
 * compaction remains usable as an ordinary Pi summary (#217).
 */
export function deriveCurrentMemory(session: MemorySessionReader): CurrentMemory {
  const branch = [...session.getBranch(session.getLeafId?.() ?? undefined)];

  let compaction: SessionEntry | undefined;
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "compaction") {
      compaction = branch[i];
      compactionIndex = i;
      break;
    }
  }
  if (!compaction) return { kind: "none" };

  const details = parseMemoryDetails((compaction as { details?: unknown }).details);
  if (!details) return { kind: "opaque" };
  const bodies = parseMemorySummary(
    (compaction as { summary?: unknown }).summary as string,
    details,
  );
  if (!bodies || bodies.length !== details.blocks.length) return { kind: "opaque" };

  const positionById = new Map<string, number>();
  for (let i = 0; i < branch.length; i++) {
    if (!positionById.has(branch[i]!.id)) positionById.set(branch[i]!.id, i);
  }

  // Kept-tail relationship: the retained recent context begins at an entry on
  // the carrying compaction's own ancestor path, before the compaction itself.
  const keptPosition = positionById.get((compaction as { firstKeptEntryId: string }).firstKeptEntryId);
  if (keptPosition === undefined || keptPosition >= compactionIndex) return { kind: "opaque" };

  const blocks: DerivedMemoryBlock[] = [];
  let previousEnd = -1;
  for (let i = 0; i < details.blocks.length; i++) {
    const item = details.blocks[i]!;
    const endPosition = positionById.get(item.endEntryId);
    if (endPosition === undefined || endPosition >= compactionIndex) return { kind: "opaque" };
    if (endPosition <= previousEnd) return { kind: "opaque" };
    if (endPosition >= keptPosition) return { kind: "opaque" };
    const endEntry = branch[endPosition]!;
    if (!isEligibleSourceEntry(endEntry)) return { kind: "opaque" };
    const sourceEntries = branch
      .slice(previousEnd + 1, endPosition + 1)
      .filter(isEligibleSourceEntry);
    if (sourceEntries.length === 0) return { kind: "opaque" };
    blocks.push({ markdown: bodies[i]!, endEntryId: item.endEntryId, sourceEntries });
    previousEnd = endPosition;
  }

  return {
    kind: "valid",
    compactionId: compaction.id,
    firstKeptEntryId: (compaction as { firstKeptEntryId: string }).firstKeptEntryId,
    blocks,
  };
}
