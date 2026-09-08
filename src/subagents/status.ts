export const STALE_ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;

/** An active-phase record (queued, running, or cancelling) whose artifacts
 * stopped changing and whose activity lease is gone: the process died before
 * writing a terminal phase. */
export function isStaleActiveRecord(
  persisted: { phase?: string },
  mtimeMs: number,
  now: number = Date.now(),
): boolean {
  return (persisted.phase === "queued" || persisted.phase === "running" || persisted.phase === "cancelling")
    && now - mtimeMs > STALE_ACTIVE_THRESHOLD_MS;
}
