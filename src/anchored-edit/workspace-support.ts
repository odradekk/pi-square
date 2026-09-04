import { loadHashStoreAt, type HashStoreHandle } from "./hash-store.ts";
import { anchoredHashStorePath } from "./paths.ts";

export const PARENT_OWNER = "parent";

/**
 * Opens the anchored hash store rooted at the session-resolved store
 * directory (`anchoredStoreDir`) under the required owner partition. Owner
 * identity is part of the type: an ownerless store cannot be constructed.
 */
export async function loadAnchoredHashStore(
  storeDir: string,
  owner: string,
): Promise<HashStoreHandle> {
  return loadHashStoreAt(anchoredHashStorePath(storeDir), owner);
}
