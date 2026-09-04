import { realpathSync } from "node:fs";
import { pruneMissing } from "./hash-store";
import { loadAnchoredHashStore, PARENT_OWNER } from "./workspace-support";
import { anchoredStoreDir } from "./paths";

/**
 * Documented bound on how many child anchor-store partitions are retained in
 * one workspace at a time. The anchor store lives in the session directory
 * (`<sessionDir>/anchored-edit/hash-store.sqlite`) and keeps one partition per
 * owner; child partitions use the subagent ID as their owner. The store retains
 * a child partition exactly while that child's artifacts are retained, so
 * dropping a child's history drops its partition with it.
 * `reconcileChildPartitions` is the reconciliation point that evicts orphan
 * partitions and enforces this bound.
 */
export const MAX_RETAINED_CHILD_PARTITIONS = 32;

function isChildOwner(owner: string): boolean {
  return owner !== PARENT_OWNER && owner.length > 0;
}

/**
 * Resolves the store directory for one workspace session. The persistent
 * session directory is authoritative; when it is absent (a non-persisted
 * session) the throwaway temp fallback is keyed by the real path of the cwd,
 * matching how the read and replace operations resolve their workspace root.
 * Returns undefined when there is no session directory and the cwd no longer
 * exists, in which case there is no store to manage.
 */
function storeDirOf(cwd: string, sessionDir: string | undefined): string | undefined {
  if (sessionDir && sessionDir.trim().length > 0) return anchoredStoreDir(sessionDir, cwd);
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return undefined;
  }
  return anchoredStoreDir(undefined, root);
}

/**
 * Deletes every anchor-store row belonging to one child owner. Called when a
 * child's history is deleted so its served records are dropped with its
 * artifacts; also used by the reconciliation.
 */
export async function dropChildPartition(cwd: string, owner: string, sessionDir?: string): Promise<void> {
  if (!isChildOwner(owner)) return;
  const storeDir = storeDirOf(cwd, sessionDir);
  if (!storeDir) return;
  const store = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
  try {
    store.deleteOwnerPartition(owner);
  } finally {
    store.release();
  }
}

/**
 * Prunes records for files that no longer exist for every owner in the
 * workspace store, not only the parent. Each owner's store is opened and
 * pruned so a child's stale records do not outlive their files.
 */
export async function pruneMissingForAllOwners(cwd: string, sessionDir?: string): Promise<void> {
  const storeDir = storeDirOf(cwd, sessionDir);
  if (!storeDir) return;
  const store = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
  let owners: string[];
  try {
    owners = [...new Set([PARENT_OWNER, ...store.listOwners().map((p) => p.owner)])];
  } finally {
    store.release();
  }
  for (const owner of owners) {
    const ownerStore = await loadAnchoredHashStore(storeDir, owner);
    try {
      await pruneMissing(ownerStore);
    } finally {
      ownerStore.release();
    }
  }
}

/**
 * Reconciles the workspace's child partitions against the retained artifact
 * set and enforces the documented bound. A retained child (whose subagent
 * artifacts still exist) is never evicted, so a resumed child keeps the served
 * records it was working from. Eviction order is least-recently active: orphan
 * partitions (children whose artifacts are gone) are dropped first, then, when
 * the bound is exceeded, the least-recently-active retained partitions are
 * evicted.
 *
 * @returns the owners whose partitions were evicted.
 */
export async function reconcileChildPartitions(
  cwd: string,
  retainedOwners: ReadonlySet<string>,
  sessionDir?: string,
): Promise<{ evicted: string[] }> {
  const storeDir = storeDirOf(cwd, sessionDir);
  if (!storeDir) return { evicted: [] };
  const store = await loadAnchoredHashStore(storeDir, PARENT_OWNER);
  const evicted: string[] = [];
  try {
    const partitions = store.listOwners()
      .filter((p) => isChildOwner(p.owner))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const retained = partitions.filter((p) => retainedOwners.has(p.owner));
    const orphans = partitions.filter((p) => !retainedOwners.has(p.owner));
    for (const partition of orphans) {
      store.deleteOwnerPartition(partition.owner);
      evicted.push(partition.owner);
    }
    let retainedCount = retained.length;
    for (const partition of retained) {
      if (retainedCount <= MAX_RETAINED_CHILD_PARTITIONS) break;
      store.deleteOwnerPartition(partition.owner);
      evicted.push(partition.owner);
      retainedCount -= 1;
    }
    return { evicted };
  } finally {
    store.release();
  }
}
