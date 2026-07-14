import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

interface SgPlatformPackage {
  packageName: string;
  binaryName: string;
}

const SG_PACKAGES: Readonly<Record<string, string>> = {
  "linux-x64": "@ast-grep/cli-linux-x64-gnu",
  "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
  "darwin-x64": "@ast-grep/cli-darwin-x64",
  "darwin-arm64": "@ast-grep/cli-darwin-arm64",
  "win32-x64": "@ast-grep/cli-win32-x64-msvc",
  "win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
};

export function sgPlatformPackage(platform: string, arch: string): SgPlatformPackage {
  const packageName = SG_PACKAGES[`${platform}-${arch}`];
  if (!packageName) {
    throw new Error(`Unsupported ast-grep platform/arch: ${platform}/${arch}`);
  }
  return {
    packageName,
    binaryName: platform === "win32" ? "ast-grep.exe" : "ast-grep",
  };
}

export function resolveSgBinary(
  platform: string,
  arch: string,
  packageRoot: string,
): string {
  const target = sgPlatformPackage(platform, arch);
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  let packageJson: string;
  try {
    packageJson = requireFromPackage.resolve(`${target.packageName}/package.json`);
  } catch {
    throw new Error(
      `ast-grep native package ${target.packageName} is not installed; reinstall with optional dependencies enabled`,
    );
  }
  const candidate = resolve(dirname(packageJson), target.binaryName);
  if (!existsSync(candidate)) {
    throw new Error(`ast-grep binary not found at ${candidate}`);
  }
  return candidate;
}
