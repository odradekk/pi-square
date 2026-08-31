/**
 * Read-only Context Memory view snapshot (odradekk/pi-square#215, #216, #217).
 *
 * The controller publishes this bounded snapshot through the registrar's
 * view provider; Prompt Manager renders it as the `/context` `memory[]`
 * section. It is not a system-prompt segment and never enters the system
 * prompt. #217 adds the reading states: `opaque` for a native, unknown,
 * malformed, or over-bound latest compaction, and `active` for strictly valid
 * current Memory with its ordered block rows. Later slices extend the union
 * with the due/pending and scale-limit states.
 */


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
  | { readonly state: "no-memory" }
  | { readonly state: "opaque" }
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
  };

/** Snapshot published before a session starts and after shutdown. */
export const CONTEXT_MEMORY_DISABLED_SNAPSHOT: ContextMemorySnapshot = Object.freeze({ state: "disabled" });

/**
 * Bound on active block rows rendered in `/context` (pathology defense; the
 * 64 KiB details cap already bounds the total). Keeps the oldest rows and a
 * visible clip marker; the total block count always stays visible.
 */
export const CONTEXT_MEMORY_MAX_VIEW_ROWS = 64;
