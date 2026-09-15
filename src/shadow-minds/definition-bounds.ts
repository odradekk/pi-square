/**
 * Declarative bounds of one Shadow definition layer (#365).
 *
 * Every numeric bound and validation pattern the strict definition parser
 * enforces lives in this one entry instead of as loose exported constants.
 * The parser's field validation applies these bounds and reports violations
 * in its error messages; the serializer's pre-write guard reads the same
 * entry, and the definition contract documents it, so the reference asset
 * cannot claim a bound enforcement does not apply (ADR-0017). Modules that
 * need a bound consume this entry — they never restate a number.
 */

/**
 * The bounds one definition layer is validated against, keyed by the field
 * or file aspect they constrain.
 */
export const SHADOW_DEFINITION_BOUNDS = {
  /** The only accepted `promptVersion` of a Shadow definition. */
  promptVersion: 1,
  /** Whole definition file bound. */
  fileMaxBytes: 64 * 1024,
  /** The single shared ID pattern; writers and the manager reuse it. */
  id: {
    maxChars: 64,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  },
  name: { maxChars: 120 },
  priority: { min: -1_000, max: 1_000 },
  triggers: { maxEntries: 4 },
  triggerInstructions: { valueMaxChars: 8_000 },
  /** Exact `provider/model-id` reference shape (#188 contract). */
  modelReferencePattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/,
  parentModels: { maxEntries: 32 },
  /** Lower bound shared by the three per-run budget fields. */
  runBudgetMin: 1,
  /** Tool-name shape shared by `tools` and `requiredTools` (#188 contract). */
  toolNamePattern: /^[a-z][a-z0-9_]{0,63}$/,
  /** Entry cap shared by `tools` and `requiredTools`. */
  toolListsMaxEntries: 16,
  body: { maxChars: 24_000 },
} as const;
