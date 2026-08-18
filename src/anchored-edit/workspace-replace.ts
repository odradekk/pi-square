import { constants } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { isWithinWorkspace, resolveWorkspacePath } from "../core/paths.ts";
import { decorateInternalTool } from "../display/internal-adapters.ts";
import type { DisplayRuntimeProvider } from "../display/tool-renderer.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import { safeSnapId } from "./file-reader.ts";
import { AnchorMismatchError, RangeStaleError } from "./hashline/index.ts";
import { loadProjectHashStore, outsideWorkspaceError, PARENT_OWNER } from "./workspace-support.ts";
import {
  assertReq,
  editToolSchema,
  execPipeline,
  resolveMissingPath,
  type ReplaceDetails,
  type ReqParams,
} from "./replace.ts";
import { buildChanged, buildNoop, type RMeta } from "./replace-response.ts";
import { restoreEndings } from "./replace-diff.ts";
import { saveUndo } from "./replace-undo.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { recordServedDiffSafe } from "./served.ts";
import { abortIf, isRec, makePrepareArguments } from "./utils.ts";
import { normReq } from "./replace-normalize.ts";

type WorkspaceReplaceDefinition = ToolDefinition<any, ReplaceDetails, unknown>;

type ReplaceWarningDetails = ReplaceDetails & {
  status: "warning";
  errorCode: string;
};

function errorCode(error: Error): string {
  return /^\[([A-Z_]+)\]/.exec(error.message)?.[1] ?? "E_ANCHOR_REFUSED";
}

function anchorWarning(error: RangeStaleError | AnchorMismatchError): {
  content: Array<{ type: "text"; text: string }>;
  details: ReplaceWarningDetails;
} {
  return {
    content: [{ type: "text", text: error.message }],
    details: {
      diff: "",
      status: "warning",
      errorCode: errorCode(error),
    },
  };
}

/**
 * Creates the parent-only anchored range replacement definition. The caller
 * applies the shared display adapter; this definition has no renderer fields.
 *
 * @param fallbackCwd Directory used when the execution context provides no cwd.
 * @param autoRead Whether post-edit anchored diff rows are recorded and returned.
 * @param owner Anchor-store owner the replace reads and writes under; defaults
 *   to the parent owner so existing records stay on the same owner.
 */
export function createAnchoredReplaceToolDefinition(
  fallbackCwd: string,
  autoRead: () => boolean = () => true,
  owner: string = PARENT_OWNER,
): WorkspaceReplaceDefinition {
  return {
    name: "replace",
    label: "Replace",
    description: loadP("./prompts/replace.md"),
    promptSnippet: loadP("./prompts/replace-snippet.md"),
    promptGuidelines: loadGuide("./prompts/replace-guidelines.md"),
    parameters: editToolSchema,
    prepareArguments: makePrepareArguments(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? fallbackCwd;
      const canonical = normReq(params);
      assertReq(canonical, { allowMissingPath: true });
      const workspace = resolveWorkspacePath(cwd, ".");
      const store = await loadProjectHashStore(workspace.workspaceRoot, owner);
      const resolution = isRec(canonical)
        ? await resolveMissingPath(canonical, store)
        : undefined;
      if (resolution && isRec(canonical)) canonical.path = resolution.path;
      assertReq(canonical);

      const normalizedParams: ReqParams = canonical;
      const target = resolveWorkspacePath(workspace.workspaceRoot, normalizedParams.path);
      if (!target.isInsideWorkspace) throw outsideWorkspaceError(normalizedParams.path);
      const mutationTargetPath = await resolveTarget(target.absolutePath);
      if (!isWithinWorkspace(workspace.workspaceRoot, mutationTargetPath)) {
        throw outsideWorkspaceError(normalizedParams.path);
      }

      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);
        let pipeline;
        try {
          pipeline = await execPipeline(normalizedParams, workspace.workspaceRoot, {
            accessMode: constants.R_OK | constants.W_OK,
            signal,
            store,
          });
        } catch (error) {
          if (error instanceof RangeStaleError || error instanceof AnchorMismatchError) {
            return anchorWarning(error);
          }
          throw error;
        }

        const {
          originalNormalized,
          originalHashes,
          result,
          bom,
          originalEnding,
          hadUtf8DecodeErrors,
          warnings,
          noopEdit,
          firstChangedLine,
          lastChangedLine,
          resultHashes,
          totalAddedLines,
          totalRemovedLines,
        } = pipeline;
        if (resolution) warnings.unshift(resolution.warning);

        const editsAttempted = 1;
        if (originalNormalized === result) {
          const snapshotId = await safeSnapId(mutationTargetPath, "noop anchored replace");
          return buildNoop({
            path: normalizedParams.path,
            noopEdit,
            snapshotId,
            editMeta: {
              editsAttempted,
              noopEditsCount: noopEdit ? 1 : 0,
              addedLines: 0,
              removedLines: 0,
            },
            warnings,
          });
        }

        if (hadUtf8DecodeErrors) {
          warnings.push(
            "Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
          );
        }

        const undo = await saveUndo(mutationTargetPath, {
          content: originalNormalized,
          bom,
          originalEnding,
          hashes: originalHashes,
          resultContent: result,
        }, store);
        if (!undo.persisted) {
          throw new Error(
            `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${normalizedParams.path} is unchanged. Retry the replace, or use write if the store cannot be recovered.`,
          );
        }

        try {
          abortIf(signal);
          await writeAtomic(target.absolutePath, bom + restoreEndings(result, originalEnding));
        } catch (error) {
          await undo.restore();
          throw error;
        }
        const snapshotId = await safeSnapId(mutationTargetPath, "post-anchored-replace");
        const editMeta: RMeta = {
          editsAttempted,
          noopEditsCount: noopEdit ? 1 : 0,
          firstChangedLine,
          lastChangedLine,
          addedLines: totalAddedLines,
          removedLines: totalRemovedLines,
        };
        const changed = buildChanged({
          path: normalizedParams.path,
          originalNormalized,
          originalHashes,
          result,
          resultHashes,
          warnings,
          snapshotId,
          editMeta,
        });
        const diff = changed.details.diff;
        if (autoRead() && diff) {
          await recordServedDiffSafe(
            mutationTargetPath,
            diff,
            "post-anchored-replace diff",
            store,
          );
        }
        if (!autoRead()) changed.details.diff = "";
        return changed;
      });
    },
  };
}

export default function registerAnchoredReplace(
  pi: ExtensionAPI,
  config: () => PiSquareConfig,
  runtime?: DisplayRuntimeProvider,
  anchoredReadAvailable: () => boolean = () => true,
): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!config().anchoredEditing.enabled || !anchoredReadAvailable()) return;
    const definition = createAnchoredReplaceToolDefinition(ctx.cwd, () => config().anchoredEditing.autoRead);
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  });
}
