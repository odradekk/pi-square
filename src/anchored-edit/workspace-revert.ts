import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiSquareConfig } from "../core/config.ts";
import { isWithinWorkspace, resolveWorkspacePath } from "../core/paths.ts";
import { decorateInternalTool } from "../display/internal-adapters.ts";
import type { DisplayRuntimeProvider } from "../display/tool-renderer.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import { changedRange, lineHashes } from "./hashline/index.ts";
import { contentChecksum } from "./hashline/hasher.ts";
import { upsertSnapshot } from "./hash-store.ts";
import { acquireFileLock, fileLockedMessage, lockFilePath } from "./file-lock.ts";
import { clearUndoRecord, getUndoRecord } from "./replace-undo.ts";
import { genDiff, restoreEndings, stripBOM, toLF } from "./replace-diff.ts";
import { buildMetrics, type RMetrics } from "./replace-response.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { recordServedDiff } from "./served.ts";
import { abortIf, cntDiff, errCode, isRec, makePrepareArguments, rejectUnknownFields, splitLines } from "./utils.ts";
import { loadProjectHashStore, outsideWorkspaceError, PARENT_OWNER } from "./workspace-support.ts";
import { toCwd } from "./paths.ts";

const REVERT_FIELDS = new Set(["path"]);

export type RevertDetails = {
  diff: string;
  metrics?: RMetrics;
  status?: "warning";
  errorCode?: string;
};

type WorkspaceRevertDefinition = ToolDefinition<any, RevertDetails, unknown>;

type RevertRequest = { path: string };

export const revertToolSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the workspace file whose most recent anchored replace to revert",
    }),
  },
  { additionalProperties: false },
);

function assertRevertRequest(request: unknown): asserts request is RevertRequest {
  if (!isRec(request)) throw new Error("[E_BAD_SHAPE] Revert request must be an object.");
  rejectUnknownFields(request, REVERT_FIELDS, "Revert request");
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Revert request requires a non-empty "path" string.');
  }
}

function warning(message: string, errorCode?: string): {
  content: Array<{ type: "text"; text: string }>;
  details: RevertDetails;
} {
  return {
    content: [{ type: "text", text: message }],
    details: {
      diff: "",
      status: "warning",
      ...(errorCode ? { errorCode } : {}),
    },
  };
}

/**
 * Names the agent that owns a revert record for the ownership refusal. The
 * parent owner is rendered as "the parent session"; child owners are subagent
 * IDs and already carry the `subagent_` prefix, so they are shown as-is.
 */
function ownerLabel(owner: string | undefined): string {
  return owner === PARENT_OWNER ? "the parent session" : String(owner);
}

/**
 * Refusal a subagent gets when it tries to revert the most recent edit it does
 * not own. Distinct from `[E_UNDO_STALE]` (a modified or deleted file) so the
 * two refusals are distinguishable.
 */
function ownershipWarning(owner: string | undefined, path: string): {
  content: Array<{ type: "text"; text: string }>;
  details: RevertDetails;
} {
  return warning(
    `[E_UNDO_OWNER] Cannot revert ${path}: the most recent edit was made by ${ownerLabel(owner)}, not by this subagent. A subagent can revert only an edit it made itself.`,
    "E_UNDO_OWNER",
  );
}

/**
 * Creates the parent-only, workspace-scoped revert definition. The caller
 * applies the shared display adapter; this definition has no renderer fields.
 *
 * @param fallbackCwd Directory used when the execution context provides no cwd.
 * @param autoRead Whether the restored diff is recorded and returned.
 * @param owner Anchor-store owner the revert reads and writes under; defaults
 *   to the parent owner so existing records stay on the same owner.
 * @param revertAnyOwner Whether this revert may consume the single file-global
 *   revert record regardless of which owner made the edit. The parent passes
 *   true so a supervisor can roll back a subagent's edit; a subagent keeps the
 *   default false so it can revert only an edit it made itself and is refused
 *   otherwise with the owning agent named.
 * @param confineToWorkspace Whether targets outside the workspace are refused.
 *   The parent registration passes false so revert follows an external
 *   replace with the same native path authority (#185); child surfaces keep
 *   the default workspace confinement until their own slice. External targets
 *   keep the initiating workspace's store and canonical-target lock key, and
 *   two different workspaces intentionally do not share external-target state
 *   or locks (accepted last-write-wins, matching Pi's native cross-workspace
 *   behavior).
 */
export function createAnchoredRevertToolDefinition(
  fallbackCwd: string,
  autoRead: () => boolean = () => true,
  owner: string = PARENT_OWNER,
  revertAnyOwner: boolean = false,
  confineToWorkspace: boolean = true,
): WorkspaceRevertDefinition {
  return {
    name: "revert",
    label: "Revert",
    description: loadP("./prompts/undo-last-replace.md"),
    promptSnippet: loadP("./prompts/undo-last-replace-snippet.md"),
    promptGuidelines: loadGuide("./prompts/revert-guidelines.md"),
    parameters: revertToolSchema,
    prepareArguments: makePrepareArguments(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertRevertRequest(params);
      const cwd = ctx?.cwd ?? fallbackCwd;
      const workspace = resolveWorkspacePath(cwd, ".");
      // Native path authority (#185): resolve exactly as Pi's built-in tools
      // do, then canonicalize through symlinks; containment is a child-surface
      // policy, not a parent rule. External targets keep the initiating
      // workspace's store and canonical-target lock key.
      const mutationTargetPath = await resolveTarget(toCwd(params.path, cwd));
      if (confineToWorkspace && !isWithinWorkspace(workspace.workspaceRoot, mutationTargetPath)) {
        throw outsideWorkspaceError(params.path);
      }
      const store = await loadProjectHashStore(workspace.workspaceRoot, owner);

      try {
        return withFileMutationQueue(mutationTargetPath, async () => {
          abortIf(signal);
          const lock = await acquireFileLock(
            lockFilePath(workspace.workspaceRoot, mutationTargetPath),
            { signal },
          );
          if (!lock) {
            return warning(fileLockedMessage(params.path, "revert"), "E_FILE_LOCKED");
          }
          try {
            abortIf(signal);
            const found = await getUndoRecord(mutationTargetPath, store);
          if (!found) {
            return warning(`No revert history for ${params.path}. There is no previous replace to revert.`);
          }
          if (!revertAnyOwner && found.owner !== owner) {
            return ownershipWarning(found.owner, params.path);
          }
          const undo = found.entry;

          let currentRaw: string | undefined;
          try {
            currentRaw = await readFile(mutationTargetPath, "utf8");
          } catch (error) {
            if (errCode(error) !== "ENOENT") throw error;
          }
          if (currentRaw === undefined) {
            await clearUndoRecord(mutationTargetPath, store);
            return warning(
              `[E_UNDO_STALE] Cannot revert ${params.path}: the file no longer exists. Call read to inspect the current state.`,
              "E_UNDO_STALE",
            );
          }
          if (currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)) {
            await clearUndoRecord(mutationTargetPath, store);
            return warning(
              `[E_UNDO_STALE] Cannot revert ${params.path}: the file was modified after the replace, so reverting would overwrite newer content. Call read to inspect the current state.`,
              "E_UNDO_STALE",
            );
          }

          const { text: currentStripped } = stripBOM(currentRaw);
          const currentNormalized = toLF(currentStripped);
          const currentHashes = await lineHashes(currentNormalized, mutationTargetPath, undefined, store);
          const diffResult = genDiff(undo.content, currentNormalized, 0, undefined, undo.hashes);
          const linesAddedByReplace = cntDiff(diffResult.diff, "+");
          const linesRemovedByReplace = cntDiff(diffResult.diff, "-");
          const restoredRange = changedRange(currentNormalized, undo.content);
          const diff = genDiff(currentNormalized, undo.content, 1, undo.hashes, currentHashes).diff;

          abortIf(signal);
          await writeAtomic(mutationTargetPath, undo.bom + restoreEndings(undo.content, undo.originalEnding));
          try {
            upsertSnapshot(
              store,
              mutationTargetPath,
              contentChecksum(undo.content),
              splitLines(undo.content).length,
              undo.hashes,
            );
            if (autoRead()) recordServedDiff(store, mutationTargetPath, diff);
          } catch (error) {
            console.error("Failed to restore hash store snapshot after revert:", error);
          }
          await clearUndoRecord(mutationTargetPath, store);

          const parts = [`Reverted the last replace on ${params.path}.`];
          if (linesAddedByReplace > 0 || linesRemovedByReplace > 0) {
            parts.push(
              `Removed ${linesAddedByReplace} line(s) that were added and restored ${linesRemovedByReplace} line(s) that were removed.`,
            );
          }
          parts.push(autoRead()
            ? "File reverted to its previous state. Use the returned diff anchors for follow-up edits."
            : "File reverted to its previous state.");
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            details: {
              diff: autoRead() ? diff : "",
              metrics: buildMetrics({
                classification: "applied",
                editsAttempted: 1,
                noopEditsCount: 0,
                warningsCount: 0,
                firstChangedLine: restoredRange?.firstChangedLine,
                lastChangedLine: restoredRange?.lastChangedLine,
                addedLines: linesRemovedByReplace,
                removedLines: linesAddedByReplace,
              }),
            },
          };
          } finally {
            await lock.release();
          }
        });
      } finally {
        store.release();
      }
    },
  };
}

export function registerAnchoredRevert(
  pi: ExtensionAPI,
  config: () => PiSquareConfig,
  runtime?: DisplayRuntimeProvider,
  anchoredReadAvailable: () => boolean = () => true,
): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!config().anchoredEditing.enabled || !anchoredReadAvailable()) return;
    const definition = createAnchoredRevertToolDefinition(
      ctx.cwd,
      () => config().anchoredEditing.autoRead,
      PARENT_OWNER,
      true,
      false,
    );
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  });
}

export default registerAnchoredRevert;
