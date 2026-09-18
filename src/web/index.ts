import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { createLibraryDocsToolDefinition } from "./tools/library-docs";
import { createLibrarySearchToolDefinition } from "./tools/library-search";
import { createWebFetchToolDefinition } from "./tools/web-fetch";
import { createWebSearchToolDefinition } from "./tools/web-search";

export default function webTools(
  pi: ExtensionAPI,
  runtime?: DisplayRuntimeProvider,
) {
  const definitions = [
    createWebSearchToolDefinition(),
    createWebFetchToolDefinition(),
    createLibrarySearchToolDefinition(),
    createLibraryDocsToolDefinition(),
  ];
  for (const definition of definitions) {
    pi.registerTool(runtime ? decorateInternalTool(definition as any, runtime) : definition as any);
  }
}
