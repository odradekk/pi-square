/**
 * Read-only Context Memory view snapshot (odradekk/pi-square#215, #216, #217, #219, #221, #319).
 *
 * The controller publishes this bounded snapshot through the registrar's
 * view provider; Prompt Manager renders it as the `/context` `memory[]`
 * section. It is not a system-prompt segment and never enters the system
 * prompt. #217 added the reading states (`opaque`, `active`); #221 added the
 * `ephemeral` marker for in-memory sessions. #319 replaces the submission
 * handshake states with the recorded/applied distinction: `active` Memory
 * reports `applied: true` only after its carrier has actually been applied to
 * a request in this session, so `/context` never reports a future request as
 * already delivered. #255 keeps capability detection as the only unsupported
 * cause, with the running host version riding along as informational
 * reporting only.
 */

/** Custom-message type of the one ephemeral due advisory (#218, #319). */
export const CONTEXT_MEMORY_ADVISORY_TYPE = "pi-square.context-memory/advisory";

/**
 * Custom-message type of the ephemeral provider-bound Memory carrier (#297,
 * #319): one ordered text content block per current Memory block. It exists
 * only inside the transformed request, never persists, and is never rendered.
 */
export const CONTEXT_MEMORY_BLOCKS_TYPE = "pi-square.context-memory/blocks";

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
  | {
    readonly state: "unsupported";
    /** Missing required interfaces is the only unsupported cause (#255). */
    readonly reason: "host-interfaces";
    /**
     * Running host Pi version, attached by the registrar for informational
     * reporting in `/context` (#255); never gates activation and is absent
     * from controller-internal snapshots.
     */
    readonly hostVersion?: string;
  }
  | { readonly state: "no-memory"; readonly ephemeral?: true }
  | { readonly state: "due"; readonly ephemeral?: true }
  | { readonly state: "opaque"; readonly ephemeral?: true }
  | {
    readonly state: "active";
    /** Which carrier holds the blocks: a #319 state entry or a v1 compaction. */
    readonly carrier: "state" | "compaction";
    /**
     * Whether this session's context handler has constructed the carrier in
     * a request projection (#319). This is not a final provider-delivery receipt.
     */
    readonly applied: boolean;
    /** Total blocks in current Memory. */
    readonly blocks: number;
    /** Block rows in source chronology, capped to the oldest rows; `rows.length < blocks` marks the clip. */
    readonly rows: readonly ContextMemoryBlockRow[];
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
