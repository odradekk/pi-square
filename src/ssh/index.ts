import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { ConfirmationCoordinator } from "../core/confirmation";
import { SshSessionManager } from "./manager";
import { createSshToolController } from "./tool";

export default function registerSshTool(
  pi: ExtensionAPI,
  getConfig: () => PiSquareConfig,
  confirmations = new ConfirmationCoordinator(),
): void {
  const manager = new SshSessionManager();
  const controller = createSshToolController(manager, confirmations);
  pi.registerTool(controller.definition);

  pi.on("session_start", async () => {
    manager.reset("Parent Pi session changed");
    manager.configure(getConfig().ssh);
    controller.resetApprovals();
  });

  pi.on("session_shutdown", async () => {
    manager.dispose("Parent Pi session shutdown");
    controller.resetApprovals();
  });
}

export { createSshToolController, createSshToolDefinition } from "./tool";
export { SshSessionManager } from "./manager";
