/**
 * Layered Shadow definition discovery and merge
 * (odradekk/pi-square#149, slice #153).
 *
 * Definitions are Markdown files discovered in three scopes: read-only package
 * templates shipped with pi-square, agent overlays under the Pi agent
 * directory, and trusted-project overlays under `.pi/shadow-minds` found by
 * walking up from the workspace. Layers merge by stable ID — package → agent
 * → trusted project — with per-field provenance (source scope, file path,
 * content hash), trigger-instruction key merge with explicit-null clearing,
 * atomic output-schema replacement, and body replacement versus inheritance.
 *
 * Failure is scoped per ID: an invalid or same-scope-conflicting definition is
 * diagnosed and excluded while every other valid definition stays inspectable.
 * Untrusted project definitions are diagnosed and excluded entirely; package
 * and agent definitions remain available in the same registry.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { diagnostic, type DiagnosticMessage } from "../core/diagnostics";
import { getAgentPath, getPackagePath } from "../core/paths";
import {
  DEFAULT_OUTPUT_SCHEMA,
  parseShadowDefinitionFile,
  type ParsedShadowDefinition,
  type ShadowDefinitionFields,
  type ShadowDelivery,
  type ShadowOutputSchema,
  type ShadowThinkingLevel,
  type ShadowTrigger,
} from "./parser";

export type ShadowDefinitionScope = "package" | "agent" | "project";

/** Tool names an omitted `tools` field resolves to; catalog construction is #156. */
export const DEFAULT_SHADOW_LOCAL_TOOLS: readonly string[] = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  "codegraph",
  "pdf_search",
]);

export interface ShadowDefinitionSource {
  scope: ShadowDefinitionScope;
  filePath: string;
  contentHash: string;
}

export interface ShadowDefinitionLayer extends ShadowDefinitionSource {
  fields: ShadowDefinitionFields;
}

export interface EffectiveShadowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  hidden: boolean;
  priority: number;
  triggers: ShadowTrigger[];
  triggerInstructions: Partial<Record<ShadowTrigger, string>>;
  delivery: ShadowDelivery;
  completionGate: boolean;
  parentModels?: string[];
  model?: string;
  thinking?: ShadowThinkingLevel;
  timeoutSeconds?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  tools?: string[];
  requiredTools: string[];
  debug: boolean;
  outputSchema: ShadowOutputSchema;
  body: string;
  /** Field name (or `triggerInstructions.<key>`) → highest-precedence source. */
  fieldSources: Record<string, ShadowDefinitionSource>;
  /** Every layer that contributes to this ID, lowest precedence first. */
  layers: ShadowDefinitionLayer[];
}

export interface InvalidShadowDefinition {
  id: string;
  /** Every file that claimed the ID; more than one means a same-scope conflict. */
  sources: string[];
  errors: string[];
}

export interface ShadowDefinitionRegistry {
  definitions: EffectiveShadowDefinition[];
  invalid: InvalidShadowDefinition[];
  diagnostics: DiagnosticMessage[];
}

function findNearestProjectShadowDir(cwd: string): string | null {
  let current = resolve(cwd);
  for (;;) {
    const candidate = join(current, ".pi", "shadow-minds");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // absent — keep walking
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface LoadedLayer {
  scope: ShadowDefinitionScope;
  filePath: string;
  parsed?: ParsedShadowDefinition;
  errors: string[];
}

function loadLayersFromDir(dir: string, scope: ShadowDefinitionScope): LoadedLayer[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const layers: LoadedLayer[] = [];
  for (const name of entries) {
    if (!/\.md$/i.test(name)) continue;
    const filePath = join(dir, name);
    try {
      if (!statSync(filePath).isFile()) continue;
      const content = readFileSync(filePath, "utf8");
      const result = parseShadowDefinitionFile(filePath, content);
      layers.push({ scope, filePath, parsed: result.definition, errors: result.errors });
    } catch (error) {
      layers.push({
        scope,
        filePath,
        errors: [`${filePath}: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }
  return layers;
}

function stemOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.md$/i, "");
}

function sourceOf(layer: LoadedLayer & { parsed: ParsedShadowDefinition }): ShadowDefinitionSource {
  return { scope: layer.scope, filePath: layer.filePath, contentHash: layer.parsed.contentHash };
}

/**
 * Merges the layers of one ID into an effective definition. Returns undefined
 * (with reasons) when the effective definition is invalid — for example an
 * explicitly empty effective body, a completion gate without a completion
 * subscription, or a required tool outside the final tool set.
 */
function mergeLayers(
  id: string,
  layers: (LoadedLayer & { parsed: ParsedShadowDefinition })[],
): { definition?: EffectiveShadowDefinition; errors: string[] } {
  const errors: string[] = [];
  const fieldSources: Record<string, ShadowDefinitionSource> = {};
  const fields: ShadowDefinitionFields = { id, name: "" };

  const scalarKeys: (keyof ShadowDefinitionFields)[] = [
    "name",
    "enabled",
    "hidden",
    "priority",
    "triggers",
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
  ];
  for (const key of scalarKeys) {
    for (const layer of layers) {
      const value = layer.parsed.fields[key];
      if (value !== undefined) {
        (fields as unknown as Record<string, unknown>)[key] = value;
        fieldSources[key] = sourceOf(layer);
      }
    }
  }

  // Trigger instructions merge by key; an explicit null in a higher layer
  // removes that trigger's instruction entirely.
  const instructions: Partial<Record<ShadowTrigger, string>> = {};
  for (const layer of layers) {
    const map = layer.parsed.fields.triggerInstructions;
    if (map === undefined) continue;
    for (const key of Object.keys(map) as ShadowTrigger[]) {
      const value = map[key];
      if (value === null) {
        delete instructions[key];
      } else {
        instructions[key] = value;
      }
      fieldSources[`triggerInstructions.${key}`] = sourceOf(layer);
    }
  }

  // Output schema is atomic: the highest layer that mentions it wins, null
  // restores the default schema, and no layer mentioning it keeps the default.
  let outputSchema: ShadowOutputSchema = DEFAULT_OUTPUT_SCHEMA;
  for (const layer of layers) {
    const value = layer.parsed.fields.outputSchema;
    if (value === undefined) continue;
    if (value === null) {
      outputSchema = DEFAULT_OUTPUT_SCHEMA;
    } else {
      outputSchema = value;
    }
    fieldSources.outputSchema = sourceOf(layer);
  }

  // The body is atomic: a provided (non-empty) body replaces the lower layer
  // and an omitted body inherits; clearing a body is not a supported overlay
  // operation, so the effective body is empty exactly when no layer provides
  // one, and that case invalidates the Shadow below.
  let body = "";
  for (const layer of layers) {
    const value = layer.parsed.fields.body ?? "";
    if (value.trim() !== "") {
      body = value;
      fieldSources.body = sourceOf(layer);
    }
  }

  const effective: EffectiveShadowDefinition = {
    id,
    name: fields.name ?? "",
    enabled: fields.enabled ?? false,
    hidden: fields.hidden ?? false,
    priority: fields.priority ?? 0,
    triggers: fields.triggers ?? [],
    triggerInstructions: instructions,
    delivery: fields.delivery ?? "steer",
    completionGate: fields.completionGate ?? false,
    ...(fields.parentModels !== undefined ? { parentModels: fields.parentModels } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.thinking !== undefined ? { thinking: fields.thinking } : {}),
    ...(fields.timeoutSeconds !== undefined ? { timeoutSeconds: fields.timeoutSeconds } : {}),
    ...(fields.maxTurns !== undefined ? { maxTurns: fields.maxTurns } : {}),
    ...(fields.maxToolCalls !== undefined ? { maxToolCalls: fields.maxToolCalls } : {}),
    ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
    requiredTools: fields.requiredTools ?? [],
    debug: fields.debug ?? false,
    outputSchema,
    body,
    fieldSources,
    layers: layers.map((layer) => ({
      scope: layer.scope,
      filePath: layer.filePath,
      contentHash: layer.parsed.contentHash,
      fields: layer.parsed.fields,
    })),
  };

  if (!effective.name) errors.push(`${id}: effective name is missing`);
  if (body.trim() === "") errors.push(`${id}: effective body is explicitly empty`);
  if (effective.completionGate && !effective.triggers.includes("completion")) {
    errors.push(`${id}: completionGate requires a completion trigger subscription`);
  }
  const finalTools = new Set(effective.tools ?? DEFAULT_SHADOW_LOCAL_TOOLS);
  for (const required of effective.requiredTools) {
    if (!finalTools.has(required)) {
      errors.push(`${id}: required tool '${required}' is outside the final tool set`);
    }
  }
  if (errors.length > 0) return { errors };
  return { definition: effective, errors: [] };
}

export function discoverShadowDefinitions(
  cwd: string,
  options: { projectTrusted: boolean },
): ShadowDefinitionRegistry {
  const diagnostics: DiagnosticMessage[] = [];
  const scopes: { dir: string | null; scope: ShadowDefinitionScope }[] = [
    { dir: getPackagePath("shadow-minds"), scope: "package" },
    { dir: getAgentPath("shadow-minds"), scope: "agent" },
  ];
  const projectDir = findNearestProjectShadowDir(cwd);
  if (projectDir && !options.projectTrusted) {
    diagnostics.push(diagnostic(
      "warning",
      `Shadow definitions in ${projectDir} are ignored because the project is not trusted`,
    ));
  } else if (projectDir) {
    scopes.push({ dir: projectDir, scope: "project" });
  }

  // Load every layer, grouped by effective ID and scope. A scope with more
  // than one file claiming an ID invalidates that ID and reports every source.
  const byId = new Map<string, { scope: ShadowDefinitionScope; layers: (LoadedLayer & { parsed: ParsedShadowDefinition })[] }[]>();
  const invalid: InvalidShadowDefinition[] = [];
  const erroredById = new Map<string, InvalidShadowDefinition>();
  for (const { dir, scope } of scopes) {
    if (!dir) continue;
    for (const layer of loadLayersFromDir(dir, scope)) {
      const id = stemOf(layer.filePath);
      if (!layer.parsed) {
        const existing = erroredById.get(id);
        if (existing) {
          existing.sources.push(layer.filePath);
          existing.errors.push(...layer.errors);
        } else {
          erroredById.set(id, { id, sources: [layer.filePath], errors: [...layer.errors] });
        }
        continue;
      }
      const buckets = byId.get(id) ?? [];
      const bucket = buckets.find((entry) => entry.scope === scope);
      if (bucket) {
        bucket.layers.push(layer as LoadedLayer & { parsed: ParsedShadowDefinition });
      } else {
        buckets.push({ scope, layers: [layer as LoadedLayer & { parsed: ParsedShadowDefinition }] });
      }
      byId.set(id, buckets);
    }
  }

  for (const [id, entry] of erroredById) {
    invalid.push(entry);
    for (const message of entry.errors) {
      diagnostics.push(diagnostic("warning", `Shadow definition '${id}' is excluded: ${message}`));
    }
  }

  const definitions: EffectiveShadowDefinition[] = [];
  for (const [id, buckets] of byId) {
    // Fail closed per ID: a layer that failed to parse invalidates the whole
    // effective ID, so a broken edit can never silently continue the behavior
    // of the surviving lower layers (epic story 22).
    if (erroredById.has(id)) continue;
    const conflictingScopes = buckets.filter((bucket) => bucket.layers.length > 1);
    if (conflictingScopes.length > 0) {
      const sources = conflictingScopes.flatMap((bucket) => bucket.layers.map((layer) => layer.filePath));
      invalid.push({
        id,
        sources,
        errors: [`${id}: duplicate definition files claim the same ID in one scope`],
      });
      diagnostics.push(diagnostic(
        "warning",
        `Shadow definition '${id}' is excluded: duplicate files ${sources.join(", ")} claim the same ID`,
      ));
      continue;
    }
    const ordered = ["package", "agent", "project"] as const;
    const layers = ordered
      .flatMap((scope) => buckets.find((bucket) => bucket.scope === scope)?.layers ?? []);
    const merged = mergeLayers(id, layers);
    if (merged.definition) {
      definitions.push(merged.definition);
    } else {
      invalid.push({ id, sources: layers.map((layer) => layer.filePath), errors: merged.errors });
      for (const message of merged.errors) {
        diagnostics.push(diagnostic("warning", `Shadow definition '${id}' is excluded: ${message}`));
      }
    }
  }

  definitions.sort((a, b) => a.id.localeCompare(b.id));
  invalid.sort((a, b) => a.id.localeCompare(b.id));
  return { definitions, invalid, diagnostics };
}

/** Canonical scope directory for definition overlays; #154 writes here. */
export function shadowDefinitionScopeDir(scope: "agent" | "project", cwd: string): string {
  if (scope === "agent") return getAgentPath("shadow-minds");
  return findNearestProjectShadowDir(cwd) ?? join(resolve(cwd), ".pi", "shadow-minds");
}
