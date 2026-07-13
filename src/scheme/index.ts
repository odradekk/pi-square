import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { verifyWasmIntegrity } from "./integrity";
import { registerSchemeTool } from "./tools/scheme";

function warn(ctx: any, pi: any, message: string): void {
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, "warning");
    return;
  }

  if (typeof pi?.log === "function") {
    pi.log("warn", message);
    return;
  }

  console.warn(message);
}

export default function registerSchemeSandbox(pi: ExtensionAPI): void {
  registerSchemeTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    const check = verifyWasmIntegrity();
    if (!check.ok) {
      warn(ctx, pi, `Scheme WASM integrity check failed: ${check.failures.join(", ")}. scheme tool may not work correctly.`);
    }
  });
}
