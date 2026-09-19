import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { FooterSnapshotProvider } from "./data";
import { renderEnhancedFooter } from "./render";
import { bindFooterRender, invalidateFooterTrailer, renderFooterTrailer } from "./trailer";

function installEnhancedFooter(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
): void {
  const provider = new FooterSnapshotProvider();
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
    const unbindRender = bindFooterRender(() => tui.requestRender());
    return {
      dispose() {
        unsubscribeBranch();
        unbindRender();
      },
      // The footer's own rows hold no cache, but the trailer's producer may.
      invalidate() {
        invalidateFooterTrailer();
      },
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        let lines: string[];
        try {
          lines = renderEnhancedFooter(
            theme,
            safeWidth,
            provider.snapshot(ctx, pi, footerData),
          );
        } catch {
          const project = basename(ctx.cwd) || ctx.cwd || "project";
          lines = [
            truncateToWidth(theme.fg("accent", project), safeWidth, theme.fg("dim", "...")),
            truncateToWidth(theme.fg("error", "! footer unavailable"), safeWidth, theme.fg("dim", "...")),
          ];
        }
        const trailer = renderFooterTrailer(theme, safeWidth, Math.max(1, tui.terminal.rows));
        return trailer.length === 0 ? lines : [...lines, "", ...trailer];
      },
    };
  });
}

export default function registerFooter(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    installEnhancedFooter(ctx, pi);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
