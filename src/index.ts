import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAskUser from "./ask-user";
import registerBanner from "./banner";
import registerCodeGraph from "./codegraph";
import { DEFAULT_CONFIG, loadConfig, type PiSquareConfig } from "./core/config";
import { emitDiagnostics } from "./core/diagnostics";
import registerFooter from "./footer";
import registerGitHub from "./github";
import registerNotifications from "./notifications";
import registerPdfSearch from "./pdf-search";
import registerPromptManager from "./prompt-manager";
import registerSchemeSandbox from "./scheme";
import registerSearchTools from "./search";
import registerShellTools from "./shell";
import registerSubagents from "./subagents";
import registerTime from "./time";
import registerTodo from "./todo";
import registerWebTools from "./web";

export default function piSquare(pi: ExtensionAPI): void {
  let config = structuredClone(DEFAULT_CONFIG) as PiSquareConfig;

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    emitDiagnostics(ctx, loaded.diagnostics);
  });

  const notifications = registerNotifications(pi);
  registerAskUser(pi, notifications);
  registerTodo(pi);
  registerTime(pi);
  registerSearchTools(pi);
  registerPdfSearch(pi);
  registerCodeGraph(pi);
  registerWebTools(pi);
  registerGitHub(pi);
  const subagents = registerSubagents(pi);
  registerFooter(pi, () => config);
  registerSchemeSandbox(pi);
  registerShellTools(pi);
  registerBanner(pi, () => config);
  registerPromptManager(pi, subagents);
}
