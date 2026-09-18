import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  parseYamlSubset,
  type YamlScalar,
  type YamlSubsetEntry,
  type YamlSubsetFinding,
} from "../core/yaml-subset";
import { getPackagePath } from "../core/paths";

export type SubagentDefinitionSource = "package" | "agent" | "project";
export type SubagentDefinitionField =
  | "description"
  | "model"
  | "effort"
  | "policy"
  | "instructions"
  | "output"
  | "inheritParentSystem"
  | "tools"
  | "extensionTools"
  | "skills"
  | "visible";

export interface SubagentDefinitionSourceRef {
  source: SubagentDefinitionSource;
  filePath: string;
  contentHash: string;
}

export interface SubagentDefinitionPatch {
  promptVersion: 2;
  name: string;
  description?: string | null;
  model?: string | null;
  effort?: string | null;
  policy?: string | null;
  instructions?: string | null;
  output?: string | null;
  inheritParentSystem?: boolean | null;
  tools?: string[] | null;
  extensionTools?: string[] | null;
  skills?: string[] | null;
  visible?: boolean | null;
}

export interface SubagentDefinitionLayer extends SubagentDefinitionSourceRef {
  patch: SubagentDefinitionPatch;
}

/** Effective V2 subagent profile assembled from package, agent, and project overlays. */
export interface SubagentDefinition {
  promptVersion: 2;
  name: string;
  description: string;
  model?: string;
  effort?: string;
  policy?: string;
  instructions?: string;
  output?: string;
  inheritParentSystem: boolean;
  tools?: string[];
  extensionTools?: string[];
  skills?: string[];
  visible: boolean;
  /** Highest-precedence layer contributing to this effective definition. */
  source: SubagentDefinitionSource;
  filePath: string;
  fieldSources: Partial<Record<SubagentDefinitionField, SubagentDefinitionSourceRef>>;
  layers: SubagentDefinitionLayer[];
}

/**
 * A definition file that was rejected whole — a parse failure or an overlay
 * merge failure. Carried beside valid definitions so management surfaces can
 * show which file is broken and why, following the Shadow Minds registry shape.
 */
export interface InvalidSubagentDefinition {
  /** The parsed definition name when one survived; otherwise the rejected file's stem. */
  id: string;
  /** The rejected file, or — for an overlay merge failure — every contributing layer. */
  sources: string[];
  errors: string[];
}

/** Discovered effective definitions plus invalid entries and diagnostics for one cwd. */
export interface SubagentRegistry {
  definitions: SubagentDefinition[];
  invalid: InvalidSubagentDefinition[];
  errors: string[];
  projectDir: string | null;
}

/**
 * Every overlay-definable V2 field in canonical order. The configuration guide
 * renders its field table from this constant (#334), so the table can never
 * drift from the parser's field set. `promptVersion` and `name` are layer
 * identity fields, not overlay fields, and stay outside the table.
 */
export const DEFINITION_FIELDS = [
  "description",
  "model",
  "effort",
  "policy",
  "instructions",
  "output",
  "inheritParentSystem",
  "tools",
  "extensionTools",
  "skills",
  "visible",
] as const satisfies readonly SubagentDefinitionField[];
const STRING_FIELDS = new Set<SubagentDefinitionField>([
  "description",
  "model",
  "effort",
  "policy",
  "instructions",
  "output",
]);
const ARRAY_FIELDS = new Set<SubagentDefinitionField>(["tools", "extensionTools", "skills"]);
const BOOLEAN_FIELDS = new Set<SubagentDefinitionField>(["inheritParentSystem", "visible"]);

/** How the parser types a field's value, in the configuration guide's wording. */
export type SubagentFieldValueType = "string" | "string list" | "boolean";

/**
 * The value type the parser enforces for one overlay field. The configuration
 * guide renders its type column from this (#334) instead of restating the sets
 * above, so the table cannot disagree with what the parser actually accepts.
 * The branch order matches the parse loop's own.
 */
export function subagentFieldValueType(field: SubagentDefinitionField): SubagentFieldValueType {
  if (ARRAY_FIELDS.has(field)) return "string list";
  if (BOOLEAN_FIELDS.has(field)) return "boolean";
  return "string";
}
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectSubagentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = join(currentDir, ".pi", "subagents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/** One shared message for every blank line that breaks a block list open. */
function blankLineInListMessage(filePath: string, line: number, key: string): string {
  return `${filePath}: line ${line}: blank line inside the block list for '${key}' — remove blank lines between or before list items`;
}

/**
 * Parses a boolean field's scalar spelling. The field-kind table in
 * `readYamlFields` guarantees only a string or a clear marker reaches this
 * point; any other spelling rejects with the subset's named error.
 */
function parseBoolean(value: string | null, fieldName: string, filePath: string): { value?: boolean | null; error?: string } {
  if (value === null) return { value: null };
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return { value: true };
  if (normalized === "false") return { value: false };
  return { error: `${filePath}: field '${fieldName}' must be true, false, or null` };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Definition text → fields ─────────────────────────────────────────
//
// The shared subset reader (`../core/yaml-subset`) owns the structural
// layer; this profile applies the subagent definition policy on top: the
// field-kind table, the named unknown/duplicate/shape errors, and the
// scalar rules (inline comments, null spellings, quote stripping, `\n`
// escapes). Values convert only when clean; the layer semantics below
// consume the resulting fields.

/** The value shape a definition field accepts in the subagent subset. */
export type YamlFieldKind = "string" | "list" | "boolean";

/** A field read through `readYamlFields`; `value` is null for a clear marker. */
export interface YamlField {
  key: string;
  line: number;
  value: string | string[] | null;
}

export interface YamlFieldOptions {
  /** Label prepended to every error message. */
  source: string;
  /** Every accepted field and the shape its value must have. */
  fields: Readonly<Record<string, YamlFieldKind>>;
  /** The accepted key shape; see `parseYamlSubset`. */
  keyPattern: RegExp;
  /** 1-based number of `text`'s first line; defaults to 1. */
  lineBase?: number;
}

export interface YamlFieldsResult {
  fields: YamlField[];
  errors: string[];
  /** The structural findings; the caller maps the ones it names to errors. */
  findings: YamlSubsetFinding[];
}

/** One shared message for every inline-comment rejection in the subagent subset. */
const INLINE_COMMENT_MESSAGE = "inline comments are not supported — quote the value to keep a literal '#' or move the comment to its own line";

/**
 * Index where an inline comment starts inside one YAML-subset value, or -1.
 * A `#` starts a comment when it begins the value or follows a space or tab,
 * matching standard YAML; quoted strings never contain a comment.
 */
function findInlineComment(value: string): number {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === `"` || ch === `'`) {
      quote = ch;
      continue;
    }
    if (ch === "#" && (index === 0 || value[index - 1] === " " || value[index - 1] === "\t")) return index;
  }
  return -1;
}

function isQuotedScalar(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) || (trimmed.startsWith(`'`) && trimmed.endsWith(`'`));
}

/**
 * Rejects misspelled null spellings — every casing of `null` other than the
 * exact lowercase word and tilde lookalikes such as `～` — instead of
 * silently storing them as literal strings. `null` and `~` are
 * case-sensitive in this subset; quoted strings are literal by design and
 * stay untouched.
 */
function nullSpellingProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (isQuotedScalar(trimmed)) return undefined;
  if (trimmed !== "null" && trimmed.toLowerCase() === "null") {
    return "null spellings are case-sensitive; write lowercase null or ~";
  }
  if (trimmed === "〜" || trimmed === "～") {
    return "tilde null must be the ASCII ~ character";
  }
  return undefined;
}

/** Strips one pair of matching quotes when they wrap the whole value. */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (isQuotedScalar(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * The subagent subset's scalar conversion: exact lowercase `null` and ASCII
 * `~` clear, other spellings stay literal, quotes are stripped, and `\n`
 * escapes resolve.
 */
function convertScalarText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  return stripQuotes(trimmed).replace(/\\n/g, "\n");
}

/**
 * Applies the subagent scalar policy to one scalar token: inline comments
 * and misspelled null spellings reject with the subset's named errors, then
 * the text converts. Returns null alongside a recorded error.
 */
function convertScalar(source: string, scalar: YamlScalar, errors: string[]): string | null {
  if (findInlineComment(scalar.raw) >= 0) {
    errors.push(`${source}: line ${scalar.line}: ${INLINE_COMMENT_MESSAGE}`);
    return null;
  }
  const spellingProblem = nullSpellingProblem(scalar.raw);
  if (spellingProblem !== undefined) {
    errors.push(`${source}: line ${scalar.line}: '${scalar.raw}' — ${spellingProblem}`);
    return null;
  }
  return convertScalarText(scalar.raw);
}

function fieldKindError(source: string, key: string, kind: YamlFieldKind): string {
  const expectation = kind === "string" ? "a string or null" : kind === "list" ? "an array or null" : "true, false, or null";
  return `${source}: field '${key}' must be ${expectation}`;
}

/**
 * Converts one entry's value with the subagent scalar policy and returns the
 * field value. `kind` is undefined for names the field table does not
 * declare: the value still converts so its policy errors surface, but no
 * shape check applies. Returns undefined once the conversion recorded an
 * error; the shape check runs only on clean conversions.
 */
function convertEntryValue(
  source: string,
  entry: YamlSubsetEntry,
  errors: string[],
  kind: YamlFieldKind | undefined,
): string | string[] | null | undefined {
  const value = entry.value;
  if (value.kind === "empty") return null;
  const before = errors.length;
  let converted: string | string[] | null = null;
  if (value.kind === "scalar") {
    converted = convertScalar(source, value.scalar, errors);
  } else if (value.kind === "flow-list" && !value.closed) {
    // An unclosed `[` is a plain scalar in this subset, never a list.
    converted = convertScalar(source, { raw: value.raw, line: entry.line }, errors);
  } else if (value.kind === "block") {
    if (value.indicator !== "|" && value.indicator !== ">") {
      errors.push(`${source}: line ${entry.line}: block scalar '${value.indicator}' carries an unsupported chomping or indentation indicator — use '|' or '>' alone`);
    } else {
      converted = value.content || null;
    }
  } else if (value.kind === "flow-list" || value.kind === "block-list") {
    const items: string[] = [];
    for (const item of value.items) {
      // A first item with no text never opened a list in this subset; it
      // reports as the bare line instead of silently clearing the field.
      if (value.kind === "block-list" && items.length === 0 && item.raw === "") {
        errors.push(`${source}: unsupported YAML line ${item.line}: -`);
      }
      const itemValue = convertScalar(source, item, errors);
      if (typeof itemValue === "string" && itemValue.trim()) items.push(itemValue.trim());
    }
    converted = items;
  }
  // Map values (and blocks rejected above) convert to nothing; the shape
  // check below names the field when one applies.
  if (errors.length !== before) return undefined;
  if (kind === undefined) return converted;
  if (value.kind === "map") {
    errors.push(fieldKindError(source, entry.key, kind));
    return undefined;
  }
  const shape = (value.kind === "flow-list" && value.closed) || value.kind === "block-list" ? "list" : "scalar";
  if (shape === "list" ? kind !== "list" : kind === "list" && converted !== null) {
    errors.push(fieldKindError(source, entry.key, kind));
    return undefined;
  }
  return converted;
}

/**
 * Reads subagent definition text into typed fields. Unknown fields, duplicate
 * fields, and values whose shape does not match the declared field kind
 * reject with the subagent subset's named errors; scalar values, list items,
 * and block scalars convert with the subagent scalar policy. Structural
 * findings are returned for the caller to name or ignore.
 */
export function readYamlFields(text: string, options: YamlFieldOptions): YamlFieldsResult {
  const document = parseYamlSubset(text, { keyPattern: options.keyPattern, lineBase: options.lineBase });
  const fields: YamlField[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of document.entries) {
    const known = Object.hasOwn(options.fields, entry.key);
    if (!known) errors.push(`${options.source}: unknown field '${entry.key}'`);
    if (seen.has(entry.key)) errors.push(`${options.source}: duplicate field '${entry.key}'`);
    seen.add(entry.key);
    // Values convert even for unknown or repeated keys so every policy error
    // (an inline comment, a misspelled null, a chomping indicator) names its
    // line; only clean conversions of known fields become fields, and a
    // repeated key keeps its last clean conversion.
    const before = errors.length;
    const converted = convertEntryValue(options.source, entry, errors, known ? options.fields[entry.key]! : undefined);
    if (!known || errors.length !== before) continue;
    const existing = fields.findIndex((field) => field.key === entry.key);
    if (existing >= 0) fields.splice(existing, 1);
    fields.push({ key: entry.key, line: entry.line, value: converted! });
  }
  return { fields, errors, findings: document.findings };
}

/**
 * The key shape accepted by the subagent definition subset. The shared
 * reader (`../core/yaml-subset`) validates keys against this pattern; a line
 * whose key fails it reports as an unsupported YAML line.
 */
export const SUBAGENT_YAML_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Every field the subagent subset accepts and the value shape each must
 * have, keyed by field name. The `readYamlFields` profile below applies this
 * table, so the parser, the configuration guide's generated field table
 * (`./config-guide`), and the reader cannot drift apart (#370).
 */
export const SUBAGENT_FIELD_KINDS: Readonly<Record<string, YamlFieldKind>> = Object.freeze({
  promptVersion: "string",
  name: "string",
  ...Object.fromEntries(
    DEFINITION_FIELDS.map((field): [string, YamlFieldKind] => [
      field,
      ARRAY_FIELDS.has(field) ? "list" : BOOLEAN_FIELDS.has(field) ? "boolean" : "string",
    ]),
  ),
});

/**
 * Names the structural findings the subagent subset rejects and ignores the
 * ones its flat shape never produces: indentation freedom, map depth, tabs,
 * and unterminated quotes inside flow lists stay observational rather than
 * named errors, matching the subset's historical acceptance.
 */
function subagentFindingMessage(filePath: string, finding: YamlSubsetFinding): string | undefined {
  switch (finding.code) {
    case "blank-line-in-list":
      return blankLineInListMessage(filePath, finding.line, finding.detail ?? "");
    case "list-item-indent":
      return `${filePath}: line ${finding.line}: list items must be indented under their field — write '  - ${(finding.detail ?? "").replace(/^-\s*/, "")}'`;
    case "tab":
    case "indent-step":
    case "nesting-depth":
    case "unbalanced-quote":
    case "list-item-shape":
      // A `-`-led line at a looser indent still reads as an item here.
      return undefined;
    case "merge-key":
    case "first-line-indent":
    case "unexpected-indent":
    case "unsupported-line":
    case "key-shape":
      return `${filePath}: unsupported YAML line ${finding.line}: ${(finding.detail ?? "").trim()}`;
  }
}

function parseYamlDefinition(
  text: string,
  filePath: string,
  source: SubagentDefinitionSource,
): { layer?: SubagentDefinitionLayer; errors: string[]; name?: string } {
  // Text becomes fields through the shared subset reader; this module keeps
  // only layer semantics (identity fields, clear markers, overlay patches).
  const { fields, errors, findings } = readYamlFields(text, {
    source: filePath,
    fields: SUBAGENT_FIELD_KINDS,
    keyPattern: SUBAGENT_YAML_KEY_PATTERN,
  });
  const allErrors: string[] = [];
  for (const finding of findings) {
    const message = subagentFindingMessage(filePath, finding);
    if (message !== undefined) allErrors.push(message);
  }
  allErrors.push(...errors);
  const data: Record<string, string | string[] | null> = {};
  const seen = new Set<string>();
  for (const field of fields) {
    data[field.key] = field.value;
    seen.add(field.key);
  }

  const versionRaw = data.promptVersion;
  if (versionRaw !== "2") allErrors.push(`${filePath}: field 'promptVersion' must be 2`);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) allErrors.push(`${filePath}: missing required field 'name'`);
  else if (!NAME_PATTERN.test(name)) allErrors.push(`${filePath}: field 'name' must match ${NAME_PATTERN}`);

  const patch: Partial<SubagentDefinitionPatch> = { promptVersion: 2, name };
  for (const field of DEFINITION_FIELDS) {
    if (!seen.has(field)) continue;
    // readYamlFields guarantees each field's shape — string fields hold a
    // string or null, list fields a string[] or null — so only the boolean
    // spelling can still reject here.
    const value = data[field];
    if (STRING_FIELDS.has(field)) {
      (patch as Record<string, unknown>)[field] = typeof value === "string" ? value.trim() || null : null;
    } else if (ARRAY_FIELDS.has(field)) {
      (patch as Record<string, unknown>)[field] = value === null
        ? null
        : [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))];
    } else {
      const parsed = parseBoolean(value as string | null, field, filePath);
      if (parsed.error) allErrors.push(parsed.error);
      else (patch as Record<string, unknown>)[field] = parsed.value;
    }
  }

  if (allErrors.length > 0) {
    // The candidate name keys the invalid entry the discovery layer surfaces;
    // it is undefined when the file never produced a usable name.
    return { errors: allErrors, ...(name && NAME_PATTERN.test(name) ? { name } : {}) };
  }
  return {
    layer: {
      source,
      filePath,
      contentHash: hashContent(text),
      patch: patch as SubagentDefinitionPatch,
    },
    errors: allErrors,
  };
}

function fileStem(entry: string): string {
  return entry.replace(/\.ya?ml$/i, "");
}

function loadDefinitionsFromDir(
  dir: string,
  source: SubagentDefinitionSource,
): { layers: SubagentDefinitionLayer[]; errors: string[]; invalid: InvalidSubagentDefinition[] } {
  const layers: SubagentDefinitionLayer[] = [];
  const errors: string[] = [];
  const invalid: InvalidSubagentDefinition[] = [];
  if (!isDirectory(dir)) return { layers, errors, invalid };

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (error) {
    return { layers, errors: [`${dir}: unable to read directory (${error instanceof Error ? error.message : String(error)})`], invalid };
  }

  const seenNames = new Map<string, string>();
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const filePath = join(dir, entry);
    try {
      const parsed = parseYamlDefinition(readFileSync(filePath, "utf8"), filePath, source);
      errors.push(...parsed.errors);
      if (!parsed.layer) {
        // Rejected files stay inspectable: identity from the parsed name when
        // one survived, otherwise the file stem.
        invalid.push({ id: parsed.name ?? fileStem(entry), sources: [filePath], errors: [...parsed.errors] });
        continue;
      }
      const previous = seenNames.get(parsed.layer.patch.name);
      if (previous) {
        errors.push(`Duplicate subagent name '${parsed.layer.patch.name}' in ${filePath} and ${previous}. Names must be unique within a discovery layer.`);
        continue;
      }
      seenNames.set(parsed.layer.patch.name, filePath);
      layers.push(parsed.layer);
    } catch (error) {
      const message = `${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      invalid.push({ id: fileStem(entry), sources: [filePath], errors: [message] });
    }
  }
  return { layers, errors, invalid };
}

function sourceRef(layer: SubagentDefinitionLayer): SubagentDefinitionSourceRef {
  return { source: layer.source, filePath: layer.filePath, contentHash: layer.contentHash };
}

function mergeDefinitionLayers(name: string, layers: SubagentDefinitionLayer[]): { definition?: SubagentDefinition; errors: string[] } {
  const values: Partial<Record<SubagentDefinitionField, unknown>> = {};
  const fieldSources: Partial<Record<SubagentDefinitionField, SubagentDefinitionSourceRef>> = {};

  for (const layer of layers) {
    for (const field of DEFINITION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(layer.patch, field)) continue;
      const raw = layer.patch[field];
      values[field] = raw === null ? undefined : Array.isArray(raw) ? [...raw] : raw;
      fieldSources[field] = sourceRef(layer);
    }
  }

  const description = typeof values.description === "string" ? values.description.trim() : "";
  if (!description) {
    return { errors: [`Effective subagent '${name}' is missing required field 'description' after overlay resolution.`] };
  }
  const top = layers.at(-1);
  if (!top) return { errors: [`Effective subagent '${name}' has no definition layers.`] };

  return {
    definition: {
      promptVersion: 2,
      name,
      description,
      ...(typeof values.model === "string" ? { model: values.model } : {}),
      ...(typeof values.effort === "string" ? { effort: values.effort } : {}),
      ...(typeof values.policy === "string" ? { policy: values.policy } : {}),
      ...(typeof values.instructions === "string" ? { instructions: values.instructions } : {}),
      ...(typeof values.output === "string" ? { output: values.output } : {}),
      inheritParentSystem: typeof values.inheritParentSystem === "boolean" ? values.inheritParentSystem : true,
      ...(Array.isArray(values.tools) ? { tools: [...values.tools] as string[] } : {}),
      ...(Array.isArray(values.extensionTools) ? { extensionTools: [...values.extensionTools] as string[] } : {}),
      ...(Array.isArray(values.skills) ? { skills: [...values.skills] as string[] } : {}),
      visible: typeof values.visible === "boolean" ? values.visible : true,
      source: top.source,
      filePath: top.filePath,
      fieldSources,
      layers: layers.map((layer) => ({ ...layer, patch: structuredClone(layer.patch) })),
    },
    errors: [],
  };
}

export function discoverSubagents(cwd: string): SubagentRegistry {
  const projectDir = findNearestProjectSubagentsDir(cwd);
  const loaded = [
    loadDefinitionsFromDir(getPackagePath("subagents"), "package"),
    loadDefinitionsFromDir(join(getAgentDir(), "subagents"), "agent"),
    projectDir ? loadDefinitionsFromDir(projectDir, "project") : { layers: [], errors: [], invalid: [] },
  ];
  const errors = loaded.flatMap((layer) => layer.errors);
  const grouped = new Map<string, SubagentDefinitionLayer[]>();
  for (const layer of loaded.flatMap((item) => item.layers)) {
    const current = grouped.get(layer.patch.name) ?? [];
    current.push(layer);
    grouped.set(layer.patch.name, current);
  }

  const invalidById = new Map<string, InvalidSubagentDefinition>();
  const recordInvalid = (entry: InvalidSubagentDefinition): void => {
    const existing = invalidById.get(entry.id);
    if (existing) {
      existing.sources.push(...entry.sources.filter((source) => !existing.sources.includes(source)));
      existing.errors.push(...entry.errors);
      return;
    }
    invalidById.set(entry.id, entry);
  };
  for (const failure of loaded.flatMap((item) => item.invalid)) recordInvalid(failure);

  const definitions: SubagentDefinition[] = [];
  for (const [name, layers] of grouped) {
    const merged = mergeDefinitionLayers(name, layers);
    errors.push(...merged.errors);
    if (merged.definition) {
      definitions.push(merged.definition);
    } else {
      // Overlay merge failures would otherwise make the definition vanish with
      // only a startup warning; keep them inspectable with every contributing
      // layer as the source set.
      recordInvalid({ id: name, sources: layers.map((layer) => layer.filePath), errors: merged.errors });
    }
  }

  const invalid = [...invalidById.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    definitions: definitions.sort((a, b) => a.name.localeCompare(b.name)),
    invalid,
    errors,
    projectDir,
  };
}

export function filterVisibleSubagents(registry: SubagentRegistry): SubagentRegistry {
  return {
    ...registry,
    definitions: registry.definitions.filter((definition) => definition.visible),
  };
}

function scalarYaml(value: string): string {
  return JSON.stringify(value);
}

function blockYaml(field: string, value: string): string[] {
  return [`${field}: |`, ...value.split("\n").map((line) => `  ${line}`)];
}

export function serializeDefinitionPatch(patch: SubagentDefinitionPatch): string {
  if (!NAME_PATTERN.test(patch.name)) throw new Error(`Invalid subagent name '${patch.name}'.`);
  const lines = ["promptVersion: 2", `name: ${scalarYaml(patch.name)}`];
  for (const field of DEFINITION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (value === null) {
      lines.push(`${field}: null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${field}: []`);
      else lines.push(`${field}:`, ...value.map((item) => `  - ${scalarYaml(item)}`));
    } else if (typeof value === "boolean") {
      lines.push(`${field}: ${value}`);
    } else if (typeof value === "string") {
      if (["description", "policy", "instructions", "output"].includes(field)) lines.push(...blockYaml(field, value));
      else lines.push(`${field}: ${scalarYaml(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function definitionScopeDir(scope: "agent" | "project", cwd: string): string {
  if (scope === "agent") return join(getAgentDir(), "subagents");
  return findNearestProjectSubagentsDir(cwd) ?? join(cwd, ".pi", "subagents");
}

export function definitionOverlayPath(scope: "agent" | "project", cwd: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid subagent name '${name}'.`);
  return join(definitionScopeDir(scope, cwd), `${name}.yaml`);
}

export function previewDefinitionPatch(input: {
  registry: SubagentRegistry;
  cwd: string;
  scope: "agent" | "project";
  patch: SubagentDefinitionPatch;
}): { content: string; filePath: string; definition?: SubagentDefinition; errors: string[] } {
  const content = serializeDefinitionPatch(input.patch);
  const current = input.registry.definitions.find((definition) => definition.name === input.patch.name);
  const existingLayer = current?.layers.find((layer) => layer.source === input.scope);
  const filePath = existingLayer?.filePath ?? definitionOverlayPath(input.scope, input.cwd, input.patch.name);
  const retained = (current?.layers ?? []).filter((layer) => layer.source !== input.scope);
  const candidate: SubagentDefinitionLayer = {
    source: input.scope,
    filePath,
    contentHash: hashContent(content),
    patch: structuredClone(input.patch),
  };
  const rank: Record<SubagentDefinitionSource, number> = { package: 0, agent: 1, project: 2 };
  const merged = mergeDefinitionLayers(input.patch.name, [...retained, candidate].sort((a, b) => rank[a.source] - rank[b.source]));
  return { content, filePath, definition: merged.definition, errors: merged.errors };
}

function validateOverlayFilePath(scope: "agent" | "project", cwd: string, filePath: string): string {
  const scopeDir = resolve(definitionScopeDir(scope, cwd));
  const candidate = resolve(filePath);
  if (dirname(candidate) !== scopeDir || ![".yaml", ".yml"].includes(extname(candidate).toLowerCase())) {
    throw new Error(`Definition path '${filePath}' is outside the ${scope} subagent directory.`);
  }
  return candidate;
}

export function writeDefinitionPatch(input: {
  cwd: string;
  scope: "agent" | "project";
  patch: SubagentDefinitionPatch;
  filePath?: string;
}): { filePath: string; content: string } {
  const content = serializeDefinitionPatch(input.patch);
  const filePath = validateOverlayFilePath(
    input.scope,
    input.cwd,
    input.filePath ?? definitionOverlayPath(input.scope, input.cwd, input.patch.name),
  );
  const parsed = parseYamlDefinition(content, filePath, input.scope);
  if (!parsed.layer || parsed.errors.length > 0) throw new Error(parsed.errors.join(" ") || "Invalid subagent definition.");
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
  return { filePath, content };
}

export function deleteDefinitionOverlay(input: {
  cwd: string;
  scope: "agent" | "project";
  name: string;
  filePath?: string;
}): boolean {
  const filePath = validateOverlayFilePath(
    input.scope,
    input.cwd,
    input.filePath ?? definitionOverlayPath(input.scope, input.cwd, input.name),
  );
  if (!existsSync(filePath)) return false;
  rmSync(filePath);
  return true;
}

export const __testables = {
  findNearestProjectSubagentsDir,
  hashContent,
  mergeDefinitionLayers,
  parseYamlDefinition,
};
