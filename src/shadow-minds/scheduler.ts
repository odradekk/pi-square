/**
 * Deterministic Shadow activation boundaries (odradekk/pi-square#158).
 *
 * The classifier, mutation set, trigger priority, and reason merge are pure:
 * the scheduler composes them, and every decision it makes is reproducible
 * from the observed events alone — no probability, no wall-clock tiebreaks,
 * no model-selected activation.
 */

import type { ShadowMindsConfig } from "../core/config";
import type { EffectiveShadowDefinition } from "./definitions";
import type { ShadowTrigger } from "./parser";

/** The four fixed automatic trigger values, as used by run records. */
export type ShadowTriggerKind = ShadowTrigger;

/** Fixed trigger priority: completion, failure, mutation, then tool turn. */
export const TRIGGER_PRIORITY: Readonly<Record<ShadowTrigger, number>> = Object.freeze({
  completion: 3,
  failure: 2,
  mutation: 1,
  tool_turn: 0,
});

/**
 * Pi- and pi-square-owned declarative mutation tools. Unknown third-party
 * tools are never classified as mutations by name guessing.
 */
export const MUTATION_TOOL_NAMES: readonly string[] = Object.freeze(["edit", "write", "replace", "revert"]);

export function isMutationToolName(name: string): boolean {
  return MUTATION_TOOL_NAMES.includes(name);
}

/** Declaratively classified quality-command families. */
export type QualityCommandKind = "test" | "build" | "typecheck" | "smoke" | "package-check";

const QUALITY_KIND_BY_TOKEN: Readonly<Record<string, QualityCommandKind>> = Object.freeze({
  test: "test",
  tests: "test",
  build: "build",
  typecheck: "typecheck",
  "type-check": "typecheck",
  "type-checks": "typecheck",
  tsc: "typecheck",
  smoke: "smoke",
  "package-check": "package-check",
  "package:check": "package-check",
});

/** Package-manager executables whose `run` targets are classified. */
const RUN_EXECUTABLES = new Set(["npm", "yarn", "pnpm", "bun", "deno", "nx", "turbo", "make", "just", "gradle", "mvn"]);

const COMMAND_MAX_CHARS = 400;

/** Flags that consume one argument before the real target. */
const VALUE_FLAGS = new Set(["--filter", "--workspace", "-s", "--scope", "-p", "--package", "-w", "--workspace-root"]);

/**
 * Classifies one shell command as a declarative quality command. Only the
 * command's first segment is considered, and only a named quality target
 * qualifies: a script called `deploy-and-test-everything` is a script, not
 * a classified test run, and arbitrary non-zero probes never become failure
 * triggers.
 */
export function classifyQualityCommand(rawCommand: string): QualityCommandKind | undefined {
  const command = rawCommand.slice(0, COMMAND_MAX_CHARS).trim();
  if (!command) return undefined;
  // First segment only: `npm run deploy && npm test` is a deploy command
  // whose compound status may come from either side.
  const segment = command.split(/&&|\|\||;|\||\n/)[0]!.trim();
  if (!segment) return undefined;
  // Strip a leading env assignment run (`FOO=1 BAR=2 cmd …`) without
  // executing anything: the classifier only needs the command words.
  const withoutEnv = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^ ]+)\s+)+/, "");
  const tokens = withoutEnv.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;

  // Flags never name the quality target; value flags drop their argument
  // too (`pnpm --filter pkg typecheck`).
  const words: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    words.push(token);
  }

  if (RUN_EXECUTABLES.has(tokens[0]!) || tokens[0] === "npx" || tokens[0] === "pnpx" || tokens[0] === "dlx") {
    if (tokens[0] === "make" || tokens[0] === "just") {
      for (const word of words) {
        const kind = QUALITY_KIND_BY_TOKEN[word.replace(/^.*\//, "")];
        if (kind) return kind;
      }
      return undefined;
    }
    const [verb, target] = words;
    if (verb === undefined) return undefined;
    // `npx <bin>` and `yarn dlx <bin>` name the binary directly.
    const directRunner = tokens[0] === "npx" || tokens[0] === "pnpx" || tokens[0] === "dlx";
    if (!directRunner && (verb === "run" || verb === "exec" || verb === "check")) {
      return target !== undefined ? QUALITY_KIND_BY_TOKEN[target.replace(/^.*\//, "")] : undefined;
    }
    // The first plain word is the script, subcommand, or binary.
    return QUALITY_KIND_BY_TOKEN[verb.replace(/^.*\//, "")];
  }

  // Direct binary call: `tsc`. `pytest` and `vitest` are not declarative
  // pi-square quality gates and stay unclassified.
  return QUALITY_KIND_BY_TOKEN[tokens[0]!.replace(/^.*\//, "")];
}
/** One merged trigger reason kept in a pending activation. */
export interface ShadowTriggerReason {
  trigger: ShadowTrigger;
  firstObservedAt: number;
  lastObservedAt: number;
  /** Tool-turn generation the reason was last observed at. */
  generation?: number;
  /** Bounded sanitized detail (`write src/a.ts`, `typecheck`). */
  detail?: string;
}

export const REASON_DETAIL_MAX_CHARS = 160;

/** Merges one observation into a reason list, keeping first/last timestamps. */
export function mergeTriggerReason(
  reasons: ShadowTriggerReason[],
  observation: { trigger: ShadowTrigger; at: number; detail?: string; generation?: number },
): ShadowTriggerReason[] {
  const existing = reasons.find((reason) => reason.trigger === observation.trigger);
  if (!existing) {
    reasons.push({
      trigger: observation.trigger,
      firstObservedAt: observation.at,
      lastObservedAt: observation.at,
      ...(observation.generation !== undefined ? { generation: observation.generation } : {}),
      ...(observation.detail !== undefined ? { detail: sliceDetail(observation.detail) } : {}),
    });
    return reasons;
  }
  existing.lastObservedAt = observation.at;
  if (observation.generation !== undefined) existing.generation = observation.generation;
  if (observation.detail !== undefined) existing.detail = sliceDetail(observation.detail);
  return reasons;
}

/** Orders reasons by fixed trigger priority (highest first). */
export function orderReasons(reasons: readonly ShadowTriggerReason[]): ShadowTriggerReason[] {
  return [...reasons].sort((a, b) => TRIGGER_PRIORITY[b.trigger] - TRIGGER_PRIORITY[a.trigger]);
}

function sliceDetail(detail: string): string {
  return detail.length <= REASON_DETAIL_MAX_CHARS ? detail : `${detail.slice(0, REASON_DETAIL_MAX_CHARS - 1)}…`;
}

/** Bounded canonical summary of one reason, used in prompts and status text. */
export function formatTriggerReason(reason: ShadowTriggerReason): string {
  const parts: string[] = [reason.trigger];
  if (reason.generation !== undefined && reason.trigger === "tool_turn") parts.push(`generation ${reason.generation}`);
  return sliceDetail(parts.join(" "));
}

/**
 * One pending automatic activation snapshot. Each Shadow has at most one:
 * new events replace the checkpoint and union the trigger reasons.
 */
export interface ShadowPendingActivation {
  shadowId: string;
  taskEpoch: number;
  /** Definition priority frozen at the latest enqueue. */
  shadowPriority: number;
  /** Highest-priority trigger among the merged reasons. */
  bestTrigger: ShadowTrigger;
  reasons: ShadowTriggerReason[];
  /** Latest observed tool generation. */
  generation: number;
  /** Latest visible trajectory checkpoint. */
  checkpoint: unknown;
  enqueuedAt: number;
  lastObservedAt: number;
}

/**
 * Deterministic arbitration: newer task generations first, then trigger
 * priority, then Shadow priority, then ID. Manual versus automatic source
 * ordering lives at the runtime slot boundary (manual starts preempt
 * automatic runs, never the reverse).
 */
export function compareActivations(a: ShadowPendingActivation, b: ShadowPendingActivation): number {
  if (a.taskEpoch !== b.taskEpoch) return b.taskEpoch - a.taskEpoch;
  const triggerDiff = TRIGGER_PRIORITY[b.bestTrigger] - TRIGGER_PRIORITY[a.bestTrigger];
  if (triggerDiff !== 0) return triggerDiff;
  if (a.shadowPriority !== b.shadowPriority) return b.shadowPriority - a.shadowPriority;
  if (a.shadowId === b.shadowId) return 0;
  return a.shadowId < b.shadowId ? -1 : 1;
}

/** Definitions subscribed to one trigger and eligible for automatic runs. */
export function subscribedDefinitions(
  definitions: readonly EffectiveShadowDefinition[],
  trigger: ShadowTrigger,
  config: ShadowMindsConfig,
): EffectiveShadowDefinition[] {
  if (!config.enabled) return [];
  return definitions.filter((definition) =>
    definition.enabled && !definition.hidden && definition.triggers.includes(trigger));
}

// ── Session-scoped deterministic scheduler ─────────────────────────

/** Bounded diagnostics list retained for the manager. */
const DIAGNOSTICS_MAX = 12;
const CLIPPED_IDS_MAX = 16;
const REASONS_PER_ACTIVATION_MAX = 4;

export interface ShadowSchedulerStartInput {
  definition: EffectiveShadowDefinition;
  taskEpoch: number;
  reasons: ShadowTriggerReason[];
  generation: number;
  checkpoint: unknown;
}

export type ShadowSchedulerStartOutcome =
  | { outcome: "started"; runId?: string }
  | { outcome: "busy" }
  | { outcome: "failed"; reason: string };

export interface ShadowSchedulerDeps {
  now(): number;
  config(): ShadowMindsConfig;
  /** Re-read effective definitions before each trigger evaluation. */
  definitions(): readonly EffectiveShadowDefinition[];
  /** Starts one automatic run through the session runtime. */
  start(input: ShadowSchedulerStartInput): ShadowSchedulerStartOutcome;
  /**
   * Frees one slot by superseding the oldest automatic run from an older
   * task epoch; manual runs are never eligible.
   */
  preemptOldestAutomatic(currentEpoch: number): { ok: boolean; runId?: string };
  /** Cancels every active run of one task epoch (user interruption). */
  cancelTaskRuns(epoch: number): number;
  /** Cancels every automatic run (session pause). */
  cancelAutomaticRuns(reason: string): number;
  /** Old-task undelivered results downgrade to notify delivery. */
  forceNotifyOldResults(beforeEpoch: number): number;
}

export interface ShadowSchedulerSnapshot {
  taskEpoch: number;
  paused: boolean;
  toolGeneration: number;
  automaticStartsByTask: Array<{ epoch: number; starts: number }>;
  pending: ShadowPendingActivation[];
  clippedIds: string[];
  diagnostics: string[];
}

export interface ShadowScheduler {
  /** A new non-extension user input opens the next task epoch. */
  handleInput(source: string): void;
  /** Marks whether the run that is starting belongs to a real user task. */
  handleRunStart(realUserTask: boolean): void;
  /** One parent tool execution began: marks a dirty generation. */
  observeToolStart(toolName: string, args: unknown): void;
  /** One parent tool execution settled: mutation and failure observation. */
  observeToolEnd(toolName: string, isError: boolean, args: unknown): void;
  /** Coalesces the turn's observations into pending activations and dispatches. */
  handleTurnEnd(checkpoint: unknown): void;
  /** Completion trigger for the settled real-user run; interruption cancels. */
  handleAgentEnd(input: { interrupted: boolean; checkpoint: unknown }): void;
  /** A run settled: a concurrency slot may have freed. */
  handleRunSettled(): void;
  pause(): void;
  resume(): void;
  snapshot(): ShadowSchedulerSnapshot;
  /** Session-scoped reset: state is rebuilt per parent session. */
  reset(): void;
}

interface TurnObservation {
  reasons: ShadowTriggerReason[];
  generation: number;
}

/**
 * Creates the session-scoped deterministic scheduler. Automatic triggers are
 * observed only inside real-user parent runs; extension continuations and
 * paused sessions never create trigger opportunities, and events observed
 * while paused are dropped rather than replayed on resume.
 */
export function createShadowScheduler(deps: ShadowSchedulerDeps): ShadowScheduler {
  let taskEpoch = 1;
  let paused = false;
  let toolGeneration = 0;
  let realUserRunActive = false;
  let pendingRealUserRun = false;
  /** Per-shadow reviewed generation: one automatic start per reviewed generation. */
  const reviewedGenerations = new Map<string, number>();
  const automaticStartsByTask = new Map<number, number>();
  const pending = new Map<string, ShadowPendingActivation>();
  const clippedIds: string[] = [];
  const diagnostics: string[] = [];
  let turn: TurnObservation = { reasons: [], generation: 0 };

  const recordDiagnostic = (text: string): void => {
    diagnostics.push(text);
    if (diagnostics.length > DIAGNOSTICS_MAX) diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_MAX);
  };

  const recordClipped = (shadowId: string): void => {
    clippedIds.push(shadowId);
    if (clippedIds.length > CLIPPED_IDS_MAX) clippedIds.splice(0, clippedIds.length - CLIPPED_IDS_MAX);
    recordDiagnostic(`Queued Shadow '${shadowId}' was clipped by the pending-activation limit.`);
  };

  const startsFor = (epoch: number): number => automaticStartsByTask.get(epoch) ?? 0;

  /** Enqueues or merges one activation; one pending snapshot per Shadow. */
  const enqueue = (input: {
    definition: EffectiveShadowDefinition;
    trigger: ShadowTrigger;
    at: number;
    detail?: string;
    generation: number;
    checkpoint: unknown;
  }): void => {
    const existing = pending.get(input.definition.id);
    const reasons = existing
      ? existing.reasons
      : ([] as ShadowTriggerReason[]);
    mergeTriggerReason(reasons, {
      trigger: input.trigger,
      at: input.at,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.trigger === "tool_turn" ? { generation: input.generation } : {}),
    });
    const ordered = orderReasons(reasons).slice(0, REASONS_PER_ACTIVATION_MAX);
    const activation: ShadowPendingActivation = {
      shadowId: input.definition.id,
      taskEpoch: existing?.taskEpoch ?? taskEpoch,
      shadowPriority: input.definition.priority,
      bestTrigger: ordered[0]!.trigger,
      reasons: ordered,
      generation: input.generation,
      checkpoint: input.checkpoint,
      enqueuedAt: existing?.enqueuedAt ?? input.at,
      lastObservedAt: input.at,
    };
    pending.set(input.definition.id, activation);

    // Bounded queue: keep the highest-ranked items, record every clipped ID.
    const limit = deps.config().defaults.maxQueuedShadowIds;
    while (pending.size > limit) {
      const ranked = rankedPending();
      const lowest = ranked[ranked.length - 1]!;
      pending.delete(lowest.shadowId);
      recordClipped(lowest.shadowId);
    }
  };

  const rankedPending = (): ShadowPendingActivation[] =>
    [...pending.values()].sort(compareActivations);

  let dispatching = false;

  /** Starts pending activations in deterministic rank order. */
  const dispatch = (): void => {
    // Starting a run notifies runtime subscribers synchronously; a re-entered
    // dispatch would see the activation it is starting as still pending.
    if (dispatching) return;
    dispatching = true;
    try {
      dispatchOnce();
    } finally {
      dispatching = false;
    }
  };

  const dispatchOnce = (): void => {
    const config = deps.config();
    if (!config.enabled || paused) return;
    for (const activation of rankedPending()) {
      if (startsFor(activation.taskEpoch) >= config.defaults.maxAutomaticStartsPerTask) {
        pending.delete(activation.shadowId);
        recordDiagnostic(
          `Shadow '${activation.shadowId}' was dropped: the task's automatic-start budget of ${config.defaults.maxAutomaticStartsPerTask} is exhausted.`,
        );
        continue;
      }
      const definition = deps.definitions().find((entry) => entry.id === activation.shadowId);
      if (!definition || !definition.enabled || definition.hidden) {
        pending.delete(activation.shadowId);
        recordDiagnostic(`Shadow '${activation.shadowId}' is no longer eligible; its pending activation was dropped.`);
        continue;
      }
      const started = deps.start({
        definition,
        taskEpoch: activation.taskEpoch,
        reasons: activation.reasons,
        generation: activation.generation,
        checkpoint: activation.checkpoint,
      });
      if (started.outcome === "started") {
        pending.delete(activation.shadowId);
        if (activation.bestTrigger === "tool_turn") {
          reviewedGenerations.set(activation.shadowId, activation.generation);
        } else {
          // A merged activation reviews its tool-turn component too.
          const toolTurn = activation.reasons.find((reason) => reason.trigger === "tool_turn");
          if (toolTurn) reviewedGenerations.set(activation.shadowId, toolTurn.generation ?? activation.generation);
        }
        automaticStartsByTask.set(activation.taskEpoch, startsFor(activation.taskEpoch) + 1);
        continue;
      }
      if (started.outcome === "failed") {
        pending.delete(activation.shadowId);
        recordDiagnostic(`Shadow '${activation.shadowId}' failed to start: ${started.reason}`);
        continue;
      }
      // busy: a newer task may preempt an older-task automatic run.
      if (activation.taskEpoch < taskEpoch) continue;
      const preempted = deps.preemptOldestAutomatic(taskEpoch);
      if (!preempted.ok) continue;
      const retried = deps.start({
        definition,
        taskEpoch: activation.taskEpoch,
        reasons: activation.reasons,
        generation: activation.generation,
        checkpoint: activation.checkpoint,
      });
      if (retried.outcome === "started") {
        pending.delete(activation.shadowId);
        const toolTurn = activation.reasons.find((reason) => reason.trigger === "tool_turn");
        if (toolTurn) reviewedGenerations.set(activation.shadowId, toolTurn.generation ?? activation.generation);
        automaticStartsByTask.set(activation.taskEpoch, startsFor(activation.taskEpoch) + 1);
      } else if (retried.outcome === "failed") {
        pending.delete(activation.shadowId);
        recordDiagnostic(`Shadow '${activation.shadowId}' failed to start: ${retried.reason}`);
      }
      // Still busy after preemption: leave it queued.
    }
  };

  return {
    handleInput(source) {
      if (source === "extension") return;
      taskEpoch += 1;
      pendingRealUserRun = true;
      // A new task downgrades every still-undelivered older-task result to
      // inbox-only delivery; older runs may finish as lower-priority work.
      const downgraded = deps.forceNotifyOldResults(taskEpoch);
      if (downgraded > 0) {
        recordDiagnostic(`${downgraded} older-task result${downgraded === 1 ? "" : "s"} downgraded to notify delivery.`);
      }
    },
    handleRunStart(realUserTask) {
      realUserRunActive = pendingRealUserRun && realUserTask;
      pendingRealUserRun = false;
      if (!realUserRunActive) turn = { reasons: [], generation: 0 };
    },
    observeToolStart(_toolName, _args) {
      if (!realUserRunActive || paused) return;
      toolGeneration += 1;
      turn.generation = toolGeneration;
    },
    observeToolEnd(toolName, isError, args) {
      if (!realUserRunActive || paused) return;
      if (isError) {
        // Only declaratively classified quality commands that ended
        // non-zero create failure reasons; arbitrary probes stay silent.
        if (toolName !== "bash" && toolName !== "pwsh" && toolName !== "shell") return;
        const command = commandFromArgs(args);
        if (!command) return;
        const kind = classifyQualityCommand(command);
        if (!kind) return;
        mergeTriggerReason(turn.reasons, {
          trigger: "failure",
          at: deps.now(),
          detail: `${kind} command failed`,
          generation: toolGeneration,
        });
        return;
      }
      // A successful Pi or pi-square-owned mutation tool marks the reason.
      if (!isMutationToolName(toolName)) return;
      mergeTriggerReason(turn.reasons, {
        trigger: "mutation",
        at: deps.now(),
        detail: mutationDetail(toolName, args),
        generation: toolGeneration,
      });
    },
    handleTurnEnd(checkpoint) {
      if (!realUserRunActive) {
        turn = { reasons: [], generation: 0 };
        return;
      }
      const config = deps.config();
      const definitions = deps.definitions();
      const at = deps.now();
      // Tool-turn: dirty generations this turn.
      if (turn.generation > 0 && config.enabled && !paused) {
        for (const definition of subscribedDefinitions(definitions, "tool_turn", config)) {
          const reviewed = reviewedGenerations.get(definition.id) ?? 0;
          if (turn.generation <= reviewed) continue;
          enqueue({
            definition,
            trigger: "tool_turn",
            at,
            generation: turn.generation,
            checkpoint,
          });
        }
      }
      // Merged mutation and failure reasons from the same turn coalesce into
      // the same pending activation.
      for (const reason of orderReasons(turn.reasons)) {
        if (reason.trigger === "tool_turn") continue;
        for (const definition of subscribedDefinitions(definitions, reason.trigger, config)) {
          enqueue({
            definition,
            trigger: reason.trigger,
            at,
            detail: reason.detail,
            generation: turn.generation,
            checkpoint,
          });
        }
      }
      turn = { reasons: [], generation: 0 };
      dispatch();
    },
    handleAgentEnd({ interrupted, checkpoint }) {
      if (interrupted) {
        // User interruption cancels all current-task Shadow work, manual
        // included, and clears current-task pending activations.
        const cancelled = deps.cancelTaskRuns(taskEpoch);
        for (const [id, activation] of [...pending]) {
          if (activation.taskEpoch === taskEpoch) pending.delete(id);
        }
        if (cancelled > 0) recordDiagnostic(`User interruption cancelled ${cancelled} current-task run${cancelled === 1 ? "" : "s"}.`);
        realUserRunActive = false;
        return;
      }
      if (!realUserRunActive) return;
      const config = deps.config();
      const at = deps.now();
      if (config.enabled && !paused) {
        for (const definition of subscribedDefinitions(deps.definitions(), "completion", config)) {
          enqueue({
            definition,
            trigger: "completion",
            at,
            generation: turn.generation,
            checkpoint,
          });
        }
      }
      turn = { reasons: [], generation: 0 };
      realUserRunActive = false;
      dispatch();
    },
    handleRunSettled() {
      dispatch();
    },
    pause() {
      if (paused) return;
      paused = true;
      const cancelled = deps.cancelAutomaticRuns("paused");
      pending.clear();
      turn = { reasons: [], generation: 0 };
      recordDiagnostic(`Session paused: ${cancelled} automatic run${cancelled === 1 ? "" : "s"} cancelled; automatic triggers are blocked.`);
    },
    resume() {
      if (!paused) return;
      paused = false;
      recordDiagnostic("Session resumed: paused events are not replayed.");
    },
    snapshot() {
      return {
        taskEpoch,
        paused,
        toolGeneration,
        automaticStartsByTask: [...automaticStartsByTask.entries()]
          .sort((a, b) => b[0] - a[0])
          .slice(0, 8)
          .map(([epoch, starts]) => ({ epoch, starts })),
        pending: rankedPending().map((activation) => structuredClone(activation)),
        clippedIds: [...clippedIds],
        diagnostics: [...diagnostics],
      };
    },
    reset() {
      taskEpoch = 1;
      paused = false;
      toolGeneration = 0;
      realUserRunActive = false;
      pendingRealUserRun = false;
      reviewedGenerations.clear();
      automaticStartsByTask.clear();
      pending.clear();
      clippedIds.length = 0;
      diagnostics.length = 0;
      turn = { reasons: [], generation: 0 };
    },
  };
}

function boundedArgString(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).command;
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function commandFromArgs(args: unknown): string | undefined {
  return boundedArgString(args);
}

function mutationDetail(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return toolName;
  const record = args as Record<string, unknown>;
  const path = record.file_path ?? record.path ?? record.filePath;
  if (typeof path !== "string" || !path.trim()) return toolName;
  const bounded = path.length <= 120 ? path : `${path.slice(0, 119)}…`;
  return `${toolName} ${bounded}`;
}
