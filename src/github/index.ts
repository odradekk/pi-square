import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { createGitHubToolDefinition } from "./tools";

export default function registerGitHub(pi: ExtensionAPI, runtime?: DisplayRuntimeProvider): void {
  const definition = createGitHubToolDefinition();
  pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
}
