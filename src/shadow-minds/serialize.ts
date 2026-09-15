/**
 * Canonical serialization of one Shadow definition layer
 * (odradekk/pi-square#149, slice #154).
 *
 * Writes exactly the Markdown shape the strict frontmatter parser accepts:
 * one canonical field order, double-quoted scalars, one-line flow lists, and
 * nested block maps for trigger instructions and output schemas. Round-trip
 * parity with `parseShadowDefinitionFile` is contract-tested. Since #190 the
 * serializer is an internal contract surface only — the reference assets and
 * round-trip tests consume it; it is no longer a runtime write path.
 */

import { SHADOW_DEFINITION_BOUNDS } from "./definition-bounds";
import type { ShadowOutputSchema } from "./output-schema";
import {
  SHADOW_FRONTMATTER_FIELDS,
  validateShadowDefinitionFields,
  type ShadowDefinitionFields,
} from "./parser";

/**
 * The default candidate for a newly created definition (#154): disabled, no
 * automatic triggers, `steer` delivery, inherited runtime defaults, debug off,
 * and the default summary schema (left absent so it inherits).
 */
export function newShadowDefinitionDraft(id: string, name: string, body: string): ShadowDefinitionFields {
  return {
    id,
    name,
    enabled: false,
    hidden: false,
    priority: 0,
    triggers: [],
    delivery: "steer",
    completionGate: false,
    debug: false,
    body,
  };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function flowList(values: readonly unknown[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map((value) => (typeof value === "string" ? quoted(value) : String(value))).join(", ")}]`;
}

function schemaLines(schema: ShadowOutputSchema, indent: string): string[] {
  const lines: string[] = [];
  lines.push(`${indent}type: ${schema.type}`);
  if (schema.type === "object") {
    if (schema.required !== undefined) lines.push(`${indent}required: ${flowList(schema.required)}`);
    lines.push(`${indent}additionalProperties: false`);
    if (schema.properties !== undefined) {
      lines.push(`${indent}properties:`);
      for (const [key, child] of Object.entries(schema.properties)) {
        lines.push(`${indent}  ${key}:`);
        lines.push(...schemaLines(child, `${indent}    `));
      }
    }
  } else if (schema.type === "array") {
    if (schema.items !== undefined) {
      lines.push(`${indent}items:`);
      lines.push(...schemaLines(schema.items, `${indent}  `));
    }
    if (schema.minItems !== undefined) lines.push(`${indent}minItems: ${schema.minItems}`);
    if (schema.maxItems !== undefined) lines.push(`${indent}maxItems: ${schema.maxItems}`);
  } else {
    if (schema.minLength !== undefined) lines.push(`${indent}minLength: ${schema.minLength}`);
    if (schema.maxLength !== undefined) lines.push(`${indent}maxLength: ${schema.maxLength}`);
    if (schema.minimum !== undefined) lines.push(`${indent}minimum: ${schema.minimum}`);
    if (schema.maximum !== undefined) lines.push(`${indent}maximum: ${schema.maximum}`);
  }
  if (schema.enum !== undefined) lines.push(`${indent}enum: ${flowList(schema.enum)}`);
  return lines;
}

function assertValid(fields: ShadowDefinitionFields): void {
  // The pre-write guard consumes the parser's field validation result
  // instead of restating bounds: a layer the serializer emits must be one
  // the parser accepts. Name and body stay optional per layer — a project
  // overlay may inherit them from the agent base, and effective completeness
  // is enforced by the write path's full-candidate validation, so a
  // body-less project-only definition can never reach disk through the
  // manager.
  const errors = validateShadowDefinitionFields(fields);
  if (errors.length > 0) throw new Error(`Shadow definition is invalid: ${errors.join(" ")}`);
}

/** Serializes one definition layer into the canonical Markdown form. */
export function serializeShadowDefinition(fields: ShadowDefinitionFields): string {
  assertValid(fields);
  // The parser's canonical field order is the serialized order.
  const lines = [`promptVersion: ${SHADOW_DEFINITION_BOUNDS.promptVersion}`];
  for (const field of SHADOW_FRONTMATTER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const value = fields[field];
    switch (field) {
      case "id":
      case "name":
      case "model":
      case "thinking":
      case "delivery":
        lines.push(`${field}: ${quoted(value as string)}`);
        break;
      case "priority":
      case "timeoutSeconds":
      case "maxTurns":
      case "maxToolCalls":
        lines.push(`${field}: ${value as number}`);
        break;
      case "enabled":
      case "hidden":
      case "completionGate":
      case "debug":
        lines.push(`${field}: ${value as boolean}`);
        break;
      case "triggers":
      case "parentModels":
      case "tools":
      case "requiredTools":
        lines.push(`${field}: ${flowList(value as readonly string[])}`);
        break;
      case "triggerInstructions": {
        const entries = Object.entries(value as Record<string, string | null>);
        if (entries.length === 0) {
          lines.push("triggerInstructions: {}");
          break;
        }
        lines.push("triggerInstructions:");
        for (const [key, instruction] of entries) {
          lines.push(`  ${key}: ${instruction === null ? "null" : quoted(instruction)}`);
        }
        break;
      }
      case "outputSchema":
        if (value === null) {
          lines.push("outputSchema: null");
        } else {
          lines.push("outputSchema:");
          lines.push(...schemaLines(value as ShadowOutputSchema, "  "));
        }
        break;
    }
  }
  if (fields.body === undefined) return `---\n${lines.join("\n")}\n---\n`;
  return `---\n${lines.join("\n")}\n---\n\n${fields.body}\n`;
}
