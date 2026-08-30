import { readFile } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { resolveWorkspacePath } from "../core/paths.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile } from "./file-reader.ts";
import { resolveTarget } from "./fs-write.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { fmtReadPreview } from "./read.ts";
import { extractWarnings } from "./replace-render.ts";
import { clearServed, recordServed } from "./served.ts";
import { errCode, isRec, visLines } from "./utils.ts";
import { loadAnchoredHashStore } from "./workspace-support.ts";
import type { HashStoreHandle } from "./hash-store.ts";
import { anchoredStoreDir, toCwd } from "./paths.ts";
import { AUTO_READ_MAX } from "./constants.ts";

type PendingWrite = {
  path: string;
  changed: boolean;
  displayPath: string;
  workspaceRoot: string;
  /** Session directory captured at tool_call time, used to locate the store. */
  sessionDir: string;
};

function writeInput(value: unknown): { path: string; content: string } | undefined {
  if (!isRec(value) || typeof value.path !== "string" || typeof value.content !== "string") return undefined;
  return { path: value.path, content: value.content };
}

export interface AutoReadAnchorsInput {
  /** Canonical target path. */
  path: string;
  /** Model-visible path string used for display and anchored-row text. */
  displayPath: string;
  /** Initiating workspace root owning the store. */
  workspaceRoot: string;
  /** Loaded anchored hash store under the acting owner; the caller releases it. */
  store: HashStoreHandle;
}

/**
 * Renders the bounded auto-read anchor appendix for one written file and
 * records its rows as served under the acting owner. Shared by the parent
 * write hook and the writable-child anchored write (#186) so both surfaces
 * append byte-identical anchors. Returns undefined when the target is not
 * supported bounded UTF-8 text (binary, image, oversized, non-regular); the
 * caller then keeps the native factory result unchanged.
 */
export async function renderAutoReadAnchors(input: AutoReadAnchorsInput): Promise<string | undefined> {
  try {
    const file = await loadFileKindAndText(input.path, {
      maxLines: MAX_HASH_LINES,
      displayPath: input.displayPath,
    });
    if (file.kind !== "text") return undefined;
    const normalized = await readNormFile(input.displayPath, input.workspaceRoot, {
      maxLines: MAX_HASH_LINES,
      preloadedFile: file,
      store: input.store,
    });
    const preview = await fmtReadPreview(
      normalized.normalized,
      {},
      normalized.fileHashes,
      DEFAULT_MAX_BYTES,
      AUTO_READ_MAX,
    );
    recordServed(input.store, normalized.absolutePath, preview.servedHashes);
    const skipped = preview.nextOffset === undefined
      ? ""
      : `\n[${visLines(normalized.normalized).length - preview.nextOffset + 1} lines skipped; call read with offset=${preview.nextOffset} for more anchors.]`;
    const warning = normalized.hadUtf8DecodeErrors
      ? "\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]"
      : "";
    return `--- Auto-read (hashline anchors) ---\n${preview.text}${skipped}${warning}`;
  } catch (error) {
    if (errCode(error) === "E_FILE_TOO_LARGE" || String(error).includes("[E_FILE_TOO_LARGE]")) return undefined;
    throw error;
  }
}

function append(content: AgentToolResult<unknown>["content"], text: string): { content: AgentToolResult<unknown>["content"] } {
  return { content: [...content, { type: "text", text }] };
}

export function registerAnchoredAutoRead(
  pi: ExtensionAPI,
  config: () => PiSquareConfig,
  anchoredReadAvailable: () => boolean = () => true,
): void {
  const pendingWrites = new Map<string, PendingWrite>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" || !config().anchoredEditing.enabled || !anchoredReadAvailable()) return;
    const input = writeInput(event.input);
    if (!input) return;
    try {
      const workspace = resolveWorkspacePath(ctx.cwd, ".");
      // Native path authority (#185): parent write-state handling follows Pi's
      // native path resolution (absolute, ~, cwd-relative including ../, and
      // symlinked targets), so a write to any supported path clears served
      // state for that canonical file in the initiating workspace. External
      // targets keep the initiating workspace's store and lock area; two
      // different workspaces intentionally do not share external-target state
      // or locks (accepted last-write-wins, matching Pi's native
      // cross-workspace behavior).
      const path = await resolveTarget(toCwd(input.path, ctx.cwd));
      let changed = true;
      const pending: PendingWrite = { path, changed, displayPath: input.path, workspaceRoot: workspace.workspaceRoot, sessionDir: ctx.sessionManager?.getSessionDir?.() ?? "" };
      pendingWrites.set(event.toolCallId, pending);
      try {
        changed = !Buffer.from(input.content, "utf8").equals(await readFile(path));
        pending.changed = changed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error("Failed to compare anchored write before execution:", error);
        }
      }
    } catch (error) {
      console.error("Failed to inspect anchored write before execution:", error);
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "replace") {
      if (event.isError || !config().anchoredEditing.enabled || !config().anchoredEditing.autoRead || !anchoredReadAvailable()) return;
      if (!isRec(event.details) || typeof event.details.diff !== "string" || event.details.diff.length === 0) return;
      const metrics = isRec(event.details.metrics) ? event.details.metrics : undefined;
      if (metrics?.classification === "noop") return;
      const warnings = extractWarnings(
        event.content
          .filter((entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string")
          .map((entry) => entry.text)
          .join("\n"),
      );
      return { content: [{ type: "text", text: warnings ? `${event.details.diff}\n\n${warnings}` : event.details.diff }] };
    }
    if (event.toolName !== "write") return;
    const pending = pendingWrites.get(event.toolCallId);
    pendingWrites.delete(event.toolCallId);
    if (event.isError || !pending || !config().anchoredEditing.enabled || !anchoredReadAvailable()) return;

    try {
      return await withFileMutationQueue(pending.path, async () => {
        const store = await loadAnchoredHashStore(anchoredStoreDir(pending.sessionDir, pending.workspaceRoot));
        try {
          clearServed(store, pending.path);
          if (!config().anchoredEditing.autoRead || !pending.changed) return;
          try {
            const appendix = await renderAutoReadAnchors({
              path: pending.path,
              displayPath: pending.displayPath,
              workspaceRoot: pending.workspaceRoot,
              store,
            });
            if (appendix !== undefined) return append(event.content, `\n\n${appendix}`);
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Auto-read after write failed:", error);
            return append(event.content, `\n\n--- Auto-read failed: ${message} ---`);
          }
        } finally {
          store.release();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to clear anchored write state:", error);
      return append(event.content, `\n\n--- Auto-read failed: ${message} ---`);
    }
  });
}

export default registerAnchoredAutoRead;
