import { loadHashStoreAtSync } from "./hash-store.ts";
import { anchoredHashStorePath } from "./paths.ts";

/**
 * Synchronous anchored-store open for the parent write's non-yielding
 * operation (see `createAnchoredWriteSession`): the caller guarantees the
 * hasher is initialized, and an uncached open is serialized through the
 * schema lock with one synchronous zero-wait attempt, so a concurrent opener
 * classifies the write as retryable `[E_FILE_LOCKED]` instead of yielding.
 */
export function loadAnchoredHashStoreSync(storeDir: string, owner: string) {
  return loadHashStoreAtSync(anchoredHashStorePath(storeDir), owner);
}
