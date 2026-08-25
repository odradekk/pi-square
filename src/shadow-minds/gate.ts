/**
 * Bounded answer-after-review completion gate (odradekk/pi-square#160).
 *
 * A definition subscribed to the completion trigger may declare
 * `completionGate: true`: when its run ends, the parent holds the Shadow
 * subsystem's settle boundary for one bounded window after the answer has
 * already rendered, so completion results can queue at the earliest safe
 * continuation boundary — the gate close — according to their normal
 * delivery policy. The gate never delays or alters the parent's assistant
 * message: it only delays the subsystem's settled handling (`agent_settled`
 * semantics for delivery and idle timing) that this extension owns.
 *
 * At the deadline, started completion runs continue (their results follow
 * the normal late/stale rules, including the notify downgrade) while every
 * unstarted completion pending item is cancelled. A new real-user task,
 * pause, user abort, session replacement, or shutdown closes the gate
 * without a settle forward; those entries resolve through the normal
 * stale-task downgrade at the next natural settle.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

import {
  SHADOW_MINDS_COMPLETION_WINDOW_HARD_MAX_SECONDS,
  type ShadowMindsConfig,
} from "../core/config";
import type { EffectiveShadowDefinition } from "./definitions";
import { subscribedDefinitions } from "./scheduler";

/** Package hard cap on the completion-gate window, defense in depth. */
export const GATE_WINDOW_HARD_MAX_SECONDS = SHADOW_MINDS_COMPLETION_WINDOW_HARD_MAX_SECONDS;

/** Why a gate closed; each reason maps to fixed close semantics. */
export type ShadowGateCloseReason =
  | "completed"
  | "deadline"
  | "drained"
  | "new-task"
  | "paused"
  | "aborted"
  | "session";

const SETTLE_FORWARDING: ReadonlySet<ShadowGateCloseReason> = new Set(["completed", "deadline", "drained"]);
const CANCELS_PENDING: ReadonlySet<ShadowGateCloseReason> = new Set([
  "deadline",
  "drained",
  "new-task",
  "paused",
  "aborted",
  "session",
]);

export interface ShadowCompletionGate {
  /** True while the gate holds the subsystem settle boundary. */
  readonly open: boolean;
  /**
   * Opens the gate when a gate-subscribed definition has a pending
   * completion activation. Returns whether the gate is open now.
   */
  maybeOpen(): boolean;
  /**
   * Re-evaluates an open gate: when no completion run is running and no
   * completion activation is pending, the gate closes early. Inert when
   * closed.
   */
  notifyActivity(): void;
  /** Closes an open gate with the fixed reason semantics; inert when closed. */
  close(reason: ShadowGateCloseReason): void;
  /** Clears all state without side effects (session start and shutdown). */
  reset(): void;
}

/** IDs of enabled definitions subscribed to completion with a gate. */
function gateDefinitionIds(
  definitions: readonly EffectiveShadowDefinition[],
  config: ShadowMindsConfig,
): Set<string> {
  return new Set(
    subscribedDefinitions(definitions, "completion", config)
      .filter((definition) => definition.completionGate)
      .map((definition) => definition.id),
  );
}

export function createCompletionGate(deps: {
  now(): number;
  config(): ShadowMindsConfig;
  definitions(): readonly EffectiveShadowDefinition[];
  scheduler: {
    /** Shadow IDs with a pending, not-yet-started completion activation. */
    pendingCompletions(): string[];
    /** Cancels every pending completion activation; returns how many. */
    cancelPendingCompletions(): number;
  };
  /** True while any completion-triggered run of one of the given gate
   * definitions is still running. */
  hasRunningCompletionRuns(gateIds: ReadonlySet<string>): boolean;
  /**
   * Forwards the delayed settle: the caller releases its idle timing and
   * lets the delivery machine flush at this safe continuation boundary.
   */
  forwardSettle(at: number): void;
  /** Bounded visibility when the gate opens. */
  onOpen?(windowSeconds: number): void;
  /** Bounded visibility for every close, with the cancelled pending count. */
  onClose?(reason: ShadowGateCloseReason, cancelled: number): void;
  /** Deadline scheduling; the default uses an unref'd timer. */
  scheduleDeadline?(ms: number, fire: () => void): () => void;
}): ShadowCompletionGate {
  let openedAt: number | undefined;
  let cancelTimer: (() => void) | undefined;

  const schedule = (ms: number, fire: () => void): (() => void) => {
    if (deps.scheduleDeadline) return deps.scheduleDeadline(ms, fire);
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  };

  const settle = (at: number): void => {
    try {
      deps.forwardSettle(at);
    } catch {
      // Settle forwarding is delivery timing; a failure must not wedge the gate.
    }
  };

  const closeGate = (reason: ShadowGateCloseReason): void => {
    if (openedAt === undefined) return;
    openedAt = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
    let cancelled = 0;
    if (CANCELS_PENDING.has(reason)) cancelled = deps.scheduler.cancelPendingCompletions();
    deps.onClose?.(reason, cancelled);
    if (SETTLE_FORWARDING.has(reason)) settle(deps.now());
  };

  return {
    get open() {
      return openedAt !== undefined;
    },

    maybeOpen() {
      if (openedAt !== undefined) return true;
      const config = deps.config();
      if (!config.enabled) return false;
      const gateIds = gateDefinitionIds(deps.definitions(), config);
      if (gateIds.size === 0) return false;
      // The gate opens only for its own definitions: pending completions or
      // already-started completion runs of a non-gate Shadow stay on the
      // ordinary #159 path.
      const hasPending = deps.scheduler.pendingCompletions().some((id) => gateIds.has(id));
      if (!hasPending && !deps.hasRunningCompletionRuns(gateIds)) return false;
      const windowSeconds = Math.min(
        Math.max(1, config.defaults.completionGateWindowSeconds),
        GATE_WINDOW_HARD_MAX_SECONDS,
      );
      openedAt = deps.now();
      deps.onOpen?.(windowSeconds);
      cancelTimer = schedule(windowSeconds * 1_000, () => closeGate("deadline"));
      return true;
    },

    notifyActivity() {
      if (openedAt === undefined) return;
      const gateIds = gateDefinitionIds(deps.definitions(), deps.config());
      if (deps.scheduler.pendingCompletions().some((id) => gateIds.has(id))) return;
      if (deps.hasRunningCompletionRuns(gateIds)) return;
      closeGate("completed");
    },

    close(reason) {
      closeGate(reason);
    },

    reset() {
      if (openedAt === undefined) return;
      openedAt = undefined;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
