/**
 * Read-only Context Memory view snapshot (odradekk/pi-square#215, #216).
 *
 * The controller publishes this bounded snapshot through the registrar's
 * view provider; Prompt Manager renders it as the `/context` `memory[]`
 * section. It is not a system-prompt segment and never enters the system
 * prompt. Later slices extend this union with the active Memory states
 * (due, pending, opaque, scale limit); the shell establishes only the
 * baseline states a configuration-only deployment can observe.
 */
export type ContextMemorySnapshot =
  | { readonly state: "disabled" }
  | { readonly state: "unsupported"; readonly reason: "host-version" | "host-interfaces" }
  | { readonly state: "no-memory" };

/** Snapshot published before a session starts and after shutdown. */
export const CONTEXT_MEMORY_DISABLED_SNAPSHOT: ContextMemorySnapshot = Object.freeze({ state: "disabled" });
