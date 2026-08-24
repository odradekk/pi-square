/**
 * Shadow Minds feature entry (odradekk/pi-square#149, slice #153).
 *
 * The runtime itself is disabled by default and arrives with the later
 * slices; this entry owns the definition registry state, refreshes it on
 * session start from the canonical workspace and project-trust result, and
 * registers the read-only `/shadow` manager. It performs no model calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiSquareConfig } from "../core/config";
import { discoverShadowDefinitions, type ShadowDefinitionRegistry } from "./definitions";
import { openShadowManager, snapshot, type ShadowManagerSnapshot } from "./manager";

export interface ShadowMindsState {
  registry: ShadowDefinitionRegistry;
  cwd: string;
  projectTrusted: boolean;
  refresh(cwd: string, projectTrusted: boolean): void;
  managerSnapshot(): ShadowManagerSnapshot;
}

export default function registerShadowMinds(pi: ExtensionAPI, config?: () => PiSquareConfig): ShadowMindsState {
  const state: ShadowMindsState = {
    registry: { definitions: [], invalid: [], diagnostics: [] },
    cwd: process.cwd(),
    projectTrusted: false,
    refresh(cwd: string, projectTrusted: boolean): void {
      state.cwd = cwd;
      state.projectTrusted = projectTrusted;
      state.registry = discoverShadowDefinitions(cwd, { projectTrusted });
    },
    managerSnapshot(): ShadowManagerSnapshot {
      const effective = config?.().shadowMinds;
      return snapshot(state.registry, state.projectTrusted, effective);
    },
  };

  pi.registerCommand("shadow", {
    description: "Inspect layered Shadow definitions, provenance, and diagnostics (read-only).",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await openShadowManager(ctx, state.managerSnapshot());
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.refresh(ctx.cwd, ctx.isProjectTrusted());
    if (ctx.hasUI && state.registry.diagnostics.length > 0) {
      const suffix = state.registry.diagnostics.length > 1
        ? ` (+${state.registry.diagnostics.length - 1} more)`
        : "";
      ctx.ui.notify(`shadow-minds: ${state.registry.diagnostics[0]!.message}${suffix}`, "warning");
    }
  });

  return state;
}
