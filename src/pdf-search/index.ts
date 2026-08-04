import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { decorateInternalTool } from "../display/internal-adapters";
import { PdfTextCache } from "./cache";
import { createPdfSearchToolDefinition } from "./tool";

export { createPdfSearchToolDefinition } from "./tool";

export default function registerPdfSearch(
  pi: ExtensionAPI,
  runtime?: DisplayRuntimeProvider,
): void {
  const cache = new PdfTextCache();
  const definition = createPdfSearchToolDefinition({ cache });
  pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
  pi.on("session_start", async () => {
    cache.clear();
  });
}
