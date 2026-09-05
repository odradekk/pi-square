/**
 * The parent-only `wait_subagent` tool (odradekk/pi-square#277).
 *
 * The ordered, bounded consumer of claimed terminal results: one call claims
 * one to six current-session background runs — active ones before completion,
 * unsent completed and failed results from the pending store — waits until
 * every claimed run reaches a terminal state, then takes the complete set from
 * the delivery core and returns every entry in requested-ID order. Claimed
 * results are excluded from automatic delivery for as long as the claim is
 * held; interrupting the wait releases the claims without touching the
 * children, and released completed and failed results rejoin the automatic
 * schedule while aborted results leave delivery storage entirely.
 *
 * Wait state is memory-only and session-scoped: a session replacement, reload,
 * or shutdown terminates every outstanding wait and clears its claims.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { artifactsDirFor, isValidSubagentId } from "./artifacts";
import { ensureDeliveryController, subscribeBackgroundState } from "./background";
import { buildDeliveryContent, type SubagentDeliveryClaim, type SubagentDeliveryEntry, MAX_WAIT_IDS } from "./delivery";
import { clipWithHeadTail } from "./confirmed-delivery";
import { createSubagentError, failureToolResult } from "./errors";
import type {
  SubagentResultStatus,
  SubagentRunDetails,
  SubagentWaitDetails,
  SubagentWaitResult,
  SubagentWaitRunSummary,
} from "./types";
import type { SubagentRuntimeState } from "./tool";

/** Budget for the task line inside wait details; matches the delivery task line. */
export const MAX_WAIT_TASK_CHARS = 300;
/**
 * Budget for the bounded result/error evidence each wait entry carries in
 * details. The model-facing content keeps the established 24,000-character
 * budget; wait details are the bounded projection, so their evidence is
 * clipped separately with the same head/tail retention.
 */
export const MAX_WAIT_EVIDENCE_CHARS = 4_000;

const WAIT_FIELDS = new Set(["ids"]);

const WaitParams = Type.Object({
  ids: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_WAIT_IDS,
    description: `One to six public IDs of current-session background subagents, in the order the results should return.`,
  }),
}, { additionalProperties: false });

/** Normalizes and fully validates the ids request; a malformed request rejects
 * the whole call before any state is touched. Repeated IDs are silently
 * deduplicated while preserving first-occurrence order. */
export function normalizeWaitIds(params: any): { ids: string[] } | { error: ReturnType<typeof failureToolResult> } {
  const unknown = Object.keys(params ?? {}).filter((key) => !WAIT_FIELDS.has(key));
  if (unknown.length > 0) {
    return {
      error: failureToolResult(createSubagentError({
        code: "INVALID_ARGUMENT",
        message: `Unknown wait_subagent parameter(s): ${unknown.join(", ")}.`,
        operation: "wait",
        retryable: false,
      })),
    };
  }
  const raw = params?.ids;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_WAIT_IDS) {
    return {
      error: failureToolResult(createSubagentError({
        code: "INVALID_ARGUMENT",
        message: `ids must be an array of 1 to ${MAX_WAIT_IDS} subagent IDs.`,
        operation: "wait",
        retryable: false,
      })),
    };
  }
  for (const item of raw) {
    if (typeof item !== "string" || !isValidSubagentId(item.trim())) {
      return {
        error: failureToolResult(createSubagentError({
          code: "INVALID_ARGUMENT",
          message: `ids must contain public subagent IDs as returned by delegate_subagent or resume_subagent; '${String(item)}' is not one.`,
          operation: "wait",
          retryable: false,
        })),
      };
    }
  }
  const ids: string[] = [];
  for (const item of raw) {
    const id = item.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

/** Another waiter already owns this run's result. */
function claimedError(id: string | undefined) {
  return createSubagentError({
    code: "RESULT_CLAIMED",
    message: `Subagent '${id}' is already claimed by another wait_subagent call.`,
    operation: "wait",
    ...(id ? { id } : {}),
    retryable: true,
    suggestedAction: "Let the active wait consume the result, then wait again or resume the child.",
  });
}

/** The result was already sent for delivery and cannot be withdrawn. */
function sentError(id: string | undefined) {
  return createSubagentError({
    code: "RESULT_SENT",
    message: `Subagent '${id}' is already scheduled for automatic delivery, and a sent delivery cannot be withdrawn.`,
    operation: "wait",
    ...(id ? { id } : {}),
    retryable: true,
    suggestedAction: "Wait for the delivery to appear in the transcript instead of calling wait_subagent again.",
  });
}

/**
 * One claimed ID's eligibility: background jobs owned by the current parent
 * session are waitable while active or while an unsent result is pending.
 * Everything else rejects the complete request with its concrete reason and
 * safe next action.
 */
function checkEligibility(input: {
  state: SubagentRuntimeState;
  id: string;
  parentSessionId: string;
}): ReturnType<typeof failureToolResult> | undefined {
  const { state, id, parentSessionId } = input;
  const delivery = state.background.delivery;
  if (delivery?.isClaimed(id)) {
    return failureToolResult(claimedError(id));
  }

  const job = state.background.jobs.get(id);
  if (!job || job.details.lastParentSessionId !== parentSessionId) {
    // Background jobs survive a session replacement in-process, so ownership
    // is decided by the parent session identity: a job still carried from an
    // earlier parent session is as foreign as a persisted record on disk.
    const foreign = job !== undefined || existsSync(artifactsDirFor(id));
    return failureToolResult(createSubagentError({
      code: "SUBAGENT_NOT_FOUND",
      message: foreign
        ? `Subagent '${id}' belongs to another parent session; only current-session background runs can be waited on.`
        : `Subagent '${id}' is not a background subagent of the current session.`,
      operation: "wait",
      id,
      retryable: false,
      suggestedAction: "Use an ID returned by delegate_subagent or resume_subagent in this parent session.",
    }));
  }

  if (job.status === "queued" || job.status === "running" || job.status === "cancelling") return undefined;

  if (job.status === "aborted") {
    return failureToolResult(createSubagentError({
      code: "RESULT_UNAVAILABLE",
      message: `Subagent '${id}' finished aborted before this wait claimed it, so there is no result to wait for.`,
      operation: "wait",
      id,
      retryable: false,
      suggestedAction: "Inspect the run in the /subagent manager, or resume the child with a new task.",
    }));
  }

  if (!delivery?.isPending(id)) {
    return failureToolResult(createSubagentError({
      code: "RESULT_DELIVERED",
      message: `Subagent '${id}' has finished and its result is no longer pending; it was already delivered to the parent or cleared with the session.`,
      operation: "wait",
      id,
      retryable: false,
      suggestedAction: "Read the delivered completion in the transcript, or resume the child for new work.",
    }));
  }
  if (delivery.isSent(id)) {
    return failureToolResult(sentError(id));
  }
  return undefined;
}

/** Maps an atomic core claim failure onto its structured recovery action. */
function claimFailureResult(failure: { kind: string; id?: string; limit?: number }): ReturnType<typeof failureToolResult> {
  if (failure.kind === "already-claimed") return failureToolResult(claimedError(failure.id));
  if (failure.kind === "sent") return failureToolResult(sentError(failure.id));
  return failureToolResult(createSubagentError({
    code: "WAIT_CAPACITY",
    message: `The wait reservation bound of ${failure.limit} is reached, so no ID was claimed.`,
    operation: "wait",
    retryable: true,
    suggestedAction: "Let other wait_subagent calls consume their results, then retry.",
  }));
}

/** How the wait ended before every result was taken. */
export type WaitEndReason =
  | { kind: "interrupted" }
  | { kind: "terminated"; reason: string }
  | { kind: "lost"; id: string };

/** Session-scoped registry of outstanding waits: a session replacement, reload,
 * or shutdown terminates every one of them and the delivery reset clears their
 * memory-only claims. */
export interface SubagentWaitRegistry {
  /** Registers one outstanding wait; returns its unregister function. */
  register(wait: { end(reason: WaitEndReason): void }): () => void;
  /** Terminates every outstanding wait with the given reason. */
  terminateAll(reason: string): void;
}

export function createSubagentWaitRegistry(): SubagentWaitRegistry {
  const waits = new Set<{ end(reason: WaitEndReason): void }>();
  return {
    register(wait) {
      waits.add(wait);
      return () => waits.delete(wait);
    },
    terminateAll(reason) {
      const outstanding = [...waits];
      waits.clear();
      for (const wait of outstanding) {
        try {
          wait.end({ kind: "terminated", reason });
        } catch {
          // a terminating wait never blocks the session lifecycle
        }
      }
    },
  };
}

/** Resolves when every claimed ID holds a stored terminal result. Ends early
 * on an abort signal, a registry termination, or the run's job record
 * disappearing (its history was deleted while waiting). Deterministic: every
 * state, delivery, abort, and termination path wakes the loop explicitly. */
async function awaitClaimedResults(input: {
  state: SubagentRuntimeState;
  claim: SubagentDeliveryClaim;
  signal?: AbortSignal;
  registry: SubagentWaitRegistry;
}): Promise<WaitEndReason | undefined> {
  const { state, claim, registry } = input;
  let wake: () => void = () => {};
  let ended: WaitEndReason | undefined;

  const end = (reason: WaitEndReason) => {
    if (ended) return;
    ended = reason;
    wake();
  };
  const onStateChange = () => wake();
  const onAbort = () => end({ kind: "interrupted" });
  const wait = { end };

  let unregister: (() => void) | undefined;
  const unsubscribeState = subscribeBackgroundState(state.background, onStateChange);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  unregister = registry.register(wait);

  try {
    while (true) {
      if (ended) return ended;
      if (input.signal?.aborted) return { kind: "interrupted" };

      let complete = true;
      for (const id of claim.ids) {
        // A reservation this claim no longer owns (its history was deleted)
        // ends the wait deterministically instead of hanging.
        if (!claim.holds(id)) return { kind: "lost", id };
        const job = state.background.jobs.get(id);
        if (!job) return { kind: "lost", id };
        if (
          job.status !== "completed" && job.status !== "failed" && job.status !== "aborted"
        ) { complete = false; break; }
        if (!claim.result(id)) { complete = false; break; }
      }
      if (complete) return undefined;

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

function waitEndResult(reason: WaitEndReason, claim: SubagentDeliveryClaim): ReturnType<typeof failureToolResult> {
  if (reason.kind === "interrupted") {
    // The interruption releases every untaken claim without aborting any
    // child; deliverable results rejoin the automatic schedule.
    claim.release();
    return failureToolResult(createSubagentError({
      code: "ABORTED",
      message: "wait_subagent was interrupted: the claims were released without stopping the selected children, and unsent completed and failed results return to automatic delivery.",
      operation: "wait",
      retryable: false,
      suggestedAction: "Call wait_subagent again to re-claim the runs, or let their results arrive as background completions.",
    }));
  }
  if (reason.kind === "lost") {
    claim.release();
    return failureToolResult(createSubagentError({
      code: "SESSION_HISTORY_UNAVAILABLE",
      message: `The history of subagent '${reason.id}' was deleted while waiting, so its result can no longer be returned.`,
      operation: "wait",
      id: reason.id,
      retryable: false,
      suggestedAction: "Wait again for the remaining IDs, or delegate a fresh run.",
    }));
  }
  // A session replacement, reload, or shutdown already cleared the memory-only
  // claims together with the pending set, so the wait ends without releasing.
  return failureToolResult(createSubagentError({
    code: "ABORTED",
    message: `The wait was terminated by the parent session (${reason.reason}); its reservations were cleared with the session.`,
    operation: "wait",
    retryable: false,
    suggestedAction: "Delegate or wait again in the current session.",
  }));
}

/** Clips the task line for the bounded wait projection. */
function clipWaitTask(task: unknown): string {
  const normalized = String(task ?? "").trim();
  if (normalized.length <= MAX_WAIT_TASK_CHARS) return normalized;
  return `${normalized.slice(0, MAX_WAIT_TASK_CHARS - 3)}...`;
}

/**
 * The bounded per-run projection for wait details: identity, terminal
 * outcome, and evidence clipped to the wait budgets. The full V4 run record
 * — prompt snapshot, session paths, timeline, unbounded texts — never enters.
 */
export function buildWaitRunSummary(
  status: SubagentResultStatus,
  details: SubagentRunDetails,
): SubagentWaitRunSummary {
  return {
    id: details.id,
    operation: details.operation,
    status,
    task: clipWaitTask(details.task),
    startedAt: details.startedAt,
    endedAt: details.endedAt,
    durationMs: details.durationMs,
    result: status === "completed"
      ? clipWithHeadTail(details.finalText || "", MAX_WAIT_EVIDENCE_CHARS)
      : "",
    error: status === "completed"
      ? undefined
      : clipWithHeadTail(details.error || (status === "aborted" ? "Subagent run aborted." : "Subagent failed."), MAX_WAIT_EVIDENCE_CHARS),
    usage: details.usage,
    toolErrors: details.toolErrors?.length ?? 0,
    toolWarnings: details.toolWarnings?.length ?? 0,
  };
}

function buildWaitDetails(ids: string[], results: SubagentWaitResult[], waitedMs: number): SubagentWaitDetails {
  return {
    version: 1,
    ids: [...ids],
    results: results.map((entry) => ({
      id: entry.id,
      status: entry.status,
      run: entry.run,
    })),
    consumed: true,
    waitedMs: Math.max(0, waitedMs),
  };
}

export function registerWaitSubagentTool(
  pi: ExtensionAPI,
  state: SubagentRuntimeState,
  registry: SubagentWaitRegistry,
  decorate?: (definition: ToolDefinition<any, any, any>) => ToolDefinition<any, any, any>,
): void {
  const definition: ToolDefinition<any, any, any> = {
    name: "wait_subagent",
    label: "Subagent Wait",
    description: "Wait for one to six current-session background subagents to finish and return every terminal result together, in the requested id order. Active runs are claimed before completion; unsent completed and failed results are returned immediately. An id claimed by another wait or already scheduled for delivery is rejected.",
    promptSnippet: "Use wait_subagent with ids to join one to six background subagents and receive their terminal results in the requested order.",
    promptGuidelines: [
      "wait_subagent joins selected background runs and returns every terminal outcome in the requested id order; a failed or aborted entry marks the whole result as an error while completed siblings stay visible.",
      "Claim queued, running, or cancelling runs before they finish, or claim an unsent completed result to receive it immediately instead of waiting for the next automatic delivery.",
      "Interrupting wait_subagent releases its claims without stopping the children; unsent completed and failed results then arrive as ordinary background completions.",
    ],
    parameters: WaitParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const normalized = normalizeWaitIds(params);
      if ("error" in normalized) return normalized.error;
      const ids = normalized.ids;

      const delivery = ensureDeliveryController(pi, state.background);
      if (!delivery) {
        return failureToolResult(createSubagentError({
          code: "PERSISTENCE_FAILED",
          message: "The session delivery controller is unavailable.",
          operation: "wait",
          retryable: false,
        }));
      }

      // Only runs of the current parent session are waitable, so the session
      // identity is part of every eligibility decision.
      const parentSessionId = String(ctx?.sessionManager?.getSessionId?.() ?? "").trim();
      if (!parentSessionId) {
        return failureToolResult(createSubagentError({
          code: "PERSISTENCE_FAILED",
          message: "The parent Pi session has no stable session ID.",
          operation: "wait",
          retryable: false,
        }));
      }

      // The complete request is validated before any state changes: one
      // unknown, foreign, ineligible, claimed, or sent ID rejects the whole
      // call and nothing is claimed.
      for (const id of ids) {
        const failure = checkEligibility({ state, id, parentSessionId });
        if (failure) return failure;
      }
      const claimed = delivery.claim(ids);
      if (!claimed.ok) return claimFailureResult(claimed.failure);

      const startedAt = Date.now();
      const end = await awaitClaimedResults({ state, claim: claimed.claim, signal, registry });
      if (end) return waitEndResult(end, claimed.claim);

      const entries = claimed.claim.take();
      const results: SubagentWaitResult[] = ids.map((id, index) => {
        const entry: SubagentDeliveryEntry | undefined = entries[index];
        if (!entry) {
          throw createSubagentError({
            code: "SUBAGENT_FAILED",
            message: `The result of subagent '${id}' disappeared before the wait could take it.`,
            operation: "wait",
            id,
            retryable: false,
          });
        }
        // The model-facing content keeps the established full budgets; the
        // structured details carry only the bounded projection.
        return { id, status: entry.status, run: buildWaitRunSummary(entry.status, entry.details) };
      });

      const hasFailure = results.some((entry) => entry.status === "failed" || entry.status === "aborted");
      return {
        content: [{
          type: "text" as const,
          // The model-facing content uses the taken entries with their
          // established full budgets, in the same requested order.
          text: buildDeliveryContent(entries as SubagentDeliveryEntry[], false),
        }],
        details: buildWaitDetails(ids, results, Date.now() - startedAt),
        ...(hasFailure ? { isError: true as const } : {}),
      };
    },
  };
  pi.registerTool(decorate ? decorate(definition) : definition);
}

export const __testables = {
  normalizeWaitIds,
  checkEligibility,
};
