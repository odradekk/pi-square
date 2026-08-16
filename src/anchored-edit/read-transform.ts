import { stat } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath } from "../core/paths.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile } from "./file-reader.ts";
import { loadHashStoreAt, pruneMissing } from "./hash-store.ts";
import { MAX_HASH_LINES } from "./hashline/index.ts";
import { projectHashStorePath } from "./paths.ts";
import { fmtReadPreview } from "./read.ts";
import { recordServed } from "./served.ts";

const PROJECT_OWNER = "parent";

export type ReadModelContent = AgentToolResult<unknown>["content"];

function textContent(text: string): ReadModelContent {
  return [{ type: "text", text }];
}

function errorText(code: string, message: string): ReadModelContent {
  return textContent(`[${code}] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readParams(value: unknown): { path: string; offset?: number; limit?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  if (typeof params.path !== "string") return undefined;
  return {
    path: params.path,
    ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

export async function guardAnchoredRead(
  value: unknown,
  cwd: string,
): Promise<ReadModelContent | undefined> {
  const params = readParams(value);
  if (!params) return undefined;

  let workspace;
  try {
    workspace = resolveWorkspacePath(cwd, params.path);
  } catch (error) {
    return errorText("E_READ_PATH", `Cannot resolve ${params.path}: ${errorMessage(error)}`);
  }
  if (!workspace.isInsideWorkspace) {
    return errorText(
      "E_OUTSIDE_WORKSPACE",
      `${params.path} resolves outside the workspace. Disable anchoredEditing.enabled to use Pi's built-in read for that path.`,
    );
  }

  try {
    const fileStat = await stat(workspace.absolutePath);
    if (fileStat.isDirectory()) {
      return errorText("E_READ_FAILED", `[E_NOT_TEXT] Path is a directory: ${params.path}. Use ls to inspect directories.`);
    }
    if (!fileStat.isFile()) {
      return errorText("E_READ_FAILED", `[E_NOT_TEXT] Path is not a regular file: ${params.path}.`);
    }
  } catch {
    // Let Pi's factory preserve its standard not-found and access errors.
  }
  return undefined;
}

export async function initializeAnchoredReadStore(cwd: string): Promise<void> {
  const workspace = resolveWorkspacePath(cwd, ".");
  const store = await loadHashStoreAt(projectHashStorePath(workspace.workspaceRoot), {
    owner: PROJECT_OWNER,
    migrateLegacy: false,
  });
  await pruneMissing(store);
}

export async function transformAnchoredReadContent(
  content: ReadModelContent,
  value: unknown,
  cwd: string,
): Promise<ReadModelContent> {
  const params = readParams(value);
  if (!params) return content;

  let workspace;
  try {
    workspace = resolveWorkspacePath(cwd, params.path);
  } catch (error) {
    return errorText("E_READ_PATH", `Cannot resolve ${params.path}: ${errorMessage(error)}`);
  }
  if (!workspace.isInsideWorkspace) {
    return errorText(
      "E_OUTSIDE_WORKSPACE",
      `${params.path} resolves outside the workspace. Disable anchoredEditing.enabled to use Pi's built-in read for that path.`,
    );
  }

  let file;
  try {
    file = await loadFileKindAndText(workspace.absolutePath, {
      maxLines: MAX_HASH_LINES,
      displayPath: params.path,
    });
  } catch (error) {
    return errorText("E_READ_FAILED", errorMessage(error));
  }
  if (file.kind === "image") return content;

  try {
    const store = await loadHashStoreAt(projectHashStorePath(workspace.workspaceRoot), {
      owner: PROJECT_OWNER,
      migrateLegacy: false,
    });
    const normalized = await readNormFile(params.path, workspace.workspaceRoot, {
      preloadedFile: file,
      maxLines: MAX_HASH_LINES,
      store,
    });
    const preview = await fmtReadPreview(
      normalized.normalized,
      { offset: params.offset, limit: params.limit },
      normalized.fileHashes,
      normalized.absolutePath,
    );
    recordServed(store, normalized.absolutePath, preview.servedHashes);
    const text = normalized.hadUtf8DecodeErrors
      ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
      : preview.text;
    return textContent(text);
  } catch (error) {
    return errorText(
      "E_READ_FAILED",
      `${errorMessage(error)} Disable anchoredEditing.enabled to use Pi's built-in read for this path.`,
    );
  }
}
