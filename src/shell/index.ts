import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { isWindowsPlatform } from "./platform";
import { createPwshToolDefinition, getPwshProbe } from "./tools/pwsh";
import type { PwshProbe } from "./spawn";

interface ShellRegistrationOptions {
  platform?: NodeJS.Platform;
  createPwshDefinition?: () => ToolDefinition<any, any, any>;
  probePwsh?: () => Promise<PwshProbe>;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function safeDiagnostic(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, 500) || "PowerShell was not found";
}

export default function registerShellTools(
  pi: ExtensionAPI,
  options: ShellRegistrationOptions = {},
  runtime?: DisplayRuntimeProvider,
): void {
  const platform = options.platform ?? process.platform;
  const windows = isWindowsPlatform(platform);

  if (windows) {
    const definition = options.createPwshDefinition?.() ?? createPwshToolDefinition();
    pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
    pi.on("session_start", async (_event, ctx) => {
      const active = pi.getActiveTools();
      const allowed = active.filter((name) => name !== "bash");
      if (!sameNames(active, allowed)) pi.setActiveTools(allowed);

      try {
        const probe = await (options.probePwsh?.() ?? getPwshProbe());
        if (!probe.available && ctx.hasUI) {
          ctx.ui.notify(`pwsh unavailable: ${safeDiagnostic(probe.reason)}`, "warning");
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(`pwsh probe failed: ${safeDiagnostic(error instanceof Error ? error.message : error)}`, "warning");
        }
      }
    });
  }

  pi.on("tool_call", (event) => {
    if (windows && event.toolName === "bash") {
      return { block: true, reason: "bash is unavailable on Windows; use pwsh instead" };
    }
    if (!windows && event.toolName === "pwsh") {
      return { block: true, reason: "pwsh is available only on Windows; use bash instead" };
    }
    return undefined;
  });
}
