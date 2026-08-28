import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAskUser from "./ask-user";
import registerAnchoredAutoRead from "./anchored-edit/auto-read";
import registerAnchoredReplace from "./anchored-edit/workspace-replace";
import registerBanner from "./banner";
import registerCodeGraph from "./codegraph";
import { DEFAULT_CONFIG, loadConfig } from "./core/config";
import { ConfirmationCoordinator } from "./core/confirmation";
import { emitDiagnostics } from "./core/diagnostics";
import registerDisplay, { DisplayController } from "./display";
import registerDisplayBuiltins from "./display/builtins";
import registerFooter from "./footer";
import registerGitHub from "./github";
import registerNotifications from "./notifications";
import registerPdfSearch from "./pdf-search";
import registerPromptManager from "./prompt-manager";
import registerShellTools from "./shell";
import registerShadowMinds from "./shadow-minds";
import registerSshTool from "./ssh";
import registerSubagents from "./subagents";
import registerTodo from "./todo";
import registerWebTools from "./web";

export default function piSquare(pi: ExtensionAPI): void {
  const display = new DisplayController(DEFAULT_CONFIG);
  const confirmations = new ConfirmationCoordinator();

  pi.on("session_start", async (_event, ctx) => {
    confirmations.reset("Parent Pi session changed");
    const loaded = loadConfig(ctx.cwd);
    display.startSession(loaded.config, ctx);
    emitDiagnostics(ctx, loaded.diagnostics);
  });

  pi.on("session_shutdown", async () => {
    confirmations.reset("Parent Pi session shutdown");
    display.dispose();
  });

  registerDisplay(pi, display);
  let anchoredReadAvailable = false;
  registerDisplayBuiltins(pi, display, (available) => { anchoredReadAvailable = available; });
  registerAnchoredReplace(
    pi,
    () => display.config,
    () => display.runtime,
    () => anchoredReadAvailable,
  );
  registerAnchoredAutoRead(
    pi,
    () => display.config,
    () => anchoredReadAvailable,
  );

  const notifications = registerNotifications(pi);
  registerAskUser(pi, notifications, () => display.runtime);
  registerTodo(pi, () => display.runtime);
  registerPdfSearch(pi, () => display.runtime);
  registerCodeGraph(pi, confirmations, () => display.runtime);
  registerWebTools(pi, confirmations, () => display.runtime);
  registerGitHub(pi, () => display.runtime);
  const subagents = registerSubagents(pi, () => display.runtime, () => display.config);
  registerShadowMinds(pi, () => display.config);
  registerFooter(pi);
  registerShellTools(pi, {}, () => display.runtime);
  registerSshTool(pi, () => display.config, confirmations, () => display.runtime);
  registerBanner(pi, () => display.config);
  registerPromptManager(pi, subagents);
}
