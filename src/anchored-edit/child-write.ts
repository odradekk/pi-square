import { readFile } from "node:fs/promises";
import { createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath } from "../core/paths.ts";
import { renderAutoReadAnchors } from "./auto-read.ts";
import { resolveTarget } from "./fs-write.ts";
import { acquireFileLock, fileLockedMessage, lockFilePath } from "./file-lock.ts";
import { anchoredStoreDir, toCwd } from "./paths.ts";
import { clearServed } from "./served.ts";
import { loadAnchoredHashStore } from "./workspace-support.ts";

type GenericToolDefinition = ToolDefinition<any, any, any>;

/**
 * Builds the child write tool for a writable subagent while anchored editing is
 * on. It is Pi's public write factory, so the child writes exactly as it does
 * with the built-in tool, with one addition: a successful write clears the
 * child's own served rows, so its next edit on the new content is not refused
 * by stale served rows. A failed write leaves them intact. Only the acting
 * child's own rows are cleared, so a sibling child's served partition survives
 * the write.
 *
 * Native path authority (#186): the write follows Pi's native path resolution
 * for every supported target — absolute paths, `~` paths, cwd-relative paths
 * (including `../`), and canonical targets reached through symlinks — so the
 * write is the creation path for external files too (`replace` edits existing
 * files only). The cross-process write lock and the state clear apply uniformly
 * to workspace and external targets through the initiating workspace's lock
 * area: two different workspaces intentionally do not share external-target
 * state or locks (accepted last-write-wins, matching Pi's native
 * cross-workspace behavior), while two sessions in one workspace still
 * coordinate. When auto-read is enabled, a successful changed write to
 * supported bounded UTF-8 text appends the same fresh-anchor appendix the
 * parent write hook appends (shared `renderAutoReadAnchors`), with the fresh
 * rows served under the writing child; failed, unchanged, binary, image,
 * oversized, and unsupported writes keep the factory result unchanged.
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
  const base = createWriteToolDefinition(cwd);
  return {
    ...base,
    async execute(toolCallId, params: { path: string; content: string }, signal, onUpdate, ctx) {
      const workspace = resolveWorkspacePath(cwd, ".");
      const path = await resolveTarget(toCwd(params.path, cwd));
      const storeDir = anchoredStoreDir(sessionDir, workspace.workspaceRoot);
      // The child write also takes the cross-process write lock, so a child
      // write and a parent (or another session's) replace on the same file can
      // never interleave; one wins and the other is refused or waits.
      const lock = await acquireFileLock(lockFilePath(storeDir, path), { signal });
      if (!lock) {
        throw new Error(fileLockedMessage(params.path, "write"));
      }
      try {
        // Pre-write comparison inside the lock decides whether the write is a
        // change for auto-read; a missing file counts as changed (creation).
        let changed = true;
        try {
          changed = !Buffer.from(params.content, "utf8").equals(await readFile(path));
        } catch {
          // ENOENT (creation) or an unreadable target: treat as changed; the
          // post-write appendix render still applies its own bounds.
        }
        // A failed factory write throws, so reaching here means the write
        // completed; the state clear and optional appendix follow.
        const result = await base.execute(toolCallId, params, signal, onUpdate, ctx);
        try {
          // The cross-process lock serializes this file for every other writer,
          // so the state clear cannot interleave with a concurrent replace and
          // needs no separate per-file mutation queue here (wrapping the clear
          // in one would invert lock order against replace and could deadlock a
          // same-process contender).
          const store = await loadAnchoredHashStore(storeDir, owner);
          try {
            clearServed(store, path);
            if (!autoRead() || !changed) return result;
            try {
              const appendix = await renderAutoReadAnchors({
                path,
                displayPath: params.path,
                workspaceRoot: workspace.workspaceRoot,
                store,
              });
              if (appendix === undefined) return result;
              return {
                ...result,
                content: [...result.content, { type: "text", text: `\n\n${appendix}` }],
              };
            } catch (error) {
              console.error(`Auto-read after anchored child write failed for ${owner}:`, error);
              return result;
            }
          } finally {
            store.release();
          }
        } catch (error) {
          console.error(`Failed to clear anchored write state for ${owner}:`, error);
          return result;
        }
      } finally {
        await lock.release();
      }
    },
  } as GenericToolDefinition;
}
