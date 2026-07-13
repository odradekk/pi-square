import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
