/**
 * Reliable delivery of background subagent results to the parent session.
 *
 * Pi injects one queued steering message per turn boundary and drops every
 * queued message when the user interrupts a turn (`clearAllQueues`), while
 * `pi.sendMessage` is fire-and-forget and reports no failure to the caller. A
 * result that is sent once and forgotten can therefore disappear without any
 * trace. The generic mechanics — the bounded pending set, batch selection,
 * safe delivery timing, confirmation, resend, interruption suppression,
 * send-failure retention, and the atomic claim/take/release ownership
 * operations — live in `confirmed-delivery.ts`; this module is the Subagent
 * adapter: it supplies the run identity, the V5 notification payload with its
 * entry validation, the message construction, the transcript confirmation
 * parser, the wait-claim adapter, and the aborted-result policy that stores an
 * aborted run only for a waiter that already owns it.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clipWithHeadTail,
  createConfirmedDeliveryCore,
  type ConfirmedDeliveryClaim,
  type DeliveryClaimFailure,
  DEFAULT_MAX_BATCH_RESULTS,
  DEFAULT_MAX_CLAIM_RESERVATIONS,
  DEFAULT_MAX_PENDING_RESULTS,
} from "./confirmed-delivery";
import type {
  SubagentNotificationDetails,
  SubagentResultStatus,
  SubagentRunDetails,
} from "./types";
export const SUBAGENT_NOTIFICATION_TYPE = "pi-square.subagent-notification";

/** Model-facing budget for one result text. */
export const MAX_RESULT_CHARS = 24_000;
/** Results coalesced into a single delivery; the rest follow at the next one. */
export const MAX_BATCH_RESULTS = DEFAULT_MAX_BATCH_RESULTS;
/** Hard bound on the pending set so an unattended session stays bounded. */
export const MAX_PENDING_RESULTS = DEFAULT_MAX_PENDING_RESULTS;
/** Hard bound on simultaneously held explicit wait reservations. */
export const MAX_WAIT_RESERVATIONS = DEFAULT_MAX_CLAIM_RESERVATIONS;
/** Public IDs one wait_subagent call may select. */
export const MAX_WAIT_IDS = 6;
const MAX_TASK_CHARS = 300;

/** Statuses that flow through automatic delivery to the parent. */
export type DeliverableStatus = "completed" | "failed";

/** One finished run as the delivery core carries it. */
interface SubagentDeliveryValue {
  status: SubagentResultStatus;
  details: SubagentRunDetails;
}

/** One run rendered into a delivery message or an explicit wait result. */
export interface SubagentDeliveryEntry {
  id: string;
  status: SubagentResultStatus;
  details: SubagentRunDetails;
}

/** One fully validated result entry of a delivered V5 notification. */
export interface ValidatedNotificationEntry {
  id: string;
  status: DeliverableStatus;
  result: SubagentRunDetails;
}

/** Shape guard for a current V4 run record carried inside a payload. */
export function isV4RunDetails(value: unknown): value is SubagentRunDetails {
  const details = value as Partial<SubagentRunDetails> | undefined;
  return details?.version === 4
    && typeof details.id === "string"
    && (details.operation === "delegate" || details.operation === "resume")
    && (details.phase === "queued"
      || details.phase === "running"
      || details.phase === "cancelling"
      || details.phase === "completed"
      || details.phase === "failed"
      || details.phase === "aborted");
}

function validatedEntry(value: unknown): ValidatedNotificationEntry | undefined {
  const entry = value as { id?: unknown; status?: unknown; result?: unknown };
  if (!entry || typeof entry !== "object") return undefined;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) return undefined;
  if (entry.status !== "completed" && entry.status !== "failed") return undefined;
  if (!isV4RunDetails(entry.result) || entry.result.id !== id) return undefined;
  return { id, status: entry.status, result: entry.result };
}

/**
 * Parses the current V5 notification payload into its fully validated result
 * entries. A payload that is not V5, or whose results are not a list, yields
 * undefined. An entry contributes only when it is complete — a current
 * terminal status, a valid V4 run record, and an entry id that names that
 * record — so a malformed entry can neither confirm nor render as a run.
 */
export function parseV5NotificationDetails(details: unknown): ValidatedNotificationEntry[] | undefined {
  const payload = details as { version?: unknown; results?: unknown } | undefined;
  if (payload?.version !== 5 || !Array.isArray(payload.results)) return undefined;
  return payload.results
    .map((entry) => validatedEntry(entry))
    .filter((entry): entry is ValidatedNotificationEntry => entry !== undefined);
}

/** The Subagent adapter over one held claim of the delivery core. */
export interface SubagentDeliveryClaim {
  /** Reserved public IDs in the order the waiter requested them. */
  readonly ids: readonly string[];
  /** False once the claim was taken, released, or cleared by a reset. */
  readonly active: boolean;
  /**
   * True while this wait is the current owner of the run's result. Deleting
   * the run's history (manager delete-history) ends the reservation, so the
   * waiter wakes and ends deterministically instead of hanging.
   */
  holds(id: string): boolean;
  /** The stored result of one still-held run once it finished; the waiter's
   * completeness signal before it takes. */
  result(id: string): SubagentDeliveryEntry | undefined;
  /** Consumes every claimed result in request order; missing results yield undefined. */
  take(): (SubagentDeliveryEntry | undefined)[];
  /**
   * Gives up ownership. Completed and failed results stay in the store as
   * unsent automatic-delivery candidates; aborted results are removed from
   * delivery storage, because an aborted run that no waiter owns never
   * notifies the parent.
   */
  release(): void;
}

/** Why one explicit wait claim was rejected, with the offending public ID. */
export type SubagentClaimFailure = DeliveryClaimFailure;

export interface DeliveryController {
  /**
   * Registers one finished run. A completed or failed run enters the pending
   * store for automatic delivery; an aborted run is stored only while an
   * explicit waiter already owns its claim, and is dropped otherwise.
   */
  enqueue(input: { id: string; status: SubagentResultStatus; details: SubagentRunDetails }): void;
  /** Drops a result, for example when its history is deleted. */
  remove(id: string): void;
  /**
   * Atomically reserves a set of public IDs for one explicit waiter. An ID
   * already claimed by another waiter, or whose result was already sent for
   * delivery, rejects the complete request, as does a request that would
   * exceed the reservation bound.
   */
  claim(ids: string[]): { ok: true; claim: SubagentDeliveryClaim } | { ok: false; failure: SubagentClaimFailure };
  /** True while an explicit waiter owns this run's result. */
  isClaimed(id: string): boolean;
  /** True while this run's result was sent for delivery but not confirmed. */
  isSent(id: string): boolean;
  /** Confirms delivery from an injected parent message. */
  observeMessage(message: unknown): void;
  /** Turn boundary of a running parent; an aborted terminal message suppresses delivery. */
  handleTurnEnd(message?: unknown): void;
  /** A new parent run started, so an earlier interruption no longer holds. */
  handleAgentStart(): void;
  /** Records whether the finished run ended through a user interruption. */
  handleAgentEnd(messages: unknown): void;
  /** Parent is idle: unconfirmed results are lost and are delivered again. */
  handleAgentSettled(): void;
  /** True while the result of this run is not confirmed in the parent. */
  isPending(id: string): boolean;
  /** Count of results that the parent has not confirmed. */
  pendingCount(): number;
  /** IDs of results that the parent has not confirmed. */
  pendingIds(): string[];
  /** Clears all state on session start and shutdown. */
  reset(): void;
}

function normalize(text: unknown): string {
  return String(text ?? "").trim();
}

function clipTask(text: unknown): string {
  const normalized = normalize(text);
  if (normalized.length <= MAX_TASK_CHARS) return normalized;
  return `${normalized.slice(0, MAX_TASK_CHARS - 3)}...`;
}

/**
 * Applies the result budget. An oversized text keeps its head and its tail,
 * because a subagent report states its conclusion, confidence, and gaps at the
 * end. The omission marker is added to the kept text and is not counted in the
 * budget.
 */
export function budgetResultText(text: unknown, max: number = MAX_RESULT_CHARS): string {
  return clipWithHeadTail(text, max);
}

function agentLabel(result: SubagentDeliveryEntry): string {
  return result.details.agent?.name ?? "generic";
}

function resultText(result: SubagentDeliveryEntry): string {
  if (result.status === "completed") return budgetResultText(result.details.finalText || "(no output)");
  return budgetResultText(result.details.error || (result.status === "aborted" ? "Subagent run aborted." : "Subagent failed."));
}

function outcomeLabel(status: SubagentResultStatus): string {
  if (status === "completed") return "Result:";
  if (status === "aborted") return "Aborted:";
  return "Error:";
}

/** Builds the model-facing content of one delivery or explicit wait result. */
export function buildDeliveryContent(results: SubagentDeliveryEntry[], resent: boolean): string {
  const suffix = resent ? " (resent)" : "";
  if (results.length === 1) {
    const only = results[0]!;
    return [
      `[Background subagent ${only.status}]${suffix}`,
      `id: ${only.id}`,
      `agent: ${agentLabel(only)}`,
      `task: ${clipTask(only.details.task)}`,
      "",
      outcomeLabel(only.status),
      resultText(only),
    ].join("\n");
  }

  const lines = [`[Background subagents: ${results.length} results]${suffix}`];
  results.forEach((result, index) => {
    lines.push(
      "",
      `--- ${index + 1}/${results.length} ${result.status} · id: ${result.id} · agent: ${agentLabel(result)}`,
      `task: ${clipTask(result.details.task)}`,
      "",
      outcomeLabel(result.status),
      resultText(result),
    );
  });
  return lines.join("\n");
}

/** Reads the run IDs carried by a delivered V5 notification. Only fully valid
 * entries confirm, so a malformed payload never clears pending results. */
export function notificationResultIds(message: unknown): string[] {
  const candidate = message as { customType?: unknown; details?: unknown } | undefined;
  if (candidate?.customType !== SUBAGENT_NOTIFICATION_TYPE) return [];
  return parseV5NotificationDetails(candidate.details)?.map((entry) => entry.id) ?? [];
}

export function createDeliveryController(options: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  /** Reads the parent run state; a missing reader assumes an idle parent. */
  isIdle?: () => boolean;
  /** Refreshes pi-square status surfaces after a pending-set change. */
  notify?: () => void;
}): DeliveryController {
  let sequence = 0;
  const core = createConfirmedDeliveryCore<SubagentDeliveryValue>({
    send(batch, resent) {
      sequence += 1;
      const entries: SubagentDeliveryEntry[] = batch.map((entry) => ({
        id: entry.id,
        status: entry.value.status,
        details: entry.value.details,
      }));
      const details: SubagentNotificationDetails = {
        version: 5,
        deliveryId: `delivery-${sequence}`,
        resent,
        // Only completed and failed results ever sit unclaimed in the pending
        // set (an aborted result enters only while claimed, and claimed
        // entries are excluded from flush), so the automatic delivery path
        // always carries the deliverable statuses.
        results: entries.map((entry) => ({
          id: entry.id,
          status: entry.status as DeliverableStatus,
          result: entry.details,
        })),
      };
      options.pi.sendMessage(
        {
          customType: SUBAGENT_NOTIFICATION_TYPE,
          content: buildDeliveryContent(entries, resent),
          display: true,
          details,
        },
        {
          triggerTurn: true,
          deliverAs: "steer",
        },
      );
    },
    confirmIds: notificationResultIds,
    isIdle: options.isIdle,
    onPendingChange: options.notify,
  });

  function toEntry(id: string, value: SubagentDeliveryValue): SubagentDeliveryEntry {
    return { id, status: value.status, details: value.details };
  }

  return {
    enqueue(input) {
      // Aborted-result policy: an ordinary aborted run notifies nobody. A run
      // an explicit waiter already owns still enters the store, claimed and
      // therefore excluded from automatic delivery, so the waiter receives its
      // aborted outcome; if the waiter releases first, the entry is dropped.
      if (input.status === "aborted" && !core.isClaimed(input.id)) return;
      core.enqueue({ id: input.id, value: { status: input.status, details: input.details } });
    },
    remove: (id) => core.remove(id),
    claim(ids) {
      const result = core.claim(ids);
      if (!result.ok) return result;
      const inner: ConfirmedDeliveryClaim<SubagentDeliveryValue> = result.claim;
      return {
        ok: true,
        claim: {
          ids: inner.ids,
          get active() {
            return inner.active;
          },
          holds: (id) => inner.holds(id),
          result(id) {
            const value = inner.result(id);
            return value ? toEntry(id, value) : undefined;
          },
          take() {
            return inner.take().map((value, index) => (value ? toEntry(inner.ids[index]!, value) : undefined));
          },
          release() {
            inner.release((value) => value.status !== "aborted");
          },
        },
      };
    },
    isClaimed: (id) => core.isClaimed(id),
    isSent: (id) => core.isSent(id),
    observeMessage: (message) => core.observeMessage(message),
    handleTurnEnd: (message) => core.handleTurnEnd(message),
    handleAgentStart: () => core.handleAgentStart(),
    handleAgentEnd: (messages) => core.handleAgentEnd(messages),
    handleAgentSettled: () => core.handleAgentSettled(),
    isPending: (id) => core.isPending(id),
    pendingCount: () => core.pendingCount(),
    pendingIds: () => core.pendingIds(),
    reset: () => core.reset(),
  };
}
