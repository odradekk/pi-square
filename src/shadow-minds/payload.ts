/**
 * Bounded payload validation for Shadow results
 * (odradekk/pi-square#149, slice #155; validator module split out of the
 * definition parser by #365).
 *
 * A decoded `submit_shadow_result` payload is validated against the effective
 * bounded output schema (`./output-schema`). The bounds live in one
 * declarative entry, `SHADOW_PAYLOAD_BOUNDS`, which this module's validator
 * enforces and the definition contract documents. Callers validate with
 * `validateShadowPayload` and read its result; they never re-apply the
 * bounds field by field.
 */

import { SHADOW_OUTPUT_SCHEMA_BOUNDS, type ShadowOutputSchema } from "./output-schema";

/**
 * The bounds one encoded payload is validated against. The single source for
 * both enforcement (`validateShadowPayload`) and documentation (the definition
 * contract published in `shadow-minds/schema-reference.md`).
 */
export const SHADOW_PAYLOAD_BOUNDS = {
  /** Encoded payload bound. */
  maxEncodedChars: 24_000,
  /** Maximum field-level errors returned for one invalid payload. */
  maxFieldErrors: 32,
} as const;

/**
 * Validates a decoded result payload against a validated output schema.
 * Returns one bounded, field-level message per violation.
 */
export function validateShadowPayload(schema: ShadowOutputSchema, payload: unknown): string[] {
  const encoded = JSON.stringify(payload);
  if (typeof encoded !== "string" || encoded.length > SHADOW_PAYLOAD_BOUNDS.maxEncodedChars) {
    return [`payload exceeds the encoded bound of ${SHADOW_PAYLOAD_BOUNDS.maxEncodedChars.toLocaleString("en-US")} characters`];
  }
  const errors: string[] = [];
  validatePayloadNode(schema, payload, "", errors);
  return errors.slice(0, SHADOW_PAYLOAD_BOUNDS.maxFieldErrors);
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
      const maxLength = schema.maxLength ?? SHADOW_OUTPUT_SCHEMA_BOUNDS.stringMaxLength;
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
      if (errors.length >= SHADOW_PAYLOAD_BOUNDS.maxFieldErrors) return;
      if (schema.minItems !== undefined && payload.length < schema.minItems) {
        errors.push(`${label}: fewer than minItems ${schema.minItems}`);
      }
      const maxItems = schema.maxItems ?? SHADOW_OUTPUT_SCHEMA_BOUNDS.maxItems;
      if (payload.length > maxItems) {
        errors.push(`${label}: more than maxItems ${maxItems}`);
      }
      if (schema.items) {
        for (let index = 0; index < payload.length && errors.length < SHADOW_PAYLOAD_BOUNDS.maxFieldErrors; index += 1) {
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
        if (errors.length >= SHADOW_PAYLOAD_BOUNDS.maxFieldErrors) return;
        if (!schema.properties || !Object.hasOwn(schema.properties, key)) {
          errors.push(`${path ? `${path}/` : ""}${key}: additional property is not allowed`);
        }
      }
      for (const name of schema.required ?? []) {
        if (errors.length >= SHADOW_PAYLOAD_BOUNDS.maxFieldErrors) return;
        if (!Object.hasOwn(payload, name)) {
          errors.push(`${path ? `${path}/` : ""}${name}: required property is missing`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (errors.length >= SHADOW_PAYLOAD_BOUNDS.maxFieldErrors) return;
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
