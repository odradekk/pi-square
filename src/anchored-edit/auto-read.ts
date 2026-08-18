import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_MAX_BYTES, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config.ts";
import { isWithinWorkspace, resolveWorkspacePath } from "../core/paths.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile } from "./file-reader.ts";
import { resolveTarget } from "./fs-write.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { fmtReadPreview } from "./read.ts";
import { deleteUndo } from "./hash-store.ts";
import { extractWarnings } from "./replace-render.ts";
import { clearServed, recordServed } from "./served.ts";
import { isRec, visLines } from "./utils.ts";
import { loadProjectHashStore } from "./workspace-support.ts";
import { AUTO_READ_MAX } from "./constants.ts";

type PendingWrite = {
  path: string;
  changed: boolean;
  displayPath: string;
  workspaceRoot: string;
};

function writeInput(value: unknown): { path: string; content: string } | undefined {
  if (!isRec(value) || typeof value.path !== "string" || typeof value.content !== "string") return undefined;
  return { path: value.path, content: value.content };
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
      const path = await resolveTarget(resolve(workspace.workspaceRoot, input.path));
      if (!isWithinWorkspace(workspace.workspaceRoot, path)) return;
      let changed = true;
      const pending: PendingWrite = { path, changed, displayPath: input.path, workspaceRoot: workspace.workspaceRoot };
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
    if (event.toolName === "replace" || event.toolName === "revert") {
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
        const store = await loadProjectHashStore(pending.workspaceRoot);
        try {
          deleteUndo(store, pending.path);
          clearServed(store, pending.path);
          if (!config().anchoredEditing.autoRead || !pending.changed) return;
          try {
            const file = await loadFileKindAndText(pending.path, {
              maxLines: MAX_HASH_LINES,
              displayPath: pending.displayPath,
            });
            if (file.kind !== "text") return;
            const normalized = await readNormFile(pending.displayPath, pending.workspaceRoot, {
              maxLines: MAX_HASH_LINES,
              preloadedFile: file,
              store,
            });
            const preview = await fmtReadPreview(
              normalized.normalized,
              {},
              normalized.fileHashes,
              normalized.absolutePath,
              DEFAULT_MAX_BYTES,
              AUTO_READ_MAX,
            );
            recordServed(store, normalized.absolutePath, preview.servedHashes);
            const skipped = preview.nextOffset === undefined
              ? ""
              : `\n[${visLines(normalized.normalized).length - preview.nextOffset + 1} lines skipped; call read with offset=${preview.nextOffset} for more anchors.]`;
            const warning = normalized.hadUtf8DecodeErrors
              ? "\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]"
              : "";
            return append(event.content, `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}${skipped}${warning}`);
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
