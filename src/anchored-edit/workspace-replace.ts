import { constants } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { isWithinWorkspace, resolveWorkspacePath, type ResolvedWorkspacePath } from "../core/paths.ts";
import { decorateInternalTool } from "../display/internal-adapters.ts";
import type { DisplayRuntimeProvider } from "../display/tool-renderer.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import { safeSnapId } from "./file-reader.ts";
import { AnchorMismatchError, RangeStaleError, parseHashRef, HASH_SEP } from "./hashline/index.ts";
import { MAX_RANGE_STALE_LINES } from "./constants.ts";
import { acquireFileLock, lockFilePath } from "./file-lock.ts";
import { loadProjectHashStore, outsideWorkspaceError, PARENT_OWNER } from "./workspace-support.ts";
import type { HashStore } from "./hash-store.ts";
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
import { abortIf, isRec, makePrepareArguments, splitLines } from "./utils.ts";
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

/** Renders the current lines of the requested range as `hash│line` rows, so a
 *  lock-timeout refusal carries fresh anchors exactly like a range that changed
 *  on disk. Returns "" when the anchors cannot be re-resolved. */
function currentRangeRows(params: ReqParams, hashes: string[], lines: string[]): string {
  let fromHash: string;
  let toHash: string;
  try {
    fromHash = parseHashRef(params.remove_from).hash;
    toHash = parseHashRef(params.remove_to).hash;
  } catch {
    return "";
  }
  const from = hashes.indexOf(fromHash);
  const to = hashes.indexOf(toHash);
  if (from < 0 || to < 0) return "";
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const count = Math.min(end - start + 1, MAX_RANGE_STALE_LINES);
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(`${hashes[start + i]}${HASH_SEP}${lines[start + i]}`);
  }
  return rows.join("\n");
}

/** Refusal a replace returns when the cross-process lock could not be acquired
 *  within the bounded wait. It uses the same recoverable `E_RANGE_STALE` code
 *  as a range that changed on disk and carries the current range with fresh
 *  anchors, so the caller retries against current content. */
async function lockTimeoutRefusal(
  params: ReqParams,
  workspace: ResolvedWorkspacePath,
  store: HashStore,
  requireServed: boolean,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: ReplaceWarningDetails;
}> {
  let pipeline: Awaited<ReturnType<typeof execPipeline>> | undefined;
  try {
    pipeline = await execPipeline(params, workspace.workspaceRoot, {
      accessMode: constants.R_OK,
      signal,
      store,
      requireServed,
    });
  } catch (error) {
    if (error instanceof RangeStaleError || error instanceof AnchorMismatchError) {
      return anchorWarning(error);
    }
    throw error;
  }
  const rows = currentRangeRows(params, pipeline.originalHashes, splitLines(pipeline.originalNormalized));
  const tail = rows
    ? `Current range with fresh anchors:\n\n${rows}`
    : "Call read to inspect the current state.";
  return {
    content: [{
      type: "text",
      text: `[E_RANGE_STALE] Another editor holds the write lock on ${params.path}; nothing was modified. ${tail}`,
    }],
    details: { diff: "", status: "warning", errorCode: "E_RANGE_STALE" },
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
 * @param requireServed Forces verification against the owner's served record
 *   even when the owner never read the file. Used by child replaces so a child
 *   cannot edit a region it was never shown; the parent leaves it off.
 */
export function createAnchoredReplaceToolDefinition(
  fallbackCwd: string,
  autoRead: () => boolean = () => true,
  owner: string = PARENT_OWNER,
  requireServed: boolean = false,
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
      try {
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
          const lock = await acquireFileLock(
            lockFilePath(workspace.workspaceRoot, mutationTargetPath),
            { signal },
          );
          if (!lock) {
            return lockTimeoutRefusal(normalizedParams, workspace, store, requireServed, signal);
          }
          try {
            abortIf(signal);
            let pipeline;
            try {
              pipeline = await execPipeline(normalizedParams, workspace.workspaceRoot, {
                accessMode: constants.R_OK | constants.W_OK,
                signal,
                store,
                requireServed,
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
