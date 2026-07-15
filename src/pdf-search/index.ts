import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PdfTextCache } from "./cache";
import { createPdfSearchToolDefinition } from "./tool";

export { createPdfSearchToolDefinition } from "./tool";

export default function registerPdfSearch(pi: ExtensionAPI): void {
  const cache = new PdfTextCache();
  pi.registerTool(createPdfSearchToolDefinition({ cache }));
  pi.on("session_start", async () => {
    cache.clear();
  });
}
