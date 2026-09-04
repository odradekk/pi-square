import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { loadHashStoreAt, shutdownHashStore, type HashStoreHandle } from "../../../src/anchored-edit/hash-store";
import { contentChecksum } from "../../../src/anchored-edit/hashline/hasher";
import { servedHashesFromDiff } from "../../../src/anchored-edit/served";
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
  return loadHashStoreAt(storePath(home), "parent");
}

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

describe("version-bound served state (#264)", () => {
  const ORIGINAL = "a\nb\nc\n";
  const CHANGED = "a\nB\nc\n";

  it("returns undefined for a path with no served record", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        expect(store.getServedState("/missing.ts", ORIGINAL)).toBeUndefined();
      } finally {
        store.release();
      }
    });
  });

  it("serves rows recorded for the exact content version", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        store.mergeServed("/a.ts", ["aB3", "cD4"], ORIGINAL);
        const lookup = store.getServedState("/a.ts", ORIGINAL);
        expect(lookup).toBeDefined();
        expect((lookup as { served: Set<string> }).served).toEqual(new Set(["aB3", "cD4"]));
      } finally {
        store.release();
      }
    });
  });

  it("marks rows for any other content version stale, even partially", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        store.mergeServed("/a.ts", ["aB3"], ORIGINAL);
        // The same hash is a different line of the changed content, so the
        // checksum differs: the row is stale against the new version.
        expect(contentChecksum(ORIGINAL)).not.toBe(contentChecksum(CHANGED));
        expect(store.getServedState("/a.ts", CHANGED)).toEqual({ stale: true });
      } finally {
        store.release();
      }
    });
  });

  it("replacing the version drops the previous version's rows in the same transaction", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        store.mergeServed("/a.ts", ["aB3", "cD4"], ORIGINAL);
        store.mergeServed("/a.ts", ["eF5"], CHANGED);
        // The changed version owns only its own row; the original version is
        // no longer authorized by anything.
        expect(store.getServedState("/a.ts", CHANGED)).toEqual({ served: new Set(["eF5"]) });
        expect(store.getServedState("/a.ts", ORIGINAL)).toEqual({ stale: true });
        const db = new DatabaseSync(storePath(home), { defensive: false } as never);
        const rows = db.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get("/a.ts") as { n: number };
        db.close();
        expect(rows.n).toBe(1);
      } finally {
        store.release();
      }
    });
  });

  it("treats a row with a malformed hash or missing version as a miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      try {
        store.mergeServed("/a.ts", ["aB3"], ORIGINAL);
        store.release();
        const db = new DatabaseSync(storePath(home), { defensive: false } as never);
        db.prepare("UPDATE served SET hash = ? WHERE owner = ? AND path = ?").run("ZZZZ", "parent", "/a.ts");
        db.close();
        const reopened = await openStore(home);
        try {
          expect(reopened.getServedState("/a.ts", ORIGINAL)).toBeUndefined();
          const check = new DatabaseSync(storePath(home), { defensive: false } as never);
          const remaining = check.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get("/a.ts") as { n: number };
          check.close();
          expect(remaining.n).toBe(0);
        } finally {
          reopened.release();
        }
      } finally {
        // already released above in the happy path branch
      }
    });
  });

  it("keeps the served record after a store reopen", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(home);
      store.mergeServed("/a.ts", ["aB3", "cD4"], ORIGINAL);
      store.release();
      shutdownHashStore();
      const reopened = await openStore(home);
      try {
        expect(reopened.getServedState("/a.ts", ORIGINAL)).toEqual({ served: new Set(["aB3", "cD4"]) });
      } finally {
        reopened.release();
      }
    });
  });
});
