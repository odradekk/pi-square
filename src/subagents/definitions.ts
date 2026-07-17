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

/** Discovered effective definitions plus parser and overlay diagnostics for one cwd. */
export interface SubagentRegistry {
  definitions: SubagentDefinition[];
  errors: string[];
  projectDir: string | null;
}

const DEFINITION_FIELDS = [
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
const KNOWN_FIELDS = new Set(["promptVersion", "name", ...DEFINITION_FIELDS]);
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

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) || (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === `"` || ch === `'`) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      const value = stripQuotes(current).trim();
      if (value) items.push(value);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = stripQuotes(current).trim();
  if (tail) items.push(tail);
  return items;
}

function parseYamlScalar(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  return stripQuotes(trimmed).replace(/\\n/g, "\n");
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

function parseYamlDefinition(
  text: string,
  filePath: string,
  source: SubagentDefinitionSource,
): { layer?: SubagentDefinitionLayer; errors: string[] } {
  const errors: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const data: Record<string, string | string[] | null> = {};
  const seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    const match = rawLine.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) {
      errors.push(`${filePath}: unsupported YAML line ${i + 1}: ${trimmed}`);
      i += 1;
      continue;
    }

    const key = match[1] ?? "";
    if (!KNOWN_FIELDS.has(key)) errors.push(`${filePath}: unknown field '${key}'`);
    if (seen.has(key)) errors.push(`${filePath}: duplicate field '${key}'`);
    seen.add(key);
    const rest = (match[2] ?? "").trim();

    if (rest === "|" || rest === ">") {
      const currentIndent = rawLine.match(/^(\s*)/)?.[1]?.length ?? 0;
      let probe = i + 1;
      let blockIndent = currentIndent + 1;
      while (probe < lines.length) {
        const candidate = lines[probe] ?? "";
        if (!candidate.trim()) {
          probe += 1;
          continue;
        }
        blockIndent = candidate.match(/^(\s*)/)?.[1]?.length ?? 0;
        break;
      }
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const nextLine = lines[i] ?? "";
        const indent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (nextLine.trim() && indent < blockIndent) break;
        blockLines.push(nextLine.trim() ? nextLine.slice(blockIndent) : "");
        i += 1;
      }
      const value = rest === ">"
        ? blockLines.join(" ").replace(/\s+/g, " ").trim()
        : blockLines.join("\n").trim();
      data[key] = value || null;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = splitInlineArray(rest.slice(1, -1));
      i += 1;
      continue;
    }

    if (!rest) {
      const nextIndent = lines[i + 1]?.match(/^(\s*)/)?.[1]?.length ?? 0;
      const nextTrimmed = lines[i + 1]?.trim() ?? "";
      if (nextTrimmed.startsWith("- ") && nextIndent > 0) {
        const items: string[] = [];
        i += 1;
        while (i < lines.length) {
          const itemMatch = (lines[i] ?? "").match(/^\s*-\s*(.*)$/);
          if (!itemMatch) break;
          const parsed = parseYamlScalar(itemMatch[1] ?? "");
          if (typeof parsed === "string" && parsed.trim()) items.push(parsed.trim());
          i += 1;
        }
        data[key] = items;
        continue;
      }
      data[key] = null;
      i += 1;
      continue;
    }

    data[key] = parseYamlScalar(rest);
    i += 1;
  }

  const versionRaw = data.promptVersion;
  if (versionRaw !== "2") errors.push(`${filePath}: field 'promptVersion' must be 2`);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) errors.push(`${filePath}: missing required field 'name'`);
  else if (!NAME_PATTERN.test(name)) errors.push(`${filePath}: field 'name' must match ${NAME_PATTERN}`);

  const patch: Partial<SubagentDefinitionPatch> = { promptVersion: 2, name };
  for (const field of DEFINITION_FIELDS) {
    if (!seen.has(field)) continue;
    const value = data[field];
    if (STRING_FIELDS.has(field)) {
      if (value !== null && typeof value !== "string") {
        errors.push(`${filePath}: field '${field}' must be a string or null`);
      } else {
        (patch as Record<string, unknown>)[field] = typeof value === "string" ? value.trim() || null : null;
      }
      continue;
    }
    if (ARRAY_FIELDS.has(field)) {
      if (value !== null && !Array.isArray(value)) {
        errors.push(`${filePath}: field '${field}' must be an array or null`);
      } else {
        (patch as Record<string, unknown>)[field] = value === null
          ? null
          : [...new Set(value.map((item) => item.trim()).filter(Boolean))];
      }
      continue;
    }
    if (BOOLEAN_FIELDS.has(field)) {
      const parsed = parseBoolean(value, field, filePath);
      if (parsed.error) errors.push(parsed.error);
      else (patch as Record<string, unknown>)[field] = parsed.value;
    }
  }

  if (errors.length > 0) return { errors };
  return {
    layer: {
      source,
      filePath,
      contentHash: hashContent(text),
      patch: patch as SubagentDefinitionPatch,
    },
    errors,
  };
}

function loadDefinitionsFromDir(
  dir: string,
  source: SubagentDefinitionSource,
): { layers: SubagentDefinitionLayer[]; errors: string[] } {
  const layers: SubagentDefinitionLayer[] = [];
  const errors: string[] = [];
  if (!isDirectory(dir)) return { layers, errors };

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (error) {
    return { layers, errors: [`${dir}: unable to read directory (${error instanceof Error ? error.message : String(error)})`] };
  }

  const seenNames = new Map<string, string>();
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const filePath = join(dir, entry);
    try {
      const parsed = parseYamlDefinition(readFileSync(filePath, "utf8"), filePath, source);
      errors.push(...parsed.errors);
      if (!parsed.layer) continue;
      const previous = seenNames.get(parsed.layer.patch.name);
      if (previous) {
        errors.push(`Duplicate subagent name '${parsed.layer.patch.name}' in ${filePath} and ${previous}. Names must be unique within a discovery layer.`);
        continue;
      }
      seenNames.set(parsed.layer.patch.name, filePath);
      layers.push(parsed.layer);
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { layers, errors };
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
    projectDir ? loadDefinitionsFromDir(projectDir, "project") : { layers: [], errors: [] },
  ];
  const errors = loaded.flatMap((layer) => layer.errors);
  const grouped = new Map<string, SubagentDefinitionLayer[]>();
  for (const layer of loaded.flatMap((item) => item.layers)) {
    const current = grouped.get(layer.patch.name) ?? [];
    current.push(layer);
    grouped.set(layer.patch.name, current);
  }

  const definitions: SubagentDefinition[] = [];
  for (const [name, layers] of grouped) {
    const merged = mergeDefinitionLayers(name, layers);
    errors.push(...merged.errors);
    if (merged.definition) definitions.push(merged.definition);
  }

  return {
    definitions: definitions.sort((a, b) => a.name.localeCompare(b.name)),
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
