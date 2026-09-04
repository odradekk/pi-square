import { DEFAULT_COMPACTION_SETTINGS, SettingsManager, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Capability-detection host gate for Context Memory (odradekk/pi-square#215, #216, #255).
 *
 * Activation is decided by interface presence alone: a Pi host that exposes
 * the required public session, compaction, context, tool, and active-tool
 * interfaces activates the feature on any version, because every check
 * consumes an interface the host itself provides. A host missing any
 * interface is unsupported and leaves Pi native compaction and the active
 * tool set unchanged. There is deliberately no minimum version floor and no
 * pinned equality test: hosts older than the interfaces fail the interface
 * check on their own, and interface semantics are absorbed by the runtime
 * validation and native-fallback paths rather than by a version string.
 */

export type HostSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: "host-interfaces" };

/**
 * The running host Pi version through its public VERSION export. Purely
 * informational — reported by `/context` and the qualification report; it
 * never gates activation.
 */
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
 * and run-boundary surfaces the feature consumes. Their absence makes the
 * host unsupported without touching Pi behavior.
 */
export function contextInterfacesPresent(ctx: {
  sessionManager?: unknown;
  compact?: unknown;
  getContextUsage?: unknown;
  getSystemPrompt?: unknown;
  isIdle?: unknown;
  hasPendingMessages?: unknown;
}): boolean {
  return Boolean(ctx.sessionManager)
    && typeof ctx.compact === "function"
    && typeof ctx.getContextUsage === "function"
    && typeof ctx.getSystemPrompt === "function"
    && typeof ctx.isIdle === "function"
    && typeof ctx.hasPendingMessages === "function";
}

/** Interface presence alone decides activation; the host version never does. */
export function evaluateHostSupport(
  apiPresent: boolean,
  contextPresent: boolean,
): HostSupport {
  if (!apiPresent || !contextPresent) return { supported: false, reason: "host-interfaces" };
  return { supported: true };
}

/**
 * Pi's configured compaction reserve, read through the public SettingsManager
 * the same way Pi's own compaction boundary does (#218: the effective due
 * point sits a safety margin below that native boundary). Any settings
 * failure keeps Pi's documented default.
 */
export function resolvePiReserveTokens(cwd: string, projectTrusted: boolean): number {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
    return settings.getCompactionSettings().reserveTokens;
  } catch {
    return DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  }
}
