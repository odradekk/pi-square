import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemorySessionReader } from "./derive";

/**
 * The two Context Memory model tools (odradekk/pi-square#215, #216, #217, #218).
 *
 * Both definitions are parent-only, registered once at extension load, and
 * synchronized dynamically by the controller: `submit_memory` activates only
 * during a due real-user run (#218) and `read_memory_source` only while
 * strictly valid non-empty current Memory exists (#217). Neither name may
 * appear in any child, Shadow, or subagent catalog. Executing either tool
 * outside its active window fails with one safe sentence beginning with its
 * stable short code; neither message echoes Memory Markdown, ranges,
 * identifiers, or raw arguments.
 */

/** One submitted Memory block is at most 16 KiB canonical UTF-8 (#215). */
export const MEMORY_BLOCK_MAX_BYTES = 16 * 1024;

/**
 * Provider-visible bound only. JSON Schema `maxLength` counts characters, not
 * bytes, and a block within the byte cap can never hold more characters than
 * bytes, so this rejects nothing the byte rule accepts while keeping the
 * schema finite. The canonical byte check is enforced at execution (#218).
 */
const MEMORY_BLOCK_MAX_CHARS = MEMORY_BLOCK_MAX_BYTES;

export const SUBMIT_MEMORY_TOOL_NAME = "submit_memory";
export const READ_MEMORY_SOURCE_TOOL_NAME = "read_memory_source";

export const SubmitMemoryParamsSchema = Type.Object({
  markdown: Type.String({
    description: "The Memory block body as free-form Markdown",
    minLength: 1,
    maxLength: MEMORY_BLOCK_MAX_CHARS,
  }),
}, {
  additionalProperties: false,
  description: "Submit one Memory block as the sole tool call of a due compression run",
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

/** The only details an accepted `submit_memory` call ever returns (#218). */
export interface SubmitMemoryDetails {
  readonly accepted: true;
}

/** One source read handed to the controller by the tool definition. */
export interface ReadMemorySourceRequest {
  readonly block: number;
  readonly page: number;
}

/**
 * The executor the registrar supplies for `submit_memory`: the controller
 * validates the due run, the sole tool call, and the block body, then stores
 * the run-scoped candidate bound for compaction takeover, or throws one safe
 * short-coded sentence (#218).
 */
export type SubmitMemoryExecutor = (
  markdown: string,
  toolCallId: string,
  session: MemorySessionReader,
) => Promise<AgentToolResult<SubmitMemoryDetails>>;

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

export function createSubmitMemoryToolDefinition(
  executor: SubmitMemoryExecutor,
): ToolDefinition<typeof SubmitMemoryParamsSchema, SubmitMemoryDetails> {
  return {
    name: SUBMIT_MEMORY_TOOL_NAME,
    label: "Memory submit",
    description:
      "Submit one Markdown Memory block for the current compression run. "
      + "Available only when a Context Memory compression is due and no block was accepted yet this run; "
      + "must be the sole tool call of its batch. The run continues after the acknowledgement.",
    parameters: SubmitMemoryParamsSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const session = (ctx as { sessionManager?: MemorySessionReader }).sessionManager;
      if (!session) {
        memoryError("SUBMIT_NOT_DUE", "no Context Memory compression is due in this run");
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
