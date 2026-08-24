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

import { randomUUID } from "node:crypto";
import {
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ShadowMindsConfig } from "../core/config";
import {
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
import { buildShadowUserPrompt, type ShadowTrajectory } from "./prompt";
import {
  createShadowInbox,
  createSubmitShadowResultTool,
  SUBMIT_SHADOW_RESULT_TOOL,
  type ShadowResultEntity,
} from "./result";

export const SHADOW_MANUAL_NOTE_MAX_CHARS = 8_000;

/** Terminal-run history retained for manager observation. */
const RUN_HISTORY_MAX = 50;
const RUN_MESSAGE_MAX_CHARS = 200;

export type ShadowRunPhase =
  | "running"
  | "submitted"
  | "silent"
  | "cancelled"
  | "timeout"
  | "max_turns"
  | "max_tool_calls"
  | "error";

export interface ShadowRunView {
  id: string;
  shadowId: string;
  shadowName: string;
  trigger: "manual";
  phase: ShadowRunPhase;
  startedAt: number;
  endedAt?: number;
  note?: string;
  model?: string;
  /** Bounded terminal explanation; present for error phases. */
  message?: string;
  usage?: ChildSessionUsage;
  resultId?: string;
}

export interface ShadowModelResolution {
  /** Resolved model object handed to the child session. */
  model?: any;
  /** `provider/id` label for records when the object does not report one. */
  label?: string;
  /** Explicit-model failure; the run never starts and never falls back. */
  error?: string;
}

export interface ShadowManualRunRequest {
  definition: EffectiveShadowDefinition;
  note?: string;
  system: string;
  trajectory: ShadowTrajectory;
  cwd: string;
  modelResolution?: ShadowModelResolution;
  thinkingLevel?: string;
}

export interface ShadowRuntimeSnapshot {
  runs: ShadowRunView[];
  results: ShadowResultEntity[];
}

/** Child-session creation input for the runtime seam; the system rides on the loader. */
export interface ShadowChildSessionInput {
  cwd: string;
  system: string;
  model?: any;
  thinkingLevel?: string;
  tools: string[];
  customTools: ToolDefinition<any, any, any>[];
}

export interface ShadowRuntimeDeps {
  now(): number;
  makeRunId?(): string;
  makeResultId?(): string;
  createSession(input: ShadowChildSessionInput): Promise<OneTimeChildSessionHandle>;
  runSession(input: OneTimeChildSessionRunInput): Promise<OneTimeChildSessionOutcome>;
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
      });
    },
    runSession: runOneTimeChildSession,
  };
}

interface ActiveRun {
  view: ShadowRunView;
  cancel(force?: boolean): void;
  /** Set when the session scope ended before the run settled. */
  detached?: boolean;
}

export type ManualRunStart =
  | { started: false; reason: string }
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
}) {
  const deps = input.deps ?? createShadowRuntimeDeps();
  let runSequence = 0;
  let resultSequence = 0;
  const inbox = createShadowInbox({
    makeId: deps.makeResultId ?? (() => `shr-${(++resultSequence).toString(36)}`),
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
    if (active.length >= effective.defaults.maxConcurrentRuns) {
      return {
        started: false,
        reason: `All ${effective.defaults.maxConcurrentRuns} Shadow run slots are busy; cancel a run or wait for one to settle.`,
      };
    }

    const { definition: requestDefinition } = request;
    const definition = structuredClone(requestDefinition);
    const startedAt = deps.now();
    const view: ShadowRunView = {
      id: deps.makeRunId?.() ?? `run-${(++runSequence).toString(36)}`,
      shadowId: definition.id,
      shadowName: definition.name,
      trigger: "manual",
      phase: "running",
      startedAt,
      ...(note ? { note } : {}),
      ...(request.modelResolution?.label ? { model: request.modelResolution.label } : {}),
    };

    let abortReason: "cancelled" | "timeout" | "max_turns" | "max_tool_calls" | undefined;
    let submitted: { payload: unknown; at: number } | undefined;
    const controller = new AbortController();
    const usage = createChildSessionUsage();
    const forceAbort = (reason: "cancelled" | "timeout" | "max_turns" | "max_tool_calls") => {
      abortReason ??= reason;
      controller.abort();
    };
    const run: ActiveRun = {
      view,
      cancel(force = false) {
        if (submitted && !force) return;
        forceAbort("cancelled");
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

      const onEvent = (event: any) => {
        if (event?.type === "turn_start") {
          if (!submitted && !abortReason && usage.turns >= maxTurns) {
            forceAbort("max_turns");
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
        ...(note ? { note } : {}),
      });

      let outcome: OneTimeChildSessionOutcome;
      try {
        const creation = deps.createSession({
          cwd: request.cwd,
          system: request.system,
          model: request.modelResolution?.model,
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
          tools: [SUBMIT_SHADOW_RESULT_TOOL],
          customTools: [tool],
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
        const entity = inbox.add({
          shadowId: definition.id,
          shadowName: definition.name,
          payload: submitted.payload,
          ...(note ? { note } : {}),
          createdAt: submitted.at,
          ...(outcome.model ? { model: outcome.model } : {}),
          usage: outcome.usage,
        });
        resultId = entity.id;
      }

      view.phase = phase;
      view.endedAt = deps.now();
      view.usage = outcome.usage;
      if (outcome.model) view.model = outcome.model;
      if (message) view.message = message;
      if (resultId) view.resultId = resultId;

      const activeIndex = active.indexOf(run);
      if (activeIndex >= 0) active.splice(activeIndex, 1);
      if (!run.detached) {
        history.unshift({ ...view });
        if (history.length > RUN_HISTORY_MAX) history.length = RUN_HISTORY_MAX;
      }
      notify();
      return { ...view };
    })();

    return { started: true, runId: view.id, done };
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
    };
  }

  return {
    startManualRun,
    cancelRun,
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
    subscribe(listener: () => void): () => void {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    /** Aborts every active run and clears session-scoped state. */
    reset(_reason: string) {
      sessionEpoch += 1;
      runSequence = 0;
      resultSequence = 0;
      const staleRuns = active.splice(0);
      for (const run of staleRuns) {
        run.detached = true;
        run.cancel(true);
      }
      history.length = 0;
      inbox.clear();
      notify();
    },
  };
}

export type ShadowRuntime = ReturnType<typeof createShadowRuntime>;
