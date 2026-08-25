/**
 * Generic reliable-delivery core (odradekk/pi-square#152).
 *
 * Owns only the queue-loss mechanics of confirmed result delivery: the
 * bounded pending set, batch selection, safe delivery timing (idle parent,
 * turn boundary, natural settle), transcript confirmation, natural-settle
 * resend, interruption suppression, and send-failure retention. The caller
 * supplies result identity and payload, confirmation parsing, optional batch
 * compatibility grouping, message construction and sending, and a
 * pending-change hook for persistence — so the core assumes no particular
 * payload shape and carries no Subagent, display, or store semantics. The
 * shared head/tail text budget (`clipWithHeadTail`) also lives here for the
 * Subagent and Shadow Minds adapters.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

/** Results coalesced into a single delivery; the rest follow at the next one. */
export const DEFAULT_MAX_BATCH_RESULTS = 6;
/** Hard bound on the pending set so an unattended session stays bounded. */
export const DEFAULT_MAX_PENDING_RESULTS = 50;
/** Share of the budget kept from the head; the remainder keeps the tail. */
const HEAD_SHARE = 0.7;

/**
 * Applies a model-facing head/tail budget to one text. A result states its
 * conclusion early and its gaps late, so an oversized text keeps both. The
 * omission marker is added to the kept text and is not counted in the budget.
 */
export function clipWithHeadTail(text: unknown, max: number): string {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= max) return normalized;
  const head = Math.floor(max * HEAD_SHARE);
  const tail = max - head;
  const omitted = normalized.length - head - tail;
  return `${normalized.slice(0, head)}\n... [omitted ${omitted} characters] ...\n${normalized.slice(normalized.length - tail)}`;
}

/** One entry of a batch handed to the caller's send hook. */
export interface ConfirmedDeliveryBatchEntry<T> {
  id: string;
  value: T;
}

export interface ConfirmedDeliveryCore<T> {
  /** Registers a finished result and delivers it when the consumer is idle. */
  enqueue(input: { id: string; value: T }): void;
  /** Drops a result, for example when its history is deleted. */
  remove(id: string): void;
  /** Offers one observed consumer message for confirmation. */
  observeMessage(message: unknown): void;
  /** Turn boundary of a running consumer; an aborted terminal message suppresses delivery. */
  handleTurnEnd(message?: unknown): void;
  /** A new consumer run started, so an earlier interruption no longer holds. */
  handleAgentStart(): void;
  /** Records whether the finished run ended through an interruption. */
  handleAgentEnd(messages: unknown): void;
  /** Consumer settled naturally: unconfirmed results are delivered again. */
  handleAgentSettled(): void;
  /** True while the result of this identity is not confirmed. */
  isPending(id: string): boolean;
  /** Count of results the consumer has not confirmed. */
  pendingCount(): number;
  /** Identities of results the consumer has not confirmed. */
  pendingIds(): string[];
  /** Clears all state on session start and shutdown. */
  reset(): void;
}

interface PendingEntry<T> {
  id: string;
  value: T;
  completedAt: number;
  /** Sent and not yet observed in the consumer transcript. */
  sent: boolean;
  /** Sent at least once before, so the next delivery states that it repeats. */
  resent: boolean;
}

function isAbortedMessage(message: unknown): boolean {
  return (message as { stopReason?: unknown } | undefined)?.stopReason === "aborted";
}

function wasInterrupted(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(isAbortedMessage);
}

export function createConfirmedDeliveryCore<T>(options: {
  /**
   * Sends one batch of compatible results. Throwing means the send never
   * reached the consumer: the core retains every entry of the batch for the
   * next safe moment instead of losing it.
   */
  send: (batch: ConfirmedDeliveryBatchEntry<T>[], resent: boolean) => void;
  /** Reads the result identities one delivered message carries; empty when the message is foreign. */
  confirmIds: (message: unknown) => string[];
  /**
   * Optional compatibility key: only results sharing the key of the oldest
   * unsent entry are coalesced into one message. Omitted means every result
   * is compatible with every other.
   */
  batchKey?: (value: T) => string;
  /** Results coalesced into a single delivery. Default: 6. */
  maxBatch?: number;
  /** Hard bound on the pending set. Default: 50. */
  maxPending?: number;
  /** Reads the consumer run state; a missing reader assumes an idle consumer. */
  isIdle?: () => boolean;
  /** Fired after every pending-set change, for persistence and status refresh. */
  onPendingChange?: () => void;
}): ConfirmedDeliveryCore<T> {
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH_RESULTS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_RESULTS;
  const pending = new Map<string, PendingEntry<T>>();
  let interrupted = false;

  const notify = () => {
    try {
      options.onPendingChange?.();
    } catch {
      // isolate persistence and status refresh failures from delivery
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
    const first = [...pending.values()].find((entry) => !entry.sent);
    if (!first) return;
    const key = options.batchKey?.(first.value);
    const batch: PendingEntry<T>[] = [];
    for (const entry of pending.values()) {
      if (entry.sent) continue;
      if (options.batchKey && options.batchKey(entry.value) !== key) continue;
      batch.push(entry);
      if (batch.length >= maxBatch) break;
    }
    if (batch.length === 0) return;

    const resent = batch.some((entry) => entry.resent);
    for (const entry of batch) entry.sent = true;
    try {
      options.send(
        batch.map((entry) => ({ id: entry.id, value: entry.value })),
        resent,
      );
    } catch {
      // The send never reached the consumer: keep the results pending for the
      // next safe moment rather than losing them in a swallowed failure.
      for (const entry of batch) {
        entry.sent = false;
        entry.resent = true;
      }
    }
    notify();
  };

  return {
    enqueue(input) {
      const existing = pending.get(input.id);
      pending.set(input.id, {
        id: input.id,
        value: input.value,
        completedAt: existing?.completedAt ?? Date.now(),
        sent: false,
        resent: existing?.resent ?? false,
      });
      while (pending.size > maxPending) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      // An idle consumer receives the result at once; a busy consumer receives
      // it at the next turn boundary. An interrupted consumer keeps its silence
      // until it starts the next run. A delivery refreshes persistence itself,
      // so the pending set reports one change for each completion.
      if (!interrupted && isIdle()) flush();
      else notify();
    },

    remove(id) {
      if (pending.delete(id)) notify();
    },

    observeMessage(message) {
      const ids = options.confirmIds(message);
      if (ids.length === 0) return;
      let changed = false;
      for (const id of ids) {
        if (pending.delete(id)) changed = true;
      }
      if (changed) notify();
    },

    handleTurnEnd(message) {
      if (isAbortedMessage(message)) interrupted = true;
      if (interrupted) return;
      flush();
    },

    handleAgentStart() {
      interrupted = false;
    },

    handleAgentEnd(messages) {
      interrupted ||= wasInterrupted(messages);
    },

    handleAgentSettled() {
      // The consumer drains its queues before it settles, so a result that is
      // still unconfirmed here was discarded (an interruption clears queues).
      let lost = false;
      for (const entry of pending.values()) {
        if (!entry.sent) continue;
        entry.sent = false;
        entry.resent = true;
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
