import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAnchoredWriteSession, resolveAnchoredTarget, runWithWriteSignal } from "./operations.ts";

type GenericToolDefinition = ToolDefinition<any, any, any>;

/** @internal Deterministic test seam after canonicalization and before the
 * public factory registers its queue. Production never sets it. */
export const childWriteEntryBarrier: {
  afterResolve?: (canonicalPath: string) => Promise<void>;
} = {};

/**
 * Builds the child write tool for a writable subagent while anchored editing is
 * on. It is Pi's public write factory with the integrated anchored write
 * operation injected through the factory's filesystem-operation seam (#264):
 * the factory still owns the tool name, parameters, prompt guidance, path
 * resolution, abort checks, success wording, and ordinary filesystem error
 * semantics, while the injected write joins the fixed queue-then-lock protocol
 * — the factory enters Pi's per-file mutation queue and the operation takes
 * the anchored cross-process lock inside it — and publishes the child's store
 * state (clearing its own served rows, then the bounded auto-read appendix
 * with its rows served under the writing child) before the lock releases. A
 * failed or refused write leaves the child's state intact; only the acting
 * child's own rows are cleared, so a sibling's served partition survives.
 *
 * Native path authority (#186): the write follows Pi's native path resolution
 * for every supported target — absolute paths, `~` paths, cwd-relative paths
 * (including `../`), and canonical targets reached through symlinks — so the
 * write is the creation path for external files too (`replace` edits existing
 * files only). The lock and state clear apply uniformly to workspace and
 * external targets through the initiating workspace's lock area.
 *
 * The returned definition carries the built-in write name; when it is passed as
 * a child custom tool it overrides the child's built-in write, leaving exactly
 * one write tool offered. It has no pi-square display shell.
 *
 * @param cwd The child's working directory; Pi's factory resolves writes from it.
 * @param owner Anchor-store owner whose served rows the write clears. Required
 *   so a child's write never clears another agent's served record.
 * @param sessionDir The parent session's persistent session directory, used to
 *   locate the anchor store and lock area. Required because the child session's
 *   own directory is its artifacts directory, not the workspace session
 *   directory; an empty value selects the throwaway temp-directory fallback of
 *   a non-persisted parent session.
 * @param autoRead Whether a successful changed write appends the bounded
 *   fresh-anchor appendix. The parent session resolves the agent-only
 *   `anchoredEditing.autoRead` configuration when assembling the child tools;
 *   the default matches the configuration default.
 */
export function createChildAnchoredWriteTool(
  cwd: string,
  owner: string,
  sessionDir: string,
  autoRead: () => boolean = () => true,
): GenericToolDefinition {
  const session = createAnchoredWriteSession({ cwd, owner, sessionDir, autoRead });
  const base = createWriteToolDefinition(cwd, { operations: session.operations });
  return {
    ...base,
    // The operations seam carries no call id. Sequential host execution keeps
    // each completed outcome paired with its own result, including identical
    // path/content calls where an earlier call failed before writeFile.
    executionMode: "sequential",
    async execute(toolCallId, params: { path: string; content: string }, signal, onUpdate, ctx) {
      const target = await resolveAnchoredTarget(cwd, params.path);
      await childWriteEntryBarrier.afterResolve?.(target.canonicalPath);
      const canonicalParams = { ...params, path: target.canonicalPath };
      const successText = `Successfully wrote ${params.content.length} bytes to ${params.path}`;
      try {
        const result = await runWithWriteSignal(
          signal,
          () => base.execute(toolCallId, canonicalParams, signal, onUpdate, ctx),
        );
        const outcome = session.takeOutcome(target.canonicalPath, params.content);
        const restored = result.content.map((part) =>
          part.type === "text" && part.text === `Successfully wrote ${params.content.length} bytes to ${target.canonicalPath}`
            ? { ...part, text: successText }
            : part,
        );
        return {
          ...result,
          content: outcome?.appendix
            ? [...restored, { type: "text" as const, text: `\n\n${outcome.appendix}` }]
            : restored,
        };
      } catch (error) {
        // Pi checks cancellation once more after the injected write settles.
        // If the operation recorded an outcome, the bytes were committed and
        // the truthful result is success even when that final check aborted.
        const outcome = session.takeOutcome(target.canonicalPath, params.content);
        if (!outcome) throw error;
        return {
          content: [
            { type: "text" as const, text: successText },
            ...(outcome.appendix ? [{ type: "text" as const, text: `\n\n${outcome.appendix}` }] : []),
          ],
          details: undefined,
        };
      }
    },
  } as GenericToolDefinition;
}
