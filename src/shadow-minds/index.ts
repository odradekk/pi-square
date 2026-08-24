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
import { sanitizeDisplayLine, sanitizeDisplayText } from "../display/sanitize";
import { getAgentPath } from "../core/paths";
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildShadowConfigGuide,
  renderShadowConfigGuide,
  SHADOW_CONFIG_GUIDE_TYPE,
} from "./config-guide";
import {
  discoverShadowDefinitions,
  previewShadowDefinition,
  previewShadowDefinitionDeletion,
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
  const sanitized = sanitizeDisplayLine(message);
  return sanitized.length <= MAX_NOTIFY_CHARS ? sanitized : `${sanitized.slice(0, MAX_NOTIFY_CHARS - 1)}…`;
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
      const within = (dir: string): boolean => {
        const rel = relative(resolve(dir), resolve(filePath));
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      };
      if (within(getAgentPath("shadow-minds"))) return "agent";
      try {
        if (within(shadowDefinitionScopeDir("project", ctx.cwd))) return "project";
      } catch {
        // Project scope resolution is unavailable; only the agent scope maps.
      }
      return undefined;
    },
    async overlaySnapshot(scope, id, filePath) {
      return readShadowOverlaySnapshot(scope, ctx.cwd, id, {
        projectTrusted: ctx.isProjectTrusted(),
        filePath,
      });
    },
    preview(scope, fields, expectedContextFingerprint, reviewedFilePath) {
      try {
        const content = serializeShadowDefinition(fields);
        const filePath = reviewedFilePath ?? shadowOverlayFilePath(scope, ctx.cwd, fields.id);
        const preview = previewShadowDefinition(ctx.cwd, {
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          filePath,
          content,
          expectedContextFingerprint,
        });
        return {
          content,
          filePath,
          definition: preview.definition,
          errors: preview.errors,
          contextFingerprint: preview.contextFingerprint,
        };
      } catch (error) {
        return {
          content: "",
          filePath: "",
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },
    previewDelete(scope, _id, filePath, expectedContextFingerprint) {
      try {
        const preview = previewShadowDefinitionDeletion(ctx.cwd, {
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          filePath,
          expectedContextFingerprint,
        });
        return {
          definition: preview.definition,
          errors: preview.errors,
          contextFingerprint: preview.contextFingerprint,
        };
      } catch (error) {
        return { errors: [error instanceof Error ? error.message : String(error)] };
      }
    },
    async approve(request: ShadowApprovalRequest): Promise<boolean> {
      if (!ctx.hasUI) return false;
      return confirmations.run(undefined, (signal) => ctx.ui.confirm(
        sanitizeDisplayLine(request.title),
        sanitizeDisplayText([...request.lines, "", request.destructive
          ? "This permanently changes Shadow definition files on disk."
          : "Declining performs no write."].join("\n")),
        { signal },
      ));
    },
    async save(scope, fields, reviewFilePath, reviewFingerprint, reviewContextFingerprint, reviewIdentity) {
      try {
        const result = await writeShadowOverlay({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          fields,
          reviewFilePath,
          reviewFingerprint,
          reviewContextFingerprint,
          reviewIdentity,
        });
        state.refresh(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(`shadow-minds: saved ${fields.id} ${scope} overlay (${result.filePath})`, "info");
        return { ok: true, message: `Saved ${fields.id} ${scope} overlay.` };
      } catch (error) {
        const outcome = outcomeOf(error, "saving the overlay failed");
        ctx.ui.notify(`shadow-minds: ${outcome.message}`, "warning");
        return outcome;
      }
    },
    async deleteOverlay(scope, id, filePath, reviewFingerprint, reviewContextFingerprint, reviewIdentity) {
      try {
        const result = await deleteShadowOverlay({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
          scope,
          id,
          filePath,
          reviewFingerprint,
          reviewContextFingerprint,
          reviewIdentity,
        });
        state.refresh(ctx.cwd, ctx.isProjectTrusted());
        const message = result.removed
          ? `Deleted the ${id} ${scope} overlay.`
          : `No ${id} ${scope} overlay existed anymore.`;
        ctx.ui.notify(`shadow-minds: ${message}`, "info");
        return { ok: true, message };
      } catch (error) {
        const outcome = outcomeOf(error, "deleting the overlay failed");
        ctx.ui.notify(`shadow-minds: ${outcome.message}`, "warning");
        return outcome;
      }
    },
  };
}

export default function registerShadowMinds(
  pi: ExtensionAPI,
  confirmations: ConfirmationCoordinator = new ConfirmationCoordinator(),
  config?: () => PiSquareConfig,
): ShadowMindsState {
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

  pi.registerMessageRenderer(SHADOW_CONFIG_GUIDE_TYPE, renderShadowConfigGuide);

  pi.registerCommand("shadow", {
    description: "Manage layered Shadow definitions and overlays, or ask Pi to help configure one.",
    handler: async (args, ctx) => {
      const rawRequest = String(args ?? "");
      const request = rawRequest.trim();
      state.refresh(ctx.cwd, ctx.isProjectTrusted());
      if (request) {
        const guide = buildShadowConfigGuide(state.registry, ctx.cwd);
        pi.sendMessage({
          customType: SHADOW_CONFIG_GUIDE_TYPE,
          content: guide.content,
          display: true,
          details: guide.details,
        }, { deliverAs: "followUp" });
        pi.sendUserMessage(rawRequest, { deliverAs: "followUp" });
        return;
      }
      if (!ctx.hasUI) return;
      await openShadowManager(ctx, state.managerSnapshot(), makeServices(state, ctx, confirmations));
    },
  });

  // The shared session coordinator is reset by the extension entry on
  // session start and shutdown; a private default stays unreset here.
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

export const __testables = { makeServices };
