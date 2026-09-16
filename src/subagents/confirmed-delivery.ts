/**
 * Generic reliable-delivery core (odradekk/pi-square#152).
 *
 * Owns only the queue-loss mechanics of confirmed result delivery: the
 * bounded pending set, batch selection, safe delivery timing (idle parent,
 * turn boundary, natural settle), transcript confirmation, natural-settle
 * resend, interruption suppression, and send-failure retention — plus the
 * atomic result-ownership operations for one explicit consumer (odradekk/pi-square#277):
 * claim, take, and release, synchronized with the automatic flush through the
 * sent-state, capacity, single-consumer, and eviction-exclusion guarantees.
 * The caller parameterizes the core with a delivery policy: result identity
 * and payload, message construction and sending, confirmation parsing,
 * optional batch compatibility grouping, an optional admission rule for which
 * finished results enter the store at all, an optional gate re-check at each
 * delivery boundary, an optional removal observer for the policy's own side
 * records, and a pending-change hook for persistence — so the core assumes no
 * particular payload shape and carries no Subagent, display, or store
 * semantics. Callers hold the policy-parameterized core directly; no adapter
 * redeclares the core's members (odradekk/pi-square#372).
 * Adapters that never claim keep exactly their previous automatic-delivery
 * semantics. The shared head/tail text budget (`clipWithHeadTail`) also lives
 * here for the Subagent and Shadow Minds adapters.
 *
 * The core also owns its Pi lifecycle wiring: `subscribeDeliveryLifecycle`
 * hands the delivery signals (agent start, turn end, agent end, message
 * observation, and — unless the caller forwards settles itself — agent
 * settled) to one event source under a fixed, complete signal-to-event
 * mapping, so registration roots cannot drop a result by wiring one signal
 * to the wrong event or omitting one (odradekk/pi-square#369). Session start
 * and shutdown resets stay with the caller, whose own teardown ordering they
 * interleave with.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

/** Results coalesced into a single delivery; the rest follow at the next one. */
export const DEFAULT_MAX_BATCH_RESULTS = 6;
/** Hard bound on the pending set so an unattended session stays bounded. */
export const DEFAULT_MAX_PENDING_RESULTS = 50;
/** Hard bound on simultaneously held explicit reservations (odradekk/pi-square#277). */
export const DEFAULT_MAX_CLAIM_RESERVATIONS = 50;
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

/**
 * Why one explicit claim was rejected before any state changed. The core owns
 * these single-consumer, sent-state, and capacity decisions; the caller owns
 * every eligibility question about ids it knows more about (odradekk/pi-square#277).
 */
export type DeliveryClaimFailure =
  | { kind: "already-claimed"; id: string }
  | { kind: "sent"; id: string }
  | { kind: "capacity"; limit: number; requested: number };

/**
 * One explicit consumer's atomic ownership of a set of results. A claimed
 * result stays in the pending store but is excluded from automatic delivery
 * and eviction until the holder takes or releases it. Exactly one claim can
 * own one identity at a time, and the handle is single-use.
 */
export interface ConfirmedDeliveryClaim<T> {
  /** Reserved identities in the order the holder requested them. */
  readonly ids: readonly string[];
  /** False once the claim was taken, released, or cleared by a reset. */
  readonly active: boolean;
  /**
   * True while this claim is the current owner of the identity. An identity
   * whose reservation was removed (its history was deleted) is no longer
   * held, even before the holder observes it.
   */
  holds(id: string): boolean;
  /**
   * The stored result of one still-held identity, once its run entered the
   * store; undefined for identities this claim no longer owns or whose
   * result has not arrived yet.
   */
  result(id: string): T | undefined;
  /**
   * Removes every claimed result from the store and returns the values in
   * request order. An identity whose result has not entered the store yet
   * yields undefined; the holder normally waits for terminal results first.
   */
  take(): (T | undefined)[];
  /**
   * Gives up ownership without consuming. A stored result whose `keep` is
   * true stays in the store as an unsent entry eligible for the normal
   * automatic-delivery schedule; every other stored result is removed from
   * delivery storage, and reservations without a stored result are dropped.
   * The predicate may be omitted, in which case the core's configured
   * release policy decides; with no policy configured, every stored result
   * leaves delivery storage.
   */
  release(keep?: (value: T) => boolean): void;
}

export interface ConfirmedDeliveryCore<T> extends ConfirmedDeliveryLifecycle {
  /** Registers a finished result and delivers it when the consumer is idle. */
  enqueue(input: { id: string; value: T }): void;
  /** Drops a result, for example when its history is deleted. */
  remove(id: string): void;
  /**
   * Atomically reserves a set of identities for one explicit consumer. An
   * identity already claimed by another consumer, or whose stored result was
   * already sent but not confirmed, rejects the complete request, as does a
   * request that would exceed the reservation bound. Identities without a
   * stored result may be reserved before their results exist.
   */
  claim(ids: string[]): { ok: true; claim: ConfirmedDeliveryClaim<T> } | { ok: false; failure: DeliveryClaimFailure };
  /** True while an explicit consumer holds this identity. */
  isClaimed(id: string): boolean;
  /** True while the stored result of this identity was sent but not confirmed. */
  isSent(id: string): boolean;
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
  /** An explicit consumer owns this result; it is never flushed or evicted. */
  claimed: boolean;
}

/** One held reservation: the identities a single explicit consumer owns. */
interface Reservation {
  ids: string[];
  active: boolean;
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
   * Optional admission policy: false means the finished result enters no store
   * and produces no delivery side effects at all. The core hands the policy
   * its own claim lookup so an admission rule can consult ownership it cannot
   * see from the value alone (odradekk/pi-square#372).
   */
  accepts?: (input: { id: string; value: T }, isClaimed: (id: string) => boolean) => boolean;
  /**
   * Optional gate re-check at each delivery boundary (turn end and natural
   * settle), before interruption state is applied and before any batch is
   * selected — the boundary may still turn out interrupted and flush nothing.
   * A policy whose send eligibility varies over time (a source-run or task
   * gate) drops entries that went stale here, so they never join a batch.
   */
  beforeFlush?: () => void;
  /**
   * Optional removal observer through which a policy retires its own side
   * records. Fired with `confirmed` after transcript confirmation removed the
   * entries (after the pending-change hook), with `removed` on every explicit
   * removal request, and with `reset` after the store was cleared. Silent
   * pending-cap eviction fires nothing; a policy reconciles that case at its
   * next boundary check.
   */
  onEntriesRemoved?: (ids: readonly string[], reason: "confirmed" | "removed" | "reset") => void;
  /**
   * Optional release routing consulted when a claim releases without an
   * explicit keep predicate: true rejoins the automatic schedule, false
   * leaves delivery storage. Binding the rule here keeps a policy such as
   * the aborted-result drop enforced by the adapter instead of remembered
   * by every caller (odradekk/pi-square#372).
   */
  releaseKeep?: (value: T) => boolean;
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
  /** Hard bound on simultaneously held explicit reservations. Default: 50. */
  maxReservations?: number;
  /** Reads the consumer run state; a missing reader assumes an idle consumer. */
  isIdle?: () => boolean;
  /** Fired after every pending-set change, for persistence and status refresh. */
  onPendingChange?: () => void;
}): ConfirmedDeliveryCore<T> {
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH_RESULTS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_RESULTS;
  const maxReservations = options.maxReservations ?? DEFAULT_MAX_CLAIM_RESERVATIONS;
  const pending = new Map<string, PendingEntry<T>>();
  const reservations = new Map<string, Reservation>();
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
    // A claimed result belongs to one explicit consumer and is never handed
    // to the automatic schedule, so it neither leads a batch nor joins one.
    const first = [...pending.values()].find((entry) => !entry.sent && !entry.claimed);
    if (!first) return;
    const key = options.batchKey?.(first.value);
    const batch: PendingEntry<T>[] = [];
    for (const entry of pending.values()) {
      if (entry.sent || entry.claimed) continue;
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

  // The pending bound is total: claimed entries count toward it but are never
  // evicted, because their explicit consumer owns the only copy. Beyond the
  // bound the oldest unclaimed entries leave first; an incoming unclaimed
  // result is therefore the one dropped when every older entry is claimed.
  const evictOverflow = () => {
    while (pending.size > maxPending) {
      const oldest = [...pending.values()].find((entry) => !entry.claimed);
      if (!oldest) break; // only reachable when maxPending < the reservation bound
      pending.delete(oldest.id);
    }
  };

  return {
    enqueue(input) {
      // The admission policy decides first: a refused result enters no store
      // and produces no side effects at all.
      if (options.accepts && !options.accepts(input, (id) => reservations.has(id))) return;
      const existing = pending.get(input.id);
      pending.set(input.id, {
        id: input.id,
        value: input.value,
        completedAt: existing?.completedAt ?? Date.now(),
        sent: false,
        resent: existing?.resent ?? false,
        claimed: reservations.has(input.id) || existing?.claimed === true,
      });
      evictOverflow();
      // An idle consumer receives the result at once; a busy consumer receives
      // it at the next turn boundary. An interrupted consumer keeps its silence
      // until it starts the next run. A delivery refreshes persistence itself,
      // so the pending set reports one change for each completion.
      if (!interrupted && isIdle()) flush();
      else notify();
    },

    remove(id) {
      // Deleting a run's history states that its result is no longer wanted:
      // the pending entry and any outstanding reservation for it end together.
      // The previous holder wakes (the notify below) and can neither consume
      // nor release a later waiter's claim on the same identity, because every
      // claim operation is checked against the identity's current owner.
      const hadReservation = reservations.delete(id);
      const hadEntry = pending.delete(id);
      // Fired on every explicit removal request, whether or not an entry was
      // stored: a policy retires its side records before the change hook, as a
      // wrapping adapter did.
      options.onEntriesRemoved?.([id], "removed");
      if (hadReservation || hadEntry) notify();
    },

    claim(ids) {
      // Validate the complete request before touching any state: one
      // conflicting identity rejects the whole claim, and nothing is reserved
      // when the request would pass the capacity bound.
      const requested: string[] = [];
      for (const id of ids) {
        if (requested.includes(id)) continue;
        requested.push(id);
        if (reservations.has(id)) {
          return { ok: false, failure: { kind: "already-claimed", id } };
        }
        const entry = pending.get(id);
        if (entry?.sent) {
          return { ok: false, failure: { kind: "sent", id } };
        }
      }
      if (reservations.size + requested.length > maxReservations) {
        return { ok: false, failure: { kind: "capacity", limit: maxReservations, requested: requested.length } };
      }

      const reservation: Reservation = { ids: requested, active: true };
      for (const id of requested) {
        reservations.set(id, reservation);
        const entry = pending.get(id);
        if (entry) entry.claimed = true;
      }
      notify();

      // Every claim operation is checked against the identity's current
      // owner: an id whose reservation was removed (history deleted) and
      // later re-claimed by another waiter is never touched again by the
      // previous holder.
      const holds = (id: string) => reservation.active && reservations.get(id) === reservation;

      const finish = () => {
        if (!reservation.active) return false;
        reservation.active = false;
        for (const id of reservation.ids) {
          if (reservations.get(id) === reservation) reservations.delete(id);
        }
        return true;
      };

      return {
        ok: true,
        claim: {
          ids: [...reservation.ids],
          get active() {
            return reservation.active;
          },
          holds,
          result(id) {
            if (!holds(id)) return undefined;
            const entry = pending.get(id);
            return entry?.claimed ? entry.value : undefined;
          },
          take() {
            if (!reservation.active) return reservation.ids.map(() => undefined);
            // Capture ownership before finish() clears what this claim holds:
            // an identity whose reservation was removed (history deleted) and
            // re-claimed belongs to a later waiter and stays untouched.
            const ownedIds = new Set(reservation.ids.filter((id) => reservations.get(id) === reservation));
            finish();
            const values: (T | undefined)[] = [];
            let changed = false;
            for (const id of reservation.ids) {
              const entry = pending.get(id);
              if (ownedIds.has(id) && entry?.claimed && pending.delete(id)) changed = true;
              values.push(ownedIds.has(id) ? entry?.value : undefined);
            }
            if (changed) notify();
            return values;
          },
          release(keep) {
            if (!reservation.active) return;
            // Same ownership capture as take(): only entries this claim still
            // owns are routed back to the automatic schedule or dropped.
            const ownedIds = new Set(reservation.ids.filter((id) => reservations.get(id) === reservation));
            finish();
            const keepEntry = keep ?? options.releaseKeep ?? (() => false);
            let changed = false;
            let releasedUnsent = false;
            for (const id of reservation.ids) {
              if (!ownedIds.has(id)) continue;
              const entry = pending.get(id);
              if (!entry?.claimed) continue;
              if (keepEntry(entry.value)) {
                entry.claimed = false;
                entry.sent = false;
                releasedUnsent = true;
              } else if (pending.delete(id)) {
                changed = true;
              }
            }
            if (changed || releasedUnsent) notify();
            // A released result that stays rejoins the automatic schedule the
            // same way a fresh completion does.
            if (releasedUnsent && !interrupted && isIdle()) flush();
          },
        },
      };
    },

    isClaimed(id) {
      return reservations.has(id);
    },

    isSent(id) {
      return pending.get(id)?.sent === true;
    },

    observeMessage(message) {
      const ids = options.confirmIds(message);
      if (ids.length === 0) return;
      let changed = false;
      for (const id of ids) {
        if (pending.delete(id)) changed = true;
      }
      if (!changed) return;
      notify();
      // A policy retires its side records only after the pending-change hook,
      // matching the order a wrapping adapter used to apply.
      options.onEntriesRemoved?.(ids, "confirmed");
    },

    handleTurnEnd(message) {
      // The policy re-checks its gate before interruption state is applied:
      // stale entries leave even when this boundary turns out aborted.
      options.beforeFlush?.();
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
      options.beforeFlush?.();
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
      // A session replacement or shutdown clears memory-only reservations as
      // well: claims never survive into another consumer session.
      for (const reservation of reservations.values()) reservation.active = false;
      reservations.clear();
      const ids = [...pending.keys()];
      pending.clear();
      interrupted = false;
      options.onEntriesRemoved?.(ids, "reset");
      if (ids.length > 0) notify();
    },
  };
}

/**
 * The five delivery signals every confirmed-delivery consumer must receive,
 * named for the Pi session events that carry them. `ConfirmedDeliveryCore`
 * satisfies this shape, and so does every adapter controller that wraps it.
 */
export interface ConfirmedDeliveryLifecycle {
  /** A new consumer run started, so an earlier interruption no longer holds. */
  handleAgentStart(): void;
  /** Turn boundary of a running consumer; an aborted terminal message suppresses delivery. */
  handleTurnEnd(message?: unknown): void;
  /** Records whether the finished run ended through an interruption. */
  handleAgentEnd(messages: unknown): void;
  /** Consumer settled naturally: unconfirmed results are delivered again. */
  handleAgentSettled(): void;
  /** Offers one observed consumer message for confirmation. */
  observeMessage(message: unknown): void;
}

/**
 * The Pi session lifecycle surface the delivery core subscribes to. Pi's
 * extension event emitter satisfies this shape; tests substitute a recording
 * source and emit through it.
 */
export interface DeliveryEventSource {
  on(event: "agent_start", handler: () => void): void;
  on(event: "turn_end", handler: (event: { message?: unknown }) => void): void;
  on(event: "agent_end", handler: (event: { messages?: unknown }) => void): void;
  on(event: "agent_settled", handler: () => void): void;
  on(event: "message_start", handler: (event: { message?: unknown }) => void): void;
}

export interface DeliveryLifecycleSubscribeOptions {
  /**
   * Defaults to true: the core subscribes `agent_settled` itself and the
   * call returns nothing. Set false only when the caller owns settle
   * forwarding — a completion gate may park the settled event for a bounded
   * window and release it later; the core then leaves `agent_settled`
   * unwired and returns the forwarding handle.
   */
  subscribeSettled?: boolean;
}

/**
 * Forwards consumer-settled signals on the caller's behalf, returned only by
 * `subscribeDeliveryLifecycle(..., { subscribeSettled: false })`. Pi's event
 * emitter offers no unsubscribe, so this is a forwarding handle over the
 * subscribed lifecycle, not a disposable subscription.
 */
export interface DeliverySettleForwarding {
  /** Forwards one consumer-settled signal into the subscribed lifecycle. */
  settle(): void;
}

/**
 * Wires one delivery lifecycle to one event source. The core fixes the
 * complete signal-to-event mapping, so the caller cannot drop a result by
 * wiring a signal to the wrong event or omitting one: a running consumer
 * receives results at each turn boundary, a naturally settled consumer at
 * once, and an interrupted consumer stays silent until its next run starts
 * (ADR-0009). The registrations observe distinct events, so the safety lies
 * in the mapping, not in any registration order.
 */
export function subscribeDeliveryLifecycle(
  lifecycle: ConfirmedDeliveryLifecycle,
  events: DeliveryEventSource,
  options: { subscribeSettled: false },
): DeliverySettleForwarding;
export function subscribeDeliveryLifecycle(
  lifecycle: ConfirmedDeliveryLifecycle,
  events: DeliveryEventSource,
  options?: { subscribeSettled?: true },
): void;
/**
 * Accepts a widened options value the caller could not narrow; the return
 * type is the union because the settled wiring depends on the runtime flag.
 */
export function subscribeDeliveryLifecycle(
  lifecycle: ConfirmedDeliveryLifecycle,
  events: DeliveryEventSource,
  options: DeliveryLifecycleSubscribeOptions,
): DeliverySettleForwarding | void;
export function subscribeDeliveryLifecycle(
  lifecycle: ConfirmedDeliveryLifecycle,
  events: DeliveryEventSource,
  options?: DeliveryLifecycleSubscribeOptions,
): DeliverySettleForwarding | void {
  events.on("agent_start", () => lifecycle.handleAgentStart());
  events.on("turn_end", (event) => lifecycle.handleTurnEnd(event?.message));
  events.on("agent_end", (event) => lifecycle.handleAgentEnd(event?.messages));
  events.on("message_start", (event) => lifecycle.observeMessage(event?.message));
  if (options?.subscribeSettled !== false) {
    events.on("agent_settled", () => lifecycle.handleAgentSettled());
    return undefined;
  }
  return {
    settle: () => lifecycle.handleAgentSettled(),
  };
}
