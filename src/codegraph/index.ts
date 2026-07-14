import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getPackageRoot } from "../core/paths";
import { runCommand } from "../core/process";
import { resolveCodeGraphBinary } from "./binary";
import { createCodeGraphToolDefinition } from "./tool";

export function createCodeGraphDefinition(allowWrite = true) {
  const packageRoot = getPackageRoot();
  return createCodeGraphToolDefinition({
    resolveBinary: () => Promise.resolve(resolveCodeGraphBinary(process.platform, process.arch, packageRoot)),
    runCommand,
  }, allowWrite);
}

export default function registerCodeGraph(pi: ExtensionAPI): void {
  pi.registerTool(createCodeGraphDefinition(true) as any);
}
