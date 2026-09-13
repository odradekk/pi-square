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

/** Quote-aware split of an inline array body into raw trimmed items, quotes kept. */
function splitInlineArrayItems(body: string): string[] {
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
      const value = current.trim();
      if (value) items.push(value);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) items.push(tail);
  return items;
}

/**
 * Inline array items get the same scalar treatment as block list items:
 * quoted strings lose their quotes, exact `null` and `~` spellings clear the
 * item, and escapes resolve — one spelling never diverges between the forms.
 */
function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  for (const raw of splitInlineArrayItems(body)) {
    const parsed = parseYamlScalar(raw);
    if (typeof parsed === "string" && parsed.trim()) items.push(parsed.trim());
  }
  return items;
}

function parseYamlScalar(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  return stripQuotes(trimmed).replace(/\\n/g, "\n");
}

/** Bare block scalar indicators with a chomping or indentation marker (`|-`, `>+`, `|2`). */
const CHOMPING_INDICATOR_PATTERN = /^[|>][-+0-9]*$/;

/**
 * One shared message for every inline-comment rejection. Quoting is the way to
 * keep a literal '#' such as an issue number in the value; moving the comment
 * to its own line is the way to actually have a comment.
 */
const INLINE_COMMENT_MESSAGE = "inline comments are not supported — quote the value to keep a literal '#' or move the comment to its own line";

/** One shared message for every blank line that breaks a block list open. */
function blankLineInListMessage(filePath: string, line: number, key: string): string {
  return `${filePath}: line ${line}: blank line inside the block list for '${key}' — remove blank lines between or before list items`;
}

/**
 * Index where an inline comment starts inside one YAML-subset value, or -1.
 * A `#` starts a comment when it begins the value or follows a space or tab,
 * matching standard YAML; quoted strings never contain a comment. Inline
 * comments are not supported by this subset, so callers reject the line instead
 * of storing the comment text in the field value.
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
 * exact lowercase word and tilde lookalikes such as `～` — instead of silently
 * storing them as literal strings. `null` and `~` are case-sensitive in this
 * subset; quoted strings are literal by design and stay untouched.
 */
function nullSpellingProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (isQuotedScalar(trimmed)) return undefined;
  if (trimmed !== "null" && trimmed.toLowerCase() === "null") {
    return `null spellings are case-sensitive; write lowercase null or ~`;
  }
  if (trimmed === "〜" || trimmed === "～") {
    return `tilde null must be the ASCII ~ character`;
  }
  return undefined;
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
): { layer?: SubagentDefinitionLayer; errors: string[]; name?: string } {
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
      if (/^-\s?/.test(rawLine)) {
        // Column-zero list items never attach to a field; the message states
        // the indentation rule instead of a generic unsupported-line error.
        errors.push(`${filePath}: line ${i + 1}: list items must be indented under their field — write '  - ${trimmed.replace(/^-\s*/, "")}'`);
      } else {
        errors.push(`${filePath}: unsupported YAML line ${i + 1}: ${trimmed}`);
      }
      i += 1;
      continue;
    }

    const key = match[1] ?? "";
    if (!KNOWN_FIELDS.has(key)) errors.push(`${filePath}: unknown field '${key}'`);
    if (seen.has(key)) errors.push(`${filePath}: duplicate field '${key}'`);
    seen.add(key);
    const rest = (match[2] ?? "").trim();

    if (findInlineComment(rest) >= 0) {
      errors.push(`${filePath}: line ${i + 1}: ${INLINE_COMMENT_MESSAGE}`);
      data[key] = null;
      i += 1;
      continue;
    }

    if (rest === "|" || rest === ">" || CHOMPING_INDICATOR_PATTERN.test(rest)) {
      const fieldLine = i + 1;
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
      // Only lines indented past the field carry block content. Without this
      // guard a following field at the same indent reads as the body and is
      // swallowed, taking its own value and the file's identity with it.
      if (blockIndent > currentIndent) {
        while (i < lines.length) {
          const nextLine = lines[i] ?? "";
          const indent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
          if (nextLine.trim() && indent < blockIndent) break;
          blockLines.push(nextLine.trim() ? nextLine.slice(blockIndent) : "");
          i += 1;
        }
      }
      if (rest !== "|" && rest !== ">") {
        // Chomping and indentation indicators (`|-`, `>+`, `|2`) are not part
        // of this subset. A real body is consumed along with the rejection so
        // it cannot pile orphaned-line errors on top of the named cause.
        errors.push(`${filePath}: line ${fieldLine}: block scalar '${rest}' carries an unsupported chomping or indentation indicator — use '|' or '>' alone`);
        data[key] = null;
        continue;
      }
      const value = rest === ">"
        ? blockLines.join(" ").replace(/\s+/g, " ").trim()
        : blockLines.join("\n").trim();
      data[key] = value || null;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline arrays get the same item checks as block lists, so one spelling
      // of the same value cannot silently diverge between the two forms.
      let misspelling: { item: string; problem: string } | undefined;
      for (const item of splitInlineArrayItems(rest.slice(1, -1))) {
        const problem = nullSpellingProblem(item);
        if (problem !== undefined) {
          misspelling = { item, problem };
          break;
        }
      }
      if (misspelling) {
        errors.push(`${filePath}: line ${i + 1}: '${misspelling.item}' — ${misspelling.problem}`);
        data[key] = null;
        i += 1;
        continue;
      }
      data[key] = splitInlineArray(rest.slice(1, -1));
      i += 1;
      continue;
    }

    if (!rest) {
      // Probe past blank lines: a blank between the field line and its first
      // item would silently detach the list, so it is an explicit error
      // instead of a null value plus an orphaned-item complaint.
      let probe = i + 1;
      while (probe < lines.length && !(lines[probe] ?? "").trim()) probe += 1;
      const probeLine = lines[probe] ?? "";
      const probeIndent = probeLine.match(/^(\s*)/)?.[1]?.length ?? 0;
      const isBlockList = probeLine.trim().startsWith("- ") && probeIndent > 0;
      if (isBlockList && probe > i + 1) {
        errors.push(blankLineInListMessage(filePath, i + 2, key));
      }
      if (isBlockList) {
        const items: string[] = [];
        i = probe;
        while (i < lines.length) {
          const itemLine = lines[i] ?? "";
          const itemMatch = itemLine.match(/^\s*-\s*(.*)$/);
          if (!itemMatch) {
            if (!itemLine.trim()) {
              // A blank line followed by more items would silently truncate
              // the list; report it by name and resume at the continuation.
              let afterBlanks = i;
              while (afterBlanks < lines.length && !(lines[afterBlanks] ?? "").trim()) afterBlanks += 1;
              if ((lines[afterBlanks] ?? "").match(/^\s*-\s/)) {
                errors.push(blankLineInListMessage(filePath, i + 1, key));
                i = afterBlanks;
                continue;
              }
            }
            break;
          }
          const itemText = (itemMatch[1] ?? "").trim();
          if (findInlineComment(itemText) >= 0) {
            errors.push(`${filePath}: line ${i + 1}: ${INLINE_COMMENT_MESSAGE}`);
          } else {
            const itemNullProblem = nullSpellingProblem(itemText);
            if (itemNullProblem) {
              errors.push(`${filePath}: line ${i + 1}: '${itemText}' — ${itemNullProblem}`);
            } else {
              const parsed = parseYamlScalar(itemMatch[1] ?? "");
              if (typeof parsed === "string" && parsed.trim()) items.push(parsed.trim());
            }
          }
          i += 1;
        }
        data[key] = items;
        continue;
      }
      data[key] = null;
      i += 1;
      continue;
    }

    const nullProblem = nullSpellingProblem(rest);
    if (nullProblem) {
      errors.push(`${filePath}: line ${i + 1}: '${rest}' — ${nullProblem}`);
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

  if (errors.length > 0) {
    // The candidate name keys the invalid entry the discovery layer surfaces;
    // it is undefined when the file never produced a usable name.
    return { errors, ...(name && NAME_PATTERN.test(name) ? { name } : {}) };
  }
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
