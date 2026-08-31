/**
 * Read-only Context Memory view snapshot (odradekk/pi-square#215, #216, #217, #218, #219, #220, #221).
 *
 * The controller publishes this bounded snapshot through the registrar's
 * view provider; Prompt Manager renders it as the `/context` `memory[]`
 * section. It is not a system-prompt segment and never enters the system
 * prompt. #217 added the reading states (`opaque`, `active`); #218 adds the
 * submission-handshake states: `due` (threshold reached, the next real-user
 * run authors the first Memory block), `pending` (a candidate was accepted
 * this run and compaction follows), and `committing` (takeover in progress).
 * #221 adds the `ephemeral` marker for in-memory sessions. #220 adds the
 * `scale-limit` state: Memory sits above half its budget and the complete
 * maintenance request cannot fit the model window, so the structured
 * takeover stops and Pi native compaction keeps owning the boundary.
 */

/** Custom-message type of the one ephemeral due-run advisory (#218). */
export const CONTEXT_MEMORY_ADVISORY_TYPE = "pi-square.context-memory/advisory";

/** One chronological block row in the active view: bounded, no identifiers. */
export interface ContextMemoryBlockRow {
  /** Bounded single-line Markdown preview (sanitized at render). */
  readonly preview: string;
  /** Estimated tokens for this block's body (chars/4). */
  readonly tokens: number;
  /** Safe count of eligible source conversation entries behind the block. */
  readonly sources: number;
}

export type ContextMemorySnapshot =
  | { readonly state: "disabled" }
  | { readonly state: "unsupported"; readonly reason: "host-version" | "host-interfaces" }
  | { readonly state: "no-memory"; readonly ephemeral?: true }
  | { readonly state: "due"; readonly ephemeral?: true }
  | { readonly state: "pending"; readonly ephemeral?: true }
  | { readonly state: "committing"; readonly ephemeral?: true }
  | { readonly state: "opaque"; readonly ephemeral?: true }
  | { readonly state: "scale-limit"; readonly ephemeral?: true }
  | {
    readonly state: "active";
    /** Total blocks in current Memory. */
    readonly blocks: number;
    /** Block rows in source chronology, capped to the oldest rows; `rows.length < blocks` marks the clip. */
    readonly rows: readonly ContextMemoryBlockRow[];
    /** Blocks left byte-stable by the next operation (null when unknown). */
    readonly stablePrefix: number | null;
    /** Next operation by the half-budget rule (null when the budget is unknown). */
    readonly nextOperation: "append" | "rebuild" | null;
    /** Estimated tokens of the complete rendered Memory. */
    readonly memoryTokens: number;
    /** Configured Memory budget in tokens (null when the model window is unknown). */
    readonly budgetTokens: number | null;
    /** Current context tokens, when reported. */
    readonly currentTokens: number | null;
    /** Current model context window, when reported. */
    readonly contextWindow: number | null;
    readonly ephemeral?: true;
  };

/** Snapshot published before a session starts and after shutdown. */
export const CONTEXT_MEMORY_DISABLED_SNAPSHOT: ContextMemorySnapshot = Object.freeze({ state: "disabled" });

/**
 * Bound on active block rows rendered in `/context` (pathology defense; the
 * 64 KiB details cap already bounds the total). Keeps the oldest rows and a
 * visible clip marker; the total block count always stays visible.
 */
export const CONTEXT_MEMORY_MAX_VIEW_ROWS = 64;

/**
 * Whether the snapshot was derived on an ephemeral in-memory session (#221):
 * the feature runs identically there, `/context` reports it, and no file or
 * sidecar is ever created.
 */
export function isEphemeralMemorySnapshot(memory: ContextMemorySnapshot): boolean {
  return (memory as { readonly ephemeral?: true }).ephemeral === true;
}
