/**
 * Shadow-safe tool catalog and envelope resolution (odradekk/pi-square#156).
 *
 * Interprets a definition's `tools` and `requiredTools` against the approved
 * strictly read-only catalog: omitted tools select the default local evidence
 * set, an explicit empty list stays the no-tool trial, and required tools must
 * be a subset of the requested set. Pi built-ins are validated and hashed from
 * Pi 0.84.2 public factories — never from parent registry overrides — and
 * extension tools come only from the child-safe read-only factories. The final
 * envelope is canonically ordered and carries a stable hash of every
 * model-visible tool name, description, and parameter schema so prompt/tool
 * cache cohorts stay comparable across runs; `submit_shadow_result` is built in
 * and always hashes last.
 */

import { createHash } from "node:crypto";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createShadowSafeExtensionTools, SHADOW_SAFE_EXTENSION_TOOLS } from "../tool-catalog";
import { SHADOW_DEFAULT_TOOLS } from "./parser";
import { canonicalSchemaJson } from "./prompt";
import {
  SUBMIT_SHADOW_RESULT_DESCRIPTION,
  SUBMIT_SHADOW_RESULT_PARAMETERS,
  SUBMIT_SHADOW_RESULT_TOOL,
} from "./result";

/** Package-defined canonical order of the local evidence built-ins. */
export const SHADOW_BUILTIN_BASE_ORDER = ["read", "grep", "find", "ls"] as const;

/** Extension catalog order for Shadow-safe evidence tools. */
export const SHADOW_EXTENSION_BASE_ORDER = SHADOW_SAFE_EXTENSION_TOOLS;

/** Every tool a Shadow may investigate with, in canonical order. */
export const SHADOW_SAFE_TOOLS = [...SHADOW_BUILTIN_BASE_ORDER, ...SHADOW_EXTENSION_BASE_ORDER] as const;

export { SHADOW_DEFAULT_TOOLS };

/** One resolved, canonically ordered evidence-tool envelope. */
export interface ShadowToolEnvelope {
  /** Evidence tool names in canonical order, built-ins and extensions; the submit tool is excluded. */
  toolNames: string[];
  /** Extension tool definitions in canonical order, for `customTools`. */
  customTools: ToolDefinition<any, any, any>[];
  /** Stable hash of the final model-visible envelope, submit tool included. */
  schemaHash: string;
  /** Bounded warnings for requested tools that are unavailable. */
  warnings: string[];
}

export interface ResolveShadowToolsInput {
  /** Definition `tools`; undefined selects the default local evidence set. */
  tools?: string[];
  requiredTools?: string[];
  cwd: string;
}

export type ShadowToolResolution =
  | { ok: true; envelope: ShadowToolEnvelope }
  | { ok: false; error: string };

type BuiltinFactory = (cwd: string) => ToolDefinition<any, any, any>;

const BUILTIN_FACTORIES: Readonly<Record<string, BuiltinFactory>> = Object.freeze({
  read: (cwd) => createReadToolDefinition(cwd),
  grep: (cwd) => createGrepToolDefinition(cwd),
  find: (cwd) => createFindToolDefinition(cwd),
  ls: (cwd) => createLsToolDefinition(cwd),
});

const HASH_CHARS = 16;
const WARNINGS_MAX = 16;

/** Hashes the canonical model-visible name, description, and parameter schema list. */
function hashEnvelope(tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>): string {
  return createHash("sha256")
    .update(canonicalSchemaJson(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))))
    .digest("hex")
    .slice(0, HASH_CHARS);
}

/**
 * Resolves one definition's tool request into the canonical Shadow envelope.
 * Pure and registry-free: resolution consults only the Shadow-safe catalog,
 * so parent registry overrides can never be inherited by name. Missing
 * optional tools drop with a warning; a required tool that is not requested,
 * or that the catalog cannot supply, fails before the run ever prompts.
 */
export function resolveShadowTools(input: ResolveShadowToolsInput): ShadowToolResolution {
  const requested = input.tools === undefined ? [...SHADOW_DEFAULT_TOOLS] : [...new Set(input.tools)];
  const required = input.requiredTools ?? [];

  const notRequested = required.filter((name) => !requested.includes(name));
  if (notRequested.length > 0) {
    return {
      ok: false,
      error: `requiredTools must be a subset of tools; missing from tools: ${notRequested.join(", ")}.`,
    };
  }

  const warnings: string[] = [];
  const excluded = new Set<string>();
  const builtins: Array<{ name: string; factory: BuiltinFactory }> = [];
  const extensionNames: string[] = [];
  const safe = new Set<string>(SHADOW_SAFE_TOOLS);
  for (const name of requested) {
    if (!safe.has(name)) {
      warnings.push(`Tool '${name}' is not in the Shadow-safe catalog and was excluded.`);
      excluded.add(name);
      continue;
    }
    const factory = BUILTIN_FACTORIES[name] as BuiltinFactory | undefined;
    if (factory) builtins.push({ name, factory });
    else extensionNames.push(name);
  }

  const unavailableRequired = required.filter((name) => excluded.has(name));
  if (unavailableRequired.length > 0) {
    return {
      ok: false,
      error: `Required Shadow tools are unavailable: ${unavailableRequired.join(", ")}.`,
    };
  }
  const definitions = createShadowSafeExtensionTools(extensionNames);
  const extensionOrder: readonly string[] = SHADOW_EXTENSION_BASE_ORDER;
  const customTools = [...definitions].sort(
    (left, right) => extensionOrder.indexOf(left.name) - extensionOrder.indexOf(right.name),
  );

  const builtinOrder: readonly string[] = SHADOW_BUILTIN_BASE_ORDER;
  const orderedBuiltins = [...builtins].sort(
    (left, right) => builtinOrder.indexOf(left.name) - builtinOrder.indexOf(right.name),
  );
  const builtinSchemas = orderedBuiltins.map((entry) => {
    const definition = entry.factory(input.cwd);
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    };
  });

  const hashInput = [
    ...builtinSchemas,
    ...customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    {
      name: SUBMIT_SHADOW_RESULT_TOOL,
      description: SUBMIT_SHADOW_RESULT_DESCRIPTION,
      parameters: SUBMIT_SHADOW_RESULT_PARAMETERS,
    },
  ];

  return {
    ok: true,
    envelope: {
      toolNames: [...builtinSchemas.map((entry) => entry.name), ...customTools.map((tool) => tool.name)],
      customTools,
      schemaHash: hashEnvelope(hashInput),
      warnings: warnings.slice(0, WARNINGS_MAX),
    },
  };
}
