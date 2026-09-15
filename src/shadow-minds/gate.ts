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
 * The registration root reports parent run-state transitions through
 * `handleRunTransition`; deriving when to open, when to close, and which
 * close reason applies lives here, next to the window semantics it
 * controls. Callers never choose a gate verb or pass a close reason, and
 * the parked-settle bit is owned here instead of being mirrored by callers.
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

/**
 * One parent run-state transition the gate derives its open/close from. The
 * registration root translates raw Pi events into these facts; mapping a
 * transition to a gate action and close reason is this module's job.
 */
export type ShadowGateRunTransition =
  | { kind: "parent-run-start"; realUserTask: boolean }
  | { kind: "parent-run-end"; interrupted: boolean }
  | { kind: "parent-run-abort" }
  | { kind: "scheduler-paused" }
  | { kind: "session-ending" }
  | { kind: "shadow-activity" };

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
   * Reports one parent run-state transition. The gate derives whether to
   * open, re-evaluate, or close — and with which reason — from the
   * transition itself.
   */
  handleRunTransition(transition: ShadowGateRunTransition): void;
  /**
   * Parks the subsystem settle while the gate is open: returns true when the
   * gate is holding (the caller must not run its own settle handling), false
   * when the gate is closed and the settle is the caller's to run.
   */
  holdSettle(): boolean;
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
   * lets the delivery machine flush at this safe continuation boundary. The
   * gate only invokes this when a settle is parked, so the implementation
   * needs no hold-state check of its own.
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
  // Set when the parent settled while the gate was open; cleared by every
  // close. Invariant: a closed gate never parks a settle, so a forwarding
  // close always knows whether the subsystem settle is actually waiting.
  let settleParked = false;

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
    const forward = settleParked;
    settleParked = false;
    if (SETTLE_FORWARDING.has(reason) && forward) settle(deps.now());
  };

  /** Opens the gate when gate-subscribed completion work is present. */
  const openIfCompletionWorkPending = (): void => {
    if (openedAt !== undefined) return;
    const config = deps.config();
    if (!config.enabled) return;
    const gateIds = gateDefinitionIds(deps.definitions(), config);
    if (gateIds.size === 0) return;
    // The gate opens only for its own definitions: pending completions or
    // already-started completion runs of a non-gate Shadow stay on the
    // ordinary #159 path.
    const hasPending = deps.scheduler.pendingCompletions().some((id) => gateIds.has(id));
    if (!hasPending && !deps.hasRunningCompletionRuns(gateIds)) return;
    const windowSeconds = Math.min(
      Math.max(1, config.defaults.completionGateWindowSeconds),
      GATE_WINDOW_HARD_MAX_SECONDS,
    );
    openedAt = deps.now();
    deps.onOpen?.(windowSeconds);
    cancelTimer = schedule(windowSeconds * 1_000, () => closeGate("deadline"));
  };

  /** Re-evaluates an open gate after Shadow run activity; closes early once drained. */
  const reevaluateAfterActivity = (): void => {
    if (openedAt === undefined) return;
    const gateIds = gateDefinitionIds(deps.definitions(), deps.config());
    if (deps.scheduler.pendingCompletions().some((id) => gateIds.has(id))) return;
    if (deps.hasRunningCompletionRuns(gateIds)) return;
    closeGate("completed");
  };

  return {
    get open() {
      return openedAt !== undefined;
    },

    handleRunTransition(transition) {
      switch (transition.kind) {
        case "parent-run-start":
          // Only a real-user task closes the gate: extension continuations
          // never re-trigger Shadows and never end the held window.
          if (transition.realUserTask) closeGate("new-task");
          return;
        case "parent-run-end":
          if (transition.interrupted) closeGate("aborted");
          else openIfCompletionWorkPending();
          return;
        case "parent-run-abort":
          // Pi emits turn_end before agent_end on abort; both observations
          // map to the same close and the second is an inert no-op.
          closeGate("aborted");
          return;
        case "scheduler-paused":
          closeGate("paused");
          return;
        case "session-ending":
          closeGate("session");
          return;
        case "shadow-activity":
          reevaluateAfterActivity();
          return;
      }
    },

    holdSettle() {
      if (openedAt === undefined) return false;
      settleParked = true;
      return true;
    },

    reset() {
      if (openedAt === undefined) return;
      openedAt = undefined;
      settleParked = false;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
