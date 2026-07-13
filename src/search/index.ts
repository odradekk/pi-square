import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPackageRoot } from "../core/paths";
import { resolveBundledBinary } from "./binary";
import { runCommand } from "./runner";
import { createFdToolDefinition } from "./tools/fd";
import { createRgToolDefinition } from "./tools/rg";

export function createSearchToolDefinitions() {
  const packageRoot = getPackageRoot();
  return [
    createRgToolDefinition({
      resolveBinary: () => Promise.resolve(resolveBundledBinary("rg", process.platform, process.arch, packageRoot)),
      runCommand,
    }),
    createFdToolDefinition({
      resolveBinary: () => Promise.resolve(resolveBundledBinary("fd", process.platform, process.arch, packageRoot)),
      runCommand,
    }),
  ] as const;
}

export default function registerSearchTools(pi: ExtensionAPI): void {
  for (const definition of createSearchToolDefinitions()) pi.registerTool(definition as any);
}
