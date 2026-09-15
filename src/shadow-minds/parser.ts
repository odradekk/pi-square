/**
 * Strict bounded Markdown/frontmatter parser for Shadow definitions
 * (odradekk/pi-square#149, slice #153; validators split out by #365; the
 * YAML-subset structure shared with subagent definitions lives in
 * `../core/yaml-subset` since #370).
 *
 * A definition is one Markdown file: a YAML frontmatter block between two
 * `---` delimiter lines followed by the responsibility body. The frontmatter
 * is read through the shared subset reader; this module owns the Shadow
 * subset's policy on top of it — the scalar rules (plain, single- and
 * double-quoted scalars; typed null, boolean, and number spellings; no
 * comments or `: ` inside plain scalars) and the named rejections (anchors,
 * aliases, tags, merge keys, complex keys, block scalars, tabs, duplicate
 * keys; whole-line comments are skipped as author documentation). No runtime
 * dependency is added and no general YAML is supported.
 *
 * Field validation applies the bounds declared in
 * `SHADOW_DEFINITION_BOUNDS` (`./definition-bounds`) and reports violations
 * in its error messages; it exports no bound constants of its own. The
 * output-schema subset and payload validation live in `./output-schema` and
 * `./payload`.
 */

import { createHash } from "node:crypto";
import {
  SHADOW_MINDS_MODEL_TURNS_HARD_MAX,
  SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS,
  SHADOW_MINDS_TOOL_CALLS_HARD_MAX,
} from "../core/config";
import { parseYamlSubset, type YamlSubsetEntry, type YamlSubsetFinding } from "../core/yaml-subset";
import { SHADOW_DEFINITION_BOUNDS } from "./definition-bounds";
import { validateOutputSchema, type ShadowOutputSchema } from "./output-schema";

/**
 * The default local evidence set an omitted `tools` field resolves to. This is
 * a selection, not the catalog: `SHADOW_BUILTIN_BASE_ORDER` in `./tools` holds
 * the catalog's built-ins and may grow without widening this default (#345).
 */
export const SHADOW_DEFAULT_TOOLS: readonly string[] = Object.freeze(["read", "grep", "find", "ls"]);

export const SHADOW_TRIGGERS = ["tool_turn", "failure", "mutation", "completion"] as const;
export type ShadowTrigger = (typeof SHADOW_TRIGGERS)[number];

export const SHADOW_DELIVERIES = ["steer", "wake", "notify"] as const;
export type ShadowDelivery = (typeof SHADOW_DELIVERIES)[number];
export const SHADOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ShadowThinkingLevel = (typeof SHADOW_THINKING_LEVELS)[number];

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

/**
 * Every frontmatter field a definition layer may declare, in canonical order.
 * The parser's accepted-key set, the serializer's field order, and the
 * discovery merge all derive from this constant (#342), so the repository
 * holds one field-name list instead of four that can drift apart.
 */
export const SHADOW_FRONTMATTER_FIELDS = [
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
] as const satisfies readonly (keyof ShadowDefinitionFields)[];

/**
 * Every documented definition field: the frontmatter fields plus the Markdown
 * responsibility body, which carries no frontmatter key of its own.
 */
export const SHADOW_DEFINITION_FIELDS = [...SHADOW_FRONTMATTER_FIELDS, "body"] as const;

export type ShadowDefinitionField = (typeof SHADOW_DEFINITION_FIELDS)[number];

export interface ParsedShadowDefinition {
  fields: ShadowDefinitionFields;
  contentHash: string;
}

/**
 * Validates one definition layer's fields against the same bounds and
 * vocabularies `parseShadowDefinitionFile` enforces, as a typed counterpart
 * of the raw-frontmatter normalization below. Returns one message per
 * violation; an empty array means the fields are acceptable to serialize
 * and parse. Callers consume this validation result instead of restating
 * individual bounds.
 */
export function validateShadowDefinitionFields(fields: ShadowDefinitionFields): string[] {
  const bounds = SHADOW_DEFINITION_BOUNDS;
  const errors: string[] = [];
  if (typeof fields.id !== "string" || !bounds.id.pattern.test(fields.id)) {
    errors.push(`id must match ${bounds.id.pattern}`);
  }
  if (fields.name !== undefined && (typeof fields.name !== "string" || fields.name.length < 1 || fields.name.length > bounds.name.maxChars)) {
    errors.push(`name must be a string between 1 and ${bounds.name.maxChars} characters when present`);
  }
  if (fields.priority !== undefined && (!Number.isInteger(fields.priority) || fields.priority < bounds.priority.min || fields.priority > bounds.priority.max)) {
    errors.push(`priority must be an integer between ${bounds.priority.min} and ${bounds.priority.max}`);
  }
  if (fields.triggers !== undefined) {
    if (fields.triggers.some((trigger) => !(SHADOW_TRIGGERS as readonly string[]).includes(trigger))) {
      errors.push(`triggers entries must be one of ${SHADOW_TRIGGERS.join(", ")}`);
    }
    // Unreachable while the trigger enum holds exactly maxEntries values and
    // duplicates are rejected below; kept so the typed rule stays total when
    // the enum grows.
    if (fields.triggers.length > bounds.triggers.maxEntries) {
      errors.push(`triggers allows at most ${bounds.triggers.maxEntries} entries`);
    }
    if (new Set(fields.triggers).size !== fields.triggers.length) {
      errors.push("duplicate trigger in triggers");
    }
  }
  if (fields.triggerInstructions !== undefined) {
    for (const [key, value] of Object.entries(fields.triggerInstructions)) {
      if (!(SHADOW_TRIGGERS as readonly string[]).includes(key)) {
        errors.push(`unknown triggerInstructions key '${key}'`);
        continue;
      }
      if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > bounds.triggerInstructions.valueMaxChars)) {
        errors.push(`triggerInstructions.${key} must be a non-empty string or null of at most ${bounds.triggerInstructions.valueMaxChars} characters`);
      }
    }
  }
  if (fields.delivery !== undefined && !SHADOW_DELIVERIES.includes(fields.delivery)) {
    errors.push("delivery must be steer, wake, or notify");
  }
  if (fields.parentModels !== undefined) {
    if (fields.parentModels.length > bounds.parentModels.maxEntries) {
      errors.push(`parentModels allows at most ${bounds.parentModels.maxEntries} entries`);
    }
    if (new Set(fields.parentModels).size !== fields.parentModels.length) {
      errors.push("duplicate parentModels entry");
    }
    if (!fields.parentModels.every((entry) => entry === "*" || (entry.length <= bounds.modelReference.maxChars && bounds.modelReference.pattern.test(entry)))) {
      errors.push("parentModels entries must be exact 'provider/model-id' references or '*'");
    }
  }
  if (fields.model !== undefined && (typeof fields.model !== "string" || !bounds.modelReference.pattern.test(fields.model))) {
    errors.push("model must be an exact 'provider/model-id' reference");
  }
  if (fields.thinking !== undefined && !SHADOW_THINKING_LEVELS.includes(fields.thinking)) {
    errors.push(`thinking must be one of ${SHADOW_THINKING_LEVELS.join(", ")}`);
  }
  for (const key of ["timeoutSeconds", "maxTurns", "maxToolCalls"] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    const max = key === "timeoutSeconds"
      ? SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS
      : key === "maxTurns" ? SHADOW_MINDS_MODEL_TURNS_HARD_MAX : SHADOW_MINDS_TOOL_CALLS_HARD_MAX;
    if (!Number.isInteger(value) || value < bounds.runBudgets.min || value > max) {
      errors.push(`${key} must be an integer between ${bounds.runBudgets.min} and ${max}`);
    }
  }
  for (const key of ["tools", "requiredTools"] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    const fieldBounds = bounds[key];
    if (value.length > fieldBounds.maxEntries) {
      errors.push(`${key} allows at most ${fieldBounds.maxEntries} entries`);
    }
    if (new Set(value).size !== value.length) {
      errors.push(`duplicate ${key} entry`);
    }
    if (!value.every((entry) => fieldBounds.entryPattern.test(entry))) {
      errors.push(`${key} entries must be lowercase snake-case tool names`);
    }
  }
  if (fields.outputSchema !== undefined && fields.outputSchema !== null) {
    errors.push(...validateOutputSchema(fields.outputSchema));
  }
  if (fields.body !== undefined) {
    if (typeof fields.body !== "string" || fields.body.trim() === "") {
      errors.push("body must be a non-empty string when present");
    } else if (fields.body.length > bounds.body.maxChars) {
      errors.push(`body exceeds ${bounds.body.maxChars} characters`);
    }
  }
  return errors;
}

export function parseShadowDefinitionFile(
  source: string,
  content: string,
): { definition?: ParsedShadowDefinition; errors: string[] } {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > SHADOW_DEFINITION_BOUNDS.file.maxBytes) {
    return { errors: [`${source}: file exceeds the ${SHADOW_DEFINITION_BOUNDS.file.maxBytes / 1024} KiB bound (${byteLength} bytes)`] };
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
  const parsed = readFrontmatterFields(source, lines.slice(1, closing));
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

/**
 * Maps one structural finding to the Shadow subset's named error, or
 * undefined where the subset deliberately stays silent: blank lines inside a
 * block list are skipped like any other blank line.
 */
function shadowFindingMessage(source: string, finding: YamlSubsetFinding): string | undefined {
  const at = `${source}: line ${finding.line}: `;
  switch (finding.code) {
    case "blank-line-in-list":
      return undefined;
    case "tab":
      return `${at}tabs are not supported`;
    case "merge-key":
      return `${at}merge keys are not supported`;
    case "first-line-indent":
      return `${at}frontmatter must start at column zero`;
    case "unexpected-indent":
      return `${at}unexpected indentation`;
    case "indent-step":
      return `${at}nested blocks must indent exactly two spaces`;
    case "nesting-depth":
      return `${at}nesting exceeds the supported depth`;
    case "list-item-shape":
      return `${at}list items must be scalars on '- ' lines`;
    case "unbalanced-quote":
      return `${at}flow lists contain an unterminated quoted scalar`;
    case "list-item-indent":
    case "unsupported-line":
    case "key-shape":
      return `${at}unsupported or complex key '${(finding.detail ?? "").slice(0, 40)}'`;
  }
}

/** Applies the Shadow scalar policy to one raw scalar token. */
function walkScalarToken(source: string, token: { raw: string; line: number }, errors: string[]): YamlValue | undefined {
  if (token.raw.startsWith("|") || token.raw.startsWith(">")) {
    errors.push(`${source}: line ${token.line}: block scalars are not supported`);
    return undefined;
  }
  if (token.raw.startsWith("&")) {
    errors.push(`${source}: line ${token.line}: anchors are not supported`);
    return undefined;
  }
  if (token.raw.startsWith("*")) {
    errors.push(`${source}: line ${token.line}: aliases are not supported`);
    return undefined;
  }
  if (token.raw.startsWith("!")) {
    errors.push(`${source}: line ${token.line}: tags are not supported`);
    return undefined;
  }
  const scalar = parseScalar(token.raw);
  const failure = asScalarError(scalar);
  if (failure !== undefined) {
    errors.push(`${source}: line ${token.line}: ${failure}`);
    return undefined;
  }
  return scalar;
}

/** Converts one parsed entry into the field map with the Shadow scalar policy. */
function walkEntryValue(source: string, entry: YamlSubsetEntry, errors: string[]): YamlValue | undefined {
  const value = entry.value;
  switch (value.kind) {
    case "empty":
      return null;
    case "scalar":
      // A bare `{}` rest is the empty map, exactly as the subset has always
      // special-cased it; other flow mappings stay scalar rejections.
      if (value.scalar.raw === "{}") {
        return Object.create(null) as { [key: string]: YamlValue };
      }
      return walkScalarToken(source, value.scalar, errors);
    case "block":
      errors.push(`${source}: line ${entry.line}: block scalars are not supported`);
      return undefined;
    case "flow-list": {
      if (!value.closed) {
        errors.push(`${source}: line ${entry.line}: flow lists must close on one line`);
        return undefined;
      }
      const items: YamlValue[] = [];
      for (const item of value.items) {
        if (item.raw === "") {
          errors.push(`${source}: line ${entry.line}: flow lists cannot contain empty items`);
          return undefined;
        }
        const parsed = walkScalarToken(source, item, errors);
        if (parsed === undefined) return undefined;
        items.push(parsed);
      }
      return items;
    }
    case "block-list": {
      const items: YamlValue[] = [];
      for (const item of value.items) {
        const parsed = walkScalarToken(source, item, errors);
        if (parsed === undefined) return undefined;
        items.push(parsed);
      }
      return items;
    }
    case "map": {
      const map: { [key: string]: YamlValue } = Object.create(null) as { [key: string]: YamlValue };
      for (const child of value.entries) {
        if (Object.hasOwn(map, child.key)) {
          errors.push(`${source}: line ${child.line}: duplicate key '${child.key}'`);
          return undefined;
        }
        const walked = walkEntryValue(source, child, errors);
        if (walked === undefined) return undefined;
        map[child.key] = walked;
      }
      return map;
    }
  }
}

/**
 * Reads the frontmatter block through the shared subset reader and applies
 * the Shadow subset's policy: every finding the subset names rejects the
 * file, then each entry converts with the Shadow scalar rules. Returns the
 * same field map `normalizeDefinitionFields` has always consumed.
 */
function readFrontmatterFields(source: string, lines: string[]): { value?: { [key: string]: YamlValue }; errors: string[] } {
  const document = parseYamlSubset(lines.join("\n"), {
    keyPattern: SHADOW_DEFINITION_BOUNDS.yamlKeys.pattern,
    lineBase: 2,
  });
  const errors: string[] = [];
  for (const finding of document.findings) {
    const message = shadowFindingMessage(source, finding);
    if (message !== undefined) errors.push(message);
  }
  if (errors.length > 0) return { errors };
  const map: { [key: string]: YamlValue } = Object.create(null) as { [key: string]: YamlValue };
  for (const entry of document.entries) {
    if (Object.hasOwn(map, entry.key)) {
      errors.push(`${source}: line ${entry.line}: duplicate key '${entry.key}'`);
      return { errors };
    }
    const walked = walkEntryValue(source, entry, errors);
    if (walked === undefined) return { errors };
    map[entry.key] = walked;
  }
  return { value: map, errors: [] };
}

// ── Field normalization ──────────────────────────────────────────────

const KNOWN_FIELDS = new Set<string>(["promptVersion", ...SHADOW_FRONTMATTER_FIELDS]);

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
  const bounds = SHADOW_DEFINITION_BOUNDS;
  const errors: string[] = [];
  const fail = (message: string): { errors: string[] } => ({ errors: [`${source}: ${message}`] });
  if (!frontmatter) return fail("frontmatter is missing");
  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FIELDS.has(key)) return fail(`unknown field '${key}'`);
  }
  if (frontmatter.promptVersion !== bounds.promptVersion) {
    return fail(`promptVersion must be ${bounds.promptVersion} (got ${JSON.stringify(frontmatter.promptVersion) ?? "null"})`);
  }
  const id = expectString(source, frontmatter, "id", errors, 1, bounds.id.maxChars);
  const name = frontmatter.name === undefined
    ? undefined
    : expectString(source, frontmatter, "name", errors, 1, bounds.name.maxChars);
  const fileStem = source.replace(/\.md$/i, "").split(/[\\/]/).pop()!;
  if (id !== undefined && !bounds.id.pattern.test(id)) {
    errors.push(`${source}: id must match [A-Za-z0-9][A-Za-z0-9._-]{0,${bounds.id.maxChars - 1}}`);
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
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < bounds.priority.min || priority > bounds.priority.max) {
      errors.push(`${source}: priority must be an integer between ${bounds.priority.min} and ${bounds.priority.max}`);
    } else {
      fields.priority = priority;
    }
  }

  const triggers = frontmatter.triggers;
  if (triggers !== undefined) {
    const list = expectStringList(source, "triggers", triggers, errors, bounds.triggers.maxEntries);
    if (list) {
      const known = list.filter((entry): entry is ShadowTrigger => (SHADOW_TRIGGERS as readonly string[]).includes(entry));
      if (known.length !== list.length) {
        const unknown = list.filter((entry) => !(SHADOW_TRIGGERS as readonly string[]).includes(entry));
        errors.push(`${source}: triggers entries must be one of ${SHADOW_TRIGGERS.join(", ")} (unknown '${unknown.join("', '")}')`);
      }
      if (new Set(list).size !== list.length) {
        errors.push(`${source}: duplicate trigger in triggers`);
      }
      if (list.length > bounds.triggers.maxEntries) {
        errors.push(`${source}: triggers allows at most ${bounds.triggers.maxEntries} entries`);
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
        if (value.length > bounds.triggerInstructions.valueMaxChars) {
          errors.push(`${source}: triggerInstructions.${key} exceeds ${bounds.triggerInstructions.valueMaxChars.toLocaleString("en-US")} characters (${value.length.toLocaleString("en-US")})`);
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
    const list = expectStringList(source, "parentModels", parentModels, errors, bounds.parentModels.maxEntries);
    if (list) {
      if (new Set(list).size !== list.length) {
        errors.push(`${source}: duplicate parentModels entry`);
      }
      if (!list.every((entry) => entry === "*" || (entry.length <= bounds.modelReference.maxChars && bounds.modelReference.pattern.test(entry)))) {
        errors.push(`${source}: parentModels entries must be exact 'provider/model-id' references or '*'`);
      }
      if (errors.length === 0) fields.parentModels = list;
    }
  }

  const model = frontmatter.model;
  if (model !== undefined) {
    if (typeof model !== "string" || !bounds.modelReference.pattern.test(model)) {
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
    if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < bounds.runBudgets.min || timeoutSeconds > SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS) {
      errors.push(`${source}: timeoutSeconds must be an integer between ${bounds.runBudgets.min} and ${SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS}`);
    } else {
      fields.timeoutSeconds = timeoutSeconds;
    }
  }
  const maxTurns = frontmatter.maxTurns;
  if (maxTurns !== undefined) {
    if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < bounds.runBudgets.min || maxTurns > SHADOW_MINDS_MODEL_TURNS_HARD_MAX) {
      errors.push(`${source}: maxTurns must be an integer between ${bounds.runBudgets.min} and ${SHADOW_MINDS_MODEL_TURNS_HARD_MAX}`);
    } else {
      fields.maxTurns = maxTurns;
    }
  }
  const maxToolCalls = frontmatter.maxToolCalls;
  if (maxToolCalls !== undefined) {
    if (typeof maxToolCalls !== "number" || !Number.isInteger(maxToolCalls) || maxToolCalls < bounds.runBudgets.min || maxToolCalls > SHADOW_MINDS_TOOL_CALLS_HARD_MAX) {
      errors.push(`${source}: maxToolCalls must be an integer between ${bounds.runBudgets.min} and ${SHADOW_MINDS_TOOL_CALLS_HARD_MAX}`);
    } else {
      fields.maxToolCalls = maxToolCalls;
    }
  }

  const tools = frontmatter.tools;
  if (tools !== undefined) {
    const list = expectStringList(source, "tools", tools, errors, bounds.tools.maxEntries);
    if (list) {
      if (new Set(list).size !== list.length) errors.push(`${source}: duplicate tools entry`);
      if (!list.every((entry) => bounds.tools.entryPattern.test(entry))) {
        errors.push(`${source}: tools entries must be lowercase snake-case tool names`);
      }
      if (errors.length === 0) fields.tools = list;
    }
  }
  const requiredTools = frontmatter.requiredTools;
  if (requiredTools !== undefined) {
    const list = expectStringList(source, "requiredTools", requiredTools, errors, bounds.requiredTools.maxEntries);
    if (list) {
      if (new Set(list).size !== list.length) errors.push(`${source}: duplicate requiredTools entry`);
      if (!list.every((entry) => bounds.requiredTools.entryPattern.test(entry))) {
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
    if (body.length > bounds.body.maxChars) {
      errors.push(`${source}: body exceeds ${bounds.body.maxChars.toLocaleString("en-US")} characters (${body.length.toLocaleString("en-US")})`);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
