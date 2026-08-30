import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The two Context Memory model tools (odradekk/pi-square#215, #216).
 *
 * Both definitions are parent-only, registered once at extension load, and
 * inactive in the baseline state: `submit_memory` activates only during a due
 * real-user run (#218) and `read_memory_source` only while valid non-empty
 * current Memory exists (#217). Neither name may appear in any child, Shadow,
 * or subagent catalog. Executing either tool outside its active window fails
 * with one safe sentence beginning with its stable short code; neither message
 * echoes Memory Markdown, ranges, identifiers, or raw arguments.
 */

/** One submitted Memory block is at most 16 KiB canonical UTF-8 (#215). */
export const MEMORY_BLOCK_MAX_BYTES = 16 * 1024;

/**
 * Provider-visible bound only. JSON Schema `maxLength` counts characters, not
 * bytes, and a block within the byte cap can never hold more characters than
 * bytes, so this rejects nothing the byte rule accepts while keeping the
 * schema finite. The canonical byte check arrives with #218.
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
  description: "Submit one Memory block as the final and sole tool call of a due compression run",
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

function memoryError(code: string, sentence: string): never {
  throw new Error(`${code}: ${sentence}`);
}

export function createSubmitMemoryToolDefinition(
): ToolDefinition<typeof SubmitMemoryParamsSchema, Record<string, never>> {
  return {
    name: SUBMIT_MEMORY_TOOL_NAME,
    label: "Memory submit",
    description:
      "Submit one Markdown Memory block for the current compression run. "
      + "Available only when a Context Memory compression is due; must be the final and sole tool call of its batch.",
    parameters: SubmitMemoryParamsSchema,
    executionMode: "sequential",
    async execute() {
      // The due-run submission window opens with #218; the shell never opens one.
      memoryError("SUBMIT_NOT_DUE", "no Context Memory compression is due in this run");
    },
  };
}

export function createReadMemorySourceToolDefinition(
): ToolDefinition<typeof ReadMemorySourceParamsSchema, Record<string, never>> {
  return {
    name: READ_MEMORY_SOURCE_TOOL_NAME,
    label: "Memory source",
    description:
      "Read one bounded page of the original conversation behind a Memory block. "
      + "Available only while valid Context Memory exists on the current branch.",
    parameters: ReadMemorySourceParamsSchema,
    async execute() {
      // Memory derivation and source paging arrive with #217; the shell derives none.
      memoryError("MEMORY_NOT_AVAILABLE", "no valid Context Memory is available on the current branch");
    },
  };
}
