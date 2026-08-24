/**
 * Shadow run-model resolution (odradekk/pi-square#156).
 *
 * Pure helpers for the three model axes of one activation: explicit run-model
 * resolution with configured-auth verification, exact parent-model filtering
 * (`provider/model-id` or `*`, never patterns), and ordered exact-support
 * thinking selection (Shadow value, effective configuration default, then the
 * activating parent value).
 */

import { formatModel } from "../subagents/child-session-executor";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { SHADOW_THINKING_LEVELS, type ShadowThinkingLevel } from "./parser";

/** Minimal command-context surface these resolvers consume. */
export interface ShadowResolveContext {
  model?: unknown;
  modelRegistry?: {
    find?: (provider: string, id: string) => any;
    hasConfiguredAuth?: (model: any) => boolean;
  };
}

export interface ShadowModelResolution {
  /** Resolved model object handed to the child session. */
  model?: unknown;
  /** `provider/id` label for records when the object does not report one. */
  label?: string;
  /** Explicit-model failure; the run never starts and never falls back. */
  error?: string;
}

/**
 * Resolves the Shadow run model: an explicit `provider/model` spec resolves
 * through the registry (cross-provider by default and observable through the
 * label), while an omitted spec inherits the activating parent model.
 */
export function resolveShadowModel(spec: string | undefined, ctx: ShadowResolveContext): ShadowModelResolution {
  const trimmed = spec?.trim();
  if (!trimmed) {
    if (!ctx.model) return { error: "No parent model is selected for this Shadow run." };
    const label = formatModel(ctx.model);
    return { model: ctx.model, ...(label ? { label } : {}) };
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: `Invalid model '${trimmed}'. Expected provider/model.` };
  }
  const registry = ctx.modelRegistry;
  const model = registry?.find?.(trimmed.slice(0, slash).trim(), trimmed.slice(slash + 1).trim());
  if (!model) return { error: `Unknown Shadow model '${trimmed}'.` };
  if (typeof registry?.hasConfiguredAuth !== "function" || !registry.hasConfiguredAuth(model)) {
    return { error: `Shadow model '${trimmed}' has no configured authentication.` };
  }
  return { model, label: formatModel(model) ?? trimmed };
}

/**
 * Exact parent-model filter: a missing or empty filter matches every parent
 * model; otherwise the parent's `provider/model-id` label must equal one
 * entry exactly or the filter must contain `*`. There are no patterns or
 * model-family matching, and an unknown parent model never matches.
 */
export function matchesParentModelFilter(filters: readonly string[] | undefined, parentLabel: string | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  if (!parentLabel) return false;
  return filters.includes("*") || filters.includes(parentLabel);
}

const VALID_LEVELS: ReadonlySet<string> = new Set(SHADOW_THINKING_LEVELS);

/**
 * Ordered thinking-level fallback: choose the first exact candidate supported
 * by the selected model. If candidates were supplied but none are supported,
 * fail the run instead of allowing Pi's ordinary nearest-level clamp to change
 * the reviewed request. With no candidates, omit the override and use Pi's
 * model default.
 */
export function resolveShadowThinkingLevel(
  shadowLevel: ShadowThinkingLevel | undefined,
  configLevel: string | undefined,
  parentLevel: string | undefined,
  model: unknown,
): { level?: ShadowThinkingLevel; error?: string } {
  const candidates = [shadowLevel, configLevel, parentLevel]
    .filter((candidate): candidate is string => typeof candidate === "string" && VALID_LEVELS.has(candidate));
  if (candidates.length === 0) return {};
  let supported: readonly string[];
  try {
    supported = getSupportedThinkingLevels(model as any);
  } catch {
    return { error: "The selected Shadow model does not expose a valid thinking-level capability map." };
  }
  const level = candidates.find((candidate) => supported.includes(candidate));
  if (level) return { level: level as ShadowThinkingLevel };
  return {
    error: `The selected Shadow model does not support any requested thinking level (${candidates.join(", ")}).`,
  };
}
