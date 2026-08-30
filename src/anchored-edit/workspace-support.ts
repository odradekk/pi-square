import { loadHashStoreAt, type HashStoreHandle } from "./hash-store.ts";
import { anchoredHashStorePath } from "./paths.ts";

export const PARENT_OWNER = "parent";

/**
 * Opens the anchored hash store rooted at the session-resolved store
 * directory (`anchoredStoreDir`), under the given owner partition.
 */
export async function loadAnchoredHashStore(
  storeDir: string,
  owner: string = PARENT_OWNER,
): Promise<HashStoreHandle> {
  return loadHashStoreAt(anchoredHashStorePath(storeDir), {
    owner,
  });
}

export function outsideWorkspaceError(path: string): Error {
  return new Error(
    `[E_OUTSIDE_WORKSPACE] ${path} resolves outside the workspace. Disable anchoredEditing.enabled to use Pi's built-in edit for that path.`,
  );
}
