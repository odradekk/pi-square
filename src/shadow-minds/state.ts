/**
 * Shadow Minds state shapes (odradekk/pi-square#373).
 *
 * This module owns the two state shapes the registration root holds and the
 * conversion between them. The registered shape is owned from extension
 * registration until the first `session_start`; it carries no session-scoped
 * member, so nothing here can half-exist. `session_start` promotes it to the
 * session shape, which has no optional members: delivery, gate, partition,
 * and task snapshot are all present, with `undefined` as an honest value for
 * a memory-only session or a session before its first real-user task. The
 * registration root owns the Pi event wiring; it narrows the union with
 * `isShadowSessionState` and skips session-only work before a session
 * exists — an explicit, tested no-op, never a throw. The module also owns
 * the run composition shared by manual trials and automatic dispatch and
 * the manager runtime services, so tests can assemble a usable state from
 * this module alone, without loading the registration root.
 */

import { realpathSync } from "node:fs";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  type PiSquareConfig,
  type ShadowMindsConfig,
} from "../core/config";
import { sanitizeDisplayLine } from "../display/sanitize";
import {
  discoverShadowDefinitions,
  shadowDefinitionContextFingerprint,
  type EffectiveShadowDefinition,
  type ShadowDefinitionRegistry,
} from "./definitions";
import {
  snapshot as managerSnapshotView,
  type ShadowManagerServices,
  type ShadowManagerSnapshot,
} from "./manager";
import { formatModel } from "../subagents/child-session-executor";
import {
  buildShadowSystem,
  canonicalSchemaJson,
  type ShadowProjectRule,
} from "./prompt";
import { matchesParentModelFilter, resolveShadowModel, resolveShadowThinkingLevel } from "./resolve";
import {
  createShadowResultStore,
  type ShadowResultStore,
} from "./result-store";
import {
  createShadowRuntime,
  shadowCohortHash,
  type ShadowRunRequest,
  type ShadowRuntime,
  type ShadowRuntimeDeps,
} from "./runtime";
import {
  createShadowScheduler,
  type ShadowScheduler,
  type ShadowSchedulerStartInput,
  type ShadowSchedulerStartOutcome,
} from "./scheduler";
import { buildTrajectory, type ShadowTrajectoryEvidence } from "./trajectory";
import { resolveShadowTools } from "./tools";
import type { ShadowDeliveryCore } from "./delivery";
import type { ShadowCompletionGate } from "./gate";

/** Parent-task authority snapshot frozen at each real user task start. */
export interface ShadowTaskSnapshot {
  parentCore?: string;
  projectRules: ShadowProjectRule[];
  cwd: string;
  error?: string;
}

/** Per-session persistent inbox partition; absent for memory-only sessions. */
export interface ShadowSessionPartition {
  sessionDir: string;
  sessionId: string;
}

/**
 * The members owned under both state shapes: the definition registry, the
 * result store, the runtime, and the scheduler all exist from registration,
 * so the `/shadow` manager and the event observers have a fully populated
 * state to work with before any session starts.
 */
export interface ShadowMindsState {
  /** The state shape discriminator: registered until session_start promotes the state. */
  kind: "registered" | "session";
  registry: ShadowDefinitionRegistry;
  cwd: string;
  runtime: ShadowRuntime;
  /** Deterministic automatic scheduling for this parent session. */
  scheduler: ShadowScheduler;
  /** The result store the runtime writes to and the manager services reach. */
  resultStore: ShadowResultStore;
  /** Current parent-run sequence used to bind manual activation provenance. */
  currentParentRun(): number;
  /** The frozen task snapshot, captured from one command context. */
  captureTaskSnapshot(commandCtx: ExtensionCommandContext): ShadowTaskSnapshot;
  refresh(cwd: string): void;
  managerSnapshot(): ShadowManagerSnapshot;
}

/**
 * The state shape owned from extension registration until a parent session
 * starts. Session-scoped delivery, gate, partition, and task snapshot are
 * reachable only on the session shape.
 */
export interface ShadowMindsRegisteredState extends ShadowMindsState {
  kind: "registered";
}

/**
 * The state shape owned while a parent session runs: the registered shape
 * promoted at `session_start`. No optional members — `partition` and
 * `taskSnapshot` hold `undefined` as a declared value, not an absent key.
 */
export interface ShadowMindsSessionState extends ShadowMindsState {
  kind: "session";
  /** Confirmed delivery of Shadow results as advisory evidence (#159). */
  delivery: ShadowDeliveryCore;
  /** Bounded answer-after-review completion gate (#160). */
  gate: ShadowCompletionGate;
  /** Present when the parent session persists; Shadow results survive reopening. */
  partition: ShadowSessionPartition | undefined;
  /** Frozen per-task snapshot used by every automatic activation of the task. */
  taskSnapshot: ShadowTaskSnapshot | undefined;
}

/** Narrows a state shape to the session shape. */
export function isShadowSessionState(
  state: ShadowMindsState,
): state is ShadowMindsSessionState {
  return state.kind === "session";
}


/** Live reads the state-owned scheduler delegates back to the state. */
export interface ShadowStateSources {
  definitions(): readonly EffectiveShadowDefinition[];
  runtime(): ShadowRuntime;
  resultStore(): ShadowResultStore;
}

/** Wiring the registration root injects into the state-owned scheduler. */
export interface ShadowStateSchedulerGlue {
  config(): ShadowMindsConfig;
  /** Current parent-run sequence, frozen into each observed activation. */
  currentRun(): number;
  /** Starts one automatic run; the registration root wires the real composer. */
  dispatch(activation: ShadowSchedulerStartInput): ShadowSchedulerStartOutcome;
  sources: ShadowStateSources;
}

/**
 * Builds the state-owned deterministic scheduler. The runtime, registry, and
 * result-store reads go through the injected sources, so a session-start
 * rebuild observes the promoted state's current members. The registration
 * root adds its own pause/resume wrapper around the returned scheduler.
 */
export function createStateScheduler(glue: ShadowStateSchedulerGlue): ShadowScheduler {
  return createShadowScheduler({
    now: () => Date.now(),
    currentRun: glue.currentRun,
    config: glue.config,
    definitions: () => glue.sources.definitions(),
    start: glue.dispatch,
    activeRun: (shadowId) => glue.sources.runtime().activeRun(shadowId),
    preemptOldestAutomatic: (currentEpoch) => glue.sources.runtime().preemptOldestAutomatic(currentEpoch),
    cancelTaskRuns: (epoch) => glue.sources.runtime().cancelTaskRuns(epoch),
    cancelAutomaticRuns: (reason) => glue.sources.runtime().cancelAutomaticRuns(reason),
    forceNotifyOldResults(beforeEpoch) {
      let downgraded = 0;
      for (const result of glue.sources.runtime().snapshot().results) {
        // Results without a recorded task identity predate scheduling;
        // treat them as old work.
        if ((result.taskIdentity?.epoch ?? 0) >= beforeEpoch) continue;
        if (glue.sources.resultStore().forceNotify(result.id)) downgraded += 1;
      }
      return downgraded;
    },
  });
}

/** Builds one session-scoped runtime bound to one result store. */
export function createStateRuntime(input: {
  config(): ShadowMindsConfig;
  runtimeDeps?: ShadowRuntimeDeps;
  resultStore: ShadowResultStore;
  currentTaskEpoch(): number;
}): ShadowRuntime {
  return createShadowRuntime({
    config: input.config,
    ...(input.runtimeDeps ? { deps: input.runtimeDeps } : {}),
    resultStore: input.resultStore,
    currentTaskEpoch: input.currentTaskEpoch,
  });
}

/** Everything `session_start` installs when it promotes the state. */
export interface ShadowSessionPromotion {
  delivery: ShadowDeliveryCore;
  gate: ShadowCompletionGate;
  partition: ShadowSessionPartition | undefined;
  runtime: ShadowRuntime;
  scheduler: ShadowScheduler;
  resultStore: ShadowResultStore;
}

/**
 * The session_start conversion (#373): promotes the registered state in
 * place and returns it. Identity is preserved — the methods created by
 * `createRegisteredState` close over this object, so they keep working on
 * the promoted shape — while the type-level promise changes: every session
 * member is present from here on.
 */
export function promoteToSessionState(
  registered: ShadowMindsState,
  promotion: ShadowSessionPromotion,
): ShadowMindsSessionState {
  const session = registered as ShadowMindsSessionState;
  session.kind = "session";
  session.delivery = promotion.delivery;
  session.gate = promotion.gate;
  session.partition = promotion.partition;
  session.taskSnapshot = undefined;
  session.runtime = promotion.runtime;
  session.scheduler = promotion.scheduler;
  session.resultStore = promotion.resultStore;
  return session;
}

/** Wiring the registration root injects into the registered state. */
export interface CreateShadowRegisteredStateInput {
  config?: () => PiSquareConfig;
  runtimeDeps?: ShadowRuntimeDeps;
  /** The current parent-run sequence, frozen into manual-run provenance. */
  currentParentRun?: () => number;
  /**
   * Automatic dispatch; the registration root wires the real run composer
   * against the live session context. Defaults to an inert refusal, which
   * is enough for state-level tests that never dispatch.
   */
  dispatchAutomatic?: (activation: ShadowSchedulerStartInput) => ShadowSchedulerStartOutcome;
}

/**
 * Builds the registered state: the definition registry, the result store,
 * the runtime, and the scheduler all exist from registration, so the
 * `/shadow` manager and the event observers below have a fully populated
 * state to work with before any session starts.
 */
export function createRegisteredState(
  input: CreateShadowRegisteredStateInput = {},
): ShadowMindsRegisteredState {
  const effectiveConfig = (): ShadowMindsConfig => input.config?.().shadowMinds ?? DEFAULT_CONFIG.shadowMinds;
  const dispatchAutomatic: (activation: ShadowSchedulerStartInput) => ShadowSchedulerStartOutcome =
    input.dispatchAutomatic ?? (() => ({ outcome: "failed", reason: "No automatic dispatch is wired for this state." }));
  const resultStore = createShadowResultStore({});
  const scheduler = createStateScheduler({
    config: effectiveConfig,
    currentRun: () => state.currentParentRun(),
    dispatch: dispatchAutomatic,
    sources: {
      definitions: () => state.registry.definitions,
      runtime: () => state.runtime,
      resultStore: () => state.resultStore,
    },
  });
  const runtime = createStateRuntime({
    config: effectiveConfig,
    ...(input.runtimeDeps ? { runtimeDeps: input.runtimeDeps } : {}),
    resultStore,
    currentTaskEpoch: () => state.scheduler.snapshot().taskEpoch,
  });
  const state: ShadowMindsRegisteredState = {
    kind: "registered",
    registry: { definitions: [], invalid: [], diagnostics: [] },
    cwd: process.cwd(),
    runtime,
    scheduler,
    resultStore,
    currentParentRun: input.currentParentRun ?? (() => 0),
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
        projectRules: rulesFromContextFiles((options as { contextFiles?: unknown } | undefined)?.contextFiles),
        cwd,
      };
    },
    refresh(cwd: string): void {
      state.cwd = cwd;
      state.registry = discoverShadowDefinitions(cwd);
      // #191: the refreshed registry revalidates pending activations at once
      // — a disabled master switch or deleted, disabled, hidden, invalid, or
      // unsubscribed definition drops queued work visibly instead of starting
      // from stale configuration at the next dispatch.
      state.scheduler.revalidate();
    },
    managerSnapshot(): ShadowManagerSnapshot {
      return managerSnapshotView(state.registry, input.config?.().shadowMinds);
    },
  };
  return state;
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
export function taskSnapshotFromOptions(options: unknown, cwd: string): ShadowTaskSnapshot {
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
    // Project rules participate unconditionally (#188): trust never gates
    // the frozen Shadow authority snapshot.
    projectRules: rulesFromContextFiles((options as { contextFiles?: unknown } | undefined)?.contextFiles),
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

/** Builds the observational trajectory view from the live context projection. */
export function captureTrajectory(
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

export function hasRunningGateCompletion(
  runs: readonly { phase: string; trigger?: string; shadowId: string }[],
  gateIds: ReadonlySet<string>,
): boolean {
  return runs.some((run) => run.phase === "running" && run.trigger === "completion" && gateIds.has(run.shadowId));
}

/** Delivered Shadow results as trajectory evidence; notified results stay out. */
export function deliveredEvidence(runtime: ShadowRuntime): ShadowTrajectoryEvidence[] {
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

/** One bounded, display-safe notification line. */
export function notifyText(message: string): string {
  const sanitized = sanitizeDisplayLine(message);
  return sanitized.length <= MAX_NOTIFY_CHARS ? sanitized : `${sanitized.slice(0, MAX_NOTIFY_CHARS - 1)}…`;
}

/** One notification line for a run that starts with a reduced tool set. */
export function toolWarningNotice(shadowId: string, warnings: string[]): string {
  return `shadow-minds: ${shadowId} starts with ${warnings.length} tool warning${warnings.length === 1 ? "" : "s"} — ${warnings.join(" ")}`;
}

/**
 * Composes and starts one run from an effective definition against a live
 * context. Manual trials and scheduler dispatch share every guard: registry
 * refresh, definition lookup, parent-model filter, tool-envelope resolution
 * with visible warnings, model and thinking resolution, and the same child
 * seam. Returns the runtime start outcome.
 */
export function composeShadowRun(input: {
  state: ShadowMindsState;
  ctx: ExtensionContext;
  partition?: ShadowSessionPartition | undefined;
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
  /** Surfaces the pre-start reason that refused the run. */
  onWarning?: (message: string) => void;
  /** Surfaces the bounded tool warnings once per run start. */
  onToolWarnings?: (warnings: string[]) => void;
}): { started: boolean; reason?: string; kind?: "busy" | "failed" } {
  const { state, ctx } = input;
  const runtime = state.runtime;
  try {
    state.refresh(ctx.cwd);
    const liveConfig = state.managerSnapshot().config ?? DEFAULT_CONFIG.shadowMinds;
    const definition = state.registry.definitions.find((entry) => entry.id === input.definition.id);
    const automaticReasons = input.source === "automatic"
      ? (input.triggerReasons ?? []).filter((reason) => definition?.triggers.includes(reason.trigger))
      : [];
    if (!definition
      || (input.source === "automatic" && (
        !definition.enabled
        || definition.hidden
        || !liveConfig.enabled
        || automaticReasons.length === 0
      ))) {
      return {
        started: false,
        kind: "failed",
        reason: `Shadow '${input.definition.id}' is no longer eligible after the pre-start refresh.`,
      };
    }
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
    if (resolution.envelope.warnings.length > 0) {
      input.onToolWarnings?.(resolution.envelope.warnings);
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
      ...(input.source === "automatic" && automaticReasons[0] ? { trigger: automaticReasons[0].trigger } : input.trigger ? { trigger: input.trigger } : {}),
      ...(input.taskEpoch !== undefined ? { taskEpoch: input.taskEpoch } : {}),
      ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
      ...(input.source === "automatic" && automaticReasons.length > 0
        ? { triggerReasons: automaticReasons }
        : input.triggerReasons && input.triggerReasons.length > 0
          ? { triggerReasons: input.triggerReasons }
          : {}),
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
      // Authority hashes are computed here — where the raw snapshot text is
      // visible — so the run record stores only hash prefixes, never the
      // prompt text (odradekk/pi-square#161).
      authorityCohort: {
        ...(snapshot.parentCore ? { parentCoreHash: shadowCohortHash(snapshot.parentCore) } : {}),
        ...(snapshot.projectRules.length > 0
          ? {
            projectRulesHash: shadowCohortHash(
              canonicalSchemaJson(snapshot.projectRules.map((rule) => ({ path: rule.path, content: rule.content }))),
            ),
          }
          : {}),
      },
      ...(definition.debug && input.partition ? { debug: input.partition } : {}),
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

/** Builds the manager runtime services against one command invocation. */
export function makeServices(
  state: ShadowMindsState,
  ctx: ExtensionCommandContext,
  runtime: ShadowRuntime = state.runtime,
  hooks?: { onSchedulerChange?: () => void },
): ShadowManagerServices {
  const store = state.resultStore;
  return {
    runtime: {
      snapshot: () => runtime.snapshot(),
      runManual(input) {
        try {
          state.refresh(ctx.cwd);
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
            partition: isShadowSessionState(state) ? state.partition : undefined,
            definition,
            source: "manual",
            ...(input.note ? { note: input.note } : {}),
            taskEpoch: state.scheduler.snapshot().taskEpoch,
            sourceRun: state.currentParentRun(),
            onWarning: (message) => ctx.ui.notify(`shadow-minds: ${notifyText(message)}`, "warning"),
            onToolWarnings: (warnings) => ctx.ui.notify(notifyText(toolWarningNotice(definition.id, warnings)), "warning"),
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
      markResultRead: (id) => store.markRead(id),
      dismissResult: (id) => store.dismiss(id),
      deleteResult: (id) => {
        const ok = store.delete(id);
        // Delivery removal is session-scoped work: before session_start the
        // pending set is empty by construction, so the skip changes nothing.
        if (ok && isShadowSessionState(state)) state.delivery.remove(id);
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
        // Explicit sends are session-scoped work; before session_start there
        // is no delivery machine to enter, so the request is refused with a
        // truthful reason instead of a throw.
        if (!isShadowSessionState(state)) {
          return { ok: false, message: "Results can be sent to the agent once the parent session starts." };
        }
        const sent = state.delivery.sendResultToAgent(result);
        return sent
          ? { ok: true, message: "Sent to the agent as advisory evidence." }
          : { ok: false, message: "That result is already being delivered or was delivered." };
      },
      sendErrorSummary(runId: string): { ok: boolean; message: string } {
        const run = state.runtime.snapshot().runs.find((entry) => entry.id === runId);
        if (!run) return { ok: false, message: "That run is no longer available." };
        if (run.phase !== "error") return { ok: false, message: "Only failed runs can send a failure summary." };
        if (!isShadowSessionState(state)) {
          return { ok: false, message: "Failure summaries can be sent once the parent session starts." };
        }
        const sent = state.delivery.sendErrorSummary({
          id: run.id,
          shadowId: run.shadowId,
          shadowName: run.shadowName,
          phase: run.phase,
          ...(run.message ? { message: run.message } : {}),
        });
        return sent
          ? { ok: true, message: "Sent the failure summary to the agent." }
          : { ok: false, message: "The failure summary could not be sent." };
      },
    },
  };
}
