import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfirmationCoordinator } from "../core/confirmation";
import { registerDocsTool } from "./tools/docs";
import { registerLibsTool } from "./tools/libs";
import { registerFetchTool } from "./tools/fetch";
import { registerParseTool } from "./tools/parse";
import { registerSearchTool } from "./tools/search";

export default function webTools(
  pi: ExtensionAPI,
  confirmations = new ConfirmationCoordinator(),
) {
  registerSearchTool(pi);
  registerFetchTool(pi);
  registerParseTool(pi, confirmations);
  registerLibsTool(pi);
  registerDocsTool(pi);
}
