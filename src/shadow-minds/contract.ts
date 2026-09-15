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
import { SHADOW_DEFINITION_BOUNDS } from "./definition-bounds";
import { SHADOW_PAYLOAD_BOUNDS } from "./payload";
import { SHADOW_OUTPUT_SCHEMA_BOUNDS } from "./output-schema";
import {
  SHADOW_DEFAULT_TOOLS,
  SHADOW_DELIVERIES,
  SHADOW_THINKING_LEVELS,
  SHADOW_TRIGGERS,
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
  // Every bound and pattern below is read off the declarative entries the
  // parser and validators enforce (`SHADOW_DEFINITION_BOUNDS`,
  // `SHADOW_OUTPUT_SCHEMA_BOUNDS`, `SHADOW_PAYLOAD_BOUNDS`), so this
  // contract cannot claim a bound enforcement does not apply.
  const bounds = SHADOW_DEFINITION_BOUNDS;
  const fields: Record<ShadowDefinitionField, ShadowContractField> = {
    id: {
      required: true,
      maxLength: bounds.id.maxChars,
      pattern: bounds.id.pattern.source,
      equalsFilenameStem: true,
    },
    name: {
      maxLength: bounds.name.maxChars,
      effectiveRequired: true,
    },
    enabled: { default: minimal.enabled },
    hidden: { default: minimal.hidden },
    priority: {
      min: bounds.priority.min,
      max: bounds.priority.max,
      default: minimal.priority,
    },
    triggers: {
      maxEntries: bounds.triggers.maxEntries,
      unique: true,
      enum: [...SHADOW_TRIGGERS],
      default: minimal.triggers,
    },
    triggerInstructions: {
      keysSubsetOfDeclaredTriggers: true,
      valueMaxLength: bounds.triggerInstructions.valueMaxChars,
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
      maxEntries: bounds.parentModels.maxEntries,
      unique: true,
      entryPattern: "exact provider/model-id or *",
    },
    model: { pattern: bounds.modelReferencePattern.source },
    thinking: { enum: [...SHADOW_THINKING_LEVELS] },
    timeoutSeconds: { min: bounds.runBudgetMin, max: SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS },
    maxTurns: { min: bounds.runBudgetMin, max: SHADOW_MINDS_MODEL_TURNS_HARD_MAX },
    maxToolCalls: { min: bounds.runBudgetMin, max: SHADOW_MINDS_TOOL_CALLS_HARD_MAX },
    tools: {
      maxEntries: bounds.toolListsMaxEntries,
      unique: true,
      entryPattern: bounds.toolNamePattern.source,
      default: minimal.tools ?? [...SHADOW_DEFAULT_TOOLS],
      emptyListMeans: "no tools",
      catalogIsFixed: true,
    },
    requiredTools: {
      maxEntries: bounds.toolListsMaxEntries,
      unique: true,
      entryPattern: bounds.toolNamePattern.source,
      subsetOfFinalTools: true,
    },
    debug: { default: minimal.debug },
    outputSchema: {
      atomicReplace: true,
      nullRestoresDefault: true,
      rootMustBeObject: true,
      additionalPropertiesFalseRequired: true,
      maxDepth: SHADOW_OUTPUT_SCHEMA_BOUNDS.maxDepth,
      maxTotalProperties: SHADOW_OUTPUT_SCHEMA_BOUNDS.maxTotalProperties,
      maxPropertiesPerObject: SHADOW_OUTPUT_SCHEMA_BOUNDS.maxPropertiesPerObject,
      maxItems: SHADOW_OUTPUT_SCHEMA_BOUNDS.maxItems,
      stringMaxLength: SHADOW_OUTPUT_SCHEMA_BOUNDS.stringMaxLength,
      default: minimal.outputSchema,
    },
    body: {
      maxChars: bounds.body.maxChars,
      omittedOrEmptyInherits: true,
      nonEmptyReplaces: true,
      effectiveRequired: true,
    },
  };

  return {
    promptVersion: bounds.promptVersion,
    file: {
      maxBytes: bounds.fileMaxBytes,
      commentPolicy: "whole-line-only",
    },
    toolCatalog: {
      builtIns: [...SHADOW_BUILTIN_BASE_ORDER],
      remoteEvidence: [...SHADOW_EXTENSION_BASE_ORDER],
      defaultSelection: [...SHADOW_DEFAULT_TOOLS],
    },
    fields,
    payload: {
      maxEncodedChars: SHADOW_PAYLOAD_BOUNDS.maxEncodedChars,
      maxFieldErrors: SHADOW_PAYLOAD_BOUNDS.maxFieldErrors,
    },
  };
}
