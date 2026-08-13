import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { decorateInternalTool } from "../display/internal-adapters";
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

export default function registerSearchTools(
  pi: ExtensionAPI,
  runtime?: DisplayRuntimeProvider,
): void {
  for (const definition of createSearchToolDefinitions()) {
    pi.registerTool((runtime ? decorateInternalTool(definition as any, runtime) : definition) as any);
  }
}
