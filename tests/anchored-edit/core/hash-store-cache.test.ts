import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import {
  loadHashStoreAt,
  shutdownHashStore,
  openStoreCount,
  OPEN_STORE_LIMIT,
  type HashStoreHandle,
} from "../../../src/anchored-edit/hash-store";
import { initHasher, contentChecksum } from "../../../src/anchored-edit/hashline/hasher";
import { splitLines } from "../../../src/anchored-edit/utils";
import { getWritableTempRoot } from "../support/fixtures";

let dir: string;
let storePath: string;

beforeAll(async () => {
  await initHasher();
  dir = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-cache-test-"));
  storePath = join(dir, "hash-store.sqlite");
});

afterEach(() => {
  shutdownHashStore();
});

afterAll(async () => {
  shutdownHashStore();
  await rm(dir, { recursive: true, force: true });
});

describe("hash-store — physical-connection and snapshot-cache ownership (#264)", () => {
  it("holds one cache entry per store path while several owners open the same file", async () => {
    const ownerA = await loadHashStoreAt(storePath, "A");
    await loadHashStoreAt(storePath, "B");
    expect(openStoreCount()).toBe(1);

    // A's repository operations stay usable after B opened the same file.
    ownerA.upsertSnapshot("/p.ts", contentChecksum("x\n"), splitLines("x\n").length, ["AAA"]);
    expect(ownerA.getSnapshot("/p.ts", "x\n")).toEqual(["AAA"]);
    ownerA.release();
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
    const { deleteOwnerPartition } = await import("../../../src/anchored-edit/hash-store");
    const a = await loadHashStoreAt(storePath, "A");
    const keeper = await loadHashStoreAt(storePath, "keeper");
    a.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["AAA"]);
    keeper.upsertSnapshot("/k.ts", contentChecksum("k\n"), 1, ["KKK"]);
    a.mergeServed("/p.ts", ["AAA"]);
    expect(a.getSnapshot("/p.ts", "x\n")).toEqual(["AAA"]);

    deleteOwnerPartition(a, "A");

    // The deleted partition cannot be revived by a later cache hit, and other
    // owners keep their rows and caches.
    expect(a.getSnapshot("/p.ts", "x\n")).toBeUndefined();
    expect(keeper.getSnapshot("/k.ts", "k\n")).toEqual(["KKK"]);
    expect(a.getServed("/p.ts")).toBeUndefined();
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

  it("merges concurrent served-hash additions into their union instead of losing one (#264)", async () => {
    const a1 = await loadHashStoreAt(storePath, "A");
    const a2 = await loadHashStoreAt(storePath, "A");
    a1.mergeServed("/p.ts", ["AAA", "BBB"]);
    a2.mergeServed("/p.ts", ["CCC"]);
    const merged = a1.getServed("/p.ts");
    expect(merged).toEqual(new Set(["AAA", "BBB", "CCC"]));
    a1.release();
    a2.release();
  });

  it("refreshes served-row activity on repeated identical reads so partitions do not look idle (#264)", async () => {
    const { listOwnerPartitions } = await import("../../../src/anchored-edit/hash-store");
    const a = await loadHashStoreAt(storePath, "active");
    const b = await loadHashStoreAt(storePath, "stale");
    a.mergeServed("/a.ts", ["AAA"]);
    b.mergeServed("/b.ts", ["BBB"]);
    const scoped = (rows: { owner: string; updatedAt: number }[]) =>
      rows.filter((row) => row.owner === "active" || row.owner === "stale");
    const before = scoped(listOwnerPartitions(a)).sort((x, y) => x.updatedAt - y.updatedAt);
    expect(before[0]!.owner).toBe("active");
    // Repeated identical reads reuse the cached snapshot; the served merge
    // must still count as activity.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    a.mergeServed("/a.ts", ["AAA"]);
    const after = scoped(listOwnerPartitions(a)).sort((x, y) => x.updatedAt - y.updatedAt);
    expect(after[0]!.owner).toBe("stale");
    expect(after[after.length - 1]!.owner).toBe("active");
    a.release();
    b.release();
  });
});
