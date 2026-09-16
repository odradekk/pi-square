/**
 * Shadow Minds feature entry (odradekk/pi-square#149, slices #153–#155;
 * read-only manager since #190).
 *
 * This entry owns the Pi event wiring: it registers the read-only manager
 * and the parameterized `/shadow <request>` Config Guide flow, wires the
 * delivery core and the completion gate at registration, and promotes the
 * registered state to the session state at `session_start` (the two state
 * shapes and the conversion live in `./state`, #373). Every handler narrows
 * the state union with `isShadowSessionState`: session-only work — delivery,
 * gate transitions, task snapshots, transcript references — is an explicit
 * no-op before a session starts, never a throw. The session runtime executes
 * manual no-tool trials through the shared one-time child-session executor
 * seam: every run freezes the parent core, project rules, and canonical
 * working directory from the parent's current prompt options at activation,
 * and composes the versioned Shadow SYSTEM and reference-only trajectory
 * from that snapshot. Definition files change only through ordinary file
 * tools; the manager never writes. The runtime performs model calls only
 * for explicitly started manual trials while the master switch is on.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  SHADOW_MINDS_HEADLESS_DRAIN_HARD_MAX_SECONDS,
  type PiSquareConfig,
  type ShadowMindsConfig,
} from "../core/config";
import {
  buildShadowConfigGuide,
  renderShadowConfigGuide,
  SHADOW_CONFIG_GUIDE_TYPE,
} from "./config-guide";
import { openShadowManager } from "./manager";
import {
  createPersistentShadowResultStore,
  reconcileShadowPartitions,
  sweepShadowDebugRetention,
} from "./result-partition";
import {
  createShadowResultStore,
  type ShadowResultStore,
} from "./result-store";
import {
  TASK_EPOCH_RETENTION_MAX,
  type ShadowSchedulerStartInput,
  type ShadowSchedulerStartOutcome,
  type ShadowScheduler,
} from "./scheduler";
import {
  DEFAULT_MAX_PENDING_RESULTS,
  subscribeDeliveryLifecycle,
  type DeliverySettleForwarding,
} from "../subagents/confirmed-delivery";
import {
  createShadowDeliveryCore,
  shadowNotificationResultIds,
  type ShadowDeliveryCore,
} from "./delivery";
import { createCompletionGate, type ShadowCompletionGate } from "./gate";
import type { ShadowRuntimeDeps } from "./runtime";
import {
  captureTrajectory,
  composeShadowRun,
  createRegisteredState,
  createStateRuntime,
  createStateScheduler,
  deliveredEvidence,
  hasRunningGateCompletion,
  isShadowSessionState,
  makeServices,
  notifyText,
  promoteToSessionState,
  taskSnapshotFromOptions,
  toolWarningNotice,
  type ShadowMindsRegisteredState,
  type ShadowMindsSessionState,
  type ShadowSessionPartition,
  type ShadowTaskSnapshot,
} from "./state";

/** Parent-session custom entry type for one bounded result reference. */
export const SHADOW_RESULT_ENTRY_TYPE = "pi-square.shadow-result";

export default function registerShadowMinds(
  pi: ExtensionAPI,
  config?: () => PiSquareConfig,
  runtimeDeps?: ShadowRuntimeDeps,
): ShadowMindsRegisteredState {
  const effectiveConfig = (): ShadowMindsConfig => config?.().shadowMinds ?? DEFAULT_CONFIG.shadowMinds;

  // Automatic runs start while nobody is watching the manager, so a reduced
  // tool set is notified too — but once per shadow and warning set, not on
  // every automatic trigger. A later definition edit changes the key and
  // reports again; an unchanged reduction stays quiet for the session.
  const announcedToolWarnings = new Set<string>();

  // The registration root holds one of the two state shapes (#373): the
  // registered shape from extension registration until `session_start`
  // promotes it to the session shape. Handlers narrow the union before any
  // session-only work.
  let state: ShadowMindsRegisteredState | ShadowMindsSessionState;

  const dispatchAutomatic = (activation: ShadowSchedulerStartInput): ShadowSchedulerStartOutcome => {
    const sessionCtx = ctx;
    if (!sessionCtx) return { outcome: "failed", reason: "No parent session context." };
    const taskSnapshot = taskSnapshots.get(activation.taskEpoch);
    if (!taskSnapshot) {
      return {
        outcome: "failed",
        reason: `The frozen authority snapshot for task ${activation.taskEpoch} is no longer retained.`,
      };
    }
    const outcome = composeShadowRun({
      state,
      ctx: sessionCtx,
      partition: isShadowSessionState(state) ? state.partition : undefined,
      definition: activation.definition,
      source: "automatic",
      trigger: activation.reasons[0]?.trigger,
      taskEpoch: activation.taskEpoch,
      sourceRun: activation.sourceRun,
      triggerReasons: activation.reasons,
      snapshot: taskSnapshot,
      trajectory: activation.checkpoint as ReturnType<typeof captureTrajectory> | undefined,
      onToolWarnings: (warnings) => {
        if (!sessionCtx.hasUI) return;
        const key = `${activation.definition.id}\n${warnings.join("\n")}`;
        if (announcedToolWarnings.has(key)) return;
        announcedToolWarnings.add(key);
        sessionCtx.ui.notify(notifyText(toolWarningNotice(activation.definition.id, warnings)), "warning");
      },
    });
    if (outcome.started) return { outcome: "started" };
    if (outcome.kind === "busy") return { outcome: "busy" };
    return { outcome: "failed", reason: outcome.reason ?? "The automatic run did not start." };
  };

  state = createRegisteredState({
    config,
    ...(runtimeDeps ? { runtimeDeps } : {}),
    currentParentRun: () => parentRunSeq,
    dispatchAutomatic,
  });

  // ── Caller-forwarded delivery settles (odradekk/pi-square#369) ─────────
  // The delivery subscription leaves `agent_settled` unwired: the completion
  // gate below releases a parked settle through this handle, an unheld settle
  // forwards at the settled event itself, and the headless shutdown drain
  // forwards settles itself. Assigned once the delivery controller exists.
  let deliverySettleForwarding: DeliverySettleForwarding | undefined;

  let ctx: ExtensionContext | undefined;
  const seenPhases = new Map<string, string>();
  const SHADOW_STATUS_KEY = "pi-square.shadow-minds";
  let statusContext: ExtensionContext | undefined;

  /** Renders the bounded conditional footer status: running, queued, unread. */
  const renderStatusText = (): string | undefined => {
    if (!effectiveConfig().enabled) return undefined;
    const snapshot = state.runtime.snapshot();
    const running = snapshot.runs.filter((run) => run.phase === "running").length;
    const queued = state.scheduler.snapshot().pending.length;
    const unread = snapshot.results.filter((result) => result.attention === "unread").length;
    const paused = state.scheduler.snapshot().paused;
    if (running === 0 && queued === 0 && unread === 0 && !paused) return undefined;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (queued > 0) parts.push(`${queued} queued`);
    if (unread > 0) parts.push(`${unread} unread`);
    if (paused) parts.push("paused");
    return `Shadow: ${parts.join(" · ")}`;
  };

  const refreshStatus = (): void => {
    if (!statusContext?.hasUI) return;
    statusContext.ui.setStatus?.(SHADOW_STATUS_KEY, renderStatusText());
  };

  const bindSchedulerStatus = (sessionCtx: ExtensionContext): void => {
    statusContext = sessionCtx;
    refreshStatus();
  };

  // ── Bounded completion gate (#160) ─────────────────────────────────
  // The gate never delays the parent answer: it only holds this extension's
  // settled handling for a bounded window after the answer has rendered. The
  // root reports parent run-state transitions below and at the Pi event
  // boundaries; which transition opens, re-evaluates, or closes the gate —
  // and with which reason — is derived inside the gate. The gate outlives
  // individual sessions: it is created once at registration, reset at each
  // session boundary, and published onto the state by the session promotion.
  const completionGate: ShadowCompletionGate = createCompletionGate({
    now: () => Date.now(),
    config: effectiveConfig,
    definitions: () => state.registry.definitions,
    scheduler: {
      pendingCompletions: () => state.scheduler.pendingCompletions(),
      cancelPendingCompletions: () => state.scheduler.cancelPendingCompletions(),
    },
    hasRunningCompletionRuns: (gateIds) => hasRunningGateCompletion(state.runtime.snapshot().runs, gateIds),
    // The gate calls this only when a settle is actually parked, so the
    // delivery flush needs no hold-state check of its own.
    forwardSettle: (_at) => {
      deliverySettleForwarding?.settle();
      refreshStatus();
    },
    onClose: (reason, cancelled) => {
      if (cancelled > 0 && ctx?.hasUI) {
        ctx.ui.notify(
          notifyText(`shadow-minds: completion gate closed (${reason}); ${cancelled} queued completion run${cancelled === 1 ? "" : "s"} cancelled`),
          "info",
        );
      }
    },
  });

  // The delivery core is created once at registration and reset at each
  // session boundary; Pi's event emitter offers no unsubscribe, so its
  // lifecycle subscription is wired once against this instance. The session
  // promotion publishes the same instance onto the state — the session shape
  // never carries a second, differently configured core.
  const shadowDelivery: ShadowDeliveryCore = createShadowDeliveryCore({
    pi,
    getResultStore: () => state.resultStore,
    timing: () => ({
      currentRun: parentRunSeq,
      currentTaskEpoch: state.scheduler.snapshot().taskEpoch,
      parentRunning: parentRunActive,
      ...(draining ? { quiet: true } : {}),
    }),
    onDegrade: (count) => {
      if (!ctx?.hasUI) return;
      ctx.ui.notify(
        notifyText(`shadow-minds: ${count} result${count === 1 ? "" : "s"} stayed in the inbox; the delivery window passed`),
        "info",
      );
    },
    onPendingChange: refreshStatus,
  });
  deliverySettleForwarding = subscribeDeliveryLifecycle(shadowDelivery, pi, { subscribeSettled: false });

  pi.registerMessageRenderer(SHADOW_CONFIG_GUIDE_TYPE, renderShadowConfigGuide);

  pi.registerCommand("shadow", {
    description: "Inspect read-only Shadow definitions, runs, and results, or ask Pi to help configure one.",
    handler: async (args, ctx) => {
      const rawRequest = String(args ?? "");
      const request = rawRequest.trim();
      state.refresh(ctx.cwd);
      if (request) {
        const guide = buildShadowConfigGuide(state.registry, ctx.cwd);
        pi.sendMessage({
          customType: SHADOW_CONFIG_GUIDE_TYPE,
          content: guide.content,
          display: true,
          details: guide.details,
        }, { deliverAs: "followUp" });
        pi.sendUserMessage(rawRequest, { deliverAs: "followUp" });
        return;
      }
      if (!ctx.hasUI) return;
      await openShadowManager(ctx, state.managerSnapshot(), makeServices(state, ctx, undefined, {
        onSchedulerChange: refreshStatus,
      }));
    },
  });

  // ── Deterministic automatic scheduling (odradekk/pi-square#158) ──────
  // Real-user runs alone create trigger opportunities: the input event
  // distinguishes interactive/rpc user input from extension continuations,
  // and the before_agent_start options freeze the per-task authority
  // snapshot every automatic activation of that task shares.
  let pendingIdleInput: "real" | "extension" | undefined;
  const queuedSteeringSources: Array<"real" | "extension"> = [];
  const queuedFollowUpSources: Array<"real" | "extension"> = [];
  let streamingInputDesynchronized = false;
  let skipInitialUserMessage = false;
  // Parent-run timing for delivery policies: one run spans its
  // before_agent_start boundary through agent_settled. Queued steering or
  // follow-up continuations of a still-streaming run stay inside that run;
  // a triggerTurn delivery (a wake follow-up) starts its own run, which
  // emits agent_start but never input or before_agent_start, so it can
  // neither open a task epoch nor re-trigger Shadows.
  let parentRunSeq = 0;
  let parentRunActive = false;
  let parentRunPrepared = false;
  // A headless drain makes every delivery quiet (no new turn); the gate
  // owns the held-settle bit itself.
  let draining = false;

  const makeRuntime = (store: ShadowResultStore) => createStateRuntime({
    config: effectiveConfig,
    ...(runtimeDeps ? { runtimeDeps } : {}),
    resultStore: store,
    currentTaskEpoch: () => state.scheduler.snapshot().taskEpoch,
  });

  const makeScheduler = (): ShadowScheduler => {
    const scheduler = createStateScheduler({
      config: effectiveConfig,
      currentRun: () => parentRunSeq,
      dispatch: dispatchAutomatic,
      sources: {
        definitions: () => state.registry.definitions,
        runtime: () => state.runtime,
        resultStore: () => state.resultStore,
      },
    });
    // Pause state is user-visible: both entry points (manager service and
    // any future direct call) refresh the conditional status. The gate
    // transition is session-scoped work; before session_start the pause
    // itself still applies, only the notification is skipped (#373).
    return {
      ...scheduler,
      pause() {
        if (isShadowSessionState(state)) state.gate.handleRunTransition({ kind: "scheduler-paused" });
        scheduler.pause();
        refreshStatus();
      },
      resume() {
        scheduler.resume();
        refreshStatus();
      },
    };
  };

  const toolArgsById = new Map<string, { toolName: string; args: unknown }>();
  const TOOL_ARG_PAIRS_MAX = 64;
  const STREAMING_INPUT_PAIRS_MAX = 64;
  pi.on("input", (event) => {
    const source = event?.source === "extension" ? "extension" : "real";
    if (event?.streamingBehavior) {
      // Pi queues streaming input without a new before_agent_start event and
      // drains steering messages before follow-ups. Keep those identities
      // separate so mixed real/extension inputs cannot misclassify.
      const queue = event.streamingBehavior === "followUp" ? queuedFollowUpSources : queuedSteeringSources;
      if (queue.length >= STREAMING_INPUT_PAIRS_MAX) {
        streamingInputDesynchronized = true;
        queuedSteeringSources.length = 0;
        queuedFollowUpSources.length = 0;
        return;
      }
      queue.push(source);
      return;
    }
    // Idle input is only committed at before_agent_start. Model/auth/preflight
    // failures after input must not advance the task epoch.
    pendingIdleInput = source;
  });

  const taskSnapshots = createTaskSnapshotStore();
  pi.on("before_agent_start", async (event, sessionCtx) => {
    const source = pendingIdleInput;
    pendingIdleInput = undefined;
    const realUserTask = source === "real";
    if (source) state.scheduler.handleInput(realUserTask ? "interactive" : "extension");
    // The run-start transition is reported for both input classes; the gate
    // itself derives that only a real-user task closes the held window. The
    // task snapshot is session-scoped state: before session_start there is
    // no session authority to freeze, so both are skipped there (#373).
    if (isShadowSessionState(state)) {
      state.gate.handleRunTransition({ kind: "parent-run-start", realUserTask });
      state.taskSnapshot = taskSnapshotFromOptions(
        event?.systemPromptOptions,
        sessionCtx?.cwd ?? state.cwd,
      );
      if (realUserTask) {
        taskSnapshots.record(state.scheduler.snapshot().taskEpoch, state.taskSnapshot);
      }
    }
    skipInitialUserMessage = true;
    parentRunSeq += 1;
    parentRunActive = true;
    parentRunPrepared = true;
    state.scheduler.handleRunStart(realUserTask);
    refreshStatus();
  });

  pi.on("agent_start", () => {
    // Normal user runs were already identified at before_agent_start. A
    // triggerTurn custom-message follow-up has no such boundary, so agent_start
    // is its only authoritative run-start signal.
    if (!parentRunPrepared) {
      parentRunSeq += 1;
      parentRunActive = true;
    }
    parentRunPrepared = false;
  });

  pi.on("agent_settled", () => {
    parentRunActive = false;
    // The completion gate (#160) holds the subsystem settle for its bounded
    // window: the parent answer has already rendered; only this extension's
    // settled handling waits. The gate parks the settle and its close
    // forwards it exactly once. Without a session there is no gate to park
    // it; an unheld settle forwards at the settled event itself.
    if (isShadowSessionState(state) && state.gate.holdSettle()) {
      refreshStatus();
      return;
    }
    deliverySettleForwarding?.settle();
  });

  pi.on("message_start", (event) => {
    if (event?.message?.role !== "user") return;
    if (skipInitialUserMessage) {
      skipInitialUserMessage = false;
      return;
    }
    if (streamingInputDesynchronized) {
      state.scheduler.handleRunStart(false);
      return;
    }
    const source = queuedSteeringSources.shift() ?? queuedFollowUpSources.shift();
    if (!source) return;
    const realUserTask = source === "real";
    if (isShadowSessionState(state)) state.gate.handleRunTransition({ kind: "parent-run-start", realUserTask });
    state.scheduler.handleInput(realUserTask ? "interactive" : "extension");
    // A queued continuation stays inside the same parent agent run, so it uses
    // the authority frozen by that run's before_agent_start boundary.
    if (realUserTask && isShadowSessionState(state) && state.taskSnapshot) {
      taskSnapshots.record(state.scheduler.snapshot().taskEpoch, state.taskSnapshot);
    }
    state.scheduler.handleRunStart(realUserTask);
    refreshStatus();
  });

  pi.on("tool_execution_start", (event) => {
    const toolCallId = String(event?.toolCallId ?? "");
    const toolName = String(event?.toolName ?? "");
    if (toolCallId) {
      if (toolArgsById.size >= TOOL_ARG_PAIRS_MAX) toolArgsById.clear();
      toolArgsById.set(toolCallId, { toolName, args: event?.args });
    }
    state.scheduler.observeToolStart(toolName, event?.args);
  });

  pi.on("tool_execution_end", (event) => {
    const toolCallId = String(event?.toolCallId ?? "");
    const toolName = String(event?.toolName ?? "");
    const paired = toolCallId ? toolArgsById.get(toolCallId) : undefined;
    if (toolCallId) toolArgsById.delete(toolCallId);
    const args = paired?.toolName === toolName ? paired.args : undefined;
    state.scheduler.observeToolEnd(toolName, Boolean(event?.isError), args, event?.result);
  });

  pi.on("turn_end", (event, sessionCtx) => {
    if (!sessionCtx) return;
    // A turn that ended through user interruption drops its observations
    // instead of dispatching: Pi emits turn_end before agent_end on abort,
    // and an aborted quality command is not a failure trigger.
    if ((event?.message as { stopReason?: unknown } | undefined)?.stopReason === "aborted") {
      if (isShadowSessionState(state)) state.gate.handleRunTransition({ kind: "parent-run-interrupted" });
      state.scheduler.handleTurnAbort();
      refreshStatus();
      return;
    }
    let checkpoint: ReturnType<typeof captureTrajectory> | undefined;
    if (state.scheduler.shouldCapture()) {
      try {
        checkpoint = captureTrajectory(sessionCtx, deliveredEvidence(state.runtime));
      } catch {
        checkpoint = undefined;
      }
    }
    state.scheduler.handleTurnEnd(checkpoint);
    refreshStatus();
  });

  pi.on("agent_end", (event, sessionCtx) => {
    const interrupted = Array.isArray(event?.messages)
      && event.messages.some((message) => (message as { stopReason?: unknown } | undefined)?.stopReason === "aborted");
    let checkpoint: ReturnType<typeof captureTrajectory> | undefined;
    if (sessionCtx && state.scheduler.shouldCapture()) {
      try {
        checkpoint = captureTrajectory(sessionCtx, deliveredEvidence(state.runtime));
      } catch {
        checkpoint = undefined;
      }
    }
    state.scheduler.handleAgentEnd({ interrupted, checkpoint });
    if (isShadowSessionState(state)) state.gate.handleRunTransition({ kind: "parent-run-end", interrupted });
    refreshStatus();
    streamingInputDesynchronized = false;
    queuedSteeringSources.length = 0;
    queuedFollowUpSources.length = 0;
    skipInitialUserMessage = false;
  });

  // The shared session coordinator is reset by the extension entry on
  // session start and shutdown; a private default stays unreset here.
  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    state.runtime.reset("Parent Pi session changed");
    seenPhases.clear();
    // Each parent session owns its Shadow state: persisted sessions get the
    // authoritative partition store (results survive reopening) while
    // non-persisted sessions fall back to memory with a visible diagnostic.
    const sessionDir = sessionCtx.sessionManager?.getSessionDir?.() ?? "";
    const sessionFile = sessionCtx.sessionManager?.getSessionFile?.();
    let store: ShadowResultStore | undefined;
    let partition: ShadowSessionPartition | undefined;
    if (!effectiveConfig().enabled) {
      // Disabled: no partition is opened, scanned, or created, and the
      // fallback notice stays silent.
      partition = undefined;
    } else if (sessionDir && typeof sessionFile === "string" && sessionFile.length > 0) {
      const sessionId = String(sessionCtx.sessionManager?.getSessionId?.() ?? "session");
      partition = { sessionDir, sessionId };
      const reconciled = reconcileShadowPartitions(sessionDir, sessionId);
      if (reconciled.removed.length > 0) {
        sessionCtx.hasUI && sessionCtx.ui.notify(
          `shadow-minds: removed ${reconciled.removed.length} orphaned Shadow partition${reconciled.removed.length === 1 ? "" : "s"}`,
          "info",
        );
      }
      try {
        sweepShadowDebugRetention(sessionDir, sessionId);
        const persistentStore = createPersistentShadowResultStore({ sessionDir, sessionId });
        store = persistentStore;
        for (const diagnostic of persistentStore.diagnostics().slice(0, 3)) {
          sessionCtx.hasUI && sessionCtx.ui.notify(`shadow-minds: ${notifyText(diagnostic)}`, "warning");
        }
      } catch (error) {
        partition = undefined;
        sessionCtx.hasUI && sessionCtx.ui.notify(
          `shadow-minds: the persistent inbox could not open (${error instanceof Error ? error.message : String(error)}); results stay in memory`,
          "warning",
        );
      }
    } else {
      partition = undefined;
      if (sessionCtx.hasUI) {
        sessionCtx.ui.notify(
          "shadow-minds: this session is not persisted; Shadow results stay in memory",
          "info",
        );
      }
    }
    const sessionStore = store ?? createShadowResultStore({});
    // session_start converts the registered state into the session state
    // (#373): every session member is present from here on, and the
    // identity-preserving promotion keeps the state's methods valid.
    state = promoteToSessionState(state, {
      delivery: shadowDelivery,
      gate: completionGate,
      partition,
      runtime: makeRuntime(sessionStore),
      scheduler: makeScheduler(),
      resultStore: sessionStore,
    });
    // The delivery core and the gate outlive the session; each boundary
    // resets them (their lifecycle subscription is wired once, at
    // registration, because Pi's emitter offers no unsubscribe).
    shadowDelivery.reset();
    completionGate.reset();
    parentRunSeq = 0;
    parentRunActive = false;
    parentRunPrepared = false;
    draining = false;
    // A result left pending by a lost session never resumes automatically:
    // it returns inbox-only with notify policy and waits for an explicit send.
    const recoveredDeliveries = sessionStore.recoverPendingDelivery();
    if (recoveredDeliveries > 0 && sessionCtx.hasUI) {
      sessionCtx.ui.notify(
        `shadow-minds: recovered ${recoveredDeliveries} undelivered result${recoveredDeliveries === 1 ? "" : "s"} to the inbox`,
        "info",
      );
    }
    pendingIdleInput = undefined;
    queuedSteeringSources.length = 0;
    queuedFollowUpSources.length = 0;
    streamingInputDesynchronized = false;
    skipInitialUserMessage = false;
    taskSnapshots.clear();
    toolArgsById.clear();
    bindRuntimeNotifications();
    bindSchedulerStatus(sessionCtx);
    state.refresh(sessionCtx.cwd);
    if (sessionCtx.hasUI && state.registry.diagnostics.length > 0) {
      const suffix = state.registry.diagnostics.length > 1
        ? ` (+${state.registry.diagnostics.length - 1} more)`
        : "";
      sessionCtx.ui.notify(`shadow-minds: ${state.registry.diagnostics[0]!.message}${suffix}`, "warning");
    }
  });

  pi.on("session_shutdown", async (event) => {
    // Session replacement (switch/fork/new/resume/reload) and interactive
    // quit cancel the applicable gate and Shadow work promptly: there is no
    // continuation to drain into.
    if (isShadowSessionState(state)) state.gate.handleRunTransition({ kind: "session-ending" });
    // A print/JSON quit is headless: Pi awaits this handler before the
    // process exits, so started completion runs get one bounded drain
    // window to finish, persist, and deliver quietly — no turn is started.
    // Replacement reasons must not drain: the outgoing session is replaced,
    // not continued. Only a session state holds pending completion work.
    const headless = (ctx?.mode === "print" || ctx?.mode === "json")
      && (event as { reason?: unknown } | undefined)?.reason === "quit";
    if (headless && isShadowSessionState(state) && effectiveConfig().enabled) {
      // Awaits inside the drain reset narrowing on the union, so the session
      // shape is captured once, before the loop.
      const session = state;
      const seconds = Math.min(
        Math.max(1, effectiveConfig().defaults.headlessDrainSeconds),
        SHADOW_MINDS_HEADLESS_DRAIN_HARD_MAX_SECONDS,
      );
      const deadline = Date.now() + seconds * 1_000;
      draining = true;
      try {
        while (Date.now() < deadline
          && state.runtime.snapshot().runs.some((run) => run.phase === "running")) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Drain compatible batches one at a time. Each batch is confirmed only
        // from an actual session entry; without confirmation, stop rather than
        // resend in a hot loop. The iteration cap is the pending hard bound.
        for (let batch = 0; batch < DEFAULT_MAX_PENDING_RESULTS && Date.now() < deadline; batch += 1) {
          const before = session.delivery.pendingCount();
          if (before === 0) break;
          deliverySettleForwarding?.settle();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const confirmed = session.delivery.confirmQuietDeliveries(
            quietDeliveryIdsFromBranch(ctx?.sessionManager),
          );
          if (confirmed === 0) break;
        }
      } finally {
        draining = false;
      }
    }
    state.runtime.reset("Parent Pi session shutdown");
    state.scheduler.reset();
    // The delivery core and the gate are registration-owned: they reset even
    // for a session that never started, exactly as before the state split.
    shadowDelivery.reset();
    completionGate.reset();
    draining = false;
    seenPhases.clear();
    statusContext?.ui.setStatus?.(SHADOW_STATUS_KEY, undefined);
    statusContext = undefined;
    ctx = undefined;
  });

  // Terminal manual-run outcomes surface as bounded session notifications;
  // operational failures never become cognitive payloads. New results also
  // land one bounded reference entry in the parent session transcript so
  // the inbox stays the single authoritative payload store.
  // Every non-running phase is terminal, so a phase change away from running
  // notifies once; entries for runs that left the history are pruned.
  let unsubscribeRuntime: (() => void) | undefined;
  // Reference dedup lives at the registration scope, not inside one
  // subscriber binding (#181): `seenResults` and `inFlightReferences`
  // survive runtime rebinds so overlapping subscribers and session
  // replacements within this extension instance share one view, and the
  // inbox-backed claim below arbitrates between separate runtime or
  // extension instances observing the same authoritative result through one
  // partition.
  const seenResults = new Set<string>();
  const inFlightReferences = new Set<string>();
  const bindRuntimeNotifications = (): void => {
    unsubscribeRuntime?.();
    // Results carry a persisted `referenced` flag, so a reopened session
    // does not re-append transcript references it already recorded. The
    // inbox-backed claim is acquired before appendEntry and survives runtime
    // rebinds or a second extension instance (#181). Pi 0.84.2's synchronous
    // append lifecycle still permits overlapping observers; the shared claim
    // makes the guarantee independent of subscriber timing. An explicit
    // append throw releases the owner token for retry. Once append returns,
    // uncertain persistence stays fail-closed rather than risking a duplicate.
    // Results restored from a reopened partition never auto-deliver: only
    // results created inside this session enter the delivery machine.
    const seenDelivery = new Set<string>(state.runtime.snapshot().results.map((result) => result.id));
    unsubscribeRuntime = state.runtime.subscribe(() => {
      const sessionCtx = ctx;
      // A settled run may have freed a concurrency slot for queued work.
      state.scheduler.handleRunSettled();
      // Result delivery, gate transitions, and transcript references are
      // session-scoped work (#373): before session_start there is neither a
      // transcript to reference nor a delivery window to honor, so the
      // subscriber observes lifecycle state only and never throws.
      if (!isShadowSessionState(state)) return;
      // Every gate-subscribed completion draining closes the gate early.
      state.gate.handleRunTransition({ kind: "shadow-activity" });
      refreshStatus();
      const results = state.runtime.snapshot().results;
      for (const result of results) {
        if (seenResults.has(result.id) || inFlightReferences.has(result.id) || result.referenced) continue;
        // Fresh results alone enter the delivery machine; results restored
        // from a reopened partition stay inbox-only until explicitly sent.
        if (!seenDelivery.has(result.id)) {
          seenDelivery.add(result.id);
          state.delivery.enqueueResult(result);
        }
        if (!effectiveConfig().enabled) continue;
        inFlightReferences.add(result.id);
        // Cross-lifecycle arbitration (#181): the inbox claim is exclusive
        // across every observer of the partition — this instance, a rebind,
        // or a second extension instance — so two stale-unreferenced views
        // of one authoritative result cannot both append it. A refused claim
        // stays fail-closed; only an append that explicitly throws releases
        // its owner token for a later retry.
        if (!state.resultStore.claimReference(result.id)) {
          inFlightReferences.delete(result.id);
          continue;
        }
        try {
          pi.appendEntry(SHADOW_RESULT_ENTRY_TYPE, {
            version: 1 as const,
            resultId: result.id,
            shadowId: result.shadowId.slice(0, 64),
            summary: result.summary.slice(0, 160),
            createdAt: result.createdAt,
          });
        } catch {
          // A session append that did not complete leaves no reference. The
          // result stays authoritative in the inbox and releasing this
          // instance's token lets a later observer retry.
          state.resultStore.releaseReferenceClaim(result.id);
          inFlightReferences.delete(result.id);
          continue;
        }
        // Once appendEntry returns, at-most-once takes precedence over retry:
        // if persisting `referenced` fails, the durable claim intentionally
        // remains and blocks a second append. The result is still recoverable
        // from the inbox; only its bounded transcript reference may lack the
        // persisted optimization bit until a later repair path.
        seenResults.add(result.id);
        try {
          state.resultStore.markReferenced(result.id);
        } catch {
          // Keep the claim fail-closed: the transcript append already landed.
        } finally {
          inFlightReferences.delete(result.id);
        }
      }
      if (!sessionCtx?.hasUI) return;
      const runs = state.runtime.snapshot().runs;
      const liveIds = new Set(runs.map((run) => run.id));
      for (const stale of seenPhases.keys()) {
        if (!liveIds.has(stale)) seenPhases.delete(stale);
      }
      for (const run of runs) {
        const previous = seenPhases.get(run.id);
        seenPhases.set(run.id, run.phase);
        if (previous === run.phase || run.phase === "running") continue;
        const outcomeMessage = run.phase === "submitted"
          ? `shadow-minds: ${run.shadowId} finished — result in the /shadow inbox`
          : `shadow-minds: ${run.shadowId} run ended (${run.phase}${run.message ? `: ${run.message}` : ""})`;
        sessionCtx.ui.notify(notifyText(outcomeMessage), run.phase === "error" ? "warning" : "info");
      }
    });
  };
  bindRuntimeNotifications();

  return state;
}

const QUIET_CONFIRM_BRANCH_ENTRIES_MAX = 128;

/** IDs carried by actual persisted Shadow custom-message entries near the leaf. */
function quietDeliveryIdsFromBranch(sessionManager: unknown): string[] {
  const branch = (sessionManager as { getBranch?: () => unknown[] } | undefined)?.getBranch?.();
  if (!Array.isArray(branch)) return [];
  const ids = new Set<string>();
  for (const entry of branch.slice(-QUIET_CONFIRM_BRANCH_ENTRIES_MAX)) {
    for (const id of shadowNotificationResultIds(entry)) ids.add(id);
  }
  return [...ids];
}

/** Bounded per-task-epoch snapshot store: late dispatch composes with the authority frozen for that task. */
export function createTaskSnapshotStore() {
  const store = new Map<number, ShadowTaskSnapshot>();
  return {
    record(epoch: number, snapshot: ShadowTaskSnapshot): void {
      store.set(epoch, snapshot);
      while (store.size > TASK_EPOCH_RETENTION_MAX) {
        const oldest = [...store.keys()].sort((a, b) => a - b)[0];
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get(epoch: number): ShadowTaskSnapshot | undefined {
      return store.get(epoch);
    },
    clear(): void {
      store.clear();
    },
  };
}

export const __testables = {
  makeServices,
  hasRunningGateCompletion,
  createTaskSnapshotStore,
  quietDeliveryIdsFromBranch,
};
