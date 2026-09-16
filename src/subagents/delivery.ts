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
 * delivery policy bound to that core (odradekk/pi-square#372): which finished
 * runs enter the store, how one batch renders as a V5 notification, how a
 * transcript message confirms, and how a released result is routed. Callers
 * hold the policy-parameterized core; nothing here redeclares a core member.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clipWithHeadTail,
  createConfirmedDeliveryCore,
  type ConfirmedDeliveryClaim,
  type ConfirmedDeliveryCore,
  type DeliveryClaimFailure,
} from "./confirmed-delivery";
import type { SubagentNotificationDetails, SubagentResultStatus } from "./notification-types";
import type { SubagentRunDetails } from "./run-types";

export const SUBAGENT_NOTIFICATION_TYPE = "pi-square.subagent-notification";

/** Model-facing budget for one result text. */
export const MAX_RESULT_CHARS = 24_000;
/** Public IDs one wait_subagent call may select. */
export const MAX_WAIT_IDS = 6;
const MAX_TASK_CHARS = 300;

/** Statuses that flow through automatic delivery to the parent. */
export type DeliverableStatus = "completed" | "failed";

/** One finished run as the delivery core carries and stores it. */
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

/** The Subagent claim over the delivery core's ownership handle. */
export type SubagentDeliveryClaim = ConfirmedDeliveryClaim<SubagentDeliveryEntry>;

/** Why one explicit wait claim was rejected, with the offending public ID. */
export type SubagentClaimFailure = DeliveryClaimFailure;

/** The Subagent delivery core: the generic core carrying finished runs. */
export type SubagentDeliveryCore = ConfirmedDeliveryCore<SubagentDeliveryEntry>;

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

/**
 * Admission policy: an ordinary aborted run notifies nobody, so it enters the
 * store only while an explicit waiter already owns its claim — the waiter
 * receives its aborted outcome, and a release drops it again. Completed and
 * failed runs always enter.
 */
function admitsFinishedRun(input: { id: string; value: SubagentDeliveryEntry }, isClaimed: (id: string) => boolean): boolean {
  return input.value.status !== "aborted" || isClaimed(input.id);
}

/**
 * Release routing for a wait that gives up its claims: completed and failed
 * results stay in the store as unsent automatic-delivery candidates, while an
 * aborted result leaves delivery storage entirely, because an aborted run that
 * no waiter owns never notifies the parent.
 */
export function keepReleasedResult(entry: SubagentDeliveryEntry): boolean {
  return entry.status !== "aborted";
}

export function createSubagentDeliveryCore(options: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  /** Reads the parent run state; a missing reader assumes an idle parent. */
  isIdle?: () => boolean;
  /** Refreshes pi-square status surfaces after a pending-set change. */
  notify?: () => void;
}): SubagentDeliveryCore {
  let sequence = 0;
  return createConfirmedDeliveryCore<SubagentDeliveryEntry>({
    send(batch, resent) {
      sequence += 1;
      const entries: SubagentDeliveryEntry[] = batch.map((entry) => entry.value);
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
    accepts: admitsFinishedRun,
    // The aborted-result release rule binds to the core, so a wait that
    // releases without a predicate still routes completed and failed
    // results back and drops aborted ones (ADR-0016).
    releaseKeep: keepReleasedResult,
    isIdle: options.isIdle,
    onPendingChange: options.notify,
  });
}
