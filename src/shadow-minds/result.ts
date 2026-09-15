/**
 * Shadow result submission (odradekk/pi-square#155).
 *
 * One stable terminating tool, `submit_shadow_result`, carries every Shadow
 * result. Its model-callable schema is fixed — a strict object with one
 * required `payload` string and no additional properties — so the schema
 * never changes per Shadow. The payload string is parsed as JSON and
 * validated against the effective bounded output schema; field-level
 * rejections are returned for an in-run retry, and only a valid submission
 * terminates the run. Results land in the session result store
 * (`result-store.ts`), which owns their full lifecycle; the recoverable
 * persistent partition arrives with #157 (`result-partition.ts`).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeDisplayLine } from "../display/sanitize";
import {
  SHADOW_PAYLOAD_MAX_CHARS,
  validateShadowPayload,
  type ShadowOutputSchema,
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
