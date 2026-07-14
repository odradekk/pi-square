import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PiSquareConfig } from "../core/config";
import { collectEnhancedFooterSnapshot } from "./data";
import { renderEnhancedFooter } from "./render";

function installEnhancedFooter(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose() {
        unsubscribeBranch();
      },
      invalidate() {},
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        try {
          return renderEnhancedFooter(
            theme,
            safeWidth,
            collectEnhancedFooterSnapshot(ctx, pi, footerData),
          );
        } catch {
          const project = basename(ctx.cwd) || ctx.cwd || "project";
          return [
            truncateToWidth(theme.fg("accent", project), safeWidth, theme.fg("dim", "...")),
            truncateToWidth(
              theme.fg("error", "footer unavailable")
                + theme.fg("dim", " · set footer.mode to native"),
              safeWidth,
              theme.fg("dim", "..."),
            ),
          ];
        }
      },
    };
  });
}

export default function registerFooter(
  pi: ExtensionAPI,
  getConfig: () => PiSquareConfig,
): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (getConfig().footer.mode === "native") {
      ctx.ui.setFooter(undefined);
      return;
    }
    installEnhancedFooter(ctx, pi);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
