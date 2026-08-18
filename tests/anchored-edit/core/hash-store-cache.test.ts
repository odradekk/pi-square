import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import {
  loadHashStoreAt,
  shutdownHashStore,
  getSnapshot,
  upsertSnapshot,
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

describe("hash-store — multi-owner cache", () => {
  it("holds a store across an await while another owner opens the same file", async () => {
    const ownerA = await loadHashStoreAt(storePath, { owner: "A", migrateLegacy: false });
    await loadHashStoreAt(storePath, { owner: "B", migrateLegacy: false });

    // A's prepared statements must still be usable after B opened the same file.
    upsertSnapshot(ownerA, "/p.ts", contentChecksum("x\n"), splitLines("x\n").length, ["AAA"]);
    expect(getSnapshot(ownerA, "/p.ts", "x\n")).toEqual(["AAA"]);
    ownerA.release();
  });

  it("completes concurrent operations under two owners against the same file", async () => {
    const [a, b] = await Promise.all([
      loadHashStoreAt(storePath, { owner: "A", migrateLegacy: false }),
      loadHashStoreAt(storePath, { owner: "B", migrateLegacy: false }),
    ]);

    upsertSnapshot(a, "/a.ts", contentChecksum("a\n"), 1, ["AAA"]);
    upsertSnapshot(b, "/b.ts", contentChecksum("b\n"), 1, ["BBB"]);
    expect(getSnapshot(a, "/a.ts", "a\n")).toEqual(["AAA"]);
    expect(getSnapshot(b, "/b.ts", "b\n")).toEqual(["BBB"]);
    a.release();
    b.release();
  });

  it("reuses the cached database for repeated access under one owner", async () => {
    const first = await loadHashStoreAt(storePath, { owner: "A", migrateLegacy: false });
    const second = await loadHashStoreAt(storePath, { owner: "A", migrateLegacy: false });

    expect(second.stmts).toBe(first.stmts);
    first.release();
    second.release();
    expect(openStoreCount()).toBe(1);
  });

  it("treats a second release of the same handle as a no-op", async () => {
    const handle = await loadHashStoreAt(storePath, { owner: "A", migrateLegacy: false });
    handle.release();
    handle.release();
    expect(() => handle.release()).not.toThrow();
    expect(openStoreCount()).toBe(1);

    const again = await loadHashStoreAt(storePath, { owner: "A", migrateLegacy: false });
    upsertSnapshot(again, "/p.ts", contentChecksum("x\n"), 1, ["AAA"]);
    expect(getSnapshot(again, "/p.ts", "x\n")).toEqual(["AAA"]);
    again.release();
  });

  it("evicts idle databases beyond the bound but never a held one", async () => {
    const held: HashStoreHandle[] = [];
    for (let i = 0; i < OPEN_STORE_LIMIT; i++) {
      held.push(await loadHashStoreAt(storePath, { owner: `held-${i}`, migrateLegacy: false }));
    }
    expect(openStoreCount()).toBe(OPEN_STORE_LIMIT);

    // Open and release more owners; the cache must evict idle databases.
    for (let i = 0; i < OPEN_STORE_LIMIT + 2; i++) {
      const idle = await loadHashStoreAt(storePath, { owner: `idle-${i}`, migrateLegacy: false });
      idle.release();
    }
    expect(openStoreCount()).toBeLessThanOrEqual(OPEN_STORE_LIMIT);

    // Every held database is still usable after eviction ran.
    for (let i = 0; i < OPEN_STORE_LIMIT; i++) {
      upsertSnapshot(held[i], `/held-${i}.ts`, contentChecksum("x\n"), 1, ["AAA"]);
      expect(getSnapshot(held[i], `/held-${i}.ts`, "x\n")).toEqual(["AAA"]);
    }
  });

  it("closes every database on shutdown after a run that used several owners", async () => {
    for (let i = 0; i < 6; i++) {
      const handle = await loadHashStoreAt(storePath, { owner: `owner-${i}`, migrateLegacy: false });
      handle.release();
    }
    expect(openStoreCount()).toBeGreaterThan(0);

    shutdownHashStore();

    expect(openStoreCount()).toBe(0);
  });
});
