/**
 * Canonical serialization of one Shadow definition layer
 * (odradekk/pi-square#149, slice #154).
 *
 * Writes exactly the Markdown shape the strict frontmatter parser accepts:
 * one canonical field order, double-quoted scalars, one-line flow lists, and
 * nested block maps for trigger instructions and output schemas. Round-trip
 * parity with `parseShadowDefinitionFile` is contract-tested, so every layer
 * the manager writes reparses deterministically.
 */

import {
  SHADOW_BODY_MAX_CHARS,
  SHADOW_ID_MAX_CHARS,
  SHADOW_NAME_MAX_CHARS,
  SHADOW_PRIORITY_MAX,
  SHADOW_PRIORITY_MIN,
  SHADOW_TRIGGERS,
  SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS,
  SHADOW_TOOLS_MAX,
  SHADOW_PARENT_MODELS_MAX,
  validateOutputSchema,
  type ShadowDefinitionFields,
  type ShadowOutputSchema,
  type ShadowTrigger,
} from "./parser";

const ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${SHADOW_ID_MAX_CHARS - 1}}$`);

/** Fixed canonical field order for serialized layers. */
const FIELD_ORDER = [
  "name",
  "enabled",
  "hidden",
  "priority",
  "triggers",
  "triggerInstructions",
  "delivery",
  "completionGate",
  "parentModels",
  "model",
  "thinking",
  "timeoutSeconds",
  "maxTurns",
  "maxToolCalls",
  "tools",
  "requiredTools",
  "debug",
  "outputSchema",
] as const;

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
  if (typeof fields.id !== "string" || !ID_PATTERN.test(fields.id)) {
    throw new Error(`Shadow definition id must match ${ID_PATTERN} (got '${fields.id}').`);
  }
  if (typeof fields.name !== "string" || fields.name.length < 1 || fields.name.length > SHADOW_NAME_MAX_CHARS) {
    throw new Error(`Shadow definition name must be a string between 1 and ${SHADOW_NAME_MAX_CHARS} characters.`);
  }
  if (typeof fields.body !== "string" || fields.body.trim() === "") {
    throw new Error("Shadow definition body must be a non-empty string.");
  }
  if (fields.body.length > SHADOW_BODY_MAX_CHARS) {
    throw new Error(`Shadow definition body exceeds ${SHADOW_BODY_MAX_CHARS} characters.`);
  }
  if (fields.priority !== undefined && (!Number.isInteger(fields.priority) || fields.priority < SHADOW_PRIORITY_MIN || fields.priority > SHADOW_PRIORITY_MAX)) {
    throw new Error(`Shadow definition priority must be an integer between ${SHADOW_PRIORITY_MIN} and ${SHADOW_PRIORITY_MAX}.`);
  }
  if (fields.triggers !== undefined) {
    if (fields.triggers.some((trigger) => !SHADOW_TRIGGERS.includes(trigger))) {
      throw new Error(`Shadow definition triggers must be among ${SHADOW_TRIGGERS.join(", ")}.`);
    }
  }
  if (fields.triggerInstructions !== undefined) {
    for (const key of Object.keys(fields.triggerInstructions)) {
      if (!SHADOW_TRIGGERS.includes(key as ShadowTrigger)) {
        throw new Error(`Shadow definition triggerInstructions key '${key}' is not a known trigger.`);
      }
      const value = fields.triggerInstructions[key as ShadowTrigger];
      if (value !== null && (typeof value !== "string" || value.length > SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS)) {
        throw new Error(`Shadow definition triggerInstructions '${key}' must be null or a string of at most ${SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS} characters.`);
      }
    }
  }
  for (const listField of ["tools", "requiredTools", "parentModels"] as const) {
    const value = fields[listField];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > (listField === "parentModels" ? SHADOW_PARENT_MODELS_MAX : SHADOW_TOOLS_MAX)) {
      throw new Error(`Shadow definition ${listField} allows at most ${listField === "parentModels" ? SHADOW_PARENT_MODELS_MAX : SHADOW_TOOLS_MAX} entries.`);
    }
  }
  if (fields.outputSchema !== undefined && fields.outputSchema !== null) {
    const errors = validateOutputSchema(fields.outputSchema);
    if (errors.length > 0) throw new Error(`Shadow definition outputSchema is invalid: ${errors.join(" ")}`);
  }
}

/** Serializes one definition layer into the canonical Markdown form. */
export function serializeShadowDefinition(fields: ShadowDefinitionFields): string {
  assertValid(fields);
  const lines = ["promptVersion: 1", `id: ${quoted(fields.id)}`];
  for (const field of FIELD_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const value = fields[field];
    switch (field) {
      case "name":
        lines.push(`name: ${quoted(value as string)}`);
        break;
      case "model":
        lines.push(`model: ${quoted(value as string)}`);
        break;
      case "thinking":
        lines.push(`thinking: ${quoted(value as string)}`);
        break;
      case "delivery":
        lines.push(`delivery: ${quoted(value as string)}`);
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
  return `---\n${lines.join("\n")}\n---\n\n${fields.body}\n`;
}
