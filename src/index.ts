import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAskUser from "./ask-user";
import registerBanner from "./banner";
import { DEFAULT_CONFIG, loadConfig, type PiSquareConfig } from "./core/config";
import { emitDiagnostics } from "./core/diagnostics";
import registerNotifications from "./notifications";
import registerPromptManager from "./prompt-manager";
import registerSchemeSandbox from "./scheme";
import registerSearchTools from "./search";
import registerShellTools from "./shell";
import registerStatusline from "./statusline";
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
  registerWebTools(pi);
  const subagents = registerSubagents(pi);
  registerSchemeSandbox(pi);
  registerShellTools(pi);
  registerStatusline(pi, () => config);
  registerBanner(pi, () => config);
  registerPromptManager(pi, subagents);
}
