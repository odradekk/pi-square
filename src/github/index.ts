import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { createGitHubToolDefinitions } from "./tools";

export default function registerGitHub(pi: ExtensionAPI, runtime?: DisplayRuntimeProvider): void {
  for (const definition of createGitHubToolDefinitions()) {
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  }
}
