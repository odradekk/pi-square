import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGitHubTools } from "./tools";

export default function registerGitHub(pi: ExtensionAPI): void {
  registerGitHubTools(pi);
}
