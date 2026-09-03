import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { basename, dirname, join } from "path";
import {
  loadHashStoreAt,
  shutdownHashStore,
  openStoreCount,
  OPEN_STORE_LIMIT,
  __testables,
  type HashStoreHandle,
} from "../../../src/anchored-edit/hash-store";
import { initHasher, contentChecksum } from "../../../src/anchored-edit/hashline/hasher";
import { splitLines } from "../../../src/anchored-edit/utils";
import { getWritableTempRoot } from "../support/fixtures";
import { acquireFileLock, __lockTestables } from "../../../src/anchored-edit/file-lock";

let dir: string;
let storePath: string;

beforeAll(async () => {
  await initHasher();
  dir = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-cache-test-"));
  storePath = join(dir, "hash-store.sqlite");
});

afterEach(() => {
  vi.restoreAllMocks();
  __lockTestables.lockBarrier.acquireWaitStarted = undefined;
  __testables.loadBarrier.beforeAcquire = undefined;
  shutdownHashStore();
});

afterAll(async () => {
  shutdownHashStore();
  await rm(dir, { recursive: true, force: true });
});

describe("hash-store — physical-connection and snapshot-cache ownership (#264)", () => {
  it("holds one cache entry per store path while several owners open the same file", async () => {
    const ownerA = await loadHashStoreAt(storePath, "A");
    const ownerB = await loadHashStoreAt(storePath, "B");
    expect(openStoreCount()).toBe(1);

    // A's repository operations stay usable after B opened the same file.
    ownerA.upsertSnapshot("/p.ts", contentChecksum("x\n"), splitLines("x\n").length, ["AAA"]);
    expect(ownerA.getSnapshot("/p.ts", "x\n")).toEqual(["AAA"]);
    ownerA.release();
    ownerB.release();
  });

  it("completes concurrent operations under two owners against the same file", async () => {
    const [a, b] = await Promise.all([
      loadHashStoreAt(storePath, "A"),
      loadHashStoreAt(storePath, "B"),
    ]);

    a.upsertSnapshot("/a.ts", contentChecksum("a\n"), 1, ["AAA"]);
    b.upsertSnapshot("/b.ts", contentChecksum("b\n"), 1, ["BBB"]);
    expect(a.getSnapshot("/a.ts", "a\n")).toEqual(["AAA"]);
    expect(b.getSnapshot("/b.ts", "b\n")).toEqual(["BBB"]);
    a.release();
    b.release();
  });

  it("scopes cached snapshots by owner: one owner never receives another owner's snapshot", async () => {
    const a = await loadHashStoreAt(storePath, "A");
    const b = await loadHashStoreAt(storePath, "B");
    // Identical path and content under two owners must not cross the owner
    // boundary through the shared store's cache.
    a.upsertSnapshot("/shared.ts", contentChecksum("same\n"), 1, ["AAA"]);
    expect(b.getSnapshot("/shared.ts", "same\n")).toBeUndefined();
    expect(a.getSnapshot("/shared.ts", "same\n")).toEqual(["AAA"]);
    a.release();
    b.release();
  });

  it("scopes cached snapshots by physical store: two store paths never share cache entries", async () => {
    const otherPath = join(dir, "other-hash-store.sqlite");
    const one = await loadHashStoreAt(storePath, "A");
    const two = await loadHashStoreAt(otherPath, "A");
    one.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["AAA"]);
    expect(two.getSnapshot("/p.ts", "x\n")).toBeUndefined();
    expect(one.getSnapshot("/p.ts", "x\n")).toEqual(["AAA"]);
    one.release();
    two.release();
  });

  it("owner deletion invalidates exactly that owner's cached and persisted state", async () => {
    const a = await loadHashStoreAt(storePath, "A");
    const keeper = await loadHashStoreAt(storePath, "keeper");
    a.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["AAA"]);
    keeper.upsertSnapshot("/k.ts", contentChecksum("k\n"), 1, ["KKK"]);
    a.mergeServed("/p.ts", ["AAA"], "x\n");
    expect(a.getSnapshot("/p.ts", "x\n")).toEqual(["AAA"]);

    a.deleteOwnerPartition("A");

    // The deleted partition cannot be revived by a later cache hit, and other
    // owners keep their rows and caches.
    expect(a.getSnapshot("/p.ts", "x\n")).toBeUndefined();
    expect(keeper.getSnapshot("/k.ts", "k\n")).toEqual(["KKK"]);
    expect(a.getServedState("/p.ts", "x\n")).toBeUndefined();
    const fresh = await loadHashStoreAt(storePath, "A");
    expect(fresh.getSnapshot("/p.ts", "x\n")).toBeUndefined();
    fresh.release();
    a.release();
    keeper.release();
  });

  it("treats a second release of the same handle as a no-op", async () => {
    const handle: HashStoreHandle = await loadHashStoreAt(storePath, "A");
    handle.release();
    handle.release();
    expect(() => handle.release()).not.toThrow();
    expect(openStoreCount()).toBe(1);

    const again = await loadHashStoreAt(storePath, "A");
    again.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["AAA"]);
    expect(again.getSnapshot("/p.ts", "x\n")).toEqual(["AAA"]);
    again.release();
  });

  it("evicts idle databases beyond the bound but never a held one", async () => {
    const held: HashStoreHandle[] = [];
    for (let i = 0; i < OPEN_STORE_LIMIT; i++) {
      held.push(await loadHashStoreAt(join(dir, `held-${i}.sqlite`), "A"));
    }
    expect(openStoreCount()).toBe(OPEN_STORE_LIMIT);

    // Open and release more store paths; the cache must evict idle databases.
    for (let i = 0; i < OPEN_STORE_LIMIT + 2; i++) {
      const idle = await loadHashStoreAt(join(dir, `idle-${i}.sqlite`), "A");
      idle.release();
    }
    expect(openStoreCount()).toBeLessThanOrEqual(OPEN_STORE_LIMIT);

    // Every held database is still usable after eviction ran.
    for (let i = 0; i < OPEN_STORE_LIMIT; i++) {
      held[i]!.upsertSnapshot(`/held-${i}.ts`, contentChecksum("x\n"), 1, ["AAA"]);
      expect(held[i]!.getSnapshot(`/held-${i}.ts`, "x\n")).toEqual(["AAA"]);
      held[i]!.release();
    }
  });

  it("closes every database on shutdown after a run that used several owners", async () => {
    for (let i = 0; i < 6; i++) {
      const handle = await loadHashStoreAt(storePath, `owner-${i}`);
      handle.release();
    }
    expect(openStoreCount()).toBeGreaterThan(0);

    shutdownHashStore();

    expect(openStoreCount()).toBe(0);
  });

  it("marks a pending opener to close when its first borrower releases", async () => {
    const pendingPath = join(dir, "pending-shutdown.sqlite");
    const schemaLock = join(dirname(pendingPath), "locks", `store-${basename(pendingPath)}.schema.lock`);
    const holder = await acquireFileLock(schemaLock);
    expect(holder).not.toBeNull();
    const waiting = new Promise<void>((resolve) => {
      __lockTestables.lockBarrier.acquireWaitStarted = () => {
        __lockTestables.lockBarrier.acquireWaitStarted = undefined;
        resolve();
      };
    });
    const opening = loadHashStoreAt(pendingPath, "pending-owner");
    await waiting;

    shutdownHashStore();
    await holder!.release();
    const handle = await opening;
    expect(openStoreCount()).toBe(1);
    handle.release();
    expect(openStoreCount()).toBe(0);
  });

  it("keeps a completed opener alive until its first borrower acquires", async () => {
    const pendingPath = join(dir, "handoff-shutdown.sqlite");
    let releaseAcquire!: () => void;
    const acquireBlocked = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let reachedAcquire!: () => void;
    const atAcquire = new Promise<void>((resolve) => {
      reachedAcquire = resolve;
    });
    __testables.loadBarrier.beforeAcquire = async () => {
      reachedAcquire();
      await acquireBlocked;
    };

    const opening = loadHashStoreAt(pendingPath, "handoff-owner");
    await atAcquire;
    shutdownHashStore();
    releaseAcquire();

    const handle = await opening;
    expect(openStoreCount()).toBe(1);
    handle.upsertSnapshot("/handoff.ts", contentChecksum("x\n"), 1, ["AAA"]);
    expect(handle.getSnapshot("/handoff.ts", "x\n")).toEqual(["AAA"]);
    handle.release();
    expect(openStoreCount()).toBe(0);
  });

  it("does not let a second caller close a completed opener before the first acquires", async () => {
    const pendingPath = join(dir, "two-caller-handoff.sqlite");
    let releaseAcquire!: () => void;
    const acquireBlocked = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let reachedAcquire!: () => void;
    const atAcquire = new Promise<void>((resolve) => {
      reachedAcquire = resolve;
    });
    let barrierCalls = 0;
    __testables.loadBarrier.beforeAcquire = async () => {
      barrierCalls += 1;
      reachedAcquire();
      await acquireBlocked;
    };

    const firstOpening = loadHashStoreAt(pendingPath, "first-owner");
    await atAcquire;
    shutdownHashStore();
    const second = await loadHashStoreAt(pendingPath, "second-owner");
    second.release();
    releaseAcquire();

    const first = await firstOpening;
    expect(barrierCalls).toBe(1);
    expect(openStoreCount()).toBe(1);
    first.upsertSnapshot("/first.ts", contentChecksum("x\n"), 1, ["AAA"]);
    expect(first.getSnapshot("/first.ts", "x\n")).toEqual(["AAA"]);
    first.release();
    expect(openStoreCount()).toBe(0);
  });

  it("merges concurrent served-hash additions into their union instead of losing one (#264)", async () => {
    const a1 = await loadHashStoreAt(storePath, "A");
    const a2 = await loadHashStoreAt(storePath, "A");
    a1.mergeServed("/p.ts", ["AAA", "BBB"], "x\n");
    a2.mergeServed("/p.ts", ["CCC"], "x\n");
    const lookup = a1.getServedState("/p.ts", "x\n");
    const merged = lookup !== undefined && "served" in lookup ? lookup.served : undefined;
    expect(merged).toEqual(new Set(["AAA", "BBB", "CCC"]));
    a1.release();
    a2.release();
  });

  it("refreshes served-row activity on repeated identical reads so partitions do not look idle (#264)", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const a = await loadHashStoreAt(storePath, "active");
    const b = await loadHashStoreAt(storePath, "stale");
    a.mergeServed("/a.ts", ["AAA"], "x\n");
    now += 1;
    b.mergeServed("/b.ts", ["BBB"], "y\n");
    const scoped = (rows: { owner: string; updatedAt: number }[]) =>
      rows.filter((row) => row.owner === "active" || row.owner === "stale");
    const before = scoped(a.listOwners()).sort((x, y) => x.updatedAt - y.updatedAt);
    expect(before[0]!.owner).toBe("active");
    // Repeated identical reads reuse the cached snapshot; the served merge
    // must still count as activity.
    now += 1;
    a.mergeServed("/a.ts", ["AAA"], "x\n");
    const after = scoped(a.listOwners()).sort((x, y) => x.updatedAt - y.updatedAt);
    expect(after[0]!.owner).toBe("stale");
    expect(after[after.length - 1]!.owner).toBe("active");
    a.release();
    b.release();
  });
});
