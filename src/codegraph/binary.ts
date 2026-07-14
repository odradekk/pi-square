import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { CodeGraphBinary } from "./contracts";

const CODEGRAPH_VERSION = "1.4.1";
const CODEGRAPH_PACKAGES: Readonly<Record<string, string>> = {
  "linux-x64": "@colbymchenry/codegraph-linux-x64",
  "linux-arm64": "@colbymchenry/codegraph-linux-arm64",
  "darwin-x64": "@colbymchenry/codegraph-darwin-x64",
  "darwin-arm64": "@colbymchenry/codegraph-darwin-arm64",
  "win32-x64": "@colbymchenry/codegraph-win32-x64",
  "win32-arm64": "@colbymchenry/codegraph-win32-arm64",
};

export function codeGraphPlatformPackage(platform: string, arch: string): string {
  const packageName = CODEGRAPH_PACKAGES[`${platform}-${arch}`];
  if (!packageName) throw new Error(`Unsupported CodeGraph platform/arch: ${platform}/${arch}`);
  return packageName;
}

export function resolveCodeGraphBinary(
  platform: string,
  arch: string,
  packageRoot: string,
): CodeGraphBinary {
  const packageName = codeGraphPlatformPackage(platform, arch);
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromPackage.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `CodeGraph platform package ${packageName}@${CODEGRAPH_VERSION} is not installed; reinstall with optional dependencies enabled`,
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (packageJson.version !== CODEGRAPH_VERSION) {
    throw new Error(
      `CodeGraph platform package ${packageName} has version ${String(packageJson.version)}; expected ${CODEGRAPH_VERSION}`,
    );
  }

  const root = dirname(packageJsonPath);
  const command = join(root, platform === "win32" ? "node.exe" : "node");
  const entry = join(root, "lib", "dist", "bin", "codegraph.js");
  if (!existsSync(command)) throw new Error(`CodeGraph bundled runtime not found at ${command}`);
  if (!existsSync(entry)) throw new Error(`CodeGraph CLI entry not found at ${entry}`);
  return {
    command,
    prefixArgs: ["--liftoff-only", entry],
    packageName,
    version: CODEGRAPH_VERSION,
  };
}
