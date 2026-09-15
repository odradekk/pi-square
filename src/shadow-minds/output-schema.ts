/**
 * Bounded output-schema subset for Shadow definitions
 * (odradekk/pi-square#149, slice #153; validator module split out of the
 * definition parser by #365).
 *
 * The output schema subset is a bounded JSON Schema dialect: object roots
 * only, `additionalProperties: false` on every object, no `$ref`, no
 * composition, no pattern properties, depth/property/count/string bounds.
 * The bounds live in one declarative entry, `SHADOW_OUTPUT_SCHEMA_BOUNDS`,
 * which this module's validator enforces and the definition contract
 * documents, so the reference asset cannot claim a bound validation does not
 * apply. Callers validate a candidate schema with `validateOutputSchema` and
 * read its result; they never re-apply individual bounds.
 */

/** The bounded schema type one Shadow result payload is validated against. */
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

/**
 * The bounds one output schema is validated against. The single source for
 * both enforcement (`validateOutputSchema`) and documentation (the definition
 * contract published in `shadow-minds/schema-reference.md`).
 */
export const SHADOW_OUTPUT_SCHEMA_BOUNDS = {
  /** Maximum nesting of one output schema. */
  maxDepth: 6,
  /** Total properties across one output schema. */
  maxTotalProperties: 64,
  /** Properties on one object schema. */
  maxPropertiesPerObject: 32,
  /** `maxItems` a schema may declare. */
  maxItems: 64,
  /** `maxLength` a schema may declare. */
  stringMaxLength: 12_000,
} as const;

/** The default schema every definition without an explicit one resolves to. */
export const DEFAULT_OUTPUT_SCHEMA: ShadowOutputSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    summary: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: SHADOW_OUTPUT_SCHEMA_BOUNDS.stringMaxLength,
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
/** Property names must stay inside the YAML-safe schema key subset. */
const SCHEMA_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

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
  if (context.properties > SHADOW_OUTPUT_SCHEMA_BOUNDS.maxTotalProperties) {
    errors.push(`output schema exceeds ${SHADOW_OUTPUT_SCHEMA_BOUNDS.maxTotalProperties} total properties (${context.properties})`);
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
  if (depth >= SHADOW_OUTPUT_SCHEMA_BOUNDS.maxDepth) {
    errors.push(`${path || "root"}: output schema exceeds depth ${SHADOW_OUTPUT_SCHEMA_BOUNDS.maxDepth}`);
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
  validateNonNegativeIntegerKeyword(record, "maxLength", path, errors, SHADOW_OUTPUT_SCHEMA_BOUNDS.stringMaxLength);
  validateFiniteNumberKeyword(record, "minimum", path, errors);
  validateFiniteNumberKeyword(record, "maximum", path, errors);
  validateNonNegativeIntegerKeyword(record, "minItems", path, errors);
  validateNonNegativeIntegerKeyword(record, "maxItems", path, errors, SHADOW_OUTPUT_SCHEMA_BOUNDS.maxItems);
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
    if (!Array.isArray(record.enum) || record.enum.length === 0 || record.enum.length > SHADOW_OUTPUT_SCHEMA_BOUNDS.maxItems) {
      errors.push(`${path || "root"}: enum must list between 1 and ${SHADOW_OUTPUT_SCHEMA_BOUNDS.maxItems} values`);
    } else if (type === "object" || type === "array") {
      errors.push(`${path || "root"}: enum is supported only for scalar schemas`);
    } else if (!record.enum.every((entry) => enumValueMatchesType(entry, type))) {
      errors.push(`${path || "root"}: enum values must match type '${type}'`);
    } else if (record.enum.some((entry) => typeof entry === "string" && entry.length > SHADOW_OUTPUT_SCHEMA_BOUNDS.stringMaxLength)) {
      errors.push(`${path || "root"}: enum string values exceed the maximum of ${SHADOW_OUTPUT_SCHEMA_BOUNDS.stringMaxLength}`);
    }
  }
  if (type === "object") {
    const properties = record.properties;
    if (properties !== undefined) {
      if (!isPlainObject(properties)) {
        errors.push(`${path || "root"}: properties must be an object`);
      } else {
        const keys = Object.keys(properties);
        if (keys.length > SHADOW_OUTPUT_SCHEMA_BOUNDS.maxPropertiesPerObject) {
          errors.push(`${path || "root"}: object schemas allow at most ${SHADOW_OUTPUT_SCHEMA_BOUNDS.maxPropertiesPerObject} properties (${keys.length})`);
        }
        context.properties += keys.length;
        for (const key of keys) {
          if (!SCHEMA_KEY_PATTERN.test(key) || key === "__proto__" || key === "prototype" || key === "constructor") {
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
        if (required.length > SHADOW_OUTPUT_SCHEMA_BOUNDS.maxPropertiesPerObject) {
          errors.push(`${path || "root"}: required allows at most ${SHADOW_OUTPUT_SCHEMA_BOUNDS.maxPropertiesPerObject} entries`);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
