import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPwshTool } from "./tools/pwsh";

export default function registerShellTools(pi: ExtensionAPI): void {
  registerPwshTool(pi);
}
