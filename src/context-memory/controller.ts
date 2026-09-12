import type { AgentToolResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMPACTION_SETTINGS,
  buildContextEntries,
  estimateTokens as estimateMessageTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { deriveCurrentMemory, isEligibleSourceEntry, isProtocolToolName, isUserMessageEntry, type CurrentMemory, type DerivedMemoryBlock, type MemorySessionReader, type ValidMemory } from "./derive";
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
import {
  type MaintenanceFailures,
  type MaintenanceRequest,
  maintenanceSuppressed,
  noteMaintenanceFailure,
  sameMaintenanceScope,
} from "./maintenance";
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
  type ContextMemoryArbitrationInfo,
  type ContextMemoryBlockRow,
  type ContextMemoryMaintenanceInfo,
  type ContextMemoryPressureInfo,
  type ContextMemorySnapshot,
} from "./view";

/**
 * The session-scoped Context Memory controller (odradekk/pi-square#215, #216,
 * #217, #319, #320, #321).
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
 * #320 adds sustained maintenance inside one long task: pressure is judged on
 * every ordinary request (never only at user input or settle), one pending
 * maintenance request pins the exact append sources the advisory invites, and
 * later tool work extends coverage only through an explicit re-scope at a
 * request boundary where the new sources are served. Repeated refused,
 * invalid, or zero-benefit attempts against one pinned scope suppress the
 * advisory (bounded, with the specific refusal kept); real growth or a Memory state
 * change re-enables evaluation without waiting for the next user input.
 * Provider usage is bound to the request and Memory version it measured: the
 * deterministic request estimate directly counts messages, the system prompt,
 * and active tool definitions, plus a bounded provider residual for comparable
 * request compositions. Thus a pre-compression report never floors
 * post-compression pressure and an
 * accepted compression rebuilds the baseline through the next estimate.
 *
 * #321 extends the same maintenance machine with the suffix rebuild: while
 * rendered Memory sits above half its budget, the pending request replaces
 * the shortest newest adjacent block suffix (never recursive summaries), the
 * request projection keeps serving that suffix's complete original sources
 * while its summaries are absent, acceptance records one new block spanning
 * the suffix's originals plus the new eligible history with every retained
 * exception of the replaced blocks kept raw, and a rebuild whose complete
 * request cannot fit the window stays a reported `scale-limit` instead of
 * truncating, paging, or deleting anything.
 *
 * Recording never blocks the run: the accepted block lands as a Pi custom
 * state entry (SessionManager stays the only session-file writer), and the
 * next ordinary model request — including tool continuations — applies the
 * projection through the public `context` transform. No settle, abort,
 * restart, background model, autonomous turn, or native `compact()` call is
 * involved in the normal path; Pi native compaction stays untouched as the
 * fallback owner of the context boundary.
 *
 * #324 adds the request-exit arbitration on top of the same transform: every
 * provider-bound request first tries the latest recorded Memory projection;
 * when valid Memory cannot be applied this request and the complete
 * (artifact-filtered) baseline fits, the exit declines the custom
 * application — the safe native fallback — discards the unrecorded
 * maintenance candidates, and leaves Pi native compaction owning the
 * boundary at its own safe idle/native edge, never awaited from inside a
 * running tool or the context handler; and when no validated view fits
 * under Pi's own native compaction boundary (window minus reserve — the
 * output and tool-growth headroom Pi itself relies on), the exit issues the
 * public abort signal instead of sending anything, so a model that ignores
 * advisories, one oversized tool result, or a no-net-benefit scope can never
 * push a known-unsafe view to the provider. The stop never touches recorded
 * Memory or the truthful applied accounting, never continues or retries on
 * its own, and is never used for normal compression.
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
 * The request's non-message composition, gathered from the host's public
 * seams (#320): the effective system prompt and the active tool definitions
 * — name, description, and parameter schema — that the provider-bound
 * request carries beside the handler's messages. Images and thinking stay
 * inside the per-message estimate; this carries only what the messages never
 * include.
 */
export interface ContextOverheadInput {
  readonly systemPrompt?: string;
  readonly toolDefinitions?: readonly {
    readonly name: unknown;
    readonly description: unknown;
    readonly parameters: unknown;
  }[];
}

/** Deterministic chars/4 estimate of the system prompt's contribution (#320). */
function estimateSystemPromptTokens(systemPrompt: string): number {
  return Math.ceil(Array.from(systemPrompt).length / 4);
}

/**
 * Deterministic estimate of one active tool definition's provider-side
 * contribution (#320): the JSON form of its name, description, and parameter
 * schema. Provider serialization differs, but the residual calibration term
 * absorbs the systematic difference; a definition that cannot be serialized
 * estimates as zero rather than blocking the request.
 */
function estimateToolDefinitionTokens(definition: {
  readonly name: unknown;
  readonly description: unknown;
  readonly parameters: unknown;
}): number {
  let chars = 0;
  try {
    const serialized = JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    });
    if (typeof serialized === "string") chars = serialized.length;
  } catch {
    chars = 0;
  }
  return Math.ceil(chars / 4);
}

/**
 * The calibration term may claim at most this share of the model window (#320):
 * the residual between a provider report and the same request's full estimate
 * is a real but bounded correction, and a pathological provider report can
 * never inflate pressure through it.
 */
const USAGE_CALIBRATION_WINDOW_SHARE = 4;

/**
 * The minimal valid block body, used only for the establishment-time savings
 * floor of a maintenance request (#320): savings shrink as the body grows, so
 * a range that cannot save tokens even with the smallest legal body can never
 * back an advisory.
 */
const MINIMAL_BLOCK_BODY = "x";
/**
 * The latest input to this controller's context handler (#319): its branch
 * leaf and the entry ids whose native messages aligned at this point. Earlier
 * transforms that replace or remove entries cannot authorize those entries.
 * This is not final delivery evidence: later context/payload handlers and
 * provider conversion remain outside this observation boundary (ADR-0017).
 */
interface ObservedContextBoundary {
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

/**
 * The entry ids of the replacement set one ordered block list records (#319,
 * #322, #321): every non-retained source entry, plus the protocol tool
 * results whose producing assistant is among those evicted sources so the
 * call and its result always leave provider requests together. A rebuild's
 * serving projection applies exactly this set over the kept prefix blocks.
 */
function replacementEntryIdsOf(blocks: readonly {
  readonly sourceEntries: readonly SessionEntry[];
  readonly retainedEntryIds: readonly string[];
  readonly protocolResultEntryIds: readonly string[];
}[]): ReadonlySet<string> {
  const evict = new Set<string>();
  for (const block of blocks) {
    const retained = new Set(block.retainedEntryIds);
    for (const entry of block.sourceEntries) {
      if (!retained.has(entry.id)) evict.add(entry.id);
    }
    for (const id of block.protocolResultEntryIds) evict.add(id);
  }
  return evict;
}

/** The one complete Memory carrier: one ordered text part per block (#297, #319, #321). */
function memoryCarrierMessage(blocks: readonly { readonly markdown: string }[], carrierTimestamp: number): unknown {
  return {
    role: "custom",
    customType: CONTEXT_MEMORY_BLOCKS_TYPE,
    content: [
      { type: "text", text: MEMORY_SUMMARY_WRAPPER },
      ...blocks.map((block) => ({ type: "text", text: MEMORY_BLOCK_SEPARATOR + block.markdown })),
    ],
    display: false,
    timestamp: carrierTimestamp,
  };
}

/**
 * The fixed continuation sentence every due advisory ends with (#253): the
 * submission is not the run's end — the model answers the user in the same run
 * after the acknowledgement.
 */
const ADVISORY_CONTINUATION_SENTENCE =
  "After the acknowledgement, continue the same run and deliver your answer to the user.";

/** The fixed due advisory body (#319: resident tool, source scope; #320: fixed range). */
const DUE_ADVISORY_TEXT = [
  "Context Memory: compression is due for this conversation.",
  "",
  `Call compact_to_memory_block as the sole tool call of its batch, carrying one concise Markdown Memory block that preserves what matters from the older conversation it covers — goals, decisions, and open work. ${ADVISORY_CONTINUATION_SENTENCE}`,
  "The next request after the acknowledgement will carry that block in place of the covered older conversation; your current request and everything you do for it stay uncompressed.",
  "The covered range is fixed once this advisory appears: work you finish afterwards stays uncompressed until the next maintenance request.",
  "Do not copy credential values, private keys, access tokens, or other secrets into the Memory block.",
].join("\n");

/**
 * The fixed due advisory body for a suffix rebuild (#321): the model authors
 * one block from the complete original sources served in the same request,
 * never from the summaries those sources replace. Same fixed frame as the
 * append advisory — sole call, continuation, fixed range, secrets.
 */
const DUE_ADVISORY_REBUILD_TEXT = [
  "Context Memory: compression is due for this conversation.",
  "",
  "Rendered Memory is above half its budget, so this maintenance rebuilds the newest Memory suffix. The complete original conversation behind the replaced blocks is present again in this request, in order, ahead of your current work, and their summaries are gone.",
  `Call compact_to_memory_block as the sole tool call of its batch, carrying one concise Markdown Memory block that preserves what matters from that complete original conversation — goals, decisions, and open work. ${ADVISORY_CONTINUATION_SENTENCE}`,
  "The next request after the acknowledgement will carry the rebuilt block — and every older block unchanged — in place of the covered original conversation; your current request and everything you do for it stay uncompressed.",
  "The covered range is fixed once this advisory appears: work you finish afterwards stays uncompressed until the next maintenance request.",
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
 * - The latest assistant batch and all its results pass through whole,
 *   accepted or refused, until the next user or assistant message: a mixed
 *   batch's rejection must reach the model alongside ordinary sibling results.
 *   Once the complete Memory carrier is established in the same
 *   request, an accepted trailing call's arguments carry only the bounded
 *   placeholder — the body survives in full exactly once, inside the carrier.
 * - Older accepted pairs survive untouched while no carrier is established:
 *   their arguments are the only request-side copy of the recorded summary,
 *   so dropping either half would orphan the result or silently lose the
 *   body. Once the carrier is established the whole pair drops together.
 * - Older refused pairs (error results) drop together — call part and
 *   result — whether or not a carrier exists; a later message ends the
 *   current batch's feedback retention, and no Memory was recorded by the attempt.
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

  // Results need not be adjacent to their assistant: one batch can contain
  // many calls, and their results may complete in either order. A later
  // user or assistant message, not the last result's position, ends this
  // exception.
  const latestConversation = findLastIndexOf(messages, (message) => {
    const role = (message as { role?: unknown } | null)?.role;
    return role === "assistant" || role === "user";
  });
  const keepFrom = latestConversation !== -1 && hasCompressionCall(messages[latestConversation])
    ? latestConversation : messages.length;

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
 * not split an ordinary tool batch. A trailing answered protocol pair keeps
 * the end below its producer so both halves remain raw (#322). Returns null
 * when no qualified source exists.
 */
function selectAppendSource(branch: readonly SessionEntry[], previousEndPosition: number): AppendSource | null {
  const retainedFrom = workingSetAnchor(branch);
  if (retainedFrom === -1) return null;
  let sourceEndPosition = -1;
  for (let i = retainedFrom - 1; i > previousEndPosition; i--) {
    if (isEligibleSourceEntry(branch[i]!)) {
      sourceEndPosition = i;
      break;
    }
  }
  if (sourceEndPosition <= previousEndPosition) return null;
  // A protocol tool result trailing the range while its producing assistant
  // would be covered must not strand an unpaired result: the request-side
  // pair rules keep reading artifacts visible (unlike compression pairs), so
  // evicting the call alone would leave a result no provider accepts (#322).
  // Move the range end below the producing exchange so the pair stays raw and
  // whole; results produced before this block's start belong to an earlier
  // accepted range and are beyond what this append can fix.
  const assistantCallPosition = new Map<string, number>();
  for (let i = previousEndPosition + 1; i < retainedFrom; i++) {
    const calls = assistantToolCalls(branch[i]!);
    for (const call of calls) assistantCallPosition.set(call.id, i);
  }
  for (;;) {
    let lowestTrailingProducer = -1;
    for (let i = sourceEndPosition + 1; i < retainedFrom; i++) {
      const entry = branch[i]!;
      if (entry.type !== "message") continue;
      const message = (entry as { message?: { role?: unknown; toolCallId?: unknown; toolName?: unknown } }).message;
      if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
      if (!isProtocolToolName(message.toolName)) continue;
      const producer = assistantCallPosition.get(message.toolCallId);
      if (producer === undefined || producer > sourceEndPosition || producer <= previousEndPosition) continue;
      if (lowestTrailingProducer === -1 || producer < lowestTrailingProducer) lowestTrailingProducer = producer;
    }
    if (lowestTrailingProducer === -1) break;
    let moved = -1;
    for (let i = lowestTrailingProducer - 1; i > previousEndPosition; i--) {
      if (isEligibleSourceEntry(branch[i]!)) {
        moved = i;
        break;
      }
    }
    if (moved <= previousEndPosition) return null;
    sourceEndPosition = moved;
  }
  return buildAppendSource(branch, previousEndPosition, sourceEndPosition);
}

/**
 * The retained working set's anchor position on the branch (#319): the most
 * recent completed ordinary tool batch — every call of the assistant message
 * has its result later on the branch — or, with no completed ordinary batch,
 * the latest user instruction. Completed Context Memory protocol batches
 * never anchor the working set: they are maintenance bookkeeping, not recent
 * work, and anchoring on them would strand the conversation around them.
 */
function workingSetAnchor(branch: readonly SessionEntry[]): number {
  const resultsByCallId = new Map<string, number>();
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; toolCallId?: unknown } }).message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      resultsByCallId.set(message.toolCallId, i);
    }
  }
  for (let i = branch.length - 1; i >= 0; i--) {
    const calls = assistantToolCalls(branch[i]!);
    if (calls.length === 0) continue;
    if (calls.every((call) => isProtocolToolName(call.name))) continue;
    if (calls.every((call) => {
      const position = resultsByCallId.get(call.id);
      return position !== undefined && position > i;
    })) {
      return i;
    }
  }
  for (let i = branch.length - 1; i >= 0; i--) {
    if (isUserMessageEntry(branch[i]!)) return i;
  }
  return -1;
}

/**
 * Validate and build the append source ending at one fixed position (#319,
 * #320, #322). Every ordinary tool call and result must pair inside the range;
 * an ordinary orphan refuses compression rather than dropping messages to
 * force a fit. Unanswered protocol calls are exempt; answered protocol results
 * inside the range leave with their evicted producer through derivation.
 * The same validation backs natural selection and a pinned request's fixed end.
 */
function buildAppendSource(
  branch: readonly SessionEntry[],
  previousEndPosition: number,
  sourceEndPosition: number,
): AppendSource | null {
  const rangeCalls = new Map<string, number>();
  const rangeResults = new Map<string, number>();
  for (let i = previousEndPosition + 1; i <= sourceEndPosition; i++) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown } }).message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        const candidate = part as { type?: unknown; id?: unknown; name?: unknown } | null;
        if (candidate?.type === "toolCall" && typeof candidate.id === "string"
          && !isProtocolToolName((candidate as { name?: unknown }).name)) {
          rangeCalls.set(candidate.id, i);
        }
      }
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string"
      && !isProtocolToolName(message.toolName)) {
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
  return { sourceEndPosition, retainedEntryIds };
}

/**
 * The eligible, non-retained entries a source range would evict from the
 * request (#319, #321): retained protected instructions never count as
 * savings. The retained set defaults to the source's own latest-instruction
 * scan (the complete set for an append); a rebuild passes the final recorded
 * union — the replaced blocks' retained exceptions included — so its savings
 * are measured against the replacement set that actually evicts, never
 * against instructions that stay raw in every request.
 */
function evictableEntries(
  branch: readonly SessionEntry[],
  previousEndPosition: number,
  source: AppendSource,
  retainedEntryIds: readonly string[] = source.retainedEntryIds,
): readonly SessionEntry[] {
  return branch
    .slice(previousEndPosition + 1, source.sourceEndPosition + 1)
    .filter((entry) => isEligibleSourceEntry(entry) && !retainedEntryIds.includes(entry.id));
}

/**
 * Deterministic projected net request savings of one append (#319, #320): the
 * evicted source tokens minus the carrier DELTA the request gains. An append
 * onto existing Memory adds only the new block's part to the carrier already
 * in the request; the unchanged prefix is never charged again.
 */
function netAppendSavings(
  evictable: readonly SessionEntry[],
  current: CurrentMemory,
  markdown: string,
): number {
  const carrierDelta = current.kind === "valid"
    ? estimateTextTokens(MEMORY_BLOCK_SEPARATOR + markdown)
    : estimateTextTokens(composeMemorySummary([markdown]));
  let savings = -carrierDelta;
  for (const entry of evictable) {
    for (const message of sessionEntryToContextMessages(entry)) {
      savings += estimateFilteredMessageTokens(message as { role?: unknown; content?: unknown; toolName?: unknown });
    }
  }
  return savings;
}

/**
 * Select the suffix a rebuild replaces (#321): the shortest newest adjacent
 * suffix whose removal leaves the unselected prefix rendered at or below half
 * the Memory budget, measured with the one deterministic
 * {@link renderedMemoryTokens} measure shared by the half-budget rule,
 * `/context`, and the submission budget. `minimumPrefix` is the smallest
 * recordable prefix — blocks whose originals the native context projection
 * cannot serve (below a compaction's kept boundary) must stay in the prefix,
 * and a state entry over a v1 base must keep the complete inherited prefix.
 * When even the minimum prefix renders above half, that floor is returned:
 * the suffix is still recordable and the invariant prefix is never rewritten.
 * Returns null when no block is rebuildable at all.
 */
export function selectRebuildSuffix(
  markdowns: readonly string[],
  halfBudgetTokens: number,
  minimumPrefix: number,
): { readonly prefixCount: number; readonly suffixCount: number } | null {
  const total = markdowns.length;
  if (minimumPrefix >= total) return null;
  for (let prefixCount = total - 1; prefixCount >= minimumPrefix; prefixCount--) {
    if (renderedMemoryTokens(markdowns.slice(0, prefixCount)) <= halfBudgetTokens) {
      return { prefixCount, suffixCount: total - prefixCount };
    }
  }
  return { prefixCount: minimumPrefix, suffixCount: total - minimumPrefix };
}

/**
 * The smallest block index whose complete original range the native context
 * projection can serve (#321): with a compaction on the branch, Pi carries
 * only the compaction entry plus entries from its `firstKeptEntryId` onward,
 * so any block whose range starts below that boundary has originals that can
 * never re-enter a request. Blocks are range-ordered, so every block from
 * this index on is servable. Without a compaction (or when everything from
 * the first entry is kept) every block is servable and the index is 0.
 */
export function firstFullyServableBlockIndex(
  branch: readonly SessionEntry[],
  blocks: readonly { readonly endEntryId: string }[],
): number {
  let keptPosition = -2;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type !== "compaction") continue;
    const keptId = (branch[i] as { firstKeptEntryId?: unknown }).firstKeptEntryId;
    keptPosition = typeof keptId === "string" ? branch.findIndex((entry) => entry.id === keptId) : -1;
    break;
  }
  if (keptPosition <= 0) return 0;
  for (let i = 0; i < blocks.length; i++) {
    const rangeStart = i === 0 ? 0 : branch.findIndex((entry) => entry.id === blocks[i - 1]!.endEntryId) + 1;
    if (rangeStart >= keptPosition) return i;
  }
  return blocks.length;
}

/**
 * The one rebuild plan both the advisory and the acceptance compute (#321):
 * suffix selection over the half budget plus the kept prefix's boundary on
 * the branch. `none` when no block's complete originals can re-enter a
 * request; `unresolved` when the kept prefix no longer resolves (an invalid
 * derivation the callers each treat as their own invalid-state refusal).
 * Sharing the computation keeps the pinned advisory and the later acceptance
 * from drifting apart.
 */
function planRebuild(
  branch: readonly SessionEntry[],
  blocks: readonly { readonly markdown: string; readonly endEntryId: string }[],
  halfBudget: number,
): { readonly kind: "plan"; readonly prefixCount: number; readonly suffixCount: number; readonly prefixEndPosition: number; readonly prefixEndEntryId: string | null }
  | { readonly kind: "none" }
  | { readonly kind: "unresolved" } {
  const minimumPrefix = firstFullyServableBlockIndex(branch, blocks);
  const plan = selectRebuildSuffix(blocks.map((block) => block.markdown), halfBudget, minimumPrefix);
  if (plan === null) return { kind: "none" };
  const prefixCount = plan.prefixCount;
  const prefixEndPosition = prefixCount === 0
    ? -1
    : branch.findIndex((entry) => entry.id === blocks[prefixCount - 1]!.endEntryId);
  if (prefixCount > 0 && prefixEndPosition === -1) return { kind: "unresolved" };
  return {
    kind: "plan",
    prefixCount,
    suffixCount: plan.suffixCount,
    prefixEndPosition,
    prefixEndEntryId: prefixCount === 0 ? null : blocks[prefixCount - 1]!.endEntryId,
  };
}

/**
 * The retained exceptions a rebuild's new block records (#321): the union of
 * the replaced suffix blocks' retained instructions — protection decided by an
 * earlier acceptance is fixed and cannot silently disappear when the recent
 * zone moves — with the latest user instruction inside the new range, ordered
 * by branch position. Derivation validates every id resolves as a protected
 * user instruction inside the range.
 */
function rebuildRetainedEntryIds(
  branch: readonly SessionEntry[],
  source: AppendSource,
  suffixBlocks: readonly { readonly retainedEntryIds: readonly string[] }[],
): readonly string[] {
  const retained = new Set<string>(source.retainedEntryIds);
  for (const block of suffixBlocks) {
    for (const id of block.retainedEntryIds) retained.add(id);
  }
  const positionById = new Map<string, number>();
  for (let i = 0; i < branch.length; i++) positionById.set(branch[i]!.id, i);
  return [...retained].sort((left, right) =>
    (positionById.get(left) ?? Number.MAX_SAFE_INTEGER) - (positionById.get(right) ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Deterministic projected net request savings of one rebuild (#321), measured
 * against the served pending request the model actually saw: the evicted
 * source tokens minus the carrier delta from the prefix-only carrier the
 * served request carried to the rebuilt carrier — the suffix summaries were
 * already absent during the pending request and are never charged again.
 */
function netRebuildSavings(
  evictable: readonly SessionEntry[],
  prefixMarkdowns: readonly string[],
  markdown: string,
): number {
  const carrierDelta = renderedMemoryTokens([...prefixMarkdowns, markdown])
    - renderedMemoryTokens(prefixMarkdowns);
  let savings = -carrierDelta;
  for (const entry of evictable) {
    for (const message of sessionEntryToContextMessages(entry)) {
      savings += estimateFilteredMessageTokens(message as { role?: unknown; content?: unknown; toolName?: unknown });
    }
  }
  return savings;
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
  /** Sources observed at our context handler, not proof of final delivery (#319). */
  private observedContext: ObservedContextBoundary | undefined;
  /** Tool-call ids of the most recent assistant message (#319 sole-call check). */
  private lastToolBatch: ToolBatch | undefined;
  /** The pending maintenance request riding due requests, when one is due (#320). */
  private maintenance: MaintenanceRequest | undefined;
  /** Bounded refusal bookkeeping for the pending request (#320). */
  private maintenanceFailures: MaintenanceFailures | undefined;
  /** The last provider-bound request this controller transformed (#320). */
  private lastRequest: {
    readonly estimateTokens: number;
    readonly systemTokens: number;
    readonly toolsTokens: number;
    readonly memoryVersion: string;
  } | undefined;
  /** The provider-reported size of the last measured request and the Memory version it measured (#320). */
  private reportedRequest: { readonly tokens: number; readonly memoryVersion: string } | undefined;
  /**
   * Residual calibration for the request a provider report actually measured
   * (#320): the bounded difference between the report and that request's full
   * estimate — messages plus the directly estimated system prompt and active
   * tool definitions — so nothing is charged twice. The residual applies only
   * while the Memory version and the system/tool composition it was derived
   * from are unchanged: a compression or a composition change suspends it
   * until the next report recalibrates, so stale residuals never mask growth
   * and post-compression requests keep their still-present overhead.
   */
  private calibration: {
    readonly offsetTokens: number;
    readonly memoryVersion: string;
    readonly systemTokens: number;
    readonly toolsTokens: number;
  } | undefined;
  /** Projected net request savings of the most recent accepted compression (#320). */
  private lastNetSavingsTokens: number | undefined;
  /**
   * The honest scale endpoint (#321): the last due request found rendered
   * Memory above half its budget with a rebuild whose complete serving —
   * suffix originals, retained context, and headroom — does not fit the
   * window. No maintenance request is pinned, no sources are re-served, and
   * Pi native compaction keeps owning the boundary. Recomputed every request.
   */
  private scaleLimit = false;
  /**
   * The rebuild sources the last outgoing request actually served (#321).
   * A rebuild submission is accepted only when the request that carried the
   * call served exactly these sources in their native form: an un-served
   * (for example scale-limited) request can never authorize a rebuild.
   */
  private lastServedRebuild: {
    readonly prefixEndEntryId: string | null;
    readonly sourceEndEntryId: string;
    readonly memoryVersion: string;
  } | undefined;
  /**
   * The request-exit arbitration verdict of the last provider-bound request
   * (#324): which view the exit selected — the custom Memory projection, the
   * complete native baseline (custom application unavailable, native
   * compaction owning the boundary), or the hard stop whose abort signal
   * cancelled the request. Bounded codes and counts only; recomputed on every
   * request and never persisted.
   */
  private arbitration: ContextMemoryArbitrationInfo | undefined;
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
   * carrier has already been applied to a request in this session (#319), and
   * carries the bounded #320 sustained-maintenance diagnostics when they exist.
   */
  snapshot(usage?: ContextMemoryUsageInput): ContextMemorySnapshot {
    if (!this.config.enabled) return { state: "disabled" };
    if (!this.support.supported) return { state: "unsupported", reason: this.support.reason };
    if (this.current.kind === "none") {
      if (!this.due) return this.markEphemeral(this.withArbitration({ state: "no-memory" }));
      const due: {
        state: "due";
        maintenance?: ContextMemoryMaintenanceInfo;
        pressure?: ContextMemoryPressureInfo;
        arbitration?: ContextMemoryArbitrationInfo;
      } = { state: "due" };
      const maintenance = this.maintenanceInfo();
      if (maintenance !== undefined) due.maintenance = maintenance;
      const pressure = this.pressureInfo();
      if (pressure !== undefined) due.pressure = pressure;
      if (this.arbitration !== undefined) due.arbitration = this.arbitration;
      return this.markEphemeral(due);
    }
    if (this.current.kind === "opaque") {
      return this.markEphemeral(this.withArbitration({ state: "opaque" }));
    }
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

  /**
   * Attach the last request-exit arbitration verdict (#324) to an inactive
   * snapshot; absent before the first request of the session.
   */
  private withArbitration<T extends { readonly state: string }>(snapshot: T): T & { readonly arbitration?: ContextMemoryArbitrationInfo } {
    return this.arbitration === undefined ? snapshot : { ...snapshot, arbitration: this.arbitration };
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
   * #319, #320). The estimate is projection-aware: recorded Memory evicts its
   * covered sources before the pressure is judged, so an accepted compression
   * relieves pressure immediately instead of waiting for a stale usage anchor.
   * #320 adds the bounded calibration term so run-boundary checks agree with
   * the per-request judgment; no reported usage number ever acts as a floor.
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
    // Run-boundary checks reuse the last observed request composition — the
    // system prompt and active tools of the most recent transform — because
    // the authoritative judgment stays at the next request boundary.
    const systemTokens = this.lastRequest?.systemTokens ?? 0;
    const toolsTokens = this.lastRequest?.toolsTokens ?? 0;
    this.due = estimate !== null
      && estimate + systemTokens + toolsTokens
        + this.activeCalibrationTokens(memoryVersionOf(this.current), systemTokens, toolsTokens) >= duePoint;
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
   * Bind the provider's own report to the request it measured and calibrate
   * the residual pressure accounting (#320). The assistant message's usage
   * describes the last request this controller transformed; the bounded
   * difference between the report and that request's **full** estimate —
   * messages, the directly estimated system prompt, and the active tool
   * definitions — is the residual term for provider tokenization and framing
   * differences. Images and thinking are already inside the per-message
   * estimate and are never charged again. The report is recorded with the
   * Memory version and composition it measured: a pre-compression report is
   * distinguishable from the current view and never acts as a floor, and a
   * stale residual is suspended once the system prompt or tool selection
   * changes, until the next report recalibrates it.
   */
  noteAssistantUsage(message: unknown): void {
    const record = message as
      | { role?: unknown; usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } }
      | null
      | undefined;
    if (!record || record.role !== "assistant" || record.usage === undefined) return;
    const { input, cacheRead, cacheWrite } = record.usage;
    if (typeof input !== "number" || typeof cacheRead !== "number" || typeof cacheWrite !== "number") return;
    if (!Number.isFinite(input) || !Number.isFinite(cacheRead) || !Number.isFinite(cacheWrite)) return;
    const reported = input + cacheRead + cacheWrite;
    if (reported <= 0 || this.lastRequest === undefined) return;
    this.reportedRequest = { tokens: reported, memoryVersion: this.lastRequest.memoryVersion };
    if (this.modelWindow === null) return;
    // Clamp to [0, a window share]: the term models a real residual, not a
    // runaway drift channel, and a missing or malformed report simply keeps
    // the previous calibration.
    const bound = Math.floor(this.modelWindow / USAGE_CALIBRATION_WINDOW_SHARE);
    const basis = this.lastRequest.estimateTokens + this.lastRequest.systemTokens + this.lastRequest.toolsTokens;
    const offsetTokens = Math.min(Math.max(reported - basis, 0), bound);
    this.calibration = {
      offsetTokens,
      memoryVersion: this.lastRequest.memoryVersion,
      systemTokens: this.lastRequest.systemTokens,
      toolsTokens: this.lastRequest.toolsTokens,
    };
  }

  /**
   * Drop the pending maintenance request (#320, #321): a model, branch, or
   * compaction change invalidates the pinned sources, and the next due
   * request boundary re-establishes a fresh request from the live branch —
   * never a replay of the dropped one. The per-request rebuild markers drop
   * with it: a request that never served rebuild sources can never authorize
   * one.
   */
  invalidateMaintenanceRequest(): void {
    this.maintenance = undefined;
    this.maintenanceFailures = undefined;
    this.scaleLimit = false;
    this.lastServedRebuild = undefined;
  }

  /**
   * Drop the usage calibration (#320): a model change replaces the system
   * prompt, tool selection, and window, so the old offset and report are
   * meaningless until the next provider report recalibrates them.
   */
  invalidateUsageCalibration(): void {
    this.calibration = undefined;
    this.reportedRequest = undefined;
    this.lastRequest = undefined;
  }

  /**
   * The residual calibration for one judged request composition (#320):
   * suspended unless the provider report measured this exact Memory version
   * with this exact system-prompt and tool estimate. A pre-compression
   * report therefore contributes nothing to post-compression pressure, and a
   * system or tool-schema change suspends the stale residual until the next
   * report recalibrates it.
   */
  private activeCalibrationTokens(memoryVersion: string, systemTokens: number, toolsTokens: number): number {
    return this.calibration !== undefined
      && this.calibration.memoryVersion === memoryVersion
      && this.calibration.systemTokens === systemTokens
      && this.calibration.toolsTokens === toolsTokens
      ? this.calibration.offsetTokens
      : 0;
  }

  /**
   * Count one refused or invalid submission against the pending maintenance
   * request's bounded failure budget (#320): the specific refusal still
   * reaches the model, the tool stays resident, and only the advisory
   * invitation is bounded. Failures attach to the current scope — a later
   * scope change resets them, so one scope's suppression never leaks into
   * another.
   */
  private noteSubmissionFailure(code: string): void {
    this.maintenanceFailures = noteMaintenanceFailure(this.maintenanceFailures, code);
  }

  /**
   * Execute one `compact_to_memory_block` call (#319, #320): validate the sole
   * tool call, the block body, the append capacity, the authorized source
   * range, batch pairing, budgets, and the net benefit, then record the
   * versioned state entry through Pi's public custom-entry seam. The fixed
   * acknowledgement says the Memory is recorded — it never claims a future
   * request already carried it. The run continues; the next ordinary request
   * applies the projection. #320: every reachable submission refusal — a
   * mixed batch, an invalid body, or a refused append binding — counts
   * against the pending maintenance request's bounded failure budget (an
   * unavailable session never does), and a successful recording clears the
   * completed request and records its projected net savings. Throws one safe
   * short-coded sentence, at most one bounded next-step hint, and never
   * echoes Markdown.
   */
  async compactToBlock(
    markdown: string,
    toolCallId: string,
    session: MemorySessionReader,
    recording: MemoryRecordingContext,
  ): Promise<AgentToolResult<CompactMemoryDetails>> {
    if (!this.operational()) {
      // An unavailable session is never a submission against a scope: its
      // error stays outside every failure budget (#320).
      fail("COMPACT_NOT_AVAILABLE", "Context Memory compression is not available in this session");
    }
    const batch = this.lastToolBatch;
    if (batch === undefined || !batch.ids.includes(toolCallId) || batch.ids.length > 1) {
      // An invalid submission (#320): a mixed batch counts against the
      // pending request's bounded failure budget exactly like a refused
      // binding, so a model that keeps mis-calling stops being invited.
      this.noteSubmissionFailure("COMPACT_NOT_SOAL_TOOL");
      fail("COMPACT_NOT_SOAL_TOOL", "compact_to_memory_block must be the sole tool call in its batch");
    }
    if (!isValidMemoryBlockBody(markdown)) {
      // An invalid submission (#320): the schema counts characters while the
      // bound counts canonical UTF-8 bytes, so a short-but-wide body (for
      // example CJK text) can pass the schema and still exceed 16 KiB. The
      // refusal counts against the same bounded budget with its next step.
      this.noteSubmissionFailure("BOUND_EXCEEDED");
      fail(
        "BOUND_EXCEEDED",
        "the Memory block body exceeds the size or content bounds; keep it within 16 KiB of canonical UTF-8 without NUL or other C0 control characters",
      );
    }
    let candidate: { state: MemoryStateData; savings: number };
    try {
      candidate = this.bindOperation(markdown, session);
    } catch (error) {
      // Bounded suppression bookkeeping (#320): the refusal stays specific and
      // the tool remains resident; only the advisory invitation is bounded.
      const code = error instanceof Error ? error.message.split(":", 1)[0]! : "MEMORY_CHANGED";
      this.noteSubmissionFailure(code);
      throw error;
    }
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
    // The completed maintenance request clears (#320): pressure is re-judged
    // on the next request against the recorded projection, and later growth in
    // the same task can establish a fresh request without any user input.
    this.maintenance = undefined;
    this.maintenanceFailures = undefined;
    this.lastNetSavingsTokens = candidate.savings;
    return {
      content: [{ type: "text", text: "Memory block recorded. The next model request will carry it in place of the covered older conversation." }],
      details: { recorded: true },
    };
  }

  /**
   * Resolve one submission's binding against the live branch, or refuse
   * safely (#319, #321): while rendered Memory sits at or below half its
   * budget the operation appends one block; above half it rebuilds the
   * shortest newest adjacent block suffix from its complete original sources.
   * Both paths validate the continuous source range — the pending maintenance
   * request's pinned range while one still authorizes this Memory state,
   * otherwise a request pinned at this call (#320) — batch pairing by call
   * id, retained exceptions, the byte-stable prefix from the current carrier,
   * and the single-block, total-Memory, and serialization budgets.
   */
  private bindOperation(markdown: string, session: MemorySessionReader): { state: MemoryStateData; savings: number } {
    const leafId = session.getLeafId?.() ?? null;
    if (leafId === null) {
      fail("MEMORY_CHANGED", "the current branch no longer carries this session");
    }
    const branch = [...session.getBranch(leafId)];
    const current = deriveCurrentMemory(session);
    if (current.kind === "opaque") {
      fail("MEMORY_CHANGED", "current Memory is no longer valid structured Context Memory");
    }
    const halfBudget = this.halfBudgetTokens();
    if (current.kind === "valid" && halfBudget !== null
      && renderedMemoryTokens(current.blocks.map((block) => block.markdown)) > halfBudget) {
      return this.bindRebuild(markdown, branch, current, halfBudget);
    }
    return this.bindAppend(markdown, branch, current);
  }

  /**
   * The append binding (#319): one new block over the conversation accumulated
   * since the existing blocks, every existing block byte-identical.
   */
  private bindAppend(
    markdown: string,
    branch: readonly SessionEntry[],
    current: CurrentMemory,
  ): { state: MemoryStateData; savings: number } {
    const prefix: MemoryStateBlock[] = [];
    let previousEndPosition = -1;
    let baseCompactionId: string | undefined;
    if (current.kind === "valid") {
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
    const source = this.authorizedAppendSource(branch, current, previousEndPosition);
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
    const evictable = evictableEntries(branch, previousEndPosition, source);
    // Acceptance is scoped to the latest input observed by our context
    // handler, not the final provider request. Earlier filtering invalidates
    // a source here; later transformations cannot be observed with Pi's
    // public API and remain a documented compatibility limit (ADR-0017).
    const observed = this.observedContext;
    if (observed === undefined
      || observed.leafId === null
      || !branch.some((entry) => entry.id === observed.leafId)
      || evictable.some((entry) => !observed.entryIds.has(entry.id))) {
      fail("SOURCE_NOT_SERVED", "the covered conversation was not observed in its native form by the Context Memory context handler");
    }
    const savings = netAppendSavings(evictable, current, markdown);
    if (savings <= 0) {
      fail("NO_NET_BENEFIT", "the Memory block would not reduce the next model request; wait for more eligible conversation or a changed source");
    }
    return { state, savings };
  }

  /**
   * The rebuild binding (#321): the selected suffix — the shortest newest
   * adjacent block suffix whose removal leaves the kept prefix at or below
   * half the Memory budget — and the new eligible history form one continuous
   * original range, and one new block replaces the whole suffix over it.
   * Every retained exception of the replaced blocks stays retained
   * (protection decided by an earlier acceptance is fixed), the kept prefix is
   * byte-identical, and the base compaction stays stable. A rebuild is
   * accepted only when the request that carried this call served exactly its
   * complete sources: the pinned request's range while it still matches the
   * derived Memory state, or a live selection whose sources the last outgoing
   * request served in full — an un-served request (a scale limit, a refused
   * projection, an unestablished advisory) can never authorize summarizing
   * text the model never saw.
   */
  private bindRebuild(
    markdown: string,
    branch: readonly SessionEntry[],
    current: ValidMemory,
    halfBudget: number,
  ): { state: MemoryStateData; savings: number } {
    const markdowns = current.blocks.map((block) => block.markdown);
    const planned = planRebuild(branch, current.blocks, halfBudget);
    if (planned.kind === "none") {
      fail("SOURCE_NOT_SERVED", "the Memory suffix's complete original sources cannot be served on this branch; compression stays available again below half the Memory budget");
    }
    if (planned.kind === "unresolved") {
      fail("MEMORY_CHANGED", "the existing Memory blocks no longer resolve on the current branch");
    }
    const { prefixCount, prefixEndPosition, prefixEndEntryId } = planned;
    const memoryVersion = memoryVersionOf(current);
    let source: AppendSource | null = null;
    const pinned = this.maintenance;
    if (pinned !== undefined
      && pinned.operation === "rebuild"
      && pinned.memoryVersion === memoryVersion
      && pinned.previousEndEntryId === prefixEndEntryId) {
      const endPosition = branch.findIndex((entry) => entry.id === pinned.sourceEndEntryId);
      if (endPosition > prefixEndPosition && isEligibleSourceEntry(branch[endPosition]!)) {
        source = buildAppendSource(branch, prefixEndPosition, endPosition);
      }
    }
    if (source === null) {
      const live = selectAppendSource(branch, prefixEndPosition);
      if (live === null) {
        fail("COMPACT_NOT_DUE", "no completed eligible conversation is available to compress since the kept Memory prefix");
      }
      // A live-pinned rebuild is legitimate only when the last outgoing
      // request served exactly these sources: unlike an append, the sources
      // are covered by recorded Memory, so an un-served request can never
      // back a rebuild over text the model never saw in native form (#321).
      const served = this.lastServedRebuild;
      if (served === undefined
        || served.memoryVersion !== memoryVersion
        || served.prefixEndEntryId !== prefixEndEntryId
        || served.sourceEndEntryId !== branch[live.sourceEndPosition]!.id) {
        fail("SOURCE_NOT_SERVED", "the complete original sources for this rebuild were not served in their native form by the Context Memory context handler");
      }
      source = live;
      this.maintenance = {
        operation: "rebuild",
        sourceEndEntryId: branch[live.sourceEndPosition]!.id,
        retainedEntryIds: rebuildRetainedEntryIds(branch, live, current.blocks.slice(prefixCount)),
        previousEndEntryId: prefixEndEntryId,
        memoryVersion,
        sourceCount: branch
          .slice(prefixEndPosition + 1, live.sourceEndPosition + 1)
          .filter(isEligibleSourceEntry).length,
        prefixBlocks: prefixCount,
        suffixBlocks: planned.suffixCount,
      };
    }
    const retainedEntryIds = rebuildRetainedEntryIds(branch, source, current.blocks.slice(prefixCount));
    const prefix: MemoryStateBlock[] = current.blocks.slice(0, prefixCount).map((block) => ({
      endEntryId: block.endEntryId,
      markdown: block.markdown,
      retainedEntryIds: [...block.retainedEntryIds],
    }));
    const newBlock: MemoryStateBlock = {
      endEntryId: branch[source.sourceEndPosition]!.id,
      markdown,
      retainedEntryIds: [...retainedEntryIds],
    };
    const blocks = [...prefix, newBlock];
    const state: MemoryStateData = {
      format: MEMORY_STATE_FORMAT_TAG,
      blocks,
      ...(current.compactionId !== undefined ? { baseCompactionId: current.compactionId } : {}),
    };
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
    // Acceptance stays scoped to the latest input observed by our context
    // handler, exactly like an append (ADR-0017). The gate keeps covering
    // every eligible entry the pinned range names beyond the latest
    // instruction; only the savings measurement narrows below.
    const observable = evictableEntries(branch, prefixEndPosition, source);
    const observed = this.observedContext;
    if (observed === undefined
      || observed.leafId === null
      || !branch.some((entry) => entry.id === observed.leafId)
      || observable.some((entry) => !observed.entryIds.has(entry.id))) {
      fail("SOURCE_NOT_SERVED", "the covered conversation was not observed in its native form by the Context Memory context handler");
    }
    // Net benefit is measured against the served pending request the model
    // actually saw and against the replacement set that actually evicts: the
    // recorded retained union — including the replaced blocks' protected
    // instructions — stays raw in every request and never counts as savings,
    // while the suffix summaries were already absent during the pending
    // request, so only the carrier delta from the prefix-only carrier is
    // charged (#321).
    const evictable = evictableEntries(branch, prefixEndPosition, source, retainedEntryIds);
    const savings = netRebuildSavings(evictable, markdowns.slice(0, prefixCount), markdown);
    if (savings <= 0) {
      fail("NO_NET_BENEFIT", "the Memory block would not reduce the next model request; wait for more eligible conversation or a changed source");
    }
    return { state, savings };
  }

  /**
   * The append source this call may cover (#320): the pending maintenance
   * request's pinned range while it still matches the derived Memory state
   * and resolves on the branch — later tool growth never silently expands an
   * established request — or a live selection pinned at this call, the only
   * moment a proactive call can observe its own sources. A stale or
   * unmatched pin falls back to the live selection, never to a refusal that
   * only the pin caused.
   */
  private authorizedAppendSource(
    branch: readonly SessionEntry[],
    current: CurrentMemory,
    previousEndPosition: number,
  ): AppendSource | null {
    const memoryVersion = memoryVersionOf(current);
    const previousEndEntryId = previousEndPosition === -1 ? null : branch[previousEndPosition]!.id;
    const pinned = this.maintenance;
    if (pinned !== undefined
      && pinned.operation === "append"
      && pinned.memoryVersion === memoryVersion
      && pinned.previousEndEntryId === previousEndEntryId) {
      const endPosition = branch.findIndex((entry) => entry.id === pinned.sourceEndEntryId);
      if (endPosition > previousEndPosition && isEligibleSourceEntry(branch[endPosition]!)) {
        const source = buildAppendSource(branch, previousEndPosition, endPosition);
        if (source !== null) return source;
      }
    }
    const live = selectAppendSource(branch, previousEndPosition);
    if (live === null) return null;
    this.maintenance = {
      operation: "append",
      sourceEndEntryId: branch[live.sourceEndPosition]!.id,
      retainedEntryIds: live.retainedEntryIds,
      previousEndEntryId,
      memoryVersion,
      sourceCount: branch
        .slice(previousEndPosition + 1, live.sourceEndPosition + 1)
        .filter(isEligibleSourceEntry).length,
    };
    return live;
  }

  /**
   * Establish, re-scope, or clear the pending maintenance request at a
   * request boundary while the projected request is due (#320, #321). The
   * request pins the exact sources the advisory invites: an append while
   * rendered Memory sits at or below half its budget, otherwise a suffix
   * rebuild whose complete original sources this very request must serve.
   * The same evaluation re-scopes the request when real growth extends the
   * eligible range — the old request is invalidated and the new sources are
   * served in this very request, which is what makes the re-scope explicit
   * rather than silent — and clears it when no qualified, observable,
   * net-beneficial range exists. A rebuild whose complete serving, advisory,
   * and composition cannot fit under the due-point safety clamp pins nothing
   * and reports the honest scale limit instead. Failure bookkeeping survives
   * only an identical scope.
   */
  private evaluateMaintenance(
    session: MemorySessionReader,
    view: {
      readonly projection: NativeProjection;
      readonly aligned: readonly AlignedMessage[];
      readonly memory: CurrentMemory;
      readonly systemTokens: number;
      readonly toolsTokens: number;
      readonly window: number;
    },
  ): { readonly request?: MaintenanceRequest; readonly scaleLimit?: boolean; readonly served?: unknown[] } {
    const previous = this.maintenance;
    const clear = (): { readonly request?: undefined; readonly scaleLimit?: undefined; readonly served?: undefined } => {
      this.maintenance = undefined;
      this.maintenanceFailures = undefined;
      return {};
    };
    const leafId = session.getLeafId?.() ?? null;
    if (leafId === null) return clear();
    const branch = [...session.getBranch(leafId)];
    const current = view.memory;
    if (current.kind === "opaque") return clear();
    const halfBudget = this.halfBudgetTokens();
    if (halfBudget === null) return clear();
    let previousEndPosition = -1;
    let previousEndEntryId: string | null = null;
    if (current.kind === "valid") {
      const lastEnd = current.blocks[current.blocks.length - 1]!.endEntryId;
      previousEndPosition = branch.findIndex((entry) => entry.id === lastEnd);
      if (previousEndPosition === -1) return clear();
      previousEndEntryId = lastEnd;
    }
    // Every evictable entry inside a pinned range must have been served in
    // its native form in this very request: an upstream transform that
    // filtered a source leaves no request to bind (#320, ADR-0017).
    const observed = this.observedContext;
    if (observed === undefined || observed.leafId !== leafId) return clear();
    if (current.kind !== "valid"
      || renderedMemoryTokens(current.blocks.map((block) => block.markdown)) <= halfBudget) {
      // ── The append request (#319, #320), unchanged in shape ──
      const source = selectAppendSource(branch, previousEndPosition);
      if (source === null) return clear();
      const request: MaintenanceRequest = {
        operation: "append",
        sourceEndEntryId: branch[source.sourceEndPosition]!.id,
        retainedEntryIds: source.retainedEntryIds,
        previousEndEntryId,
        memoryVersion: memoryVersionOf(current),
        sourceCount: branch
          .slice(previousEndPosition + 1, source.sourceEndPosition + 1)
          .filter(isEligibleSourceEntry).length,
      };
      const evictable = evictableEntries(branch, previousEndPosition, source);
      if (evictable.some((entry) => !observed.entryIds.has(entry.id))) return clear();
      // The advisory never invites a range that cannot save request tokens
      // even with the smallest legal body: coverage total is not savings.
      if (netAppendSavings(evictable, current, MINIMAL_BLOCK_BODY) <= 0) return clear();
      if (!sameMaintenanceScope(previous, request)) this.maintenanceFailures = undefined;
      this.maintenance = request;
      return { request };
    }
    // ── The suffix rebuild request (#321) ──
    const markdowns = current.blocks.map((block) => block.markdown);
    const planned = planRebuild(branch, current.blocks, halfBudget);
    if (planned.kind === "none") {
      // No block's complete originals can re-enter a request (for example a
      // v1 compaction-carried baseline): the honest boundary, not a
      // summary-of-summary fallback.
      this.maintenance = undefined;
      this.maintenanceFailures = undefined;
      return { scaleLimit: true };
    }
    if (planned.kind === "unresolved") return clear();
    const { prefixCount, prefixEndPosition, prefixEndEntryId } = planned;
    const source = selectAppendSource(branch, prefixEndPosition);
    if (source === null) return clear();
    const retainedEntryIds = rebuildRetainedEntryIds(branch, source, current.blocks.slice(prefixCount));
    const request: MaintenanceRequest = {
      operation: "rebuild",
      sourceEndEntryId: branch[source.sourceEndPosition]!.id,
      retainedEntryIds,
      previousEndEntryId: prefixEndEntryId,
      memoryVersion: memoryVersionOf(current),
      sourceCount: branch
        .slice(prefixEndPosition + 1, source.sourceEndPosition + 1)
        .filter(isEligibleSourceEntry).length,
      prefixBlocks: prefixCount,
      suffixBlocks: planned.suffixCount,
    };
    // The observation gate keeps covering every eligible entry the range
    // names beyond the latest instruction; the savings floor narrows to the
    // final replacement set, exactly like acceptance — a huge retained
    // instruction never makes a rebuild look beneficial (#321 review).
    const observable = evictableEntries(branch, prefixEndPosition, source);
    if (observable.some((entry) => !observed.entryIds.has(entry.id))) return clear();
    const evictable = evictableEntries(branch, prefixEndPosition, source, retainedEntryIds);
    if (netRebuildSavings(evictable, markdowns.slice(0, prefixCount), MINIMAL_BLOCK_BODY) <= 0) return clear();
    // This very request must serve the complete sources it invites: the
    // prefix carrier plus the suffix's originals, raw and in order. If the
    // serving projection cannot be constructed, no request is pinned — an
    // invitation the model cannot actually read from is never sent (#321).
    const served = this.rebuildServingMessages(view.aligned, view.projection, current, prefixCount);
    if (served === undefined) return clear();
    // The honest scale endpoint (#321): the complete serving, the advisory
    // that invites it, and the request's composition must fit under the same
    // safety clamp the due point uses — below Pi's native compaction
    // boundary. Otherwise nothing is pinned, nothing is truncated, paged, or
    // deleted, and Pi native compaction keeps owning the boundary.
    const bound = view.window - this.reserveTokens - Math.round(view.window / 10);
    const estimate = this.estimateMessages(served) + estimateTextTokens(DUE_ADVISORY_REBUILD_TEXT)
      + view.systemTokens + view.toolsTokens
      + this.activeCalibrationTokens(request.memoryVersion, view.systemTokens, view.toolsTokens);
    if (estimate > bound) {
      this.maintenance = undefined;
      this.maintenanceFailures = undefined;
      return { scaleLimit: true };
    }
    if (!sameMaintenanceScope(previous, request)) this.maintenanceFailures = undefined;
    this.maintenance = request;
    return { request, served };
  }

  /**
   * The projection that serves a pending rebuild's complete sources (#321):
   * the kept prefix's replacement set is applied with a prefix-only carrier
   * while the selected suffix's original entries pass through raw — their
   * summaries absent, their originals whole, for as long as the request stays
   * pending. With an empty prefix there is no carrier at all: the request is
   * the raw conversation plus the advisory. Refusal semantics match the
   * ordinary application — an upstream transform that breaks the prefix
   * alignment returns undefined and nothing is pinned. Accepted compression
   * pairs drop whole: every block's summary is either carried by the prefix
   * carrier or deliberately replaced by its served originals, never both.
   */
  private rebuildServingMessages(
    aligned: readonly AlignedMessage[],
    projection: NativeProjection,
    memory: ValidMemory,
    prefixCount: number,
  ): unknown[] | undefined {
    if (prefixCount === 0) {
      return filterCompressionArtifacts(aligned, true);
    }
    const prefixBlocks = memory.blocks.slice(0, prefixCount);
    const evict = replacementEntryIdsOf(prefixBlocks);
    const mappedEntryIds = new Set<string>();
    for (const item of aligned) {
      if (item.entryId !== undefined) mappedEntryIds.add(item.entryId);
    }
    for (const id of evict) {
      if (projection.carriedEntryIds.has(id) && !mappedEntryIds.has(id)) return undefined;
    }
    const carrier = memoryCarrierMessage(prefixBlocks, memory.carrierTimestamp);
    const out: unknown[] = [];
    let carrierPlaced = false;
    const baseSummaryId = memory.carrier === "state" ? memory.compactionId : undefined;
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
    return filterCompressionArtifacts(
      out.map((message) => ({ message, entryId: undefined }) as AlignedMessage),
      true,
    );
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
   * The ephemeral `context` transform (#215, #218, #297, #319, #324). It never
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
   * - #324 arbitration: a request whose valid Memory application refused
   *   declines the custom view, discards unrecorded maintenance candidates,
   *   and goes out as the complete artifact-filtered baseline while that
   *   baseline fits (safe native fallback — Pi native compaction keeps owning
   *   the boundary); and a final view — whichever was constructed — whose
   *   estimate exceeds Pi's native compaction boundary issues `abortRequest`
   *   (the public abort signal), discards the unrecorded candidates, and
   *   returns undefined so the cancelled request carries no custom
   *   projection. Recorded Memory and the truthful applied accounting never
   *   change on either path.
   */
  transformContext(
    event: { readonly messages: readonly unknown[] },
    session: MemorySessionReader,
    usage?: { tokens: number | null; contextWindow: number } | undefined,
    overhead?: ContextOverheadInput | undefined,
    abortRequest?: (() => void) | undefined,
  ): { messages: readonly unknown[] } | undefined {
    if (!this.operational()) return undefined;
    const original = event.messages;
    try {
      const projection = nativeProjection(session);
      const aligned = alignMessages(original, projection);
      // Capture only what this handler observed. Neither this alignment nor
      // the returned projection proves delivery after downstream modifiers.
      this.observedContext = {
        leafId: session.getLeafId?.() ?? null,
        entryIds: new Set(aligned.flatMap((item) => (item.entryId === undefined ? [] : [item.entryId]))),
      };
      const memory = deriveCurrentMemory(session);
      // A request that ends up hard-stopped below must never count as an
      // applied projection: its carrier was constructed for a request that
      // never became provider-bound, so the truthful applied flag keeps its
      // pre-request value (#324).
      const appliedBeforeStop = this.appliedStateEntryId;
      let messages = this.applyMemoryProjection(aligned, projection, memory, true);
      const applicationApplied = messages !== undefined;
      if (messages === undefined) {
        // Alignment could not map every eviction target to its source entry:
        // apply no custom projection and keep protocol history intact.
        messages = filterCompressionArtifacts(
          aligned,
          v1CarrierPresent(aligned, projection),
        );
      }
      const v1Projected = this.projectV1Blocks(messages, session);
      if (v1Projected !== undefined) messages = v1Projected;
      // Due is judged on the projected request itself, never on a stale
      // pre-compression usage anchor: a recorded compression relieves
      // pressure as soon as it applies (#319). #320 counts the request's
      // non-message composition directly — the effective system prompt and
      // the active tool definitions from the host's public seams — and adds
      // only the bounded residual from a provider report that measured this
      // exact composition, so system or tool growth is visible on the very
      // request it appears, with or without any usage report, while an
      // estimate stays an estimate and a provider report stays a report.
      // Output and tool-growth headroom stay in effectiveDuePoint's clamp
      // below Pi's native compaction boundary.
      const systemTokens = typeof overhead?.systemPrompt === "string"
        ? estimateSystemPromptTokens(overhead.systemPrompt)
        : 0;
      let toolsTokens = 0;
      for (const definition of overhead?.toolDefinitions ?? []) {
        toolsTokens += estimateToolDefinitionTokens(definition);
      }
      const window = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : this.modelWindow;
      const duePoint = window === null || window === undefined
        ? null
        : effectiveDuePoint(this.config.compressionThreshold, this.config.memoryBudgetPercent, window, this.reserveTokens);
      // #324 arbitration classification: `customView` means this request
      // carries a constructed Memory view — the state-carrier projection or
      // the v1 blocks re-projection. Valid Memory without one is a refused
      // application: the custom projection stays off this request and the
      // complete baseline below becomes the safe-native-fallback candidate.
      const customView = applicationApplied || v1Projected !== undefined;
      const applicationRefused = memory.kind === "valid" && !customView;
      const memoryVersion = memory.kind === "valid" && applicationApplied ? memoryIdentity(memory) : "none";
      if (typeof window === "number" && duePoint !== null) {
        this.modelWindow ??= window;
        // Per-request state (#321): the scale-limit marker and the
        // last-served rebuild describe exactly this outgoing request.
        this.scaleLimit = false;
        this.lastServedRebuild = undefined;
        const total = this.estimateMessages(messages);
        this.due = total + systemTokens + toolsTokens
          + this.activeCalibrationTokens(memoryVersion, systemTokens, toolsTokens) >= duePoint;
        if (applicationRefused) {
          // The #324 native fallback: this request declines the custom
          // application, so it also discards every unrecorded candidate and
          // its maintenance request — no advisory rides a request whose
          // pinned sources cannot be projected, and nothing invites new work
          // onto a view that just refused. The recorded Memory itself stays
          // untouched and revalidated at the next request; Pi native
          // compaction keeps owning the boundary at its own safe idle/native
          // edge, never awaited from inside this handler or a running tool.
          this.invalidateMaintenanceRequest();
        } else if (this.due) {
          // Maintenance need is evaluated before every ordinary request (#320):
          // while due, the pending request is established, re-scoped onto real
          // growth, or cleared; the advisory rides this request only while a
          // request is pending and not suppressed. #321: a rebuild request
          // swaps the projection for the serving one — the suffix's complete
          // originals raw, its summaries gone — in this very request.
          const decision = this.evaluateMaintenance(session, {
            projection,
            aligned,
            memory,
            systemTokens,
            toolsTokens,
            window,
          });
          if (decision.request !== undefined && decision.request.operation === "rebuild" && decision.served !== undefined) {
            messages = decision.served;
            this.lastServedRebuild = {
              prefixEndEntryId: decision.request.previousEndEntryId,
              sourceEndEntryId: decision.request.sourceEndEntryId,
              memoryVersion: decision.request.memoryVersion,
            };
          } else if (decision.scaleLimit === true) {
            this.scaleLimit = true;
          }
        } else {
          this.invalidateMaintenanceRequest();
        }
        if (!applicationRefused && this.due && this.maintenance !== undefined && !maintenanceSuppressed(this.maintenanceFailures)) {
          const advisoryText = this.maintenance.operation === "rebuild"
            ? DUE_ADVISORY_REBUILD_TEXT
            : DUE_ADVISORY_TEXT;
          const insertAfter = findLastIndexOf(messages, (message) =>
            (message as { role?: unknown } | null)?.role === "user");
          if (insertAfter !== -1) {
            const next = [...messages];
            next.splice(insertAfter + 1, 0, {
              role: "custom",
              customType: CONTEXT_MEMORY_ADVISORY_TYPE,
              content: advisoryText,
              display: false,
              timestamp: Date.now(),
            });
            messages = next;
          }
        }
      }
      // ── The #324 request-exit arbitration fit check ──
      //
      // The final view — projection, rebuild serving, and advisory included,
      // plus the system prompt, active tool definitions, and the residual a
      // matching provider report calibrated — must fit under Pi's own native
      // compaction boundary (window minus Pi's reserve). The reserve is the
      // output and tool-growth headroom Pi itself relies on, and a request
      // above it is known-unsafe no matter which view produced it: the
      // projection already evicted everything it validly could, so the
      // larger baseline cannot fit either. With no validated view left, the
      // exit issues the public abort signal instead of sending anything,
      // discards the unrecorded maintenance candidates, and returns the
      // unmodified request: the cancellation owns the request, and if a host
      // still delivers it, it sees exactly the pre-extension view. A model
      // that ignores advisories, one huge tool result, or a no-net-benefit
      // scope all end here rather than sending a known-unsafe view. This is
      // never the normal compression mechanism: below the bound nothing
      // stops, and normal append/rebuild keep flowing through the projection
      // above without abort, restart, extra models, or native compact().
      if (typeof window === "number" && Number.isFinite(window) && window > 0) {
        const nativeBound = window - this.reserveTokens;
        if (nativeBound > 0) {
          const finalEstimate = this.estimateMessages(messages) + systemTokens + toolsTokens
            + this.activeCalibrationTokens(memoryVersion, systemTokens, toolsTokens);
          if (finalEstimate > nativeBound) {
            this.invalidateMaintenanceRequest();
            // The stopped request never became provider-bound, so a carrier
            // constructed for it must not count as applied (#324).
            this.appliedStateEntryId = appliedBeforeStop;
            let abortSignaled = false;
            if (typeof abortRequest === "function") {
              try {
                abortRequest();
                abortSignaled = true;
              } catch {
                // A host whose abort throws must not break the handler; the
                // verdict records the missing signal honestly instead.
              }
            }
            this.arbitration = {
              path: "stopped",
              estimateTokens: finalEstimate,
              boundTokens: nativeBound,
              ...(abortSignaled ? { abortSignaled: true } : {}),
            };
            return undefined;
          }
        }
      }
      this.arbitration = customView
        ? { path: "memory" }
        : {
          path: "native",
          reason: memory.kind === "valid" ? "refused" : memory.kind === "opaque" ? "opaque" : "no-memory",
        };
      // The estimate of the request actually returned — projection, artifact
      // filtering, rebuild serving, and advisory included — anchors the next
      // usage report's residual and the `/context` pressure split (#320). The
      // recorded version is the Memory the request actually carried ("none"
      // whenever the state-carrier application refused), beside the request's
      // own system-prompt and tool estimates.
      const finalEstimate = this.estimateMessages(messages);
      this.lastRequest = {
        estimateTokens: finalEstimate,
        systemTokens,
        toolsTokens,
        memoryVersion: memory.kind === "valid" && applicationApplied ? memoryIdentity(memory) : "none",
      };
      return { messages };
    } catch {
      return undefined;
    }
  }

  /**
   * Pi's per-message estimate over one message list with Context Memory
   * protocol artifacts removed (#320, #321): the one measure due judgment,
   * rebuild scale-limit proof, and the `/context` pressure split share.
   */
  private estimateMessages(messages: readonly unknown[]): number {
    let total = 0;
    for (const message of messages) {
      total += estimateFilteredMessageTokens(message as { role?: unknown; content?: unknown; toolName?: unknown });
    }
    return total;
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
    const evict = replacementEntryIdsOf(memory.blocks);
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
    const carrier = memoryCarrierMessage(memory.blocks, memory.carrierTimestamp);
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
   * per block. Returns undefined for any request shape that keeps the
   * ordinary unmodified compaction summary message, so the caller knows no
   * custom view was constructed. State-carried Memory already replaced any
   * base summary with its own carrier, so the two carriers never coexist.
   */
  private projectV1Blocks(messages: readonly unknown[], session: MemorySessionReader): unknown[] | undefined {
    let current: CurrentMemory;
    try {
      current = deriveCurrentMemory(session);
    } catch {
      return undefined;
    }
    if (current.kind !== "valid" || current.carrier !== "compaction") return undefined;
    const markdowns = current.blocks.map((block) => block.markdown);
    return projectMemoryBlocksMessage(messages, [{ summary: composeMemorySummary(markdowns), bodies: markdowns }]) ?? undefined;
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

    const snapshot: ContextMemorySnapshot = {
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
    const active = snapshot as {
      maintenance?: ContextMemoryMaintenanceInfo;
      pressure?: ContextMemoryPressureInfo;
      lastNetSavingsTokens?: number;
      scaleLimit?: true;
      arbitration?: ContextMemoryArbitrationInfo;
    };
    const maintenance = this.maintenanceInfo();
    if (maintenance !== undefined) active.maintenance = maintenance;
    const pressure = this.pressureInfo();
    if (pressure !== undefined) active.pressure = pressure;
    if (this.lastNetSavingsTokens !== undefined) active.lastNetSavingsTokens = this.lastNetSavingsTokens;
    if (this.scaleLimit) active.scaleLimit = true;
    if (this.arbitration !== undefined) active.arbitration = this.arbitration;
    return snapshot;
  }

  /**
   * The bounded pending-request diagnostics for `/context` (#320, #321):
   * present exactly while a maintenance request is pending, never a log.
   * #321 names the invited operation and, for a rebuild, the replaced block
   * count.
   */
  private maintenanceInfo(): ContextMemoryMaintenanceInfo | undefined {
    if (this.maintenance === undefined) return undefined;
    return {
      operation: this.maintenance.operation,
      sources: this.maintenance.sourceCount,
      suffixBlocks: this.maintenance.operation === "rebuild"
        ? this.maintenance.suffixBlocks ?? null
        : null,
      suppressed: maintenanceSuppressed(this.maintenanceFailures),
      lastErrorCode: this.maintenanceFailures?.lastCode ?? null,
    };
  }

  /**
   * The bounded pressure split for `/context` (#320): the deterministic
   * estimate of the last projected request (calibration term included), the
   * provider-reported size of the last measured request, and whether that
   * report measured the current Memory version. Absent until a request has
   * been projected or a report observed.
   */
  private pressureInfo(): ContextMemoryPressureInfo | undefined {
    if (this.lastRequest === undefined && this.reportedRequest === undefined) return undefined;
    return {
      estimated: this.lastRequest !== undefined
        ? this.lastRequest.estimateTokens + this.lastRequest.systemTokens + this.lastRequest.toolsTokens
          + this.activeCalibrationTokens(
            this.lastRequest.memoryVersion,
            this.lastRequest.systemTokens,
            this.lastRequest.toolsTokens,
          )
        : null,
      reported: this.reportedRequest?.tokens ?? null,
      reportedForCurrentMemory: this.reportedRequest !== undefined
        && this.reportedRequest.memoryVersion === memoryVersionOf(this.current),
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

/** The derivation identity pressure bookkeeping uses: a valid Memory's carrier id, else "none" (#320). */
function memoryVersionOf(memory: CurrentMemory): string {
  return memory.kind === "valid" ? memoryIdentity(memory) : "none";
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
