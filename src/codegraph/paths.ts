import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isWithinWorkspace, resolveWorkspacePath } from "../core/paths.ts";

export class CodeGraphPathError extends Error {
  constructor(
    readonly code: "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE" | "NOT_DIRECTORY",
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedCodeGraphPath {
  workspaceRoot: string;
  requestedPath: string;
}

export function resolveCodeGraphPath(cwd: string, requested?: string): ResolvedCodeGraphPath {
  let resolvedPath: ReturnType<typeof resolveWorkspacePath>;
  try {
    resolvedPath = resolveWorkspacePath(cwd, requested ?? ".", { rejectDoubleDotPrefix: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CodeGraphPathError("INVALID_PATH", `CodeGraph project path does not exist: ${reason}`);
  }

  const { workspaceRoot, absolutePath: requestedPath, isInsideWorkspace } = resolvedPath;
  if (!isInsideWorkspace) {
    throw new CodeGraphPathError(
      "PATH_OUTSIDE_WORKSPACE",
      `CodeGraph project path must stay within the current workspace: ${workspaceRoot}`,
    );
  }
  if (!statSync(requestedPath).isDirectory()) {
    throw new CodeGraphPathError("NOT_DIRECTORY", `CodeGraph project path is not a directory: ${requestedPath}`);
  }
  return { workspaceRoot, requestedPath };
}

export function hasCodeGraphIndex(projectPath: string): boolean {
  return existsSync(join(projectPath, ".codegraph", "codegraph.db"));
}

export function hasCodeGraphResidue(projectPath: string): boolean {
  const directory = join(projectPath, ".codegraph");
  if (!existsSync(directory)) return false;
  try {
    if (!lstatSync(directory).isDirectory()) return true;
    return readdirSync(directory).some((name) => name !== ".gitignore");
  } catch {
    return true;
  }
}

export function findCodeGraphRoot(start: string, workspaceRoot: string): string | undefined {
  let current = start;
  while (isWithinWorkspace(workspaceRoot, current, { rejectDoubleDotPrefix: true })) {
    if (hasCodeGraphIndex(current)) return current;
    if (current === workspaceRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}
