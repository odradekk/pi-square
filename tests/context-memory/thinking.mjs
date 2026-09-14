import { createHash } from "node:crypto";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export const REQUESTED_THINKING_LEVEL = "low";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Safe reproducibility pins: provider-specific mapping values remain hash-only. */
export function thinkingConfiguration(model) {
  return {
    requested: REQUESTED_THINKING_LEVEL,
    supported: getSupportedThinkingLevels(model),
    effective: clampThinkingLevel(model, REQUESTED_THINKING_LEVEL),
    mappingSha256: createHash("sha256").update(JSON.stringify(LEVELS.map((level) =>
      [level, model.thinkingLevelMap?.[level] ?? null, Object.hasOwn(model.thinkingLevelMap ?? {}, level)]))).digest("hex"),
  };
}

export class ThinkingConfigurationError extends Error {
  constructor(configuration) {
    super(`qualification requested thinking ${configuration.requested}, but Pi selects ${configuration.effective}; supported: ${configuration.supported.join(", ")}. No model request was started by this check.`);
    this.name = "ThinkingConfigurationError";
    this.configuration = configuration;
  }
}

/** Validate every lane before starting any paid queue; never silently substitute a level. */
export function requireThinkingConfiguration(model) {
  const configuration = thinkingConfiguration(model);
  if (configuration.effective !== configuration.requested) throw new ThinkingConfigurationError(configuration);
  return configuration;
}

/** The SDK may clamp again during creation; check its actual state before prompting. */
export function requireSessionThinking(session, configuration) {
  if (session.thinkingLevel !== configuration.requested) {
    throw new ThinkingConfigurationError({ ...configuration,
      effective: LEVELS.includes(session.thinkingLevel) ? session.thinkingLevel : "unavailable" });
  }
}
