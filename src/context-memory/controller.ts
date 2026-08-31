import type { AgentToolResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, buildSessionContext, estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";
import type { ContextMemoryThreshold, ContextMemoryConfig } from "../core/config";
import { deriveCurrentMemory, isEligibleSourceEntry, type CurrentMemory, type DerivedMemoryBlock, type MemorySessionReader } from "./derive";
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
 * The session-scoped Context Memory controller (odradekk/pi-square#215, #216, #217, #218).
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
 * `session_before_compact` with exact `session_compact` confirmation. #221
 * completes the branch-private lifecycle: derivation always follows Pi's
 * actual current leaf across resume, tree navigation, fork, clone, import,
 * cross-directory copies, and session replacement, ephemeral in-memory
 * sessions run the same behavior with an `ephemeral` snapshot marker and no
 * sidecar, and no cancellable Pi session event is ever subscribed or blocked.
 * Appending further blocks (#219) and the suffix rebuild (#220) extend the
 * same seams later; the compatibility gate and owned active-tool
 * synchronization stay.
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

/** The fixed one-shot due-run advisory body (#215: append instruction, source scope, secret warning). */
const DUE_RUN_ADVISORY_TEXT = [
  "Context Memory: compression is due for this conversation.",
  "",
  "Complete the user's current task first. When it is done, finish the run with one final and sole tool call: submit_memory, carrying one concise Markdown Memory block that preserves what matters from the conversation before this run — goals, decisions, and open work.",
  "That block will replace the older conversation as compressed context; the current request and everything you do for it stay uncompressed.",
  "Do not copy credential values, private keys, access tokens, or other secrets into the Memory block.",
].join("\n");

/** The frozen due run opened by one real-user input (#218). */
interface DueRunState {
  /** Leaf id at the opening input; the run's user request is the first user entry after it. */
  readonly preRunLeafId: string | null;
  advisoryDelivered: boolean;
}

/** One accepted submission awaiting compaction (#218). Never persisted. */
interface MemoryCandidate {
  /** Leaf at acceptance; navigation since invalidates the candidate. */
  readonly leafId: string;
  readonly toolCallId: string;
  readonly operation: "append";
  /** Inclusive source end: the last eligible entry covered by the new block. */
  readonly sourceEndEntryId: string;
  /** Retained-tail boundary: the real user entry that began the due run. */
  readonly firstKeptEntryId: string;
  readonly contextWindow: number;
  readonly markdown: string;
  readonly summary: string;
  readonly details: MemoryCompactionDetails;
}

/** The single in-memory transaction slot (#215: phases `pending` and `committing`). */
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
   * is active exactly while a due real-user run is open (#218);
   * `read_memory_source` is active exactly while enabled on a supported host
   * with strictly valid non-empty current Memory (#217). Returns the owned
   * names removed from the active list.
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
    if (this.dueRun !== undefined) desired.push(SUBMIT_MEMORY_TOOL_NAME);
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
   * artifacts filtered, decides (#215). No counter persists.
   */
  recomputeDue(ctx: ContextMemoryRunContext): void {
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
    const tokens = usage && typeof usage.tokens === "number" ? usage.tokens : null;
    const estimate = tokens ?? this.estimateProjectedTokens(ctx.sessionManager);
    this.due = estimate !== null && estimate >= duePoint;
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
   * The `input` boundary (#215, #218): only a real-user input may open a due
   * handshake, and it activates `submit_memory` before Pi builds the first
   * model request. A steering input during an open run keeps it. A new
   * real-user run clears all transient state first.
   */
  handleInput(
    event: { readonly source: unknown },
    ctx: ContextMemoryRunContext,
    pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">,
  ): void {
    if (!this.operational()) return;
    const realUser = event.source === "interactive" || event.source === "rpc";
    if (!realUser) return;
    if (this.dueRun !== undefined && !ctx.isIdle()) return;
    this.clearTransient();
    this.synchronizeActiveTools(pi, ctx.sessionManager);
    // #218 opens the handshake only for the first block; appending onto
    // existing Memory (#219) and the suffix rebuild (#220) arrive later.
    if (!this.due || this.current.kind !== "none") return;
    this.dueRun = {
      preRunLeafId: ctx.sessionManager.getLeafId?.() ?? null,
      advisoryDelivered: false,
    };
    this.synchronizeActiveTools(pi, ctx.sessionManager);
  }

  /**
   * The ephemeral `context` transform (#215, #218). It never throws. Two
   * deterministic rules apply while the feature is enabled on a supported
   * host:
   *
   * - `submit_memory` tool-call parts and their paired results leave every
   *   provider-bound request, while ordinary assistant text in the same
   *   message survives and `read_memory_source` artifacts stay visible.
   * - On the first provider request of a due run, one fixed custom advisory
   *   is appended after the current user message and never repeated.
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
      const messages = filterSubmitArtifacts(original);
      if (this.dueRun !== undefined && !this.dueRun.advisoryDelivered) {
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
          content: DUE_RUN_ADVISORY_TEXT,
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
   * Execute one `submit_memory` call (#218): validate the due run, the sole
   * tool call, the transaction slot, and the block body, then store the
   * run-scoped candidate. Returns the fixed pending acknowledgement and
   * terminates the tool batch; compaction itself happens later through Pi's
   * seam. Throws one safe short-coded sentence and never echoes Markdown.
   */
  async submitCandidate(
    markdown: string,
    toolCallId: string,
    session: MemorySessionReader,
  ): Promise<AgentToolResult<{ accepted: true }>> {
    if (!this.operational() || this.dueRun === undefined) {
      fail("SUBMIT_NOT_DUE", "no Context Memory compression is due in this run");
    }
    if (this.slot !== undefined) {
      fail("COMPACTION_BUSY", "a Memory candidate is already awaiting compaction");
    }
    const batch = this.lastToolBatch;
    if (batch === undefined || !batch.includes(toolCallId) || batch.length > 1) {
      fail("SUBMIT_NOT_SOLE_TOOL", "submit_memory must be the final and only tool call in its batch");
    }
    if (!isValidMemoryBlockBody(markdown)) {
      fail("BOUND_EXCEEDED", "the Memory block body exceeds the size or content bounds");
    }
    const candidate = this.bindCandidate(markdown, toolCallId, session);
    this.slot = { phase: "pending", candidate };
    return {
      content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }],
      details: { accepted: true },
      terminate: true,
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
    const summary = composeMemorySummary([markdown]);
    const details: MemoryCompactionDetails = {
      format: MEMORY_FORMAT_TAG,
      blocks: [{
        endEntryId: branch[sourceEndIndex]!.id,
        markdownBytes: Buffer.byteLength(markdown, "utf8"),
      }],
    };
    if (parseMemoryDetails(details) === undefined) {
      fail("BOUND_EXCEEDED", "the Memory directory exceeds the persisted format bounds");
    }
    const contextWindow = this.windowForBudget();
    if (estimateTextTokens(summary) > Math.round((contextWindow * this.config.memoryBudgetPercent) / 100)) {
      fail("BOUND_EXCEEDED", "the Memory block exceeds the configured Memory budget");
    }
    return {
      leafId,
      toolCallId,
      operation: "append",
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
   * Pi's public compaction seam exactly once — no autonomous model turn.
   * The due run closes, `submit_memory` deactivates, and the due flag is
   * recomputed from current usage.
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
    // The first block still compresses a branch with no compaction of its own.
    if (deriveCurrentMemory(session).kind !== "none") return mismatch();
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
    const blockTokens = memory.blocks.map((block) => estimateTextTokens(block.markdown));
    const renderedChars = memory.blocks.reduce(
      (sum, block) => sum + Array.from(block.markdown).length,
      MEMORY_SUMMARY_WRAPPER.length + MEMORY_BLOCK_SEPARATOR.length * memory.blocks.length,
    );
    const memoryTokens = Math.ceil(renderedChars / 4);
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
        let cumulative = 0;
        let stable = 0;
        for (const tokens of blockTokens) {
          if (cumulative + tokens > halfBudget) break;
          cumulative += tokens;
          stable += 1;
        }
        stablePrefix = stable;
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
 * (#215): paired submit tool results drop entirely, submit tool-call parts
 * drop from their assistant message while ordinary text survives, and an
 * assistant message left without any eligible part drops as a whole.
 * `read_memory_source` artifacts stay visible; only future source streams
 * exclude them.
 */
function filterSubmitArtifacts(messages: readonly unknown[]): unknown[] {
  const filtered: unknown[] = [];
  for (const message of messages) {
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
