import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { DisplayRuntime, installGlobalDisplayRuntime } from "./runtime";
import { registerDisplayManager } from "./manager";

export class DisplayController {
  private currentConfig: PiSquareConfig;
  private currentRuntime: DisplayRuntime;
  private currentDiagnostics: readonly string[] = [];

  constructor(config: PiSquareConfig) {
    this.currentConfig = structuredClone(config);
    this.currentRuntime = new DisplayRuntime(this.currentConfig);
    installGlobalDisplayRuntime(this.currentRuntime);
  }

  get config(): PiSquareConfig {
    return this.currentConfig;
  }

  get runtime(): DisplayRuntime {
    return this.currentRuntime;
  }

  get diagnostics(): readonly string[] {
    return this.currentDiagnostics;
  }

  setDiagnostics(diagnostics: readonly string[]): void {
    this.currentDiagnostics = diagnostics.map((diagnostic) => String(diagnostic)).slice(0, 8);
  }

  startSession(config: PiSquareConfig, ctx: Pick<ExtensionContext, "mode">): void {
    this.currentRuntime.dispose();
    this.currentConfig = structuredClone(config);
    this.currentRuntime = new DisplayRuntime(this.currentConfig, {
      environment: {
        isTTY: ctx.mode === "tui" && Boolean(process.stdout.isTTY),
        term: process.env.TERM,
        ci: process.env.CI === "true" || process.env.CI === "1",
        test: process.env.NODE_ENV === "test" || process.env.PI_SQUARE_TEST === "1",
      },
    });
    installGlobalDisplayRuntime(this.currentRuntime);
  }

  applyConfig(config: PiSquareConfig, ctx: Pick<ExtensionContext, "mode">): void {
    this.currentConfig = structuredClone(config);
    this.currentRuntime.updateConfig(this.currentConfig, {
      isTTY: ctx.mode === "tui" && Boolean(process.stdout.isTTY),
      term: process.env.TERM,
      ci: process.env.CI === "true" || process.env.CI === "1",
      test: process.env.NODE_ENV === "test" || process.env.PI_SQUARE_TEST === "1",
    });
  }

  dispose(): void {
    this.currentDiagnostics = [];
    this.currentRuntime.dispose();
  }
}

export default function registerDisplay(
  pi: ExtensionAPI,
  controller: DisplayController,
): void {
  registerDisplayManager(pi, controller);
}
