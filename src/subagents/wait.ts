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
import { buildDeliveryContent, MAX_WAIT_IDS, type SubagentDeliveryClaim } from "./delivery";
import { createSubagentError, failureToolResult } from "./errors";
import type { SubagentWaitDetails, SubagentWaitResult } from "./types";
import type { SubagentRuntimeState } from "./tool";

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

/** One claimed ID's eligibility: current-session background jobs are waitable
 * while active or while an unsent result is pending. Everything else rejects
 * the complete request with its concrete reason and safe next action. */
function checkEligibility(input: {
  state: SubagentRuntimeState;
  id: string;
}): ReturnType<typeof failureToolResult> | undefined {
  const { state, id } = input;
  const delivery = state.background.delivery;
  if (delivery?.isClaimed(id)) {
    return failureToolResult(createSubagentError({
      code: "RESULT_CLAIMED",
      message: `Subagent '${id}' is already claimed by another wait_subagent call.`,
      operation: "wait",
      id,
      retryable: true,
      suggestedAction: "Let the active wait consume the result, then wait again or resume the child.",
    }));
  }

  const job = state.background.jobs.get(id);
  if (!job) {
    // A persisted record that exists on disk belongs to another parent
    // session; everything else is simply unknown to this session.
    const persisted = existsSync(artifactsDirFor(id));
    return failureToolResult(createSubagentError({
      code: "SUBAGENT_NOT_FOUND",
      message: persisted
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
    return failureToolResult(createSubagentError({
      code: "RESULT_SENT",
      message: `Subagent '${id}' is already scheduled for automatic delivery, and a sent delivery cannot be withdrawn.`,
      operation: "wait",
      id,
      retryable: true,
      suggestedAction: "Wait for the delivery to appear in the transcript instead of calling wait_subagent again.",
    }));
  }
  return undefined;
}

/** Maps an atomic core claim failure onto its structured recovery action. */
function claimFailureResult(failure: { kind: string; id?: string; limit?: number }): ReturnType<typeof failureToolResult> {
  if (failure.kind === "already-claimed") {
    return failureToolResult(createSubagentError({
      code: "RESULT_CLAIMED",
      message: `Subagent '${failure.id}' is already claimed by another wait_subagent call.`,
      operation: "wait",
      id: failure.id,
      retryable: true,
      suggestedAction: "Let the active wait consume the result, then wait again or resume the child.",
    }));
  }
  if (failure.kind === "sent") {
    return failureToolResult(createSubagentError({
      code: "RESULT_SENT",
      message: `Subagent '${failure.id}' is already scheduled for automatic delivery, and a sent delivery cannot be withdrawn.`,
      operation: "wait",
      id: failure.id,
      retryable: true,
      suggestedAction: "Wait for the delivery to appear in the transcript instead of calling wait_subagent again.",
    }));
  }
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

function buildWaitDetails(ids: string[], results: SubagentWaitResult[], waitedMs: number): SubagentWaitDetails {
  return {
    version: 1,
    ids: [...ids],
    results: results.map((entry) => ({
      id: entry.id,
      status: entry.status,
      result: entry.result,
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
    async execute(_toolCallId, params: any, signal, _onUpdate, _ctx) {
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

      // The complete request is validated before any state changes: one
      // unknown, foreign, ineligible, claimed, or sent ID rejects the whole
      // call and nothing is claimed.
      for (const id of ids) {
        const failure = checkEligibility({ state, id });
        if (failure) return failure;
      }
      const claimed = delivery.claim(ids);
      if (!claimed.ok) return claimFailureResult(claimed.failure);

      const startedAt = Date.now();
      const end = await awaitClaimedResults({ state, claim: claimed.claim, signal, registry });
      if (end) return waitEndResult(end, claimed.claim);

      const entries = claimed.claim.take();
      const results: SubagentWaitResult[] = ids.map((id, index) => {
        const entry = entries[index];
        if (!entry) {
          throw createSubagentError({
            code: "SUBAGENT_FAILED",
            message: `The result of subagent '${id}' disappeared before the wait could take it.`,
            operation: "wait",
            id,
            retryable: false,
          });
        }
        return { id, status: entry.status, result: entry.details };
      });

      const hasFailure = results.some((entry) => entry.status === "failed" || entry.status === "aborted");
      return {
        content: [{
          type: "text" as const,
          text: buildDeliveryContent(
            results.map((entry) => ({ id: entry.id, status: entry.status, details: entry.result })),
            false,
          ),
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
