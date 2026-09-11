import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemorySessionReader } from "./derive";

/**
 * The two Context Memory model tools (odradekk/pi-square#215, #216, #217, #319).
 *
 * Both definitions are parent-only, registered once at extension load. Since
 * #319 the compression tool is `compact_to_memory_block` and it is resident:
 * while the feature is enabled on a supported host it stays in the active tool
 * list regardless of thresholds or previous submissions — availability never
 * bypasses runtime source, budget, or net-benefit validation, which can still
 * refuse any individual call with one bounded sentence. The retired
 * `submit_memory` name has no active alias; historical calls in older sessions
 * stay recognized as protocol history and are never re-executed or treated as
 * original source evidence. `read_memory_source` is synchronized dynamically
 * and activates only while strictly valid non-empty current Memory exists
 * (#217). Neither name may appear in any child, Shadow, or subagent catalog.
 * Executing outside a valid window fails with one safe sentence beginning with
 * a stable short code; no message echoes Memory Markdown, ranges,
 * identifiers, or raw arguments.
 */

/** One Memory block body is at most 16 KiB canonical UTF-8 (#215). */
export const MEMORY_BLOCK_MAX_BYTES = 16 * 1024;

/**
 * Provider-visible bound only. JSON Schema `maxLength` counts characters, not
 * bytes, and a block within the byte cap can never hold more characters than
 * bytes, so this rejects nothing the byte rule accepts while keeping the
 * schema finite. The canonical byte check is enforced at execution (#218).
 */
const MEMORY_BLOCK_MAX_CHARS = MEMORY_BLOCK_MAX_BYTES;

/**
 * The retired compression tool name (#319). It has no active alias and stays
 * only as recognized protocol history: old calls keep filtering out of
 * provider-bound requests and never become original source evidence.
 */
export const SUBMIT_MEMORY_TOOL_NAME = "submit_memory";

/** The resident compression tool name (#319). */
export const COMPACT_MEMORY_TOOL_NAME = "compact_to_memory_block";

export const READ_MEMORY_SOURCE_TOOL_NAME = "read_memory_source";

export const CompactMemoryParamsSchema = Type.Object({
  markdown: Type.String({
    description: "The Memory block body as free-form Markdown",
    minLength: 1,
    maxLength: MEMORY_BLOCK_MAX_CHARS,
  }),
}, {
  additionalProperties: false,
  description: "Compact the covered older conversation into one Memory block, as the sole tool call of its batch",
});

export const ReadMemorySourceParamsSchema = Type.Object({
  block: Type.Integer({
    description: "1-based position in the current ordered Memory block list",
    minimum: 1,
  }),
  page: Type.Integer({
    description: "1-based source transcript page for the block",
    minimum: 1,
  }),
}, {
  additionalProperties: false,
  description: "Read one page of a Memory block's original conversation",
});

/** The only paging details `read_memory_source` ever returns (#215). */
export interface ReadMemorySourceDetails {
  readonly block: number;
  readonly totalBlocks: number;
  readonly page: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
}

/** The only details an accepted `compact_to_memory_block` call ever returns (#319). */
export interface CompactMemoryDetails {
  /** The Memory was accepted and recorded; it does not claim request application. */
  readonly recorded: true;
}

/** One source read handed to the controller by the tool definition. */
export interface ReadMemorySourceRequest {
  readonly block: number;
  readonly page: number;
}

/**
 * The surface the controller needs to record accepted Memory through Pi's
 * public custom-entry seam (#319): the extension API's `appendEntry` writes
 * through the SessionManager — the only session-file writer.
 */
export interface MemoryRecordingContext {
  appendEntry(customType: string, data?: unknown): void;
}

/**
 * The executor the registrar supplies for `compact_to_memory_block`: the
 * controller validates the sole tool call, the source range, the budgets, and
 * the net benefit, then records the versioned state entry and returns the
 * fixed recorded acknowledgement, or throws one safe short-coded sentence
 * (#319). The registrar supplies the recording context built from the
 * extension API's public `appendEntry`, so the tool definition itself stays
 * context-free.
 */
export type CompactMemoryExecutor = (
  markdown: string,
  toolCallId: string,
  session: MemorySessionReader,
) => Promise<AgentToolResult<CompactMemoryDetails>>;

/**
 * The executor the registrar supplies for `read_memory_source`: the
 * controller revalidates current Memory against the live session and returns
 * the bounded page or throws one safe short-coded sentence.
 */
export type ReadMemorySourceExecutor = (
  request: ReadMemorySourceRequest,
  session: MemorySessionReader,
) => Promise<AgentToolResult<ReadMemorySourceDetails>>;

function memoryError(code: string, sentence: string): never {
  throw new Error(`${code}: ${sentence}`);
}

export function createCompactMemoryToolDefinition(
  executor: CompactMemoryExecutor,
): ToolDefinition<typeof CompactMemoryParamsSchema, CompactMemoryDetails> {
  return {
    name: COMPACT_MEMORY_TOOL_NAME,
    label: "Memory compact",
    description:
      "Compact the covered older conversation into one Markdown Memory block. "
      + "Resident while Context Memory is enabled; must be the sole tool call of its batch. "
      + "On acceptance the next model request carries the block in place of the covered conversation; "
      + "the run continues after the acknowledgement.",
    parameters: CompactMemoryParamsSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const session = (ctx as { sessionManager?: MemorySessionReader }).sessionManager;
      if (!session) {
        memoryError("COMPACT_NOT_AVAILABLE", "Context Memory compression is not available in this context");
      }
      return executor(params.markdown, toolCallId, session);
    },
  };
}

export function createReadMemorySourceToolDefinition(
  executor: ReadMemorySourceExecutor,
): ToolDefinition<typeof ReadMemorySourceParamsSchema, ReadMemorySourceDetails> {
  return {
    name: READ_MEMORY_SOURCE_TOOL_NAME,
    label: "Memory source",
    description:
      "Read one bounded page of the original conversation behind a Memory block. "
      + "Available only while valid Context Memory exists on the current branch.",
    parameters: ReadMemorySourceParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = (ctx as { sessionManager?: MemorySessionReader }).sessionManager;
      if (!session) {
        memoryError("MEMORY_NOT_AVAILABLE", "no valid Context Memory is available on the current branch");
      }
      return executor({ block: params.block, page: params.page }, session);
    },
  };
}
