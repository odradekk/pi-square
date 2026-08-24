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

import { realpathSync } from "node:fs";
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
  shadowDefinitionContextFingerprint,
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
import { matchesParentModelFilter, resolveShadowModel, resolveShadowThinkingLevel } from "./resolve";
import { createPersistentShadowInbox, reconcileShadowPartitions } from "./inbox-store";
import { createShadowRuntime, type ShadowRuntime, type ShadowRuntimeDeps } from "./runtime";
import { serializeShadowDefinition } from "./serialize";
import { buildTrajectory, type ShadowTrajectoryEvidence } from "./trajectory";
import { resolveShadowTools } from "./tools";
import type { ShadowInbox } from "./result";

/** Parent-session custom entry type for one bounded result reference. */
export const SHADOW_RESULT_ENTRY_TYPE = "pi-square.shadow-result";

export interface ShadowMindsState {
  registry: ShadowDefinitionRegistry;
  cwd: string;
  projectTrusted: boolean;
  runtime: ShadowRuntime;
  /** Present when the parent session persists; Shadow results survive reopening. */
  partition?: { sessionDir: string; sessionId: string };
  /** The frozen task snapshot, captured from one command context. */
  captureTaskSnapshot(commandCtx: ExtensionCommandContext): ShadowTaskSnapshot;
  refresh(cwd: string, projectTrusted: boolean): void;
  managerSnapshot(): ShadowManagerSnapshot;
}

/** Parent-task authority snapshot frozen at each real user task start. */
interface ShadowTaskSnapshot {
  parentCore?: string;
  projectRules: ShadowProjectRule[];
  cwd: string;
  error?: string;
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
function captureTrajectory(ctx: ExtensionCommandContext, evidence: readonly ShadowTrajectoryEvidence[] = []) {
  try {
    // The compaction-aware context projection: `buildContextEntries` follows
    // the current leaf and omits entries the latest compaction replaced, so
    // the trajectory matches what the parent model actually sees. The plain
    // branch remains the fallback for surfaces without the projection.
    const manager = ctx.sessionManager;
    const branch = manager?.buildContextEntries?.() ?? manager?.getBranch?.(manager.getLeafId?.() ?? undefined);
    return buildTrajectory(Array.isArray(branch) ? branch : [], { evidence });
  } catch {
    return buildTrajectory([], { evidence });
  }
}

/** Delivered Shadow results as trajectory evidence; notified results stay out. */
function deliveredEvidence(runtime: ShadowRuntime): ShadowTrajectoryEvidence[] {
  return runtime.snapshot().results
    .filter((result) => result.delivery === "delivered")
    .map((result) => ({
      shadowId: result.shadowId,
      shadowName: result.shadowName,
      summary: result.summary,
      deliveredAt: result.createdAt,
      delivery: result.delivery,
    }));
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
        try {
          const liveConfig = state.managerSnapshot().config ?? DEFAULT_CONFIG.shadowMinds;
          state.refresh(ctx.cwd, ctx.isProjectTrusted());
          const definition = state.registry.definitions.find((entry) => entry.id === input.shadowId);
          if (!definition) {
            return { ok: false, message: `Shadow definition '${input.shadowId}' is no longer available.` };
          }
          const liveFingerprint = shadowDefinitionContextFingerprint(definition.layers);
          const expectedBounds = {
            timeoutSeconds: definition.timeoutSeconds ?? liveConfig.defaults.runTimeoutSeconds,
            maxTurns: definition.maxTurns ?? liveConfig.defaults.maxModelTurnsPerRun,
            maxToolCalls: definition.maxToolCalls ?? liveConfig.defaults.maxToolCallsPerRun,
          };
          const carriesReview = input.definitionFingerprint !== undefined
            || input.defaultThinking !== undefined
            || input.timeoutSeconds !== undefined
            || input.maxTurns !== undefined
            || input.maxToolCalls !== undefined;
          if (carriesReview && (
            liveFingerprint !== input.definitionFingerprint
            || liveConfig.defaults.thinking !== input.defaultThinking
            || expectedBounds.timeoutSeconds !== input.timeoutSeconds
            || expectedBounds.maxTurns !== input.maxTurns
            || expectedBounds.maxToolCalls !== input.maxToolCalls
          )) {
            return { ok: false, message: "The Shadow definition or run limits changed since review; reopen /shadow and review the current run." };
          }
          const snapshot = state.captureTaskSnapshot(ctx);
          if (snapshot.error) {
            ctx.ui.notify(`shadow-minds: ${notifyText(snapshot.error)}`, "warning");
            return { ok: false, message: snapshot.error };
          }
          // Exact parent-model filter: a filtered Shadow refuses to run
          // beside a non-matching parent model rather than silently differing
          // from its automatic activation contract.
          const parentLabel = formatModel(ctx.model);
          if (!matchesParentModelFilter(definition.parentModels, parentLabel)) {
            const message = `Shadow '${definition.id}' is filtered to parent models ${definition.parentModels!.join(", ")}${parentLabel ? `; the parent model is ${parentLabel}` : ""}.`;
            ctx.ui.notify(`shadow-minds: ${notifyText(message)}`, "warning");
            return { ok: false, message };
          }
          // Resolve the strictly read-only evidence envelope before anything
          // is prompted: missing optional tools warn, missing required tools
          // fail the run before the child session is ever created.
          const resolution = resolveShadowTools({
            ...(definition.tools !== undefined ? { tools: definition.tools } : {}),
            ...(definition.requiredTools && definition.requiredTools.length > 0 ? { requiredTools: definition.requiredTools } : {}),
            cwd: snapshot.cwd,
          });
          if (!resolution.ok) {
            ctx.ui.notify(`shadow-minds: ${notifyText(resolution.error)}`, "warning");
            return { ok: false, message: resolution.error };
          }
          for (const warning of resolution.envelope.warnings) {
            ctx.ui.notify(`shadow-minds: ${notifyText(warning)}`, "warning");
          }
          const modelResolution = resolveShadowModel(definition.model, ctx);
          if (modelResolution.error) {
            ctx.ui.notify(`shadow-minds: ${notifyText(modelResolution.error)}`, "warning");
            return { ok: false, message: modelResolution.error };
          }
          const thinkingResolution = resolveShadowThinkingLevel(
            definition.thinking,
            liveConfig.defaults.thinking,
            ctx.thinkingLevel,
            modelResolution.model,
          );
          if (thinkingResolution.error) {
            ctx.ui.notify(`shadow-minds: ${notifyText(thinkingResolution.error)}`, "warning");
            return { ok: false, message: thinkingResolution.error };
          }
          const outcome = runtime.startManualRun({
            definition,
            ...(input.note ? { note: input.note } : {}),
            system: buildShadowSystem({
              ...(snapshot.parentCore ? { parentCore: snapshot.parentCore } : {}),
              projectRules: snapshot.projectRules,
              cwd: snapshot.cwd,
            }),
            trajectory: captureTrajectory(ctx, deliveredEvidence(runtime)),
            cwd: snapshot.cwd,
            modelResolution,
            ...(thinkingResolution.level ? { thinkingLevel: thinkingResolution.level } : {}),
            envelope: resolution.envelope,
            ...(definition.debug && state.partition ? { debug: state.partition } : {}),
          });
          if (!outcome.started) {
            ctx.ui.notify(`shadow-minds: ${outcome.reason}`, "warning");
            return { ok: false, message: outcome.reason };
          }
          ctx.ui.notify(`shadow-minds: started manual run of ${definition.id}`, "info");
          return { ok: true, message: `Started manual run of ${definition.id}.` };
        } catch (error) {
          return { ok: false, message: notifyText(`The Shadow run context is no longer active: ${error instanceof Error ? error.message : String(error)}`) };
        }
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
  let currentInbox: ShadowInbox | undefined;
  const makeRuntime = (inbox?: ShadowInbox): ShadowRuntime => {
    currentInbox = inbox;
    return createShadowRuntime({
      config: effectiveConfig,
      ...(runtimeDeps ? { deps: runtimeDeps } : {}),
      ...(inbox ? { inbox } : {}),
    });
  };
  const state: ShadowMindsState = {
    registry: { definitions: [], invalid: [], diagnostics: [] },
    cwd: process.cwd(),
    projectTrusted: false,
    runtime: makeRuntime(),
    captureTaskSnapshot(commandCtx: ExtensionCommandContext): ShadowTaskSnapshot {
      // `getSystemPromptOptions` exists only on command contexts in Pi
      // 0.84.2 — the session-start event context never carries it — so the
      // command context that opened the manager is the capture source.
      const options = commandCtx.getSystemPromptOptions?.();
      const parentCore = parentCoreFromOptions(options);
      let cwd: string;
      try {
        cwd = realpathSync.native(commandCtx.cwd ?? state.cwd);
      } catch (error) {
        return {
          ...(parentCore ? { parentCore } : {}),
          projectRules: [],
          cwd: commandCtx.cwd ?? state.cwd,
          error: `The Shadow working directory cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return {
        ...(parentCore ? { parentCore } : {}),
        projectRules: commandCtx.isProjectTrusted()
          ? rulesFromContextFiles((options as { contextFiles?: unknown } | undefined)?.contextFiles)
          : [],
        cwd,
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
  const seenPhases = new Map<string, string>();
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
    seenPhases.clear();
    // Each parent session owns its Shadow state: persisted sessions get the
    // authoritative partition inbox (results survive reopening) while
    // non-persisted sessions fall back to memory with a visible diagnostic.
    const sessionDir = sessionCtx.sessionManager?.getSessionDir?.() ?? "";
    const sessionFile = sessionCtx.sessionManager?.getSessionFile?.();
    let inbox: ShadowInbox | undefined;
    if (!effectiveConfig().enabled) {
      // Disabled: no partition is opened, scanned, or created, and the
      // fallback notice stays silent.
      state.partition = undefined;
    } else if (sessionDir && typeof sessionFile === "string" && sessionFile.length > 0) {
      const sessionId = String(sessionCtx.sessionManager?.getSessionId?.() ?? "session");
      state.partition = { sessionDir, sessionId };
      const reconciled = reconcileShadowPartitions(sessionDir, sessionId);
      if (reconciled.removed.length > 0) {
        sessionCtx.hasUI && sessionCtx.ui.notify(
          `shadow-minds: removed ${reconciled.removed.length} orphaned Shadow partition${reconciled.removed.length === 1 ? "" : "s"}`,
          "info",
        );
      }
      try {
        const persistentInbox = createPersistentShadowInbox({ sessionDir, sessionId });
        inbox = persistentInbox;
        for (const diagnostic of persistentInbox.diagnostics().slice(0, 3)) {
          sessionCtx.hasUI && sessionCtx.ui.notify(`shadow-minds: ${notifyText(diagnostic)}`, "warning");
        }
      } catch (error) {
        state.partition = undefined;
        sessionCtx.hasUI && sessionCtx.ui.notify(
          `shadow-minds: the persistent inbox could not open (${error instanceof Error ? error.message : String(error)}); results stay in memory`,
          "warning",
        );
      }
    } else {
      state.partition = undefined;
      if (sessionCtx.hasUI) {
        sessionCtx.ui.notify(
          "shadow-minds: this session is not persisted; Shadow results stay in memory",
          "info",
        );
      }
    }
    state.runtime = makeRuntime(inbox);
    bindRuntimeNotifications();
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
    seenPhases.clear();
    ctx = undefined;
  });

  // Terminal manual-run outcomes surface as bounded session notifications;
  // operational failures never become cognitive payloads. New results also
  // land one bounded reference entry in the parent session transcript so
  // the inbox stays the single authoritative payload store.
  // Every non-running phase is terminal, so a phase change away from running
  // notifies once; entries for runs that left the history are pruned.
  let unsubscribeRuntime: (() => void) | undefined;
  const bindRuntimeNotifications = (): void => {
    unsubscribeRuntime?.();
    // Results carry a persisted `referenced` flag, so a reopened session
    // does not re-append transcript references it already recorded; the
    // in-memory set only guards duplicate notifications within this
    // runtime instance. A crash between the append and the persisted mark
    // can re-append one bounded entry at the next open.
    const seenResults = new Set<string>();
    unsubscribeRuntime = state.runtime.subscribe(() => {
      const sessionCtx = ctx;
      const results = state.runtime.snapshot().results;
      for (const result of results) {
        if (seenResults.has(result.id) || result.referenced) continue;
        seenResults.add(result.id);
        if (!effectiveConfig().enabled) continue;
        try {
          pi.appendEntry(SHADOW_RESULT_ENTRY_TYPE, {
            version: 1 as const,
            resultId: result.id,
            shadowId: result.shadowId.slice(0, 64),
            summary: result.summary.slice(0, 160),
            createdAt: result.createdAt,
          });
          currentInbox?.markReferenced?.(result.id);
        } catch {
          // A session that cannot record the reference keeps the result in
          // the inbox; the entry is observability, not authority.
        }
      }
      if (!sessionCtx?.hasUI) return;
      const runs = state.runtime.snapshot().runs;
      const liveIds = new Set(runs.map((run) => run.id));
      for (const stale of seenPhases.keys()) {
        if (!liveIds.has(stale)) seenPhases.delete(stale);
      }
      for (const run of runs) {
        const previous = seenPhases.get(run.id);
        seenPhases.set(run.id, run.phase);
        if (previous === run.phase || run.phase === "running") continue;
        const outcomeMessage = run.phase === "submitted"
          ? `shadow-minds: ${run.shadowId} finished — result in the /shadow inbox`
          : `shadow-minds: ${run.shadowId} run ended (${run.phase}${run.message ? `: ${run.message}` : ""})`;
        sessionCtx.ui.notify(notifyText(outcomeMessage), run.phase === "error" ? "warning" : "info");
      }
    });
  };
  bindRuntimeNotifications();

  return state;
}

export const __testables = { makeServices };
