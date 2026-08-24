/**
 * Shadow Minds feature entry (odradekk/pi-square#149, slices #153–#155).
 *
 * This entry owns the definition registry state, refreshes it on session
 * start from the canonical workspace and project-trust result, registers
 * the `/shadow` manager with its safe overlay write services, and provides
 * the parameterized `/shadow <request>` Config Guide flow. The session
 * runtime executes manual no-tool trials through the shared one-time
 * child-session executor seam: every run freezes the parent core, trusted
 * project rules, and canonical working directory from the parent's current
 * prompt options at activation, and composes the versioned Shadow SYSTEM and
 * reference-only trajectory from that snapshot. Manager approvals route through the
 * session FIFO confirmation coordinator; every persistent write executes
 * through the safe overlay writer. The runtime performs model calls only
 * for explicitly started manual trials while the master switch is on.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ConfirmationCoordinator } from "../core/confirmation";
import { DEFAULT_CONFIG, type PiSquareConfig, type ShadowMindsConfig } from "../core/config";
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
import { formatModel } from "../subagents/child-session-executor";
import {
  buildShadowSystem,
  type ShadowProjectRule,
} from "./prompt";
import { createShadowRuntime, type ShadowRuntime, type ShadowRuntimeDeps } from "./runtime";
import { serializeShadowDefinition } from "./serialize";
import { buildTrajectory } from "./trajectory";

export interface ShadowMindsState {
  registry: ShadowDefinitionRegistry;
  cwd: string;
  projectTrusted: boolean;
  runtime: ShadowRuntime;
  /** The frozen task snapshot, captured live when no turn has started yet. */
  captureTaskSnapshot(): ShadowTaskSnapshot;
  refresh(cwd: string, projectTrusted: boolean): void;
  managerSnapshot(): ShadowManagerSnapshot;
}

/** Parent-task authority snapshot frozen at each real user task start. */
interface ShadowTaskSnapshot {
  parentCore?: string;
  projectRules: ShadowProjectRule[];
  cwd: string;
}

function rulesFromContextFiles(files: unknown): ShadowProjectRule[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file): file is { path: string; content: string } =>
      Boolean(file) && typeof file === "object"
      && typeof (file as { path?: unknown }).path === "string"
      && typeof (file as { content?: unknown }).content === "string")
    .map((file) => ({ path: file.path, content: file.content }));
}

function parentCoreFromOptions(options: unknown): string | undefined {
  const source = options as { customPrompt?: unknown; appendSystemPrompt?: unknown } | undefined;
  const custom = typeof source?.customPrompt === "string" ? source.customPrompt.trim() : "";
  const append = typeof source?.appendSystemPrompt === "string" ? source.appendSystemPrompt.trim() : "";
  if (!custom && !append) return undefined;
  return append ? `${custom}\n\n${append}` : custom || undefined;
}

/** Resolves the run model: an explicit Shadow model or the activating parent model. */
function resolveShadowModel(spec: string | undefined, ctx: ExtensionCommandContext): {
  model?: any;
  label?: string;
  error?: string;
} {
  const trimmed = spec?.trim();
  if (!trimmed) {
    const label = formatModel(ctx.model);
    return { ...(ctx.model ? { model: ctx.model } : {}), ...(label ? { label } : {}) };
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: `Invalid model '${trimmed}'. Expected provider/model.` };
  }
  const model = ctx.modelRegistry?.find?.(trimmed.slice(0, slash).trim(), trimmed.slice(slash + 1).trim());
  if (!model) return { error: `Unknown Shadow model '${trimmed}'.` };
  return { model, label: formatModel(model) ?? trimmed };
}

function captureTrajectory(ctx: ExtensionCommandContext) {
  try {
    const leafId = ctx.sessionManager?.getLeafId?.() ?? undefined;
    const branch = ctx.sessionManager?.getBranch?.(leafId);
    return buildTrajectory(Array.isArray(branch) ? branch : []);
  } catch {
    return buildTrajectory([]);
  }
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

/** Builds the manager write and runtime services against one command invocation. */
function makeServices(
  state: ShadowMindsState,
  ctx: ExtensionCommandContext,
  confirmations: ConfirmationCoordinator,
  runtime: ShadowRuntime = state.runtime,
): ShadowManagerServices {
  return {
    runtime: {
      snapshot: () => runtime.snapshot(),
      runManual(input) {
        state.refresh(ctx.cwd, ctx.isProjectTrusted());
        const definition = state.registry.definitions.find((entry) => entry.id === input.shadowId);
        if (!definition) {
          return { ok: false, message: `Shadow definition '${input.shadowId}' is no longer available.` };
        }
        if (definition.tools?.length !== 0) {
          return { ok: false, message: "Manual runs currently support only definitions with the explicit empty tool list (tools: [])." };
        }
        const snapshot = state.captureTaskSnapshot();
        const outcome = runtime.startManualRun({
          definition,
          ...(input.note ? { note: input.note } : {}),
          system: buildShadowSystem({
            ...(snapshot.parentCore ? { parentCore: snapshot.parentCore } : {}),
            projectRules: snapshot.projectRules,
            cwd: snapshot.cwd,
          }),
          trajectory: captureTrajectory(ctx),
          cwd: snapshot.cwd,
          modelResolution: resolveShadowModel(definition.model, ctx),
          ...(definition.thinking ?? ctx.thinkingLevel
            ? { thinkingLevel: definition.thinking ?? ctx.thinkingLevel }
            : {}),
        });
        if (!outcome.started) {
          ctx.ui.notify(`shadow-minds: ${outcome.reason}`, "warning");
          return { ok: false, message: outcome.reason };
        }
        ctx.ui.notify(`shadow-minds: started manual run of ${definition.id}`, "info");
        return { ok: true, message: `Started manual run of ${definition.id}.` };
      },
      cancelRun(runId) {
        return runtime.cancelRun(runId);
      },
      markResultRead: (id) => runtime.markResultRead(id),
      dismissResult: (id) => runtime.dismissResult(id),
      deleteResult: (id) => runtime.deleteResult(id),
      subscribe: (listener) => runtime.subscribe(listener),
    },
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
  runtimeDeps?: ShadowRuntimeDeps,
): ShadowMindsState {
  const effectiveConfig = (): ShadowMindsConfig => config?.().shadowMinds ?? DEFAULT_CONFIG.shadowMinds;
  const state: ShadowMindsState = {
    registry: { definitions: [], invalid: [], diagnostics: [] },
    cwd: process.cwd(),
    projectTrusted: false,
    runtime: createShadowRuntime({
      config: effectiveConfig,
      ...(runtimeDeps ? { deps: runtimeDeps } : {}),
    }),
    captureTaskSnapshot(): ShadowTaskSnapshot {
      const options = (ctx as ExtensionCommandContext | undefined)?.getSystemPromptOptions?.();
      const parentCore = parentCoreFromOptions(options);
      return {
        ...(parentCore ? { parentCore } : {}),
        projectRules: rulesFromContextFiles((options as { contextFiles?: unknown } | undefined)?.contextFiles),
        cwd: ctx?.cwd ?? state.cwd,
      };
    },
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

  let ctx: ExtensionContext | undefined;
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
  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    state.runtime.reset("Parent Pi session changed");
    state.refresh(sessionCtx.cwd, sessionCtx.isProjectTrusted());
    if (sessionCtx.hasUI && state.registry.diagnostics.length > 0) {
      const suffix = state.registry.diagnostics.length > 1
        ? ` (+${state.registry.diagnostics.length - 1} more)`
        : "";
      sessionCtx.ui.notify(`shadow-minds: ${state.registry.diagnostics[0]!.message}${suffix}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    state.runtime.reset("Parent Pi session shutdown");
    ctx = undefined;
  });

  // Terminal manual-run outcomes surface as bounded session notifications;
  // operational failures never become cognitive payloads.
  const terminalPhases = new Set(["submitted", "silent", "cancelled", "timeout", "max_turns", "max_tool_calls", "error"]);
  const seenPhases = new Map<string, string>();
  state.runtime.subscribe(() => {
    const sessionCtx = ctx;
    if (!sessionCtx?.hasUI) return;
    for (const run of state.runtime.snapshot().runs) {
      const previous = seenPhases.get(run.id);
      seenPhases.set(run.id, run.phase);
      if (previous === run.phase || run.phase === "running") continue;
      if (!terminalPhases.has(run.phase)) continue;
      const outcomeMessage = run.phase === "submitted"
        ? `shadow-minds: ${run.shadowId} finished — result in the /shadow inbox`
        : `shadow-minds: ${run.shadowId} run ended (${run.phase}${run.message ? `: ${run.message}` : ""})`;
      sessionCtx.ui.notify(notifyText(outcomeMessage), run.phase === "error" ? "warning" : "info");
    }
  });

  return state;
}

export const __testables = { makeServices };
