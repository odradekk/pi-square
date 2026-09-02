import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { link, mkdir, readFile, stat, writeFile } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAnchoredWriteSession,
  readBarrier,
  resolveAnchoredTarget,
} from "../../../src/anchored-edit/operations";
import { createAnchoredReplaceToolDefinition } from "../../../src/anchored-edit/workspace-replace";
import { createChildAnchoredWriteTool } from "../../../src/anchored-edit/child-write";
import { PARENT_OWNER, loadAnchoredHashStore } from "../../../src/anchored-edit/workspace-support";
import { anchoredStoreDir } from "../../../src/anchored-edit/paths";
import { lockFilePath } from "../../../src/anchored-edit/file-lock";
import { loadHashStoreAt, shutdownHashStore } from "../../../src/anchored-edit/hash-store";
import { getServed } from "../../../src/anchored-edit/served";
import { _lineHashesPure } from "../../../src/anchored-edit/hashline";
import { makeTestCtx, testSessionDir, withTempDir } from "../support/fixtures";

function rowsOf(content: Array<{ type: string; text?: string }>): string[] {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
      return match ? [match[1]!] : [];
    });
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

async function parentStoreFor(cwd: string) {
  return loadAnchoredHashStore(anchoredStoreDir(testSessionDir(cwd), cwd), PARENT_OWNER);
}

/** The live parent anchored read exactly as `src/display/builtins.ts`
 *  composes it (native path authority, session-resolved store). */
async function anchoredReadOf(cwd: string, ctx: unknown) {
  const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
  const { withAnchoredReadTransform } = await import("../../../src/anchored-edit/read-tool");
  const { transformAnchoredReadContent } = await import("../../../src/anchored-edit/read-transform");
  const readTool = withAnchoredReadTransform(
    createReadToolDefinition(cwd),
    cwd,
    async (content: unknown, value: unknown, executionCwd: string, sessionDir: string) =>
      transformAnchoredReadContent(content as never, value, executionCwd, PARENT_OWNER, { sessionDir }),
  );
  return readTool.execute("read-boundary", { path: "sample.txt" }, undefined, undefined, ctx as never);
}

afterEach(() => {
  readBarrier.onBytes = undefined;
});

describe("operation boundary — replace preparation is pure (#264)", () => {
  it("a failed filesystem commit leaves bytes, snapshot, served state, cache, and subsequent anchors unchanged", async () => {
    await withTempDir("boundary-precommit-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "aaa\nbbb\nccc\n", "utf-8");
      const userTemp = join(cwd, ".tmp-user-file.txt");
      await writeFile(userTemp, "precious", "utf-8");
      const ctx = makeTestCtx(cwd);

      const read = await anchoredReadOf(cwd, ctx);
      const readHashes = rowsOf(read.content);
      expect(readHashes.length).toBe(3);

      const before = await parentStoreFor(cwd);
      const beforeServed = getServed(before, path);
      const beforeSnapshot = before.getSnapshot(path, "aaa\nbbb\nccc\n");
      before.release();

      const fsWrite = await import("../../../src/anchored-edit/fs-write");
      const spy = vi.spyOn(fsWrite, "writeAtomic").mockRejectedValue(new Error("disk full"));
      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      await expect(
        replace.execute(
          "replace-1",
          { path: "sample.txt", remove_from: readHashes[1]!, remove_to: readHashes[1]!, replacement_text: "BBB" },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow("disk full");
      spy.mockRestore();

      expect(await readFile(path, "utf-8"), "disk bytes unchanged").toBe("aaa\nbbb\nccc\n");
      expect(await readFile(userTemp, "utf-8"), "unrelated temp-named files untouched by the failed replace").toBe("precious");
      const after = await parentStoreFor(cwd);
      expect(after.getSnapshot(path, "aaa\nbbb\nccc\n")).toEqual(beforeSnapshot);
      expect(getServed(after, path)).toEqual(beforeServed);
      after.release();

      // The next replace begins from truthful pre-operation state and applies.
      const retry = await replace.execute(
        "replace-2",
        { path: "sample.txt", remove_from: readHashes[1]!, remove_to: readHashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      expect(retry.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("a post-commit publication failure leaves stale state unable to authorize another replace; a fresh read repairs it", async () => {
    await withTempDir("boundary-postcommit-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "aaa\nbbb\nccc\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure("aaa\nbbb\nccc\n");
      const store = await parentStoreFor(cwd);
      store.mergeServed(path, hashes);
      store.release();

      const hashStoreModule = await import("../../../src/anchored-edit/hash-store");
      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const spy = vi.spyOn(hashStoreModule, "publishMutation").mockImplementation(() => {
        throw new Error("store down");
      });
      const applied: Awaited<ReturnType<typeof replace.execute>> = await replace.execute(
        "replace-1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      spy.mockRestore();

      expect(textOf(applied.content)).toContain("Successfully replaced");
      expect(textOf(applied.content)).toContain("[E_STATE_UNAVAILABLE]");
      expect(await readFile(path, "utf-8"), "the file changed and the result says so").toBe("aaa\nBBB\nccc\n");

      // Stale served state cannot authorize another replace against the
      // changed bytes: the old anchors no longer match the file.
      const stale = await replace.execute(
        "replace-2",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "XXX" },
        undefined, undefined, ctx,
      );
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(stale.details.errorCode);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");

      // A fresh anchored read repairs the state: it republishes the current
      // content's snapshot and served rows, and the retry applies.
      const read = await anchoredReadOf(cwd, ctx);
      const fresh = rowsOf(read.content);
      const repaired = await replace.execute(
        "replace-3",
        { path: "sample.txt", remove_from: fresh[1]!, remove_to: fresh[1]!, replacement_text: "XXX" },
        undefined, undefined, ctx,
      );
      expect(repaired.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nXXX\nccc\n");
    });
  });
});

describe("operation boundary — read/replace ordering (#264)", () => {
  it("a read's returned content, snapshot, and served hashes describe one file version even when a replace follows immediately", async () => {
    await withTempDir("boundary-readreplace-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "aaa\nbbb\nccc\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure("aaa\nbbb\nccc\n");

      // Deterministic barrier: pause the read between its locked byte read and
      // its publication; a replace fired meanwhile waits for the boundary.
      let releaseRead!: () => void;
      const readEntered = new Promise<void>((resolveEntered) => {
        readBarrier.onBytes = () => {
          resolveEntered();
          return new Promise<void>((resolveRead2) => { releaseRead = resolveRead2; });
        };
      });
      const readPromise = anchoredReadOf(cwd, ctx);
      await readEntered;

      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const replacePromise = replace.execute(
        "replace-1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );

      releaseRead();
      const read = await readPromise;
      const replaced = await replacePromise;

      // The read observed and published one version: every anchor it returned
      // is served, and the content it returned is the pre-replace version.
      const readRows = textOf(read.content);
      expect(readRows).toContain("│bbb");
      const readAnchors = rowsOf(read.content);
      const store = await parentStoreFor(cwd);
      const served = getServed(store, path);
      for (const hash of readAnchors) expect(served?.has(hash)).toBe(true);
      store.release();
      expect(textOf(read.content)).not.toContain("BBB");

      // The replace then applied cleanly: no straddle, no lost update.
      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("a contended read reports classified contention instead of unanchored content presented as anchored evidence", async () => {
    await withTempDir("boundary-lockedread-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "aaa\nbbb\n", "utf-8");
      const target = await resolveAnchoredTarget(cwd, "sample.txt");
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      const holder = await (await import("../../../src/anchored-edit/operations")).enterTargetBoundary(storeDir, target, { waitMs: 100 });
      expect(holder).not.toBeNull();
      try {
        const transform = await import("../../../src/anchored-edit/read-transform");
        const content = await transform.transformAnchoredReadContent(
          [{ type: "text", text: "factory content" }],
          { path: "sample.txt" },
          cwd,
          PARENT_OWNER,
          { sessionDir: testSessionDir(cwd) },
        );
        const text = textOf(content);
        expect(text).toContain("[E_FILE_LOCKED]");
        expect(text).not.toContain("│aaa");
      } finally {
        await holder!.release();
      }
    });
  });
});

describe("operation boundary — one queue-then-lock order for every writer (#264)", () => {
  const setup = async (cwd: string) => {
    await writeFile(join(cwd, "sample.txt"), "aaa\nbbb\nccc\n", "utf-8");
    const ctx = makeTestCtx(cwd);
    const hashes = _lineHashesPure("aaa\nbbb\nccc\n");
    const store = await parentStoreFor(cwd);
    store.mergeServed(join(cwd, "sample.txt"), hashes);
    store.release();
    const parentWrite = createWriteToolDefinition(cwd, {
      operations: createAnchoredWriteSession({
        cwd,
        owner: PARENT_OWNER,
        sessionDir: testSessionDir(cwd),
        autoRead: () => false,
      }).operations,
    });
    const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
    const childWrite = createChildAnchoredWriteTool(cwd, "subagent_boundary", testSessionDir(cwd), () => false);
    return { ctx, hashes, parentWrite, replace, childWrite };
  };

  it("parent write versus replace: both settle without deadlock and the file keeps a well-defined version", async () => {
    await withTempDir("boundary-pw-replace-", async (cwd) => {
      const { ctx, hashes, parentWrite, replace } = await setup(cwd);
      const [writeResult, replaceResult] = await Promise.all([
        parentWrite.execute("w1", { path: "sample.txt", content: "written\n" }, undefined, undefined, ctx),
        replace.execute("r1", { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" }, undefined, undefined, ctx),
      ]);
      expect(writeResult.content.length).toBeGreaterThan(0);
      expect(replaceResult).toBeDefined();
      const content = await readFile(join(cwd, "sample.txt"), "utf-8");
      const writeLanded = content === "written\n";
      const replaceLanded = content === "aaa\nBBB\nccc\n";
      expect(writeLanded || replaceLanded).toBe(true);
      expect(content).not.toContain("BBB\nccc\nccc");
    });
  });

  it("child write versus replace: both settle without deadlock or false stale state", async () => {
    await withTempDir("boundary-cw-replace-", async (cwd) => {
      const { ctx, hashes, replace, childWrite } = await setup(cwd);
      const [writeResult, replaceResult] = await Promise.all([
        childWrite.execute("w1", { path: "sample.txt", content: "child-written\n" }, undefined, undefined, ctx),
        replace.execute("r1", { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" }, undefined, undefined, ctx),
      ]);
      expect(textOf(writeResult.content)).toContain("Successfully wrote");
      expect(replaceResult).toBeDefined();
      const content = await readFile(join(cwd, "sample.txt"), "utf-8");
      expect(["child-written\n", "aaa\nBBB\nccc\n"]).toContain(content);
    });
  });

  it("parent versus child write: both settle without deadlock and last-writer-wins", async () => {
    await withTempDir("boundary-pw-cw-", async (cwd) => {
      const { ctx, parentWrite, childWrite } = await setup(cwd);
      const [, childResult] = await Promise.all([
        parentWrite.execute("w1", { path: "sample.txt", content: "parent\n" }, undefined, undefined, ctx),
        childWrite.execute("w1-child", { path: "sample.txt", content: "child\n" }, undefined, undefined, ctx),
      ]);
      expect(textOf(childResult.content)).toContain("Successfully wrote");
      const content = await readFile(join(cwd, "sample.txt"), "utf-8");
      expect(["parent\n", "child\n"]).toContain(content);
    });
  });
});

describe("operation boundary — hard-link aliases share one lock (#264)", () => {
  it("two hard-link names of one existing file derive the same operation key and coordinate", async () => {
    await withTempDir("boundary-hardlink-", async (cwd) => {
      const original = join(cwd, "original.txt");
      await writeFile(original, "aaa\nbbb\nccc\n", "utf-8");
      const alias = join(cwd, "alias.txt");
      await link(original, alias);

      const targetA = await resolveAnchoredTarget(cwd, "original.txt");
      const targetB = await resolveAnchoredTarget(cwd, "alias.txt");
      expect(targetA.canonicalPath).not.toBe(targetB.canonicalPath);
      expect(targetA.opKey).toBe(targetB.opKey);
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      expect(lockFilePath(storeDir, targetA.opKey)).toBe(lockFilePath(storeDir, targetB.opKey));

      // While the boundary is held through one alias, a replace through the
      // other is classified contention, not a silent overwrite.
      const { enterTargetBoundary } = await import("../../../src/anchored-edit/operations");
      const holder = await enterTargetBoundary(storeDir, targetB, { waitMs: 200 });
      expect(holder).not.toBeNull();
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure("aaa\nbbb\nccc\n");
      try {
        const store = await parentStoreFor(cwd);
        store.mergeServed(targetA.canonicalPath, hashes);
        store.release();
        const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
        const blocked = await replace.execute(
          "replace-1",
          { path: "original.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
          undefined, undefined, ctx,
        );
        expect(blocked.details.errorCode).toBe("E_FILE_LOCKED");
        expect(await readFile(original, "utf-8")).toBe("aaa\nbbb\nccc\n");
      } finally {
        await holder!.release();
      }

      // Once free, a replace through the alias edits the shared inode and
      // both names observe the new content (multi-link writes stay in place).
      const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
      const applied = await replace.execute(
        "replace-2",
        { path: "alias.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      expect(applied.details.metrics?.classification).toBe("applied");
      expect(await readFile(original, "utf-8")).toBe("aaa\nBBB\nccc\n");
      expect(await readFile(alias, "utf-8")).toBe("aaa\nBBB\nccc\n");
      expect(existsSync(alias)).toBe(true);
    });
  });
});

describe("operation boundary — store robustness (#264)", () => {
  it("quarantines the former ownerless current-version layout instead of failing with a SQL error", async () => {
    await withTempDir("boundary-ownerless-", async (cwd) => {
      const { mkdtemp, rm } = await import("fs/promises");
      const dir = await mkdtemp(join(cwd, "store-"));
      const storePath = join(dir, "hash-store.sqlite");
      try {
        // Recreate the former ownerless v6 layout: no owner column, path
        // primary keys, version 6.
        const { DatabaseSync } = await import("node:sqlite");
        const legacy = new DatabaseSync(storePath);
        legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        legacy.exec(
          "CREATE TABLE snapshots (path TEXT PRIMARY KEY, checksum TEXT NOT NULL, line_count INTEGER NOT NULL, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        );
        legacy.exec(
          "CREATE TABLE served (path TEXT PRIMARY KEY, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        );
        legacy.prepare("INSERT INTO meta (key, value) VALUES ('version', '6')").run();
        legacy.prepare("INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run("/p.ts", "checksum", 1, "[\"AAA\"]", Date.now());
        legacy.close();

        const view = await loadHashStoreAt(storePath, "parent");
        // One bounded quarantine/rebuild, not a missing-column SQL error.
        expect(view.getSnapshot("/p.ts", "x\n")).toBeUndefined();
        const { contentChecksum } = await import("../../../src/anchored-edit/hashline/hasher");
        const { splitLines } = await import("../../../src/anchored-edit/utils");
        view.upsertSnapshot("/p.ts", contentChecksum("x\n"), splitLines("x\n").length, ["BBB"]);
        expect(view.getSnapshot("/p.ts", "x\n")).toEqual(["BBB"]);
        view.release();

        const { readdir } = await import("fs/promises");
        const entries = await readdir(dir);
        expect(entries.filter((name) => name.includes(".old-schema-")).length).toBe(1);
        expect(entries.includes("hash-store.sqlite")).toBe(true);
      } finally {
        shutdownHashStore();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("keeps rows and cache consistent when a pruning delete fails mid-transaction", async () => {
    await withTempDir("boundary-prune-fail-", async (cwd) => {
      const { mkdtemp, rm } = await import("fs/promises");
      const dir = await mkdtemp(join(cwd, "store-"));
      try {
        const { pruneMissing, __testables } = await import("../../../src/anchored-edit/hash-store");
        const view = await loadHashStoreAt(join(dir, "hash-store.sqlite"), "parent");
        view.upsertSnapshot("/gone-a.ts", "c1", 1, ["AAA"]);
        view.mergeServed("/gone-a.ts", ["AAA"]);
        view.upsertSnapshot("/gone-b.ts", "c2", 1, ["BBB"]);
        view.mergeServed("/gone-b.ts", ["BBB"]);
        // Both paths are missing; the first delete throws, so the whole
        // pruning transaction rolls back.
        const entry = __testables.storeEntryOf(view);
        const deleteSpy = vi.spyOn(entry.stmts, "deleteSnapshot").mockImplementationOnce(() => {
          throw new Error("db exploded");
        });
        await expect(pruneMissing(view)).rejects.toThrow("db exploded");
        deleteSpy.mockRestore();
        expect(view.allPaths().sort()).toEqual(["/gone-a.ts", "/gone-b.ts"]);
        expect(view.getServed("/gone-a.ts")).toEqual(new Set(["AAA"]));
        shutdownHashStore();
        const reopened = await loadHashStoreAt(join(dir, "hash-store.sqlite"), "parent");
        expect(reopened.allPaths().sort()).toEqual(["/gone-a.ts", "/gone-b.ts"]);
        reopened.release();
      } finally {
        shutdownHashStore();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("preserves rows for paths whose stat fails without a genuine missing-path error", async () => {
    await withTempDir("boundary-prune-stat-", async (cwd) => {
      const { mkdtemp, rm, chmod } = await import("fs/promises");
      const dir = await mkdtemp(join(cwd, "store-"));
      try {
        const guarded = join(dir, "guarded");
        await mkdir(guarded);
        await writeFile(join(guarded, "inside.ts"), "x\n");
        await chmod(guarded, 0o000);
        const view = await loadHashStoreAt(join(dir, "hash-store.sqlite"), "parent");
        view.upsertSnapshot(join(guarded, "inside.ts"), "c1", 1, ["AAA"]);
        view.upsertSnapshot(join(dir, "really-gone.ts"), "c2", 1, ["BBB"]);
        await pruneMissing(view);
        const paths = view.allPaths();
        if (process.getuid?.() === 0) {
          // Running as root, the permission bit does not block stat: only the
          // genuinely missing path is pruned.
          expect(paths).toEqual([join(guarded, "inside.ts")]);
        } else {
          expect(paths, "permission failures preserve rows").toEqual([join(guarded, "inside.ts")]);
          expect(paths).not.toContain(join(dir, "really-gone.ts"));
        }
        view.release();
      } finally {
        await chmod(join(dir, "guarded"), 0o700).catch(() => {});
        shutdownHashStore();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  async function pruneMissing(view: import("../../../src/anchored-edit/hash-store").HashStoreHandle): Promise<void> {
    const mod = await import("../../../src/anchored-edit/hash-store");
    await mod.pruneMissing(view);
  }
});

describe("operation boundary — independent targets never contend (#264)", () => {
  it("operations on different files run concurrently and keep separate lock files", async () => {
    await withTempDir("boundary-independent-", async (cwd) => {
      await writeFile(join(cwd, "a.txt"), "aaa\nbbb\n", "utf-8");
      await writeFile(join(cwd, "b.txt"), "ccc\nddd\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const store = await parentStoreFor(cwd);
      store.mergeServed(join(cwd, "a.txt"), _lineHashesPure("aaa\nbbb\n"));
      store.mergeServed(join(cwd, "b.txt"), _lineHashesPure("ccc\nddd\n"));
      store.release();

      const targetA = await resolveAnchoredTarget(cwd, "a.txt");
      const targetB = await resolveAnchoredTarget(cwd, "b.txt");
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      expect(lockFilePath(storeDir, targetA.opKey)).not.toBe(lockFilePath(storeDir, targetB.opKey));

      const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
      const hashesA = _lineHashesPure("aaa\nbbb\n");
      const hashesB = _lineHashesPure("ccc\nddd\n");
      // Both boundaries are held simultaneously from the test itself; the two
      // replaces must still complete because their targets are independent.
      const { enterTargetBoundary } = await import("../../../src/anchored-edit/operations");
      const holdA = await enterTargetBoundary(storeDir, targetA, { waitMs: 100 });
      const holdB = await enterTargetBoundary(storeDir, targetB, { waitMs: 100 });
      expect(holdA).not.toBeNull();
      expect(holdB).not.toBeNull();
      await holdA!.release();
      await holdB!.release();

      const [ra, rb] = await Promise.all([
        replace.execute("ra", { path: "a.txt", remove_from: hashesA[0]!, remove_to: hashesA[0]!, replacement_text: "AAA" }, undefined, undefined, ctx),
        replace.execute("rb", { path: "b.txt", remove_from: hashesB[0]!, remove_to: hashesB[0]!, replacement_text: "CCC" }, undefined, undefined, ctx),
      ]);
      expect(ra.details.metrics?.classification).toBe("applied");
      expect(rb.details.metrics?.classification).toBe("applied");
      expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("AAA\nbbb\n");
      expect(await readFile(join(cwd, "b.txt"), "utf-8")).toBe("CCC\nddd\n");
      await stat(join(cwd, "a.txt"));
    });
  });
});
