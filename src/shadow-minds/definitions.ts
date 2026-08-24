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

import { realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isWithinWorkspace } from "../core/paths";
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

interface ProjectShadowLocation {
  dir: string;
  projectRoot: string;
  error?: string;
}

function findNearestProjectShadowDir(cwd: string): ProjectShadowLocation | null {
  let current = resolve(cwd);
  for (;;) {
    const candidate = join(current, ".pi", "shadow-minds");
    try {
      if (statSync(candidate).isDirectory()) {
        const projectRoot = realpathSync(current);
        const dir = realpathSync(candidate);
        if (!isWithinWorkspace(projectRoot, dir)) {
          return { dir: candidate, projectRoot, error: `Shadow definitions in ${candidate} are ignored because the canonical directory is outside the project workspace` };
        }
        return { dir, projectRoot };
      }
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

function loadLayersFromDir(
  dir: string,
  scope: ShadowDefinitionScope,
  projectRoot?: string,
): LoadedLayer[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const layers: LoadedLayer[] = [];
  for (const name of entries) {
    if (!/\.md$/i.test(name)) continue;
    const requestedPath = join(dir, name);
    let filePath = requestedPath;
    try {
      if (projectRoot) {
        filePath = realpathSync(requestedPath);
        if (!isWithinWorkspace(projectRoot, filePath)) {
          layers.push({ scope, filePath, errors: [`${requestedPath}: canonical file is outside the project workspace`] });
          continue;
        }
      }
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
  const fields: ShadowDefinitionFields = { id };

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

interface ShadowScopeEntry {
  dir: string | null;
  scope: ShadowDefinitionScope;
  projectRoot?: string;
}

interface ShadowScopeCollection {
  scopes: ShadowScopeEntry[];
  diagnostics: DiagnosticMessage[];
}

function collectShadowScopes(cwd: string, projectTrusted: boolean): ShadowScopeCollection {
  const diagnostics: DiagnosticMessage[] = [];
  const scopes: ShadowScopeEntry[] = [
    { dir: getPackagePath("shadow-minds"), scope: "package" },
    { dir: getAgentPath("shadow-minds"), scope: "agent" },
  ];
  const projectLocation = findNearestProjectShadowDir(cwd);
  if (projectLocation?.error) {
    diagnostics.push(diagnostic("warning", projectLocation.error));
  } else if (projectLocation && !projectTrusted) {
    diagnostics.push(diagnostic(
      "warning",
      `Shadow definitions in ${projectLocation.dir} are ignored because the project is not trusted`,
    ));
  } else if (projectLocation) {
    scopes.push({ dir: projectLocation.dir, scope: "project", projectRoot: projectLocation.projectRoot });
  }
  return { scopes, diagnostics };
}

export function discoverShadowDefinitions(
  cwd: string,
  options: { projectTrusted: boolean },
): ShadowDefinitionRegistry {
  const collected = collectShadowScopes(cwd, options.projectTrusted);
  const diagnostics = collected.diagnostics;
  const scopes = collected.scopes;

  // Load every layer, grouped by effective ID and scope. A scope with more
  // than one file claiming an ID invalidates that ID and reports every source.
  const byId = new Map<string, { scope: ShadowDefinitionScope; layers: (LoadedLayer & { parsed: ParsedShadowDefinition })[] }[]>();
  const invalid: InvalidShadowDefinition[] = [];
  const erroredById = new Map<string, InvalidShadowDefinition>();
  for (const { dir, scope, projectRoot } of scopes) {
    if (!dir) continue;
    for (const layer of loadLayersFromDir(dir, scope, projectRoot)) {
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

/**
 * Composes one candidate layer into the current discovery state and merges
 * the effective definition for its ID (#154). The candidate replaces every
 * same-scope layer for the ID at `filePath`; layers from other scopes and
 * same-scope files claiming the same ID through other file names keep their
 * discovery semantics — including fail-closed treatment of broken layers and
 * same-scope duplicates.
 */
export function previewShadowDefinition(
  cwd: string,
  options: {
    projectTrusted: boolean;
    scope: "agent" | "project";
    filePath: string;
    content: string;
  },
): { definition?: EffectiveShadowDefinition; errors: string[] } {
  const parsed = parseShadowDefinitionFile(options.filePath, options.content);
  if (!parsed.definition) return { errors: parsed.errors };
  const id = stemOf(options.filePath);
  const { scopes } = collectShadowScopes(cwd, options.projectTrusted);
  const errors: string[] = [];
  const buckets: { scope: ShadowDefinitionScope; layers: (LoadedLayer & { parsed: ParsedShadowDefinition })[] }[] = [];
  for (const { dir, scope, projectRoot } of scopes) {
    if (!dir) continue;
    const claiming = loadLayersFromDir(dir, scope, projectRoot).filter(
      (layer) => layer.filePath !== options.filePath && stemOf(layer.filePath) === id,
    );
    if (scope !== options.scope) {
      for (const layer of claiming) {
        if (!layer.parsed) {
          errors.push(...layer.errors);
          continue;
        }
        buckets.push({ scope, layers: [layer as LoadedLayer & { parsed: ParsedShadowDefinition }] });
      }
      continue;
    }
    const others = claiming.filter((layer) => layer.parsed);
    if (claiming.length !== others.length) {
      // A broken same-scope file keeps the ID failed closed until repaired.
      for (const layer of claiming) {
        if (!layer.parsed) errors.push(...layer.errors);
      }
    }
    const bucket: typeof buckets[number] = {
      scope,
      layers: others.map((layer) => layer as LoadedLayer & { parsed: ParsedShadowDefinition }),
    };
    buckets.push(bucket);
  }
  const candidateBucket = buckets.find((bucket) => bucket.scope === options.scope);
  const candidate: LoadedLayer & { parsed: ParsedShadowDefinition } = {
    scope: options.scope,
    filePath: options.filePath,
    parsed: parsed.definition,
    errors: [],
  };
  if (candidateBucket) candidateBucket.layers.push(candidate);
  else buckets.push({ scope: options.scope, layers: [candidate] });

  const duplicates = buckets.filter((bucket) => bucket.layers.length > 1);
  if (duplicates.length > 0) {
    const sources = duplicates.flatMap((bucket) => bucket.layers.map((layer) => layer.filePath));
    errors.push(`${id}: duplicate definition files claim the same ID in one scope (${sources.join(", ")})`);
  }
  if (errors.length > 0) return { errors };

  const ordered = (["package", "agent", "project"] as const)
    .flatMap((scope) => buckets.find((bucket) => bucket.scope === scope)?.layers ?? []);
  return mergeLayers(id, ordered);
}

/**
 * The nearest discovered project Shadow location, for write targeting (#154).
 * Writes follow discovery: an existing ancestor `.pi/shadow-minds` is the
 * canonical overlay target for the current workspace.
 */
export function shadowProjectScopeLocation(cwd: string): ProjectShadowLocation | null {
  return findNearestProjectShadowDir(cwd);
}

/** Canonical scope directory for definition overlays; #154 writes here. */
export function shadowDefinitionScopeDir(scope: "agent" | "project", cwd: string): string {
  if (scope === "agent") return getAgentPath("shadow-minds");
  const project = findNearestProjectShadowDir(cwd);
  if (project?.error) throw new Error(project.error);
  return project?.dir ?? join(resolve(cwd), ".pi", "shadow-minds");
}
