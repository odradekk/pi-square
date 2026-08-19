import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { guardAnchoredRead, transformAnchoredReadContent } from "./read-transform";
import { withAnchoredReadGuidelines, withAnchoredReadTransform } from "./read-tool";

/**
 * Builds the child anchored read tool for a writable subagent. It is composed
 * from Pi's public read factory plus the shared anchor transform, so the child
 * gets the same three-character anchored rows as the parent with no second
 * anchoring implementation. Served rows are recorded under the given owner, so
 * one child's read never makes another agent's edit legal.
 *
 * The returned definition carries the built-in read name; when it is passed as
 * a child custom tool it overrides the child's built-in read, leaving exactly
 * one read tool offered. It has no renderer fields, so child tool construction
 * needs no parent display runtime.
 *
 * @param cwd The child's working directory; Pi's factory resolves reads from it.
 * @param owner Anchor-store owner the child's served rows are recorded under.
 *   Required: an omitted owner would silently mix a child's rows into the parent
 *   partition, which is exactly the isolation this feature exists to provide.
 */
export function createChildAnchoredReadTool(
  cwd: string,
  owner: string,
): ToolDefinition {
  const definition = createReadToolDefinition(cwd);
  const anchored = withAnchoredReadTransform(
    definition,
    cwd,
    (content, value, executionCwd) => transformAnchoredReadContent(content, value, executionCwd, owner),
    guardAnchoredRead,
  );
  return withAnchoredReadGuidelines(anchored);
}
