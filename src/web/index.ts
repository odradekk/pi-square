import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDocsTool } from "./tools/docs";
import { registerLibsTool } from "./tools/libs";
import { registerFetchTool } from "./tools/fetch";
import { registerSearchTool } from "./tools/search";

export default function webTools(pi: ExtensionAPI) {
  registerSearchTool(pi);
  registerFetchTool(pi);
  registerLibsTool(pi);
  registerDocsTool(pi);
}
