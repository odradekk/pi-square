/**
 * Effective display policy resolution.
 *
 * Applies overlays in the fixed precedence order:
 *   package defaults → agent defaults → agent family → agent tool
 *                     → project defaults → project family → project tool.
 *
 * Project scope wins over every agent-scope specificity, matching the
 * existing config layer precedence. Each effective policy leaf carries
 * provenance: `"default"` or the config file path that last set it.
 */

import { DISPLAY_CATALOG } from "./catalog";
import {
  DEFAULT_DISPLAY_POLICY,
  DISPLAY_POLICY_FIELDS,
  type DisplayFamily,
  type DisplayMotion,
  type DisplayPolicy,
  type DisplayPolicyField,
  type DisplayPolicyOverlay,
  type DisplayPolicyProvenance,
  type EffectiveDisplayPolicy,
} from "./types";
import type { DisplayEffectiveConfig, PiSquareConfig } from "../core/config";

export interface ResolvedDisplay {
  readonly motion: DisplayMotion;
  readonly motionProvenance: DisplayPolicyProvenance;
  readonly policies: ReadonlyMap<string, EffectiveDisplayPolicy>;
}

export function resolveDisplayPolicies(config: PiSquareConfig): ResolvedDisplay {
  const policies = new Map<string, EffectiveDisplayPolicy>();
  for (const entry of DISPLAY_CATALOG) {
    policies.set(entry.name, resolveDisplayPolicyForTool(entry.name, entry.family, config.display));
  }
  const motionProvenance = config.display.project?.config.motion !== undefined
    ? config.display.project.path
    : config.display.agent?.config.motion !== undefined
      ? config.display.agent.path
      : "default";
  return Object.freeze({ motion: config.display.motion, motionProvenance, policies });
}

export function resolveDisplayPolicyForTool(
  toolName: string,
  family: DisplayFamily,
  display: DisplayEffectiveConfig,
): EffectiveDisplayPolicy {
  const policy: DisplayPolicy = { ...DEFAULT_DISPLAY_POLICY };
  const provenance = createDefaultProvenance();

  for (const { source, overlay } of buildOverlaySteps(toolName, family, display)) {
    applyOverlay(policy, provenance, overlay, source);
  }

  return Object.freeze({ policy: Object.freeze(policy), provenance: Object.freeze(provenance) });
}

function createDefaultProvenance(): Record<DisplayPolicyField, DisplayPolicyProvenance> {
  const result = {} as Record<DisplayPolicyField, DisplayPolicyProvenance>;
  for (const field of DISPLAY_POLICY_FIELDS) {
    result[field] = "default";
  }
  return result;
}

interface OverlayStep {
  readonly source: string;
  readonly overlay: DisplayPolicyOverlay | undefined;
}

function buildOverlaySteps(
  toolName: string,
  family: DisplayFamily,
  display: DisplayEffectiveConfig,
): OverlayStep[] {
  const steps: OverlayStep[] = [];

  // Agent scope: defaults → family → tool
  if (display.agent) {
    const { path, config } = display.agent;
    steps.push({ source: path, overlay: config.defaults });
    steps.push({ source: path, overlay: config.families?.[family] });
    steps.push({ source: path, overlay: config.tools?.[toolName] });
  }

  // Project scope: defaults → family → tool
  if (display.project) {
    const { path, config } = display.project;
    steps.push({ source: path, overlay: config.defaults });
    steps.push({ source: path, overlay: config.families?.[family] });
    steps.push({ source: path, overlay: config.tools?.[toolName] });
  }

  return steps;
}

function applyOverlay(
  policy: DisplayPolicy,
  provenance: Record<DisplayPolicyField, DisplayPolicyProvenance>,
  overlay: DisplayPolicyOverlay | undefined,
  source: string,
): void {
  if (!overlay) return;
  for (const field of DISPLAY_POLICY_FIELDS) {
    const value = overlay[field];
    if (value !== undefined) {
      (policy as Record<DisplayPolicyField, unknown>)[field] = value;
      provenance[field] = source;
    }
  }
}
