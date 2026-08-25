/**
 * Session-scoped Shadow runtime (odradekk/pi-square#155).
 *
 * Owns the manual-run lifecycle: start refusal (master switch, concurrency
 * slots, note bound, model resolution), one fresh non-resumable child
 * session per run through the shared one-time executor seam, event-boundary
 * enforcement of the model-turn and tool-call budgets, user cancellation,
 * timeout propagation, terminal classification, and the session result
 * inbox. Terminal operational states (timeout, bounded budgets, aborts,
 * model/auth failures) are lifecycle data and never become cognitive
 * payloads: only a schema-valid `submit_shadow_result` submission creates
 * a result, and a run without one is silent.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ShadowMindsConfig } from "../core/config";
import {
  addUsageValues,
  createChildSessionUsage,
  createOneTimeChildSession,
  runOneTimeChildSession,
  type ChildSessionUsage,
  type OneTimeChildSessionHandle,
  type OneTimeChildSessionOutcome,
  type OneTimeChildSessionRunInput,
} from "../subagents/child-session-executor";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../display/sanitize";
import type { EffectiveShadowDefinition } from "./definitions";
import { buildShadowUserPrompt, canonicalSchemaJson, type ShadowTrajectory } from "./prompt";
import type { ShadowModelResolution } from "./resolve";
import { SUBMIT_SHADOW_RESULT_DESCRIPTION, SUBMIT_SHADOW_RESULT_PARAMETERS } from "./result";
import { finalizeShadowDebugRun, openShadowDebugSessionManager, shadowDebugRunDir } from "./inbox-store";
import type { ShadowTriggerKind, ShadowTriggerReason } from "./scheduler";
import type { ShadowToolEnvelope } from "./tools";
import {
  createShadowInbox,
  createSubmitShadowResultTool,
  SUBMIT_SHADOW_RESULT_TOOL,
  type ShadowInbox,
  type ShadowResultEntity,
} from "./result";

export const SHADOW_MANUAL_NOTE_MAX_CHARS = 8_000;

/** Terminal-run history retained for manager observation. */
const RUN_HISTORY_MAX = 50;
const RUN_MESSAGE_MAX_CHARS = 200;
/** Cohort hash prefix length; full schemas never leave the run record. */
const COHORT_HASH_CHARS = 16;
/** Per-request metrics retained per run; the turn budget stays far below. */
const REQUEST_METRICS_MAX = 64;

function cohortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, COHORT_HASH_CHARS);
}

/** Bounded definition-source hash recorded with every result entity. */
function definitionHashOf(definition: EffectiveShadowDefinition): string | undefined {
  const layers = definition.layers;
  if (!Array.isArray(layers) || layers.length === 0) return undefined;
  // Layer content hashes make the record change when a definition file is
  // edited, not only when its path or scope assignment changes.
  const sources = layers.map((layer) => ({
    scope: layer.scope,
    ...(typeof layer.filePath === "string" ? { filePath: layer.filePath } : {}),
    ...(typeof layer.contentHash === "string" ? { contentHash: layer.contentHash } : {}),
  }));
  return cohortHash(canonicalSchemaJson(sources));
}

export type ShadowRunPhase =
  | "running"
  | "submitted"
  | "silent"
  | "cancelled"
  | "superseded"
  | "timeout"
  | "max_turns"
  | "max_tool_calls"
  | "error";

/** How one run entered the runtime: a manager trial or scheduler dispatch. */
export type ShadowRunSource = "manual" | "automatic";

/** One model request's bounded usage and timing when the provider reports it. */
export interface ShadowRequestMetric {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Time from request start to the first assistant message start. */
  ttftMs?: number;
}

export interface ShadowRunView {
  id: string;
  shadowId: string;
  shadowName: string;
  source: ShadowRunSource;
  phase: ShadowRunPhase;
  startedAt: number;
  endedAt?: number;
  /** The automatic activation trigger; absent for manual trials. */
  trigger?: ShadowTriggerKind;
  /** The task epoch an automatic run belongs to. */
  taskEpoch?: number;
  /** Merged trigger reasons for automatic runs, priority-ordered. */
  triggerReasons?: ShadowTriggerReason[];
  note?: string;
  model?: string;
  /** Bounded terminal explanation; present for error phases. */
  message?: string;
  usage?: ChildSessionUsage;
  resultId?: string;
  /** Canonical evidence tool names; the submit tool is implied last. */
  toolNames?: string[];
  /** Bounded warnings for requested tools unavailable at run start. */
  toolWarnings?: string[];
  /** Stable prompt/tool/trajectory cache-cohort hashes. */
  systemHash?: string;
  toolSchemaHash?: string;
  trajectoryHash?: string;
  /** Whether the frozen trajectory was deterministically truncated. */
  trajectoryTruncated?: boolean;
  /** Per-request usage and TTFT, bounded by the turn budget. */
  requests?: ShadowRequestMetric[];
}

export type ShadowRunRequest = ShadowManualRunRequest & {
  /** Present for scheduler-dispatched runs. */
  trigger?: ShadowTriggerKind;
  taskEpoch?: number;
  triggerReasons?: ShadowTriggerReason[];
};

export interface ShadowManualRunRequest {
  definition: EffectiveShadowDefinition;
  note?: string;
  system: string;
  trajectory: ShadowTrajectory;
  cwd: string;
  modelResolution?: ShadowModelResolution;
  thinkingLevel?: string;
  /**
   * Resolved evidence-tool envelope in canonical order. Absent means the
   * no-tool trial; `submit_shadow_result` is always appended last.
   */
  envelope?: ShadowToolEnvelope;
  /**
   * Debug partition for a debug-enabled definition: the child session
   * persists native JSONL there and the settled run is sanitized, indexed,
   * and retention-swept after the run.
   */
  debug?: { sessionDir: string; sessionId: string };
}

export interface ShadowRuntimeSnapshot {
  runs: ShadowRunView[];
  results: ShadowResultEntity[];
  evictionEvents: Array<{ kind: "evicted"; id: string; at: number; reason: "count" | "bytes" }>;
}

/** Child-session creation input for the runtime seam; the system rides on the loader. */
export interface ShadowChildSessionInput {
  cwd: string;
  system: string;
  model?: any;
  thinkingLevel?: string;
  tools: string[];
  customTools: ToolDefinition<any, any, any>[];
  /** Present for debug runs: the child persists native JSONL here. */
  debugDir?: string;
}

export interface ShadowRuntimeDeps {
  now(): number;
  makeRunId?(): string;
  makeResultId?(): string;
  createSession(input: ShadowChildSessionInput): Promise<OneTimeChildSessionHandle>;
  runSession(input: OneTimeChildSessionRunInput): Promise<OneTimeChildSessionOutcome>;
  /** Sanitizes, indexes, and retention-sweeps one settled debug run. */
  finalizeDebug?(input: {
    sessionDir: string;
    sessionId: string;
    runId: string;
    shadowId: string;
    startedAt: number;
    endedAt: number;
    phase: string;
  }): void;
}

/**
 * Frozen child resource loader for Shadow sessions: the composed Shadow
 * SYSTEM is authoritative, and discovered extensions, skills, prompt
 * templates, themes, and project rule files all stay disabled so the child
 * never re-expands its envelope or duplicates project discovery.
 */
export function createFrozenShadowResourceLoader(input: { cwd: string; systemPrompt: string }) {
  const baseLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noSkills: true,
  });
  return {
    async reload() {
      await baseLoader.reload();
    },
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
  };
}

/** In-memory child settings, matching the delegated-child retry envelope. */
function shadowChildSettings() {
  return SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { maxRetries: 0 },
    },
  });
}

/** Production deps over the shared one-time child-session executor seam. */
export function createShadowRuntimeDeps(): ShadowRuntimeDeps {
  return {
    now: () => Date.now(),
    makeRunId: () => `run-${randomUUID()}`,
    makeResultId: () => `shr-${randomUUID()}`,
    async createSession(input) {
      return await createOneTimeChildSession({
        cwd: input.cwd,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        tools: input.tools,
        customTools: input.customTools,
        resourceLoader: createFrozenShadowResourceLoader({
          cwd: input.cwd,
          systemPrompt: input.system,
        }),
        settingsManager: shadowChildSettings(),
        ...(input.debugDir ? { sessionManager: openShadowDebugSessionManager(input.debugDir, input.cwd) } : {}),
      });
    },
    runSession: runOneTimeChildSession,
    finalizeDebug(input) {
      finalizeShadowDebugRun(input.sessionDir, input.sessionId, {
        runId: input.runId,
        shadowId: input.shadowId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        phase: input.phase,
      });
    },
  };
}

interface ActiveRun {
  view: ShadowRunView;
  source: ShadowRunSource;
  taskEpoch?: number;
  startedAt: number;
  cancel(force?: boolean): void;
  /** Supersedes this run for a newer task or a manual start. */
  supersede(): void;
  /** Set when the session scope ended before the run settled. */
  detached?: boolean;
  /** Set once superseded: the slot is released the moment it is chosen. */
  superseding?: boolean;
}

export type ManualRunStart =
  | { started: false; reason: string; kind?: "busy" | "failed" }
  | { started: true; runId: string; done: Promise<ShadowRunView> };

/** Automatic-run start result with an explicit refusal classification. */
export type AutomaticRunStart =
  | { started: false; reason: string; kind: "busy" | "failed" }
  | { started: true; runId: string; done: Promise<ShadowRunView> };

function boundedMessage(value: unknown): string {
  const text = sanitizeDisplayLine(value instanceof Error ? value.message : String(value ?? ""));
  return text.length <= RUN_MESSAGE_MAX_CHARS ? text : `${text.slice(0, RUN_MESSAGE_MAX_CHARS - 1)}…`;
}

/**
 * Creates one session-scoped Shadow runtime. Manual runs occupy concurrency
 * slots against the effective configuration; a valid submission terminates
 * its run and persists a result into the inbox; everything else is an
 * observable operational outcome.
 */
export function createShadowRuntime(input: {
  config: () => ShadowMindsConfig;
  deps?: ShadowRuntimeDeps;
  /** Session inbox; defaults to the in-memory fallback. */
  inbox?: ShadowInbox;
  /**
   * The scheduler's current task epoch: a run whose task is no longer
   * current persists its result with notify delivery.
   */
  currentTaskEpoch?: () => number;
}) {
  const deps = input.deps ?? createShadowRuntimeDeps();
  let runSequence = 0;
  const inbox = input.inbox ?? createShadowInbox({
    makeId: deps.makeResultId,
  });
  let sessionEpoch = 0;
  const active: ActiveRun[] = [];
  const history: ShadowRunView[] = [];
  const subscribers = new Set<() => void>();

  const notify = () => {
    for (const subscriber of subscribers) {
      try {
        subscriber();
      } catch {
        // A broken observer never affects run lifecycle.
      }
    }
  };

  function startManualRun(request: ShadowManualRunRequest): ManualRunStart {
    return startRun(request, "manual");
  }

  function startAutomaticRun(request: ShadowRunRequest): AutomaticRunStart {
    const outcome = startRun({ ...request }, "automatic");
    if (!outcome.started) {
      return { ...outcome, kind: outcome.kind ?? "failed" };
    }
    return outcome;
  }

  function startRun(request: ShadowRunRequest, source: ShadowRunSource): ManualRunStart {
    const effective = structuredClone(input.config());
    const runEpoch = sessionEpoch;
    if (!effective.enabled) {
      return {
        started: false,
        reason: "Shadow Minds is disabled by the master switch (agent config shadowMinds.enabled).",
      };
    }
    const note = sanitizeDisplayText(request.note).trim();
    if (note && note.length > SHADOW_MANUAL_NOTE_MAX_CHARS) {
      return {
        started: false,
        reason: `The manual note exceeds ${SHADOW_MANUAL_NOTE_MAX_CHARS.toLocaleString("en-US")} characters.`,
      };
    }
    if (request.modelResolution?.error) {
      return { started: false, reason: request.modelResolution.error };
    }
    const sameShadow = active.find((entry) => entry.view.shadowId === request.definition.id && !entry.superseding);
    if (sameShadow) {
      return {
        started: false,
        kind: "busy",
        reason: `Shadow '${request.definition.id}' already has an active run; wait for it to settle before starting another.`,
      };
    }
    const occupiedSlots = active.filter((entry) => !entry.superseding).length;
    if (occupiedSlots >= effective.defaults.maxConcurrentRuns) {
      if (source === "manual") {
        // Manual outranks automatic: free one slot by superseding the oldest
        // automatic run. Manual runs are never superseded this way.
        const preempted = supersedeOldestAutomatic(Number.MAX_SAFE_INTEGER);
        if (preempted.ok) {
          return startRun(request, source);
        }
      }
      return {
        started: false,
        kind: "busy",
        reason: `All ${effective.defaults.maxConcurrentRuns} Shadow run slots are busy; cancel a run or wait for one to settle.`,
      };
    }

    const { definition: requestDefinition } = request;
    const definition = structuredClone(requestDefinition);
    const envelope = request.envelope;
    const definitionHash = definitionHashOf(definition);
    const schemaHash = cohortHash(canonicalSchemaJson(definition.outputSchema));
    const startedAt = deps.now();
    const toolNames = [...(envelope?.toolNames ?? [])];
    const toolSchemaHash = envelope?.schemaHash
      ?? cohortHash(canonicalSchemaJson([{
        name: SUBMIT_SHADOW_RESULT_TOOL,
        description: SUBMIT_SHADOW_RESULT_DESCRIPTION,
        parameters: SUBMIT_SHADOW_RESULT_PARAMETERS,
      }]));
    const view: ShadowRunView = {
      id: deps.makeRunId?.() ?? `run-${(++runSequence).toString(36)}`,
      shadowId: definition.id,
      shadowName: definition.name,
      source,
      ...(request.trigger ? { trigger: request.trigger } : {}),
      ...(request.taskEpoch !== undefined ? { taskEpoch: request.taskEpoch } : {}),
      ...(request.triggerReasons && request.triggerReasons.length > 0
        ? { triggerReasons: structuredClone(request.triggerReasons) }
        : {}),
      phase: "running",
      startedAt,
      ...(note ? { note } : {}),
      ...(request.modelResolution?.label ? { model: request.modelResolution.label } : {}),
      toolNames,
      ...(envelope && envelope.warnings.length > 0 ? { toolWarnings: envelope.warnings } : {}),
      systemHash: cohortHash(request.system),
      toolSchemaHash,
      trajectoryHash: cohortHash(`${request.trajectory.text}\0${request.trajectory.truncation}`),
      ...(request.trajectory.truncation !== "none" ? { trajectoryTruncated: true } : {}),
    };

    let abortReason: "cancelled" | "superseded" | "timeout" | "max_turns" | "max_tool_calls" | undefined;
    let submitted: { payload: unknown; at: number } | undefined;
    const controller = new AbortController();
    const usage = createChildSessionUsage();
    const forceAbort = (reason: "cancelled" | "superseded" | "timeout" | "max_turns" | "max_tool_calls") => {
      abortReason ??= reason;
      controller.abort();
    };
    const run: ActiveRun = {
      view,
      source,
      ...(request.taskEpoch !== undefined ? { taskEpoch: request.taskEpoch } : {}),
      startedAt,
      cancel(force = false) {
        if (submitted && !force) return;
        forceAbort("cancelled");
      },
      supersede() {
        if (run.superseding || submitted) return;
        run.superseding = true;
        forceAbort("superseded");
      },
    };
    active.push(run);
    notify();

    const done = (async (): Promise<ShadowRunView> => {
      const defaults = effective.defaults;
      const timeoutMs = (definition.timeoutSeconds ?? defaults.runTimeoutSeconds) * 1000;
      const maxTurns = definition.maxTurns ?? defaults.maxModelTurnsPerRun;
      const maxToolCalls = definition.maxToolCalls ?? defaults.maxToolCallsPerRun;
      const deadlineAt = startedAt + timeoutMs;
      let toolCalls = 0;

      const tool = createSubmitShadowResultTool({
        schema: definition.outputSchema,
        beforeExecute() {
          if (runEpoch !== sessionEpoch || run.detached || controller.signal.aborted) {
            return "This Shadow run is no longer active; the result was not accepted.";
          }
          if (deps.now() >= deadlineAt) {
            forceAbort("timeout");
            return "The Shadow run deadline has passed; this submission was not accepted.";
          }
          if (toolCalls > maxToolCalls) {
            forceAbort("max_tool_calls");
            return `The Shadow tool-call budget of ${maxToolCalls} has been exhausted; this submission was not accepted.`;
          }
          return undefined;
        },
        onAccepted(payload) {
          if (runEpoch === sessionEpoch && !run.detached && !controller.signal.aborted) {
            submitted ??= { payload, at: deps.now() };
            controller.abort();
          }
        },
      });

      // Per-request usage and time-to-first-token: one request begins at each
      // turn start and completes at the next assistant message end. All
      // timing flows through the injected clock seam.
      const requests: ShadowRequestMetric[] = [];
      let currentRequest: ShadowRequestMetric | undefined;
      let requestStartedAt: number | undefined;

      const onEvent = (event: any) => {
        if (event?.type === "turn_start") {
          if (!submitted && !abortReason && usage.turns >= maxTurns) {
            forceAbort("max_turns");
          }
          currentRequest = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          requestStartedAt = deps.now();
          return;
        }
        if (event?.type === "message_start" && event.message?.role === "assistant") {
          if (currentRequest && currentRequest.ttftMs === undefined && requestStartedAt !== undefined) {
            currentRequest.ttftMs = Math.max(0, deps.now() - requestStartedAt);
          }
          return;
        }
        if (event?.type === "message_end" && event.message?.role === "assistant") {
          // The request finalizes at its assistant message end whether or not
          // the provider attached usage; a missing report lands as zeros so
          // the request count and TTFT stay observable.
          if (currentRequest) {
            addUsageValues(currentRequest, event.message?.usage);
            if (requests.length < REQUEST_METRICS_MAX) requests.push(currentRequest);
            currentRequest = undefined;
            requestStartedAt = undefined;
          }
          return;
        }
        if (event?.type === "tool_execution_start") {
          toolCalls += 1;
          if (!submitted && !abortReason && toolCalls > maxToolCalls) {
            forceAbort("max_tool_calls");
          }
        }
      };

      const prompt = buildShadowUserPrompt({
        trajectory: request.trajectory,
        definition,
        schema: definition.outputSchema,
        ...(request.trigger
          ? {
              triggerTask: {
                trigger: request.trigger,
                reasons: request.triggerReasons ?? [],
                instruction: definition.triggerInstructions[request.trigger],
              },
            }
          : {}),
        ...(note ? { note } : {}),
      });

      let outcome: OneTimeChildSessionOutcome;
      try {
        const creation = deps.createSession({
          cwd: request.cwd,
          system: request.system,
          model: request.modelResolution?.model,
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
          tools: [...toolNames, SUBMIT_SHADOW_RESULT_TOOL],
          customTools: [...(envelope?.customTools ?? []), tool],
          ...(request.debug ? { debugDir: shadowDebugRunDir(request.debug.sessionDir, request.debug.sessionId, view.id) } : {}),
        });
        let creationTimer: NodeJS.Timeout | undefined;
        let onCreationAbort: (() => void) | undefined;
        const creationStop = new Promise<never>((_resolve, reject) => {
          const stop = (message: string) => reject(new Error(message));
          onCreationAbort = () => stop("Shadow child session creation aborted");
          controller.signal.addEventListener("abort", onCreationAbort, { once: true });
          creationTimer = setTimeout(() => {
            forceAbort("timeout");
            stop("Shadow child session creation timed out");
          }, timeoutMs);
          creationTimer.unref?.();
        });
        let created: OneTimeChildSessionHandle;
        try {
          created = await Promise.race([creation, creationStop]);
        } catch (error) {
          void creation.then((late) => late.session?.dispose?.()).catch(() => {});
          throw error;
        } finally {
          if (creationTimer) clearTimeout(creationTimer);
          if (onCreationAbort) controller.signal.removeEventListener("abort", onCreationAbort);
        }
        const remainingTimeoutMs = deadlineAt - deps.now();
        if (remainingTimeoutMs <= 0) forceAbort("timeout");
        outcome = await deps.runSession({
          session: created.session,
          prompt,
          signal: controller.signal,
          timeoutMs: Math.max(1, remainingTimeoutMs),
          onEvent,
          usage,
        });
      } catch (error) {
        outcome = {
          status: "error",
          prompted: false,
          timedOut: false,
          error,
          finalText: "",
          usage,
          streamingCompleted: false,
          messages: [],
        };
      }

      let phase: ShadowRunPhase;
      let message: string | undefined;
      if (runEpoch !== sessionEpoch || run.detached) {
        phase = "cancelled";
      } else if (abortReason) {
        phase = abortReason;
      } else if (submitted) {
        phase = "submitted";
      } else if (outcome.status === "timeout") {
        phase = "timeout";
      } else if (outcome.status === "error" || outcome.terminalAssistantError) {
        phase = "error";
        message = boundedMessage(outcome.error ?? outcome.terminalAssistantError);
      } else {
        phase = "silent";
      }

      let resultId: string | undefined;
      if (phase === "submitted" && submitted && runEpoch === sessionEpoch && !run.detached) {
        try {
          const entity = inbox.add({
            shadowId: definition.id,
            shadowName: definition.name,
            payload: submitted.payload,
            ...(note ? { note } : {}),
            createdAt: submitted.at,
            ...(outcome.model ? { model: outcome.model } : {}),
            usage: outcome.usage,
            ...(definitionHash ? { definitionHash } : {}),
            schemaHash,
            source,
            ...(request.trigger ? { primaryTrigger: request.trigger } : {}),
            ...(request.triggerReasons && request.triggerReasons.length > 0
              ? { triggers: [...new Set(request.triggerReasons.map((reason) => reason.trigger))] }
              : {}),
            ...(request.taskEpoch !== undefined
              ? { taskIdentity: { epoch: request.taskEpoch } }
              : {}),
            validationSchema: structuredClone(definition.outputSchema),
            // A run that outlived its task delivers inbox-only: its result
            // must never enter the newer task automatically.
            configuredDelivery: request.taskEpoch !== undefined
              && (input.currentTaskEpoch?.() ?? request.taskEpoch) > request.taskEpoch
              ? "notify"
              : definition.delivery,
            lifecycle: "submitted",
            toolCalls,
            trajectoryTruncated: request.trajectory.truncation !== "none",
            ...(requests.length > 0 ? { requests: structuredClone(requests) } : {}),
          });
          resultId = entity.id;
        } catch (error) {
          phase = "error";
          message = boundedMessage(error);
        }
      }

      view.phase = phase;
      view.endedAt = deps.now();
      view.usage = outcome.usage;
      if (outcome.model) view.model = outcome.model;
      if (message) view.message = message;
      if (resultId) view.resultId = resultId;
      if (requests.length > 0) view.requests = requests;

      const activeIndex = active.indexOf(run);
      if (activeIndex >= 0) active.splice(activeIndex, 1);
      if (!run.detached) {
        history.unshift({ ...view });
        if (history.length > RUN_HISTORY_MAX) history.length = RUN_HISTORY_MAX;
      }
      if (request.debug) {
        // Detached runs finalize too: an unsanitized debug log must never
        // linger outside the retention sweep, whatever ended the run.
        try {
          deps.finalizeDebug?.({
            sessionDir: request.debug.sessionDir,
            sessionId: request.debug.sessionId,
            runId: view.id,
            shadowId: definition.id,
            startedAt,
            endedAt: view.endedAt ?? startedAt,
            phase: view.phase,
          });
        } catch {
          // Debug finalization is observability; failures never affect runs.
        }
      }
      notify();
      return { ...view };
    })();

    return { started: true, runId: view.id, done };
  }

  /**
   * Supersedes the oldest running automatic run from a task epoch below
   * `currentEpoch`. Manual runs and same-or-newer-epoch automatic runs are
   * never eligible; a superseded run records the distinct `superseded`
   * outcome and releases its slot immediately.
   */
  function supersedeOldestAutomatic(currentEpoch: number): { ok: boolean; runId?: string } {
    const candidates = active
      .filter((entry) => entry.source === "automatic"
        && !entry.superseding
        && entry.taskEpoch !== undefined
        && entry.taskEpoch < currentEpoch)
      .sort((a, b) => a.startedAt - b.startedAt);
    const target = candidates[0];
    if (!target) return { ok: false };
    target.supersede();
    return { ok: true, runId: target.view.id };
  }

  /** Cancels every active run of one task epoch (user interruption). */
  function cancelTaskRuns(epoch: number): number {
    let cancelled = 0;
    for (const entry of [...active]) {
      if (entry.taskEpoch !== epoch) continue;
      entry.cancel(true);
      cancelled += 1;
    }
    return cancelled;
  }

  /** Cancels every active automatic run and stamps why (session pause). */
  function cancelAutomaticRuns(reason: string): number {
    let cancelled = 0;
    for (const entry of [...active]) {
      if (entry.source !== "automatic") continue;
      entry.view.message = boundedMessage(reason);
      entry.cancel(true);
      cancelled += 1;
    }
    return cancelled;
  }

  /** Active activation identity for scheduler arbitration. */
  function activeRun(shadowId: string): { source: ShadowRunSource; taskEpoch?: number } | undefined {
    const entry = active.find((candidate) => candidate.view.shadowId === shadowId && !candidate.superseding);
    if (!entry) return undefined;
    return {
      source: entry.source,
      ...(entry.taskEpoch !== undefined ? { taskEpoch: entry.taskEpoch } : {}),
    };
  }

  function cancelRun(runId: string): { ok: boolean; message?: string } {
    const run = active.find((entry) => entry.view.id === runId);
    if (!run) return { ok: false, message: "That Shadow run is no longer active." };
    run.cancel();
    return { ok: true };
  }

  function snapshot(): ShadowRuntimeSnapshot {
    return {
      runs: [...active.map((run) => structuredClone(run.view)), ...history.map((run) => structuredClone(run))],
      results: inbox.list(),
      evictionEvents: inbox.events?.().map((event) => structuredClone(event)) ?? [],
    };
  }

  return {
    startManualRun,
    startAutomaticRun,
    cancelRun,
    preemptOldestAutomatic: supersedeOldestAutomatic,
    activeRun,
    cancelTaskRuns,
    cancelAutomaticRuns,
    snapshot,
    markResultRead(id: string) {
      const ok = inbox.markRead(id);
      if (ok) notify();
      return ok;
    },
    dismissResult(id: string) {
      const ok = inbox.dismiss(id);
      if (ok) notify();
      return ok;
    },
    deleteResult(id: string) {
      const ok = inbox.delete(id);
      if (ok) notify();
      return ok;
    },
    sendResultForDelivery(id: string) {
      const ok = inbox.send(id);
      if (ok) notify();
      return ok;
    },
    markResultDelivered(id: string) {
      const ok = inbox.markDelivered?.(id) ?? false;
      if (ok) notify();
      return ok;
    },
    degradeResultDelivery(id: string) {
      const ok = inbox.degradeToNotify?.(id) ?? false;
      if (ok) notify();
      return ok;
    },
    subscribe(listener: () => void): () => void {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    /** Aborts every active run and clears session-scoped state. */
    reset(_reason: string) {
      sessionEpoch += 1;
      runSequence = 0;
      const staleRuns = active.splice(0);
      for (const run of staleRuns) {
        run.detached = true;
        run.cancel(true);
      }
      history.length = 0;
      // A persistent partition is the authoritative record and survives
      // session-scoped resets; only the in-memory inbox is wiped.
      if (!inbox.persistent) inbox.clear();
      notify();
    },
  };
}

export type ShadowRuntime = ReturnType<typeof createShadowRuntime>;
