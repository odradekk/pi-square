import { resolve } from "node:path";
import { createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isWithinWorkspace, resolveWorkspacePath } from "../core/paths.ts";
import { resolveTarget } from "./fs-write.ts";
import { acquireFileLock, fileLockedMessage, lockFilePath } from "./file-lock.ts";
import { clearUndoRecord } from "./replace-undo.ts";
import { clearServed } from "./served.ts";
import { loadProjectHashStore } from "./workspace-support.ts";

type GenericToolDefinition = ToolDefinition<any, any, any>;

/**
 * Builds the child write tool for a writable subagent while anchored editing is
 * on. It is Pi's public write factory, so the child writes exactly as it does
 * with the built-in tool, with one addition: a successful workspace write
 * clears that file's single revert record (whoever made the recorded edit) and
 * the child's own served rows, so single-level revert never outlives a
 * subsequent write by the child, and a later revert cannot clobber the write.
 * A failed write leaves both intact.
 *
 * The returned definition carries the built-in write name; when it is passed as
 * a child custom tool it overrides the child's built-in write, leaving exactly
 * one write tool offered. It has no pi-square display shell.
 *
 * @param cwd The child's working directory; Pi's factory resolves writes from it.
 * @param owner Anchor-store owner whose served rows the write clears. Required
 *   so a child's write never clears another agent's served record.
 */
export function createChildAnchoredWriteTool(cwd: string, owner: string): GenericToolDefinition {
  const base = createWriteToolDefinition(cwd);
  return {
    ...base,
    async execute(toolCallId, params: { path: string; content: string }, signal, onUpdate, ctx) {
      const workspace = resolveWorkspacePath(cwd, ".");
      const path = await resolveTarget(resolve(workspace.workspaceRoot, params.path));
      if (!isWithinWorkspace(workspace.workspaceRoot, path)) {
        return base.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      // The child write also takes the cross-process write lock, so a child
      // write and a parent (or another session's) replace or revert on the same
      // file can never interleave; one wins and the other is refused or waits.
      const lock = await acquireFileLock(lockFilePath(workspace.workspaceRoot, path), { signal });
      if (!lock) {
        throw new Error(fileLockedMessage(params.path, "write"));
      }
      try {
        const result = await base.execute(toolCallId, params, signal, onUpdate, ctx);
        try {
          // The cross-process lock serializes this file for every other writer,
          // so the state clear cannot interleave with a concurrent replace or
          // revert and needs no separate per-file mutation queue here (wrapping
          // the clear in one would invert lock order against replace/revert and
          // could deadlock a same-process contender).
          const store = await loadProjectHashStore(workspace.workspaceRoot, owner);
          try {
            clearUndoRecord(path, store);
            clearServed(store, path);
          } finally {
            store.release();
          }
        } catch (error) {
          console.error(`Failed to clear anchored write state for ${owner}:`, error);
        }
        return result;
      } finally {
        await lock.release();
      }
    },
  } as GenericToolDefinition;
}
