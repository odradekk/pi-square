/**
 * Effort (thinking-level) values a subagent definition may request. Kept in a
 * small standalone module so the configuration guide can render the exact
 * runtime-validated list without importing the session module's dependency
 * graph (#334). Validation itself happens at child-run startup.
 */
export const ALLOWED_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type AllowedEffort = (typeof ALLOWED_EFFORTS)[number];
