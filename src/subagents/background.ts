import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { artifactsDirFor } from "./artifacts";
import type { ParentContextMessage } from "./context";
import type { SubagentDefinition } from "./definitions";
import { applyRunFailure, createSubagentError, normalizeSubagentError } from "./errors";
import { resumeSubagentTask, runSubagentTask } from "./session";
import type {
  ActiveSubagentConfig,
  BackgroundJobSnapshot,
  SubagentCancelDetails,
  SubagentNotificationDetails,
  SubagentPromptSnapshot,
  SubagentRunDetails,
  SubagentStatusDetails,
} from "./types";

/** Mutable runtime record for one session-owned background subagent job. */
export interface BackgroundJob {
  id: string;
  status: "queued" | "running" | "cancelling" | "done" | "error" | "aborted";
  createdAt: number;
  updatedAt: number;
  /** YAML definition used for routing and display, when the job is named. */
  definition?: SubagentDefinition;
  abortController: AbortController;
  /** Serializable run details mirrored into notifications and status output. */
  details: SubagentRunDetails;
}

/** Session-owned collection of background jobs and change notifications. */
export interface BackgroundState {
  jobs: Map<string, BackgroundJob>;
  onChange?: () => void;
  listeners: Set<() => void>;
}

const MAX_FINISHED_JOBS = 20;
const DEFAULT_CANCEL_REASON = "Background subagent job canceled.";

function clip(text: string, max = 800): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

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
  const finished = Array.from(state.jobs.values())
    .filter((job) => job.status === "done" || job.status === "error" || job.status === "aborted")
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const extra of finished.slice(MAX_FINISHED_JOBS)) {
    state.jobs.delete(extra.id);
  }
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
    operation: "bg",
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

function buildNotificationContent(job: BackgroundJob): string {
  const label = job.details.agent?.name ?? "generic";
  const summary = job.status === "done"
    ? clip(job.details.finalText || "(no output)", 1600)
    : clip(job.details.error || "Subagent failed.", 800);

  const lines = [
    `[Background subagent ${job.status}]`,
    `id: ${job.id}`,
    `agent: ${label}`,
    `task: ${clip(job.details.task, 300)}`,
    "",
    job.status === "done" ? "Result:" : "Error:",
    summary,
  ];

  return lines.join("\n");
}

function notifyCompletion(pi: ExtensionAPI, job: BackgroundJob): void {
  if (job.status !== "done" && job.status !== "error") return;

  const details: SubagentNotificationDetails = {
    id: job.id,
    status: job.status,
    result: job.details,
  };

  pi.sendMessage(
    {
      customType: "pi-square.subagent-notification",
      content: buildNotificationContent(job),
      display: true,
      details,
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
}

/** Creates the session-owned background job store for subagent runs. */
export function createBackgroundState(): BackgroundState {
  return { jobs: new Map(), listeners: new Set() };
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
      version: 3,
      id: input.id,
      mode: "bg",
      artifactsDir: artifactsDirFor(input.id),
      sessionFile: "",
      sessionId: "",
      originParentSessionId: input.parentSessionId,
      lastParentSessionId: input.parentSessionId,
      promptSnapshot: input.promptSnapshot,
      phase: "running",
      agent: buildAgentConfig(input.definition, input.modelOverride, input.effortOverride),
      task: input.task,
      cwd: input.cwd,
      model: requestedModel,
      startedAt: createdAt,
      finalText: "",
      retries: 0,
      toolErrors: [],
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
  const createdAt = now();
  const job: BackgroundJob = {
    id: input.details.id,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    abortController: new AbortController(),
    details: {
      ...input.details,
      mode: "resume",
      task: input.task,
      lastParentSessionId: input.parentSessionId,
      phase: "running",
      startedAt: createdAt,
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

/** Builds a serializable snapshot of queued, running, and finished jobs. */
export function getBackgroundStatusDetails(state: BackgroundState): SubagentStatusDetails {
  const jobs = Array.from(state.jobs.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((job) => snapshot(job));

  return {
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running" || job.status === "cancelling").length,
    finished: jobs.filter((job) => job.status === "done" || job.status === "error" || job.status === "aborted").length,
    jobs,
  };
}

/** Formats the compact status-line indicator for the current job counts. */
export function formatBackgroundIndicator(state: BackgroundState): string | null {
  const details = getBackgroundStatusDetails(state);
  if (details.jobs.length === 0) return null;

  const parts: string[] = [];
  if (details.queued > 0) parts.push(`queued ${details.queued}`);
  if (details.running > 0) parts.push(`running ${details.running}`);
  const cancelling = details.jobs.filter((job) => job.status === "cancelling").length;
  if (cancelling > 0) parts.push(`cancelling ${cancelling}`);

  const done = details.jobs.filter((job) => job.status === "done").length;
  const failed = details.jobs.filter((job) => job.status === "error").length;
  const aborted = details.jobs.filter((job) => job.status === "aborted").length;

  if (done > 0) parts.push(`✓ ${done}`);
  if (failed > 0) parts.push(`✗ ${failed}`);
  if (aborted > 0) parts.push(`× ${aborted}`);

  return parts.length > 0 ? parts.join(" ") : null;
}

/** Lists background jobs in the same ordering used by status reporting. */
export function listBackgroundJobs(state: BackgroundState): BackgroundJobSnapshot[] {
  return getBackgroundStatusDetails(state).jobs;
}

/** Requests cancellation for one job or all active background jobs. */
export function cancelBackgroundJobs(input: {
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
      job.abortController.abort();
      job.status = "aborted";
      job.updatedAt = now();
      ensureAbortedDetails(job, reason);
      details.canceled.push(snapshot(job));
      changed = true;
      continue;
    }
    if (job.status === "running") {
      job.status = "cancelling";
      job.details.phase = "cancelling";
      job.updatedAt = now();
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
  operation: "bg" | "resume";
  execute: (onUpdate: (partial: { details: SubagentRunDetails }) => void) => Promise<{ details: SubagentRunDetails }>;
}): void {
  const { pi, state, job } = input;
  void (async () => {
    if (jobWasAborted(job)) {
      ensureAbortedDetails(job, job.details.error || DEFAULT_CANCEL_REASON);
      job.updatedAt = now();
      compactFinishedJobs(state);
      emitChange(state);
      return;
    }

    job.status = "running";
    job.updatedAt = now();
    job.details.timeline.push({ kind: "status", text: "background subagent job started" });
    emitChange(state);

    const result = await input.execute((partial) => {
      if (jobWasAborted(job)) return;
      job.details = partial.details;
      job.updatedAt = now();
      emitChange(state);
    });
    job.details = result.details;
    job.updatedAt = now();

    if (jobWasAborted(job)) {
      job.status = "aborted";
      ensureAbortedDetails(job, job.details.error || DEFAULT_CANCEL_REASON);
      compactFinishedJobs(state);
      emitChange(state);
      return;
    }

    job.status = result.details.phase === "error" ? "error" : result.details.phase === "aborted" ? "aborted" : "done";
    compactFinishedJobs(state);
    emitChange(state);
    notifyCompletion(pi, job);
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    job.updatedAt = now();
    if (jobWasAborted(job)) {
      job.status = "aborted";
      ensureAbortedDetails(job, job.details.error || DEFAULT_CANCEL_REASON);
      compactFinishedJobs(state);
      emitChange(state);
      return;
    }

    job.status = "error";
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
    notifyCompletion(pi, job);
  });
}

export function startBackgroundJob(input: {
  pi: ExtensionAPI;
  state: BackgroundState;
  job: BackgroundJob;
  ctx: any;
  task: string;
  cwd?: string;
  inheritedSystemCore?: string;
  systemPrompt?: string;
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
    operation: "bg",
    execute: (onUpdate) => runSubagentTask({
      ctx: input.ctx,
      id: input.job.id,
      mode: "bg",
      task: input.task,
      parentSessionId: input.parentSessionId,
      contextMessages: input.contextMessages,
      cwd: input.cwd,
      inheritedSystemCore: input.inheritedSystemCore,
      systemPrompt: input.systemPrompt,
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
  parentSessionId: string;
}): void {
  startBackgroundLifecycle({
    pi: input.pi,
    state: input.state,
    job: input.job,
    operation: "resume",
    execute: (onUpdate) => resumeSubagentTask({
      ctx: input.ctx,
      id: input.job.id,
      task: input.task,
      parentSessionId: input.parentSessionId,
      signal: input.job.abortController.signal,
      onUpdate,
    }),
  });
}

export function abortAllBackgroundJobs(state: BackgroundState): void {
  cancelBackgroundJobs({
    state,
    all: true,
    reason: "Background subagent job aborted during session shutdown.",
  });
}
