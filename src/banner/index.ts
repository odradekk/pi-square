import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";

/**
 * The pi-square startup banner: a minimal π² arch mark, rendered via
 * ctx.ui.setHeader() so it replaces the built-in "π v<version>" header
 * in the TUI. Colors come from the active theme (accent for the mark,
 * muted/dim for the label and tagline) so the banner follows whatever
 * theme is currently selected.
 */
function buildBannerLines(theme: Theme): string[] {
  const arch = (text: string) => theme.fg("dim", text);
  const mark = (text: string) => theme.bold(theme.fg("accent", text));
  const label = (text: string) => theme.fg("muted", text);
  const tagline = (text: string) => theme.fg("dim", text);

  const top = `   ${arch("┌──────────────┐")}`;
  const row1 = `   ${arch("│  │        │  │")}    ${mark("π²")}`;
  const row2 = `   ${arch("│  │        │  │")}    ${label("pi-square")}`;
  const bottom = `   ${arch("└──┘        └──┘")}`;
  const foot = `                        ${tagline("unified local extension package for Pi")}`;

  return ["", top, row1, row2, bottom, foot, ""];
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
      render(_width: number): string[] {
        return buildBannerLines(theme);
      },
      invalidate() {},
    }));
  });
}
