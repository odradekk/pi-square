import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type PiSquareConfig } from "../core/config";
import type { SubagentFeature } from "../subagents";
import { refreshGitSnapshot } from "./git.ts";
import { resolveModelMeta } from "./model.ts";
import { installStatusline, updateLastUsage } from "./statusline.ts";
import type { StatuslineState } from "./types.ts";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function syncCurrentModel(state: StatuslineState, ctx: ExtensionContext): void {
  const model = resolveModelMeta(ctx);
  state.currentModelId = model.id;
  state.currentModelName = model.name;
}

function applyFooter(
  state: StatuslineState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  subagents?: Pick<SubagentFeature, "getBackgroundJobs">,
): void {
  if (!ctx.hasUI) return;
  if (state.enabled) {
    installStatusline(ctx, pi, state, () => subagents?.getBackgroundJobs() ?? []);
  } else {
    state.tuiRef = null;
    ctx.ui.setFooter(undefined);
  }
}

function setEnabled(
  state: StatuslineState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  enabled: boolean,
  subagents?: Pick<SubagentFeature, "getBackgroundJobs">,
): void {
  if (state.enabled === enabled) {
    notify(ctx, `Status line: already ${enabled ? "on" : "off"}`, "info");
    return;
  }
  state.enabled = enabled;
  applyFooter(state, ctx, pi, subagents);
  notify(ctx, `Status line: ${enabled ? "on" : "off"}`, "info");
}

export default function registerStatusline(
  pi: ExtensionAPI,
  getConfig: () => PiSquareConfig,
  subagents?: Pick<SubagentFeature, "getBackgroundJobs" | "subscribeBackground">,
): void {
  const state: StatuslineState = {
    config: { ...DEFAULT_CONFIG.statusline },
    enabled: DEFAULT_CONFIG.statusline.enabled,
    currentModelId: "",
    currentModelName: "",
    lastUsage: null,
    tuiRef: null,
    activeShortcut: DEFAULT_CONFIG.statusline.shortcut,
    registeredShortcuts: new Set<string>(),
    cwd: "",
    git: { branch: null, dirty: false, staged: 0, unstaged: 0, untracked: 0 },
  };
  let unsubscribeBackground: (() => void) | undefined;

  function registerShortcut(shortcut: string): void {
    if (!shortcut || state.registeredShortcuts.has(shortcut)) return;
    state.registeredShortcuts.add(shortcut);
    pi.registerShortcut(shortcut as any, {
      description: "Toggle custom status line",
      handler: async (ctx) => {
        if (state.activeShortcut !== shortcut) return;
        setEnabled(state, ctx, pi, !state.enabled, subagents);
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    state.config = { ...getConfig().statusline };
    state.enabled = state.config.enabled;
    state.activeShortcut = state.config.shortcut;
    registerShortcut(state.activeShortcut);
    state.cwd = ctx.cwd;
    state.git = refreshGitSnapshot(ctx.cwd);
    syncCurrentModel(state, ctx);
    applyFooter(state, ctx, pi, subagents);
    unsubscribeBackground?.();
    unsubscribeBackground = subagents?.subscribeBackground(() => state.tuiRef?.requestRender());
  });

  pi.on("session_shutdown", async () => {
    unsubscribeBackground?.();
    unsubscribeBackground = undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    updateLastUsage(state, (event as any).message);
    state.git = refreshGitSnapshot(ctx.cwd);
    state.tuiRef?.requestRender();
  });

  pi.on("model_select", async (_event, ctx) => {
    syncCurrentModel(state, ctx);
    state.tuiRef?.requestRender();
  });

  pi.registerCommand("statusline", {
    description: "Toggle the custom status line, or set it directly: /statusline on | off",
    handler: async (args, ctx) => {
      const value = args?.trim().toLowerCase();
      if (!value) {
        setEnabled(state, ctx, pi, !state.enabled, subagents);
        return;
      }
      if (value === "on" || value === "off") {
        setEnabled(state, ctx, pi, value === "on", subagents);
        return;
      }
      notify(ctx, `Invalid status line value "${value}". Use on | off.`, "warning");
    },
  });
}
