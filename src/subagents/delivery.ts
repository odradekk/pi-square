/**
 * Reliable delivery of background subagent results to the parent session.
 *
 * Pi injects one queued steering message per turn boundary and drops every
 * queued message when the user interrupts a turn (`clearAllQueues`), while
 * `pi.sendMessage` is fire-and-forget and reports no failure to the caller. A
 * result that is sent once and forgotten can therefore disappear without any
 * trace. The generic mechanics — the bounded pending set, batch selection,
 * safe delivery timing, confirmation, resend, interruption suppression, and
 * send-failure retention — live in `confirmed-delivery.ts`; this module is the
 * Subagent adapter: it supplies the run identity, the V4 notification payload
 * and message construction, and the transcript confirmation parser.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createConfirmedDeliveryCore,
  DEFAULT_MAX_BATCH_RESULTS,
  DEFAULT_MAX_PENDING_RESULTS,
} from "./confirmed-delivery";
import type { SubagentNotificationDetails, SubagentRunDetails } from "./types";

export const SUBAGENT_NOTIFICATION_TYPE = "pi-square.subagent-notification";

/** Model-facing budget for one result text. */
export const MAX_RESULT_CHARS = 24_000;
/** Share of the budget kept from the head; the remainder keeps the tail. */
const HEAD_SHARE = 0.7;
/** Results coalesced into a single delivery; the rest follow at the next one. */
export const MAX_BATCH_RESULTS = DEFAULT_MAX_BATCH_RESULTS;
/** Hard bound on the pending set so an unattended session stays bounded. */
export const MAX_PENDING_RESULTS = DEFAULT_MAX_PENDING_RESULTS;
const MAX_TASK_CHARS = 300;

export type DeliverableStatus = "done" | "error";

/** One finished run as the delivery core carries it. */
interface SubagentDeliveryValue {
  status: DeliverableStatus;
  details: SubagentRunDetails;
}

/** One run rendered into a delivery message. */
export interface SubagentDeliveryEntry {
  id: string;
  status: DeliverableStatus;
  details: SubagentRunDetails;
}

export interface DeliveryController {
  /** Registers a finished run and delivers it when the parent is idle. */
  enqueue(input: { id: string; status: DeliverableStatus; details: SubagentRunDetails }): void;
  /** Drops a result, for example when its history is deleted. */
  remove(id: string): void;
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
  const normalized = normalize(text);
  if (normalized.length <= max) return normalized;
  const head = Math.floor(max * HEAD_SHARE);
  const tail = max - head;
  const omitted = normalized.length - head - tail;
  return `${normalized.slice(0, head)}\n... [omitted ${omitted} characters] ...\n${normalized.slice(normalized.length - tail)}`;
}

function agentLabel(result: SubagentDeliveryEntry): string {
  return result.details.agent?.name ?? "generic";
}

function resultText(result: SubagentDeliveryEntry): string {
  return result.status === "done"
    ? budgetResultText(result.details.finalText || "(no output)")
    : budgetResultText(result.details.error || "Subagent failed.");
}

/** Builds the model-facing content of one delivery. */
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
      only.status === "done" ? "Result:" : "Error:",
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
      result.status === "done" ? "Result:" : "Error:",
      resultText(result),
    );
  });
  return lines.join("\n");
}

/** Reads the run IDs carried by a delivered notification, V4 or legacy V3. */
export function notificationResultIds(message: unknown): string[] {
  const candidate = message as { customType?: unknown; details?: unknown } | undefined;
  if (candidate?.customType !== SUBAGENT_NOTIFICATION_TYPE) return [];
  const details = candidate.details as
    | { results?: { id?: unknown }[]; id?: unknown }
    | undefined;
  if (Array.isArray(details?.results)) {
    return details.results
      .map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
      .filter((id): id is string => id.length > 0);
  }
  return typeof details?.id === "string" ? [details.id] : [];
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
        version: 4,
        deliveryId: `delivery-${sequence}`,
        resent,
        results: entries.map((entry) => ({
          id: entry.id,
          status: entry.status,
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

  return {
    enqueue(input) {
      core.enqueue({ id: input.id, value: { status: input.status, details: input.details } });
    },
    remove: (id) => core.remove(id),
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
