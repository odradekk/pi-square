import { VERSION } from "@earendil-works/pi-coding-agent";

/**
 * Exact Pi compatibility gate for Context Memory (odradekk/pi-square#215, #216).
 *
 * V1 supports only the pinned Pi contract. Activation requires the exact
 * supported host version plus the presence of the required public session,
 * compaction, context, tool, and active-tool interfaces. An unsupported host
 * leaves Pi native compaction and the active tool set unchanged.
 */

/** The single Pi version this feature is qualified against. */
export const SUPPORTED_PI_VERSION = "0.84.2";

export type HostSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: "host-version" | "host-interfaces" };

/** Resolve the running host Pi version through its public VERSION export. */
export function resolveHostVersion(): string {
  return typeof VERSION === "string" ? VERSION : String(VERSION ?? "unknown");
}

/**
 * The registration-time interface set: the extension API surface the feature
 * itself needs (tool registration and owned active-tool synchronization).
 */
export function apiInterfacesPresent(pi: {
  registerTool?: unknown;
  getAllTools?: unknown;
  getActiveTools?: unknown;
  setActiveTools?: unknown;
}): boolean {
  return typeof pi.registerTool === "function"
    && typeof pi.getAllTools === "function"
    && typeof pi.getActiveTools === "function"
    && typeof pi.setActiveTools === "function";
}

/**
 * The session-time interface set: the public session, compaction, and context
 * surfaces later slices consume. Their absence makes the host unsupported
 * without touching Pi behavior.
 */
export function contextInterfacesPresent(ctx: {
  sessionManager?: unknown;
  compact?: unknown;
  getContextUsage?: unknown;
  getSystemPrompt?: unknown;
}): boolean {
  return Boolean(ctx.sessionManager)
    && typeof ctx.compact === "function"
    && typeof ctx.getContextUsage === "function"
    && typeof ctx.getSystemPrompt === "function";
}

/** Exact-version gate first; interface presence second. */
export function evaluateHostSupport(
  version: string,
  apiPresent: boolean,
  contextPresent: boolean,
): HostSupport {
  if (version !== SUPPORTED_PI_VERSION) return { supported: false, reason: "host-version" };
  if (!apiPresent || !contextPresent) return { supported: false, reason: "host-interfaces" };
  return { supported: true };
}
