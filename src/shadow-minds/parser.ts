/**
 * Strict bounded Markdown/frontmatter parser for Shadow definitions
 * (odradekk/pi-square#149, slice #153).
 *
 * A definition is one Markdown file: a YAML frontmatter block between two
 * `---` delimiter lines followed by the responsibility body. This module
 * parses a deliberately tiny YAML subset — plain, single- and double-quoted
 * scalars, nested maps by fixed two-space indentation, flow lists of
 * scalars — and rejects everything else (anchors, aliases, tags, merge keys,
 * complex keys, block scalars, comments, tabs, duplicate keys). No runtime
 * dependency is added and no general YAML is supported.
 *
 * The output schema subset is a bounded JSON Schema dialect: object roots
 * only, `additionalProperties: false` on every object, no `$ref`, no
 * composition, no pattern properties, depth/property/count/string bounds.
 */

import { createHash } from "node:crypto";
import {
  SHADOW_MINDS_MODEL_TURNS_HARD_MAX,
  SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS,
  SHADOW_MINDS_TOOL_CALLS_HARD_MAX,
} from "../core/config";

// ── Bounds ───────────────────────────────────────────────────────────

/** Whole definition file bound. */
export const SHADOW_FILE_MAX_BYTES = 64 * 1024;
/** Markdown responsibility body bound. */
export const SHADOW_BODY_MAX_CHARS = 24_000;
/** One trigger-specific instruction bound. */
export const SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS = 8_000;
/** The default local evidence set an omitted `tools` field resolves to. */
export const SHADOW_DEFAULT_TOOLS: readonly string[] = Object.freeze(["read", "grep", "find", "ls"]);

/** Entries allowed in `tools` and `requiredTools`. */
export const SHADOW_TOOLS_MAX = 16;
/** Fixed automatic trigger enum values. */
export const SHADOW_TRIGGERS_MAX = 4;
/** Parent-model filter entries. */
export const SHADOW_PARENT_MODELS_MAX = 32;
export const SHADOW_ID_MAX_CHARS = 64;
export const SHADOW_NAME_MAX_CHARS = 120;
export const SHADOW_PRIORITY_MIN = -1_000;
export const SHADOW_PRIORITY_MAX = 1_000;
/** Maximum nesting of one output schema. */
export const SHADOW_SCHEMA_MAX_DEPTH = 6;
/** Total properties across one output schema. */
export const SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES = 64;
/** Properties on one object schema. */
export const SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT = 32;
/** `maxItems` a schema may declare. */
export const SHADOW_SCHEMA_MAX_ITEMS = 64;
/** `maxLength` a schema may declare. */
export const SHADOW_SCHEMA_STRING_MAX_LENGTH = 12_000;
export const SHADOW_PAYLOAD_MAX_CHARS = 24_000;
/** Maximum field-level errors returned for one invalid payload. */
export const SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX = 32;

export const SHADOW_TRIGGERS = ["tool_turn", "failure", "mutation", "completion"] as const;
export type ShadowTrigger = (typeof SHADOW_TRIGGERS)[number];

export const SHADOW_DELIVERIES = ["steer", "wake", "notify"] as const;
export type ShadowDelivery = (typeof SHADOW_DELIVERIES)[number];
export const SHADOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ShadowThinkingLevel = (typeof SHADOW_THINKING_LEVELS)[number];

/** The single shared ID pattern; writers and the manager reuse it. */
export const SHADOW_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${SHADOW_ID_MAX_CHARS - 1}}$`);
const SHADOW_TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SHADOW_MODEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// ── Output schema subset ─────────────────────────────────────────────

export type ShadowOutputSchema =
  | { type: "string" | "number" | "integer" | "boolean" | "null"; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }
  | { type: "array"; items?: ShadowOutputSchema; enum?: unknown[]; minItems?: number; maxItems?: number }
  | {
      type: "object";
      properties?: Record<string, ShadowOutputSchema>;
      required?: string[];
      additionalProperties: false;
      enum?: unknown[];
    };

export const DEFAULT_OUTPUT_SCHEMA: ShadowOutputSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    summary: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: SHADOW_SCHEMA_STRING_MAX_LENGTH,
    }),
  }),
  required: Object.freeze(["summary"]) as unknown as string[],
  additionalProperties: false,
}) as ShadowOutputSchema;

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const STRING_SCHEMA_KEYS = new Set(["type", "enum", "minLength", "maxLength"]);
const NUMBER_SCHEMA_KEYS = new Set(["type", "enum", "minimum", "maximum"]);
const SCALAR_SCHEMA_KEYS = new Set(["type", "enum"]);
const ARRAY_SCHEMA_KEYS = new Set(["type", "enum", "items", "minItems", "maxItems"]);
const OBJECT_SCHEMA_KEYS = new Set(["type", "enum", "properties", "required", "additionalProperties"]);
/**
 * Validates a candidate output schema against the bounded subset. Returns one
 * message per violation; an empty array means the schema is accepted.
 */
export function validateOutputSchema(value: unknown): string[] {
  const errors: string[] = [];
  const context = { properties: 0 };
  validateSchemaNode(value, "", 0, errors, context);
  if (!isObjectSchema(value)) {
    errors.push("output schema root must be an object schema");
  }
  if (context.properties > SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES) {
    errors.push(`output schema exceeds ${SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES} total properties (${context.properties})`);
  }
  return errors;
}

function isObjectSchema(value: unknown): value is Extract<ShadowOutputSchema, { type: "object" }> {
  return isPlainObject(value) && (value as { type?: unknown }).type === "object";
}

function validateSchemaNode(value: unknown, path: string, depth: number, errors: string[], context: { properties: number }): void {
  if (!isPlainObject(value)) {
    errors.push(`${path || "root"}: schema must be an object`);
    return;
  }
  if (depth >= SHADOW_SCHEMA_MAX_DEPTH) {
    errors.push(`${path || "root"}: output schema exceeds depth ${SHADOW_SCHEMA_MAX_DEPTH}`);
    return;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !(SCALAR_TYPES.has(type) || type === "array" || type === "object")) {
    errors.push(`${path || "root"}: unsupported type ${JSON.stringify(type)}`);
    return;
  }
  const allowedKeys = type === "string"
    ? STRING_SCHEMA_KEYS
    : type === "number" || type === "integer"
      ? NUMBER_SCHEMA_KEYS
      : type === "boolean" || type === "null"
        ? SCALAR_SCHEMA_KEYS
        : type === "array"
          ? ARRAY_SCHEMA_KEYS
          : OBJECT_SCHEMA_KEYS;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) errors.push(`${path || "root"}: keyword '${key}' is not supported for type '${type}'`);
  }
  if (type === "object" && record.additionalProperties !== false) {
    errors.push(`${path || "root"}: every object schema must set additionalProperties: false`);
  }
  validateNonNegativeIntegerKeyword(record, "minLength", path, errors);
  validateNonNegativeIntegerKeyword(record, "maxLength", path, errors, SHADOW_SCHEMA_STRING_MAX_LENGTH);
  validateFiniteNumberKeyword(record, "minimum", path, errors);
  validateFiniteNumberKeyword(record, "maximum", path, errors);
  validateNonNegativeIntegerKeyword(record, "minItems", path, errors);
  validateNonNegativeIntegerKeyword(record, "maxItems", path, errors, SHADOW_SCHEMA_MAX_ITEMS);
  if (typeof record.minLength === "number" && typeof record.maxLength === "number" && record.minLength > record.maxLength) {
    errors.push(`${path || "root"}: minLength cannot exceed maxLength`);
  }
  if (typeof record.minItems === "number" && typeof record.maxItems === "number" && record.minItems > record.maxItems) {
    errors.push(`${path || "root"}: minItems cannot exceed maxItems`);
  }
  if (typeof record.minimum === "number" && typeof record.maximum === "number" && record.minimum > record.maximum) {
    errors.push(`${path || "root"}: minimum cannot exceed maximum`);
  }
  if (record.enum !== undefined) {
    if (!Array.isArray(record.enum) || record.enum.length === 0 || record.enum.length > SHADOW_SCHEMA_MAX_ITEMS) {
      errors.push(`${path || "root"}: enum must list between 1 and ${SHADOW_SCHEMA_MAX_ITEMS} values`);
    } else if (type === "object" || type === "array") {
      errors.push(`${path || "root"}: enum is supported only for scalar schemas`);
    } else if (!record.enum.every((entry) => enumValueMatchesType(entry, type))) {
      errors.push(`${path || "root"}: enum values must match type '${type}'`);
    } else if (record.enum.some((entry) => typeof entry === "string" && entry.length > SHADOW_SCHEMA_STRING_MAX_LENGTH)) {
      errors.push(`${path || "root"}: enum string values exceed the maximum of ${SHADOW_SCHEMA_STRING_MAX_LENGTH}`);
    }
  }
  if (type === "object") {
    const properties = record.properties;
    if (properties !== undefined) {
      if (!isPlainObject(properties)) {
        errors.push(`${path || "root"}: properties must be an object`);
      } else {
        const keys = Object.keys(properties);
        if (keys.length > SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT) {
          errors.push(`${path || "root"}: object schemas allow at most ${SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT} properties (${keys.length})`);
        }
        context.properties += keys.length;
        for (const key of keys) {
          if (!KEY_PATTERN.test(key) || key === "__proto__" || key === "prototype" || key === "constructor") {
            errors.push(`${path || "root"}: property name '${key}' is outside the supported YAML-safe schema key subset`);
            continue;
          }
          validateSchemaNode(properties[key], path ? `${path}/${key}` : key, depth + 1, errors, context);
        }
      }
    }
    const required = record.required;
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
        errors.push(`${path || "root"}: required must be a list of property names`);
      } else {
        if (required.length > SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT) {
          errors.push(`${path || "root"}: required allows at most ${SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT} entries`);
        }
        if (new Set(required).size !== required.length) {
          errors.push(`${path || "root"}: required property names must be unique`);
        }
        if (isPlainObject(properties)) {
          for (const name of required) {
            if (!Object.hasOwn(properties, name)) {
              errors.push(`${path || "root"}: required property '${name}' is not declared in properties`);
            }
          }
        }
      }
    }
  }
  if (type === "array" && record.items !== undefined) {
    if (Array.isArray(record.items)) {
      errors.push(`${path || "root"}: tuple items are not supported; use one items schema`);
    } else {
      validateSchemaNode(record.items, path ? `${path}/*` : "*", depth + 1, errors, context);
    }
  }
}
function enumValueMatchesType(value: unknown, type: string): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return type === "null" && value === null;
}

function validateNonNegativeIntegerKeyword(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  max?: number,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${path || "root"}: ${key} must be a non-negative integer`);
  } else if (max !== undefined && value > max) {
    errors.push(`${path || "root"}: ${key} exceeds the maximum of ${max}`);
  }
}

function validateFiniteNumberKeyword(
  record: Record<string, unknown>,
  key: "minimum" | "maximum",
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    errors.push(`${path || "root"}: ${key} must be a finite number`);
  }
}

/**
 * Validates a decoded result payload against a validated output schema.
 * Returns one bounded, field-level message per violation.
 */
export function validateShadowPayload(schema: ShadowOutputSchema, payload: unknown): string[] {
  const encoded = JSON.stringify(payload);
  if (typeof encoded !== "string" || encoded.length > SHADOW_PAYLOAD_MAX_CHARS) {
    return [`payload exceeds the encoded bound of ${SHADOW_PAYLOAD_MAX_CHARS.toLocaleString("en-US")} characters`];
  }
  const errors: string[] = [];
  validatePayloadNode(schema, payload, "", errors);
  return errors.slice(0, SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX);
}

function validatePayloadNode(schema: ShadowOutputSchema, payload: unknown, path: string, errors: string[]): void {
  const label = path || "payload";
  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(payload, entry))) {
    errors.push(`${label}: value must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  switch (schema.type) {
    case "string":
      if (typeof payload !== "string") {
        errors.push(`${label}: expected string`);
        return;
      }
      if (schema.minLength !== undefined && payload.length < schema.minLength) {
        errors.push(`${label}: shorter than minLength ${schema.minLength}`);
      }
      const maxLength = schema.maxLength ?? SHADOW_SCHEMA_STRING_MAX_LENGTH;
      if (payload.length > maxLength) {
        errors.push(`${label}: longer than maxLength ${maxLength}`);
      }
      return;
    case "integer":
      if (typeof payload !== "number" || !Number.isInteger(payload)) {
        errors.push(`${label}: expected integer`);
        return;
      }
      break;
    case "number":
      if (typeof payload !== "number" || !Number.isFinite(payload)) {
        errors.push(`${label}: expected number`);
        return;
      }
      break;
    case "boolean":
      if (typeof payload !== "boolean") {
        errors.push(`${label}: expected boolean`);
        return;
      }
      return;
    case "null":
      if (payload !== null) {
        errors.push(`${label}: expected null`);
      }
      return;
    case "array": {
      if (!Array.isArray(payload)) {
        errors.push(`${label}: expected array`);
        return;
      }
      if (errors.length >= SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX) return;
      if (schema.minItems !== undefined && payload.length < schema.minItems) {
        errors.push(`${label}: fewer than minItems ${schema.minItems}`);
      }
      const maxItems = schema.maxItems ?? SHADOW_SCHEMA_MAX_ITEMS;
      if (payload.length > maxItems) {
        errors.push(`${label}: more than maxItems ${maxItems}`);
      }
      if (schema.items) {
        for (let index = 0; index < payload.length && errors.length < SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX; index += 1) {
          validatePayloadNode(schema.items, payload[index], `${path}[${index}]`, errors);
        }
      }
      return;
    }
    case "object": {
      if (!isPlainObject(payload)) {
        errors.push(`${label}: expected object`);
        return;
      }
      for (const key of Object.keys(payload)) {
        if (errors.length >= SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX) return;
        if (!schema.properties || !Object.hasOwn(schema.properties, key)) {
          errors.push(`${path ? `${path}/` : ""}${key}: additional property is not allowed`);
        }
      }
      for (const name of schema.required ?? []) {
        if (errors.length >= SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX) return;
        if (!Object.hasOwn(payload, name)) {
          errors.push(`${path ? `${path}/` : ""}${name}: required property is missing`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (errors.length >= SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX) return;
        if (Object.hasOwn(payload, key)) {
          validatePayloadNode(child, payload[key], path ? `${path}/${key}` : key, errors);
        }
      }
      return;
    }
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (schema.minimum !== undefined && payload < schema.minimum) {
      errors.push(`${label}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && payload > schema.maximum) {
      errors.push(`${label}: above maximum ${schema.maximum}`);
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return Object.keys(a).length === Object.keys(b).length
      && Object.entries(a).every(([key, value]) => deepEqual(value, (b as Record<string, unknown>)[key]));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Definition fields ────────────────────────────────────────────────

/** Frontmatter fields of one definition layer; absent means inherit. */
export interface ShadowDefinitionFields {
  id: string;
  name?: string;
  enabled?: boolean;
  hidden?: boolean;
  priority?: number;
  triggers?: ShadowTrigger[];
  /** Per-trigger instructions; `null` clears that trigger key. */
  triggerInstructions?: Partial<Record<ShadowTrigger, string | null>>;
  delivery?: ShadowDelivery;
  completionGate?: boolean;
  /** Exact `provider/model-id` references or `*`; absent means all models. */
  parentModels?: string[];
  model?: string;
  thinking?: ShadowThinkingLevel;
  timeoutSeconds?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  tools?: string[];
  requiredTools?: string[];
  debug?: boolean;
  /** Absent inherits; `null` restores the default schema. */
  outputSchema?: ShadowOutputSchema | null;
  /** Raw Markdown body; an empty body inherits the lower layer. */
  body?: string;
}

export interface ParsedShadowDefinition {
  fields: ShadowDefinitionFields;
  contentHash: string;
}

export function parseShadowDefinitionFile(
  source: string,
  content: string,
): { definition?: ParsedShadowDefinition; errors: string[] } {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > SHADOW_FILE_MAX_BYTES) {
    return { errors: [`${source}: file exceeds the ${SHADOW_FILE_MAX_BYTES / 1024} KiB bound (${byteLength} bytes)`] };
  }
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { errors: [`${source}: definition must open with a '---' frontmatter delimiter`] };
  }
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closing = index;
      break;
    }
  }
  if (closing === -1) {
    return { errors: [`${source}: frontmatter is missing its closing '---' delimiter`] };
  }
  const parsed = parseYamlSubset(source, lines.slice(1, closing));
  if (parsed.errors.length > 0) return { errors: parsed.errors };
  // The body is canonicalized to its edge-trimmed Markdown form: leading and
  // trailing blank lines are insignificant in a responsibility prompt, and one
  // canonical shape keeps serializer round-trips exact.
  const rawBody = lines.slice(closing + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const normalized = normalizeDefinitionFields(source, parsed.value, rawBody);
  if (normalized.errors.length > 0) return { errors: normalized.errors };
  return {
    definition: {
      fields: normalized.fields!,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    },
    errors: [],
  };
}

// ── Bounded YAML subset ──────────────────────────────────────────────

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine {
  indent: number;
  text: string;
  number: number;
}

function parseYamlSubset(source: string, lines: string[]): { value?: { [key: string]: YamlValue }; errors: string[] } {
  const errors: string[] = [];
  const prepared: YamlLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.includes("\t")) {
      errors.push(`${source}: line ${index + 2}: tabs are not supported`);
      continue;
    }
    const indentMatch = /^ */.exec(raw)![0].length;
    const text = raw.slice(indentMatch);
    if (text === "") continue;
    if (text.startsWith("#")) {
      errors.push(`${source}: line ${index + 2}: comments are not supported`);
      continue;
    }
    prepared.push({ indent: indentMatch, text, number: index + 2 });
  }
  if (errors.length > 0) return { errors };
  if (prepared.length === 0) return { value: {}, errors: [] };
  if (prepared[0]!.indent !== 0) {
    return { errors: [`${source}: line ${prepared[0]!.number}: frontmatter must start at column zero`] };
  }
  const value = parseBlock(source, prepared, 0, prepared[0]!.indent, 0, errors);
  if (errors.length > 0 || value === undefined) return { errors: errors.length > 0 ? errors : [`${source}: frontmatter is empty`] };
  return { value: value as { [key: string]: YamlValue }, errors: [] };
}

const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/**
 * Parses consecutive map entries at `indent` starting from `start`. Returns
 * the parsed map and the index of the first unconsumed line, or undefined on
 * structural error (errors are pushed by the callee).
 */
function parseBlock(
  source: string,
  lines: YamlLine[],
  start: number,
  indent: number,
  depth: number,
  errors: string[],
): { [key: string]: YamlValue } | undefined {
  // Bound map nesting generously above what a maximum-depth output schema
  // needs (schema depth six consumes roughly twice that in YAML map levels).
  if (depth > 16) {
    errors.push(`${source}: line ${lines[start]!.number}: nesting exceeds the supported depth`);
    return undefined;
  }
  const map: { [key: string]: YamlValue } = Object.create(null) as { [key: string]: YamlValue };
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      errors.push(`${source}: line ${line.number}: unexpected indentation`);
      return undefined;
    }
    if (line.text.startsWith("<<:")) {
      errors.push(`${source}: line ${line.number}: merge keys are not supported`);
      return undefined;
    }
    const match = /^([^:\s]+):(.*)$/.exec(line.text);
    if (!match || !KEY_PATTERN.test(match[1]!)) {
      errors.push(`${source}: line ${line.number}: unsupported or complex key '${line.text.slice(0, 40)}'`);
      return undefined;
    }
    const key = match[1]!;
    if (Object.hasOwn(map, key)) {
      errors.push(`${source}: line ${line.number}: duplicate key '${key}'`);
      return undefined;
    }
    const rest = match[2]!.trim();
    if (rest === "{}") {
      map[key] = Object.create(null) as { [key: string]: YamlValue };
      index += 1;
      continue;
    }
    if (rest === "") {
      const child = lines[index + 1];
      if (child && child.indent === indent + 2 && child.text.startsWith("- ")) {
        const list = parseListBlock(source, lines, index + 1, child.indent, errors);
        if (list === undefined) return undefined;
        map[key] = list.value;
        index = list.next;
        continue;
      }
      if (child && child.indent > indent) {
        if (child.indent !== indent + 2) {
          errors.push(`${source}: line ${child.number}: nested blocks must indent exactly two spaces`);
          return undefined;
        }
        const childMap = parseBlock(source, lines, index + 1, child.indent, depth + 1, errors);
        if (childMap === undefined) return undefined;
        map[key] = childMap;
        index = blockEnd(lines, index + 1, child.indent);
        continue;
      }
      map[key] = null;
      index += 1;
      continue;
    }
    if (rest.startsWith("|") || rest.startsWith(">")) {
      errors.push(`${source}: line ${line.number}: block scalars are not supported`);
      return undefined;
    }
    if (rest.startsWith("&")) {
      errors.push(`${source}: line ${line.number}: anchors are not supported`);
      return undefined;
    }
    if (rest.startsWith("*")) {
      errors.push(`${source}: line ${line.number}: aliases are not supported`);
      return undefined;
    }
    if (rest.startsWith("!")) {
      errors.push(`${source}: line ${line.number}: tags are not supported`);
      return undefined;
    }
    if (rest.startsWith("[")) {
      const list = parseFlowList(rest);
      if (typeof list === "string") {
        errors.push(`${source}: line ${line.number}: ${list}`);
        return undefined;
      }
      map[key] = list;
      index += 1;
      continue;
    }
    const scalar = parseScalar(rest);
    const scalarFailure = asScalarError(scalar);
    if (scalarFailure !== undefined) {
      errors.push(`${source}: line ${line.number}: ${scalarFailure}`);
      return undefined;
    }
    map[key] = scalar;
    index += 1;
  }
  return map;
}

function parseListBlock(
  source: string,
  lines: YamlLine[],
  start: number,
  indent: number,
  errors: string[],
): { value: YamlValue[]; next: number } | undefined {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith("- ")) {
      errors.push(`${source}: line ${line.number}: list items must be scalars on '- ' lines`);
      return undefined;
    }
    const scalar = parseScalar(line.text.slice(2).trim());
    const scalarFailure = asScalarError(scalar);
    if (scalarFailure !== undefined) {
      errors.push(`${source}: line ${line.number}: ${scalarFailure}`);
      return undefined;
    }
    items.push(scalar);
    index += 1;
  }
  return { value: items, next: index };
}

function blockEnd(lines: YamlLine[], start: number, indent: number): number {
  let index = start;
  while (index < lines.length && lines[index]!.indent >= indent) index += 1;
  return index;
}

function parseFlowList(text: string): YamlValue[] | string {
  if (!text.endsWith("]")) return "flow lists must close on one line";
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = splitFlowItems(inner);
  if (typeof parts === "string") return parts;
  if (parts.some((part) => part.trim() === "")) return "flow lists cannot contain empty items";
  const items: YamlValue[] = [];
  for (const part of parts) {
    const scalar = parseScalar(part.trim());
    const scalarFailure = asScalarError(scalar);
    if (scalarFailure !== undefined) return scalarFailure;
    items.push(scalar);
  }
  return items;
}

function splitFlowItems(text: string): string[] | string {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) return "flow lists contain an unterminated quoted scalar";
  parts.push(current);
  return parts.map((part) => part.trim());
}

const YAML_ERROR_PREFIX = "__yaml_error__:";

/** Wraps an error a scalar parser wants to return instead of throwing. */
function scalarError(message: string): string {
  return `${YAML_ERROR_PREFIX}${message}`;
}

/** Reads the error a scalar parser wrapped into its result. */
function asScalarError(value: YamlValue): string | undefined {
  return typeof value === "string" && value.startsWith(YAML_ERROR_PREFIX)
    ? value.slice(YAML_ERROR_PREFIX.length)
    : undefined;
}

function parseScalar(text: string): YamlValue {
  if (text === "") return null;
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) return scalarError("unterminated double-quoted scalar");
    const inner = text.slice(1, -1);
    if (inner.includes("\\")) {
      const unescaped = inner.replace(/\\(.)/g, (full, escape: string) => {
        if (escape === "n") return "\n";
        if (escape === "t") return "\t";
        if (escape === "r") return "\r";
        if (escape === '"' || escape === "\\") return escape;
        return full;
      });
      if (/\\(?!["\\ntr])/.test(inner.replace(/\\(["\\ntr])/g, ""))) {
        return scalarError("unsupported escape in double-quoted scalar");
      }
      return unescaped;
    }
    return inner;
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) return scalarError("unterminated single-quoted scalar");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("{") || text.startsWith("[") || text.startsWith("&") || text.startsWith("*") || text.startsWith("!")) {
    return scalarError("only scalar values and one-line flow lists are supported");
  }
  if (text.includes("#")) return scalarError("comments are not supported");
  if (text.includes(": ")) return scalarError("plain scalars cannot contain ': '");
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

// ── Field normalization ──────────────────────────────────────────────

const KNOWN_FIELDS = new Set([
  "promptVersion",
  "id",
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
]);

function plainSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => plainSchema(entry));
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = plainSchema(entry);
    }
    return copy;
  }
  return value;
}

function normalizeDefinitionFields(
  source: string,
  frontmatter: { [key: string]: YamlValue } | undefined,
  body: string,
): { fields?: ShadowDefinitionFields; errors: string[] } {
  const errors: string[] = [];
  const fail = (message: string): { errors: string[] } => ({ errors: [`${source}: ${message}`] });
  if (!frontmatter) return fail("frontmatter is missing");
  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FIELDS.has(key)) return fail(`unknown field '${key}'`);
  }
  if (frontmatter.promptVersion !== 1) {
    return fail(`promptVersion must be 1 (got ${JSON.stringify(frontmatter.promptVersion) ?? "null"})`);
  }
  const id = expectString(source, frontmatter, "id", errors, 1, SHADOW_ID_MAX_CHARS);
  const name = frontmatter.name === undefined
    ? undefined
    : expectString(source, frontmatter, "name", errors, 1, SHADOW_NAME_MAX_CHARS);
  const fileStem = source.replace(/\.md$/i, "").split(/[\\/]/).pop()!;
  if (id !== undefined && !SHADOW_ID_PATTERN.test(id)) {
    errors.push(`${source}: id must match [A-Za-z0-9][A-Za-z0-9._-]{0,${SHADOW_ID_MAX_CHARS - 1}}`);
  } else if (id !== undefined && id !== fileStem) {
    errors.push(`${source}: id '${id}' must equal the Markdown filename stem '${fileStem}'`);
  }
  const fields: ShadowDefinitionFields = { id: id ?? fileStem, ...(name !== undefined ? { name } : {}) };

  assignBoolean(source, frontmatter, "enabled", fields, errors);
  assignBoolean(source, frontmatter, "hidden", fields, errors);
  assignBoolean(source, frontmatter, "completionGate", fields, errors);
  assignBoolean(source, frontmatter, "debug", fields, errors);

  const priority = frontmatter.priority;
  if (priority !== undefined) {
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < SHADOW_PRIORITY_MIN || priority > SHADOW_PRIORITY_MAX) {
      errors.push(`${source}: priority must be an integer between ${SHADOW_PRIORITY_MIN} and ${SHADOW_PRIORITY_MAX}`);
    } else {
      fields.priority = priority;
    }
  }

  const triggers = frontmatter.triggers;
  if (triggers !== undefined) {
    const list = expectStringList(source, "triggers", triggers, errors, SHADOW_TRIGGERS_MAX);
    if (list) {
      const known = list.filter((entry): entry is ShadowTrigger => (SHADOW_TRIGGERS as readonly string[]).includes(entry));
      if (known.length !== list.length) {
        const unknown = list.filter((entry) => !(SHADOW_TRIGGERS as readonly string[]).includes(entry));
        errors.push(`${source}: triggers entries must be one of ${SHADOW_TRIGGERS.join(", ")} (unknown '${unknown.join("', '")}')`);
      }
      if (new Set(list).size !== list.length) {
        errors.push(`${source}: duplicate trigger in triggers`);
      }
      if (list.length > SHADOW_TRIGGERS_MAX) {
        errors.push(`${source}: triggers allows at most ${SHADOW_TRIGGERS_MAX} entries`);
      }
      if (errors.length === 0) fields.triggers = list as ShadowTrigger[];
    }
  }

  const instructions = frontmatter.triggerInstructions;
  if (instructions !== undefined) {
    if (!isPlainObject(instructions)) {
      errors.push(`${source}: triggerInstructions must be a map of trigger key to instruction`);
    } else {
      const merged: Partial<Record<ShadowTrigger, string | null>> = {};
      for (const [key, value] of Object.entries(instructions)) {
        if (!(SHADOW_TRIGGERS as readonly string[]).includes(key)) {
          errors.push(`${source}: unknown triggerInstructions key '${key}'`);
          continue;
        }
        if (value === null) {
          merged[key as ShadowTrigger] = null;
          continue;
        }
        if (typeof value !== "string" || value.length === 0) {
          errors.push(`${source}: triggerInstructions.${key} must be a non-empty string or null`);
          continue;
        }
        if (value.length > SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS) {
          errors.push(`${source}: triggerInstructions.${key} exceeds ${SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS.toLocaleString("en-US")} characters (${value.length.toLocaleString("en-US")})`);
          continue;
        }
        merged[key as ShadowTrigger] = value;
      }
      if (errors.length === 0) fields.triggerInstructions = merged;
    }
  }

  const delivery = frontmatter.delivery;
  if (delivery !== undefined) {
    if (typeof delivery !== "string" || !SHADOW_DELIVERIES.includes(delivery as ShadowDelivery)) {
      errors.push(`${source}: delivery must be steer, wake, or notify`);
    } else {
      fields.delivery = delivery as ShadowDelivery;
    }
  }

  const parentModels = frontmatter.parentModels;
  if (parentModels !== undefined) {
    const list = expectStringList(source, "parentModels", parentModels, errors, SHADOW_PARENT_MODELS_MAX);
    if (list) {
      if (new Set(list).size !== list.length) {
        errors.push(`${source}: duplicate parentModels entry`);
      }
      if (!list.every((entry) => entry === "*" || (entry.length <= 200 && SHADOW_MODEL_REFERENCE.test(entry)))) {
        errors.push(`${source}: parentModels entries must be exact 'provider/model-id' references or '*'`);
      }
      if (errors.length === 0) fields.parentModels = list;
    }
  }

  const model = frontmatter.model;
  if (model !== undefined) {
    if (typeof model !== "string" || !SHADOW_MODEL_REFERENCE.test(model)) {
      errors.push(`${source}: model must be an exact 'provider/model-id' reference`);
    } else {
      fields.model = model;
    }
  }

  const thinking = frontmatter.thinking;
  if (thinking !== undefined) {
    const levels = SHADOW_THINKING_LEVELS;
    if (typeof thinking !== "string" || !levels.includes(thinking as ShadowThinkingLevel)) {
      errors.push(`${source}: thinking must be one of ${levels.join(", ")}`);
    } else {
      fields.thinking = thinking as ShadowThinkingLevel;
    }
  }

  const timeoutSeconds = frontmatter.timeoutSeconds;
  if (timeoutSeconds !== undefined) {
    if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS) {
      errors.push(`${source}: timeoutSeconds must be an integer between 1 and ${SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS}`);
    } else {
      fields.timeoutSeconds = timeoutSeconds;
    }
  }
  const maxTurns = frontmatter.maxTurns;
  if (maxTurns !== undefined) {
    if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > SHADOW_MINDS_MODEL_TURNS_HARD_MAX) {
      errors.push(`${source}: maxTurns must be an integer between 1 and ${SHADOW_MINDS_MODEL_TURNS_HARD_MAX}`);
    } else {
      fields.maxTurns = maxTurns;
    }
  }
  const maxToolCalls = frontmatter.maxToolCalls;
  if (maxToolCalls !== undefined) {
    if (typeof maxToolCalls !== "number" || !Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > SHADOW_MINDS_TOOL_CALLS_HARD_MAX) {
      errors.push(`${source}: maxToolCalls must be an integer between 1 and ${SHADOW_MINDS_TOOL_CALLS_HARD_MAX}`);
    } else {
      fields.maxToolCalls = maxToolCalls;
    }
  }

  const tools = frontmatter.tools;
  if (tools !== undefined) {
    const list = expectStringList(source, "tools", tools, errors, SHADOW_TOOLS_MAX);
    if (list) {
      if (new Set(list).size !== list.length) errors.push(`${source}: duplicate tools entry`);
      if (!list.every((entry) => SHADOW_TOOL_PATTERN.test(entry))) {
        errors.push(`${source}: tools entries must be lowercase snake-case tool names`);
      }
      if (errors.length === 0) fields.tools = list;
    }
  }
  const requiredTools = frontmatter.requiredTools;
  if (requiredTools !== undefined) {
    const list = expectStringList(source, "requiredTools", requiredTools, errors, SHADOW_TOOLS_MAX);
    if (list) {
      if (new Set(list).size !== list.length) errors.push(`${source}: duplicate requiredTools entry`);
      if (!list.every((entry) => SHADOW_TOOL_PATTERN.test(entry))) {
        errors.push(`${source}: requiredTools entries must be lowercase snake-case tool names`);
      }
      if (errors.length === 0) fields.requiredTools = list;
    }
  }

  const outputSchema = frontmatter.outputSchema;
  if (outputSchema !== undefined) {
    if (outputSchema === null) {
      fields.outputSchema = null;
    } else {
      const schemaErrors = validateOutputSchema(outputSchema);
      if (schemaErrors.length > 0) {
        errors.push(...schemaErrors.map((entry) => `${source}: ${entry}`));
      } else {
        // Deep-copy the validated schema into plain-prototype objects so a
        // parsed schema is an ordinary value: deep-equality against authored
        // schemas works and null-prototype maps never escape the parser.
        fields.outputSchema = plainSchema(outputSchema) as ShadowOutputSchema;
      }
    }
  }

  // A body-less layer inherits its responsibility body from the lower
  // layer: canonicalize an empty or whitespace-only raw body to absent
  // (#177) so the parsed overlay round-trips through the serializer as
  // body-less instead of carrying an explicit blank string that the layer
  // write path rejects on the next edit. An effective definition with no
  // non-empty body anywhere still fails closed in discovery's complete-
  // candidate validation.
  if (body.trim() !== "") {
    if (body.length > SHADOW_BODY_MAX_CHARS) {
      errors.push(`${source}: body exceeds ${SHADOW_BODY_MAX_CHARS.toLocaleString("en-US")} characters (${body.length.toLocaleString("en-US")})`);
    }
    fields.body = body;
  }

  if (errors.length > 0) return { errors };
  return { fields, errors: [] };
}

function expectString(
  source: string,
  frontmatter: { [key: string]: YamlValue },
  key: string,
  errors: string[],
  min: number,
  max: number,
): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string" || value.length < min || value.length > max) {
    errors.push(`${source}: ${key} must be a string between ${min} and ${max} characters`);
    return undefined;
  }
  return value;
}

function expectStringList(
  source: string,
  key: string,
  value: YamlValue,
  errors: string[],
  max: number,
): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    errors.push(`${source}: ${key} must be a list of strings`);
    return undefined;
  }
  const list = value as string[];
  if (list.length > max) {
    errors.push(`${source}: ${key} allows at most ${max} entries (${list.length})`);
    return undefined;
  }
  return list;
}

function assignBoolean(
  source: string,
  frontmatter: { [key: string]: YamlValue },
  key: "enabled" | "hidden" | "completionGate" | "debug",
  fields: ShadowDefinitionFields,
  errors: string[],
): void {
  const value = frontmatter[key];
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    errors.push(`${source}: ${key} must be a boolean`);
    return;
  }
  fields[key] = value;
}
