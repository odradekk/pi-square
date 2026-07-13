// Resolve a bundled binary path for one of the six supported platform/arch pairs.
//
// The resolver never inspects PATH, hashes, or the network. It derives the
// file location from injected platform/arch/root, checks existence, and
// returns an absolute path. A missing or unsupported target throws.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ToolName } from "./contracts";

const SUPPORTED_TARGETS: ReadonlySet<string> = new Set([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]);

export function resolveBundledBinary(
  tool: ToolName,
  platform: string,
  arch: string,
  packageRoot: string,
): string {
  const targetKey = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.has(targetKey)) {
    throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
  }

  const binaryName = platform === "win32" ? `${tool}.exe` : tool;
  const candidate = resolve(join(packageRoot, "bin", targetKey, binaryName));

  if (!existsSync(candidate)) {
    throw new Error(`Bundled ${tool} binary not found at ${candidate}`);
  }

  return candidate;
}
