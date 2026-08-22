/**
 * Reliable delivery of background subagent results to the parent session.
 *
 * Pi injects one queued steering message per turn boundary and drops every
 * queued message when the user interrupts a turn (`clearAllQueues`), while
 * `pi.sendMessage` is fire-and-forget and reports no failure to the caller. A
 * result that is sent once and forgotten can therefore disappear without any
 * trace. This module owns the pending set instead: it coalesces finished runs
 * into one message per safe moment, confirms delivery by observing the message
 * that Pi actually injected, and re-sends a result the parent never received.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentNotificationDetails, SubagentRunDetails } from "./types";

export const SUBAGENT_NOTIFICATION_TYPE = "pi-square.subagent-notification";

/** Model-facing budget for one result text. */
export const MAX_RESULT_CHARS = 24_000;
/** Share of the budget kept from the head; the remainder keeps the tail. */
const HEAD_SHARE = 0.7;
/** Results coalesced into a single delivery; the rest follow at the next one. */
export const MAX_BATCH_RESULTS = 6;
/** Hard bound on the pending set so an unattended session stays bounded. */
export const MAX_PENDING_RESULTS = 50;
const MAX_TASK_CHARS = 300;

export type DeliverableStatus = "done" | "error";

/** One finished run waiting for confirmed delivery to the parent. */
interface PendingResult {
  id: string;
  status: DeliverableStatus;
  details: SubagentRunDetails;
  completedAt: number;
  /** Sent to Pi and not yet observed in the parent transcript. */
  sent: boolean;
  /** Sent at least once before, so the next delivery states that it repeats. */
  resent: boolean;
}

export interface DeliveryController {
  /** Registers a finished run and delivers it when the parent is idle. */
  enqueue(input: { id: string; status: DeliverableStatus; details: SubagentRunDetails }): void;
  /** Drops a result, for example when its history is deleted. */
  remove(id: string): void;
  /** Confirms delivery from an injected parent message. */
  observeMessage(message: unknown): void;
  /** Turn boundary of a running parent: deliver without waiting for idle. */
  handleTurnEnd(): void;
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

function agentLabel(result: PendingResult): string {
  return result.details.agent?.name ?? "generic";
}

function resultText(result: PendingResult): string {
  return result.status === "done"
    ? budgetResultText(result.details.finalText || "(no output)")
    : budgetResultText(result.details.error || "Subagent failed.");
}

/** Builds the model-facing content of one delivery. */
export function buildDeliveryContent(results: PendingResult[], resent: boolean): string {
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

function wasInterrupted(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => (message as { stopReason?: unknown } | undefined)?.stopReason === "aborted");
}

export function createDeliveryController(options: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  /** Reads the parent run state; a missing reader assumes an idle parent. */
  isIdle?: () => boolean;
  /** Refreshes pi-square status surfaces after a pending-set change. */
  notify?: () => void;
}): DeliveryController {
  const pending = new Map<string, PendingResult>();
  let interrupted = false;
  let sequence = 0;

  const notify = () => {
    try {
      options.notify?.();
    } catch {
      // isolate status refresh failures from delivery
    }
  };

  const isIdle = () => {
    try {
      return options.isIdle ? options.isIdle() : true;
    } catch {
      return false;
    }
  };

  const flush = () => {
    const batch: PendingResult[] = [];
    for (const result of pending.values()) {
      if (result.sent) continue;
      batch.push(result);
      if (batch.length >= MAX_BATCH_RESULTS) break;
    }
    if (batch.length === 0) return;

    const resent = batch.some((result) => result.resent);
    sequence += 1;
    const details: SubagentNotificationDetails = {
      version: 4,
      deliveryId: `delivery-${sequence}`,
      resent,
      results: batch.map((result) => ({
        id: result.id,
        status: result.status,
        result: result.details,
      })),
    };

    for (const result of batch) result.sent = true;
    try {
      options.pi.sendMessage(
        {
          customType: SUBAGENT_NOTIFICATION_TYPE,
          content: buildDeliveryContent(batch, resent),
          display: true,
          details,
        },
        {
          triggerTurn: true,
          deliverAs: "steer",
        },
      );
    } catch {
      // The send never reached Pi: keep the results pending for the next safe
      // moment rather than losing them in a swallowed failure.
      for (const result of batch) {
        result.sent = false;
        result.resent = true;
      }
    }
    notify();
  };

  return {
    enqueue(input) {
      const existing = pending.get(input.id);
      pending.set(input.id, {
        id: input.id,
        status: input.status,
        details: input.details,
        completedAt: existing?.completedAt ?? Date.now(),
        sent: false,
        resent: existing?.resent ?? false,
      });
      while (pending.size > MAX_PENDING_RESULTS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      // An idle parent receives the result at once; a busy parent receives it
      // at the next turn boundary. An interrupted parent keeps its silence
      // until it starts the next turn. A delivery refreshes the status itself,
      // so the pending set reports one change for each completion.
      if (!interrupted && isIdle()) flush();
      else notify();
    },

    remove(id) {
      if (pending.delete(id)) notify();
    },

    observeMessage(message) {
      const ids = notificationResultIds(message);
      if (ids.length === 0) return;
      let changed = false;
      for (const id of ids) {
        if (pending.delete(id)) changed = true;
      }
      if (changed) notify();
    },

    handleTurnEnd() {
      flush();
    },

    handleAgentStart() {
      interrupted = false;
    },

    handleAgentEnd(messages) {
      interrupted = wasInterrupted(messages);
    },

    handleAgentSettled() {
      // Pi drains its queues before the run settles, so a result that is still
      // unconfirmed here was discarded (an interruption clears the queue).
      let lost = false;
      for (const result of pending.values()) {
        if (!result.sent) continue;
        result.sent = false;
        result.resent = true;
        lost = true;
      }
      if (lost) notify();
      if (!interrupted) flush();
    },

    isPending(id) {
      return pending.has(id);
    },

    pendingCount() {
      return pending.size;
    },

    pendingIds() {
      return [...pending.keys()];
    },

    reset() {
      const had = pending.size > 0;
      pending.clear();
      interrupted = false;
      if (had) notify();
    },
  };
}
