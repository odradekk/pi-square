/**
 * Shadow run-model resolution (odradekk/pi-square#156).
 *
 * Pure helpers for the three model axes of one activation: explicit run-model
 * resolution (an explicit spec fails rather than silently switching), exact
 * parent-model filtering (`provider/model-id` or `*`, never patterns), and the
 * ordered thinking-level fallback (Shadow value, then activating parent
 * value). Per-model support is enforced natively by Pi 0.84.2, which clamps
 * unsupported levels, so the fallback only validates the level enum; the
 * definition parser rejects invalid Shadow values at its boundary.
 */

import { formatModel } from "../subagents/child-session-executor";
import { SHADOW_THINKING_LEVELS, type ShadowThinkingLevel } from "./parser";

/** Minimal command-context surface these resolvers consume. */
export interface ShadowResolveContext {
  model?: unknown;
  modelRegistry?: { find?: (provider: string, id: string) => unknown };
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
  const model = ctx.modelRegistry?.find?.(trimmed.slice(0, slash).trim(), trimmed.slice(slash + 1).trim());
  if (!model) return { error: `Unknown Shadow model '${trimmed}'.` };
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
 * Ordered thinking-level fallback: the Shadow value wins, then the activating
 * parent value; the first enum-valid value is used and unsupported levels are
 * dropped rather than passed through. Pi 0.84.2 clamps a supported-but-
 * unavailable level for the selected model natively.
 */
export function resolveShadowThinkingLevel(
  shadowLevel: ShadowThinkingLevel | undefined,
  parentLevel: string | undefined,
): ShadowThinkingLevel | undefined {
  const candidates = [shadowLevel, parentLevel];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && VALID_LEVELS.has(candidate)) {
      return candidate as ShadowThinkingLevel;
    }
  }
  return undefined;
}
