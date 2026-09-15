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
import { readYamlFields, type YamlFieldKind, type YamlSubsetFinding } from "../core/yaml-subset";
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



function parseBoolean(value: unknown, fieldName: string, filePath: string): { value?: boolean | null; error?: string } {
  if (value === null) return { value: null };
  if (typeof value !== "string") return { error: `${filePath}: field '${fieldName}' must be true, false, or null` };
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return { value: true };
  if (normalized === "false") return { value: false };
  return { error: `${filePath}: field '${fieldName}' must be true, false, or null` };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The key shape accepted by the subagent definition subset. The shared
 * reader (`../core/yaml-subset`) validates keys against this pattern; a line
 * whose key fails it reports as an unsupported YAML line.
 */
export const SUBAGENT_YAML_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Every field the subagent subset accepts and the value shape each must
 * have, keyed by field name. `readYamlFields` in `../core/yaml-subset`
 * applies this table, so the parser, the configuration guide's generated
 * field table (`./config-guide`), and the reader cannot drift apart (#370).
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
    const value = data[field];
    if (STRING_FIELDS.has(field)) {
      if (value !== null && typeof value !== "string") {
        allErrors.push(`${filePath}: field '${field}' must be a string or null`);
      } else {
        (patch as Record<string, unknown>)[field] = typeof value === "string" ? value.trim() || null : null;
      }
      continue;
    }
    if (ARRAY_FIELDS.has(field)) {
      if (value !== null && !Array.isArray(value)) {
        allErrors.push(`${filePath}: field '${field}' must be an array or null`);
      } else {
        (patch as Record<string, unknown>)[field] = value === null
          ? null
          : [...new Set(value.map((item) => item.trim()).filter(Boolean))];
      }
      continue;
    }
    if (BOOLEAN_FIELDS.has(field)) {
      const parsed = parseBoolean(value, field, filePath);
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
