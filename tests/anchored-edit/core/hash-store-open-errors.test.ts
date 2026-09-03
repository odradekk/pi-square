import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  openError: null as Error | null,
  busyOnce: null as Error | null,
  persistentBusy: false,
  runCalls: 0,
  rename: vi.fn(async (from: string, to: string) => {
    void from;
    void to;
  }),
  readFile: vi.fn(async () => {
    const err = new Error("no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
}));

function busyError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  }) as Error;
}

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor() {
      if (state.openError) throw state.openError;
    }
    get isOpen() {
      return true;
    }
    exec() {}
    prepare(sql: string) {
      if (sql.includes("SELECT value FROM meta WHERE key = 'version'")) {
        return { get: () => ({ value: "4" }) };
      }
      if (sql.includes("PRAGMA quick_check")) {
        return { get: () => ({ quick_check: "ok" }) };
      }
      return {
        get: () => undefined,
        all: () => [],
        run: () => {
          state.runCalls++;
          if (state.busyOnce) {
            const err = state.busyOnce;
            if (!state.persistentBusy) state.busyOnce = null;
            throw err;
          }
        },
      };
    }
    close() {}
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    // Quarantine renames the store file synchronously; assert only those,
    // pass every other sync rename through.
    renameSync: (from: string, to: string) => {
      if (/hash-store\.sqlite$/.test(from)) {
        state.rename(from, to);
        return;
      }
      return actual.renameSync(from, to);
    },
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    // The store schema lock (src/anchored-edit/file-lock.ts) renames its lock
    // files through retirement names during normal release; only store-file
    // quarantine renames are asserted, so everything else passes through.
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [from] = args;
      if (typeof from === "string" && /hash-store\.sqlite$/.test(from)) {
        return state.rename(from, args[1] as string);
      }
      return (actual.rename as any)(...args);
    },
    readFile: async (path: Parameters<typeof actual.readFile>[0], ...args: any[]) =>
      String(path).endsWith(".schema.lock") || /[.]retired-|publish-/.test(String(path))
        ? (actual.readFile as any)(path, ...args)
        : state.readFile(),
  };
});

let tmpHome: string;

function storePath(): string {
  return join(tmpHome, "anchored-edit", "hash-store.sqlite");
}

beforeAll(async () => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "hash-store-open-errors-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  const { initHasher } = await import("../../../src/anchored-edit/hashline/hasher");
  await initHasher();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  state.openError = null;
  state.busyOnce = null;
  state.persistentBusy = false;
  state.runCalls = 0;
  vi.clearAllMocks();
});

describe("hash store open error handling", () => {
  it("does not quarantine the store on a busy open error", async () => {
    state.openError = busyError("database is locked");
    const { loadHashStoreAt, shutdownHashStore } = await import("../../../src/anchored-edit/hash-store");
    shutdownHashStore();
    await expect(loadHashStoreAt(storePath(), "parent")).rejects.toThrow(/locked/);
    expect(state.rename).not.toHaveBeenCalled();
  });

  it("does not quarantine the store on a permission open error", async () => {
    state.openError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    }) as Error;
    const { loadHashStoreAt, shutdownHashStore } = await import("../../../src/anchored-edit/hash-store");
    shutdownHashStore();
    await expect(loadHashStoreAt(storePath(), "parent")).rejects.toThrow(/permission denied/);
    expect(state.rename).not.toHaveBeenCalled();
  });

  it("quarantines and rebuilds on a NOTADB open error", async () => {
    state.openError = Object.assign(new Error("file is not a database"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    }) as Error;
    const { loadHashStoreAt, shutdownHashStore } = await import("../../../src/anchored-edit/hash-store");
    shutdownHashStore();
    await expect(loadHashStoreAt(storePath(), "parent")).rejects.toThrow(/not a database/);
    expect(state.rename).toHaveBeenCalledWith(
      expect.stringMatching(/hash-store\.sqlite$/),
      expect.stringMatching(/\.corrupt-/),
    );
  });

  it("retries a transient busy error on statement execution", async () => {
    const { loadHashStoreAt, shutdownHashStore } = await import("../../../src/anchored-edit/hash-store");
    shutdownHashStore();
    const store = await loadHashStoreAt(storePath(), "parent");
    state.busyOnce = busyError("database is locked");
    expect(() => {
      store.upsertSnapshot("/p.ts", "checksum", 1, ["AAA"]);
    }).not.toThrow();
    expect(state.runCalls).toBeGreaterThan(1);
  });

  it("propagates a persistent busy error after exhausting retries", async () => {
    const { loadHashStoreAt, shutdownHashStore } = await import("../../../src/anchored-edit/hash-store");
    shutdownHashStore();
    const store = await loadHashStoreAt(storePath(), "parent");
    state.busyOnce = busyError("database is locked");
    state.persistentBusy = true;
    const callsBefore = state.runCalls;
    expect(() => {
      store.upsertSnapshot("/p.ts", "checksum", 1, ["AAA"]);
    }).toThrow(/locked/);
    expect(state.runCalls - callsBefore).toBe(4);
  });
});

describe("isCorruptionError", () => {
  it("classifies NOTADB, CORRUPT, and FORMAT errcodes as corruption", async () => {
    const { isCorruptionError } = await import("../../../src/anchored-edit/hash-store");
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 26 }))).toBe(true);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 11 }))).toBe(true);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 24 }))).toBe(true);
  });

  it("classifies busy, locked, and permission errors as non-corruption", async () => {
    const { isCorruptionError } = await import("../../../src/anchored-edit/hash-store");
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 5 }))).toBe(false);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 6 }))).toBe(false);
    expect(isCorruptionError(Object.assign(new Error("x"), { errcode: 14 }))).toBe(false);
    expect(isCorruptionError(Object.assign(new Error("EACCES"), { code: "EACCES" }))).toBe(false);
  });

  it("matches corruption by message text", async () => {
    const { isCorruptionError } = await import("../../../src/anchored-edit/hash-store");
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true);
    expect(isCorruptionError(new Error("database is locked"))).toBe(false);
  });
});
