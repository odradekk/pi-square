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

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildSessionUsage } from "../subagents/child-session-executor";
import { validateShadowPayload, type ShadowOutputSchema } from "./parser";

export const SUBMIT_SHADOW_RESULT_TOOL = "submit_shadow_result";

const SubmitParams = Type.Object({
  payload: Type.String({
    description: "The Shadow result as a JSON string matching the output schema shown in the user message.",
  }),
}, { additionalProperties: false });

export interface SubmitShadowResultHandlers {
  schema: ShadowOutputSchema;
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
  return {
    name: SUBMIT_SHADOW_RESULT_TOOL,
    label: "Submit Shadow result",
    description: "Submit the final Shadow result. The payload must be a JSON string matching the output schema. A valid submission completes the run; an invalid one returns the exact fields to fix.",
    parameters: SubmitParams,
    async execute(_toolCallId, params) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.payload);
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `The payload is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix the payload string and submit again.`,
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
      return JSON.stringify(payload) ?? "";
    } catch {
      return "[unserializable payload]";
    }
  })();
  const normalized = source.replace(/\s+/g, " ").trim();
  return normalized.length <= SHADOW_RESULT_SUMMARY_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, SHADOW_RESULT_SUMMARY_MAX_CHARS - 1)}…`;
}

export type ShadowResultDelivery = "notified" | "pending" | "delivered";
export type ShadowResultAttention = "unread" | "read" | "dismissed";

export interface ShadowResultEntity {
  id: string;
  shadowId: string;
  shadowName: string;
  trigger: "manual";
  note?: string;
  payload: unknown;
  summary: string;
  delivery: ShadowResultDelivery;
  attention: ShadowResultAttention;
  createdAt: number;
  model?: string;
  usage?: ChildSessionUsage;
}

/** Default in-memory retention; the persistent inbox (#157) keeps the same bound. */
export const SHADOW_INBOX_DEFAULT_MAX_RESULTS = 100;

export interface ShadowInboxAddInput {
  shadowId: string;
  shadowName: string;
  payload: unknown;
  note?: string;
  createdAt: number;
  model?: string;
  usage?: ChildSessionUsage;
}

export interface ShadowInbox {
  add(input: ShadowInboxAddInput): ShadowResultEntity;
  list(): ShadowResultEntity[];
  markRead(id: string): boolean;
  dismiss(id: string): boolean;
  delete(id: string): boolean;
}

/**
 * Session-scoped in-memory result inbox. Newest first; every state
 * transition is observable and unknown IDs are refused. Retention evicts
 * the oldest read or dismissed entries before unread ones, matching the
 * persistent retention order (#157).
 */
export function createShadowInbox(options?: { maxResults?: number; makeId?: () => string }): ShadowInbox {
  const maxResults = Math.max(1, options?.maxResults ?? SHADOW_INBOX_DEFAULT_MAX_RESULTS);
  const makeId = options?.makeId ?? (() => `shr-${Math.random().toString(36).slice(2, 10)}`);
  const entries: ShadowResultEntity[] = [];

  const evictIfNeeded = () => {
    while (entries.length > maxResults) {
      const candidate = [...entries]
        .filter((entry) => entry.attention !== "unread")
        .sort((a, b) => a.createdAt - b.createdAt)[0]
        ?? [...entries].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!candidate) return;
      entries.splice(entries.indexOf(candidate), 1);
    }
  };

  return {
    add(input) {
      const entity: ShadowResultEntity = {
        id: makeId(),
        shadowId: input.shadowId,
        shadowName: input.shadowName,
        trigger: "manual",
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        payload: input.payload,
        summary: summarizeShadowResult(input.payload),
        delivery: "notified",
        attention: "unread",
        createdAt: input.createdAt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
      };
      entries.unshift(entity);
      evictIfNeeded();
      return entity;
    },
    list() {
      return entries.map((entry) => ({ ...entry }));
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
  };
}
