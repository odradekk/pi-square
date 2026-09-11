import type { AgentToolResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMPACTION_SETTINGS,
  buildContextEntries,
  estimateTokens as estimateMessageTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { deriveCurrentMemory, isEligibleSourceEntry, isProtocolToolName, isUserMessageEntry, type CurrentMemory, type DerivedMemoryBlock, type MemorySessionReader, type StateMemory, type ValidMemory } from "./derive";
import {
  MEMORY_BLOCK_SEPARATOR,
  MEMORY_DETAILS_MAX_BYTES,
  MEMORY_STATE_CUSTOM_TYPE,
  MEMORY_STATE_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
  composeMemorySummary,
  isValidMemoryBlockBody,
  parseMemoryState,
  type MemoryStateBlock,
  type MemoryStateData,
} from "./format";
import type { ContextMemoryThreshold, ContextMemoryConfig } from "../core/config";
import {
  paginateTranscript,
  renderSourceTranscript,
} from "./transcript";
import type { HostSupport } from "./host";
import {
  COMPACT_MEMORY_TOOL_NAME,
  READ_MEMORY_SOURCE_TOOL_NAME,
  SUBMIT_MEMORY_TOOL_NAME,
  type CompactMemoryDetails,
  type MemoryRecordingContext,
  type ReadMemorySourceDetails,
  type ReadMemorySourceRequest,
} from "./tools";
import {
  CONTEXT_MEMORY_ADVISORY_TYPE,
  CONTEXT_MEMORY_BLOCKS_TYPE,
  CONTEXT_MEMORY_MAX_VIEW_ROWS,
  type ContextMemoryBlockRow,
  type ContextMemorySnapshot,
} from "./view";

/**
 * The session-scoped Context Memory controller (odradekk/pi-square#215, #216,
 * #217, #319).
 *
 * #319 replaces the settle-driven submission protocol with in-task recording
 * and request projection, per ADR-0017 and #317. The controller keeps one
 * owner for every boundary: the resident `compact_to_memory_block` tool, due
 * detection, source selection and tool-batch pairing, the versioned state
 * entry recorded through Pi's public `appendEntry` seam, the request
 * projection that evicts covered originals and inserts the one complete
 * Memory carrier, bounded source recovery, and the read-only `/context`
 * snapshot that separates recorded from applied Memory.
 *
 * Recording never blocks the run: the accepted block lands as a Pi custom
 * state entry (SessionManager stays the only session-file writer), and the
 * next ordinary model request — including tool continuations — applies the
 * projection through the public `context` transform. No settle, abort,
 * restart, background model, autonomous turn, or native `compact()` call is
 * involved in the normal path; Pi native compaction stays untouched as the
 * fallback owner of the context boundary.
 *
 * #217's reading surface (`read_memory_source`, `/context memory`) is
 * unchanged; #221's branch-private lifecycle rules still hold (derivation
 * follows Pi's actual leaf, no cancellable session event is subscribed, no
 * sidecar); and pre-#319 compaction-carried v1 Memory keeps deriving as a
 * read-only baseline through the #297 blocks projection.
 */

/** The only tool names this feature may add to or remove from the active list. */
export const OWNED_TOOL_NAMES: readonly string[] = Object.freeze([
  COMPACT_MEMORY_TOOL_NAME,
  READ_MEMORY_SOURCE_TOOL_NAME,
]);

const OWNED_TOOL_NAME_SET: ReadonlySet<string> = new Set(OWNED_TOOL_NAMES);

const NO_MEMORY_SENTENCE = "no valid Context Memory is available on the current branch";

/** Current context usage as supplied by Prompt Manager at render time. */
export interface ContextMemoryUsageInput {
  readonly tokens: number | null;
  readonly contextWindow: number | null;
}

export interface ContextMemoryControllerOptions {
  readonly config: ContextMemoryConfig;
  readonly support: HostSupport;
}

function fail(code: string, sentence: string): never {
  throw new Error(`${code}: ${sentence}`);
}

/** Deterministic chars/4 text estimate used consistently for Memory comparisons. */
function estimateTextTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 4);
}

/**
 * Deterministic chars/4 estimate of the complete rendered Memory — wrapper,
 * one separator per block, every body — the one measure the half-budget rule,
 * the `/context` estimate, and the submission budget share (#219).
 */
export function renderedMemoryTokens(markdowns: readonly string[]): number {
  let chars = MEMORY_SUMMARY_WRAPPER.length + MEMORY_BLOCK_SEPARATOR.length * markdowns.length;
  for (const markdown of markdowns) chars += Array.from(markdown).length;
  return Math.ceil(chars / 4);
}

/**
 * The most recent provider-bound request the controller observed (#319): the
 * leaf it was served on and the entry ids whose native messages reached the
 * transform aligned — the only proof that a source entry was actually served
 * to the model in its current form. Entries an upstream transform replaced or
 * removed never enter this set.
 */
interface ServedBoundary {
  readonly leafId: string | null;
  readonly entryIds: ReadonlySet<string>;
}

/** Structural deep equality for native message projections and request messages. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    key in (right as Record<string, unknown>) && deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/**
 * The one-request Memory projection input derived from the session tree
 * (#319): the native context entries, their projected messages, and the
 * derived Memory whose replacement set the projection applies.
 */
interface NativeProjection {
  readonly entries: readonly SessionEntry[];
  /** Messages the native projection produces, with the producing entry id. */
  readonly expected: readonly { readonly message: unknown; readonly entryId: string }[];
  /** Entry ids the native context projection actually carries. */
  readonly carriedEntryIds: ReadonlySet<string>;
}

function nativeProjection(session: MemorySessionReader): NativeProjection {
  const branch = [...session.getBranch(session.getLeafId?.() ?? undefined)];
  const leafId = session.getLeafId?.() ?? null;
  const entries = buildContextEntries(branch, leafId);
  const expected: { message: unknown; entryId: string }[] = [];
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      expected.push({ message, entryId: entry.id });
    }
  }
  return { entries, expected, carriedEntryIds: new Set(entries.map((entry) => entry.id)) };
}

/** One aligned request message: its producing entry id, or undefined for a foreign insertion. */
interface AlignedMessage {
  readonly message: unknown;
  readonly entryId: string | undefined;
}

/**
 * Align incoming request messages to the native projection (#319): every
 * message deep-equal to the next natively projected message maps to its
 * producing entry; anything else is a foreign insertion kept in place. The
 * walk never skips an expected message, so an upstream deletion or
 * modification leaves everything after it unmapped — the application then
 * refuses rather than guessing which history a message belongs to.
 */
function alignMessages(
  messages: readonly unknown[],
  projection: NativeProjection,
): readonly AlignedMessage[] {
  const items: AlignedMessage[] = [];
  let expectedIndex = 0;
  for (const message of messages) {
    if (expectedIndex < projection.expected.length
      && deepEqual(message, projection.expected[expectedIndex]!.message)) {
      items.push({ message, entryId: projection.expected[expectedIndex]!.entryId });
      expectedIndex += 1;
    } else {
      items.push({ message, entryId: undefined });
    }
  }
  return items;
}

/** The entry ids of the replacement set a state-carried Memory records (#319). */
function replacementEntryIds(memory: StateMemory): ReadonlySet<string> {
  const evict = new Set<string>();
  for (const block of memory.blocks) {
    const retained = new Set(block.retainedEntryIds);
    for (const entry of block.sourceEntries) {
      if (!retained.has(entry.id)) evict.add(entry.id);
    }
  }
  return evict;
}

/** The one complete Memory carrier: one ordered text part per block (#297, #319). */
function memoryCarrierMessage(memory: StateMemory): unknown {
  return {
    role: "custom",
    customType: CONTEXT_MEMORY_BLOCKS_TYPE,
    content: [
      { type: "text", text: MEMORY_SUMMARY_WRAPPER },
      ...memory.blocks.map((block) => ({ type: "text", text: MEMORY_BLOCK_SEPARATOR + block.markdown })),
    ],
    display: false,
    timestamp: memory.carrierTimestamp,
  };
}

/**
 * The fixed continuation sentence every due advisory ends with (#253): the
 * submission is not the run's end — the model answers the user in the same run
 * after the acknowledgement.
 */
const ADVISORY_CONTINUATION_SENTENCE =
  "After the acknowledgement, continue the same run and deliver your answer to the user.";

/** The fixed due advisory body (#319: resident tool, source scope, secret warning). */
const DUE_ADVISORY_TEXT = [
  "Context Memory: compression is due for this conversation.",
  "",
  `Call compact_to_memory_block as the sole tool call of its batch, carrying one concise Markdown Memory block that preserves what matters from the older conversation it covers — goals, decisions, and open work. ${ADVISORY_CONTINUATION_SENTENCE}`,
  "The next request after the acknowledgement will carry that block in place of the covered older conversation; your current request and everything you do for it stay uncompressed.",
  "Do not copy credential values, private keys, access tokens, or other secrets into the Memory block.",
].join("\n");

/**
 * The bounded placeholder a compression tool call's arguments carry once the
 * complete Memory carrier is established in the same request (#319): the body
 * survives in full exactly once, inside the carrier.
 */
const CARRIED_BLOCK_ARGUMENT_PLACEHOLDER = "(this Memory block is carried in full above)";

/**
 * Remove compression-tool artifacts from a provider-bound message list (#215,
 * #253, #319) as whole call/result pairs, never half-pairs:
 *
 * - The current trailing compression call/result pair passes through whole,
 *   accepted or refused: removing it would end the request on an assistant
 *   turn, and a refused result must stay visible for the model to correct
 *   itself. Once the complete Memory carrier is established in the same
 *   request, an accepted trailing call's arguments carry only the bounded
 *   placeholder — the body survives in full exactly once, inside the carrier.
 * - Older accepted pairs survive untouched while no carrier is established:
 *   their arguments are the only request-side copy of the recorded summary,
 *   so dropping either half would orphan the result or silently lose the
 *   body. Once the carrier is established the whole pair drops together.
 * - Refused pairs (error results) always drop together — call part and
 *   result — whether or not a carrier exists; the model already saw and
 *   addressed the refusal, and nothing recorded duplicates the attempt.
 * - A compression call whose result is absent (an aborted batch mid-request)
 *   drops from its assistant message while ordinary text and sibling calls
 *   survive: an unanswered call cannot stay in a provider request.
 *
 * The retired `submit_memory` name filters the same way, so historical
 * protocol calls never re-enter requests. `read_memory_source` artifacts stay
 * visible.
 */
function filterCompressionArtifacts(
  aligned: readonly AlignedMessage[],
  carrierEstablished: boolean,
): unknown[] {
  const messages = aligned.map((item) => item.message);
  const isCompressionResult = (m: unknown): boolean =>
    (m as { role?: unknown; toolName?: unknown } | null)?.role === "toolResult"
    && isCompressionToolResultName((m as { toolName?: unknown }).toolName);
  const hasCompressionCall = (m: unknown): boolean => {
    const record = m as { role?: unknown; content?: unknown } | null;
    return record?.role === "assistant" && Array.isArray(record.content)
      && record.content.some((part) =>
        (part as { type?: unknown; name?: unknown } | null)?.type === "toolCall"
        && isCompressionCallName((part as { name?: unknown }).name));
  };
  // Refused attempts drop as whole pairs; an accepted call needs its paired
  // result present to survive without a carrier.
  const refusedCallIds = new Set<string>();
  const acceptedCallIds = new Set<string>();
  for (const message of messages) {
    if (!isCompressionResult(message)) continue;
    const record = message as { toolCallId?: unknown; isError?: unknown };
    if (typeof record.toolCallId !== "string") continue;
    if (record.isError === true) refusedCallIds.add(record.toolCallId);
    else acceptedCallIds.add(record.toolCallId);
  }

  let keepFrom = messages.length;
  if (messages.length >= 2 && isCompressionResult(messages[messages.length - 1]) && hasCompressionCall(messages[messages.length - 2])) {
    keepFrom = messages.length - 2;
  } else if (messages.length >= 1 && hasCompressionCall(messages[messages.length - 1])) {
    keepFrom = messages.length - 1;
  }

  // The trailing pair's accepted arguments collapse to the bounded
  // placeholder once the carrier carries the body in full; a refused attempt
  // keeps its arguments (nothing recorded duplicates them).
  const stubArguments = (message: unknown): unknown => {
    if (!carrierEstablished) return message;
    const record = message as { role?: unknown; content?: unknown } | null;
    if (record?.role !== "assistant" || !Array.isArray(record.content)) return message;
    if (!hasCompressionCall(message)) return message;
    return {
      ...record,
      content: record.content.map((part) => {
        const candidate = part as { type?: unknown; id?: unknown; name?: unknown } | null;
        if (candidate?.type !== "toolCall" || !isCompressionCallName(candidate.name)) {
          return part;
        }
        if (typeof candidate.id === "string" && refusedCallIds.has(candidate.id)) return part;
        return { ...(part as object), arguments: { markdown: CARRIED_BLOCK_ARGUMENT_PLACEHOLDER } };
      }),
    };
  };

  const filtered: unknown[] = [];
  aligned.forEach((item, index) => {
    const message = item.message;
    if (index >= keepFrom) {
      filtered.push(stubArguments(message));
      return;
    }
    const record = message as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown } | null;
    if (!record) return;
    if (record.role === "toolResult" && isCompressionToolResultName(record.toolName)) {
      if (carrierEstablished || record.isError === true) return;
      // Accepted without a carrier: the result survives, and its paired call
      // part survives below so the pair never splits.
      filtered.push(message);
      return;
    }
    if (record.role === "assistant" && Array.isArray(record.content)) {
      const kept = record.content.filter((part) => {
        const candidate = part as { type?: unknown; id?: unknown; name?: unknown } | null;
        if (candidate?.type !== "toolCall" || !isCompressionCallName(candidate.name)) return true;
        if (typeof candidate.id !== "string") return carrierEstablished;
        if (refusedCallIds.has(candidate.id)) return false;
        if (carrierEstablished) return false;
        // Keep the call only while its accepted result is present in the
        // same request — a call without its result cannot stay paired.
        return acceptedCallIds.has(candidate.id);
      });
      if (kept.length === 0) return;
      if (kept.length !== record.content.length) {
        filtered.push({ ...record, content: kept });
        return;
      }
    }
    filtered.push(message);
  });
  return filtered;
}

function isCompressionToolResultName(name: unknown): boolean {
  return name === COMPACT_MEMORY_TOOL_NAME || name === SUBMIT_MEMORY_TOOL_NAME;
}

function isCompressionCallName(name: unknown): boolean {
  return name === COMPACT_MEMORY_TOOL_NAME || name === SUBMIT_MEMORY_TOOL_NAME;
}

/**
 * Pi's per-message chars/4 estimate with Context Memory protocol artifacts
 * removed, mirroring the provider-bound projection (#215).
 */
function estimateFilteredMessageTokens(message: { role?: unknown; content?: unknown; toolName?: unknown }): number {
  if (message.role === "toolResult") {
    return message.toolName === COMPACT_MEMORY_TOOL_NAME || message.toolName === SUBMIT_MEMORY_TOOL_NAME
      ? 0
      : estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
  }
  if (message.role === "assistant") {
    const content = message.content;
    if (!Array.isArray(content)) return 0;
    const hasCompressionCall = content.some((part) =>
      (part as { type?: unknown; name?: unknown } | null)?.type === "toolCall"
      && ((part as { name?: unknown }).name === COMPACT_MEMORY_TOOL_NAME
        || (part as { name?: unknown }).name === SUBMIT_MEMORY_TOOL_NAME));
    if (!hasCompressionCall) {
      return estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
    }
    const kept = content.filter((part) =>
      (part as { type?: unknown; name?: unknown } | null)?.type !== "toolCall"
      || ((part as { name?: unknown }).name !== COMPACT_MEMORY_TOOL_NAME
        && (part as { name?: unknown }).name !== SUBMIT_MEMORY_TOOL_NAME));
    if (kept.length === 0) return 0;
    return estimateMessageTokens({ ...message, content: kept } as Parameters<typeof estimateMessageTokens>[0]);
  }
  return estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
}

/**
 * The effective due point for the current model (#215, #218): the configured
 * percent/token threshold capped ten percent of the window below Pi's native
 * compaction boundary (window − Pi reserve − ten percent of the window).
 * `null` disables the advisory — a non-positive point, or a Memory budget
 * that is not strictly smaller than the due point.
 */
export function effectiveDuePoint(
  threshold: ContextMemoryThreshold,
  memoryBudgetPercent: number,
  contextWindow: number | null,
  reserveTokens: number,
): number | null {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const configured = "percent" in threshold
    ? Math.round((contextWindow * threshold.percent) / 100)
    : threshold.tokens;
  const nativeBoundary = contextWindow - reserveTokens;
  const safetyClamp = nativeBoundary - Math.round(contextWindow / 10);
  const duePoint = Math.min(configured, safetyClamp);
  if (duePoint <= 0) return null;
  const budgetTokens = Math.round((contextWindow * memoryBudgetPercent) / 100);
  if (budgetTokens >= duePoint) return null;
  return duePoint;
}

/** First non-empty line, whitespace-collapsed, code-point-bounded preview. */
function blockPreview(markdown: string, maximum = 60): string {
  for (const line of markdown.split("\n")) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    const points = Array.from(collapsed);
    return points.length > maximum ? `${points.slice(0, maximum - 1).join("")}…` : collapsed;
  }
  return "(empty block)";
}

/** One resolved page plus its fixed paging metadata. */
interface ResolvedPage {
  readonly pages: readonly string[];
  readonly pageText: string;
  readonly details: ReadMemorySourceDetails;
}

type PageResolution =
  | { readonly kind: "block" }
  | { readonly kind: "page"; readonly totalPages: number }
  | { readonly kind: "ok"; readonly resolved: ResolvedPage };

/** The minimal Pi context surfaces the controller consumes at run boundaries. */
export interface ContextMemoryRunContext {
  readonly sessionManager: MemorySessionReader;
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
}

/** The assistant message's tool-call ids collected by `message_end`. */
interface ToolBatch {
  readonly ids: readonly string[];
}

/**
 * The append source selection on the live branch (#319): one continuous range
 * of eligible entries before the retained working set, ending at a
 * batch-closed boundary, with the latest user instruction as the only
 * retained exception inside the range.
 */
interface AppendSource {
  /** Inclusive range end: the last eligible entry before the retained working set. */
  readonly sourceEndPosition: number;
  /** The latest user instruction inside the range, retained raw in requests. */
  readonly retainedEntryIds: readonly string[];
  /** The working set anchor: the retained region begins at this position. */
  readonly retainedFrom: number;
}

/** The tool calls one assistant message entry carries, as id/name pairs. */
function assistantToolCalls(entry: SessionEntry): readonly { id: string; name: unknown }[] {
  if (entry.type !== "message") return [];
  const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: { id: string; name: unknown }[] = [];
  for (const part of message.content) {
    const candidate = part as { type?: unknown; id?: unknown; name?: unknown } | null;
    if (candidate?.type === "toolCall" && typeof candidate.id === "string") {
      calls.push({ id: candidate.id, name: candidate.name });
    }
  }
  return calls;
}

/**
 * Select the append source for the current branch (#319). The retained
 * working set is the most recent completed ordinary tool batch and everything
 * after it; with no completed ordinary batch it is the latest user
 * instruction and everything after it. The source range ends at the last eligible entry
 * before that boundary, must extend beyond the previous block's end, and must
 * not split a tool batch: every compression tool call inside the range needs
 * its paired result inside the range and vice versa. Returns null when no
 * qualified source exists.
 */
function selectAppendSource(branch: readonly SessionEntry[], previousEndPosition: number): AppendSource | null {
  const resultsByCallId = new Map<string, number>();
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; toolCallId?: unknown } }).message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      resultsByCallId.set(message.toolCallId, i);
    }
  }
  let retainedFrom = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const calls = assistantToolCalls(branch[i]!);
    if (calls.length === 0) continue;
    // Completed Context Memory protocol batches never anchor the working
    // set: they are maintenance bookkeeping, not recent work, and anchoring
    // on them would strand the conversation around them (#319).
    if (calls.every((call) => isProtocolToolName(call.name))) continue;
    if (calls.every((call) => {
      const position = resultsByCallId.get(call.id);
      return position !== undefined && position > i;
    })) {
      retainedFrom = i;
      break;
    }
  }
  if (retainedFrom === -1) {
    for (let i = branch.length - 1; i >= 0; i--) {
      if (isUserMessageEntry(branch[i]!)) {
        retainedFrom = i;
        break;
      }
    }
  }
  if (retainedFrom === -1) return null;
  let sourceEndPosition = -1;
  for (let i = retainedFrom - 1; i > previousEndPosition; i--) {
    if (isEligibleSourceEntry(branch[i]!)) {
      sourceEndPosition = i;
      break;
    }
  }
  if (sourceEndPosition <= previousEndPosition) return null;
  // Batch integrity inside the range: every tool call paired inside, every
  // result belonging to a call inside. An orphan in the range refuses the
  // compression rather than dropping messages to force a fit (#319).
  const rangeCalls = new Map<string, number>();
  const rangeResults = new Map<string, number>();
  for (let i = previousEndPosition + 1; i <= sourceEndPosition; i++) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown; toolCallId?: unknown } }).message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        const candidate = part as { type?: unknown; id?: unknown } | null;
        if (candidate?.type === "toolCall" && typeof candidate.id === "string") rangeCalls.set(candidate.id, i);
      }
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      rangeResults.set(message.toolCallId, i);
    }
  }
  for (const [id, position] of rangeCalls) {
    const result = rangeResults.get(id);
    if (result === undefined || result > sourceEndPosition || result < previousEndPosition) return null;
    void position;
  }
  for (const id of rangeResults.keys()) {
    if (!rangeCalls.has(id)) return null;
  }
  const retainedEntryIds: string[] = [];
  for (let i = branch.length - 1; i > previousEndPosition; i--) {
    if (isUserMessageEntry(branch[i]!)) {
      if (i <= sourceEndPosition) retainedEntryIds.push(branch[i]!.id);
      break;
    }
  }
  return { sourceEndPosition, retainedEntryIds, retainedFrom };
}

export class ContextMemoryController {
  private readonly config: ContextMemoryConfig;
  private readonly support: HostSupport;
  private current: CurrentMemory;
  /** Whether the current session is ephemeral (in-memory, unpersisted) (#221). */
  private ephemeralSession = false;
  /** The Memory identity the active `read_memory_source` window was opened against. */
  private activeMemoryId: string | undefined;
  /** Pi's configured compaction reserve, captured at session start (#218). */
  private reserveTokens: number = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  /** The model window the current due point was computed against. */
  private modelWindow: number | null = null;
  /** Whether the raw branch sits at or above the due point (display only). */
  private due = false;
  /** The state entry whose carrier has been applied to at least one request (#319). */
  private appliedStateEntryId: string | undefined;
  /** The most recent served request boundary: what actually reached the model (#319). */
  private served: ServedBoundary | undefined;
  /** Tool-call ids of the most recent assistant message (#319 sole-call check). */
  private lastToolBatch: ToolBatch | undefined;

  constructor(options: ContextMemoryControllerOptions) {
    this.config = options.config;
    this.support = options.support;
    this.current = { kind: "none" };
  }

  get hostSupport(): HostSupport {
    return this.support;
  }

  get memoryConfig(): ContextMemoryConfig {
    return this.config;
  }

  /** Current derivation, refreshed by {@link refresh} at session boundaries. */
  get derived(): CurrentMemory {
    return this.current;
  }

  /**
   * Read-only view snapshot; Prompt Manager renders it as `/context` `memory[]`.
   * `active` distinguishes Memory that has been recorded from Memory whose
   * carrier has already been applied to a request in this session (#319).
   */
  snapshot(usage?: ContextMemoryUsageInput): ContextMemorySnapshot {
    if (!this.config.enabled) return { state: "disabled" };
    if (!this.support.supported) return { state: "unsupported", reason: this.support.reason };
    if (this.current.kind === "none") return this.markEphemeral(this.due ? { state: "due" } : { state: "no-memory" });
    if (this.current.kind === "opaque") return this.markEphemeral({ state: "opaque" });
    return this.markEphemeral(this.activeSnapshot(this.current, usage));
  }

  /**
   * Mark snapshots derived on an ephemeral in-memory session (#221): the
   * feature runs identically there, `/context` reports it, and nothing is
   * written. Readers that do not expose persistence are treated as persisted.
   */
  private markEphemeral<T extends { readonly state: string; readonly ephemeral?: true }>(snapshot: T): T {
    return { ...snapshot, ...(this.ephemeralSession ? { ephemeral: true } : {}) };
  }

  /** Re-derive current Memory from the live session tree. */
  refresh(session: MemorySessionReader): void {
    this.ephemeralSession = session.isPersisted?.() === false;
    this.current = deriveCurrentMemory(session);
  }

  /**
   * Synchronize the owned active-tool names while preserving every other
   * active tool selected by Pi or another pi-square module. Since #319,
   * `compact_to_memory_block` is resident: active exactly while the feature is
   * enabled on a supported host — thresholds and previous submissions never
   * change the tool set. `read_memory_source` stays active exactly while
   * enabled on a supported host with strictly valid non-empty current Memory
   * (#217). Returns the owned names removed from the active list.
   */
  synchronizeActiveTools(
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
    session: MemorySessionReader,
  ): readonly string[] {
    this.refresh(session);
    const active = pi.getActiveTools();
    const removed = active.filter((name) => OWNED_TOOL_NAME_SET.has(name));
    const desired = active.filter((name) => !OWNED_TOOL_NAME_SET.has(name));
    const compactActive = this.config.enabled && this.support.supported;
    const readActive = this.config.enabled
      && this.support.supported
      && this.current.kind === "valid"
      && this.current.blocks.length > 0;
    if (compactActive) desired.push(COMPACT_MEMORY_TOOL_NAME);
    if (readActive) desired.push(READ_MEMORY_SOURCE_TOOL_NAME);
    this.activeMemoryId = readActive && this.current.kind === "valid"
      ? memoryIdentity(this.current)
      : undefined;
    const changed = active.length !== desired.length || active.some((name, index) => name !== desired[index]);
    if (changed) pi.setActiveTools(desired);
    return removed;
  }

  // ── #319: due detection, recording, and the request projection ──

  /** Whether the feature is enabled on a supported host. */
  private operational(): boolean {
    return this.config.enabled && this.support.supported;
  }

  /** Capture Pi's compaction reserve for the pre-native safety clamp. */
  adoptRuntime(reserveTokens: number): void {
    this.reserveTokens = reserveTokens;
  }

  /**
   * The deterministic projection estimate over the current branch (#319):
   * Pi's own projection, the Memory application (eviction plus carrier), and
   * protocol-artifact filtering — measured per message with Pi's estimator so
   * pressure reflects the request the model will actually see, never a stale
   * pre-compression usage number.
   */
  private projectedRequestTokens(session: MemorySessionReader): number | null {
    try {
      const projection = nativeProjection(session);
      const memory = deriveCurrentMemory(session);
      const aligned = alignMessages(projection.expected.map((item) => item.message), projection);
      const applied = this.applyMemoryProjection(aligned, projection, memory, false);
      // Mirrors the transform fallback: without an applicable state carrier
      // the estimate still applies protocol-artifact filtering.
      const messages = applied ?? filterCompressionArtifacts(aligned, v1CarrierPresent(aligned, projection));
      let total = 0;
      for (const message of messages) {
        total += estimateFilteredMessageTokens(message as { role?: unknown; content?: unknown; toolName?: unknown });
      }
      return total;
    } catch {
      return null;
    }
  }

  /**
   * Recompute the in-memory due flag for display and budget gating (#215,
   * #319). The estimate is projection-aware: recorded Memory evicts its
   * covered sources before the pressure is judged, so an accepted compression
   * relieves pressure immediately instead of waiting for a stale usage anchor.
   */
  recomputeDue(ctx: ContextMemoryRunContext): void {
    this.refresh(ctx.sessionManager);
    this.due = false;
    this.modelWindow = null;
    if (!this.operational()) return;
    const usage = ctx.getContextUsage();
    const contextWindow = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : null;
    const duePoint = effectiveDuePoint(
      this.config.compressionThreshold,
      this.config.memoryBudgetPercent,
      contextWindow,
      this.reserveTokens,
    );
    if (duePoint === null) return;
    this.modelWindow = contextWindow;
    const estimate = this.projectedRequestTokens(ctx.sessionManager);
    this.due = estimate !== null && estimate >= duePoint;
  }

  /**
   * Record the tool-call ids of the most recent assistant message so
   * `compact_to_memory_block` can refuse a batch it does not solely occupy
   * (#319).
   */
  noteAssistantToolBatch(message: unknown): void {
    const record = message as { role?: unknown; content?: unknown } | null | undefined;
    if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return;
    const ids: string[] = [];
    for (const part of record.content) {
      const candidate = part as { type?: unknown; id?: unknown } | null;
      if (candidate?.type === "toolCall" && typeof candidate.id === "string") ids.push(candidate.id);
    }
    this.lastToolBatch = { ids };
  }

  /**
   * Execute one `compact_to_memory_block` call (#319): validate the sole tool
   * call, the block body, the append capacity, the source range, batch
   * pairing, budgets, and the net benefit, then record the versioned state
   * entry through Pi's public custom-entry seam. The fixed acknowledgement
   * says the Memory is recorded — it never claims a future request already
   * carried it. The run continues; the next ordinary request applies the
   * projection. Throws one safe short-coded sentence and never echoes
   * Markdown.
   */
  async compactToBlock(
    markdown: string,
    toolCallId: string,
    session: MemorySessionReader,
    recording: MemoryRecordingContext,
  ): Promise<AgentToolResult<CompactMemoryDetails>> {
    if (!this.operational()) {
      fail("COMPACT_NOT_AVAILABLE", "Context Memory compression is not available in this session");
    }
    const batch = this.lastToolBatch;
    if (batch === undefined || !batch.ids.includes(toolCallId) || batch.ids.length > 1) {
      fail("COMPACT_NOT_SOAL_TOOL", "compact_to_memory_block must be the sole tool call in its batch");
    }
    if (!isValidMemoryBlockBody(markdown)) {
      fail("BOUND_EXCEEDED", "the Memory block body exceeds the size or content bounds");
    }
    const candidate = this.bindAppend(markdown, session);
    recording.appendEntry(MEMORY_STATE_CUSTOM_TYPE, candidate.state);
    // `appendEntry` writes synchronously through the SessionManager as a
    // child of the current leaf, so the leaf is the recorded state entry;
    // confirm before acknowledging so a silent no-write never reports success.
    const leafId = session.getLeafId?.() ?? null;
    const leaf = leafId === null ? undefined : session.getBranch(leafId).at(-1);
    if (!leaf || (leaf as { customType?: unknown }).customType !== MEMORY_STATE_CUSTOM_TYPE) {
      fail("MEMORY_CHANGED", "the recorded Memory state entry is not visible on the current branch");
    }
    this.current = deriveCurrentMemory(session);
    this.appliedStateEntryId = undefined;
    return {
      content: [{ type: "text", text: "Memory block recorded. The next model request will carry it in place of the covered older conversation." }],
      details: { recorded: true },
    };
  }

  /**
   * Resolve the append binding against the live branch, or refuse safely:
   * the continuous source range before the retained working set, batch
   * pairing by call id, the latest user instruction as the retained
   * exception, the byte-stable prefix from the current carrier, and the
   * single-block, total-Memory, and serialization budgets (#319).
   */
  private bindAppend(markdown: string, session: MemorySessionReader): { state: MemoryStateData } {
    const leafId = session.getLeafId?.() ?? null;
    if (leafId === null) {
      fail("MEMORY_CHANGED", "the current branch no longer carries this session");
    }
    const branch = [...session.getBranch(leafId)];
    const current = deriveCurrentMemory(session);
    if (current.kind === "opaque") {
      fail("MEMORY_CHANGED", "current Memory is no longer valid structured Context Memory");
    }
    const prefix: MemoryStateBlock[] = [];
    let previousEndPosition = -1;
    let baseCompactionId: string | undefined;
    if (current.kind === "valid") {
      const markdowns = current.blocks.map((block) => block.markdown);
      const halfBudget = this.halfBudgetTokens();
      if (halfBudget !== null && renderedMemoryTokens(markdowns) > halfBudget) {
        fail("MAINTENANCE_PENDING", "rendered Memory is above half its budget; the next operation is a suffix rebuild, which is not available yet");
      }
      const lastEnd = current.blocks[current.blocks.length - 1]!.endEntryId;
      previousEndPosition = branch.findIndex((entry) => entry.id === lastEnd);
      if (previousEndPosition === -1) {
        fail("MEMORY_CHANGED", "the existing Memory blocks no longer resolve on the current branch");
      }
      for (const block of current.blocks) {
        prefix.push({ endEntryId: block.endEntryId, markdown: block.markdown, retainedEntryIds: [...block.retainedEntryIds] });
      }
      // The base stays stable across appends: the compaction the first state
      // entry recorded, kept by every later one.
      baseCompactionId = current.compactionId;
    }
    const source = selectAppendSource(branch, previousEndPosition);
    if (source === null) {
      fail("COMPACT_NOT_DUE", "no completed eligible conversation is available to compress since the existing Memory blocks");
    }
    const newBlock: MemoryStateBlock = {
      endEntryId: branch[source.sourceEndPosition]!.id,
      markdown,
      retainedEntryIds: source.retainedEntryIds,
    };
    const blocks = [...prefix, newBlock];
    const state: MemoryStateData = { format: MEMORY_STATE_FORMAT_TAG, blocks, ...(baseCompactionId !== undefined ? { baseCompactionId } : {}) };
    if (parseMemoryState(state) === undefined) {
      fail("BOUND_EXCEEDED", "the Memory state entry exceeds the persisted format bounds");
    }
    const contextWindow = this.windowForBudget();
    if (estimateTextTokens(composeMemorySummary(blocks.map((block) => block.markdown))) > Math.round((contextWindow * this.config.memoryBudgetPercent) / 100)) {
      fail("BOUND_EXCEEDED", "the Memory blocks exceed the configured Memory budget");
    }
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MEMORY_DETAILS_MAX_BYTES) {
      fail("BOUND_EXCEEDED", "the Memory state entry exceeds the persisted format bounds");
    }
    // Net benefit on the projected request (#319): the evicted source tokens
    // minus the carrier DELTA the request actually gains. An append onto
    // existing Memory only adds one new block part to the carrier already in
    // the request; the unchanged prefix is never charged again. Retained
    // protected instructions never count as savings.
    const evictable = branch
      .slice(previousEndPosition + 1, source.sourceEndPosition + 1)
      .filter((entry) => isEligibleSourceEntry(entry) && !source.retainedEntryIds.includes(entry.id));
    // Serving proof (#319): every eviction target must have reached the model
    // in its current native form in the most recent observed request on this
    // branch. An upstream transform that replaced or removed a source entry
    // removes it from the served boundary, and the compression refuses rather
    // than claiming to replace text the model never saw — or text the
    // eviction would not actually remove from the current request.
    const served = this.served;
    if (served === undefined
      || served.leafId === null
      || !branch.some((entry) => entry.id === served.leafId)
      || evictable.some((entry) => !served.entryIds.has(entry.id))) {
      fail("SOURCE_NOT_SERVED", "the covered conversation has not reached the model in its current form; cannot prove it as compression source");
    }
    const carrierDelta = current.kind === "valid"
      ? estimateTextTokens(MEMORY_BLOCK_SEPARATOR + markdown)
      : estimateTextTokens(composeMemorySummary([markdown]));
    let savings = -carrierDelta;
    for (const entry of evictable) {
      for (const message of sessionEntryToContextMessages(entry)) {
        savings += estimateFilteredMessageTokens(message as { role?: unknown; content?: unknown; toolName?: unknown });
      }
    }
    if (savings <= 0) {
      fail("NO_NET_BENEFIT", "the Memory block would not reduce the next model request");
    }
    return { state };
  }

  /** The model window the current budget was computed against. */
  private windowForBudget(): number {
    if (this.modelWindow === null) {
      fail("COMPACT_NOT_DUE", "no model context window is available for the Memory budget");
    }
    return this.modelWindow;
  }

  /** Half the configured Memory budget in tokens; null when the window is unknown. */
  private halfBudgetTokens(): number | null {
    if (this.modelWindow === null) return null;
    return Math.round((this.modelWindow * this.config.memoryBudgetPercent) / 100) / 2;
  }

  /**
   * The ephemeral `context` transform (#215, #218, #297, #319). It never
   * throws and never blocks the request: any failure leaves the unmodified
   * context in place with the custom application skipped.
   *
   * - Recorded state-carried Memory is applied to the request (#319): the
   *   covered, non-retained original messages leave, the one complete Memory
   *   carrier enters at the eviction boundary (or replaces the base
   *   compaction's summary message), and the retained working set stays
   *   whole. Application requires reliable message-to-entry alignment; any
   *   upstream deletion or modification that breaks the mapping refuses the
   *   application rather than guessing or resurrecting filtered history.
   * - Compression-tool artifacts leave the request under the carrier rule of
   *   {@link filterCompressionArtifacts}; `read_memory_source` artifacts stay
   *   visible.
   * - Compaction-carried v1 Memory keeps its read-only baseline behavior: the
   *   native summary message stays and is re-projected as one ordered text
   *   block per block (#297).
   * - While the projected request sits at or above the due point, one fixed
   *   advisory is inserted after the current user message and never persists
   *   or accumulates (#319).
   */
  transformContext(
    event: { readonly messages: readonly unknown[] },
    session: MemorySessionReader,
    usage?: { tokens: number | null; contextWindow: number } | undefined,
  ): { messages: readonly unknown[] } | undefined {
    if (!this.operational()) return undefined;
    const original = event.messages;
    try {
      const projection = nativeProjection(session);
      const aligned = alignMessages(original, projection);
      // The alignment is the served boundary (#319): these native messages
      // reached the transform in their current form, whatever upstream
      // transforms did to the rest. Acceptance later refuses to cover a
      // source entry this boundary never observed.
      this.served = {
        leafId: session.getLeafId?.() ?? null,
        entryIds: new Set(aligned.flatMap((item) => (item.entryId === undefined ? [] : [item.entryId]))),
      };
      let messages = this.applyMemoryProjection(aligned, projection, deriveCurrentMemory(session), true);
      if (messages === undefined) {
        // Alignment could not map every eviction target to its source entry:
        // apply no custom projection and keep protocol history intact.
        messages = filterCompressionArtifacts(
          aligned,
          v1CarrierPresent(aligned, projection),
        );
      }
      messages = this.projectV1Blocks(messages, session);
      // Due is judged on the projected request itself, never on a stale
      // pre-compression usage anchor: a recorded compression relieves
      // pressure as soon as it applies (#319).
      const window = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : this.modelWindow;
      const duePoint = window === null || window === undefined
        ? null
        : effectiveDuePoint(this.config.compressionThreshold, this.config.memoryBudgetPercent, window, this.reserveTokens);
      if (duePoint !== null) {
        this.modelWindow ??= window;
        let total = 0;
        for (const message of messages) {
          total += estimateFilteredMessageTokens(message as { role?: unknown; content?: unknown; toolName?: unknown });
        }
        this.due = total >= duePoint;
        if (this.due && this.appendAdvisoryAllowed()) {
          const insertAfter = findLastIndexOf(messages, (message) =>
            (message as { role?: unknown } | null)?.role === "user");
          if (insertAfter !== -1) {
            const next = [...messages];
            next.splice(insertAfter + 1, 0, {
              role: "custom",
              customType: CONTEXT_MEMORY_ADVISORY_TYPE,
              content: DUE_ADVISORY_TEXT,
              display: false,
              timestamp: Date.now(),
            });
            messages = next;
          }
        }
      }
      return { messages };
    } catch {
      return undefined;
    }
  }

  /** Whether the advisory may ask for an append right now (#319). */
  private appendAdvisoryAllowed(): boolean {
    if (this.current.kind === "opaque") return false;
    if (this.current.kind === "none") return true;
    const halfBudget = this.halfBudgetTokens();
    if (halfBudget === null) return false;
    const markdowns = this.current.blocks.map((block) => block.markdown);
    return renderedMemoryTokens(markdowns) <= halfBudget;
  }

  /**
   * Apply state-carried Memory to one aligned request (#319). Returns the
   * projected messages, or undefined when the application must refuse: an
   * eviction target or the base compaction summary that the incoming messages
   * cannot reliably map, or a request that carries no position for the
   * carrier. Refusal keeps the unmodified request and never partially
   * applies.
   */
  private applyMemoryProjection(
    aligned: readonly AlignedMessage[],
    projection: NativeProjection,
    memory: CurrentMemory,
    recordApplication: boolean,
  ): unknown[] | undefined {
    if (memory.kind !== "valid" || memory.carrier !== "state") return undefined;
    const evict = replacementEntryIds(memory);
    const retained = new Set<string>();
    for (const block of memory.blocks) {
      for (const id of block.retainedEntryIds) retained.add(id);
    }
    // Every eviction target the native projection carries must be mapped;
    // an unmapped target means an upstream transform changed it and the
    // application refuses rather than guessing.
    const mappedEntryIds = new Set<string>();
    for (const item of aligned) {
      if (item.entryId !== undefined) mappedEntryIds.add(item.entryId);
    }
    for (const id of evict) {
      if (projection.carriedEntryIds.has(id) && !mappedEntryIds.has(id)) return undefined;
    }
    const carrier = memoryCarrierMessage(memory);
    const out: unknown[] = [];
    let carrierPlaced = false;
    const baseSummaryId = memory.compactionId;
    for (const item of aligned) {
      if (item.entryId !== undefined && evict.has(item.entryId)) {
        if (!carrierPlaced) {
          out.push(carrier);
          carrierPlaced = true;
        }
        continue;
      }
      if (item.entryId !== undefined && baseSummaryId !== undefined && item.entryId === baseSummaryId) {
        out.push(carrier);
        carrierPlaced = true;
        continue;
      }
      out.push(item.message);
    }
    if (!carrierPlaced) return undefined;
    if (recordApplication) this.appliedStateEntryId = memory.stateEntryId;
    return filterCompressionArtifacts(
      out.map((message) => ({ message, entryId: undefined }) as AlignedMessage),
      true,
    );
  }

  /**
   * The uniform multi-block projection for compaction-carried v1 Memory
   * (#297): when the request carries exactly the composed rendering of its
   * blocks, replace that summary message with one ordered text content block
   * per block. Any other request shape keeps the ordinary unmodified
   * compaction summary message. State-carried Memory already replaced any
   * base summary with its own carrier, so the two carriers never coexist.
   */
  private projectV1Blocks(messages: readonly unknown[], session: MemorySessionReader): unknown[] {
    let current: CurrentMemory;
    try {
      current = deriveCurrentMemory(session);
    } catch {
      return [...messages];
    }
    if (current.kind !== "valid" || current.carrier !== "compaction") return [...messages];
    const markdowns = current.blocks.map((block) => block.markdown);
    const projected = projectMemoryBlocksMessage(messages, [{ summary: composeMemorySummary(markdowns), bodies: markdowns }]);
    return projected ?? [...messages];
  }

  // ── #217: source recovery and human inspection (unchanged contract) ──

  /**
   * Execute one `read_memory_source` call: re-derive and revalidate current
   * Memory against the live session, then return one fixed 16 KiB page of the
   * block's source transcript. Throws one safe sentence beginning with a
   * stable short code; never echoes Memory Markdown, ranges, or identifiers.
   */
  async readSource(
    request: ReadMemorySourceRequest,
    session: MemorySessionReader,
  ): Promise<AgentToolResult<ReadMemorySourceDetails>> {
    if (!this.config.enabled || !this.support.supported) {
      fail("MEMORY_NOT_AVAILABLE", NO_MEMORY_SENTENCE);
    }
    const memory = deriveCurrentMemory(session);
    if (memory.kind !== "valid") fail("MEMORY_NOT_AVAILABLE", NO_MEMORY_SENTENCE);
    const identity = memoryIdentity(memory);
    if (this.activeMemoryId === undefined || identity !== this.activeMemoryId) {
      if (this.activeMemoryId !== undefined) {
        fail("MEMORY_CHANGED", "current Memory changed since the tool became active; re-read the current block list");
      }
      fail("MEMORY_NOT_AVAILABLE", NO_MEMORY_SENTENCE);
    }
    const resolution = this.resolvePage(memory, request);
    if (resolution.kind !== "ok") {
      switch (resolution.kind) {
        case "block": fail("BLOCK_OUT_OF_RANGE", "block position is outside the current Memory block list");
        default: fail("PAGE_OUT_OF_RANGE", "page is outside the block's source transcript");
      }
    }
    const { resolved } = resolution;
    const content: { type: "text"; text: string }[] = [
      {
        type: "text",
        text: `Memory source · block ${resolved.details.block} of ${resolved.details.totalBlocks}`
          + ` · page ${resolved.details.page} of ${resolved.details.totalPages}`,
      },
      { type: "text", text: resolved.pageText },
    ];
    if (resolved.details.hasMore) {
      content.push({
        type: "text",
        text: `Next page: read_memory_source({ "block": ${resolved.details.block}, "page": ${resolved.details.page + 1} })`,
      });
    }
    return { content, details: resolved.details };
  }

  /**
   * Read-only human inspection for `/context memory <block> [page]`: the
   * block's full Markdown plus one source page, rendered from the same
   * transcript and paging as the model tool. Performs no model call and no
   * session write; refusals return one safe sentence.
   */
  inspect(
    request: { readonly block: number; readonly page: number },
    session: MemorySessionReader,
  ): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly sentence: string } {
    if (!this.config.enabled || !this.support.supported) {
      return { ok: false, sentence: "No valid Context Memory is available on the current branch." };
    }
    const memory = deriveCurrentMemory(session);
    if (memory.kind !== "valid") {
      return { ok: false, sentence: "No valid Context Memory is available on the current branch." };
    }
    if (this.activeMemoryId !== undefined && memoryIdentity(memory) !== this.activeMemoryId) {
      return { ok: false, sentence: "Memory changed; open /context to see the current block list." };
    }
    const resolution = this.resolvePage(memory, request);
    switch (resolution.kind) {
      case "block":
        return { ok: false, sentence: `Block ${request.block} is outside the current Memory block list (1–${memory.blocks.length}).` };
      case "page":
        return { ok: false, sentence: `Page ${request.page} is outside this block's source pages (1–${resolution.totalPages}).` };
      case "ok": {
        const { resolved } = resolution;
        const lines: string[] = [
          `✓ Context Memory · block ${resolved.details.block} of ${resolved.details.totalBlocks}`
            + ` · source page ${resolved.details.page} of ${resolved.details.totalPages}`,
          "",
          memory.blocks[resolved.details.block - 1]!.markdown,
          "",
          `│  source · page ${resolved.details.page} of ${resolved.details.totalPages}`,
        ];
        for (const line of resolved.pageText.split("\n")) lines.push(`│  ${line}`);
        lines.push("│");
        lines.push("│  read-only · current session only · visible in terminal scrollback");
        if (resolved.details.hasMore) {
          lines.push(`│  next page: /context memory ${resolved.details.block} ${resolved.details.page + 1}`);
        }
        return { ok: true, text: lines.join("\n") };
      }
    }
  }

  private resolvePage(
    memory: ValidMemory,
    request: ReadMemorySourceRequest,
  ): PageResolution {
    const totalBlocks = memory.blocks.length;
    if (request.block < 1 || request.block > totalBlocks || !Number.isInteger(request.block)) {
      return { kind: "block" };
    }
    const block = memory.blocks[request.block - 1]!;
    const pages = paginateTranscript(renderSourceTranscript(block.sourceEntries));
    if (pages.length === 0 || request.page < 1 || request.page > pages.length || !Number.isInteger(request.page)) {
      return { kind: "page", totalPages: pages.length };
    }
    const page = request.page;
    return {
      kind: "ok",
      resolved: {
        pages,
        pageText: pages[page - 1]!,
        details: {
          block: request.block,
          totalBlocks,
          page,
          totalPages: pages.length,
          hasMore: page < pages.length,
        },
      },
    };
  }

  private activeSnapshot(
    memory: ValidMemory,
    usage: ContextMemoryUsageInput | undefined,
  ): ContextMemorySnapshot {
    const markdowns = memory.blocks.map((block) => block.markdown);
    const blockTokens = memory.blocks.map((block) => estimateTextTokens(block.markdown));
    const memoryTokens = renderedMemoryTokens(markdowns);
    const window = usage?.contextWindow;
    const budgetTokens = typeof window === "number" && window > 0
      ? Math.round((window * this.config.memoryBudgetPercent) / 100)
      : null;

    const rows: ContextMemoryBlockRow[] = [];
    for (let i = 0; i < memory.blocks.length && rows.length < CONTEXT_MEMORY_MAX_VIEW_ROWS; i++) {
      const block: DerivedMemoryBlock = memory.blocks[i]!;
      rows.push({
        preview: blockPreview(block.markdown),
        tokens: blockTokens[i]!,
        sources: block.sourceEntries.length,
      });
    }

    return {
      state: "active",
      carrier: memory.carrier,
      applied: memory.carrier === "state" && memory.stateEntryId === this.appliedStateEntryId,
      blocks: memory.blocks.length,
      rows,
      memoryTokens,
      budgetTokens,
      currentTokens: usage && typeof usage.tokens === "number" ? usage.tokens : null,
      contextWindow: typeof window === "number" && window > 0 ? window : null,
    };
  }
}

/** The minimal Pi surface the active-tool synchronization consumes. */
export interface ExtensionAPIForTools {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

/** The stable identity of one valid Memory derivation (#319). */
function memoryIdentity(memory: ValidMemory): string {
  return memory.carrier === "state" ? memory.stateEntryId : memory.compactionId!;
}

/** Last index satisfying the predicate, or -1. */
function findLastIndexOf(messages: readonly unknown[], predicate: (message: unknown) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (predicate(messages[i])) return i;
  }
  return -1;
}

/** Whether an aligned request carries a v1 compaction summary message. */
function v1CarrierPresent(aligned: readonly AlignedMessage[], projection: NativeProjection): boolean {
  return aligned.some((item, index) => {
    void index;
    if (item.entryId === undefined) return false;
    const entry = projection.entries.find((candidate) => candidate.id === item.entryId);
    return entry?.type === "compaction";
  });
}

/**
 * The uniform provider-bound v1 Memory projection (#297): one ordered text
 * content block per current Memory block, for every model and provider, with
 * no provider branch and no cache field or breakpoint of any kind.
 *
 * The request's carrying `compactionSummary` message — the one whose summary
 * byte-matches a candidate exactly — is replaced in place by one ephemeral
 * custom message (`pi-square.context-memory/blocks`, non-display) whose text
 * parts are, in order: the exact leading text Pi renders before the wrapper
 * followed by the fixed wrapper, then one part per block carrying the fixed
 * separator plus that block's body, then the exact trailing text Pi renders
 * after the summary. The concatenated model-visible text is therefore
 * byte-identical to Pi's own rendering of the original message — the framing
 * literals are recovered through Pi's own `convertToLlm` rather than
 * duplicated — and the per-block parts are byte-stable across an append:
 * appending a block inserts one new part before the trailing part and leaves
 * every earlier part untouched.
 *
 * Fail-safe by construction: a request carrying no compaction summary, more
 * than one compaction summary, no candidate matching the carried summary, an
 * invalid or ambiguous rendering, or a reconstruction whose concatenation
 * does not equal Pi's own rendering returns `undefined` and the caller keeps
 * the ordinary unmodified compaction summary message — native and opaque
 * summaries are never touched.
 */
export function projectMemoryBlocksMessage(
  messages: readonly unknown[],
  candidates: readonly MemoryBlocksCandidate[],
): unknown[] | undefined {
  // Pi projects at most one compactionSummary message per request. Zero (no
  // Memory in the request) or more than one (a foreign or duplicated summary
  // beside ours) is an abnormal request shape, and the projection refuses
  // instead of guessing which message to replace (#297 review finding 6).
  const summaryIndex = messages.findIndex((message) => {
    const record = message as { role?: unknown } | null;
    return record?.role === "compactionSummary";
  });
  if (summaryIndex === -1) return undefined;
  if (messages.findIndex((message, index) =>
    index > summaryIndex && (message as { role?: unknown } | null)?.role === "compactionSummary") !== -1) {
    return undefined;
  }
  const summary = (messages[summaryIndex] as { summary?: unknown }).summary;
  const candidate = candidates.find((item) => item.summary === summary);
  if (candidate === undefined) return undefined;
  const projected = memoryBlocksParts(messages[summaryIndex], candidate);
  if (projected === undefined) return undefined;
  const next = [...messages];
  next[summaryIndex] = projected;
  return next;
}

/**
 * One candidate rendering the request's Memory summary message may carry:
 * the exact composed summary plus the ordered block bodies it unpacks into.
 */
export interface MemoryBlocksCandidate {
  readonly summary: string;
  readonly bodies: readonly string[];
}

/**
 * Build the replacement blocks message for one carrying summary message.
 * The framing literals are sliced from Pi's own rendering of that exact
 * message, and the parts' concatenation is re-verified against it before the
 * message is used, so no framing assumption is ever trusted blindly. The
 * rendering must be exactly one message carrying exactly one text part —
 * anything else is a drifted or unexpected host shape and refuses rather
 * than reading a partial rendering (#297 review finding 6). Exported as the
 * pure seam the ambiguity tests drive; production reaches it only through
 * {@link projectMemoryBlocksMessage}.
 */
export function memoryBlocksParts(
  message: unknown,
  candidate: MemoryBlocksCandidate,
): unknown | undefined {
  const convertToLlm = PiCodingAgent.convertToLlm;
  if (typeof convertToLlm !== "function") return undefined;
  let rendered: readonly unknown[];
  try {
    rendered = convertToLlm([message as Parameters<typeof convertToLlm>[0][number]]);
  } catch {
    return undefined;
  }
  if (rendered.length !== 1) return undefined;
  const first = rendered[0] as { content?: unknown } | null | undefined;
  if (!first || !Array.isArray(first.content) || first.content.length !== 1) return undefined;
  const textPart = first.content[0] as { type?: unknown; text?: unknown } | null | undefined;
  if (!textPart || textPart.type !== "text" || typeof textPart.text !== "string") return undefined;
  const wrapperStart = textPart.text.indexOf(MEMORY_SUMMARY_WRAPPER);
  if (wrapperStart < 0) return undefined;
  const summaryEnd = wrapperStart + candidate.summary.length;
  if (textPart.text.slice(wrapperStart, summaryEnd) !== candidate.summary) return undefined;
  const partTexts = [
    textPart.text.slice(0, wrapperStart) + MEMORY_SUMMARY_WRAPPER,
    ...candidate.bodies.map((body) => MEMORY_BLOCK_SEPARATOR + body),
    textPart.text.slice(summaryEnd),
  ];
  if (partTexts.join("") !== textPart.text) return undefined;
  return {
    role: "custom",
    customType: CONTEXT_MEMORY_BLOCKS_TYPE,
    content: partTexts.map((part) => ({ type: "text", text: part })),
    display: false,
    timestamp: (message as { timestamp?: unknown }).timestamp,
  };
}
