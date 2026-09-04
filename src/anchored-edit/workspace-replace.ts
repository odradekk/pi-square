import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { resolveWorkspacePath } from "../core/paths.ts";
import { decorateInternalTool } from "../display/internal-adapters.ts";
import type { DisplayRuntimeProvider } from "../display/tool-renderer.ts";
import { PARENT_OWNER, loadAnchoredHashStore } from "./workspace-support.ts";
import { anchoredStoreDir } from "./paths.ts";
import {
  assertReq,
  editToolSchema,
  resolveMissingPath,
  type ReplaceDetails,
  type ReqParams,
} from "./replace.ts";
import { runAnchoredReplace } from "./operations.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { makePrepareArguments } from "./utils.ts";
import { normReq } from "./replace-normalize.ts";

type WorkspaceReplaceDefinition = ToolDefinition<any, ReplaceDetails, unknown>;

/**
 * Creates the parent-only anchored range replacement definition. The caller
 * applies the shared display adapter; this definition has no renderer fields.
 * Execution is the integrated per-target operation boundary (#264): Pi's
 * per-file mutation queue, then the cross-process target lock, then pure
 * preparation, the filesystem commit, and the owner-scoped store publication
 * — all before the boundary releases. Lock contention is reported with the
 * classified `[E_FILE_LOCKED]` refusal; `[E_RANGE_STALE]` is reserved for
 * post-lock validation against a file that no longer matches the served
 * range. Native path authority (#185) is preserved: absolute, `~`,
 * cwd-relative (including `../`), and symlinked targets resolve exactly as
 * Pi's built-ins do, with the initiating workspace owning external targets'
 * store rows and locks.
 *
 * @param fallbackCwd Directory used when the execution context provides no cwd.
 * @param autoRead Whether post-edit anchored diff rows are recorded and returned.
 * @param owner Anchor-store owner the replace reads and writes under; defaults
 *   to the parent owner so existing records stay on the same owner.
 * @param requireServed Forces verification against the owner's served record
 *   even when the owner never read the file. Used by child replaces so a child
 *   cannot edit a region it was never shown; the parent leaves it off.
 * @param sessionDir Persistent session directory used to locate the anchor
 *   store (`<sessionDir>/anchored-edit/`). When undefined, the executing
 *   session's own directory is read from the execution context (the parent
 *   case). Child compositions pass the parent session's directory captured at
 *   assembly time, because a child session's own directory is its artifacts
 *   directory, not the workspace session directory. An empty value selects the
 *   throwaway temp-directory fallback for non-persisted sessions.
 */
export function createAnchoredReplaceToolDefinition(
  fallbackCwd: string,
  autoRead: () => boolean = () => true,
  owner: string = PARENT_OWNER,
  requireServed: boolean = false,
  sessionDir?: string,
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
      const effectiveSessionDir = sessionDir ?? ctx?.sessionManager?.getSessionDir?.() ?? "";
      const canonical = normReq(params);
      assertReq(canonical, { allowMissingPath: true });
      const workspace = resolveWorkspacePath(cwd, ".");
      const storeDir = anchoredStoreDir(effectiveSessionDir, workspace.workspaceRoot);
      let leadingWarnings: string[] | undefined;
      if (!Object.hasOwn(canonical as Record<string, unknown>, "path")) {
        const store = await loadAnchoredHashStore(storeDir, owner);
        try {
          const resolution = await resolveMissingPath(canonical, store);
          if (resolution) {
            (canonical as { path?: string }).path = resolution.path;
            leadingWarnings = [resolution.warning];
          }
        } finally {
          store.release();
        }
      }
      assertReq(canonical);
      const normalizedParams: ReqParams = canonical;
      return runAnchoredReplace({
        cwd,
        params: normalizedParams,
        owner,
        requireServed,
        autoRead,
        sessionDir: effectiveSessionDir,
        signal,
        ...(leadingWarnings ? { leadingWarnings } : {}),
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
    const definition = createAnchoredReplaceToolDefinition(
      ctx.cwd,
      () => config().anchoredEditing.autoRead,
      PARENT_OWNER,
      false,
    );
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  });
}
