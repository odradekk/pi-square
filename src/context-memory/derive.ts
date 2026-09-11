import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  MEMORY_STATE_CUSTOM_TYPE,
  parseMemoryDetails,
  parseMemoryState,
  parseMemorySummary,
  type MemoryStateData,
} from "./format";
import { COMPACT_MEMORY_TOOL_NAME, READ_MEMORY_SOURCE_TOOL_NAME, SUBMIT_MEMORY_TOOL_NAME } from "./tools";

/**
 * Current-Memory derivation from the live session tree (odradekk/pi-square#215, #217, #319).
 *
 * Current Memory comes only from the current leaf's ancestor path. Since #319
 * the primary carrier is the latest valid Context Memory state entry — a Pi
 * custom entry appended through the public `ctx.appendEntry` seam — which
 * records the complete ordered block list plus, per block, the retained
 * exceptions that define the exact request replacement set. A compaction entry
 * appended after the state entry establishes a new native baseline and
 * supersedes it; a state entry appended after a compaction extends its v1
 * Memory with `baseCompactionId` naming the base. A branch with no state entry
 * and a strictly valid v1 compaction keeps deriving exactly the pre-#319
 * compaction-carried Memory as a read-only baseline.
 *
 * A strictly valid carrier yields the complete ordered block list with each
 * block's original same-branch source entries; a native, unknown, malformed,
 * or over-bound carrier stays opaque Pi context with structured operations
 * disabled. The newest Memory state record on the path is the derivation
 * boundary: when it is unknown, malformed, or fails branch derivation, the
 * branch degrades explicitly to `opaque` — never to a guessed repair and
 * never to a silent fallback onto an older record's coverage. There is no
 * cross-session lookup, and every end entry resolves only on the carrying
 * entry's own ancestor path.
 */

/**
 * The minimal read-only Pi session surface derivation consumes (#221 adds the
 * ephemeral marker surface; readers that do not expose persistence are treated
 * as persisted). Only the live tree is read — never `parentSession`, the
 * session header, or any origin file — so copied and imported trees stay
 * self-contained.
 */
export interface MemorySessionReader {
  getLeafId?(): string | null;
  getBranch(fromId?: string): readonly SessionEntry[];
  isPersisted?(): boolean;
}

/** One derived Memory block: its exact Markdown plus its original source entries. */
export interface DerivedMemoryBlock {
  readonly markdown: string;
  readonly endEntryId: string;
  readonly sourceEntries: readonly SessionEntry[];
  /**
   * Entries inside this block's continuous source range that stay raw in
   * requests: protected instructions recorded at acceptance (#319). Empty for
   * compaction-carried v1 blocks, whose ranges were removed natively as a whole.
   */
  readonly retainedEntryIds: readonly string[];
  /**
   * Protocol tool-result entries inside this block's range whose producing
   * assistant entry is one of the block's evicted sources (#322). They are
   * never sources — reading copies never enter the source stream — but they
   * leave provider requests together with the exchange that carried their
   * call, because the request-side pair rules keep reading artifacts visible
   * and an evicted call with a surviving result would be an unpaired message
   * providers reject. Deterministically re-derived from the branch on restart.
   */
  readonly protocolResultEntryIds: readonly string[];
}

/** The derivation result for the current leaf. */
/** Fields every valid Memory derivation carries. */
interface ValidMemoryBase {
  readonly kind: "valid";
  readonly blocks: readonly DerivedMemoryBlock[];
  /** The carrying state entry's timestamp; anchors the stable carrier message (#319). */
  readonly carrierTimestamp: number;
}

/** Valid Memory held by a #319 state entry, optionally extending a v1 base. */
export interface StateMemory extends ValidMemoryBase {
  readonly carrier: "state";
  readonly stateEntryId: string;
  /** The base compaction whose v1 Memory provided the unchanged prefix. */
  readonly compactionId: string | undefined;
}

/** Valid Memory held by a v1 compaction entry (read-only baseline). */
export interface CompactionMemory extends ValidMemoryBase {
  readonly carrier: "compaction";
  readonly stateEntryId: string;
  readonly compactionId: string;
}

/** Any valid Memory derivation. */
export type ValidMemory = StateMemory | CompactionMemory;

export type CurrentMemory =
  | { readonly kind: "none" }
  | { readonly kind: "opaque" }
  | StateMemory
  | CompactionMemory;

/**
 * Context Memory protocol artifacts never participate in source streams (#215,
 * #319): both the retired `submit_memory` name — historical calls in older
 * sessions stay protocol history — and the active `compact_to_memory_block`
 * name, plus `read_memory_source`.
 */
export const PROTOCOL_TOOL_NAMES: ReadonlySet<string> = new Set([
  SUBMIT_MEMORY_TOOL_NAME,
  COMPACT_MEMORY_TOOL_NAME,
  READ_MEMORY_SOURCE_TOOL_NAME,
]);

/** Whether a tool name belongs to the Context Memory protocol tools. */
export function isProtocolToolName(name: unknown): boolean {
  return typeof name === "string" && PROTOCOL_TOOL_NAMES.has(name);
}

/** Whether a tool name is one of the two compression tool names (#319). */
export function isCompressionToolName(name: unknown): boolean {
  return name === SUBMIT_MEMORY_TOOL_NAME || name === COMPACT_MEMORY_TOOL_NAME;
}

interface MessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly toolName?: unknown;
}

function messageOf(entry: SessionEntry): MessageLike | undefined {
  return entry.type === "message" ? entry.message as MessageLike : undefined;
}

/**
 * Whether a message content part survives Context Memory protocol filtering.
 * Compression-tool and `read_memory_source` tool-call parts are excluded while
 * ordinary assistant text in the same message is preserved (#215, #319).
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

/** Whether the entry is a real user message entry (not a tool result). */
export function isUserMessageEntry(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = (entry as { message?: { role?: unknown } }).message;
  return message?.role === "user";
}

/** Position index of an entry id on the branch, or -1. */
function positionOf(branch: readonly SessionEntry[], id: string): number {
  return branch.findIndex((entry) => entry.id === id);
}

/**
 * Protocol tool-result entries inside one block's range whose producing
 * assistant entry is among the block's sources (#322). The results never
 * become sources; they only join the replacement set so the evicted call and
 * its result leave provider requests together.
 */
function coveredProtocolResults(range: readonly SessionEntry[], sourceIds: ReadonlySet<string>): readonly string[] {
  const producerOfCall = new Map<string, string>();
  for (const entry of range) {
    if (!sourceIds.has(entry.id)) continue;
    const message = messageOf(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const candidate = part as { type?: unknown; id?: unknown; name?: unknown } | null;
      if (candidate?.type === "toolCall" && typeof candidate.id === "string" && isProtocolToolName(candidate.name)) {
        producerOfCall.set(candidate.id, entry.id);
      }
    }
  }
  if (producerOfCall.size === 0) return [];
  const results: string[] = [];
  for (const entry of range) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; toolCallId?: unknown; toolName?: unknown } }).message;
    if (message?.role !== "toolResult" || !isProtocolToolName(message.toolName)) continue;
    if (typeof message.toolCallId !== "string") continue;
    if (producerOfCall.has(message.toolCallId)) results.push(entry.id);
  }
  return results;
}

/**
 * Derive the block list a state entry records against the branch (#319):
 * strictly increasing eligible ends before the state entry, source ranges from
 * the previous end, retained ids resolving as protected user instructions
 * inside their block's range, and a base compaction — when recorded — that is
 * the only compaction between itself and the state entry.
 *
 * A recorded base carries an inherited prefix: v1 blocks whose ends sit at or
 * before the base compaction itself. Such blocks are valid exactly when the
 * base compaction derives valid v1 Memory and the inherited prefix reproduces
 * its block list exactly — same ends in order, same Markdown bytes — so the
 * append keeps the existing blocks byte-stable instead of smuggling in a
 * rewritten history. Blocks after the base extend the coverage and follow the
 * ordinary strictly-increasing rule.
 */
function deriveStateBlocks(
  branch: readonly SessionEntry[],
  state: MemoryStateData,
  statePosition: number,
): readonly DerivedMemoryBlock[] | undefined {
  const blocks: DerivedMemoryBlock[] = [];
  let previousEnd = -1;
  let basePosition = -1;
  let baseBodies: readonly string[] | undefined;
  let baseEnds: readonly string[] | undefined;
  let inheritedCount = 0;
  if (state.baseCompactionId !== undefined) {
    basePosition = positionOf(branch, state.baseCompactionId);
    if (basePosition === -1 || branch[basePosition]!.type !== "compaction") return undefined;
    const base = v1BlocksOfCompaction(branch, basePosition);
    if (base === undefined) return undefined;
    baseBodies = base.bodies;
    baseEnds = base.ends;
  }
  for (const item of state.blocks) {
    const endPosition = positionOf(branch, item.endEntryId);
    if (endPosition === -1 || endPosition >= statePosition) return undefined;
    if (endPosition <= previousEnd) return undefined;
    if (basePosition !== -1 && endPosition <= basePosition) {
      // Inherited v1 prefix block: must match the base's own derivation in
      // position, order, and bytes.
      const index = inheritedCount;
      if (baseEnds === undefined || index >= baseEnds.length) return undefined;
      if (baseEnds[index] !== item.endEntryId) return undefined;
      if (baseBodies![index] !== item.markdown) return undefined;
      if (item.retainedEntryIds.length > 0) return undefined;
      inheritedCount += 1;
      const sourceEntries = branch
        .slice(previousEnd + 1, endPosition + 1)
        .filter(isEligibleSourceEntry);
      blocks.push({ markdown: item.markdown, endEntryId: item.endEntryId, sourceEntries, retainedEntryIds: [], protocolResultEntryIds: [] });
      previousEnd = endPosition;
      continue;
    }
    const endEntry = branch[endPosition]!;
    if (!isEligibleSourceEntry(endEntry)) return undefined;
    const sourceEntries = branch
      .slice(previousEnd + 1, endPosition + 1)
      .filter(isEligibleSourceEntry);
    if (sourceEntries.length === 0) return undefined;
    const rangeIds = new Set(branch.slice(previousEnd + 1, endPosition + 1).map((entry) => entry.id));
    for (const id of item.retainedEntryIds) {
      const retainedPosition = positionOf(branch, id);
      if (!rangeIds.has(id) || !isUserMessageEntry(branch[retainedPosition]!)) return undefined;
    }
    const range = branch.slice(previousEnd + 1, endPosition + 1);
    const protocolResultEntryIds = coveredProtocolResults(
      range,
      new Set(sourceEntries.map((entry) => entry.id)),
    );
    blocks.push({ markdown: item.markdown, endEntryId: item.endEntryId, sourceEntries, retainedEntryIds: item.retainedEntryIds, protocolResultEntryIds });
    previousEnd = endPosition;
  }
  if (basePosition !== -1) {
    // The inherited prefix must be exactly the base's block list — a state
    // entry may not drop, reorder, or extend the prefix before the base.
    if (inheritedCount !== baseEnds!.length) return undefined;
    // A competing compaction between the recorded base and the state entry
    // means the recorded prefix no longer matches the branch baseline.
    for (let i = basePosition + 1; i < statePosition; i++) {
      if (branch[i]!.type === "compaction") return undefined;
    }
  }
  return blocks;
}

/**
 * The v1 block bodies and directory ends a compaction entry carries, when it
 * derives valid v1 Memory against the branch. Shared by the inherited-prefix
 * validation of state entries (#319).
 */
function v1BlocksOfCompaction(branch: readonly SessionEntry[], compactionIndex: number): { bodies: readonly string[]; ends: readonly string[] } | undefined {
  const compaction = branch[compactionIndex]!;
  const details = parseMemoryDetails((compaction as { details?: unknown }).details);
  if (!details) return undefined;
  const bodies = parseMemorySummary((compaction as { summary?: unknown }).summary as string, details);
  if (!bodies || bodies.length !== details.blocks.length) return undefined;
  const positionById = new Map<string, number>();
  for (let i = 0; i < branch.length; i++) {
    if (!positionById.has(branch[i]!.id)) positionById.set(branch[i]!.id, i);
  }
  const keptPosition = positionById.get((compaction as { firstKeptEntryId: string }).firstKeptEntryId);
  if (keptPosition === undefined || keptPosition >= compactionIndex) return undefined;
  let previousEnd = -1;
  const ends: string[] = [];
  for (let i = 0; i < details.blocks.length; i++) {
    const item = details.blocks[i]!;
    const endPosition = positionById.get(item.endEntryId);
    if (endPosition === undefined || endPosition >= compactionIndex) return undefined;
    if (endPosition <= previousEnd || endPosition >= keptPosition) return undefined;
    if (!isEligibleSourceEntry(branch[endPosition]!)) return undefined;
    ends.push(item.endEntryId);
    previousEnd = endPosition;
  }
  return { bodies, ends };
}

/**
 * The newest Memory state record on the branch and what it derives to
 * (#319): `valid` with the block list, or `invalid` when the record is
 * unknown, malformed, or fails branch derivation. Older records are never
 * consulted — the newest record is the boundary and an invalid one degrades
 * explicitly.
 */
type StateRecordDerivation =
  | { readonly kind: "valid"; readonly stateEntryId: string; readonly statePosition: number; readonly state: MemoryStateData; readonly blocks: readonly DerivedMemoryBlock[] }
  | { readonly kind: "invalid"; readonly statePosition: number }
  | undefined;

function deriveStateRecord(
  branch: readonly SessionEntry[],
): StateRecordDerivation {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "custom" || (entry as { customType?: unknown }).customType !== MEMORY_STATE_CUSTOM_TYPE) continue;
    const state = parseMemoryState((entry as { data?: unknown }).data);
    if (state === undefined) return { kind: "invalid", statePosition: i };
    const blocks = deriveStateBlocks(branch, state, i);
    if (blocks === undefined) return { kind: "invalid", statePosition: i };
    return { kind: "valid", stateEntryId: entry.id, statePosition: i, state, blocks };
  }
  return undefined;
}

/**
 * Derive current Memory from the session tree. Structural problems (missing
 * kept boundary, non-resolving or non-increasing directory ends, ends past the
 * kept boundary, malformed wrapper/directory) degrade to `opaque` — the
 * compaction remains usable as an ordinary Pi summary (#217). The newest
 * Memory state record is the boundary: a compaction after it is the newer
 * native baseline (the record is superseded), an invalid record degrades the
 * branch explicitly to `opaque`, and only a valid record derives state Memory.
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

  const stateRecord = deriveStateRecord(branch);
  // A native (or v1) compaction after the newest state record is the newer
  // baseline: the record's coverage was folded into it and applying the stale
  // state again would resurrect replaced history (#319). The record's own
  // validity does not matter once superseded.
  const recordSuperseded = stateRecord !== undefined
    && compaction !== undefined
    && compactionIndex > stateRecord.statePosition;
  if (stateRecord !== undefined && !recordSuperseded) {
    if (stateRecord.kind === "invalid") return { kind: "opaque" };
    return {
      kind: "valid",
      carrier: "state",
      stateEntryId: stateRecord.stateEntryId,
      carrierTimestamp: Date.parse(branch[stateRecord.statePosition]!.timestamp) || 0,
      compactionId: stateRecord.state.baseCompactionId,
      blocks: stateRecord.blocks,
    };
  }

  if (!compaction) return { kind: "none" };

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
    blocks.push({ markdown: bodies[i]!, endEntryId: item.endEntryId, sourceEntries, retainedEntryIds: [], protocolResultEntryIds: [] });
    previousEnd = endPosition;
  }

  return {
    kind: "valid",
    carrier: "compaction",
    stateEntryId: "",
    carrierTimestamp: 0,
    compactionId: compaction.id,
    blocks,
  };
}
