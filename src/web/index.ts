import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfirmationCoordinator } from "../core/confirmation";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { createDocsToolDefinition } from "./tools/docs";
import { createLibsToolDefinition } from "./tools/libs";
import { createFetchToolDefinition } from "./tools/fetch";
import { createParseToolDefinition } from "./tools/parse";
import { createSearchToolDefinition } from "./tools/search";

export default function webTools(
  pi: ExtensionAPI,
  confirmations = new ConfirmationCoordinator(),
  runtime?: DisplayRuntimeProvider,
) {
  const definitions = [
    createSearchToolDefinition(),
    createFetchToolDefinition(),
    createParseToolDefinition({ confirmations }),
    createLibsToolDefinition(),
    createDocsToolDefinition(),
  ];
  for (const definition of definitions) {
    pi.registerTool(runtime ? decorateInternalTool(definition as any, runtime) : definition as any);
  }
}
