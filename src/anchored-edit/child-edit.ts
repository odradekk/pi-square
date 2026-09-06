import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAnchoredInsertToolDefinition } from "./workspace-insert";
import { createAnchoredReplaceToolDefinition } from "./workspace-replace";

type GenericToolDefinition = ToolDefinition<any, any, any>;

/**
 * Builds the child anchored replace tool for a writable subagent. It is the
 * same display-free definition the parent uses (identical schema, prompt, and
 * verification), executed under the child's own owner so a child's edit
 * verifies against the rows its own read served.
 *
 * Native path authority (#186): the child tool keeps Pi-native path
 * authority, so a child can replace any Pi-native-accessible external target
 * while its `requireServed` gate still refuses anchors the child was never
 * served (recoverably, with the current range as fresh rows). External targets
 * keep the initiating workspace's store and lock area: two different
 * workspaces intentionally do not share external-target state or locks
 * (accepted last-write-wins, matching Pi's native cross-workspace behavior).
 *
 * Unlike the parent, the child replace always verifies against its served
 * record (`requireServed`): a child that names anchors it never read for
 * itself is refused with the recoverable stale-range code, and the refusal
 * serves the current range for its immediate retry. The child keeps `autoRead`
 * on so each successful edit records its result rows and the child's next edit
 * on that content is not refused.
 *
 * The returned definition carries no renderer fields, so child tool
 * construction needs no parent display runtime.
 *
 * @param cwd The child's working directory.
 * @param owner Anchor-store owner the child's replace uses. Required so a
 *   child's records never mix with the parent's or another child's.
 * @param sessionDir The parent session's persistent session directory, used to
 *   locate the anchor store. Required because the child session's own directory
 *   is its artifacts directory, not the workspace session directory; an empty
 *   value selects the throwaway temp-directory fallback of a non-persisted
 *   parent session.
 */
export function createChildAnchoredReplaceTool(cwd: string, owner: string, sessionDir: string): GenericToolDefinition {
  return createAnchoredReplaceToolDefinition(cwd, () => true, owner, true, sessionDir) as GenericToolDefinition;
}

/**
 * Builds the child anchored insert tool for a writable subagent (#287). It is
 * the same display-free definition the parent uses, executed under the child's
 * own owner partition, so an insert's mandatory served-anchor authorization
 * verifies against the rows that child's own read served — rows served to the
 * parent or a sibling child authorize nothing. The child keeps `autoRead` on
 * so each successful insert records the authoritative diff's rows and the
 * child's next mutation on that content is not refused.
 *
 * The child insert keeps Pi-native path authority (#186) and never creates a
 * missing target, exactly like the parent insert: an empty existing file
 * initializes through its served synthetic anchor, and one empty-string item
 * is one real blank logical line (#286).
 *
 * The returned definition carries no renderer fields, so child tool
 * construction needs no parent display runtime.
 *
 * @param cwd The child's working directory.
 * @param owner Anchor-store owner the child's insert uses. Required so a
 *   child's records never mix with the parent's or another child's.
 * @param sessionDir The parent session's persistent session directory, used to
 *   locate the anchor store; see createChildAnchoredReplaceTool.
 */
export function createChildAnchoredInsertTool(cwd: string, owner: string, sessionDir: string): GenericToolDefinition {
  return createAnchoredInsertToolDefinition(cwd, () => true, owner, sessionDir) as GenericToolDefinition;
}
