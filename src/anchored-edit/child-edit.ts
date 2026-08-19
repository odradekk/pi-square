import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAnchoredReplaceToolDefinition } from "./workspace-replace";
import { createAnchoredRevertToolDefinition } from "./workspace-revert";

type GenericToolDefinition = ToolDefinition<any, any, any>;

/**
 * Builds the child anchored replace and revert tools for a writable subagent.
 * They are the same display-free definitions the parent uses (identical
 * schemas, prompts, and verification), executed under the child's own owner so
 * a child's edit verifies against the rows its own read served and its revert
 * record stays in its own partition.
 *
 * Unlike the parent, the child replace always verifies against its served
 * record (`requireServed`): a child that names anchors it never read for itself
 * is refused with the recoverable stale-range code, and the refusal serves the
 * current range for its immediate retry. The child keeps `autoRead` on so each
 * successful edit records its result rows and the child's next edit on that
 * content is not refused.
 *
 * The returned definitions carry no renderer fields, so child tool construction
 * needs no parent display runtime.
 *
 * @param cwd The child's working directory.
 * @param owner Anchor-store owner the child's replace and revert use. Required
 *   so a child's records never mix with the parent's or another child's.
 */
export function createChildAnchoredEditTools(cwd: string, owner: string): GenericToolDefinition[] {
  return [
    createAnchoredReplaceToolDefinition(cwd, () => true, owner, true) as GenericToolDefinition,
    createAnchoredRevertToolDefinition(cwd, () => true, owner) as GenericToolDefinition,
  ];
}
