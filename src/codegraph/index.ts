import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfirmationCoordinator } from "../core/confirmation";
import { getPackageRoot } from "../core/paths";
import { runCommand } from "../core/process";
import { resolveCodeGraphBinary } from "./binary";
import { createCodeGraphToolDefinition } from "./tool";

export function createCodeGraphDefinition(
  allowWrite = true,
  confirmations = new ConfirmationCoordinator(),
) {
  const packageRoot = getPackageRoot();
  return createCodeGraphToolDefinition({
    resolveBinary: () => Promise.resolve(resolveCodeGraphBinary(process.platform, process.arch, packageRoot)),
    runCommand,
    confirmations,
  }, allowWrite);
}

export default function registerCodeGraph(
  pi: ExtensionAPI,
  confirmations = new ConfirmationCoordinator(),
): void {
  pi.registerTool(createCodeGraphDefinition(true, confirmations) as any);
}
