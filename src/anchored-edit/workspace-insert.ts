import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { resolveWorkspacePath } from "../core/paths.ts";
import { decorateInternalTool } from "../display/internal-adapters.ts";
import type { DisplayRuntimeProvider } from "../display/tool-renderer.ts";
import { PARENT_OWNER, loadAnchoredHashStore } from "./workspace-support.ts";
import { anchoredStoreDir } from "./paths.ts";
import {
  assertInsertReq,
  insertToolSchema,
  resolveMissingInsertPath,
  type InsertDetails,
  type InsertParams,
} from "./insert.ts";
import { runAnchoredInsert } from "./operations.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { makePrepareArguments } from "./utils.ts";
import { normReq } from "./replace-normalize.ts";

type WorkspaceInsertDefinition = ToolDefinition<any, InsertDetails, unknown>;

/**
 * Creates the parent-only anchored insertion definition. The caller applies
 * the shared display adapter; this definition has no renderer fields.
 * Execution is the integrated per-target operation boundary (#264), in the
 * same order as anchored replace: Pi's per-file mutation queue, then the
 * cross-process target lock, then pure preparation, the filesystem commit,
 * and the owner-scoped store publication — all before the boundary releases.
 * Lock contention is reported with the classified `[E_FILE_LOCKED]` refusal.
 * Authorization is mandatory for every owner, the parent included: the target
 * anchor must be served for the exact current content version (#285). Native
 * path authority (#185) is preserved, and the tool operates only on existing
 * files — it never creates a missing target.
 *
 * @param fallbackCwd Directory used when the execution context provides no cwd.
 * @param autoRead Whether post-insert anchored diff rows are recorded and returned.
 * @param owner Anchor-store owner the insert reads and writes under; defaults
 *   to the parent owner so records stay on the same owner partition.
 * @param sessionDir Persistent session directory used to locate the anchor
 *   store (`<sessionDir>/anchored-edit/`); see createAnchoredReplaceToolDefinition.
 */
export function createAnchoredInsertToolDefinition(
  fallbackCwd: string,
  autoRead: () => boolean = () => true,
  owner: string = PARENT_OWNER,
  sessionDir?: string,
): WorkspaceInsertDefinition {
  return {
    name: "insert",
    label: "Insert",
    description: loadP("./prompts/insert.md"),
    promptSnippet: loadP("./prompts/insert-snippet.md"),
    promptGuidelines: loadGuide("./prompts/insert-guidelines.md"),
    parameters: insertToolSchema,
    prepareArguments: makePrepareArguments(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? fallbackCwd;
      const effectiveSessionDir = sessionDir ?? ctx?.sessionManager?.getSessionDir?.() ?? "";
      const canonical = normReq(params);
      assertInsertReq(canonical, { allowMissingPath: true });
      const workspace = resolveWorkspacePath(cwd, ".");
      const storeDir = anchoredStoreDir(effectiveSessionDir, workspace.workspaceRoot);
      let leadingWarnings: string[] | undefined;
      if (!Object.hasOwn(canonical as Record<string, unknown>, "path")) {
        const store = await loadAnchoredHashStore(storeDir, owner);
        try {
          const resolution = await resolveMissingInsertPath(canonical, store);
          if (resolution) {
            (canonical as { path?: string }).path = resolution.path;
            leadingWarnings = [resolution.warning];
          }
        } finally {
          store.release();
        }
      }
      assertInsertReq(canonical);
      const normalizedParams: InsertParams = canonical;
      return runAnchoredInsert({
        cwd,
        params: normalizedParams,
        owner,
        autoRead,
        sessionDir: effectiveSessionDir,
        signal,
        ...(leadingWarnings ? { leadingWarnings } : {}),
      });
    },
  };
}

export default function registerAnchoredInsert(
  pi: ExtensionAPI,
  config: () => PiSquareConfig,
  runtime?: DisplayRuntimeProvider,
  anchoredReadAvailable: () => boolean = () => true,
): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!config().anchoredEditing.enabled || !anchoredReadAvailable()) return;
    const definition = createAnchoredInsertToolDefinition(
      ctx.cwd,
      () => config().anchoredEditing.autoRead,
      PARENT_OWNER,
    );
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  });
}
