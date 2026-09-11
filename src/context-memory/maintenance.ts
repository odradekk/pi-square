// Pending maintenance request and bounded failure suppression
// (odradekk/pi-square#320).
//
// One due request pins the exact append sources it invites: the inclusive
// range end, the retained exceptions inside that range, the Memory boundary
// it appends onto, and the derived Memory version it was established
// against. The advisory bound to the request never silently grows — later
// tool work extends coverage only through an explicit re-scope at a request
// boundary, where the new sources are served in that very request. Repeated
// failed or zero-benefit attempts against one pinned scope are suppressed
// after a bounded count; a changed scope or Memory state resets suppression
// without waiting for the next user input.

/**
 * One pinned maintenance request (#320). Immutable once established; a
 * changed scope is a new request object, never a mutation of the old one.
 */
export interface MaintenanceRequest {
  /** Inclusive end of the pinned continuous source range (entry id). */
  readonly sourceEndEntryId: string;
  /** Protected user instructions inside the range that stay raw (entry ids). */
  readonly retainedEntryIds: readonly string[];
  /**
   * The Memory boundary the append extends: the last existing block's end
   * entry id, or null when the request appends the first block.
   */
  readonly previousEndEntryId: string | null;
  /** Identity of the derived Memory the request was established against. */
  readonly memoryVersion: string;
  /** Safe count of eligible source entries inside the pinned range. */
  readonly sourceCount: number;
}

/**
 * Bounded failure bookkeeping for one pending request (#320): consecutive
 * refused attempts and the most recent refusal code. Never a log — one
 * small record, replaced wholesale when the scope changes.
 */
export interface MaintenanceFailures {
  readonly attempts: number;
  readonly lastCode: string;
}

/**
 * After this many consecutive refusals against one unchanged scope the
 * advisory stops inviting the same attempt (#320). The tool itself stays
 * resident and keeps refusing with its specific bounded error; only the
 * invitation is bounded.
 */
export const MAINTENANCE_ADVISORY_FAILURE_LIMIT = 3;

/** Upper bound stored for the refusal counter; the count never grows unbounded. */
export const MAINTENANCE_FAILURE_COUNT_BOUND = 99;

/** Whether the advisory must stay silent for the current pending request. */
export function maintenanceSuppressed(failures: MaintenanceFailures | undefined): boolean {
  return failures !== undefined && failures.attempts >= MAINTENANCE_ADVISORY_FAILURE_LIMIT;
}

/** Record one more refused attempt against the pending request, bounded. */
export function noteMaintenanceFailure(
  failures: MaintenanceFailures | undefined,
  code: string,
): MaintenanceFailures {
  return {
    attempts: Math.min(
      (failures?.attempts ?? 0) + 1,
      MAINTENANCE_FAILURE_COUNT_BOUND,
    ),
    lastCode: code,
  };
}

/**
 * Whether two pinned requests authorize the identical scope: same range end,
 * same retained exceptions in order, same Memory boundary, and same Memory
 * version. Only an identical scope keeps an established request (and its
 * failure bookkeeping) in place; anything else is a re-scope.
 */
export function sameMaintenanceScope(
  left: MaintenanceRequest | undefined,
  right: MaintenanceRequest,
): boolean {
  if (left === undefined) return false;
  return left.sourceEndEntryId === right.sourceEndEntryId
    && left.previousEndEntryId === right.previousEndEntryId
    && left.memoryVersion === right.memoryVersion
    && left.retainedEntryIds.length === right.retainedEntryIds.length
    && left.retainedEntryIds.every((id, index) => id === right.retainedEntryIds[index]);
}
