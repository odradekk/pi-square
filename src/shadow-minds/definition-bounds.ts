/**
 * Declarative validation limits of one Shadow definition layer (#365).
 *
 * Every bound and pattern the strict definition parser's field validation
 * applies lives in this one entry instead of as loose exported constants:
 * the parser reads it and reports violations in its error messages, the
 * serializer's pre-write guard consumes the parser's validation result, and
 * the definition contract documents the entry, so the reference asset cannot
 * claim a bound enforcement does not apply (ADR-0017).
 *
 * Coverage has one deliberate boundary: the ceilings of the three per-run
 * budget fields (`timeoutSeconds`, `maxTurns`, `maxToolCalls`) are runtime
 * hard caps owned by `../core/config` and consumed outside definition
 * parsing, so this entry holds only their shared lower bound rather than
 * restating them.
 */

/**
 * The definition ID length bound. The accepted ID pattern below is
 * constructed from this value so the published length and pattern cannot
 * drift apart.
 */
const ID_MAX_CHARS = 64;

/** Key shape accepted by YAML frontmatter keys and output-schema property names alike. */
const YAML_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Tool-name shape shared by `tools` and `requiredTools` (#188 contract). */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Whole-reference length cap for exact `provider/model-id` references — the
 * binding length constraint (`parentModels` also accepts `*`). A first
 * segment at its own bound plus the longest shape-legal second segment would
 * exceed it, so this cap is what actually limits length.
 */
const MODEL_REFERENCE_MAX_CHARS = 200;
/** First-segment (`provider`) length bound. */
const MODEL_PROVIDER_MAX_CHARS = 64;
/**
 * Reference shape (#188 contract). The second segment's bound derives from
 * the whole-reference cap minus the shortest possible first segment, the
 * separator, and the segment's first character, so the pattern and the cap
 * stay consistent instead of hand-copying a bound the cap already makes
 * unreachable.
 */
const MODEL_REFERENCE_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${MODEL_PROVIDER_MAX_CHARS - 1}}/[A-Za-z0-9][A-Za-z0-9._/-]{0,${MODEL_REFERENCE_MAX_CHARS - 3}}$`,
);

/**
 * The limits one definition layer is validated against, keyed by the field
 * or file aspect they constrain.
 */
export const SHADOW_DEFINITION_BOUNDS = {
  /** The only accepted `promptVersion` of a Shadow definition. */
  promptVersion: 1,
  file: { maxBytes: 64 * 1024 },
  /** The definition ID bound; the parser's field validation applies it and the contract publishes its source. */
  id: {
    maxChars: ID_MAX_CHARS,
    pattern: new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${ID_MAX_CHARS - 1}}$`),
  },
  name: { maxChars: 120 },
  priority: { min: -1_000, max: 1_000 },
  triggers: { maxEntries: 4 },
  triggerInstructions: { valueMaxChars: 8_000 },
  /** Exact `provider/model-id` reference shape (#188 contract); `parentModels` also accepts `*`. */
  modelReference: {
    maxChars: MODEL_REFERENCE_MAX_CHARS,
    pattern: MODEL_REFERENCE_PATTERN,
  },
  parentModels: { maxEntries: 32 },
  /** Shared floor of the three per-run budget fields; their ceilings live in `../core/config`. */
  runBudgets: { min: 1 },
  tools: { maxEntries: 16, entryPattern: TOOL_NAME_PATTERN },
  requiredTools: { maxEntries: 16, entryPattern: TOOL_NAME_PATTERN },
  body: { maxChars: 24_000 },
  /** Key subset shared by the YAML-subset parser and the output-schema validator. */
  yamlKeys: { pattern: YAML_KEY_PATTERN },
} as const;
