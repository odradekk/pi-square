/**
 * The machine-checked Shadow definition contract (odradekk/pi-square#342).
 *
 * `shadow-minds/schema-reference.md` ships one `json shadow-contract` block
 * stating the definition schema's bounds, enums, patterns, and defaults. This
 * module generates that object from production code so the document cannot
 * claim a bound the parser does not enforce: every number, enum, and pattern
 * comes from a parser or configuration constant, and every documented default
 * is read off an effective definition that declares no optional field, which
 * is where discovery actually resolves those defaults.
 *
 * Only the semantic claims no constant can carry — layering, clearing, and
 * cross-field rules — are written out here, in one table the compiler keys by
 * the parser's own field union, so a new definition field can neither be
 * documented by accident nor silently left undocumented.
 *
 * The tool catalog is a run boundary rather than a definition field — it says
 * what a definition may request at all, not how one field is parsed — so it
 * gets its own top-level section instead of a row in `fields`, whose compiler
 * check holds exactly one entry per parser field (#345).
 */

import {
  SHADOW_MINDS_MODEL_TURNS_HARD_MAX,
  SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS,
  SHADOW_MINDS_TOOL_CALLS_HARD_MAX,
} from "../core/config";
import type { EffectiveShadowDefinition } from "./definitions";
import {
  SHADOW_BODY_MAX_CHARS,
  SHADOW_DEFAULT_TOOLS,
  SHADOW_DELIVERIES,
  SHADOW_FILE_MAX_BYTES,
  SHADOW_ID_MAX_CHARS,
  SHADOW_ID_PATTERN,
  SHADOW_MODEL_REFERENCE,
  SHADOW_NAME_MAX_CHARS,
  SHADOW_PARENT_MODELS_MAX,
  SHADOW_PAYLOAD_MAX_CHARS,
  SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX,
  SHADOW_PRIORITY_MAX,
  SHADOW_PRIORITY_MIN,
  SHADOW_PROMPT_VERSION,
  SHADOW_RUN_BUDGET_MIN,
  SHADOW_SCHEMA_MAX_DEPTH,
  SHADOW_SCHEMA_MAX_ITEMS,
  SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT,
  SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES,
  SHADOW_SCHEMA_STRING_MAX_LENGTH,
  SHADOW_THINKING_LEVELS,
  SHADOW_TOOL_PATTERN,
  SHADOW_TOOLS_MAX,
  SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS,
  SHADOW_TRIGGERS,
  SHADOW_TRIGGERS_MAX,
  type ShadowDefinitionField,
} from "./parser";
import { SHADOW_BUILTIN_BASE_ORDER, SHADOW_EXTENSION_BASE_ORDER } from "./tools";

/** One field's documented claims: bounds, enum, pattern, default, and semantics. */
export type ShadowContractField = Record<string, unknown>;

/** The fixed read-only catalog every run's tool envelope is drawn from. */
export interface ShadowToolCatalogContract {
  /** Local evidence built-ins, in catalog order. */
  builtIns: string[];
  /** Optional opt-in remote evidence tools, in catalog order. */
  remoteEvidence: string[];
  /** The set an omitted `tools` field selects. */
  defaultSelection: string[];
}

export interface ShadowDefinitionContract {
  promptVersion: number;
  file: { maxBytes: number; commentPolicy: string };
  toolCatalog: ShadowToolCatalogContract;
  fields: Record<ShadowDefinitionField, ShadowContractField>;
  payload: { maxEncodedChars: number; maxFieldErrors: number };
}

/**
 * Builds the contract the schema reference publishes.
 *
 * @param minimal An effective definition whose layers declare no optional
 * field, so each documented default is the value discovery resolved for it.
 * `tools` is the one default an effective definition does not carry — it stays
 * absent until the run resolves it — so it falls back to the same constant
 * production falls back to.
 */
export function buildShadowDefinitionContract(minimal: EffectiveShadowDefinition): ShadowDefinitionContract {
  const fields: Record<ShadowDefinitionField, ShadowContractField> = {
    id: {
      required: true,
      maxLength: SHADOW_ID_MAX_CHARS,
      pattern: SHADOW_ID_PATTERN.source,
      equalsFilenameStem: true,
    },
    name: {
      maxLength: SHADOW_NAME_MAX_CHARS,
      effectiveRequired: true,
    },
    enabled: { default: minimal.enabled },
    hidden: { default: minimal.hidden },
    priority: {
      min: SHADOW_PRIORITY_MIN,
      max: SHADOW_PRIORITY_MAX,
      default: minimal.priority,
    },
    triggers: {
      maxEntries: SHADOW_TRIGGERS_MAX,
      unique: true,
      enum: [...SHADOW_TRIGGERS],
      default: minimal.triggers,
    },
    triggerInstructions: {
      keysSubsetOfDeclaredTriggers: true,
      valueMaxLength: SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS,
      nullClearsKey: true,
      merge: "per-key across layers",
    },
    delivery: {
      enum: [...SHADOW_DELIVERIES],
      default: minimal.delivery,
    },
    completionGate: {
      default: minimal.completionGate,
      requiresCompletionTrigger: true,
    },
    parentModels: {
      maxEntries: SHADOW_PARENT_MODELS_MAX,
      unique: true,
      entryPattern: "exact provider/model-id or *",
    },
    model: { pattern: SHADOW_MODEL_REFERENCE.source },
    thinking: { enum: [...SHADOW_THINKING_LEVELS] },
    timeoutSeconds: { min: SHADOW_RUN_BUDGET_MIN, max: SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS },
    maxTurns: { min: SHADOW_RUN_BUDGET_MIN, max: SHADOW_MINDS_MODEL_TURNS_HARD_MAX },
    maxToolCalls: { min: SHADOW_RUN_BUDGET_MIN, max: SHADOW_MINDS_TOOL_CALLS_HARD_MAX },
    tools: {
      maxEntries: SHADOW_TOOLS_MAX,
      unique: true,
      entryPattern: SHADOW_TOOL_PATTERN.source,
      default: minimal.tools ?? [...SHADOW_DEFAULT_TOOLS],
      emptyListMeans: "no tools",
      catalogIsFixed: true,
    },
    requiredTools: {
      maxEntries: SHADOW_TOOLS_MAX,
      unique: true,
      entryPattern: SHADOW_TOOL_PATTERN.source,
      subsetOfFinalTools: true,
    },
    debug: { default: minimal.debug },
    outputSchema: {
      atomicReplace: true,
      nullRestoresDefault: true,
      rootMustBeObject: true,
      additionalPropertiesFalseRequired: true,
      maxDepth: SHADOW_SCHEMA_MAX_DEPTH,
      maxTotalProperties: SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES,
      maxPropertiesPerObject: SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT,
      maxItems: SHADOW_SCHEMA_MAX_ITEMS,
      stringMaxLength: SHADOW_SCHEMA_STRING_MAX_LENGTH,
      default: minimal.outputSchema,
    },
    body: {
      maxChars: SHADOW_BODY_MAX_CHARS,
      omittedOrEmptyInherits: true,
      nonEmptyReplaces: true,
      effectiveRequired: true,
    },
  };

  return {
    promptVersion: SHADOW_PROMPT_VERSION,
    file: {
      maxBytes: SHADOW_FILE_MAX_BYTES,
      commentPolicy: "whole-line-only",
    },
    toolCatalog: {
      builtIns: [...SHADOW_BUILTIN_BASE_ORDER],
      remoteEvidence: [...SHADOW_EXTENSION_BASE_ORDER],
      defaultSelection: [...SHADOW_DEFAULT_TOOLS],
    },
    fields,
    payload: {
      maxEncodedChars: SHADOW_PAYLOAD_MAX_CHARS,
      maxFieldErrors: SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX,
    },
  };
}
