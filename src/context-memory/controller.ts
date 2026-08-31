import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ContextMemoryConfig } from "../core/config";
import { deriveCurrentMemory, type CurrentMemory, type DerivedMemoryBlock, type MemorySessionReader } from "./derive";
import {
  MEMORY_BLOCK_SEPARATOR,
  MEMORY_SUMMARY_WRAPPER,
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
  CONTEXT_MEMORY_MAX_VIEW_ROWS,
  type ContextMemoryBlockRow,
  type ContextMemorySnapshot,
} from "./view";

/**
 * The session-scoped Context Memory controller (odradekk/pi-square#215, #216, #217).
 *
 * The controller is the highest test seam: tests drive it through the same
 * registrar events and tool surfaces Pi drives and assert externally visible
 * state — the read-only snapshot, the active tool set, and tool/inspection
 * output. #217 adds current-leaf derivation, strict format parsing, block
 * source recovery with fixed 16 KiB paging, `read_memory_source`
 * activation/execution, and the `/context memory` detail rendering. Later
 * slices add due runs, submission, and compaction takeover; the shell keeps
 * the compatibility gate and owned active-tool synchronization.
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

/** Deterministic chars/4 token estimate used consistently for Memory comparisons. */
function estimateTokens(text: string): number {
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

export class ContextMemoryController {
  private readonly config: ContextMemoryConfig;
  private readonly support: HostSupport;
  private current: CurrentMemory;
  /** The carrying compaction the active `read_memory_source` window was opened against. */
  private activeCompactionId: string | undefined;

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
    if (this.current.kind === "none") return { state: "no-memory" };
    if (this.current.kind === "opaque") return { state: "opaque" };
    return this.activeSnapshot(this.current, usage);
  }

  /** Re-derive current Memory from the live session tree. */
  refresh(session: MemorySessionReader): void {
    this.current = deriveCurrentMemory(session);
  }

  /**
   * Synchronize the owned active-tool names while preserving every other
   * active tool selected by Pi or another pi-square module. `submit_memory`
   * needs a due run (#218) and stays inactive; `read_memory_source` is active
   * exactly while enabled on a supported host with strictly valid non-empty
   * current Memory. Returns the owned names removed from the active list.
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
    this.activeCompactionId = readActive && this.current.kind === "valid" ? this.current.compactionId : undefined;
    const changed = active.length !== desired.length || active.some((name, index) => name !== desired[index]);
    if (changed) pi.setActiveTools(desired);
    return removed;
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
    const blockTokens = memory.blocks.map((block) => estimateTokens(block.markdown));
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
