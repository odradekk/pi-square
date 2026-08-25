/**
 * Shadow result submission and inbox (odradekk/pi-square#155).
 *
 * One stable terminating tool, `submit_shadow_result`, carries every Shadow
 * result. Its model-callable schema is fixed — a strict object with one
 * required `payload` string and no additional properties — so the schema
 * never changes per Shadow. The payload string is parsed as JSON and
 * validated against the effective bounded output schema; field-level
 * rejections are returned for an in-run retry, and only a valid submission
 * terminates the run. Results land in the session inbox; the bounded
 * recoverable persistent inbox arrives with #157.
 */

import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeDisplayLine } from "../display/sanitize";
import type { ChildSessionUsage } from "../subagents/child-session-executor";
import {
  SHADOW_PAYLOAD_MAX_CHARS,
  validateShadowPayload,
  type ShadowDelivery,
  type ShadowOutputSchema,
  type ShadowTrigger,
} from "./parser";

export const SUBMIT_SHADOW_RESULT_TOOL = "submit_shadow_result";
export const SUBMIT_SHADOW_RESULT_DESCRIPTION = "Submit the final Shadow result. The payload must be a JSON string matching the output schema. A valid submission completes the run; an invalid one returns the exact fields to fix.";
const SubmitParams = Type.Object({
  payload: Type.String({
    maxLength: SHADOW_PAYLOAD_MAX_CHARS,
    description: "The Shadow result as a JSON string matching the output schema shown in the user message.",
  }),
}, { additionalProperties: false });

/**
 * The fixed model-callable parameters of `submit_shadow_result`. Exported so
 * the Shadow tool-envelope hash covers the complete final schema cohort.
 */
export const SUBMIT_SHADOW_RESULT_PARAMETERS = SubmitParams;

export interface SubmitShadowResultHandlers {
  schema: ShadowOutputSchema;
  /** Refuses an invocation before parsing or accepting its payload. */
  beforeExecute?: () => string | undefined;
  /** Called exactly once per run with the parsed, schema-valid payload. */
  onAccepted(payload: unknown): void;
}

/**
 * Builds the stable terminating result tool for one Shadow run. The tool
 * never throws: every rejection is a recoverable tool error the model can
 * correct within its remaining budgets, and acceptance terminates the run
 * at the tool-batch boundary through the native `terminate` hint.
 */
export function createSubmitShadowResultTool(handlers: SubmitShadowResultHandlers): ToolDefinition<typeof SubmitParams, { status: string }> {
  let accepted = false;
  return {
    name: SUBMIT_SHADOW_RESULT_TOOL,
    label: "Submit Shadow result",
    description: SUBMIT_SHADOW_RESULT_DESCRIPTION,
    executionMode: "sequential",
    parameters: SubmitParams,
    async execute(_toolCallId, params) {
      if (accepted) {
        return {
          content: [{ type: "text" as const, text: "A Shadow result was already accepted for this run." }],
          details: { status: "already_accepted" },
          isError: true,
          terminate: true,
        };
      }
      const refusal = handlers.beforeExecute?.();
      if (refusal) {
        return {
          content: [{ type: "text" as const, text: refusal }],
          details: { status: "budget_exceeded" },
          isError: true,
        };
      }
      if (params.payload.length > SHADOW_PAYLOAD_MAX_CHARS) {
        return {
          content: [{ type: "text" as const, text: `The payload exceeds ${SHADOW_PAYLOAD_MAX_CHARS.toLocaleString("en-US")} characters. Shorten it and submit again.` }],
          details: { status: "payload_too_large" },
          isError: true,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.payload);
      } catch {
        return {
          content: [{
            type: "text" as const,
            text: "The payload is not valid JSON. Fix the payload string and submit again.",
          }],
          details: { status: "invalid_json" },
          isError: true,
        };
      }

      const errors = validateShadowPayload(handlers.schema, parsed);
      if (errors.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "The payload does not match the output schema. Fix these fields and submit again:",
              ...errors.map((line) => `- ${line}`),
            ].join("\n"),
          }],
          details: { status: "schema_invalid", errors: errors.slice(0, 8) },
          isError: true,
        };
      }

      accepted = true;
      handlers.onAccepted(parsed);
      return {
        content: [{ type: "text" as const, text: "Shadow result accepted. This run is complete." }],
        details: { status: "accepted" },
        terminate: true,
      };
    },
  };
}

export const SHADOW_RESULT_SUMMARY_MAX_CHARS = 300;

export function canonicalPayloadJson(payload: unknown, spacing?: number): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(payload), null, spacing) ?? "";
}

/**
 * Deterministic one-line summary: the first top-level string among
 * `summary`, `title`, and `message`, otherwise a bounded prefix of the
 * canonical JSON encoding. Never calls a model.
 */
export function summarizeShadowResult(payload: unknown): string {
  let preferred: string | undefined;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["summary", "title", "message"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        preferred = value;
        break;
      }
    }
  }
  const source = preferred ?? (() => {
    try {
      return canonicalPayloadJson(payload);
    } catch {
      return "[unserializable payload]";
    }
  })();
  const normalized = sanitizeDisplayLine(source).replace(/\s+/g, " ").trim();
  return normalized.length <= SHADOW_RESULT_SUMMARY_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, SHADOW_RESULT_SUMMARY_MAX_CHARS - 1)}…`;
}

export type ShadowResultDelivery = "notified" | "pending" | "delivered";
export type ShadowResultAttention = "unread" | "read" | "dismissed";

/** How the activation that produced a result entered the runtime. */
export type ShadowResultSource = "manual" | "automatic";

/** Task identity of the activation that produced a result (scheduling fills it). */
export interface ShadowTaskIdentity {
  epoch: number;
  /** Parent-run sequence in which the automatic activation was observed. */
  sourceRun?: number;
  parentEntryId?: string;
}

/** Bounded provenance and contract metadata every result records (#157). */
export interface ShadowResultMetadata {
  /** Hash of the effective definition source that produced the result. */
  definitionHash?: string;
  /** Hash of the effective output schema the payload validated against. */
  schemaHash?: string;
  /** The definition's configured delivery policy at run time. */
  configuredDelivery?: ShadowDelivery;
  /** Manual trial or scheduler-dispatched activation. */
  source?: ShadowResultSource;
  /** Canonical highest-priority trigger for an automatic activation. */
  primaryTrigger?: ShadowTrigger;
  /** Trigger reasons of the activation; automatic scheduling fills these. */
  triggers?: ShadowTrigger[];
  taskIdentity?: ShadowTaskIdentity;
  /** Terminal lifecycle for a persisted cognitive result. */
  lifecycle?: "submitted";
  /** Number of child tool executions observed before submission. */
  toolCalls?: number;
  /** Whether deterministic trajectory truncation qualified this result. */
  trajectoryTruncated?: boolean;
  /** Bounded per-request usage and TTFT records. */
  requests?: Array<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    ttftMs?: number;
  }>;
}

export interface ShadowResultEntity extends ShadowResultMetadata {
  id: string;
  shadowId: string;
  shadowName: string;
  /** Legacy compatibility field; `source` and `primaryTrigger` are authoritative. */
  trigger: "manual";
  note?: string;
  payload: unknown;
  summary: string;
  delivery: ShadowResultDelivery;
  attention: ShadowResultAttention;
  createdAt: number;
  model?: string;
  usage?: ChildSessionUsage;
  /** Set once the parent transcript carries this result's bounded reference. */
  referenced?: boolean;
}

/** Default in-memory retention; the persistent inbox keeps the same bound. */
export const SHADOW_INBOX_DEFAULT_MAX_RESULTS = 100;

export interface ShadowInboxAddInput extends ShadowResultMetadata {
  /** Effective validated schema persisted only as the disk re-validation contract. */
  validationSchema?: ShadowOutputSchema;
  shadowId: string;
  shadowName: string;
  payload: unknown;
  note?: string;
  createdAt: number;
  model?: string;
  usage?: ChildSessionUsage;
}

export interface ShadowInbox {
  /** Whether the inbox survives the parent session (persistent partition). */
  readonly persistent: boolean;
  add(input: ShadowInboxAddInput): ShadowResultEntity;
  list(): ShadowResultEntity[];
  /**
   * Atomic `notified → pending` delivery transition; the confirmed-delivery
   * slice drives it through to `delivered`. Refused for any other state.
   */
  send(id: string): boolean;
  markRead(id: string): boolean;
  dismiss(id: string): boolean;
  delete(id: string): boolean;
  /**
   * Persists that the parent transcript already carries this result's
   * bounded reference entry, so a reopen does not append it again.
   */
  markReferenced?(id: string): boolean;
  /**
   * Downgrades one still-undelivered result's configured delivery to
   * `notify`; a new parent task forces old-task results inbox-only.
   */
  forceNotify?(id: string): boolean;
  /**
   * Confirms one delivery from transcript observation; `pending → delivered`.
   */
  markDelivered?(id: string): boolean;
  /**
   * A degraded delivery returns inbox-only: `pending → notified` with notify
   * policy. Refused for delivered results.
   */
  degradeToNotify?(id: string): boolean;
  /**
   * Reopen recovery: results left `pending` by a lost session return
   * inbox-only with notify policy; delivery never resumes automatically.
   */
  recoverPendingDelivery?(): number;
  /** Bounded retention events when the backing store records them. */
  events?(): Array<{ kind: "evicted"; id: string; at: number; reason: "count" | "bytes" }>;
  clear(): void;
}

/** Retention order: oldest resolved (read, dismissed, or delivered) first. */
export function evictionCandidate(entries: readonly ShadowResultEntity[]): ShadowResultEntity | undefined {
  return [...entries]
    .filter((entry) => entry.attention !== "unread" || entry.delivery === "delivered")
    .sort((a, b) => a.createdAt - b.createdAt)[0]
    ?? [...entries].sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * Session-scoped in-memory result inbox. Newest first; every state
 * transition is observable and unknown IDs are refused. `send` performs the
 * atomic `notified → pending` delivery transition. Retention evicts the
 * oldest resolved (read, dismissed, or delivered) entries before unread
 * notified ones, matching the persistent retention order.
 */
export function createShadowInbox(options?: { maxResults?: number; makeId?: () => string }): ShadowInbox {
  const maxResults = Math.min(
    SHADOW_INBOX_DEFAULT_MAX_RESULTS,
    Math.max(1, Math.trunc(options?.maxResults ?? SHADOW_INBOX_DEFAULT_MAX_RESULTS)),
  );
  const makeId = options?.makeId ?? (() => `shr-${randomUUID()}`);
  const entries: ShadowResultEntity[] = [];
  const clone = <T>(value: T): T => structuredClone(value);

  const evictIfNeeded = () => {
    while (entries.length > maxResults) {
      const candidate = evictionCandidate(entries);
      if (!candidate) return;
      entries.splice(entries.indexOf(candidate), 1);
    }
  };

  return {
    persistent: false,
    add(input) {
      const entity: ShadowResultEntity = {
        id: makeId(),
        shadowId: input.shadowId,
        shadowName: input.shadowName,
        trigger: "manual",
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        payload: clone(input.payload),
        summary: summarizeShadowResult(input.payload),
        delivery: "notified",
        attention: "unread",
        createdAt: input.createdAt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.definitionHash ? { definitionHash: input.definitionHash } : {}),
        ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
        ...(input.configuredDelivery ? { configuredDelivery: input.configuredDelivery } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.primaryTrigger ? { primaryTrigger: input.primaryTrigger } : {}),
        ...(input.triggers ? { triggers: [...input.triggers] } : {}),
        ...(input.taskIdentity ? { taskIdentity: clone(input.taskIdentity) } : {}),
      };
      entries.unshift(entity);
      evictIfNeeded();
      return entity;
    },
    list() {
      return entries.map((entry) => clone(entry));
    },
    send(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery !== "notified") return false;
      entry.delivery = "pending";
      return true;
    },
    markRead(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.attention = "read";
      return true;
    },
    dismiss(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.attention = "dismissed";
      return true;
    },
    delete(id) {
      const index = entries.findIndex((item) => item.id === id);
      if (index === -1) return false;
      entries.splice(index, 1);
      return true;
    },
    forceNotify(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery !== "notified" || entry.configuredDelivery === "notify") return false;
      entry.configuredDelivery = "notify";
      return true;
    },
    markDelivered(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery !== "pending") return false;
      entry.delivery = "delivered";
      return true;
    },
    degradeToNotify(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery === "delivered") return false;
      entry.configuredDelivery = "notify";
      if (entry.delivery === "pending") entry.delivery = "notified";
      return true;
    },
    recoverPendingDelivery() {
      let recovered = 0;
      for (const entry of entries) {
        if (entry.delivery !== "pending") continue;
        entry.delivery = "notified";
        entry.configuredDelivery = "notify";
        recovered += 1;
      }
      return recovered;
    },
    clear() {
      entries.length = 0;
    },
  };
}
