import type { HashStoreHandle } from "./hash-store";
import { HASH_CLASS } from "./hashline/alphabet";

const SERVED_DIFF_ROW_RE = new RegExp(`^[+ ](${HASH_CLASS})│`);

export function servedHashesFromDiff(diff: string): string[] {
  const hashes: string[] = [];
  for (const line of diff.split("\n")) {
    const match = SERVED_DIFF_ROW_RE.exec(line);
    if (match) hashes.push(match[1]!);
  }
  return hashes;
}

export function getServed(store: HashStoreHandle, path: string): Set<string> | undefined {
  return store.getServed(path);
}

/**
 * Merges hashes into the owner's served set for the path. Persistence is
 * row-level and conflict-safe, so concurrent additions under one owner union
 * instead of one update replacing the other; the merge also refreshes the
 * rows' activity timestamp so partition retention observes real use even
 * when every added hash was already present.
 */
export function recordServed(store: HashStoreHandle, path: string, hashes: string[]): void {
  store.mergeServed(path, hashes);
}

export function recordServedDiff(store: HashStoreHandle, path: string, diff: string): void {
  recordServed(store, path, servedHashesFromDiff(diff));
}

export function clearServed(store: HashStoreHandle, path: string): void {
  store.clearServed(path);
}

export async function recordServedSafe(
  path: string,
  hashes: string[],
  context: string,
  store: HashStoreHandle,
): Promise<void> {
  if (hashes.length === 0) return;
  try {
    recordServed(store, path, hashes);
  } catch (error) {
    console.error(`Failed to record served state (${context}):`, error);
  }
}

export async function recordServedDiffSafe(
  path: string,
  diff: string,
  context: string,
  store: HashStoreHandle,
): Promise<void> {
  if (!diff) return;
  await recordServedSafe(path, servedHashesFromDiff(diff), context, store);
}
