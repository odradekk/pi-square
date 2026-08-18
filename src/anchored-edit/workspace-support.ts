import { loadHashStoreAt, type HashStore } from "./hash-store.ts";
import { projectHashStorePath } from "./paths.ts";

export const PARENT_OWNER = "parent";

export async function loadProjectHashStore(
  workspaceRoot: string,
  owner: string = PARENT_OWNER,
): Promise<HashStore> {
  return loadHashStoreAt(projectHashStorePath(workspaceRoot), {
    owner,
    migrateLegacy: false,
  });
}

export function outsideWorkspaceError(path: string): Error {
  return new Error(
    `[E_OUTSIDE_WORKSPACE] ${path} resolves outside the workspace. Disable anchoredEditing.enabled to use Pi's built-in edit for that path.`,
  );
}
