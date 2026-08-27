import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import {
  loadHashStore,
  shutdownHashStore,
  getSnapshot,
  upsertSnapshot,
  isValidHashList,
  SNAPSHOT_CACHE_LIMIT,
  pruneMissing,
  type HashStore,
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

function configHome(home: string): string {
  return join(home, ".config", "pi-hashline-edit-pro");
}

function sqlitePath(home: string): string {
  return join(configHome(home), "hash-store.sqlite");
}

function legacyPath(home: string): string {
  return join(configHome(home), "hash-store.json");
}

async function put(
  store: HashStore,
  path: string,
  content: string,
  hashes: string[],
): Promise<void> {
  upsertSnapshot(store, path, contentChecksum(content), splitLines(content).length, hashes);
}
async function writeLegacyStore(home: string, snapshots: unknown): Promise<void> {
  await mkdir(configHome(home), { recursive: true });
  await writeFile(legacyPath(home), JSON.stringify({ version: 1, snapshots }), "utf-8");
}

describe("hash-store — loadHashStore", () => {
  it("opens a fresh sqlite database when none exists", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      expect(existsSync(sqlitePath(home))).toBe(true);
      expect(getSnapshot(store, "/none.ts", "x\n")).toBeUndefined();
    });
  });

  it("creates the config directory", async () => {
    await withTempHome(async () => {
      await loadHashStore();
      const s = await stat(configHome(tmpHome));
      expect(s.isDirectory()).toBe(true);
    });
  });
});

describe("hash-store — snapshot get / upsert / delete", () => {
  it("round-trips a snapshot by path and content matching checksum", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const content = "hello\nworld\n";
      const hashes = ["aB3", "xY7"];
      await put(store, "/path/to/file.ts", content, hashes);

      expect(getSnapshot(store, "/path/to/file.ts", content)).toEqual(hashes);
    });
  });

  it("returns undefined when content changed (checksum mismatch)", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "aaa\nbbb\n", ["aB3", "xY7"]);

      expect(getSnapshot(store, "/p.ts", "aaa\nbbb\n")).toEqual(["aB3", "xY7"]);
      expect(getSnapshot(store, "/p.ts", "aaa\nBBB\n")).toBeUndefined();
    });
  });

  it("overwrites an existing path with new content+hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "old\n", ["OPQ"]);
      await put(store, "/p.ts", "new\n", ["NOP"]);

      expect(getSnapshot(store, "/p.ts", "old\n")).toBeUndefined();
      expect(getSnapshot(store, "/p.ts", "new\n")).toEqual(["NOP"]);
    });
  });

  it("keeps unrelated snapshots intact when upserting another path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const aContent = "a\nb\nc\nd\ne\n".repeat(50);
      const aHashes = aContent.split("\n").map((_, i) => i.toString(16).padStart(3, "0"));
      await put(store, "/big.ts", aContent, aHashes);
      await put(store, "/small.ts", "x\n", ["XYZ"]);

      expect(getSnapshot(store, "/big.ts", aContent)).toEqual(aHashes);
      expect(getSnapshot(store, "/small.ts", "x\n")).toEqual(["XYZ"]);
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
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", "not json");
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
      upsertSnapshot(reloaded, "/p.ts", contentChecksum("x\n"), 1, ["BBB"]);
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["BBB"]);
    });
  });

  it("treats a row with non-string hashes as a cache miss", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", "[1,2]");
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
    });
  });

  it("treats a row with malformed hash strings as a cache miss and deletes it", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["AAA"]);
      await corruptHashes(home, "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
      const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?").get("/p.ts") as { n: number };
      db.close();
      expect(remaining.n).toBe(0);
    });
  });
});

describe("hash-store — migration from legacy hash-store.json", () => {
  it("imports valid legacy snapshots and renames the file to .bak", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
        "/also.ts": { content: "good\nmore\n", hashes: ["XYZ", "QWE"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
      expect(getSnapshot(store, "/also.ts", "good\nmore\n")).toEqual(["XYZ", "QWE"]);
      expect(existsSync(legacyPath(home))).toBe(false);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
    });
  });

  it("drops structurally invalid legacy entries, keeps valid ones", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
        "/missing-hashes.ts": { content: "x\n" },
        "/null-content.ts": { content: null, hashes: ["DEF"] },
        "/hashes-not-array.ts": { content: "y\n", hashes: "not-an-array" },
        "/hash-not-string.ts": { content: "z\n", hashes: [42] },
        "/also-valid.ts": { content: "good\n", hashes: ["XYZ"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
      expect(getSnapshot(store, "/also-valid.ts", "good\n")).toEqual(["XYZ"]);
      expect(getSnapshot(store, "/missing-hashes.ts", "x\n")).toBeUndefined();
      expect(getSnapshot(store, "/null-content.ts", "")).toBeUndefined();
      expect(getSnapshot(store, "/hashes-not-array.ts", "y\n")).toBeUndefined();
      expect(getSnapshot(store, "/hash-not-string.ts", "z\n")).toBeUndefined();
    });
  });

  it("skips legacy snapshots with duplicate hashes so they re-hash on next read", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/dup.ts": { content: "a\nb\n", hashes: ["AAA", "AAA"] },
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/dup.ts", "a\nb\n")).toBeUndefined();
      expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
    });
  });

  it("warns when skipping a legacy snapshot with duplicate hashes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        await writeLegacyStore(home, {
          "/dup.ts": { content: "a\nb\n", hashes: ["AAA", "AAA"] },
          "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
        });

        const store = await loadHashStore();

        expect(warnSpy).toHaveBeenCalledWith(
          "Skipped legacy snapshot with duplicate hashes for /dup.ts; it will be re-hashed on next read.",
        );
        expect(getSnapshot(store, "/dup.ts", "a\nb\n")).toBeUndefined();
        expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips legacy snapshots with malformed hashes so they re-hash on next read", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/bad.ts": { content: "x\n", hashes: ["ZZ", "ZZZZ"] },
        "/valid.ts": { content: "ok\n", hashes: ["ABC"] },
      });

      const store = await loadHashStore();

      expect(getSnapshot(store, "/bad.ts", "x\n")).toBeUndefined();
      expect(getSnapshot(store, "/valid.ts", "ok\n")).toEqual(["ABC"]);
    });
  });

  it("ignores a legacy snapshots field that is an array", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, ["not-an-object"]);

      const store = await loadHashStore();
      const paths = store.stmts.allPaths();
      expect(paths).toEqual([]);
    });
  });

  it("does not run migration when no legacy file exists", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      expect(store.stmts.allPaths()).toEqual([]);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(false);
    });
  });

  it("migrates only once even if legacy file reappears", async () => {
    await withTempHome(async (home) => {
      await writeLegacyStore(home, {
        "/one.ts": { content: "1\n", hashes: ["AAA"] },
      });
      const first = await loadHashStore();
      expect(getSnapshot(first, "/one.ts", "1\n")).toEqual(["AAA"]);
      expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);

      await writeFile(legacyPath(home), JSON.stringify({
        version: 1,
        snapshots: { "/two.ts": { content: "2\n", hashes: ["BBB"] } },
      }), "utf-8");

      const second = await loadHashStore();
      expect(getSnapshot(second, "/two.ts", "2\n")).toBeUndefined();
      expect(getSnapshot(second, "/one.ts", "1\n")).toEqual(["AAA"]);
    });
  });
});

describe("hash-store — pruneMissing", () => {
  it("removes snapshots for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      await put(store, "/gone.ts", "old\n", ["ZZZ"]);
      await pruneMissing(store);
      expect(getSnapshot(store, "/gone.ts", "old\n")).toBeUndefined();
    });
  });

  it("keeps snapshots for files that still exist", async () => {
    await withTempHome(async (home) => {
      const existing = join(home, "keep.ts");
      await writeFile(existing, "keep\n", "utf-8");

      const store = await loadHashStore();
      await put(store, existing, "keep\n", ["KEP"]);
      await put(store, "/gone.ts", "gone\n", ["GON"]);
      await pruneMissing(store);

      expect(getSnapshot(store, existing, "keep\n")).toEqual(["KEP"]);
      expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
    });
  });

  it("prunes against live rows, not a stale snapshot", async () => {
    await withTempHome(async (home) => {
      const keep = join(home, "keep.ts");
      const grown = join(home, "grow.ts");
      await writeFile(keep, "keep\n", "utf-8");
      await writeFile(grown, "grow\n", "utf-8");

      const store = await loadHashStore();
      await put(store, keep, "keep\n", ["KEP"]);
      await put(store, "/gone.ts", "gone\n", ["GON"]);
      await put(store, grown, "grow\n", ["GRW"]);
      await pruneMissing(store);

      expect(getSnapshot(store, keep, "keep\n")).toEqual(["KEP"]);
      expect(getSnapshot(store, grown, "grow\n")).toEqual(["GRW"]);
      expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
    });
  });

  it("prunes across multiple stat batches", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
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
        expect(getSnapshot(store, entry.path, "keep\n")).toEqual([entry.hash]);
      }
      for (let i = 0; i < 70; i++) {
        expect(getSnapshot(store, `/gone-${i}.ts`, "gone\n")).toBeUndefined();
      }
    });
  });
});

describe("hash-store — concurrency (issue #10)", () => {
  it("preserves snapshots written by a separately-opened connection", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/a.ts", "alpha\n", ["AAB"]);

      const second = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      const ins = second.prepare(
        "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      second.exec("BEGIN IMMEDIATE");
      ins.run("/b.ts", contentChecksum("beta\n"), splitLines("beta\n").length, JSON.stringify(["BBC"]), Date.now());
      second.exec("COMMIT");
      second.close();
      shutdownHashStore();
      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/a.ts", "alpha\n")).toEqual(["AAB"]);
      expect(getSnapshot(reloaded, "/b.ts", "beta\n")).toEqual(["BBC"]);
    });
  });

  it("a fresh reopen sees snapshots written by a prior session", async () => {
    await withTempHome(async () => {
      const a = await loadHashStore();
      await put(a, "/first.ts", "one\n", ["111"]);
      shutdownHashStore();

      const b = await loadHashStore();
      await put(b, "/second.ts", "two\n", ["222"]);
      shutdownHashStore();

      const c = await loadHashStore();
      expect(getSnapshot(c, "/first.ts", "one\n")).toEqual(["111"]);
      expect(getSnapshot(c, "/second.ts", "two\n")).toEqual(["222"]);
    });
  });
});

describe("hash-store — incremental writes (issue #8)", () => {
  it("upserting a new path does not alter an existing path's stored hashes", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const bigContent = "x\n".repeat(2000);
      const bigHashes = bigContent.split("\n").map((_, i) => i.toString(16).padStart(3, "0"));
      await put(store, "/big.ts", bigContent, bigHashes);
      const before = getSnapshot(store, "/big.ts", bigContent);

      await put(store, "/other.ts", "y\n", ["YYZ"]);

      expect(getSnapshot(store, "/big.ts", bigContent)).toEqual(before);
    });
  });
});

describe("hash-store — WAL checkpoint on shutdown", () => {
  it("truncates the WAL file after shutdownHashStore", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
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

      const store = await loadHashStore();
      expect(getSnapshot(store, "/x.ts", "a\n")).toBeUndefined();

      upsertSnapshot(store, "/x.ts", contentChecksum("a\n"), 1, ["AAA"]);
      expect(getSnapshot(store, "/x.ts", "a\n")).toEqual(["AAA"]);
    });
  });

  it("quarantines the corrupt file instead of deleting it", async () => {
    await withTempHome(async (home) => {
      await mkdir(configHome(home), { recursive: true });
      await writeFile(sqlitePath(home), "garbage bytes", "utf-8");

      await loadHashStore();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
      expect(existsSync(sqlitePath(home))).toBe(true);
    });
  });

  it("keeps working when the store is healthy", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      upsertSnapshot(store, "/p.ts", contentChecksum("b\n"), 1, ["BBB"]);
      expect(getSnapshot(store, "/p.ts", "b\n")).toEqual(["BBB"]);
      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    });
  });
});

describe("hash-store — schema versioning", () => {
  it("writes the current version on first open", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
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
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toEqual(["XYZ"]);
    });
  });

  it("quarantines an older-schema store and rebuilds it fresh (#187)", async () => {
    await withTempHome(async (home) => {
      // Simulate a v5 store: current-era tables plus an undo table and rows.
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const legacy = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      legacy.exec(
        "CREATE TABLE undo (path TEXT PRIMARY KEY, content TEXT NOT NULL, bom TEXT NOT NULL, " +
        "ending TEXT NOT NULL, hashes TEXT NOT NULL, result_content TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      legacy.prepare("UPDATE meta SET value = '5' WHERE key = 'version'").run();
      legacy.close();

      const reloaded = await loadHashStore();
      // Cached snapshot and served state loss is explicit: nothing survives.
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();

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
      const oldRows = old.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
      old.close();
      expect(oldRows.n).toBe(1);
    });
  });

  it("quarantines an undo-bearing pre-versioning database (#187)", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      shutdownHashStore();

      const legacy = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
      legacy.exec("DROP TABLE meta");
      // An old (pre-versioning) store still carried the undo table.
      legacy.exec("CREATE TABLE undo (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
      legacy.close();

      const reloaded = await loadHashStore();
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();

      const entries = await readdir(configHome(home));
      expect(entries.some((name) => name.includes(".old-schema-"))).toBe(true);
    });
  });

  it("quarantines once and reopens fresh beside crash residue (#187)", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
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

      const reloaded = await loadHashStore();
      const entries = await readdir(configHome(home));
      const db = sqlitePath(home).split(/[\\/]/).pop()!;
      expect(entries.filter((name) => name.startsWith(`${db}.old-schema-`)).length).toBe(1);
      // Whatever happened to the sidecars, the fresh store is usable.
      await put(reloaded, "/q.ts", "y\n", ["QRS"]);
      expect(getSnapshot(reloaded, "/q.ts", "y\n")).toEqual(["QRS"]);
      expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
    });
  });

  it("a fresh store produces no migration residue (#187)", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      await put(store, "/p.ts", "x\n", ["XYZ"]);
      expect(getSnapshot(store, "/p.ts", "x\n")).toEqual(["XYZ"]);
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
      const store = await loadHashStore();
      const checksum = contentChecksum("a\nb\n");
      upsertSnapshot(store, "/cache-hit.ts", checksum, 2, ["AAA", "BBB"]);
      const getSpy = vi.spyOn(store.stmts, "get");
      expect(getSnapshot(store, "/cache-hit.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);
      expect(getSnapshot(store, "/cache-hit.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);
      expect(getSpy).not.toHaveBeenCalled();
      getSpy.mockRestore();
    });
  });

  it("evicts least-recently-used entries beyond the cache limit", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const checksum = contentChecksum("x");
      for (let i = 0; i < SNAPSHOT_CACHE_LIMIT; i++) {
        upsertSnapshot(store, `/lru-${i}.ts`, checksum, 1, ["AAA"]);
      }
      expect(getSnapshot(store, "/lru-0.ts", "x")).toEqual(["AAA"]);
      upsertSnapshot(store, "/lru-extra.ts", checksum, 1, ["AAA"]);
      const getSpy = vi.spyOn(store.stmts, "get");
      expect(getSnapshot(store, "/lru-0.ts", "x")).toEqual(["AAA"]);
      expect(getSpy).not.toHaveBeenCalled();
      getSpy.mockClear();
      expect(getSnapshot(store, "/lru-1.ts", "x")).toEqual(["AAA"]);
      expect(getSpy).toHaveBeenCalled();
      getSpy.mockRestore();
    });
  });

  it("returns an independent copy so caller mutation cannot poison the cache", async () => {
    await withTempHome(async () => {
      let store = await loadHashStore();
      const checksum = contentChecksum("a\nb\n");
      upsertSnapshot(store, "/mutable.ts", checksum, 2, ["AAA", "BBB"]);

      const cachedHit = getSnapshot(store, "/mutable.ts", "a\nb\n")!;
      cachedHit[0] = "ZZZ";
      expect(getSnapshot(store, "/mutable.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);

      shutdownHashStore();
      store = await loadHashStore();
      const dbHit = getSnapshot(store, "/mutable.ts", "a\nb\n")!;
      dbHit[1] = "YYY";
      expect(getSnapshot(store, "/mutable.ts", "a\nb\n")).toEqual(["AAA", "BBB"]);
    });
  });
});
