import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import * as hashStore from "../../../src/anchored-edit/hash-store";
import {
  loadHashStoreAt,
  shutdownHashStore,
  isValidHashList,
  SNAPSHOT_CACHE_LIMIT,
  pruneMissing,
  type HashStoreHandle,
} from "../../../src/anchored-edit/hash-store";
import { HASH_STORE_VERSION } from "../../../src/anchored-edit/constants";
import { initHasher, contentChecksum } from "../../../src/anchored-edit/hashline/hasher";
import { splitLines } from "../../../src/anchored-edit/utils";
import { getWritableTempRoot } from "../support/fixtures";

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-hashstore-test-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function openStore(home: string) {
  return loadHashStoreAt(sqlitePath(home), "parent");
}

function configHome(home: string): string {
  return join(home, "anchored-edit");
}

function sqlitePath(home: string): string {
  return join(configHome(home), "hash-store.sqlite");
}

async function put(
  store: HashStoreHandle,
  path: string,
  content: string,
  hashes: string[],
): Promise<void> {
  store.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, hashes);
}
describe("hash-store — loadHashStoreAt", () => {
  it("opens a fresh sqlite database when none exists", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      expect(existsSync(sqlitePath(home))).toBe(true);
      expect(store.getSnapshot("/none.ts", "x\n")).toBeUndefined();
    });
  });

  it("creates the store directory", async () => {
    await withTempHome(async () => {
      await openStore(tmpHome);
      const s = await stat(configHome(tmpHome));
      expect(s.isDirectory()).toBe(true);
    });
  });
});

describe("hash-store — snapshot get / upsert / delete", () => {
  it("round-trips a snapshot by path and content matching checksum", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      const content = "hello\nworld\n";
      const hashes = ["aB3", "xY7"];
      await put(store, "/path/to/file.ts", content, hashes);

      expect(store.getSnapshot("/path/to/file.ts", content)).toEqual(hashes);
    });
  });

  it("returns undefined when content changed (checksum mismatch)", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "aaa\nbbb\n", ["aB3", "xY7"]);

      expect(store.getSnapshot("/p.ts", "aaa\nbbb\n")).toEqual(["aB3", "xY7"]);
      expect(store.getSnapshot("/p.ts", "aaa\nBBB\n")).toBeUndefined();
    });
  });

  it("overwrites an existing path with new content+hashes", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "old\n", ["OPQ"]);
      await put(store, "/p.ts", "new\n", ["NOP"]);

      expect(store.getSnapshot("/p.ts", "old\n")).toBeUndefined();
      expect(store.getSnapshot("/p.ts", "new\n")).toEqual(["NOP"]);
    });
  });

  it("keeps unrelated snapshots intact when upserting another path", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      const aContent = "a\nb\nc\nd\ne\n".repeat(50);
      const aHashes = aContent.split("\n").map((_, i) => i.toString(16).padStart(3, "0"));
      await put(store, "/big.ts", aContent, aHashes);
      await put(store, "/small.ts", "x\n", ["XYZ"]);

      expect(store.getSnapshot("/big.ts", aContent)).toEqual(aHashes);
      expect(store.getSnapshot("/small.ts", "x\n")).toEqual(["XYZ"]);
    });
  });
});

describe("hash-store — corrupt row handling", () => {
  async function corruptHashes(home: string, path: string, value: string): Promise<void> {
    const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
    db.prepare("UPDATE snapshots SET hashes = ? WHERE path = ?").run(value, path);
    db.close();
  }

  it("treats a row with unparseable hashes as a cache miss", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", "not json");
      shutdownHashStore();
      const reloaded = await openStore(tmpHome);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
      reloaded.upsertSnapshot("/p.ts", contentChecksum("x\n"), 1, ["BBB"]);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["BBB"]);
    });
  });

  it("treats a row with non-string hashes as a cache miss", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", "[1,2]");
      shutdownHashStore();
      const reloaded = await openStore(tmpHome);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
    });
  });

  it("treats a row with malformed hash strings as a cache miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
      shutdownHashStore();
      const reloaded = await openStore(tmpHome);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?").get("/p.ts") as { n: number };
      db.close();
      expect(remaining.n).toBe(0);
    });
  });
});

describe("hash-store — pruneMissing", () => {
  it("removes snapshots for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      await put(store, "/gone.ts", "old\n", ["ZZZ"]);
      await pruneMissing(store);
      expect(store.getSnapshot("/gone.ts", "old\n")).toBeUndefined();
    });
  });

  it("keeps snapshots for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");

      const store = await openStore(tmpHome);
      await put(store, existing, "keep\n", ["KEP"]);
      await put(store, "/gone.ts", "gone\n", ["GON"]);
      await pruneMissing(store);

      expect(store.getSnapshot(existing, "keep\n")).toEqual(["KEP"]);
      expect(store.getSnapshot("/gone.ts", "gone\n")).toBeUndefined();
    });
  });

  it("prunes against live rows, not a stale snapshot", async () => {
    await withTempHome(async (home) => {
      const keep = join(home, "keep.ts");
      const grown = join(home, "grow.ts");
      await writeFile(keep, "keep\n", "utf-8");
      await writeFile(grown, "grow\n", "utf-8");

      const store = await openStore(tmpHome);
      await put(store, keep, "keep\n", ["KEP"]);
      await put(store, "/gone.ts", "gone\n", ["GON"]);
      await put(store, grown, "grow\n", ["GRW"]);
      await pruneMissing(store);

      expect(store.getSnapshot(keep, "keep\n")).toEqual(["KEP"]);
      expect(store.getSnapshot(grown, "grow\n")).toEqual(["GRW"]);
      expect(store.getSnapshot("/gone.ts", "gone\n")).toBeUndefined();
    });
  });

  it("prunes across multiple stat batches", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      const existing: { path: string; hash: string }[] = [];
      for (let i = 0; i < 70; i++) {
        const path = join(home, `keep-${i}.ts`);
        await writeFile(path, "keep\n", "utf-8");
        const hash = `K${String(i).padStart(2, "0")}`;
        await put(store, path, "keep\n", [hash]);
        existing.push({ path, hash });
      }
      for (let i = 0; i < 70; i++) {
        await put(store, `/gone-${i}.ts`, "gone\n", [`G${String(i).padStart(2, "0")}`]);
      }
      await pruneMissing(store);
      for (const entry of existing) {
        expect(store.getSnapshot(entry.path, "keep\n")).toEqual([entry.hash]);
      }
      for (let i = 0; i < 70; i++) {
        expect(store.getSnapshot(`/gone-${i}.ts`, "gone\n")).toBeUndefined();
      }
    });
  });
});

describe("hash-store — concurrency (issue #10)", () => {
  it("preserves snapshots written by a separately-opened connection", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/a.ts", "alpha\n", ["AAB"]);

      const second = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const ins = second.prepare(
        "INSERT INTO snapshots (owner, path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      second.exec("BEGIN IMMEDIATE");
      ins.run("parent", "/b.ts", contentChecksum("beta\n"), splitLines("beta\n").length, JSON.stringify(["BBC"]), Date.now());
      second.exec("COMMIT");
      second.close();
      shutdownHashStore();
      const reloaded = await openStore(tmpHome);
      expect(reloaded.getSnapshot("/a.ts", "alpha\n")).toEqual(["AAB"]);
      expect(reloaded.getSnapshot("/b.ts", "beta\n")).toEqual(["BBC"]);
    });
  });

  it("a fresh reopen sees snapshots written by a prior session", async () => {
    await withTempHome(async () => {
      const a = await openStore(tmpHome);
      await put(a, "/first.ts", "one\n", ["111"]);
      shutdownHashStore();

      const b = await openStore(tmpHome);
      await put(b, "/second.ts", "two\n", ["222"]);
      shutdownHashStore();

      const c = await openStore(tmpHome);
      expect(c.getSnapshot("/first.ts", "one\n")).toEqual(["111"]);
      expect(c.getSnapshot("/second.ts", "two\n")).toEqual(["222"]);
    });
  });
});

describe("hash-store — incremental writes (issue #8)", () => {
  it("upserting a new path does not alter an existing path's stored hashes", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      const bigContent = "x\n".repeat(2000);
      const bigHashes = bigContent.split("\n").map((_, i) => i.toString(16).padStart(3, "0"));
      await put(store, "/big.ts", bigContent, bigHashes);
      const before = store.getSnapshot("/big.ts", bigContent);

      await put(store, "/other.ts", "y\n", ["YYZ"]);

      expect(store.getSnapshot("/big.ts", bigContent)).toEqual(before);
    });
  });
});

describe("hash-store — WAL checkpoint on shutdown", () => {
  it("truncates the WAL file after shutdownHashStore", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);

      const walPath = sqlitePath(home) + "-wal";
      expect(existsSync(walPath)).toBe(true);

      shutdownHashStore();

      expect(existsSync(walPath)).toBe(false);
    });
  });
});

describe("hash-store — corrupt database recovery", () => {
  it("rebuilds the store when the database file is corrupt", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      await writeFile(sqlitePath(home), "this is not a sqlite database", "utf-8");

      const store = await openStore(tmpHome);
      expect(store.getSnapshot("/x.ts", "a\n")).toBeUndefined();

      store.upsertSnapshot("/x.ts", contentChecksum("a\n"), 1, ["AAA"]);
      expect(store.getSnapshot("/x.ts", "a\n")).toEqual(["AAA"]);
    });
  });

  it("quarantines the corrupt file instead of deleting it", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      await writeFile(sqlitePath(home), "garbage bytes", "utf-8");

      await openStore(tmpHome);

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
      expect(existsSync(sqlitePath(home))).toBe(true);
    });
  });

  it("keeps working when the store is healthy", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      store.upsertSnapshot("/p.ts", contentChecksum("b\n"), 1, ["BBB"]);
      expect(store.getSnapshot("/p.ts", "b\n")).toEqual(["BBB"]);
      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });
});

describe("hash-store — schema versioning", () => {
  it("writes the current version on first open", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      db.close();

      expect(row?.value).toBe(String(HASH_STORE_VERSION));
    });
  });

  it("keeps snapshots when the stored version matches", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const reloaded = await openStore(tmpHome);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
    });
  });

  it("quarantines an older-schema store and rebuilds it fresh (#187)", async () => {
    await withTempHome(async (home) => {
      // Simulate a v5 store: current-era tables plus an undo table and rows.
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const legacy = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      legacy.exec(
        "CREATE TABLE undo (path TEXT PRIMARY KEY, content TEXT NOT NULL, bom TEXT NOT NULL, " +
        "ending TEXT NOT NULL, hashes TEXT NOT NULL, result_content TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      legacy.prepare("UPDATE meta SET value = '5' WHERE key = 'version'").run();
      legacy.close();

      const reloaded = await openStore(tmpHome);
      // Cached snapshot and served state loss is explicit: nothing survives.
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();

      const fresh = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const versionRow = fresh.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      const undoTable = fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'undo'").get();
      const snapshotRows = fresh.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
      fresh.close();
      expect(versionRow?.value).toBe(String(HASH_STORE_VERSION));
      expect(undoTable).toBeUndefined();
      expect(snapshotRows.n).toBe(0);

      // The old database was quarantined exactly once, with its old rows.
      const entries = await readdir(configHome(home));
      const quarantined = entries.filter((name) => name.includes(".old-schema-"));
      expect(quarantined.length).toBe(1);
      const old = new DatabaseSync(join(configHome(home), quarantined[0]), { defensive: false } as any);
      const oldVersion = old.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      expect(oldVersion?.value).toBe("5");
      const oldRows = old.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
      old.close();
      expect(oldRows.n).toBe(1);
    });
  });

  it("quarantines an undo-bearing pre-versioning database (#187)", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const legacy = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      legacy.exec("DROP TABLE meta");
      // An old (pre-versioning) store still carried the undo table.
      legacy.exec("CREATE TABLE undo (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
      legacy.close();

      const reloaded = await openStore(tmpHome);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".old-schema-"))).toBe(true);
    });
  });

  it("quarantines once and reopens fresh beside crash residue (#187)", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const legacy = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      legacy.prepare("UPDATE meta SET value = '4' WHERE key = 'version'").run();
      legacy.close();
      // Simulated crash residue: stale sidecar files beside the database. The
      // quarantine loop moves the sidecars best-effort; SQLite WAL recovery on
      // open may already have discarded them, which the loop tolerates.
      await writeFile(`${sqlitePath(home)}-wal`, "stale-wal", "utf-8");
      await writeFile(`${sqlitePath(home)}-shm`, "stale-shm", "utf-8");

      const reloaded = await openStore(tmpHome);
      const entries = await readdir(configHome(home));
      const db = sqlitePath(home).split(/[\\/]/).pop()!;
      expect(entries.filter((name) => name.startsWith(`${db}.old-schema-`)).length).toBe(1);
      // Whatever happened to the sidecars, the fresh store is usable.
      await put(reloaded, "/q.ts", "y\n", ["QRS"]);
      expect(reloaded.getSnapshot("/q.ts", "y\n")).toEqual(["QRS"]);
      expect(reloaded.getSnapshot("/p.ts", "x\n")).toBeUndefined();
    });
  });

  it("serializes concurrent first opens across owner partitions (#187)", async () => {
    await withTempHome(async (home) => {
      const path = sqlitePath(home);
      const initial = await loadHashStoreAt(path, "parent");
      await put(initial, "/p.ts", "x\n", ["XYZ"]);
      initial.release();
      shutdownHashStore();

      const legacy = new DatabaseSync(path, { defensive: false } as any);
      legacy.exec(
        "CREATE TABLE undo (owner TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, " +
        "PRIMARY KEY(owner, path))",
      );
      legacy.prepare("UPDATE meta SET value = '5' WHERE key = 'version'").run();
      legacy.close();

      const [parent, child] = await Promise.all([
        loadHashStoreAt(path, "parent"),
        loadHashStoreAt(path, "subagent_00000000-0000-4000-8000-000000000001"),
      ]);
      try {
        parent.upsertSnapshot("/parent.ts", contentChecksum("p\n"), 1, ["PAR"]);
        child.upsertSnapshot("/child.ts", contentChecksum("c\n"), 1, ["CHD"]);
        expect(parent.getSnapshot("/parent.ts", "p\n")).toEqual(["PAR"]);
        expect(child.getSnapshot("/child.ts", "c\n")).toEqual(["CHD"]);
      } finally {
        parent.release();
        child.release();
      }

      const entries = await readdir(configHome(home));
      expect(entries.filter((name) => name.includes(".old-schema-")).length).toBe(1);
      const fresh = new DatabaseSync(path, { defensive: false } as any);
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'undo'").get()).toBeUndefined();
      expect(fresh.prepare("SELECT COUNT(*) AS n FROM snapshots").get()).toEqual({ n: 2 });
      fresh.close();
    });
  });

  it("a fresh store produces no migration residue (#187)", async () => {
    await withTempHome(async (home) => {
      const store = await openStore(tmpHome);
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      expect(store.getSnapshot("/p.ts", "x\n")).toEqual(["XYZ"]);
      shutdownHashStore();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".old-schema-"))).toBe(false);
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
      const fresh = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const undoTable = fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'undo'").get();
      fresh.close();
      expect(undoTable).toBeUndefined();
    });
  });
});

describe("hash-store — isValidHashList", () => {
  it("accepts a unique list of valid hashes", () => {
    expect(isValidHashList(["aB3", "xY7", "Zz9"])).toBe(true);
    expect(isValidHashList([])).toBe(true);
  });

  it("rejects duplicate hashes", () => {
    expect(isValidHashList(["aB3", "aB3"])).toBe(false);
    expect(isValidHashList(["aB3", "xY7", "aB3"])).toBe(false);
  });

  it("rejects malformed or non-string entries", () => {
    expect(isValidHashList(["aB3", "ZZ"])).toBe(false);
    expect(isValidHashList(["aB3", 42])).toBe(false);
    expect(isValidHashList("aB3")).toBe(false);
    expect(isValidHashList(null)).toBe(false);
  });
});

describe("hash-store — snapshot cache", () => {
  it("serves repeated reads from memory without touching the database", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      const checksum = contentChecksum("a\nb\n");
      store.upsertSnapshot("/cache-hit.ts", checksum, 2, ["AAA", "BBB"]);
      const getSpy = vi.spyOn(hashStore.__testables.storeEntryOf(store).stmts, "getSnapshot");
      expect(store.getSnapshot("/cache-hit.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);
      expect(store.getSnapshot("/cache-hit.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);
      expect(getSpy).not.toHaveBeenCalled();
      getSpy.mockRestore();
    });
  });

  it("evicts least-recently-used entries beyond the cache limit", async () => {
    await withTempHome(async () => {
      const store = await openStore(tmpHome);
      const checksum = contentChecksum("x");
      for (let i = 0; i < SNAPSHOT_CACHE_LIMIT; i++) {
        store.upsertSnapshot(`/lru-${i}.ts`, checksum, 1, ["AAA"]);
      }
      expect(store.getSnapshot("/lru-0.ts", "x")).toEqual(["AAA"]);
      store.upsertSnapshot("/lru-extra.ts", checksum, 1, ["AAA"]);
      const getSpy = vi.spyOn(hashStore.__testables.storeEntryOf(store).stmts, "getSnapshot");
      expect(store.getSnapshot("/lru-0.ts", "x")).toEqual(["AAA"]);
      expect(getSpy).not.toHaveBeenCalled();
      getSpy.mockClear();
      expect(store.getSnapshot("/lru-1.ts", "x")).toEqual(["AAA"]);
      expect(getSpy).toHaveBeenCalled();
      getSpy.mockRestore();
    });
  });

  it("returns an independent copy so caller mutation cannot poison the cache", async () => {
    await withTempHome(async () => {
      let store = await openStore(tmpHome);
      const checksum = contentChecksum("a\nb\n");
      store.upsertSnapshot("/mutable.ts", checksum, 2, ["AAA", "BBB"]);

      const cachedHit = store.getSnapshot("/mutable.ts", "a\nb\n")!;
      cachedHit[0] = "ZZZ";
      expect(store.getSnapshot("/mutable.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);

      shutdownHashStore();
      store = await openStore(tmpHome);
      const dbHit = store.getSnapshot("/mutable.ts", "a\nb\n")!;
      dbHit[1] = "YYY";
      expect(store.getSnapshot("/mutable.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);
    });
  });
});
