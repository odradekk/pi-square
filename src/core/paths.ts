import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface WorkspaceBoundaryOptions {
  /** Retains callers that historically rejected a name beginning with "..". */
  rejectDoubleDotPrefix?: boolean;
}

export interface ResolvedWorkspacePath {
  workspaceRoot: string;
  absolutePath: string;
  isInsideWorkspace: boolean;
}

export function isWithinWorkspace(
  workspaceRoot: string,
  candidate: string,
  { rejectDoubleDotPrefix = false }: WorkspaceBoundaryOptions = {},
): boolean {
  const path = relative(workspaceRoot, candidate);
  return path === "" || (
    !path.startsWith(`..${sep}`)
    && path !== ".."
    && !isAbsolute(path)
    && (!rejectDoubleDotPrefix || !path.startsWith(".."))
  );
}

export function resolveWorkspacePath(
  cwd: string,
  requestedPath: string,
  options: WorkspaceBoundaryOptions = {},
): ResolvedWorkspacePath {
  const workspaceRoot = realpathSync(cwd);
  const absolutePath = realpathSync(resolve(workspaceRoot, requestedPath));
  return {
    workspaceRoot,
    absolutePath,
    isInsideWorkspace: isWithinWorkspace(workspaceRoot, absolutePath, options),
  };
}

export function getPackageRoot(): string {
  return packageRoot;
}

export function getPackagePath(...segments: string[]): string {
  return join(packageRoot, ...segments);
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}

export function getProjectPath(cwd: string, ...segments: string[]): string {
  return join(cwd, ".pi", ...segments);
}
