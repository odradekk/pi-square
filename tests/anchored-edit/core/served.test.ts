import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { loadHashStoreAt, shutdownHashStore, pruneMissing, type HashStoreHandle } from "../../../src/anchored-edit/hash-store";
import { getServed, recordServed, clearServed, servedHashesFromDiff, recordServedSafe, recordServedDiffSafe } from "../../../src/anchored-edit/served";
import { initHasher } from "../../../src/anchored-edit/hashline";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-served-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(home);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

function storePath(home: string): string {
  return join(home, "anchored-edit", "hash-store.sqlite");
}

function openStore(home: string): Promise<HashStoreHandle> {
  return loadHashStoreAt(storePath(home), { owner: "parent" });
}

describe("served store", () => {
  it("returns undefined for a path with no served record", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      expect(getServed(store, "/missing.ts")).toBeUndefined();
    });
  });

  it("round-trips served hashes and unions repeated records", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      recordServed(store, "/a.ts", ["aB3", "cD4"]);
      recordServed(store, "/a.ts", ["cD4", "eF5"]);
      const served = getServed(store, "/a.ts");
      expect(served).toEqual(new Set(["aB3", "cD4", "eF5"]));
    });
  });

  it("ignores empty records and clears existing ones", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      recordServed(store, "/a.ts", []);
      expect(getServed(store, "/a.ts")).toBeUndefined();
      recordServed(store, "/a.ts", ["aB3"]);
      clearServed(store, "/a.ts");
      expect(getServed(store, "/a.ts")).toBeUndefined();
    });
  });

  it("treats a row with unparseable hashes as a miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      recordServed(store, "/a.ts", ["aB3"]);
      const db = new DatabaseSync(storePath(home), { defensive: false } as any);
      db.prepare("UPDATE served SET hashes = ? WHERE path = ?").run("{not json", "/a.ts");
      db.close();
      expect(getServed(store, "/a.ts")).toBeUndefined();
      const check = new DatabaseSync(storePath(home), { defensive: false } as any);
      const remaining = check.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get("/a.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("treats a row with malformed hash strings as a miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      recordServed(store, "/a.ts", ["aB3"]);
      const db = new DatabaseSync(storePath(home), { defensive: false } as any);
      db.prepare("UPDATE served SET hashes = ? WHERE path = ?").run('["ZZ", "ZZZZ"]', "/a.ts");
      db.close();
      expect(getServed(store, "/a.ts")).toBeUndefined();
      const check = new DatabaseSync(storePath(home), { defensive: false } as any);
      const remaining = check.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get("/a.ts") as { n: number };
      check.close();
      expect(remaining.n).toBe(0);
    });
  });

  it("keeps the served record after a store reopen", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      recordServed(store, "/a.ts", ["aB3", "cD4"]);
      shutdownHashStore();
      const reopened = await openStore(home);
      expect(getServed(reopened, "/a.ts")).toEqual(new Set(["aB3", "cD4"]));
    });
  });

  it("prunes served records for deleted files", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      recordServed(store, "/deleted.ts", ["aB3"]);
      await pruneMissing(store);
      expect(getServed(store, "/deleted.ts")).toBeUndefined();
    });
  });
});

describe("servedHashesFromDiff", () => {
  it("extracts + and context rows but not removed rows", () => {
    const diff = " aaa│aaa\n-   │bbb\n-OLD│old\n+XYZ│BBB\n ccc│ccc\n";
    expect(servedHashesFromDiff(diff)).toEqual(["aaa", "XYZ", "ccc"]);
  });

  it("returns nothing for empty or row-less text", () => {
    expect(servedHashesFromDiff("")).toEqual([]);
    expect(servedHashesFromDiff("plain text\nno rows")).toEqual([]);
  });

  it("extracts the hash of every + and context row in order", () => {
    const diff = "+AAA│x\n BBB│y\n+CCC│z\n DDD│w\n";
    expect(servedHashesFromDiff(diff)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });
});

describe("served safe helpers", () => {
  it("recordServedSafe records hashes without throwing", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        await recordServedSafe("/safe.ts", ["aB3", "cD4"], "test", store);
        expect(getServed(store, "/safe.ts")).toEqual(new Set(["aB3", "cD4"]));
      } finally {
        store.release();
      }
    });
  });

  it("recordServedSafe skips empty hash lists", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        await recordServedSafe("/safe.ts", [], "test", store);
        expect(getServed(store, "/safe.ts")).toBeUndefined();
      } finally {
        store.release();
      }
    });
  });

  it("recordServedDiffSafe records diff rows", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        await recordServedDiffSafe("/safe.ts", "+aB3│x\n pQ2│y\n-cD4│z\n", "test", store);
        expect(getServed(store, "/safe.ts")).toEqual(new Set(["aB3", "pQ2"]));
      } finally {
        store.release();
      }
    });
  });

  it("recordServedSafe swallows store failures", async () => {
    const broken = {
      stmts: {
        servedGet() {
          throw new Error("store down");
        },
      },
    };
    await expect(recordServedSafe("/safe.ts", ["aB3"], "test", broken as never)).resolves.toBeUndefined();
  });
});
