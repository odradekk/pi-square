/**
 * The parent-only `abort_subagent` tool (odradekk/pi-square#278).
 *
 * The wait-aware way to stop selected current-session background subagents:
 * one call validates one to six public IDs completely — one malformed, unknown,
 * or foreign ID rejects the whole call — then sends an abort signal to every
 * active target through the same cancellation seam the `/subagent` manager's
 * Cancel action uses, and waits until each active target has actually reached
 * a terminal state. Once an abort signal has linearized against an active job,
 * the background lifecycle resolves a simultaneous natural completion as
 * `aborted`; a target that was already terminal before the request keeps its
 * real state and is only reported.
 *
 * A successful abort request is a successful tool call: tool-level error is
 * reserved for request validation, ownership conflicts, and infrastructure
 * failures. Interrupting the tool's own wait never retracts abort signals that
 * were already sent, and abort never claims or consumes a result — a target
 * claimed by `wait_subagent` stays owned by that waiter, which receives the
 * aborted terminal outcome, while an ordinary aborted run still never enters
 * automatic delivery.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { artifactsDirFor } from "./artifacts";
import { cancelBackgroundJobs, type BackgroundJob, subscribeBackgroundState } from "./background";
import { budgetResultText, MAX_WAIT_IDS } from "./delivery";
import { clipWithHeadTail } from "./confirmed-delivery";
import { createSubagentError, failureToolResult } from "./errors";
import { normalizeSubagentIdsRequest, type SubagentWaitRegistry, type WaitEndReason } from "./wait";
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

/** How the abort wait ended before every target stopped. Abort never loses a
 * target — the job records are held by reference — so the wait's `lost` end
 * reason cannot occur here. */
type AbortEndReason = Exclude<WaitEndReason, { kind: "lost" }>;

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
  registry: SubagentWaitRegistry;
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
  // The registry only ever terminates outstanding waits; the wait's `lost`
  // end reason is mapped defensively so the abort end vocabulary stays closed.
  unregister = registry.register({
    end: (reason) => end(reason.kind === "lost" ? { kind: "interrupted" } : reason),
  });

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

/** The tool's own wait ended before every target stopped; the aborts stand. */
function abortEndResult(reason: AbortEndReason): ReturnType<typeof failureToolResult> {
  if (reason.kind === "interrupted") {
    return failureToolResult(createSubagentError({
      code: "ABORTED",
      message: "abort_subagent was interrupted: every abort signal already sent stays in effect, and the selected active runs continue to stop on their own.",
      operation: "abort",
      retryable: false,
      suggestedAction: "Check the /subagent manager or the background status for the final states instead of calling abort_subagent again.",
    }));
  }
  return failureToolResult(createSubagentError({
    code: "ABORTED",
    message: `The abort wait was terminated by the parent session (${reason.reason}); the abort signals already sent stay in effect.`,
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
    abortApplied: isActiveStatus(target.before),
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

/** Builds the model-facing content in requested order, within the established
 * result budgets; a completed target contributes its outcome only, never its
 * successful result text. */
export function buildAbortContent(summaries: SubagentAbortRunSummary[]): string {
  const entryLine = (summary: SubagentAbortRunSummary): string => {
    const applied = summary.abortApplied
      ? "abort applied"
      : `already ${summary.status} before the request`;
    return `--- ${summary.status} · id: ${summary.id} · before: ${summary.before} · ${applied}`;
  };
  const payload = (summary: SubagentAbortRunSummary): string[] => {
    if (summary.status === "aborted") return ["Aborted:", budgetResultText(summary.reason || "Subagent run aborted.")];
    if (summary.status === "failed") return ["Error:", budgetResultText(summary.error || "Subagent failed.")];
    return [];
  };

  if (summaries.length === 1) {
    const only = summaries[0]!;
    return [
      "[Background subagent abort]",
      `id: ${only.id}`,
      `state before: ${only.before}`,
      `abort applied: ${only.abortApplied ? "yes" : "no"}`,
      `outcome: ${only.status}`,
      ...payload(only),
    ].join("\n");
  }

  const lines = [`[Background subagent abort: ${summaries.length} targets]`];
  summaries.forEach((summary) => {
    lines.push("", entryLine(summary), ...payload(summary));
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
  registry: SubagentWaitRegistry,
  decorate?: (definition: ToolDefinition<any, any, any>) => ToolDefinition<any, any, any>,
): void {
  const definition: ToolDefinition<any, any, any> = {
    name: "abort_subagent",
    label: "Subagent Abort",
    description: "Stop one to six current-session background subagents and wait until the active ones have actually aborted. The complete selection is validated first; already-terminal targets keep their real state and are only reported. Returns a successful result for a successful abort request.",
    promptSnippet: "Use abort_subagent with ids to stop selected background subagents; it returns after the active targets reach aborted and reports each target's real terminal state.",
    promptGuidelines: [
      "abort_subagent stops selected background runs and returns only after the active ones have actually aborted; a target that already finished keeps its real terminal state in the report.",
      "A successful abort request is a successful result: an aborted target is the expected outcome, while an already-failed target is reported with its bounded error and an already-completed one without repeating its result.",
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

      // Abort signals are applied synchronously right after the complete
      // selection was validated, so no lifecycle transition can interleave and
      // make the batch partial. Once a signal has linearized against an active
      // job, the lifecycle resolves a simultaneous natural completion as
      // aborted, so abort wins that race.
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
        content: [{ type: "text" as const, text: buildAbortContent(summaries) }],
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
