/**
 * The parent-only `abort_subagent` tool (odradekk/pi-square#278).
 *
 * The wait-aware way to stop selected current-session background subagents:
 * one call validates one to six public IDs completely — one malformed, unknown,
 * or foreign ID rejects the whole call — then applies the cancellation seam
 * that the `/subagent` manager's Cancel action also uses and waits until every
 * active target has actually reached a terminal state. A queued target is
 * aborted outright and a running target moves to `cancelling` with its abort
 * signal fired by this request; a target that was already `cancelling` keeps
 * the signal its earlier cancellation applied, so this request sends no
 * duplicate signal and only waits for that stop to complete. Once an abort
 * signal has linearized against an active job, the background lifecycle
 * resolves a simultaneous natural completion as `aborted`; a target that was
 * already terminal before the request keeps its real state and is only
 * reported.
 *
 * A successful abort request is a successful tool call. Tool-level error marks
 * a request that was rejected (validation, ownership, infrastructure) or whose
 * terminal-state observation could not complete: when the tool's own wait is
 * interrupted or ended by a session replacement or shutdown, the request has
 * not observed every target's final state and reports that failure truthfully
 * — the abort signals already sent are never retracted. Abort never claims or
 * consumes a result: a target claimed by `wait_subagent` stays owned by that
 * waiter, which receives the aborted terminal outcome, while an ordinary
 * aborted run still never enters automatic delivery.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { artifactsDirFor } from "./artifacts";
import { cancelBackgroundJobs, type BackgroundJob, subscribeBackgroundState } from "./background";
import { budgetResultText, MAX_WAIT_IDS } from "./delivery";
import { clipWithHeadTail } from "./confirmed-delivery";
import { createSubagentError, failureToolResult } from "./errors";
import {
  normalizeSubagentIdsRequest,
  type BlockingCallEndReason,
  type SubagentBlockingCallRegistry,
} from "./wait";
import type {
  SubagentAbortDetails,
  SubagentAbortRunSummary,
  SubagentResultStatus,
} from "./types";
import type { SubagentRuntimeState } from "./tool";

/** Budget for the task line inside abort details; matches the delivery task line. */
export const MAX_ABORT_TASK_CHARS = 300;
/**
 * Budget for the bounded reason or failure evidence each abort entry carries
 * in details, matching the wait projection. The model-facing content keeps the
 * established 24,000-character delivery budget instead.
 */
export const MAX_ABORT_EVIDENCE_CHARS = 4_000;

/** The abort reason recorded on runs stopped through this tool. */
export const ABORT_SUBAGENT_REASON = "Background subagent job aborted through abort_subagent.";

const AbortParams = Type.Object({
  ids: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_WAIT_IDS,
    description: "One to six public IDs of current-session background subagents to stop.",
  }),
}, { additionalProperties: false });

/** Normalizes and fully validates the abort ids request. */
export function normalizeAbortIds(params: any): { ids: string[] } | { error: ReturnType<typeof failureToolResult> } {
  return normalizeSubagentIdsRequest(params, { toolName: "abort_subagent", operation: "abort" });
}

/** One selected run: its job record held by reference and its pre-request state. */
interface AbortTarget {
  id: string;
  job: BackgroundJob;
  before: BackgroundJob["status"];
}

function isActiveStatus(status: BackgroundJob["status"]): boolean {
  return status === "queued" || status === "running" || status === "cancelling";
}

/**
 * Whether this request fired the abort signal through the cancellation seam,
 * exactly as the seam behaves: a queued target is aborted outright and a
 * running target moves to cancelling with its signal fired, so both receive an
 * abort from this request. An already-cancelling target keeps the signal its
 * earlier cancellation applied — the seam's cancelling branch sends no new
 * signal — so this request truthfully reports that it applied none and only
 * waited for the stop to finish. The value never follows from "before was
 * active" alone.
 */
function abortAppliedByRequest(before: BackgroundJob["status"]): boolean {
  return before === "queued" || before === "running";
}

function isTerminalStatus(status: BackgroundJob["status"]): status is SubagentResultStatus {
  return status === "completed" || status === "failed" || status === "aborted";
}

/**
 * Resolves one abort target. Only background jobs owned by the current parent
 * session are abortable — the boundary is the parent session identity, exactly
 * as for waiting, so a job carried from an earlier parent session is as foreign
 * as a persisted record on disk. Terminal targets are valid: they are reported
 * truthfully instead of aborted again.
 */
function resolveAbortTarget(input: {
  state: SubagentRuntimeState;
  id: string;
  parentSessionId: string;
}): AbortTarget | ReturnType<typeof failureToolResult> {
  const { state, id, parentSessionId } = input;
  const job = state.background.jobs.get(id);
  if (!job || job.details.lastParentSessionId !== parentSessionId) {
    const foreign = job !== undefined || existsSync(artifactsDirFor(id));
    return failureToolResult(createSubagentError({
      code: "SUBAGENT_NOT_FOUND",
      message: foreign
        ? `Subagent '${id}' belongs to another parent session; only current-session background runs can be aborted.`
        : `Subagent '${id}' is not a background subagent of the current session.`,
      operation: "abort",
      id,
      retryable: false,
      suggestedAction: "Use an ID returned by delegate_subagent or resume_subagent in this parent session.",
    }));
  }
  return { id, job, before: job.status };
}

/** How the abort wait ended before every target stopped. */
type AbortEndReason = { kind: "interrupted" } | BlockingCallEndReason;

/**
 * Resolves when every aborted job reaches a terminal state. Ends early on an
 * abort signal or a registry termination, both of which leave the abort
 * signals in effect. Deterministic: every lifecycle transition wakes the loop
 * explicitly through the background state listeners. The job records are held
 * by reference, so a history deletion or job compaction cannot strand the wait.
 */
async function awaitAbortTargets(input: {
  state: SubagentRuntimeState;
  jobs: BackgroundJob[];
  signal?: AbortSignal;
  registry: SubagentBlockingCallRegistry;
}): Promise<AbortEndReason | undefined> {
  const { state, jobs, registry } = input;
  let wake: () => void = () => {};
  let ended: AbortEndReason | undefined;

  const end = (reason: AbortEndReason) => {
    if (ended) return;
    ended = reason;
    wake();
  };
  const onStateChange = () => wake();
  const onAbort = () => end({ kind: "interrupted" });

  let unregister: (() => void) | undefined;
  const unsubscribeState = subscribeBackgroundState(state.background, onStateChange);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  unregister = registry.register({ end });

  try {
    while (true) {
      if (ended) return ended;
      if (input.signal?.aborted) return { kind: "interrupted" };

      if (jobs.every((job) => isTerminalStatus(job.status))) return undefined;

      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    unsubscribeState();
    input.signal?.removeEventListener("abort", onAbort);
    unregister?.();
  }
}

/**
 * The tool's own wait ended before every active target reached a terminal
 * state, so the request could not complete its terminal-state observation and
 * reports that failure as a tool error. The aborts already applied through the
 * seam stand and are never retracted.
 */
function abortEndResult(reason: AbortEndReason): ReturnType<typeof failureToolResult> {
  if (reason.kind === "interrupted") {
    return failureToolResult(createSubagentError({
      code: "ABORTED",
      message: "abort_subagent was interrupted before every selected active target reached a terminal state, so their final states were not observed; every abort signal already sent stays in effect and the runs continue to stop on their own.",
      operation: "abort",
      retryable: false,
      suggestedAction: "Check the /subagent manager or the background status for the final states instead of calling abort_subagent again.",
    }));
  }
  return failureToolResult(createSubagentError({
    code: "ABORTED",
    message: `The abort wait was terminated by the parent session (${reason.reason}) before every selected active target reached a terminal state, so their final states were not observed; the abort signals already sent stay in effect.`,
    operation: "abort",
    retryable: false,
    suggestedAction: "Check the /subagent manager or the background status for the final states in the current session.",
  }));
}

/** Clips the task line for the bounded abort projection. */
function clipAbortTask(task: unknown): string {
  const normalized = String(task ?? "").trim();
  if (normalized.length <= MAX_ABORT_TASK_CHARS) return normalized;
  return `${normalized.slice(0, MAX_ABORT_TASK_CHARS - 3)}...`;
}

/**
 * The bounded per-target projection for abort details. A completed target
 * never repeats its successful result — abort is not a second
 * result-consumption path — while failed and aborted targets keep their
 * bounded failure and abort reasons.
 */
export function buildAbortRunSummary(target: AbortTarget): SubagentAbortRunSummary {
  const { job } = target;
  const status = isTerminalStatus(job.status) ? job.status : "aborted";
  return {
    id: target.id,
    before: target.before,
    status,
    abortApplied: abortAppliedByRequest(target.before),
    ...(status === "aborted"
      ? { reason: clipWithHeadTail(job.details.error || "Subagent run aborted.", MAX_ABORT_EVIDENCE_CHARS) }
      : {}),
    ...(status === "failed"
      ? { error: clipWithHeadTail(job.details.error || "Subagent failed.", MAX_ABORT_EVIDENCE_CHARS) }
      : {}),
    task: clipAbortTask(job.details.task),
    startedAt: job.details.startedAt,
    endedAt: job.details.endedAt,
    durationMs: job.details.durationMs,
  };
}

/** The terminal outcome a target reached, read from its live job record. */
function targetStatus(target: AbortTarget): SubagentResultStatus {
  return isTerminalStatus(target.job.status) ? target.job.status : "aborted";
}

/** How this request acted on one target, in one bounded phrase. */
function appliedLabel(target: AbortTarget): string {
  if (abortAppliedByRequest(target.before)) return "abort applied";
  if (target.before === "cancelling") return "already cancelling, no new signal";
  return `already ${targetStatus(target)} before the request`;
}

/**
 * Builds the model-facing content in requested order directly from the live
 * job records, so a failed target's error keeps the established 24,000-result
 * character budget with head/tail retention — the 4,000-character details
 * projection is never the source. A completed target contributes its outcome
 * only, never its successful result text.
 */
export function buildAbortContent(targets: AbortTarget[]): string {
  const entryLine = (target: AbortTarget): string => {
    return `--- ${targetStatus(target)} · id: ${target.id} · before: ${target.before} · ${appliedLabel(target)}`;
  };
  const payload = (target: AbortTarget): string[] => {
    const status = targetStatus(target);
    if (status === "aborted") {
      return ["Aborted:", budgetResultText(target.job.details.error || "Subagent run aborted.")];
    }
    if (status === "failed") {
      return ["Error:", budgetResultText(target.job.details.error || "Subagent failed.")];
    }
    return [];
  };

  if (targets.length === 1) {
    const only = targets[0]!;
    return [
      "[Background subagent abort]",
      `id: ${only.id}`,
      `state before: ${only.before}`,
      `abort: ${appliedLabel(only)}`,
      `outcome: ${targetStatus(only)}`,
      ...payload(only),
    ].join("\n");
  }

  const lines = [`[Background subagent abort: ${targets.length} targets]`];
  targets.forEach((target) => {
    lines.push("", entryLine(target), ...payload(target));
  });
  return lines.join("\n");
}

function buildAbortDetails(ids: string[], summaries: SubagentAbortRunSummary[], waitedMs: number): SubagentAbortDetails {
  return {
    version: 1,
    ids: [...ids],
    results: summaries,
    waitedMs: Math.max(0, waitedMs),
  };
}

export function registerAbortSubagentTool(
  pi: ExtensionAPI,
  state: SubagentRuntimeState,
  registry: SubagentBlockingCallRegistry,
  decorate?: (definition: ToolDefinition<any, any, any>) => ToolDefinition<any, any, any>,
): void {
  const definition: ToolDefinition<any, any, any> = {
    name: "abort_subagent",
    label: "Subagent Abort",
    description: "Stop one to six current-session background subagents and wait until the active ones have actually aborted. The complete selection is validated first; a queued or running target receives this request's abort signal, an already-cancelling target is waited on without a duplicate signal, and an already-terminal target keeps its real state and is only reported. Returns a successful result for a successful abort request; an error means the request was rejected or its terminal-state observation did not complete.",
    promptSnippet: "Use abort_subagent with ids to stop selected background subagents; it returns after the active targets reach aborted and reports each target's real terminal state.",
    promptGuidelines: [
      "abort_subagent stops selected background runs and returns only after the active ones have actually aborted; a queued or running target receives this request's abort signal, an already-cancelling one is joined without a duplicate signal, and a target that already finished keeps its real terminal state in the report.",
      "A successful abort request is a successful result: an aborted target is the expected outcome, while an already-failed target is reported with its bounded error and an already-completed one without repeating its result. An error means the request was rejected or its wait ended before every final state was observed.",
      "Aborting does not consume results: a run claimed by wait_subagent stays owned by that waiter, which receives the aborted outcome, and an ordinary aborted run never notifies the parent.",
    ],
    parameters: AbortParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const normalized = normalizeAbortIds(params);
      if ("error" in normalized) return normalized.error;
      const ids = normalized.ids;

      // Only runs of the current parent session are abortable, so the session
      // identity is part of every ownership decision.
      const parentSessionId = String(ctx?.sessionManager?.getSessionId?.() ?? "").trim();
      if (!parentSessionId) {
        return failureToolResult(createSubagentError({
          code: "PERSISTENCE_FAILED",
          message: "The parent Pi session has no stable session ID.",
          operation: "abort",
          retryable: false,
        }));
      }

      // The complete selection is validated before any abort signal is sent:
      // one malformed, unknown, or foreign ID rejects the whole call and
      // nothing is aborted.
      const targets: AbortTarget[] = [];
      for (const id of ids) {
        const target = resolveAbortTarget({ state, id, parentSessionId });
        if ("content" in target) return target;
        targets.push(target);
      }

      // The cancellation seam is applied synchronously right after the
      // complete selection was validated, so no lifecycle transition can
      // interleave and make the batch partial. The seam fires this request's
      // abort signal for queued and running targets; an already-cancelling
      // target is acknowledged without a duplicate signal, keeping only the
      // wait. Once a signal has linearized against an active job, the
      // lifecycle resolves a simultaneous natural completion as aborted, so
      // abort wins that race.
      const active = targets.filter((target) => isActiveStatus(target.before));
      for (const target of active) {
        cancelBackgroundJobs({ pi, state: state.background, id: target.id, reason: ABORT_SUBAGENT_REASON });
      }

      let waitedMs = 0;
      if (active.length > 0) {
        const startedAt = Date.now();
        const end = await awaitAbortTargets({
          state,
          jobs: active.map((target) => target.job),
          signal,
          registry,
        });
        if (end) return abortEndResult(end);
        waitedMs = Date.now() - startedAt;
      }

      const summaries = targets.map((target) => buildAbortRunSummary(target));
      return {
        // The model-facing content is built from the live job records so the
        // failed-error budget stays the established delivery budget; the
        // structured details keep the bounded 4,000-character projection.
        content: [{ type: "text" as const, text: buildAbortContent(targets) }],
        details: buildAbortDetails(ids, summaries, waitedMs),
      };
    },
  };
  pi.registerTool(decorate ? decorate(definition) : definition);
}

export const __testables = {
  normalizeAbortIds,
  resolveAbortTarget,
};
