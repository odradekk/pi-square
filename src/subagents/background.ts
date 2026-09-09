import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { artifactsDirFor } from "./artifacts";
import type { ParentContextMessage } from "./context";
import type { SubagentDefinition } from "./definitions";
import { applyRunFailure, createSubagentError, normalizeSubagentError } from "./errors";
import { type ChildViewEvent, type ChildViewFeed, createChildViewFeed } from "./live-events";
import { resumeSubagentTask, runSubagentTask } from "./session";
import { createDeliveryController, type DeliveryController } from "./delivery";
import type {
  ActiveSubagentConfig,
  BackgroundJobSnapshot,
  SubagentCancelDetails,
  SubagentOperation,
  SubagentPhase,
  SubagentPromptSnapshot,
  SubagentRunDetails,
} from "./types";

/** Mutable runtime record for one session-owned background subagent job. */
export interface BackgroundJob {
  id: string;
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "aborted";
  createdAt: number;
  updatedAt: number;
  /** YAML definition used for routing and display, when the job is named. */
  definition?: SubagentDefinition;
  abortController: AbortController;
  /** First explicit cancellation reason, retained until an active run terminalizes. */
  abortReason?: string;
  /** Serializable run details mirrored into notifications and status output. */
  details: SubagentRunDetails;
}

/** Session-owned collection of background jobs and change notifications. */
export interface BackgroundState {
  jobs: Map<string, BackgroundJob>;
  onChange?: () => void;
  listeners: Set<() => void>;
  /**
   * Owns the pending completion results and the explicit wait claims. It is
   * attached by the session registrar and otherwise created on the first
   * terminal completion when a Pi API is available; a state with neither
   * (headless unit-test lifecycles) has nowhere to deliver and keeps none.
   */
  delivery?: DeliveryController;
  /**
   * Session-scoped ephemeral live view feed (#306): ordered child view events
   * published by the running jobs and observed only by the roster controller's
   * open overlay. Delivery runs in its own scheduler tick through one bounded
   * queue; there is no persistence, and session replacement and shutdown
   * clear the feed.
   */
  viewFeed?: ChildViewFeed;
}

const MAX_FINISHED_JOBS = 20;
const DEFAULT_CANCEL_REASON = "Background subagent job canceled.";

function buildAgentConfig(definition?: SubagentDefinition, modelOverride?: string, effortOverride?: string): ActiveSubagentConfig {
  return {
    promptVersion: 2,
    name: definition?.name,
    model: modelOverride ?? definition?.model,
    effort: effortOverride ?? definition?.effort,
    description: definition?.description,
    source: definition?.source,
    filePath: definition?.filePath,
    inheritParentSystem: definition?.inheritParentSystem ?? true,
    tools: definition?.tools,
    extensionTools: definition?.extensionTools,
    skills: definition?.skills,
  };
}

function now(): number {
  return Date.now();
}

/** Maps a terminal run phase onto the job status vocabulary. */
function terminalStatusFromPhase(phase: SubagentPhase): BackgroundJob["status"] {
  if (phase === "failed" || phase === "aborted") return phase;
  return "completed";
}

function jobWasAborted(job: BackgroundJob): boolean {
  return job.status === "aborted" || job.status === "cancelling" || job.abortController.signal.aborted;
}

function emitChange(state: BackgroundState): void {
  try {
    state.onChange?.();
  } catch {
    // ignore UI/status refresh failures
  }
  for (const listener of state.listeners ?? []) {
    try {
      listener();
    } catch {
      // isolate display subscribers from execution
    }
  }
}

function compactFinishedJobs(state: BackgroundState): void {
  // A finished job whose result the parent has not received yet is exempt from
  // compaction: dropping it here would destroy the only copy of a result that
  // is still waiting for delivery or is owned by an explicit waiter. The
  // pending set has its own hard bound.
  const finished = Array.from(state.jobs.values())
    .filter((job) => job.status === "completed" || job.status === "failed" || job.status === "aborted")
    .filter((job) => !state.delivery?.isPending(job.id) && !state.delivery?.isClaimed(job.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const extra of finished.slice(MAX_FINISHED_JOBS)) {
    state.jobs.delete(extra.id);
  }
}

/** Refreshes pi-square status surfaces after an external state change. */
export function notifyBackgroundChange(state: BackgroundState): void {
  emitChange(state);
}

function ensureAbortedDetails(job: BackgroundJob, reason = DEFAULT_CANCEL_REASON): void {
  const endedAt = now();
  const timeline = [...job.details.timeline];
  const last = timeline[timeline.length - 1];
  if (!last || last.kind !== "error" || last.text !== reason) {
    timeline.push({ kind: "error", text: reason, isError: true });
  }
  const details = { ...job.details, timeline };
  applyRunFailure(details, createSubagentError({
    code: "ABORTED",
    message: reason,
    operation: job.details.operation,
    id: job.id,
    retryable: false,
    retries: details.retries,
  }));
  details.endedAt = endedAt;
  details.durationMs = endedAt - details.startedAt;
  details.liveText = "";
  job.details = details;
}

function snapshot(job: BackgroundJob): BackgroundJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    details: job.details,
  };
}

/**
 * Returns the session-owned delivery controller, creating it on first use so a
 * completion is never dropped for a missing session registration. A state with
 * neither an attached controller nor a Pi API (headless unit-test lifecycles)
 * has nowhere to deliver and receives none.
 */
export function ensureDeliveryController(pi: ExtensionAPI | undefined, state: BackgroundState): DeliveryController | undefined {
  if (state.delivery) return state.delivery;
  if (!pi) return undefined;
  state.delivery = createDeliveryController({
    pi,
    notify: () => emitChange(state),
  });
  return state.delivery;
}

/**
 * Hands one terminal run to the delivery controller, which owns budgeting,
 * coalescing, delivery timing, confirmation, re-delivery, and the
 * explicit-wait ownership policy. Completed and failed runs enter the pending
 * store for automatic delivery; an aborted run is stored only while a waiter
 * already owns its claim.
 */
function deliverCompletion(pi: ExtensionAPI | undefined, state: BackgroundState, job: BackgroundJob): void {
  if (job.status !== "completed" && job.status !== "failed" && job.status !== "aborted") return;

  const delivery = ensureDeliveryController(pi, state);
  delivery?.enqueue({
    id: job.id,
    status: job.status,
    details: job.details,
  });
}

/** Creates the session-owned background job store for subagent runs. */
export function createBackgroundState(): BackgroundState {
  return { jobs: new Map(), listeners: new Set(), viewFeed: createChildViewFeed() };
}

export function subscribeBackgroundState(state: BackgroundState, listener: () => void): () => void {
  state.listeners ??= new Set();
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** Registers a background task as queued and returns the mutable job record. */
export function createQueuedJob(input: {
  /** Background store that owns the queued job. */
  state: BackgroundState;
  id: string;
  task: string;
  cwd: string;
  /** Optional YAML definition used to label and configure the run. */
  definition?: SubagentDefinition;
  modelOverride?: string;
  effortOverride?: string;
  parentSessionId: string;
  promptSnapshot: SubagentPromptSnapshot;
}): BackgroundJob {
  const createdAt = now();
  const requestedModel = input.modelOverride ?? input.definition?.model;
  const job: BackgroundJob = {
    id: input.id,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    definition: input.definition,
    abortController: new AbortController(),
    details: {
      version: 4,
      id: input.id,
      operation: "delegate",
      artifactsDir: artifactsDirFor(input.id),
      sessionFile: "",
      sessionId: "",
      originParentSessionId: input.parentSessionId,
      lastParentSessionId: input.parentSessionId,
      promptSnapshot: input.promptSnapshot,
      phase: "queued",
      agent: buildAgentConfig(input.definition, input.modelOverride, input.effortOverride),
      task: input.task,
      cwd: input.cwd,
      model: requestedModel,
      startedAt: createdAt,
      finalText: "",
      retries: 0,
      toolErrors: [],
      toolWarnings: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      timeline: [{ kind: "status", text: "queued background subagent job" }],
    },
  };
  input.state.jobs.set(job.id, job);
  emitChange(input.state);
  return job;
}

export function createQueuedResumeJob(input: {
  state: BackgroundState;
  details: SubagentRunDetails;
  task: string;
  parentSessionId: string;
}): BackgroundJob {
  const queuedAt = now();
  // A retained public ID keeps its original roster position. Once compaction
  // removes the old record there is no visible slot left to preserve.
  const createdAt = input.state.jobs.get(input.details.id)?.createdAt ?? queuedAt;
  const job: BackgroundJob = {
    id: input.details.id,
    status: "queued",
    createdAt,
    updatedAt: queuedAt,
    abortController: new AbortController(),
    details: {
      ...input.details,
      operation: "resume",
      task: input.task,
      lastParentSessionId: input.parentSessionId,
      phase: "queued",
      startedAt: queuedAt,
      endedAt: undefined,
      durationMs: undefined,
      finalText: "",
      liveText: "",
      error: undefined,
      errorInfo: undefined,
      salvagedFinalText: undefined,
      streamingCompleted: false,
      rawSessionOutput: undefined,
      timeline: [...input.details.timeline, { kind: "status", text: "queued background resume" }],
    },
  };
  input.state.jobs.set(job.id, job);
  emitChange(input.state);
  return job;
}

/** Lists background jobs, most recently updated first. */
export function listBackgroundJobs(state: BackgroundState): BackgroundJobSnapshot[] {
  return Array.from(state.jobs.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((job) => snapshot(job));
}

/** Requests cancellation for one job or all active background jobs. */
export function cancelBackgroundJobs(input: {
  /** Pi API for the delivery controller; a state that already owns one does not need it. */
  pi?: ExtensionAPI;
  state: BackgroundState;
  id?: string;
  all?: boolean;
  reason?: string;
}): SubagentCancelDetails {
  const { state } = input;
  const reason = input.reason?.trim() || DEFAULT_CANCEL_REASON;
  const targets = input.all
    ? Array.from(state.jobs.values())
    : input.id
      ? [state.jobs.get(input.id)].filter(Boolean) as BackgroundJob[]
      : [];

  const details: SubagentCancelDetails = {
    canceled: [],
    alreadyFinished: [],
    notFound: [],
  };

  if (!input.all && input.id && targets.length === 0) {
    details.notFound.push(input.id);
    return details;
  }

  let changed = false;
  for (const job of targets) {
    if (job.status === "queued") {
      job.abortReason = reason;
      job.abortController.abort();
      job.status = "aborted";
      job.updatedAt = now();
      ensureAbortedDetails(job, reason);
      details.canceled.push(snapshot(job));
      changed = true;
      // A waiter that already claimed this run owns its aborted outcome; an
      // ordinary aborted run never notifies the parent.
      deliverCompletion(input.pi, state, job);
      continue;
    }
    if (job.status === "running") {
      job.status = "cancelling";
      job.details.phase = "cancelling";
      job.updatedAt = now();
      job.abortReason = reason;
      job.abortController.abort();
      details.canceled.push(snapshot(job));
      changed = true;
      continue;
    }
    if (job.status === "cancelling") {
      details.canceled.push(snapshot(job));
      continue;
    }

    details.alreadyFinished.push(snapshot(job));
  }

  if (changed) {
    compactFinishedJobs(state);
    emitChange(state);
  }

  return details;
}

function startBackgroundLifecycle(input: {
  pi: ExtensionAPI;
  state: BackgroundState;
  job: BackgroundJob;
  operation: SubagentOperation;
  execute: (onUpdate: (details: SubagentRunDetails) => void) => Promise<{ details: SubagentRunDetails }>;
}): void {
  const { pi, state, job } = input;
  void (async () => {
    if (jobWasAborted(job)) {
      ensureAbortedDetails(job, job.abortReason || job.details.error || DEFAULT_CANCEL_REASON);
      job.updatedAt = now();
      compactFinishedJobs(state);
      emitChange(state);
      // A waiter that already claimed this run owns its aborted outcome.
      deliverCompletion(pi, state, job);
      return;
    }

    job.status = "running";
    job.details.phase = "running";
    job.updatedAt = now();
    job.details.timeline.push({ kind: "status", text: "background subagent job started" });
    emitChange(state);

    const result = await input.execute((details) => {
      if (jobWasAborted(job)) return;
      job.details = details;
      job.updatedAt = now();
      emitChange(state);
    });
    job.details = result.details;
    job.updatedAt = now();

    if (jobWasAborted(job)) {
      job.status = "aborted";
      ensureAbortedDetails(job, job.abortReason || job.details.error || DEFAULT_CANCEL_REASON);
      compactFinishedJobs(state);
      emitChange(state);
      // A waiter that already claimed this run owns its aborted outcome.
      deliverCompletion(pi, state, job);
      return;
    }

    job.status = terminalStatusFromPhase(result.details.phase);
    compactFinishedJobs(state);
    emitChange(state);
    deliverCompletion(pi, state, job);
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    job.updatedAt = now();
    if (jobWasAborted(job)) {
      job.status = "aborted";
      ensureAbortedDetails(job, job.abortReason || job.details.error || DEFAULT_CANCEL_REASON);
      compactFinishedJobs(state);
      emitChange(state);
      // A waiter that already claimed this run owns its aborted outcome.
      deliverCompletion(pi, state, job);
      return;
    }

    job.status = "failed";
    const failure = normalizeSubagentError(error, {
      operation: input.operation,
      id: job.id,
      retries: job.details.retries,
    });
    applyRunFailure(job.details, failure);
    job.details.endedAt = now();
    job.details.durationMs = job.details.endedAt - job.details.startedAt;
    job.details.liveText = "";
    job.details.timeline = [...job.details.timeline, { kind: "error", text: message, isError: true }];
    compactFinishedJobs(state);
    emitChange(state);
    deliverCompletion(pi, state, job);
  });
}

export function startBackgroundJob(input: {
  pi: ExtensionAPI;
  state: BackgroundState;
  job: BackgroundJob;
  ctx: any;
  task: string;
  cwd?: string;
  anchoredEditing?: boolean;
  anchoredAutoRead?: boolean;
  inheritedSystemCore?: string;
  thinkingLevel?: string;
  modelOverride?: string;
  effortOverride?: string;
  definition?: SubagentDefinition;
  contextMessages?: ParentContextMessage[];
  parentSessionId: string;
}): void {
  startBackgroundLifecycle({
    pi: input.pi,
    state: input.state,
    job: input.job,
    operation: "delegate",
    execute: (onUpdate) => runSubagentTask({
      // Ephemeral live view events (#306): publication is synchronous fan-out
      // with isolated subscribers, and this guard keeps even a feed defect
      // from reaching the child run.
      onViewEvent: (event: ChildViewEvent) => {
        try {
          input.state.viewFeed?.publish(input.job.id, event);
        } catch {
          // The live view feed is observational only.
        }
      },
      ctx: input.ctx,
      id: input.job.id,
      task: input.task,
      anchoredEditing: input.anchoredEditing,
      anchoredAutoRead: input.anchoredAutoRead,
      parentSessionId: input.parentSessionId,
      contextMessages: input.contextMessages,
      cwd: input.cwd,
      inheritedSystemCore: input.inheritedSystemCore,
      thinkingLevel: input.thinkingLevel,
      definition: input.definition,
      modelOverride: input.modelOverride,
      effortOverride: input.effortOverride,
      signal: input.job.abortController.signal,
      onUpdate,
    }),
  });
}

export function startBackgroundResumeJob(input: {
  pi: ExtensionAPI;
  state: BackgroundState;
  job: BackgroundJob;
  ctx: any;
  task: string;
  anchoredEditing?: boolean;
  anchoredAutoRead?: boolean;
  parentSessionId: string;
  contextMessages?: ParentContextMessage[];
}): void {
  startBackgroundLifecycle({
    pi: input.pi,
    state: input.state,
    job: input.job,
    operation: "resume",
    execute: (onUpdate) => resumeSubagentTask({
      onViewEvent: (event: ChildViewEvent) => {
        try {
          input.state.viewFeed?.publish(input.job.id, event);
        } catch {
          // The live view feed is observational only.
        }
      },
      ctx: input.ctx,
      id: input.job.id,
      task: input.task,
      anchoredEditing: input.anchoredEditing,
      anchoredAutoRead: input.anchoredAutoRead,
      parentSessionId: input.parentSessionId,
      contextMessages: input.contextMessages,
      signal: input.job.abortController.signal,
      onUpdate,
    }),
  });
}

export function abortAllBackgroundJobs(pi: ExtensionAPI | undefined, state: BackgroundState): void {
  cancelBackgroundJobs({
    pi,
    state,
    all: true,
    reason: "Background subagent job aborted during session shutdown.",
  });
}
