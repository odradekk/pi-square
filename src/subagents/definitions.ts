import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPackagePath } from "../core/paths";

/** YAML-loaded subagent profile owned by user or project discovery. */
export interface SubagentDefinition {
  /** Unique catalog name used to select the subagent. */
  name: string;
  model?: string;
  effort?: string;
  /** Parent-facing routing summary shown in the subagent catalog. */
  description: string;
  system?: string;
  prompt?: string;
  /** Built-in tool allowlist; empty or omitted means all built-in tools. */
  tools?: string[];
  /** Extension tool allowlist passed into the child session. */
  extensionTools?: string[];
  /** Skill allowlist; empty or omitted means all discovered skills. */
  skills?: string[];
  /** Parent-agent catalog visibility; omitted definitions default to visible. */
  visible?: boolean;
  /** Discovery layer that supplied this definition. */
  source: "package" | "agent" | "project";
  filePath: string;
}

/** Discovered subagent definitions plus parser diagnostics for one cwd. */
export interface SubagentRegistry {
  definitions: SubagentDefinition[];
  errors: string[];
  projectDir: string | null;
}

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
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
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

function parseYamlScalar(value: string): string {
  return stripQuotes(value).replace(/\\n/g, "\n");
}

function parseYamlBoolean(value: unknown, fieldName: string, filePath: string): { value?: boolean; error?: string } {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "string") {
    return { error: `${filePath}: field '${fieldName}' must be true or false` };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return { value: true };
  if (normalized === "false") return { value: false };
  return { error: `${filePath}: field '${fieldName}' must be true or false` };
}

function parseYamlDefinition(text: string, filePath: string, source: SubagentDefinition["source"]): { definition?: SubagentDefinition; errors: string[] } {
  const errors: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const data: Record<string, string | string[] | boolean> = {};

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
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

    const key = match[1] === "Prompt" ? "prompt" : match[1];
    const rest = (match[2] ?? "").trim();

    if (rest === "|" || rest === ">") {
      const currentIndent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
      let probe = i + 1;
      let blockIndent = currentIndent + 1;
      while (probe < lines.length) {
        const candidate = lines[probe];
        if (!candidate.trim()) {
          probe += 1;
          continue;
        }
        blockIndent = candidate.match(/^(\s*)/)?.[1].length ?? 0;
        break;
      }
      if (blockIndent <= currentIndent) {
        data[key] = "";
        i += 1;
        continue;
      }
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const nextLine = lines[i];
        const indent = nextLine.match(/^(\s*)/)?.[1].length ?? 0;
        if (nextLine.trim() && indent < blockIndent) break;
        if (!nextLine.trim()) {
          blockLines.push("");
          i += 1;
          continue;
        }
        blockLines.push(nextLine.slice(blockIndent));
        i += 1;
      }
      data[key] = rest === ">" ? blockLines.join(" ").replace(/\s+/g, " ").trim() : blockLines.join("\n").trim();
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      const values = splitInlineArray(rest.slice(1, -1));
      data[key] = values;
      i += 1;
      continue;
    }

    if (!rest) {
      const nextIndent = (lines[i + 1]?.match(/^(\s*)/)?.[1].length ?? 0);
      const nextTrimmed = lines[i + 1]?.trim() ?? "";
      if (nextTrimmed.startsWith("- ") && nextIndent > 0) {
        const items: string[] = [];
        i += 1;
        while (i < lines.length) {
          const nextLine = lines[i];
          const itemMatch = nextLine.match(/^\s*-\s*(.*)$/);
          if (!itemMatch) break;
          items.push(parseYamlScalar(itemMatch[1] ?? ""));
          i += 1;
        }
        data[key] = items.filter(Boolean);
        continue;
      }
      data[key] = "";
      i += 1;
      continue;
    }

    data[key] = parseYamlScalar(rest);
    i += 1;
  }

  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name) errors.push(`${filePath}: missing required field 'name'`);
  if (!description) errors.push(`${filePath}: missing required field 'description'`);

  const tools = Array.isArray(data.tools) ? data.tools.map((item) => item.trim()).filter(Boolean) : undefined;
  const extensionTools = Array.isArray(data.extensionTools) ? data.extensionTools.map((item) => item.trim()).filter(Boolean) : undefined;
  const skills = Array.isArray(data.skills) ? data.skills.map((item) => item.trim()).filter(Boolean) : undefined;
  const parsedVisible = parseYamlBoolean(data.visible, "visible", filePath);
  if (parsedVisible.error) errors.push(parsedVisible.error);
  const visible = parsedVisible.value ?? true;

  if (errors.length > 0) return { errors };

  return {
    definition: {
      name,
      model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : undefined,
      effort: typeof data.effort === "string" && data.effort.trim() ? data.effort.trim() : undefined,
      description,
      system: typeof data.system === "string" && data.system.trim() ? data.system.trim() : undefined,
      prompt: typeof data.prompt === "string" && data.prompt.trim() ? data.prompt.trim() : undefined,
      tools,
      extensionTools,
      skills,
      visible,
      source,
      filePath,
    },
    errors,
  };
}

function loadDefinitionsFromDir(dir: string, source: SubagentDefinition["source"]): { definitions: SubagentDefinition[]; errors: string[] } {
  const definitions: SubagentDefinition[] = [];
  const errors: string[] = [];
  if (!isDirectory(dir)) return { definitions, errors };

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    errors.push(`${dir}: unable to read directory (${error instanceof Error ? error.message : String(error)})`);
    return { definitions, errors };
  }

  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const filePath = join(dir, entry);
    try {
      const parsed = parseYamlDefinition(readFileSync(filePath, "utf8"), filePath, source);
      definitions.push(...(parsed.definition ? [parsed.definition] : []));
      errors.push(...parsed.errors);
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { definitions, errors };
}

export function discoverSubagents(cwd: string): SubagentRegistry {
  const projectDir = findNearestProjectSubagentsDir(cwd);
  const layers = [
    loadDefinitionsFromDir(getPackagePath("resources", "subagents"), "package"),
    loadDefinitionsFromDir(join(getAgentDir(), "subagents"), "agent"),
    projectDir ? loadDefinitionsFromDir(projectDir, "project") : { definitions: [], errors: [] },
  ];

  const errors = layers.flatMap((layer) => layer.errors);
  const effective = new Map<string, SubagentDefinition>();

  for (const layer of layers) {
    const seenInLayer = new Map<string, string>();
    for (const definition of layer.definitions) {
      const previous = seenInLayer.get(definition.name);
      if (previous) {
        errors.push(`Duplicate subagent name '${definition.name}' in ${definition.filePath} and ${previous}. Names must be unique within a discovery layer.`);
        continue;
      }
      seenInLayer.set(definition.name, definition.filePath);
      effective.set(definition.name, definition);
    }
  }

  return {
    definitions: [...effective.values()].sort((a, b) => a.name.localeCompare(b.name)),
    errors,
    projectDir,
  };
}

export function filterVisibleSubagents(registry: SubagentRegistry): SubagentRegistry {
  return {
    ...registry,
    definitions: registry.definitions.filter((definition) => (definition.visible ?? true) !== false),
  };
}
