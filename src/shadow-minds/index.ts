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
  type EffectiveShadowDefinition,
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
import {
  createPersistentShadowInbox,
  reconcileShadowPartitions,
  sweepShadowDebugRetention,
} from "./inbox-store";
import {
  createShadowRuntime,
  type ShadowRunRequest,
  type ShadowRuntime,
  type ShadowRuntimeDeps,
} from "./runtime";
import {
  createShadowScheduler,
  TASK_EPOCH_RETENTION_MAX,
  type ShadowScheduler,
  type ShadowSchedulerStartInput,
} from "./scheduler";
import { serializeShadowDefinition } from "./serialize";
import { buildTrajectory, type ShadowTrajectoryEvidence } from "./trajectory";
import { resolveShadowTools } from "./tools";
import { createShadowInbox, type ShadowInbox } from "./result";
import { createShadowDeliveryController, type ShadowDeliveryController } from "./delivery";
import { createCompletionGate, type ShadowCompletionGate } from "./gate";

/** Parent-session custom entry type for one bounded result reference. */
export const SHADOW_RESULT_ENTRY_TYPE = "pi-square.shadow-result";

export interface ShadowMindsState {
  registry: ShadowDefinitionRegistry;
  cwd: string;
  projectTrusted: boolean;
  runtime: ShadowRuntime;
  /** Deterministic automatic scheduling for this parent session. */
  scheduler: ShadowScheduler;
  /** Confirmed delivery of Shadow results as advisory evidence (#159). */
  delivery?: ShadowDeliveryController;
  /** Bounded answer-after-review completion gate (#160). */
  gate?: ShadowCompletionGate;
  /** Current parent-run sequence used to bind manual activation provenance. */
  currentParentRun(): number;
  /** Frozen per-task snapshot used by every automatic activation of the task. */
  taskSnapshot?: ShadowTaskSnapshot;
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

/** Freezes the parent-task authority snapshot from prompt-build options. */
function taskSnapshotFromOptions(
  options: unknown,
  cwd: string,
  projectTrusted: boolean,
): ShadowTaskSnapshot {
  const parentCore = parentCoreFromOptions(options);
  let canonical: string;
  try {
    canonical = realpathSync.native(cwd);
  } catch (error) {
    return {
      ...(parentCore ? { parentCore } : {}),
      projectRules: [],
      cwd,
      error: `The Shadow working directory cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ...(parentCore ? { parentCore } : {}),
    projectRules: projectTrusted
      ? rulesFromContextFiles((options as { contextFiles?: unknown } | undefined)?.contextFiles)
      : [],
    cwd: canonical,
  };
}

function parentCoreFromOptions(options: unknown): string | undefined {
  const source = options as { customPrompt?: unknown; appendSystemPrompt?: unknown } | undefined;
  const custom = typeof source?.customPrompt === "string" ? source.customPrompt.trim() : "";
  const append = typeof source?.appendSystemPrompt === "string" ? source.appendSystemPrompt.trim() : "";
  if (!custom && !append) return undefined;
  return append ? `${custom}\n\n${append}` : custom || undefined;
}

/** Resolves the run model: an explicit Shadow model or the activating parent model. */
function captureTrajectory(
  ctx: Pick<ExtensionContext, "sessionManager"> | ExtensionCommandContext,
  evidence: readonly ShadowTrajectoryEvidence[] = [],
) {
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

/**
 * Composes and starts one run from an effective definition against a live
 * context. Manual trials and scheduler dispatch share every guard: registry
 * refresh, definition lookup, parent-model filter, tool-envelope resolution
 * with visible warnings, model and thinking resolution, and the same child
 * seam. Returns the runtime start outcome.
 */
function composeShadowRun(input: {
  state: ShadowMindsState;
  ctx: ExtensionContext;
  definition: EffectiveShadowDefinition;
  source: "manual" | "automatic";
  note?: string;
  taskEpoch?: number;
  sourceRun?: number;
  trigger?: ShadowRunRequest["trigger"];
  triggerReasons?: ShadowRunRequest["triggerReasons"];
  /** Frozen automatic snapshot; manual trials capture fresh per run. */
  snapshot?: ShadowTaskSnapshot;
  trajectory?: ReturnType<typeof captureTrajectory>;
  /** Surfaces bounded pre-start warnings (unavailable optional tools). */
  onWarning?: (message: string) => void;
}): { started: boolean; reason?: string; kind?: "busy" | "failed" } {
  const { state, ctx } = input;
  const runtime = state.runtime;
  try {
    const liveConfig = state.managerSnapshot().config ?? DEFAULT_CONFIG.shadowMinds;
    state.refresh(ctx.cwd, ctx.isProjectTrusted());
    const definition = state.registry.definitions.find((entry) => entry.id === input.definition.id) ?? input.definition;
    const parentLabel = formatModel(ctx.model);
    if (!matchesParentModelFilter(definition.parentModels, parentLabel)) {
      input.onWarning?.(
        `Shadow '${definition.id}' is filtered to parent models ${(definition.parentModels ?? []).join(", ")}${parentLabel ? `; the parent model is ${parentLabel}` : ""}.`,
      );
      return {
        started: false,
        kind: "failed",
        reason: `Shadow '${definition.id}' is filtered to parent models ${(definition.parentModels ?? []).join(", ")}${parentLabel ? `; the parent model is ${parentLabel}` : ""}.`,
      };
    }
    const snapshot = input.snapshot ?? state.captureTaskSnapshot(ctx as ExtensionCommandContext);
    if (snapshot.error) {
      return { started: false, kind: "failed", reason: snapshot.error };
    }
    const resolution = resolveShadowTools({
      ...(definition.tools !== undefined ? { tools: definition.tools } : {}),
      ...(definition.requiredTools && definition.requiredTools.length > 0 ? { requiredTools: definition.requiredTools } : {}),
      cwd: snapshot.cwd,
    });
    if (!resolution.ok) {
      input.onWarning?.(resolution.error);
      return { started: false, kind: "failed", reason: resolution.error };
    }
    for (const warning of resolution.envelope.warnings) {
      input.onWarning?.(warning);
    }
    const modelResolution = resolveShadowModel(definition.model, ctx);
    if (modelResolution.error) {
      input.onWarning?.(modelResolution.error);
      return { started: false, kind: "failed", reason: modelResolution.error };
    }
    const thinkingResolution = resolveShadowThinkingLevel(
      definition.thinking,
      liveConfig.defaults.thinking,
      ctx.thinkingLevel,
      modelResolution.model,
    );
    if (thinkingResolution.error) {
      input.onWarning?.(thinkingResolution.error);
      return { started: false, kind: "failed", reason: thinkingResolution.error };
    }
    const request: ShadowRunRequest = {
      definition,
      ...(input.note ? { note: input.note } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.taskEpoch !== undefined ? { taskEpoch: input.taskEpoch } : {}),
      ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
      ...(input.triggerReasons && input.triggerReasons.length > 0 ? { triggerReasons: input.triggerReasons } : {}),
      system: buildShadowSystem({
        ...(snapshot.parentCore ? { parentCore: snapshot.parentCore } : {}),
        projectRules: snapshot.projectRules,
        cwd: snapshot.cwd,
      }),
      trajectory: input.trajectory ?? captureTrajectory(ctx, deliveredEvidence(runtime)),
      cwd: snapshot.cwd,
      modelResolution,
      ...(thinkingResolution.level ? { thinkingLevel: thinkingResolution.level } : {}),
      envelope: resolution.envelope,
      ...(definition.debug && state.partition ? { debug: state.partition } : {}),
    };
    const outcome = input.source === "manual"
      ? runtime.startManualRun(request)
      : runtime.startAutomaticRun(request);
    return outcome.started
      ? { started: true }
      : { started: false, reason: outcome.reason, ...(outcome.kind ? { kind: outcome.kind } : {}) };
  } catch (error) {
    return {
      started: false,
      kind: "failed",
      reason: notifyText(`The Shadow run context is no longer active: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

/** Builds the manager write and runtime services against one command invocation. */
function makeServices(
  state: ShadowMindsState,
  ctx: ExtensionCommandContext,
  confirmations: ConfirmationCoordinator,
  runtime: ShadowRuntime = state.runtime,
  hooks?: { onSchedulerChange?: () => void },
): ShadowManagerServices {
  return {
    runtime: {
      snapshot: () => runtime.snapshot(),
      runManual(input) {
        try {
          state.refresh(ctx.cwd, ctx.isProjectTrusted());
          const definition = state.registry.definitions.find((entry) => entry.id === input.shadowId);
          if (!definition) {
            return { ok: false, message: `Shadow definition '${input.shadowId}' is no longer available.` };
          }
          // The reviewed snapshot must still match the live definition and
          // effective limits; a drift refuses the run before any prompt.
          const liveConfig = state.managerSnapshot().config ?? DEFAULT_CONFIG.shadowMinds;
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
          const outcome = composeShadowRun({
            state,
            ctx,
            definition,
            source: "manual",
            ...(input.note ? { note: input.note } : {}),
            taskEpoch: state.scheduler.snapshot().taskEpoch,
            sourceRun: state.currentParentRun(),
            onWarning: (message) => ctx.ui.notify(`shadow-minds: ${notifyText(message)}`, "warning"),
          });
          if (!outcome.started) {
            return { ok: false, message: outcome.reason ?? "The run did not start." };
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
      deleteResult: (id) => {
        const ok = runtime.deleteResult(id);
        if (ok) state.delivery?.remove(id);
        return ok;
      },
      subscribe: (listener) => runtime.subscribe(listener),
    },
    scheduler: {
      snapshot: () => state.scheduler.snapshot(),
      pause: () => {
        state.scheduler.pause();
        hooks?.onSchedulerChange?.();
      },
      resume: () => {
        state.scheduler.resume();
        hooks?.onSchedulerChange?.();
      },
    },
    delivery: {
      sendResultToAgent(id: string): { ok: boolean; message: string } {
        const result = state.runtime.snapshot().results.find((entry) => entry.id === id);
        if (!result) return { ok: false, message: "That result is no longer available." };
        const sent = state.delivery?.sendResultToAgent(result) ?? false;
        return sent
          ? { ok: true, message: "Sent to the agent as advisory evidence." }
          : { ok: false, message: "That result is already being delivered or was delivered." };
      },
      sendErrorSummary(runId: string): { ok: boolean; message: string } {
        const run = state.runtime.snapshot().runs.find((entry) => entry.id === runId);
        if (!run) return { ok: false, message: "That run is no longer available." };
        if (run.phase !== "error") return { ok: false, message: "Only failed runs can send a failure summary." };
        const sent = state.delivery?.sendErrorSummary({
          id: run.id,
          shadowId: run.shadowId,
          shadowName: run.shadowName,
          phase: run.phase,
          ...(run.message ? { message: run.message } : {}),
        }) ?? false;
        return sent
          ? { ok: true, message: "Sent the failure summary to the agent." }
          : { ok: false, message: "The failure summary could not be sent." };
      },
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
    // An explicit inbox is always tracked so old-task downgrades reach the
    // in-memory fallback of non-persisted sessions too.
    currentInbox = inbox ?? createShadowInbox({});
    return createShadowRuntime({
      config: effectiveConfig,
      ...(runtimeDeps ? { deps: runtimeDeps } : {}),
      inbox: currentInbox,
      currentTaskEpoch: () => state.scheduler.snapshot().taskEpoch,
    });
  };

  const makeScheduler = (): ShadowScheduler => {
    const scheduler = createShadowScheduler({
      now: () => Date.now(),
      currentRun: () => parentRunSeq,
      config: effectiveConfig,
      definitions: () => state.registry.definitions,
      start(activation: ShadowSchedulerStartInput) {
        const sessionCtx = ctx;
        if (!sessionCtx) return { outcome: "failed", reason: "No parent session context." };
        const taskSnapshot = taskSnapshots.get(activation.taskEpoch);
        if (!taskSnapshot) {
          return {
            outcome: "failed",
            reason: `The frozen authority snapshot for task ${activation.taskEpoch} is no longer retained.`,
          };
        }
        const outcome = composeShadowRun({
          state,
          ctx: sessionCtx,
          definition: activation.definition,
          source: "automatic",
          trigger: activation.reasons[0]?.trigger,
          taskEpoch: activation.taskEpoch,
          sourceRun: activation.sourceRun,
          triggerReasons: activation.reasons,
          snapshot: taskSnapshot,
          trajectory: activation.checkpoint as ReturnType<typeof captureTrajectory> | undefined,
        });
        if (outcome.started) return { outcome: "started" };
        if (outcome.kind === "busy") return { outcome: "busy" };
        return { outcome: "failed", reason: outcome.reason ?? "The automatic run did not start." };
      },
      preemptOldestAutomatic: (currentEpoch) => state.runtime.preemptOldestAutomatic(currentEpoch),
      activeRun: (shadowId) => state.runtime.activeRun(shadowId),
      cancelTaskRuns: (epoch) => state.runtime.cancelTaskRuns(epoch),
      cancelAutomaticRuns: (reason) => state.runtime.cancelAutomaticRuns(reason),
      forceNotifyOldResults(beforeEpoch) {
        let downgraded = 0;
        for (const result of state.runtime.snapshot().results) {
          // Results without a recorded task identity predate scheduling;
          // treat them as old work.
          if ((result.taskIdentity?.epoch ?? 0) >= beforeEpoch) continue;
          if (currentInbox?.forceNotify?.(result.id)) downgraded += 1;
        }
        return downgraded;
      },
    });
    // Pause state is user-visible: both entry points (manager service and
    // any future direct call) refresh the conditional status.
    return {
      ...scheduler,
      pause() {
        state.gate?.close("paused");
        scheduler.pause();
        refreshStatus();
      },
      resume() {
        scheduler.resume();
        refreshStatus();
      },
    };
  };
  const state: ShadowMindsState = {
    registry: { definitions: [], invalid: [], diagnostics: [] },
    cwd: process.cwd(),
    projectTrusted: false,
    runtime: makeRuntime(),
    scheduler: makeScheduler(),
    currentParentRun: () => parentRunSeq,
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
  // ── Bounded completion gate (#160) ─────────────────────────────────
  // The gate never delays the parent answer: it only holds this extension's
  // settled handling for a bounded window after the answer has rendered.
  state.gate = createCompletionGate({
    now: () => Date.now(),
    config: effectiveConfig,
    definitions: () => state.registry.definitions,
    scheduler: {
      pendingCompletions: () => state.scheduler.pendingCompletions(),
      cancelPendingCompletions: () => state.scheduler.cancelPendingCompletions(),
    },
    hasRunningCompletionRuns: () => state.runtime.snapshot().runs.some(
      (run) => run.phase === "running" && run.trigger === "completion",
    ),
    forwardSettle: (_at) => {
      if (!settleHeld) return;
      settleHeld = false;
      state.delivery?.handleAgentSettled();
      refreshStatus();
    },
    onClose: (reason, cancelled) => {
      if (cancelled > 0 && ctx?.hasUI) {
        ctx.ui.notify(
          notifyText(`shadow-minds: completion gate closed (${reason}); ${cancelled} queued completion run${cancelled === 1 ? "" : "s"} cancelled`),
          "info",
        );
      }
    },
  });

  let ctx: ExtensionContext | undefined;
  const seenPhases = new Map<string, string>();
  const SHADOW_STATUS_KEY = "pi-square.shadow-minds";
  let statusContext: ExtensionContext | undefined;

  /** Renders the bounded conditional footer status: running, queued, unread. */
  const renderStatusText = (): string | undefined => {
    if (!effectiveConfig().enabled) return undefined;
    const snapshot = state.runtime.snapshot();
    const running = snapshot.runs.filter((run) => run.phase === "running").length;
    const queued = state.scheduler.snapshot().pending.length;
    const unread = snapshot.results.filter((result) => result.attention === "unread").length;
    const paused = state.scheduler.snapshot().paused;
    if (running === 0 && queued === 0 && unread === 0 && !paused) return undefined;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (queued > 0) parts.push(`${queued} queued`);
    if (unread > 0) parts.push(`${unread} unread`);
    if (paused) parts.push("paused");
    return `Shadow: ${parts.join(" · ")}`;
  };

  const refreshStatus = (): void => {
    if (!statusContext?.hasUI) return;
    statusContext.ui.setStatus?.(SHADOW_STATUS_KEY, renderStatusText());
  };

  const bindSchedulerStatus = (sessionCtx: ExtensionContext): void => {
    statusContext = sessionCtx;
    refreshStatus();
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
      await openShadowManager(ctx, state.managerSnapshot(), makeServices(state, ctx, confirmations, undefined, {
        onSchedulerChange: refreshStatus,
      }));
    },
  });

  // ── Deterministic automatic scheduling (odradekk/pi-square#158) ──────
  // Real-user runs alone create trigger opportunities: the input event
  // distinguishes interactive/rpc user input from extension continuations,
  // and the before_agent_start options freeze the per-task authority
  // snapshot every automatic activation of that task shares.
  let pendingIdleInput: "real" | "extension" | undefined;
  const queuedSteeringSources: Array<"real" | "extension"> = [];
  const queuedFollowUpSources: Array<"real" | "extension"> = [];
  let streamingInputDesynchronized = false;
  let skipInitialUserMessage = false;
  // Parent-run timing for delivery policies: one run spans its
  // before_agent_start boundary through agent_settled. Queued steering or
  // follow-up continuations of a still-streaming run stay inside that run;
  // a triggerTurn delivery (a wake follow-up) starts its own run, which
  // emits agent_start but never input or before_agent_start, so it can
  // neither open a task epoch nor re-trigger Shadows.
  let parentRunSeq = 0;
  let parentRunActive = false;
  let parentRunPrepared = false;
  // Completion-gate state: the subsystem settle is held while the gate is
  // open, and a headless drain makes every delivery quiet (no new turn).
  let settleHeld = false;
  let draining = false;
  state.delivery = createShadowDeliveryController({
    pi,
    getRuntime: () => state.runtime,
    timing: () => ({
      currentRun: parentRunSeq,
      currentTaskEpoch: state.scheduler.snapshot().taskEpoch,
      parentRunning: parentRunActive,
      ...(draining ? { quiet: true } : {}),
    }),
    onDegrade: (count) => {
      if (!ctx?.hasUI) return;
      ctx.ui.notify(
        notifyText(`shadow-minds: ${count} result${count === 1 ? "" : "s"} stayed in the inbox; the delivery window passed`),
        "info",
      );
    },
    onPendingChange: refreshStatus,
  });
  const toolArgsById = new Map<string, { toolName: string; args: unknown }>();
  const TOOL_ARG_PAIRS_MAX = 64;
  const STREAMING_INPUT_PAIRS_MAX = 64;
  pi.on("input", (event) => {
    const source = event?.source === "extension" ? "extension" : "real";
    if (event?.streamingBehavior) {
      // Pi queues streaming input without a new before_agent_start event and
      // drains steering messages before follow-ups. Keep those identities
      // separate so mixed real/extension inputs cannot misclassify.
      const queue = event.streamingBehavior === "followUp" ? queuedFollowUpSources : queuedSteeringSources;
      if (queue.length >= STREAMING_INPUT_PAIRS_MAX) {
        streamingInputDesynchronized = true;
        queuedSteeringSources.length = 0;
        queuedFollowUpSources.length = 0;
        return;
      }
      queue.push(source);
      return;
    }
    // Idle input is only committed at before_agent_start. Model/auth/preflight
    // failures after input must not advance the task epoch.
    pendingIdleInput = source;
  });

  const taskSnapshots = createTaskSnapshotStore();
  pi.on("before_agent_start", async (event, sessionCtx) => {
    const source = pendingIdleInput;
    pendingIdleInput = undefined;
    const realUserTask = source === "real";
    if (source) state.scheduler.handleInput(realUserTask ? "interactive" : "extension");
    // A new real-user task ends any held gate window: its unstarted
    // completions cancel and resolve through the stale-task downgrade.
    if (realUserTask) state.gate?.close("new-task");
    state.taskSnapshot = taskSnapshotFromOptions(
      event?.systemPromptOptions,
      sessionCtx?.cwd ?? state.cwd,
      Boolean(sessionCtx?.isProjectTrusted?.()),
    );
    if (realUserTask) {
      taskSnapshots.record(state.scheduler.snapshot().taskEpoch, state.taskSnapshot);
    }
    skipInitialUserMessage = true;
    parentRunSeq += 1;
    parentRunActive = true;
    parentRunPrepared = true;
    state.scheduler.handleRunStart(realUserTask);
    refreshStatus();
  });

  pi.on("agent_start", () => {
    // Normal user runs were already identified at before_agent_start. A
    // triggerTurn custom-message follow-up has no such boundary, so agent_start
    // is its only authoritative run-start signal.
    if (!parentRunPrepared) {
      parentRunSeq += 1;
      parentRunActive = true;
    }
    parentRunPrepared = false;
    state.delivery?.handleAgentStart();
  });

  pi.on("agent_settled", () => {
    parentRunActive = false;
    // The completion gate (#160) holds the subsystem settle for its bounded
    // window: the parent answer has already rendered; only this extension's
    // settled handling waits. The close forwards the settle exactly once.
    if (state.gate?.open) {
      settleHeld = true;
      refreshStatus();
      return;
    }
    state.delivery?.handleAgentSettled();
  });

  pi.on("message_start", (event) => {
    state.delivery?.observeMessage(event?.message);
    if (event?.message?.role !== "user") return;
    if (skipInitialUserMessage) {
      skipInitialUserMessage = false;
      return;
    }
    if (streamingInputDesynchronized) {
      state.scheduler.handleRunStart(false);
      return;
    }
    const source = queuedSteeringSources.shift() ?? queuedFollowUpSources.shift();
    if (!source) return;
    const realUserTask = source === "real";
    state.scheduler.handleInput(realUserTask ? "interactive" : "extension");
    // A queued continuation stays inside the same parent agent run, so it uses
    // the authority frozen by that run's before_agent_start boundary.
    if (realUserTask && state.taskSnapshot) {
      taskSnapshots.record(state.scheduler.snapshot().taskEpoch, state.taskSnapshot);
    }
    state.scheduler.handleRunStart(realUserTask);
    refreshStatus();
  });

  pi.on("tool_execution_start", (event) => {
    const toolCallId = String(event?.toolCallId ?? "");
    const toolName = String(event?.toolName ?? "");
    if (toolCallId) {
      if (toolArgsById.size >= TOOL_ARG_PAIRS_MAX) toolArgsById.clear();
      toolArgsById.set(toolCallId, { toolName, args: event?.args });
    }
    state.scheduler.observeToolStart(toolName, event?.args);
  });

  pi.on("tool_execution_end", (event) => {
    const toolCallId = String(event?.toolCallId ?? "");
    const toolName = String(event?.toolName ?? "");
    const paired = toolCallId ? toolArgsById.get(toolCallId) : undefined;
    if (toolCallId) toolArgsById.delete(toolCallId);
    const args = paired?.toolName === toolName ? paired.args : undefined;
    state.scheduler.observeToolEnd(toolName, Boolean(event?.isError), args, event?.result);
  });

  pi.on("turn_end", (event, sessionCtx) => {
    state.delivery?.handleTurnEnd(event?.message);
    if (!sessionCtx) return;
    // A turn that ended through user interruption drops its observations
    // instead of dispatching: Pi emits turn_end before agent_end on abort,
    // and an aborted quality command is not a failure trigger.
    if ((event?.message as { stopReason?: unknown } | undefined)?.stopReason === "aborted") {
      state.scheduler.handleTurnAbort();
      refreshStatus();
      return;
    }
    let checkpoint: ReturnType<typeof captureTrajectory> | undefined;
    if (state.scheduler.shouldCapture()) {
      try {
        checkpoint = captureTrajectory(sessionCtx, deliveredEvidence(state.runtime));
      } catch {
        checkpoint = undefined;
      }
    }
    state.scheduler.handleTurnEnd(checkpoint);
    refreshStatus();
  });

  pi.on("agent_end", (event, sessionCtx) => {
    const interrupted = Array.isArray(event?.messages)
      && event.messages.some((message) => (message as { stopReason?: unknown } | undefined)?.stopReason === "aborted");
    let checkpoint: ReturnType<typeof captureTrajectory> | undefined;
    if (sessionCtx && state.scheduler.shouldCapture()) {
      try {
        checkpoint = captureTrajectory(sessionCtx, deliveredEvidence(state.runtime));
      } catch {
        checkpoint = undefined;
      }
    }
    state.scheduler.handleAgentEnd({ interrupted, checkpoint });
    state.delivery?.handleAgentEnd(event?.messages);
    if (interrupted) state.gate?.close("aborted");
    else state.gate?.maybeOpen();
    refreshStatus();
    streamingInputDesynchronized = false;
    queuedSteeringSources.length = 0;
    queuedFollowUpSources.length = 0;
    skipInitialUserMessage = false;
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
        sweepShadowDebugRetention(sessionDir, sessionId);
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
    state.scheduler = makeScheduler();
    state.delivery?.reset();
    state.gate?.reset();
    parentRunSeq = 0;
    parentRunActive = false;
    parentRunPrepared = false;
    settleHeld = false;
    draining = false;
    // A result left pending by a lost session never resumes automatically:
    // it returns inbox-only with notify policy and waits for an explicit send.
    const recoveredDeliveries = inbox?.recoverPendingDelivery?.() ?? 0;
    if (recoveredDeliveries > 0 && sessionCtx.hasUI) {
      sessionCtx.ui.notify(
        `shadow-minds: recovered ${recoveredDeliveries} undelivered result${recoveredDeliveries === 1 ? "" : "s"} to the inbox`,
        "info",
      );
    }
    pendingIdleInput = undefined;
    queuedSteeringSources.length = 0;
    queuedFollowUpSources.length = 0;
    streamingInputDesynchronized = false;
    skipInitialUserMessage = false;
    state.taskSnapshot = undefined;
    taskSnapshots.clear();
    toolArgsById.clear();
    bindRuntimeNotifications();
    bindSchedulerStatus(sessionCtx);
    state.refresh(sessionCtx.cwd, sessionCtx.isProjectTrusted());
    if (sessionCtx.hasUI && state.registry.diagnostics.length > 0) {
      const suffix = state.registry.diagnostics.length > 1
        ? ` (+${state.registry.diagnostics.length - 1} more)`
        : "";
      sessionCtx.ui.notify(`shadow-minds: ${state.registry.diagnostics[0]!.message}${suffix}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event) => {
    // Session replacement and interactive quit cancel the applicable gate
    // and Shadow work; there is no continuation to drain into.
    state.gate?.close("session");
    // Print/JSON quits are headless: Pi awaits this handler before the
    // process exits, so started completion runs get one bounded drain
    // window to finish, persist, and deliver quietly — no turn is started.
    const headless = ctx?.mode === "print" || ctx?.mode === "json";
    if (headless && effectiveConfig().enabled) {
      const seconds = Math.min(
        Math.max(1, effectiveConfig().defaults.headlessDrainSeconds),
        300,
      );
      const deadline = Date.now() + seconds * 1_000;
      draining = true;
      try {
        while (Date.now() < deadline
          && state.runtime.snapshot().runs.some((run) => run.phase === "running")) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // One single settle point: the drained close cancels unstarted
        // completions and forwards a held settle; anything still owed
        // flushes here — quietly, with transcript confirmation.
        state.gate?.close("drained");
        if (settleHeld) {
          settleHeld = false;
          state.delivery?.handleAgentSettled();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        draining = false;
        settleHeld = false;
      }
    }
    state.runtime.reset("Parent Pi session shutdown");
    state.scheduler.reset();
    state.delivery?.reset();
    state.gate?.reset();
    settleHeld = false;
    draining = false;
    seenPhases.clear();
    statusContext?.ui.setStatus?.(SHADOW_STATUS_KEY, undefined);
    statusContext = undefined;
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
    // Results restored from a reopened partition never auto-deliver: only
    // results created inside this session enter the delivery machine.
    const seenDelivery = new Set<string>(state.runtime.snapshot().results.map((result) => result.id));
    unsubscribeRuntime = state.runtime.subscribe(() => {
      const sessionCtx = ctx;
      // A settled run may have freed a concurrency slot for queued work.
      state.scheduler.handleRunSettled();
      // Every gate-subscribed completion draining closes the gate early.
      state.gate?.notifyActivity();
      refreshStatus();
      const results = state.runtime.snapshot().results;
      for (const result of results) {
        if (seenResults.has(result.id) || result.referenced) continue;
        // Fresh results alone enter the delivery machine; results restored
        // from a reopened partition stay inbox-only until explicitly sent.
        if (!seenDelivery.has(result.id)) {
          seenDelivery.add(result.id);
          state.delivery?.enqueueResult(result);
        }
        if (!effectiveConfig().enabled) continue;
        try {
          pi.appendEntry(SHADOW_RESULT_ENTRY_TYPE, {
            version: 1 as const,
            resultId: result.id,
            shadowId: result.shadowId.slice(0, 64),
            summary: result.summary.slice(0, 160),
            createdAt: result.createdAt,
          });
          seenResults.add(result.id);
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

/** Bounded per-task-epoch snapshot store: late dispatch composes with the authority frozen for that task. */
export function createTaskSnapshotStore() {
  const store = new Map<number, ShadowTaskSnapshot>();
  return {
    record(epoch: number, snapshot: ShadowTaskSnapshot): void {
      store.set(epoch, snapshot);
      while (store.size > TASK_EPOCH_RETENTION_MAX) {
        const oldest = [...store.keys()].sort((a, b) => a - b)[0];
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get(epoch: number): ShadowTaskSnapshot | undefined {
      return store.get(epoch);
    },
    clear(): void {
      store.clear();
    },
  };
}

export const __testables = { makeServices, createTaskSnapshotStore };
