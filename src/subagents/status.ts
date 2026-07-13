export const STALE_RUNNING_THRESHOLD_MS = 60 * 60 * 1000;

export function isStaleRunning(
  persisted: { phase?: string },
  mtimeMs: number,
  now: number = Date.now(),
): boolean {
  return persisted.phase === "running" && now - mtimeMs > STALE_RUNNING_THRESHOLD_MS;
}
