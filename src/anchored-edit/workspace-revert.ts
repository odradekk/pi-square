import { resolve } from "node:path";
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
import { clearUndo, getUndo } from "./replace-undo.ts";
import { genDiff, restoreEndings, stripBOM, toLF } from "./replace-diff.ts";
import { buildMetrics, type RMetrics } from "./replace-response.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { recordServedDiff } from "./served.ts";
import { abortIf, cntDiff, errCode, isRec, makePrepareArguments, rejectUnknownFields, splitLines } from "./utils.ts";
import { loadProjectHashStore, outsideWorkspaceError, PARENT_OWNER } from "./workspace-support.ts";

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
 * Creates the parent-only, workspace-scoped revert definition. The caller
 * applies the shared display adapter; this definition has no renderer fields.
 *
 * @param fallbackCwd Directory used when the execution context provides no cwd.
 * @param autoRead Whether the restored diff is recorded and returned.
 * @param owner Anchor-store owner the revert reads and writes under; defaults
 *   to the parent owner so existing records stay on the same owner.
 */
export function createAnchoredRevertToolDefinition(
  fallbackCwd: string,
  autoRead: () => boolean = () => true,
  owner: string = PARENT_OWNER,
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
      const mutationTargetPath = await resolveTarget(resolve(workspace.workspaceRoot, params.path));
      if (!isWithinWorkspace(workspace.workspaceRoot, mutationTargetPath)) {
        throw outsideWorkspaceError(params.path);
      }
      const store = await loadProjectHashStore(workspace.workspaceRoot, owner);

      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);
        const undo = await getUndo(mutationTargetPath, store);
        if (!undo) {
          return warning(`No revert history for ${params.path}. There is no previous replace to revert.`);
        }

        let currentRaw: string | undefined;
        try {
          currentRaw = await readFile(mutationTargetPath, "utf8");
        } catch (error) {
          if (errCode(error) !== "ENOENT") throw error;
        }
        if (currentRaw === undefined) {
          await clearUndo(mutationTargetPath, store);
          return warning(
            `[E_UNDO_STALE] Cannot revert ${params.path}: the file no longer exists. Call read to inspect the current state.`,
            "E_UNDO_STALE",
          );
        }
        if (currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)) {
          await clearUndo(mutationTargetPath, store);
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
        await clearUndo(mutationTargetPath, store);

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
      });
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
    const definition = createAnchoredRevertToolDefinition(ctx.cwd, () => config().anchoredEditing.autoRead);
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  });
}

export default registerAnchoredRevert;
