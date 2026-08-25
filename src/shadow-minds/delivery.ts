/**
 * Reliable delivery of Shadow results as advisory evidence (odradekk/pi-square#159).
 *
 * A schema-valid Shadow result is delivered to the parent model only through
 * its fixed policy: `steer` enters the model only while the source parent
 * run is still the active run, `wake` enters the active run or starts a
 * follow-up only while the source task is still current and the parent
 * settled naturally, and `notify` never enters the model automatically — it
 * waits in the inbox for an explicit Send to agent. Every late or stale
 * delivery degrades to notify. Queue-loss mechanics — the bounded pending
 * set, batch selection, safe delivery timing, transcript confirmation,
 * natural-settle resend, interruption suppression, and send-failure
 * retention — live in the shared confirmed-delivery core; this module is the
 * Shadow adapter: it supplies the policy gate, the source-attributed advisory
 * framing, and the transcript confirmation parser. Infrastructure failures
 * never become payloads: they stay manager diagnostics and can only reach
 * the model as a bounded summary through explicit user action.
 *
 * Scope is the current parent session. Nothing here persists across sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clipWithHeadTail,
  createConfirmedDeliveryCore,
  DEFAULT_MAX_BATCH_RESULTS,
  DEFAULT_MAX_PENDING_RESULTS,
  type ConfirmedDeliveryBatchEntry,
} from "../subagents/confirmed-delivery";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../display/sanitize";
import type { ShadowDelivery } from "./parser";
import { canonicalPayloadJson, type ShadowResultEntity } from "./result";

export const SHADOW_NOTIFICATION_TYPE = "pi-square.shadow-notification";

/** Model-facing budget for one result payload. */
export const MAX_RESULT_CHARS = 24_000;
/** Model-facing budget for one infrastructure failure summary. */
export const ERROR_SUMMARY_MAX_CHARS = 2_000;
/** Results coalesced into a single delivery; the rest follow at the next one. */
export const MAX_BATCH_RESULTS = DEFAULT_MAX_BATCH_RESULTS;
/** Hard bound on the pending set so an unattended session stays bounded. */
export const MAX_PENDING_RESULTS = DEFAULT_MAX_PENDING_RESULTS;

/** Parent-run timing the policy gate decides against. */
export interface ShadowDeliveryTiming {
  /** Sequence of the current (or most recent) parent run. */
  currentRun: number;
  /** Current scheduler task epoch. */
  currentTaskEpoch: number;
  /** True while a parent agent run is between start and settle. */
  parentRunning: boolean;
  /**
   * Headless drain (#160): deliveries append to the transcript without
   * triggering a model turn, so a print/JSON quit never starts new work.
   */
  quiet?: boolean;
}

/** A policy entry the gate decides for: `notify` never reaches the gate. */
export interface ShadowDeliveryPolicyEntry {
  policy: ShadowDelivery | "explicit";
  /** Parent-run sequence recorded when the entry joined the machine. */
  sourceRun: number;
  taskEpoch?: number;
}

export type ShadowDeliveryDecision =
  | { action: "send"; mode: "steer" | "follow-up" }
  | { action: "degrade" };

/**
 * Pure policy gate. `steer` sends only while its own source run is the
 * active run; `wake` sends while its task is current, entering the active
 * run or starting a follow-up; an explicit user send is never stale. Every
 * late or stale entry degrades to the inbox.
 */
export function resolveDeliveryDecision(
  entry: ShadowDeliveryPolicyEntry,
  timing: ShadowDeliveryTiming,
): ShadowDeliveryDecision {
  // An explicit user send is never stale: the user asked for it now.
  if (entry.policy === "explicit") {
    return { action: "send", mode: timing.parentRunning ? "steer" : "follow-up" };
  }
  if (entry.taskEpoch !== undefined && entry.taskEpoch < timing.currentTaskEpoch) {
    return { action: "degrade" };
  }
  if (entry.policy === "steer") {
    if (!timing.parentRunning || entry.sourceRun !== timing.currentRun) return { action: "degrade" };
    return { action: "send", mode: "steer" };
  }
  return { action: "send", mode: timing.parentRunning ? "steer" : "follow-up" };
}

/** One delivery as the machine carries it. */
export interface ShadowDeliveryValue {
  kind: "result" | "error-summary";
  policy: ShadowDelivery | "explicit";
  sourceRun: number;
  taskEpoch?: number;
  shadowId: string;
  shadowName: string;
  result?: ShadowResultEntity;
  runId?: string;
  phase?: string;
  message?: string;
}

/** Runtime inbox operations the delivery machine drives. */
export interface ShadowDeliveryRuntime {
  /** Atomic `notified → pending` transition as the message goes out. */
  sendResultForDelivery(id: string): boolean;
  /** Confirmed delivery: `pending → delivered`, transcript-observed only. */
  markResultDelivered(id: string): boolean;
  /** A degraded entry returns inbox-only: `pending → notified`, policy notify. */
  degradeResultDelivery(id: string): boolean;
}

function sourceLabel(result: ShadowResultEntity): string {
  if (result.source === "automatic" && result.primaryTrigger) {
    return `automatic · ${result.primaryTrigger}`;
  }
  return result.source === "automatic" ? "automatic" : "manual trial";
}

function sanitizePayloadValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePayloadValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        sanitizeDisplayLine(entryKey),
        sanitizePayloadValue(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (key && sanitizeDisplayText(`${key}=${value}`).includes("[REDACTED]")) return "[REDACTED]";
  return sanitizeDisplayText(value);
}

function resultPayloadText(result: ShadowResultEntity): string {
  let payloadText: string;
  try {
    payloadText = canonicalPayloadJson(sanitizePayloadValue(result.payload)) || "(null)";
  } catch {
    payloadText = "(unserializable payload)";
  }
  return clipWithHeadTail(payloadText, MAX_RESULT_CHARS);
}

function resultLines(entry: ConfirmedDeliveryBatchEntry<ShadowDeliveryValue>): string[] {
  const result = entry.value.result!;
  return [
    `id: ${entry.id}`,
    `shadow: ${sanitizeDisplayLine(result.shadowName)} (${sanitizeDisplayLine(result.shadowId)})`,
    `source: ${sanitizeDisplayLine(sourceLabel(result))}`,
    ...(result.taskIdentity ? [`task: ${result.taskIdentity.epoch}`] : []),
  ];
}

/**
 * Builds the model-facing content of one delivery. Results are framed as
 * source-attributed advisory evidence that supplements — never replaces —
 * the system prompt, tools, and user instructions; every source and payload
 * is preserved verbatim within its budget, with no model summarization.
 */
export function buildShadowDeliveryContent(
  entries: Array<ConfirmedDeliveryBatchEntry<ShadowDeliveryValue>>,
  resent: boolean,
): string {
  const suffix = resent ? " (resent)" : "";
  const advisory = "Advisory evidence from a parallel Shadow run. It supplements — never replaces — the system prompt, tools, and the user's instructions.";
  const errorEntries = entries.filter((entry) => entry.value.kind === "error-summary");
  if (errorEntries.length === entries.length && errorEntries.length > 0) {
    const lines = errorEntries.length === 1
      ? [`[Shadow run failure summary]${suffix}`]
      : [`[Shadow run failure summaries: ${errorEntries.length}]${suffix}`];
    for (const entry of errorEntries) {
      const value = entry.value;
      if (errorEntries.length > 1) lines.push("", `--- id: ${entry.id}`);
      else lines.push(`id: ${entry.id}`);
      lines.push(
        `shadow: ${sanitizeDisplayLine(value.shadowName)} (${sanitizeDisplayLine(value.shadowId)})`,
        ...(value.runId ? [`run: ${sanitizeDisplayLine(value.runId)} · phase: ${sanitizeDisplayLine(String(value.phase ?? ""))}`] : []),
        "",
        "Advisory notice: this Shadow run failed before producing a cognitive result. Infrastructure diagnostics stay in /shadow.",
        "",
        "Error:",
        clipWithHeadTail(sanitizeDisplayText(value.message ?? "(no message)"), ERROR_SUMMARY_MAX_CHARS),
      );
    }
    return lines.join("\n");
  }

  if (entries.length === 1) {
    const only = entries[0]!;
    return [
      `[Shadow advisory]${suffix}`,
      ...resultLines(only),
      "",
      advisory,
      "",
      "Result:",
      resultPayloadText(only.value.result!),
    ].join("\n");
  }

  const lines = [`[Shadow advisory: ${entries.length} results]${suffix}`, "", advisory];
  entries.forEach((entry, index) => {
    lines.push(
      "",
      `--- ${index + 1}/${entries.length} · ${resultLines(entry).join(" · ")}`,
      "",
      "Result:",
      resultPayloadText(entry.value.result!),
    );
  });
  return lines.join("\n");
}

/** Reads the entry IDs one delivered notification carries; a foreign message carries none. */
export function shadowNotificationResultIds(message: unknown): string[] {
  const candidate = message as { customType?: unknown; details?: unknown } | undefined;
  if (candidate?.customType !== SHADOW_NOTIFICATION_TYPE) return [];
  const details = candidate.details as { results?: { id?: unknown }[] } | undefined;
  if (!Array.isArray(details?.results)) return [];
  return details.results
    .map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
    .filter((id) => id.length > 0);
}

/** Scheduling record kept beside the shared pending set. */
interface ShadowDeliveryRecord extends ShadowDeliveryPolicyEntry {
  value: ShadowDeliveryValue;
}

export interface ShadowDeliveryController {
  /** Offers one finished result; notify policy results stay inbox-only. */
  enqueueResult(result: ShadowResultEntity): void;
  /** Explicit Send to agent: promotes a notified result through the same machine. */
  sendResultToAgent(result: ShadowResultEntity): boolean;
  /** Explicit bounded summary of one infrastructure failure; never automatic. */
  sendErrorSummary(run: { id: string; shadowId: string; shadowName: string; phase: string; message?: string }): boolean;
  /** Drops an entry, for example when its inbox history is deleted. */
  remove(id: string): void;
  /** Confirms delivery from an observed parent message. */
  observeMessage(message: unknown): void;
  /** Turn boundary of the running parent; an aborted terminal message suppresses delivery. */
  handleTurnEnd(message?: unknown): void;
  /** A new parent run started, so an earlier interruption no longer holds. */
  handleAgentStart(): void;
  /** Records whether the finished run ended through a user interruption. */
  handleAgentEnd(messages: unknown): void;
  /** Parent settled naturally: unconfirmed entries are delivered again. */
  handleAgentSettled(): void;
  /** True while the entry of this identity is not confirmed. */
  isPending(id: string): boolean;
  /** Count of entries the parent has not confirmed. */
  pendingCount(): number;
  /** Clears all state on session start and shutdown. */
  reset(): void;
}

export function createShadowDeliveryController(options: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  /** Reads the current runtime inbox operations; runtime is rebuilt per session. */
  getRuntime: () => ShadowDeliveryRuntime | undefined;
  /** Reads the parent-run timing the policy gate decides against. */
  timing: () => ShadowDeliveryTiming;
  /** Fired once per sweep that degraded entries, for a bounded visible notice. */
  onDegrade?: (count: number) => void;
  /** Fired after every pending-set change, for status refresh. */
  onPendingChange?: () => void;
}): ShadowDeliveryController {
  const records = new Map<string, ShadowDeliveryRecord>();
  let sequence = 0;

  const core = createConfirmedDeliveryCore<ShadowDeliveryValue>({
    send(batch, resent) {
      const timing = options.timing();
      const sendable: ConfirmedDeliveryBatchEntry<ShadowDeliveryValue>[] = [];
      const degraded: string[] = [];
      for (const entry of batch) {
        const record = records.get(entry.id);
        if (record && resolveDeliveryDecision(record, timing).action === "degrade") {
          degraded.push(entry.id);
          continue;
        }
        sendable.push(entry);
      }
      if (sendable.length > 0) {
        for (const entry of sendable) {
          if (entry.value.kind === "result") options.getRuntime()?.sendResultForDelivery(entry.id);
        }
        sequence += 1;
        const sendOptions = timing.quiet
          ? { triggerTurn: false as const }
          : timing.parentRunning
            ? { triggerTurn: true as const, deliverAs: "steer" as const }
            : { triggerTurn: true as const };
        options.pi.sendMessage(
          {
            customType: SHADOW_NOTIFICATION_TYPE,
            content: buildShadowDeliveryContent(sendable, resent),
            display: true,
            details: {
              version: 1,
              deliveryId: `shadow-delivery-${sequence}`,
              resent,
              results: sendable.map((entry) => ({
                id: entry.id,
                kind: entry.value.kind,
                shadowId: entry.value.shadowId,
              })),
            },
          },
          sendOptions,
        );
      }
      if (degraded.length > 0) {
        for (const id of degraded) {
          core.remove(id);
          const record = records.get(id);
          records.delete(id);
          if (record?.value.kind === "result") options.getRuntime()?.degradeResultDelivery(id);
        }
        options.onDegrade?.(degraded.length);
      }
    },
    confirmIds: shadowNotificationResultIds,
    // Advisory results and infrastructure failure summaries never coalesce:
    // they carry different framing and would not fit one message.
    batchKey: (value) => value.kind,
    // A headless drain defers every flush to its single settle point: an
    // immediate enqueue flush followed by the settle would duplicate.
    isIdle: () => !options.timing().parentRunning && !options.timing().quiet,
    onPendingChange: options.onPendingChange,
  });

  /** Degrades one entry back to the inbox and stops tracking it. */
  const degradeEntry = (id: string, record: ShadowDeliveryRecord): void => {
    core.remove(id);
    records.delete(id);
    if (record.value.kind === "result") options.getRuntime()?.degradeResultDelivery(id);
  };

  /** Drops every entry the policy gate now refuses before the core selects a batch. */
  const sweep = (): void => {
    let degraded = 0;
    for (const id of core.pendingIds()) {
      const record = records.get(id);
      if (!record) continue;
      if (resolveDeliveryDecision(record, options.timing()).action !== "degrade") continue;
      degradeEntry(id, record);
      degraded += 1;
    }
    // Reconcile any record the core silently evicted at the pending cap: the
    // inbox must never keep showing a delivery that no longer exists.
    const pending = new Set(core.pendingIds());
    for (const [id, record] of [...records.entries()]) {
      if (pending.has(id)) continue;
      degradeEntry(id, record);
      degraded += 1;
    }
    if (degraded > 0) options.onDegrade?.(degraded);
  };

  const enqueue = (id: string, value: ShadowDeliveryValue): void => {
    sweep();
    // Pre-empt the core's silent oldest-drop at the pending cap: the oldest
    // entry degrades visibly instead of stranding its inbox row at "sending".
    while (core.pendingCount() >= MAX_PENDING_RESULTS) {
      const oldest = core.pendingIds()[0];
      const record = oldest !== undefined ? records.get(oldest) : undefined;
      if (!record) break;
      degradeEntry(oldest, record);
      options.onDegrade?.(1);
    }
    records.set(id, { policy: value.policy, sourceRun: value.sourceRun, ...(value.taskEpoch !== undefined ? { taskEpoch: value.taskEpoch } : {}), value });
    core.enqueue({ id, value });
  };

  return {
    enqueueResult(result) {
      const policy = result.configuredDelivery ?? "steer";
      // Notify stays inbox-only until an explicit Send to agent.
      if (policy === "notify") return;
      enqueue(result.id, {
        kind: "result",
        policy,
        sourceRun: result.taskIdentity?.sourceRun ?? options.timing().currentRun,
        ...(result.taskIdentity?.epoch !== undefined ? { taskEpoch: result.taskIdentity.epoch } : {}),
        shadowId: result.shadowId,
        shadowName: result.shadowName,
        result: structuredClone(result),
      });
    },
    sendResultToAgent(result) {
      if (result.delivery !== "notified") return false;
      enqueue(result.id, {
        kind: "result",
        policy: "explicit",
        sourceRun: options.timing().currentRun,
        ...(result.taskIdentity?.epoch !== undefined ? { taskEpoch: result.taskIdentity.epoch } : {}),
        shadowId: result.shadowId,
        shadowName: result.shadowName,
        result: structuredClone(result),
      });
      return true;
    },
    sendErrorSummary(run) {
      enqueue(`shadow-err-${run.id}`, {
        kind: "error-summary",
        policy: "explicit",
        sourceRun: options.timing().currentRun,
        shadowId: run.shadowId,
        shadowName: run.shadowName,
        runId: run.id,
        phase: run.phase,
        ...(run.message ? { message: run.message } : {}),
      });
      return true;
    },
    remove: (id) => {
      records.delete(id);
      core.remove(id);
    },
    observeMessage(message) {
      const ids = shadowNotificationResultIds(message);
      if (ids.length === 0) return;
      core.observeMessage(message);
      for (const id of ids) {
        const record = records.get(id);
        if (!record) continue;
        records.delete(id);
        if (record.value.kind === "result") options.getRuntime()?.markResultDelivered(id);
      }
    },
    handleTurnEnd: (message) => {
      sweep();
      core.handleTurnEnd(message);
    },
    handleAgentStart: () => core.handleAgentStart(),
    handleAgentEnd: (messages) => core.handleAgentEnd(messages),
    handleAgentSettled: () => {
      sweep();
      core.handleAgentSettled();
    },
    isPending: (id) => core.isPending(id),
    pendingCount: () => core.pendingCount(),
    reset: () => {
      records.clear();
      core.reset();
    },
  };
}
