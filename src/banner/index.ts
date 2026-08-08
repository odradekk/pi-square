import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { padVisible } from "../display/layout";
import { sanitizeDisplayLine, truncateCodePoints } from "../display/sanitize";

let displayDiagnostic: string | undefined;

export function setBannerDisplayDiagnostic(diagnostic: string | undefined): void {
  displayDiagnostic = diagnostic
    ? truncateCodePoints(sanitizeDisplayLine(diagnostic), 500)
    : undefined;
}

function buildBannerLines(theme: Theme, width: number): string[] {
  const safe = Math.max(1, width);
  const rail = theme.fg("success", "✓");
  const identity = theme.fg("toolTitle", "π² pi-square");
  const lines = [
    padVisible(`${rail} ${identity}`, safe),
  ];
  if (displayDiagnostic) {
    lines.push(padVisible(`${theme.fg("warning", "!")} ${theme.fg("warning", displayDiagnostic)}`, safe));
  }
  return lines;
}

export default function registerBanner(
  pi: ExtensionAPI,
  getConfig: () => PiSquareConfig,
): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!getConfig().banner.enabled) {
      ctx.ui.setHeader(undefined);
      return;
    }
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return buildBannerLines(theme, width);
      },
      invalidate() {},
    }));
  });
}
