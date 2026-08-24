/**
 * Shadow Minds feature entry (odradekk/pi-square#149, slices #153–#154).
 *
 * The runtime itself is disabled by default and arrives with the later
 * slices; this entry owns the definition registry state, refreshes it on
 * session start from the canonical workspace and project-trust result,
 * registers the `/shadow` manager with its safe overlay write services, and
 * provides the parameterized `/shadow <request>` Config Guide flow. Manager
 * approvals route through the session FIFO confirmation coordinator; every
 * persistent write executes through the safe overlay writer. It performs no
 * model calls on its own.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { ConfirmationCoordinator } from "../core/confirmation";
import type { PiSquareConfig } from "../core/config";
import { getAgentPath } from "../core/paths";
import {
  buildShadowConfigGuide,
  renderShadowConfigGuide,
  SHADOW_CONFIG_GUIDE_TYPE,
} from "./config-guide";
import {
  discoverShadowDefinitions,
  previewShadowDefinition,
  shadowDefinitionScopeDir,
  type ShadowDefinitionRegistry,
} from "./definitions";
import {
  openShadowManager,
  snapshot,
  type ShadowApprovalRequest,
  type ShadowManagerServices,
  type ShadowManagerSnapshot,
} from "./manager";
import {
  ShadowOverlayError,
  deleteShadowOverlay,
  readShadowOverlaySnapshot,
  shadowOverlayFilePath,
  writeShadowOverlay,
} from "./overlays";
import { serializeShadowDefinition } from "./serialize";

export interface ShadowMindsState {
  registry: ShadowDefinitionRegistry;
  cwd: string;
  projectTrusted: boolean;
  refresh(cwd: string, projectTrusted: boolean): void;
  managerSnapshot(): ShadowManagerSnapshot;
}

const MAX_NOTIFY_CHARS = 400;

function notifyText(message: string): string {
  return message.length <= MAX_NOTIFY_CHARS ? message : `${message.slice(0, MAX_NOTIFY_CHARS - 1)}…`;
}

function outcomeOf(error: unknown, fallbackPrefix: string) {
  if (error instanceof ShadowOverlayError) {
    if (error.code === "SHADOW_STALE_REVIEW") {
      return {
        ok: false,
        message: notifyText(`The overlay changed since it was reviewed; nothing was written. Reopen /shadow and review the current file.`),
      };
    }
    return { ok: false, message: notifyText(`${fallbackPrefix}: ${error.message}`) };
  }
  return { ok: false, message: notifyText(`${fallbackPrefix}: ${error instanceof Error ? error.message : String(error)}`) };
}

/** Builds the manager write services against one command invocation. */
function makeServices(
  state: ShadowMindsState,
  ctx: ExtensionCommandContext,
  confirmations: ConfirmationCoordinator,
): ShadowManagerServices {
  return {
    refresh(): ShadowManagerSnapshot {
      state.refresh(ctx.cwd, ctx.isProjectTrusted());
      return state.managerSnapshot();
    },
    scopeOf(filePath: string): "agent" | "project" | undefined {
      const candidates = [
        { scope: "agent" as const, dir: getAgentPath("shadow-minds") },
        { scope: "project" as const, dir: shadowDefinitionScopeDir("project", ctx.cwd) },
      ];
      for (const candidate of candidates) {
        try {
          if (filePath === shadowOverlayFilePath(candidate.scope, ctx.cwd, filePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? "")) {
            return candidate.scope;
          }
        } catch {
          // Scope resolution is best-effort mapping for menu labels.
        }
      }
      return undefined;
    },
    async overlaySnapshot(scope, id) {
      return readShadowOverlaySnapshot(scope, ctx.cwd, id, { projectTrusted: ctx.isProjectTrusted() });
    },
    preview(scope, fields) {
      try {
        const content = serializeShadowDefinition(fields);
        const filePath = shadowOverlayFilePath(scope, ctx.cwd, fields.id);
        const preview = previewShadowDefinition(ctx.cwd, {
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          filePath,
          content,
        });
        return { content, filePath, definition: preview.definition, errors: preview.errors };
      } catch (error) {
        return {
          content: "",
          filePath: "",
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },
    async approve(request: ShadowApprovalRequest): Promise<boolean> {
      if (!ctx.hasUI) return false;
      return confirmations.run(undefined, (signal) => ctx.ui.confirm(
        request.title,
        [...request.lines, "", request.destructive
          ? "This permanently changes Shadow definition files on disk."
          : "Declining performs no write."].join("\n"),
        { signal },
      ));
    },
    async save(scope, fields, reviewFingerprint) {
      try {
        const result = await writeShadowOverlay({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          fields,
          reviewFingerprint,
        });
        state.refresh(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(`shadow-minds: saved ${fields.id} ${scope} overlay (${result.filePath})`, "info");
        return { ok: true, message: `Saved ${fields.id} ${scope} overlay.` };
      } catch (error) {
        const outcome = outcomeOf(error, "saving the overlay failed");
        ctx.ui.notify(`shadow-minds: ${outcome.message}`, outcome.ok ? "info" : "warning");
        return outcome;
      }
    },
    async deleteOverlay(scope, id, reviewFingerprint) {
      try {
        const result = await deleteShadowOverlay({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          id,
          reviewFingerprint,
        });
        state.refresh(ctx.cwd, ctx.isProjectTrusted());
        const message = result.removed
          ? `Deleted the ${id} ${scope} overlay.`
          : `No ${id} ${scope} overlay existed anymore.`;
        ctx.ui.notify(`shadow-minds: ${message}`, "info");
        return { ok: true, message };
      } catch (error) {
        const outcome = outcomeOf(error, "deleting the overlay failed");
        ctx.ui.notify(`shadow-minds: ${outcome.message}`, outcome.ok ? "info" : "warning");
        return outcome;
      }
    },
  };
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

  const confirmations = new ConfirmationCoordinator();

  pi.registerMessageRenderer(SHADOW_CONFIG_GUIDE_TYPE, renderShadowConfigGuide);

  pi.registerCommand("shadow", {
    description: "Manage layered Shadow definitions and overlays, or ask Pi to help configure one.",
    handler: async (args, ctx) => {
      const request = String(args ?? "").trim();
      state.refresh(ctx.cwd, ctx.isProjectTrusted());
      if (request) {
        const guide = buildShadowConfigGuide(state.registry, ctx.cwd);
        pi.sendMessage({
          customType: SHADOW_CONFIG_GUIDE_TYPE,
          content: guide.content,
          display: true,
          details: guide.details,
        }, { deliverAs: "followUp" });
        pi.sendUserMessage(request, { deliverAs: "followUp" });
        return;
      }
      if (!ctx.hasUI) return;
      await openShadowManager(ctx, state.managerSnapshot(), makeServices(state, ctx, confirmations));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    confirmations.reset("Shadow Minds session start");
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

export const __testables = { makeServices };
