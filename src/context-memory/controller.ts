import type { AgentToolResult, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMPACTION_SETTINGS,
  buildSessionContext,
  estimateTokens as estimateMessageTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { ContextMemoryThreshold, ContextMemoryConfig } from "../core/config";
import { deriveCurrentMemory, isEligibleSourceEntry, isProtocolToolName, type CurrentMemory, type DerivedMemoryBlock, type MemorySessionReader } from "./derive";
import {
  MEMORY_BLOCK_SEPARATOR,
  MEMORY_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
  composeMemorySummary,
  isValidMemoryBlockBody,
  parseMemoryDetails,
  type MemoryCompactionDetails,
} from "./format";
import {
  paginateTranscript,
  renderSourceTranscript,
} from "./transcript";
import type { HostSupport } from "./host";
import {
  READ_MEMORY_SOURCE_TOOL_NAME,
  SUBMIT_MEMORY_TOOL_NAME,
  type ReadMemorySourceDetails,
  type ReadMemorySourceRequest,
} from "./tools";
import {
  CONTEXT_MEMORY_ADVISORY_TYPE,
  CONTEXT_MEMORY_MAX_VIEW_ROWS,
  type ContextMemoryBlockRow,
  type ContextMemorySnapshot,
} from "./view";

/**
 * The session-scoped Context Memory controller (odradekk/pi-square#215, #216, #217, #218, #219, #220, #221, #222, #253).
 *
 * The controller is the highest test seam: tests drive it through the same
 * registrar events and tool surfaces Pi drives and assert externally visible
 * state — the read-only snapshot, the active tool set, and tool/inspection
 * output. #217 added current-leaf derivation, strict format parsing, block
 * source recovery with fixed 16 KiB paging, `read_memory_source`
 * activation/execution, and the `/context memory` detail rendering. #218
 * adds the first-block submission handshake: due detection under the
 * pre-native safety clamp, the one ephemeral tail advisory through Pi's
 * context transform, the run-scoped `submit_memory` candidate slot, and
 * compaction takeover through `session_before_compact` with exact
 * `session_compact` confirmation. #219 appends further blocks onto existing
 * valid Memory with a byte-stable prefix: the append advisory, the
 * multi-block candidate directory, and the takeover's exact prefix match.
 * #221 completes the branch-private lifecycle: derivation always follows
 * Pi's actual current leaf across resume, tree navigation, fork, clone,
 * import, cross-directory copies, and session replacement, ephemeral
 * in-memory sessions run the same behavior with an `ephemeral` snapshot
 * marker and no sidecar, and no cancellable Pi session event is ever
 * subscribed or blocked. #220 rebuilds a recent suffix: while rendered
 * Memory sits above half its budget the next due run selects the shortest
 * newest contiguous suffix whose removal leaves an unchanged prefix at or
 * below half budget, replaces the selected summaries with their complete
 * original conversation in the one first-request maintenance projection,
 * and lets the main agent author one replacement block; when that complete
 * request cannot fit the model window under a ten-percent safety allowance,
 * the branch reports its scale limit, exposes no submission handshake, and
 * Pi native compaction keeps owning the boundary. #222 hardens the
 * native-fallback boundary around the existing guarantees: the transaction
 * slot leaves `pending`/`committing` only through Pi's seam or the next run
 * boundary, and Pi's `SessionManager` stays the only session-file writer —
 * one writer per session file, with forked or cloned session files as the
 * supported parallel workflow. #253 decouples the submission from the run's
 * end: an accepted candidate no longer terminates the tool batch, the model
 * continues the same run after the pending acknowledgement, `submit_memory`
 * deactivates for the rest of the due run so exactly one submission is
 * taken, and post-submission work stays uncompressed because it falls after
 * the kept boundary — bounded by the distance that remains to Pi's native
 * compaction boundary when the run opens. The due point itself always sits
 * at least ten percent of the window below that boundary (farther below
 * when the configured threshold is lower), but usage is only re-checked at
 * session start, model selection, and agent settle, so the remaining
 * distance at open can be smaller than that gap — down toward zero when
 * usage already passed the due point — or far larger near a low configured
 * threshold, and the existing native fallback owns a run that exhausts it
 * before settling. The compatibility gate
 * and owned active-tool synchronization stay.
 */

/** The only tool names this feature may add to or remove from the active list. */
export const OWNED_TOOL_NAMES: readonly string[] = Object.freeze([
  SUBMIT_MEMORY_TOOL_NAME,
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
 * one separator per block, every body — the single measure the half-budget
 * rule, the `/context` estimate, and the submission budget share (#219).
 */
function renderedMemoryTokens(markdowns: readonly string[]): number {
  let chars = MEMORY_SUMMARY_WRAPPER.length + MEMORY_BLOCK_SEPARATOR.length * markdowns.length;
  for (const markdown of markdowns) chars += Array.from(markdown).length;
  return Math.ceil(chars / 4);
}

/**
 * The unchanged-prefix size of the next maintenance run (#220): the largest
 * prefix count whose rendered Memory still fits half the budget, making the
 * suffix after it the shortest newest contiguous suffix whose removal leaves
 * that prefix at or below half. Measured with the one shared
 * {@link renderedMemoryTokens} measure; every body is non-empty, so the
 * prefix grows monotonically with the count.
 */
function selectStablePrefixCount(markdowns: readonly string[], halfBudget: number): number {
  let stable = 0;
  while (stable < markdowns.length && renderedMemoryTokens(markdowns.slice(0, stable + 1)) <= halfBudget) {
    stable += 1;
  }
  return stable;
}

/**
 * Project one original source entry into the maintenance request (#220):
 * Pi's own `sessionEntryToContextMessages` projection with Context Memory
 * protocol tool-call parts removed from assistant messages — derivation
 * already excluded whole protocol artifacts — so the inserted original
 * conversation never resurrects `submit_memory` or `read_memory_source`
 * calls. An assistant message left without any eligible part drops.
 */
function projectSourceEntry(entry: SessionEntry): unknown[] {
  const messages: unknown[] = [];
  for (const message of sessionEntryToContextMessages(entry)) {
    const record = message as { role?: unknown; content?: unknown } | null;
    if (record && record.role === "assistant" && Array.isArray(record.content)) {
      const kept = record.content.filter((part) =>
        (part as { type?: unknown; name?: unknown } | null)?.type !== "toolCall"
        || !isProtocolToolName((part as { name?: unknown }).name));
      if (kept.length === 0) continue;
      if (kept.length !== record.content.length) {
        messages.push({ ...record, content: kept });
        continue;
      }
    }
    messages.push(message);
  }
  return messages;
}

/** Every selected block's original source messages, in source order (#220). */
function projectedSourceMessages(plan: RebuildPlan): unknown[] {
  const messages: unknown[] = [];
  for (const block of plan.suffix) {
    for (const entry of block.sourceEntries) messages.push(...projectSourceEntry(entry));
  }
  return messages;
}

/**
 * Whether the complete maintenance request exceeds the model window under
 * the ten-percent safety allowance (#220): the current context baseline —
 * numeric Pi usage or the deterministic projection estimate — with the full
 * Memory summary replaced by the unchanged prefix rendering, every selected
 * original source entry, the advisory, and the current request added. A
 * null baseline cannot prove the fit, so it reports the limit. Nothing is
 * ever truncated, paged, or summarized to make it fit.
 */
function maintenanceExceedsWindow(
  baselineTokens: number | null,
  plan: RebuildPlan,
  requestTokens: number,
  contextWindow: number,
): boolean {
  if (baselineTokens === null) return true;
  let estimate = baselineTokens
    - estimateTextTokens(plan.fullSummary)
    + estimateTextTokens(plan.prefixSummary)
    + estimateTextTokens(MAINTENANCE_RUN_ADVISORY_TEXT)
    + requestTokens;
  for (const message of projectedSourceMessages(plan)) {
    estimate += estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
  }
  return estimate > contextWindow - Math.round(contextWindow / 10);
}

/**
 * The one-request maintenance projection (#220): the request's Memory
 * summary message keeps exactly the unchanged prefix rendering, every
 * selected block's original conversation is inserted once in source order
 * right after it, and the retained raw tail and current request stay
 * untouched. Returns undefined when the carrying summary is not in the
 * request, which the transform treats as projection failure.
 */
function projectMaintenanceContext(messages: readonly unknown[], plan: RebuildPlan): unknown[] | undefined {
  const summaryIndex = messages.findIndex((message) => {
    const record = message as { role?: unknown; summary?: unknown } | null;
    return record?.role === "compactionSummary" && record.summary === plan.fullSummary;
  });
  if (summaryIndex === -1) return undefined;
  const projected = [...messages];
  projected[summaryIndex] = { ...(projected[summaryIndex] as Record<string, unknown>), summary: plan.prefixSummary };
  projected.splice(summaryIndex + 1, 0, ...projectedSourceMessages(plan));
  return projected;
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

/**
 * The effective due point for the current model (#215, #218): the configured
 * percent/token threshold capped ten percent of the window below Pi's native
 * compaction boundary (window − Pi reserve − ten percent of the window).
 * `null` disables structured takeover — a non-positive point, or a Memory
 * budget that is not strictly smaller than the due point.
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

/**
 * The fixed continuation sentence every due-run advisory ends with (#253):
 * the submission is not the run's end — the model answers the user in the
 * same run after the pending acknowledgement.
 */
const ADVISORY_CONTINUATION_SENTENCE =
  "After the acknowledgement, continue the same run and deliver your answer to the user.";

/** The fixed one-shot first-block advisory body (#215, #218, #253: append instruction, source scope, secret warning). */
const DUE_RUN_ADVISORY_TEXT = [
  "Context Memory: compression is due for this conversation.",
  "",
  `Complete the user's current task first. When it is done, call submit_memory as the sole tool call of its batch, carrying one concise Markdown Memory block that preserves what matters from the conversation before this run — goals, decisions, and open work. ${ADVISORY_CONTINUATION_SENTENCE}`,
  "That block will replace the older conversation as compressed context; the current request and everything you do for it stay uncompressed.",
  "Do not copy credential values, private keys, access tokens, or other secrets into the Memory block.",
].join("\n");

/**
 * The fixed one-shot append advisory body (#219, #253): the new block covers
 * the conversation accumulated since the existing blocks and is appended
 * after them, keeping every existing block unchanged. The submission no
 * longer ends the run — the model continues in the same run afterwards.
 */
const APPEND_RUN_ADVISORY_TEXT = [
  "Context Memory: compression is due for this conversation.",
  "",
  `Complete the user's current task first. When it is done, call submit_memory as the sole tool call of its batch, carrying one concise Markdown Memory block that preserves what matters from the conversation since the existing Memory blocks — goals, decisions, and open work. ${ADVISORY_CONTINUATION_SENTENCE}`,
  "That block will be appended after the existing Memory blocks, which stay unchanged; the current request and everything you do for it stay uncompressed.",
  "Do not copy credential values, private keys, access tokens, or other secrets into the Memory block.",
].join("\n");

/**
 * The fixed one-shot maintenance advisory body (#220, #253): the request
 * carries the complete original conversation behind the newest Memory blocks
 * in place of their summaries, and one replacement block must cover that
 * conversation plus the newly accumulated raw tail while every older block
 * stays unchanged. The submission no longer ends the run — the model
 * continues in the same run afterwards.
 */
const MAINTENANCE_RUN_ADVISORY_TEXT = [
  "Context Memory: maintenance compression is due for this conversation.",
  "",
  `This request shows the original conversation behind the newest Memory blocks in place of their summaries. Complete the user's current task first. When it is done, call submit_memory as the sole tool call of its batch, carrying one concise Markdown Memory block that preserves what matters from that original conversation and the work accumulated since — goals, decisions, and open work. ${ADVISORY_CONTINUATION_SENTENCE}`,
  "That block will replace the newest Memory blocks; the older Memory blocks stay unchanged; the current request and everything you do for it stay uncompressed.",
  "Do not copy credential values, private keys, access tokens, or other secrets into the Memory block.",
].join("\n");

/** The frozen due run opened by one real-user input (#218, #219, #220). */
interface DueRunState {
  /** Leaf id at the opening input; the run's user request is the first user entry after it. */
  readonly preRunLeafId: string | null;
  /** The frozen operation: a first block or append (#218, #219), or a suffix rebuild (#220). */
  readonly operation: "append" | "rebuild";
  /** Blocks kept byte-stable by the run; opens the append advisory scope for a first block or append (#219). */
  readonly existingBlocks: number;
  /** The frozen maintenance plan; set exactly for a rebuild (#220). */
  readonly rebuild: RebuildPlan | undefined;
  advisoryDelivered: boolean;
  /**
   * Whether this due run already accepted one submission (#253). One block
   * covers one continuous entry range, so a due run takes exactly one
   * submission; after it `submit_memory` leaves the active tool list for the
   * rest of the run so the model cannot spend a call on a guaranteed
   * `COMPACTION_BUSY` refusal.
   */
  submitted: boolean;
}

/** One existing block kept byte-identical ahead of a newly appended block (#219). */
interface MemoryPrefixBlock {
  readonly markdown: string;
  readonly endEntryId: string;
}

/**
 * The frozen maintenance selection of one due run (#220): the unchanged
 * prefix, the selected newest blocks the replacement covers together with
 * their original source entries, and the exact summary renderings the
 * first-request projection matches and substitutes.
 */
interface RebuildPlan {
  /** Carrying compaction the selection was derived from. */
  readonly compactionId: string;
  /** Unselected older blocks kept byte-identical, in order. */
  readonly prefix: readonly MemoryPrefixBlock[];
  /** Selected newest blocks replaced by one new block, with their original source entries. */
  readonly suffix: readonly DerivedMemoryBlock[];
  /** The exact rendered Memory at selection; identifies the request's summary message. */
  readonly fullSummary: string;
  /** The exact rendered prefix; the projection's replacement summary. */
  readonly prefixSummary: string;
}

/** One accepted submission awaiting compaction (#218, #219, #220). Never persisted. */
interface MemoryCandidate {
  /** Leaf at acceptance; navigation since invalidates the candidate. */
  readonly leafId: string;
  readonly toolCallId: string;
  readonly operation: "append" | "rebuild";
  /** Blocks kept byte-identical ahead of the new one; empty for a first block or a full rebuild (#219, #220). */
  readonly prefix: readonly MemoryPrefixBlock[];
  /** Rebuild: the selected suffix blocks the new one replaces; empty for an append (#220). */
  readonly replacedSuffix: readonly MemoryPrefixBlock[];
  /** Carrying compaction the prefix was derived from; undefined for the first block. */
  readonly prefixCompactionId: string | undefined;
  /** Inclusive source end: the last eligible entry covered by the new block. */
  readonly sourceEndEntryId: string;
  /** Retained-tail boundary: the real user entry that began the due run. */
  readonly firstKeptEntryId: string;
  readonly contextWindow: number;
  readonly markdown: string;
  readonly summary: string;
  readonly details: MemoryCompactionDetails;
}

/**
 * The single in-memory transaction slot (#215: phases `pending` and
 * `committing`; never queued, overwritten, retried, or persisted).
 *
 * The slot leaves a phase only through Pi's seam or a run boundary (#222):
 * exact `session_compact` confirmation, a takeover mismatch, or the next
 * real-user input, tree/model invalidation, reload or session replacement,
 * or shutdown. Pi 0.84.2 exposes no compaction-failure event to extensions
 * — `compaction_end` stays on the internal subscribe channel — so a
 * compaction that never starts or never saves leaves the slot reporting its
 * phase without writing anything or blocking native compaction, until the
 * next run boundary clears it.
 */
interface TransactionSlot {
  phase: "pending" | "committing";
  readonly candidate: MemoryCandidate;
}

/** The minimal Pi context surfaces the due handshake consumes. */
export interface ContextMemoryRunContext {
  readonly sessionManager: MemorySessionReader;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
  compact(): void;
}

export class ContextMemoryController {
  private readonly config: ContextMemoryConfig;
  private readonly support: HostSupport;
  private current: CurrentMemory;
  /** Whether the current session is ephemeral (in-memory, unpersisted) (#221). */
  private ephemeralSession = false;
  /** The carrying compaction the active `read_memory_source` window was opened against. */
  private activeCompactionId: string | undefined;
  /** Pi's configured compaction reserve, captured at session start (#218). */
  private reserveTokens: number = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  /** The model window the current due point was computed against. */
  private modelWindow: number | null = null;
  /** In-memory due flag; recomputed at session start, model change, and settle. */
  private due = false;
  /** The branch is at its scale limit: maintenance cannot fit the window, so Pi native compaction owns it (#220). */
  private scaleLimited = false;
  /** The due run opened by the current real-user input, if any (#218). */
  private dueRun: DueRunState | undefined;
  /** The single submission transaction slot (#218). */
  private slot: TransactionSlot | undefined;
  /** Tool-call ids of the most recent assistant message (#218 sole-call check). */
  private lastToolBatch: readonly string[] | undefined;

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
   * Usage numbers come from the caller's live context usage, so estimates stay
   * current without persistence.
   */
  snapshot(usage?: ContextMemoryUsageInput): ContextMemorySnapshot {
    if (!this.config.enabled) return { state: "disabled" };
    if (!this.support.supported) return { state: "unsupported", reason: this.support.reason };
    if (this.slot?.phase === "committing") return this.markEphemeral({ state: "committing" });
    if (this.slot?.phase === "pending") return this.markEphemeral({ state: "pending" });
    if (this.current.kind === "none") return this.markEphemeral(this.due ? { state: "due" } : { state: "no-memory" });
    if (this.current.kind === "opaque") return this.markEphemeral({ state: "opaque" });
    if (this.scaleLimited) return this.markEphemeral({ state: "scale-limit" });
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
   * active tool selected by Pi or another pi-square module. `submit_memory`
   * is active exactly while a due real-user run is open and has not yet
   * accepted its one submission (#218, #253) — acceptance deactivates it for
   * the rest of the run; `read_memory_source` is active exactly while enabled
   * on a supported host with strictly valid non-empty current Memory (#217).
   * Returns the owned names removed from the active list.
   */
  synchronizeActiveTools(
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
    session: MemorySessionReader,
  ): readonly string[] {
    this.refresh(session);
    const active = pi.getActiveTools();
    const removed = active.filter((name) => OWNED_TOOL_NAME_SET.has(name));
    const desired = active.filter((name) => !OWNED_TOOL_NAME_SET.has(name));
    const readActive = this.config.enabled
      && this.support.supported
      && this.current.kind === "valid"
      && this.current.blocks.length > 0;
    if (readActive) desired.push(READ_MEMORY_SOURCE_TOOL_NAME);
    if (this.dueRun !== undefined && !this.dueRun.submitted) desired.push(SUBMIT_MEMORY_TOOL_NAME);
    this.activeCompactionId = readActive && this.current.kind === "valid" ? this.current.compactionId : undefined;
    const changed = active.length !== desired.length || active.some((name, index) => name !== desired[index]);
    if (changed) pi.setActiveTools(desired);
    return removed;
  }

  // ── #218: due detection and the first-block submission handshake ──

  /** Whether the feature is enabled on a supported host. */
  private operational(): boolean {
    return this.config.enabled && this.support.supported;
  }

  /** Capture Pi's compaction reserve for the pre-native safety clamp. */
  adoptRuntime(reserveTokens: number): void {
    this.reserveTokens = reserveTokens;
  }

  /**
   * Recompute the effective due point and in-memory due flag from the
   * caller's context usage. Numeric Pi usage wins; otherwise one
   * deterministic chars/4 estimate over the projected branch, with submit
   * artifacts filtered, decides (#215). No counter persists. A due branch
   * above half its Memory budget also re-proves the maintenance fit, which
   * reports the scale-limit state when the complete request cannot fit
   * (#220).
   */
  recomputeDue(ctx: ContextMemoryRunContext): void {
    this.refresh(ctx.sessionManager);
    this.due = false;
    this.scaleLimited = false;
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
    const tokens = usage && typeof usage.tokens === "number" ? usage.tokens : null;
    const estimate = tokens ?? this.estimateProjectedTokens(ctx.sessionManager);
    this.due = estimate !== null && estimate >= duePoint;
    if (this.due) this.assessMaintenanceFit(estimate, 0);
  }

  /**
   * Recompute the reported scale-limit state for the current derivation
   * (#220): only due valid Memory above half its budget plans a maintenance
   * run, and the branch is at its scale limit exactly when that complete
   * request cannot fit the model window. No block is ever deleted, scaled,
   * or rewritten to make it fit.
   */
  private assessMaintenanceFit(baselineTokens: number | null, requestTokens: number): void {
    this.scaleLimited = false;
    if (this.current.kind !== "valid" || this.modelWindow === null) return;
    const halfBudget = Math.round((this.modelWindow * this.config.memoryBudgetPercent) / 100) / 2;
    const markdowns = this.current.blocks.map((block) => block.markdown);
    if (renderedMemoryTokens(markdowns) <= halfBudget) return;
    const plan = this.rebuildPlan(this.current, halfBudget);
    this.scaleLimited = maintenanceExceedsWindow(baselineTokens, plan, requestTokens, this.modelWindow);
  }

  /**
   * The maintenance selection for current valid Memory above half its
   * budget (#220): the largest prefix whose rendered Memory still fits half
   * the budget, so the suffix after it is the shortest newest contiguous
   * suffix whose removal leaves that unchanged prefix.
   */
  private rebuildPlan(memory: Extract<CurrentMemory, { kind: "valid" }>, halfBudget: number): RebuildPlan {
    const markdowns = memory.blocks.map((block) => block.markdown);
    const stable = selectStablePrefixCount(markdowns, halfBudget);
    return {
      compactionId: memory.compactionId,
      prefix: memory.blocks.slice(0, stable).map((block) => ({ markdown: block.markdown, endEntryId: block.endEntryId })),
      suffix: memory.blocks.slice(stable),
      fullSummary: composeMemorySummary(markdowns),
      prefixSummary: composeMemorySummary(markdowns.slice(0, stable)),
    };
  }

  /**
   * Deterministic fallback estimator: Pi's own projection and per-message
   * chars/4 heuristic over the current branch, with `submit_memory` artifacts
   * removed so a past submission never counts twice (#215).
   */
  private estimateProjectedTokens(session: MemorySessionReader): number | null {
    try {
      const leafId = session.getLeafId?.() ?? undefined;
      const projected = buildSessionContext([...session.getBranch(leafId)], leafId).messages;
      let total = 0;
      for (const message of projected) {
        total += estimateFilteredMessageTokens(message);
      }
      return total;
    } catch {
      return null;
    }
  }

  /**
   * The `input` boundary (#215, #218–#220): only a real-user input may open
   * a due handshake, and it activates `submit_memory` before Pi builds the
   * first model request. A steering input during an open run keeps it. A new
   * real-user run clears all transient state first.
   */
  handleInput(
    event: { readonly source: unknown; readonly text?: unknown },
    ctx: ContextMemoryRunContext,
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
  ): void {
    if (!this.operational()) return;
    const realUser = event.source === "interactive" || event.source === "rpc";
    if (!realUser) return;
    if (this.dueRun !== undefined && !ctx.isIdle()) return;
    this.clearTransient();
    this.synchronizeActiveTools(pi, ctx.sessionManager);
    if (!this.due) return;
    const dueRun = this.planDueRun(event, ctx);
    if (dueRun === null) return;
    this.dueRun = dueRun;
    this.synchronizeActiveTools(pi, ctx.sessionManager);
  }

  /**
   * Freeze the due run's operation at the opening input (#218–#220): the
   * first block on a branch with no Memory, an append while rendered Memory
   * still fits half the configured budget (#219), or the suffix rebuild
   * above it (#220). `null` opens no run — opaque Memory, an unknown model
   * window, or the scale limit, where the complete maintenance request
   * cannot fit the window and Pi native compaction keeps owning the
   * boundary.
   */
  private planDueRun(
    event: { readonly text?: unknown },
    ctx: ContextMemoryRunContext,
  ): DueRunState | null {
    // A due run that opens is never at the scale limit; only the refused
    // maintenance input below reports it.
    this.scaleLimited = false;
    const preRunLeafId = ctx.sessionManager.getLeafId?.() ?? null;
    if (this.current.kind === "opaque") return null;
    if (this.modelWindow === null) return null;
    if (this.current.kind === "none") {
      return { preRunLeafId, operation: "append", existingBlocks: 0, rebuild: undefined, advisoryDelivered: false, submitted: false };
    }
    const halfBudget = Math.round((this.modelWindow * this.config.memoryBudgetPercent) / 100) / 2;
    const markdowns = this.current.blocks.map((block) => block.markdown);
    if (renderedMemoryTokens(markdowns) <= halfBudget) {
      return { preRunLeafId, operation: "append", existingBlocks: markdowns.length, rebuild: undefined, advisoryDelivered: false, submitted: false };
    }
    const plan = this.rebuildPlan(this.current, halfBudget);
    const usage = ctx.getContextUsage();
    const numeric = usage && typeof usage.tokens === "number" ? usage.tokens : null;
    const requestTokens = typeof event.text === "string" ? estimateTextTokens(event.text) : 0;
    if (maintenanceExceedsWindow(numeric ?? this.estimateProjectedTokens(ctx.sessionManager), plan, requestTokens, this.modelWindow)) {
      this.scaleLimited = true;
      return null;
    }
    return { preRunLeafId, operation: "rebuild", existingBlocks: plan.prefix.length, rebuild: plan, advisoryDelivered: false, submitted: false };
  }

  /**
   * The ephemeral `context` transform (#215, #218, #220). It never throws.
   * Three deterministic rules apply while the feature is enabled on a
   * supported host:
   *
   * - `submit_memory` tool-call parts and their paired results leave every
   *   provider-bound request, with one exception (#253): while the run
   *   continues after an accepted submission, the trailing submitting
   *   exchange — the final submit call and its paired result — passes
   *   through whole, because removing it would end the request on an
   *   assistant turn. Ordinary assistant text in the same message survives
   *   and `read_memory_source` artifacts stay visible.
   * - On the first provider request of a due run, one fixed custom advisory
   *   is appended after the current user message and never repeated.
   * - On the first provider request of a maintenance run only, the Memory
   *   summary message keeps exactly the unchanged prefix while every
   *   selected block's complete original conversation is inserted once, in
   *   source order, ahead of the retained raw tail — selected summaries and
   *   their sources never appear together (#220).
   *
   * On projection failure it returns the unmodified safe context, deactivates
   * submission for the run, and clears due-run transient state.
   */
  transformContext(
    event: { readonly messages: readonly unknown[] },
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
    session: MemorySessionReader,
  ): { messages: readonly unknown[] } | undefined {
    if (!this.operational()) return undefined;
    const original = event.messages;
    try {
      let messages = filterSubmitArtifacts(original);
      if (this.dueRun !== undefined && !this.dueRun.advisoryDelivered) {
        if (this.dueRun.operation === "rebuild") {
          const maintenance = projectMaintenanceContext(messages, this.dueRun.rebuild!);
          if (maintenance === undefined) throw new Error("the carrying Memory summary is not in the request");
          messages = maintenance;
        }
        let insertAfter = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if ((messages[i] as { role?: unknown } | null)?.role === "user") {
            insertAfter = i;
            break;
          }
        }
        if (insertAfter === -1) throw new Error("no current user message");
        messages.splice(insertAfter + 1, 0, {
          role: "custom",
          customType: CONTEXT_MEMORY_ADVISORY_TYPE,
          content: this.advisoryText(),
          display: false,
          timestamp: Date.now(),
        });
        this.dueRun.advisoryDelivered = true;
      }
      return { messages };
    } catch {
      // Projection failure: deactivate submission for the run and leave the
      // safe original context in place (#215).
      this.dueRun = undefined;
      this.synchronizeActiveTools(pi, session);
      return undefined;
    }
  }

  /** The one advisory body for the frozen operation: maintenance, append, or the first block (#218–#220). */
  private advisoryText(): string {
    if (this.dueRun!.operation === "rebuild") return MAINTENANCE_RUN_ADVISORY_TEXT;
    return this.dueRun!.existingBlocks > 0 ? APPEND_RUN_ADVISORY_TEXT : DUE_RUN_ADVISORY_TEXT;
  }

  /**
   * Record the tool-call ids of the most recent assistant message so
   * `submit_memory` can refuse a batch it does not solely occupy (#215).
   */
  noteAssistantToolBatch(message: unknown): void {
    const record = message as { role?: unknown; content?: unknown } | null | undefined;
    if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return;
    const ids: string[] = [];
    for (const part of record.content) {
      const candidate = part as { type?: unknown; id?: unknown } | null;
      if (candidate?.type === "toolCall" && typeof candidate.id === "string") ids.push(candidate.id);
    }
    this.lastToolBatch = ids;
  }

  /** Clear an aborted run's transient state: the slot and the open due run (#215). */
  noteAbortedRun(): void {
    this.clearTransient();
  }

  /**
   * Execute one `submit_memory` call (#218, #253): validate the due run, the
   * sole tool call, the transaction slot, and the block body, then store the
   * run-scoped candidate. Returns the fixed pending acknowledgement without
   * ending the run — the model keeps working in the same run, and acceptance
   * synchronizes `submit_memory` out of the active tool list through the
   * required tool surface, so it stays gone for the rest of the due run
   * (one submission per run; a block covers one continuous entry range).
   * Compaction itself happens later through Pi's seam at the run's natural
   * settle. Throws one safe short-coded sentence and never echoes Markdown.
   */
  async submitCandidate(
    markdown: string,
    toolCallId: string,
    session: MemorySessionReader,
    tools: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
  ): Promise<AgentToolResult<{ accepted: true }>> {
    if (!this.operational() || this.dueRun === undefined) {
      fail("SUBMIT_NOT_DUE", "no Context Memory compression is due in this run");
    }
    if (this.slot !== undefined) {
      fail("COMPACTION_BUSY", "a Memory candidate is already awaiting compaction");
    }
    const batch = this.lastToolBatch;
    if (batch === undefined || !batch.includes(toolCallId) || batch.length > 1) {
      fail("SUBMIT_NOT_SOLE_TOOL", "submit_memory must be the sole tool call in its batch");
    }
    if (!isValidMemoryBlockBody(markdown)) {
      fail("BOUND_EXCEEDED", "the Memory block body exceeds the size or content bounds");
    }
    const candidate = this.bindCandidate(markdown, toolCallId, session);
    this.slot = { phase: "pending", candidate };
    this.dueRun.submitted = true;
    this.synchronizeActiveTools(tools, session);
    return {
      content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }],
      details: { accepted: true },
    };
  }

  /** Resolve the candidate binding against the live branch, or refuse safely. */
  private bindCandidate(markdown: string, toolCallId: string, session: MemorySessionReader): MemoryCandidate {
    const leafId = session.getLeafId?.() ?? null;
    if (leafId === null) fail("MEMORY_CHANGED", "the current branch no longer carries the due run");
    const branch = [...session.getBranch(leafId)];
    const preRunLeafId = this.dueRun!.preRunLeafId;
    const preRunIndex = preRunLeafId === null ? -1 : branch.findIndex((entry) => entry.id === preRunLeafId);
    if (preRunLeafId !== null && preRunIndex === -1) {
      fail("MEMORY_CHANGED", "the current branch no longer carries the due run");
    }
    let requestIndex = -1;
    for (let i = preRunIndex + 1; i < branch.length; i++) {
      if (isUserMessageEntry(branch[i])) {
        requestIndex = i;
        break;
      }
    }
    if (requestIndex === -1) {
      fail("MEMORY_CHANGED", "the current run's user request is no longer on the branch");
    }
    let sourceEndIndex = -1;
    for (let i = requestIndex - 1; i >= 0; i--) {
      if (isEligibleSourceEntry(branch[i])) {
        sourceEndIndex = i;
        break;
      }
    }
    if (sourceEndIndex === -1) {
      fail("SUBMIT_NOT_DUE", "no eligible conversation precedes the current user request");
    }
    // #219/#220: the new block extends the existing valid list — an append
    // keeps every live block, a rebuild keeps the frozen unchanged prefix
    // and replaces the selected suffix — both derived live here and
    // re-matched at takeover. A branch with no Memory starts the first block.
    const current = deriveCurrentMemory(session);
    if (current.kind === "opaque") {
      fail("MEMORY_CHANGED", "current Memory is no longer valid structured Context Memory");
    }
    const prefix: MemoryPrefixBlock[] = [];
    let replacedSuffix: readonly MemoryPrefixBlock[] = [];
    let prefixCompactionId: string | undefined;
    if (this.dueRun!.operation === "rebuild") {
      const plan = this.dueRun!.rebuild!;
      const selected = [...plan.prefix, ...plan.suffix];
      if (current.kind !== "valid"
        || current.compactionId !== plan.compactionId
        || current.blocks.length !== selected.length
        || current.blocks.some((block, index) =>
          block.endEntryId !== selected[index]!.endEntryId
          || block.markdown !== selected[index]!.markdown)) {
        fail("MEMORY_CHANGED", "current Memory changed since the maintenance run opened");
      }
      prefix.push(...plan.prefix);
      replacedSuffix = plan.suffix.map((block) => ({ markdown: block.markdown, endEntryId: block.endEntryId }));
      prefixCompactionId = plan.compactionId;
    } else if (current.kind === "valid") {
      const lastEndIndex = branch.findIndex(
        (entry) => entry.id === current.blocks[current.blocks.length - 1]!.endEntryId,
      );
      if (lastEndIndex === -1 || sourceEndIndex <= lastEndIndex) {
        fail("SUBMIT_NOT_DUE", "no eligible conversation accumulated since the existing Memory blocks");
      }
      for (const block of current.blocks) prefix.push({ markdown: block.markdown, endEntryId: block.endEntryId });
      prefixCompactionId = current.compactionId;
    }
    const summary = composeMemorySummary([...prefix.map((block) => block.markdown), markdown]);
    const details: MemoryCompactionDetails = {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        ...prefix.map((block) => ({
          endEntryId: block.endEntryId,
          markdownBytes: Buffer.byteLength(block.markdown, "utf8"),
        })),
        {
          endEntryId: branch[sourceEndIndex]!.id,
          markdownBytes: Buffer.byteLength(markdown, "utf8"),
        },
      ],
    };
    if (parseMemoryDetails(details) === undefined) {
      fail("BOUND_EXCEEDED", "the Memory directory exceeds the persisted format bounds");
    }
    const contextWindow = this.windowForBudget();
    if (estimateTextTokens(summary) > Math.round((contextWindow * this.config.memoryBudgetPercent) / 100)) {
      fail("BOUND_EXCEEDED", "the Memory blocks exceed the configured Memory budget");
    }
    return {
      leafId,
      toolCallId,
      operation: this.dueRun!.operation,
      prefix,
      replacedSuffix,
      prefixCompactionId,
      sourceEndEntryId: branch[sourceEndIndex]!.id,
      firstKeptEntryId: branch[requestIndex]!.id,
      contextWindow,
      markdown,
      summary,
      details,
    };
  }

  /** The model window the current due point was computed against (null when the takeover is disabled). */
  private windowForBudget(): number {
    if (this.modelWindow === null) {
      fail("SUBMIT_NOT_DUE", "no Context Memory compression is due in this run");
    }
    return this.modelWindow;
  }

  /**
   * `agent_settled` (#215, #218): a pending candidate is committed through
   * Pi's public compaction seam exactly once per qualifying settle — no
   * autonomous model turn. The due run closes, `submit_memory` deactivates,
   * and the due flag is recomputed from current usage. A candidate Pi never
   * took stays in the slot and may be offered again at a later qualifying
   * settle; otherwise it survives only until the next run boundary (#222).
   */
  handleSettled(
    ctx: ContextMemoryRunContext,
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
  ): void {
    if (!this.operational()) return;
    if (this.slot?.phase === "pending" && ctx.isIdle() && !ctx.hasPendingMessages()) {
      ctx.compact();
    }
    if (this.dueRun !== undefined) {
      this.dueRun = undefined;
      this.synchronizeActiveTools(pi, ctx.sessionManager);
    }
    this.lastToolBatch = undefined;
    this.recomputeDue(ctx);
  }

  /** Tree or model invalidation clears every transient handshake state (#215). */
  invalidateTransient(
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
    session: MemorySessionReader,
    ctx?: ContextMemoryRunContext,
  ): void {
    this.clearTransient();
    this.synchronizeActiveTools(pi, session);
    if (ctx) this.recomputeDue(ctx);
  }

  private clearTransient(): void {
    this.dueRun = undefined;
    this.slot = undefined;
    this.lastToolBatch = undefined;
  }

  /**
   * `session_before_compact` (#215, #218): consume a matching pending
   * candidate without another model call. Atomically enters `committing`,
   * re-derives the branch snapshot, and returns the custom compaction with
   * the run's user request as `firstKeptEntryId` and Pi's own preparation
   * token accounting. Any mismatch clears the slot and returns nothing so
   * Pi native compaction proceeds — `cancel` is never returned.
   */
  consumeCompaction(
    event: SessionBeforeCompactEvent,
    session: MemorySessionReader,
  ): { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: MemoryCompactionDetails } } | undefined {
    if (this.slot?.phase !== "pending") return undefined;
    const candidate = this.slot.candidate;
    const mismatch = (): undefined => {
      this.slot = undefined;
      return undefined;
    };
    const leafId = session.getLeafId?.() ?? null;
    if (leafId === null) return mismatch();
    const branch = [...session.getBranch(leafId)];
    // The accepted leaf may only extend by ordinary run entries appended after
    // acceptance; navigation away removes it from the current path.
    if (!branch.some((entry) => entry.id === candidate.leafId)) return mismatch();
    const requestIndex = branch.findIndex((entry) => entry.id === candidate.firstKeptEntryId);
    if (requestIndex === -1 || !isUserMessageEntry(branch[requestIndex])) return mismatch();
    const sourceEndIndex = branch.findIndex((entry) => entry.id === candidate.sourceEndEntryId);
    if (sourceEndIndex === -1 || sourceEndIndex >= requestIndex || !isEligibleSourceEntry(branch[sourceEndIndex])) return mismatch();
    // The accepted Memory must still be the exact live Memory: no
    // compaction of its own for a first block, or the same carrying
    // compaction with the same ordered blocks and source continuity for an
    // append (#219) or a suffix rebuild, which additionally re-matches the
    // selected blocks it replaces (#220).
    const live = deriveCurrentMemory(session);
    if (candidate.operation === "append" && candidate.prefix.length === 0) {
      if (live.kind !== "none") return mismatch();
    } else {
      if (live.kind !== "valid" || live.compactionId !== candidate.prefixCompactionId) return mismatch();
      const expected = candidate.operation === "rebuild"
        ? [...candidate.prefix, ...candidate.replacedSuffix]
        : candidate.prefix;
      if (live.blocks.length !== expected.length
        || live.blocks.some((block, index) =>
          block.endEntryId !== expected[index]!.endEntryId
          || block.markdown !== expected[index]!.markdown)) return mismatch();
      if (candidate.prefix.length > 0) {
        const lastEndIndex = branch.findIndex(
          (entry) => entry.id === candidate.prefix[candidate.prefix.length - 1]!.endEntryId,
        );
        if (lastEndIndex === -1 || lastEndIndex >= sourceEndIndex) return mismatch();
      }
    }
    if (estimateTextTokens(candidate.summary) > Math.round((candidate.contextWindow * this.config.memoryBudgetPercent) / 100)) {
      return mismatch();
    }
    this.slot = { phase: "committing", candidate };
    return {
      compaction: {
        summary: candidate.summary,
        firstKeptEntryId: candidate.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: candidate.details,
      },
    };
  }

  /**
   * `session_compact` (#215, #218): success is confirmed only when the actual
   * saved entry has extension origin and exactly the expected summary, kept
   * boundary, and directory. A competing handler's different entry clears the
   * slot and emits one bounded `COMPACTION_CONFLICT` diagnostic. A foreign
   * compaction also closes any open due run, whose submission window is gone.
   */
  confirmCompaction(
    event: {
      readonly compactionEntry: { readonly summary?: unknown; readonly firstKeptEntryId?: unknown; readonly details?: unknown } | undefined;
      readonly fromExtension: boolean;
    },
    ctx: { readonly ui?: { notify?(message: string, level: "info" | "warning" | "error"): void } },
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
    session: MemorySessionReader,
  ): void {
    if (this.slot?.phase === "committing") {
      const candidate = this.slot.candidate;
      const entry = event.compactionEntry;
      const confirmed = event.fromExtension === true
        && entry !== undefined
        && entry.summary === candidate.summary
        && entry.firstKeptEntryId === candidate.firstKeptEntryId
        && sameMemoryDetails(entry.details, candidate.details);
      this.slot = undefined;
      if (confirmed) {
        this.due = false;
        // The settled recompute ran before the async commit landed; a stale
        // scale-limit report must not outlive the accepted compaction.
        this.scaleLimited = false;
      } else {
        ctx.ui?.notify?.(
          "COMPACTION_CONFLICT: compaction did not match the accepted Memory candidate; the submission was discarded",
          "warning",
        );
      }
    } else if (this.dueRun !== undefined) {
      this.dueRun = undefined;
    }
    this.synchronizeActiveTools(pi, session);
  }

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
    if (this.activeCompactionId === undefined || memory.compactionId !== this.activeCompactionId) {
      if (this.activeCompactionId !== undefined) {
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
    if (this.activeCompactionId !== undefined && memory.compactionId !== this.activeCompactionId) {
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
    memory: Extract<CurrentMemory, { kind: "valid" }>,
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
    memory: Extract<CurrentMemory, { kind: "valid" }>,
    usage: ContextMemoryUsageInput | undefined,
  ): ContextMemorySnapshot {
    const markdowns = memory.blocks.map((block) => block.markdown);
    const blockTokens = memory.blocks.map((block) => estimateTextTokens(block.markdown));
    const memoryTokens = renderedMemoryTokens(markdowns);
    const window = usage?.contextWindow;
    const budgetTokens = typeof window === "number" && window > 0
      ? Math.round((window * this.config.memoryBudgetPercent) / 100)
      : null;
    const halfBudget = budgetTokens !== null ? budgetTokens / 2 : null;

    let nextOperation: "append" | "rebuild" | null = null;
    let stablePrefix: number | null = null;
    if (halfBudget !== null) {
      if (memoryTokens <= halfBudget) {
        nextOperation = "append";
        stablePrefix = memory.blocks.length;
      } else {
        nextOperation = "rebuild";
        // The same shared selection the due run freezes (#220).
        stablePrefix = selectStablePrefixCount(markdowns, halfBudget);
      }
    }

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
      blocks: memory.blocks.length,
      rows,
      stablePrefix,
      nextOperation,
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

/** Whether the entry is a real user message entry (not a tool result). */
function isUserMessageEntry(entry: SessionEntryLike): boolean {
  if (entry.type !== "message") return false;
  const message = (entry as { message?: { role?: unknown } }).message;
  return message?.role === "user";
}

/** Structural session-entry shape the branch scans consume. */
interface SessionEntryLike {
  readonly id: string;
  readonly type?: unknown;
}

/** Exact directory equality for `session_compact` confirmation (#218). */
function sameMemoryDetails(actual: unknown, expected: MemoryCompactionDetails): boolean {
  const record = actual as { format?: unknown; blocks?: unknown } | null | undefined;
  if (!record || record.format !== expected.format) return false;
  if (!Array.isArray(record.blocks) || record.blocks.length !== expected.blocks.length) return false;
  return record.blocks.every((item, index) => {
    const candidate = item as { endEntryId?: unknown; markdownBytes?: unknown } | null;
    return candidate?.endEntryId === expected.blocks[index]!.endEntryId
      && candidate?.markdownBytes === expected.blocks[index]!.markdownBytes;
  });
}

/**
 * Remove `submit_memory` artifacts from a provider-bound message list
 * (#215), with one #253 exception: paired submit tool results drop entirely,
 * submit tool-call parts drop from their assistant message while ordinary
 * text survives, and an assistant message left without any eligible part
 * drops as a whole — but while the run continues after an accepted
 * submission, the trailing submitting exchange (the final submit call and
 * its paired result) passes through whole; see the rationale below.
 * `read_memory_source` artifacts stay visible; only future source streams
 * exclude them.
 */
function filterSubmitArtifacts(messages: readonly unknown[]): unknown[] {
  // The submitting exchange is the request tail while the run continues
  // (#253). Filtering it would end the request on an assistant turn, which
  // providers reject as an assistant prefill, and filtering only half of it
  // leaves an unpaired tool result that both wire formats reject outright.
  // So the trailing pair passes through whole; every older submit artifact
  // still leaves the request.
  const isSubmitResult = (m: unknown): boolean =>
    (m as { role?: unknown; toolName?: unknown } | null)?.role === "toolResult"
    && (m as { toolName?: unknown }).toolName === SUBMIT_MEMORY_TOOL_NAME;
  const hasSubmitCall = (m: unknown): boolean => {
    const record = m as { role?: unknown; content?: unknown } | null;
    return record?.role === "assistant" && Array.isArray(record.content)
      && record.content.some((part) =>
        (part as { type?: unknown; name?: unknown } | null)?.type === "toolCall"
        && (part as { name?: unknown }).name === SUBMIT_MEMORY_TOOL_NAME);
  };
  let keepFrom = messages.length;
  if (messages.length >= 2 && isSubmitResult(messages[messages.length - 1]) && hasSubmitCall(messages[messages.length - 2])) {
    keepFrom = messages.length - 2;
  } else if (messages.length >= 1 && hasSubmitCall(messages[messages.length - 1])) {
    keepFrom = messages.length - 1;
  }

  const filtered: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (index >= keepFrom) {
      filtered.push(message);
      continue;
    }
    const record = message as { role?: unknown; content?: unknown; toolName?: unknown } | null;
    if (!record) continue;
    if (record.role === "toolResult") {
      if (record.toolName === SUBMIT_MEMORY_TOOL_NAME) continue;
      filtered.push(message);
      continue;
    }
    if (record.role === "assistant" && Array.isArray(record.content)) {
      const kept = record.content.filter((part) =>
        (part as { type?: unknown; name?: unknown } | null)?.type !== "toolCall"
        || (part as { name?: unknown }).name !== SUBMIT_MEMORY_TOOL_NAME);
      if (kept.length === 0) continue;
      if (kept.length !== record.content.length) {
        filtered.push({ ...record, content: kept });
        continue;
      }
    }
    filtered.push(message);
  }
  return filtered;
}

/**
 * Pi's per-message chars/4 estimate with `submit_memory` protocol artifacts
 * removed, mirroring the provider-bound projection (#215).
 */
function estimateFilteredMessageTokens(message: { role?: unknown; content?: unknown; toolName?: unknown }): number {
  if (message.role === "toolResult") {
    return message.toolName === SUBMIT_MEMORY_TOOL_NAME
      ? 0
      : estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
  }
  if (message.role === "assistant") {
    const content = message.content;
    if (!Array.isArray(content)) return 0;
    const hasSubmitCall = content.some((part) =>
      (part as { type?: unknown; name?: unknown } | null)?.type === "toolCall"
      && (part as { name?: unknown }).name === SUBMIT_MEMORY_TOOL_NAME);
    if (!hasSubmitCall) {
      return estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
    }
    const kept = content.filter((part) =>
      (part as { type?: unknown; name?: unknown } | null)?.type !== "toolCall"
      || (part as { name?: unknown }).name !== SUBMIT_MEMORY_TOOL_NAME);
    if (kept.length === 0) return 0;
    return estimateMessageTokens({ ...message, content: kept } as Parameters<typeof estimateMessageTokens>[0]);
  }
  return estimateMessageTokens(message as Parameters<typeof estimateMessageTokens>[0]);
}
