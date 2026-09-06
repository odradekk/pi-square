import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { link, readFile, rename, symlink, writeFile } from "fs/promises";
import { join } from "node:path";
import {
  insertBarrier,
  readBarrier,
  replaceBarrier,
  writeBarrier,
} from "../../../src/anchored-edit/operations";
import { createChildAnchoredInsertTool } from "../../../src/anchored-edit/child-edit";
import { createAnchoredInsertToolDefinition } from "../../../src/anchored-edit/workspace-insert";
import { createAnchoredReplaceToolDefinition } from "../../../src/anchored-edit/workspace-replace";
import { PARENT_OWNER, loadAnchoredHashStore } from "../../../src/anchored-edit/workspace-support";
import { anchoredStoreDir } from "../../../src/anchored-edit/paths";
import { lockFilePath } from "../../../src/anchored-edit/file-lock";
import { _lineHashesPure } from "../../../src/anchored-edit/hashline";
import { makeTestCtx, setupParentWrite, testSessionDir, withTempDir } from "../support/fixtures";

const SAMPLE = "aaa\nbbb\nccc\n";

function rowsOf(content: Array<{ type: string; text?: string }>): Array<{ hash: string; text: string }> {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
      return match ? [{ hash: match[1]!, text: match[2] }] : [];
    });
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

async function anchoredReadOf(cwd: string, ctx: unknown) {
  const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
  const { withAnchoredReadTransform } = await import("../../../src/anchored-edit/read-tool");
  const { transformAnchoredReadContent } = await import("../../../src/anchored-edit/read-transform");
  const readTool = withAnchoredReadTransform(
    createReadToolDefinition(cwd),
    cwd,
    async (content: unknown, value: unknown, executionCwd: string, sessionDir: string, signal?: AbortSignal) =>
      transformAnchoredReadContent(content as never, value, executionCwd, PARENT_OWNER, { sessionDir }, signal),
  );
  return readTool.execute("read-insert-boundary", { path: "sample.txt" }, undefined, undefined, ctx as never);
}

afterEach(() => {
  readBarrier.locked = undefined;
  readBarrier.onBytes = undefined;
  replaceBarrier.beforePrepare = undefined;
  replaceBarrier.beforeCommit = undefined;
  insertBarrier.beforePrepare = undefined;
  insertBarrier.beforeCommit = undefined;
  writeBarrier.beforeWrite = undefined;
  writeBarrier.afterWrite = undefined;
});

describe("operation boundary — insert (#285)", () => {
  it("publishes fresh unique candidate anchors after an ambiguous refusal so either row can be retried immediately", async () => {
    await withTempDir("boundary-insert-ambiguous-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      await anchoredReadOf(cwd, ctx);

      const currentHashes = _lineHashesPure(SAMPLE);
      const ambiguousHash = currentHashes[1]!;
      const hashStoreModule = await import("../../../src/anchored-edit/hash-store");
      const peekSpy = vi.spyOn(hashStoreModule.__testables.HashStoreHandleImpl.prototype, "peekSnapshot")
        .mockReturnValueOnce([ambiguousHash, currentHashes[0]!, ambiguousHash]);
      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      try {
        const refusal = await insert.execute(
          "insert-ambiguous",
          { path: "sample.txt", anchor: ambiguousHash, direction: "after", lines: ["NEW"] },
          undefined, undefined, ctx,
        );
        expect(refusal.details?.errorCode).toBe("E_AMBIGUOUS_ANCHOR");
        const candidates = rowsOf(refusal.content);
        expect(candidates.map((row) => row.text)).toEqual(["aaa", "ccc"]);
        expect(new Set(candidates.map((row) => row.hash)).size).toBe(2);

        const unsafeOldRetry = await insert.execute(
          "insert-old-ambiguous-retry",
          { path: "sample.txt", anchor: ambiguousHash, direction: "after", lines: ["WRONG"] },
          undefined, undefined, ctx,
        );
        expect(unsafeOldRetry.details?.status).toBe("warning");
        expect(unsafeOldRetry.details?.errorCode).toBe("E_RANGE_STALE");
        expect(await readFile(path, "utf-8")).toBe(SAMPLE);

        const retry = await insert.execute(
          "insert-retry",
          { path: "sample.txt", anchor: candidates[0]!.hash, direction: "after", lines: ["NEW"] },
          undefined, undefined, ctx,
        );
        expect(retry.details?.metrics?.classification).toBe("applied");
        expect(await readFile(path, "utf-8")).toBe("aaa\nNEW\nbbb\nccc\n");
      } finally {
        peekSpy.mockRestore();
      }
    });
  });

  it("a read held at its publication boundary blocks an insert until the read's version is fully published", async () => {
    await withTempDir("boundary-readinsert-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);

      const hashes = _lineHashesPure(SAMPLE);
      let releaseRead!: () => void;
      const readEntered = new Promise<void>((resolveEntered) => {
        readBarrier.onBytes = () => {
          resolveEntered();
          return new Promise<void>((resolveRead2) => { releaseRead = resolveRead2; });
        };
      });
      const readPromise = anchoredReadOf(cwd, ctx);
      await readEntered;

      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: hashes[1]!, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );

      // The insert cannot enter the boundary while the read holds it. Give it
      // a bounded moment and confirm nothing was applied yet.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);

      releaseRead();
      const read = await readPromise;
      const readRows = rowsOf(read.content);
      expect(readRows.map((row) => row.text)).toEqual(["aaa", "bbb", "ccc"]);

      // Once the read releases, the insert runs against the read's published
      // version; its served rows authorize the bbb anchor.
      const settled = await insertPromise;
      expect(settled.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nNEW\nccc\n");
    });
  });

  it("an insert held before its commit blocks a replace on the same target until the insert publishes", async () => {
    await withTempDir("boundary-insertreplace-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure(SAMPLE);

      const read = await anchoredReadOf(cwd, ctx);
      const readAnchors = rowsOf(read.content);
      const bbb = readAnchors.find((row) => row.text === "bbb")!;

      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      await insertEntered;

      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const replacePromise = replace.execute(
        "replace-1",
        { path: "sample.txt", remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_text: "CCC" },
        undefined, undefined, ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);

      releaseInsert();
      const inserted = await insertPromise;
      expect(inserted.details.metrics?.classification).toBe("applied");
      const replaced = await replacePromise;
      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nNEW\nCCC\n");
    });
  });

  it("an insert held before its commit blocks a parent write on the same target until the insert publishes", async () => {
    await withTempDir("boundary-insertwrite-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const { runWrite } = setupParentWrite(cwd);

      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "before", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      await insertEntered;

      const writePromise = runWrite("write-1", { path: "sample.txt", content: "written\n" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);

      releaseInsert();
      await insertPromise;
      await writePromise;
      expect(await readFile(path, "utf-8")).toBe("written\n");
    });
  });

  it("coordinates hard-link aliases of one file onto the same target boundary", async () => {
    await withTempDir("boundary-insert-alias-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      const alias = join(cwd, "alias.txt");
      await writeFile(path, SAMPLE, "utf-8");
      await link(path, alias);
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure(SAMPLE);

      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      // The two hard-link names derive one operation key, so an insert held
      // at its commit through one name blocks a replace through the other.
      const { resolveAnchoredTarget, enterTargetBoundary } = await import("../../../src/anchored-edit/operations");
      const { anchoredStoreDir } = await import("../../../src/anchored-edit/paths");
      const { testSessionDir } = await import("../support/fixtures");
      const targetA = await resolveAnchoredTarget(cwd, "sample.txt");
      const targetB = await resolveAnchoredTarget(cwd, "alias.txt");
      expect(targetA.canonicalPath).not.toBe(targetB.canonicalPath);
      expect(targetA.opKey).toBe(targetB.opKey);
      expect(lockFilePath(anchoredStoreDir(testSessionDir(cwd), cwd), targetA.opKey))
        .toBe(lockFilePath(anchoredStoreDir(testSessionDir(cwd), cwd), targetB.opKey));

      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      await insertEntered;

      // The replace through the alias must wait for the held boundary instead
      // of observing or mutating mid-insert bytes.
      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const replacePromise = replace.execute(
        "replace-1",
        { path: "alias.txt", remove_from: hashes[2]!, remove_to: hashes[2]!, replacement_text: "CCC" },
        undefined, undefined, ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(alias, "utf-8")).toBe(SAMPLE);

      releaseInsert();
      const inserted = await insertPromise;
      expect(inserted.details.metrics?.classification).toBe("applied");
      const replaced = await replacePromise;
      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nNEW\nCCC\n");
      expect(await readFile(alias, "utf-8")).toBe("aaa\nbbb\nNEW\nCCC\n");

      // The lock area carries no residue once both released.
      const probe = await enterTargetBoundary(anchoredStoreDir(testSessionDir(cwd), cwd), targetA, { waitMs: 200 });
      expect(probe).not.toBeNull();
      await probe!.release();
    });
  });

  it("reports classified E_FILE_LOCKED contention and changes nothing when an external holder keeps the lock", async () => {
    await withTempDir("boundary-insert-lock-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const { acquireFileLock } = await import("../../../src/anchored-edit/file-lock");
      const { anchoredStoreDir } = await import("../../../src/anchored-edit/paths");
      const { testSessionDir } = await import("../support/fixtures");

      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      // A foreign in-process holder on the canonical target key. The insert
      // must exhaust its bounded wait and refuse with nothing modified.
      const { resolveAnchoredTarget } = await import("../../../src/anchored-edit/operations");
      const target = await resolveAnchoredTarget(cwd, "sample.txt");
      const holder = await acquireFileLock(
        lockFilePath(anchoredStoreDir(testSessionDir(cwd), cwd), target.opKey),
        { waitMs: 60 },
      );
      expect(holder).not.toBeNull();

      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const result = await insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      expect(result.details?.status).toBe("warning");
      expect(result.details?.errorCode).toBe("E_FILE_LOCKED");
      expect(textOf(result.content)).toContain("[E_FILE_LOCKED]");
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);

      await holder!.release();
    });
  });

  it("a cancelled wait before the commit modifies nothing and reports classified contention", async () => {
    await withTempDir("boundary-insert-abort-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      const controller = new AbortController();
      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
        controller.signal, undefined, ctx,
      );
      await insertEntered;
      controller.abort();
      releaseInsert();

      const result = await insertPromise;
      expect(result.details?.status).toBe("warning");
      expect(result.details?.errorCode).toBe("E_FILE_LOCKED");
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);
    });
  });

  it("reports a committed insert truthfully when the post-commit state publication fails", async () => {
    await withTempDir("boundary-insert-state-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      // Force the post-commit publication to fail inside the boundary.
      const hashStoreModule = await import("../../../src/anchored-edit/hash-store");
      const publishSpy = vi.spyOn(hashStoreModule.__testables.HashStoreHandleImpl.prototype, "publishMutation")
        .mockImplementation(() => {
          throw new Error("store down");
        });

      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      try {
        const result = await insert.execute(
          "insert-1",
          { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
          undefined, undefined, ctx,
        );
        expect((result as { isError?: boolean }).isError).toBeUndefined();
        expect(result.details?.metrics?.classification).toBe("applied");
        expect(result.details?.diff, "no fresh anchors served from the failed publication").toBe("");
        expect(result.details?.warnings?.some((warning) => warning.includes("[E_STATE_UNAVAILABLE]"))).toBe(true);
        expect(textOf(result.content)).toContain("Successfully inserted");
        expect(textOf(result.content)).toContain("[E_STATE_UNAVAILABLE]");
        expect(await readFile(path, "utf-8"), "the file changed and the result says so").toBe("aaa\nbbb\nNEW\nccc\n");

        // Authorization is version-bound: rows recorded for the pre-insert
        // content authorize nothing against the changed bytes.
        const staleRetry = await insert.execute(
          "insert-2",
          { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["AGAIN"] },
          undefined, undefined, ctx,
        );
        expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(staleRetry.details?.errorCode);
        expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nNEW\nccc\n");
      } finally {
        publishSpy.mockRestore();
      }
    });
  });

  it("freezes the symlink target at boundary entry so a mid-operation retarget cannot redirect the insert", async () => {
    await withTempDir("boundary-insert-freeze-", async (cwd) => {
      const canonical = join(cwd, "real.txt");
      const decoy = join(cwd, "decoy.txt");
      await writeFile(canonical, SAMPLE, "utf-8");
      await writeFile(decoy, "WRONG\n", "utf-8");
      const linkPath = join(cwd, "link.txt");
      await symlink(canonical, linkPath);
      const ctx = makeTestCtx(cwd);

      const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
      const { withAnchoredReadTransform } = await import("../../../src/anchored-edit/read-tool");
      const { transformAnchoredReadContent } = await import("../../../src/anchored-edit/read-transform");
      const readTool = withAnchoredReadTransform(
        createReadToolDefinition(cwd),
        cwd,
        async (content: unknown, value: unknown, executionCwd: string, sessionDir: string, signal?: AbortSignal) =>
          transformAnchoredReadContent(content as never, value, executionCwd, PARENT_OWNER, { sessionDir }, signal),
      );
      const read = await readTool.execute("r-freeze", { path: "link.txt" }, undefined, undefined, ctx as never);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      let releaseInsert!: () => void;
      const locked = new Promise<string>((resolveLocked) => {
        insertBarrier.beforePrepare = (info) => {
          insertBarrier.beforePrepare = undefined;
          resolveLocked(info.canonicalPath);
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "link.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      expect(await locked).toBe(canonical);

      const temp = join(cwd, ".relink");
      await symlink(decoy, temp);
      await rename(temp, linkPath);

      releaseInsert();
      const result = await insertPromise;
      expect(result.details?.metrics?.classification).toBe("applied");
      expect(await readFile(canonical, "utf-8")).toBe("aaa\nbbb\nNEW\nccc\n");
      expect(await readFile(decoy, "utf-8")).toBe("WRONG\n");
    });
  });
});

describe("operation boundary — insert blank and empty initialization (#286)", () => {
  it("serializes an empty-file initialization with an anchored read through one target boundary", async () => {
    await withTempDir("boundary-insert-init-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "", "utf-8");
      const ctx = makeTestCtx(cwd);

      const read = await anchoredReadOf(cwd, ctx);
      const synthetic = rowsOf(read.content)[0]!;
      expect(synthetic.text).toBe("");

      const order: string[] = [];
      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          order.push("insert-commit");
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      readBarrier.locked = () => {
        order.push("read-bytes");
        return Promise.resolve();
      };

      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const insertPromise = insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: synthetic.hash, direction: "after", lines: ["hello", ""] },
        undefined, undefined, ctx,
      );
      await insertEntered;

      // The read cannot enter the boundary while the initialization holds the
      // target exclusion, so its anchors can only describe the initialized
      // bytes. The ordering log proves the serialization deterministically.
      const readPromise = anchoredReadOf(cwd, ctx);
      releaseInsert();
      const inserted = await insertPromise;
      expect(inserted.details.metrics?.classification).toBe("applied");
      const postRead = await readPromise;
      expect(order).toEqual(["insert-commit", "read-bytes"]);
      expect(rowsOf(postRead.content).map((row) => row.text)).toEqual(["hello", ""]);
      expect(await readFile(path, "utf-8")).toBe("hello\n\n");
    });
  });

  it("reports classified E_FILE_LOCKED and initializes nothing when an external holder keeps the lock on an empty target", async () => {
    await withTempDir("boundary-insert-initlock-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "", "utf-8");
      const ctx = makeTestCtx(cwd);
      const { acquireFileLock } = await import("../../../src/anchored-edit/file-lock");
      const { anchoredStoreDir } = await import("../../../src/anchored-edit/paths");
      const { testSessionDir } = await import("../support/fixtures");

      const read = await anchoredReadOf(cwd, ctx);
      const synthetic = rowsOf(read.content)[0]!;

      const { resolveAnchoredTarget } = await import("../../../src/anchored-edit/operations");
      const target = await resolveAnchoredTarget(cwd, "sample.txt");
      const holder = await acquireFileLock(
        lockFilePath(anchoredStoreDir(testSessionDir(cwd), cwd), target.opKey),
        { waitMs: 60 },
      );
      expect(holder).not.toBeNull();

      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const result = await insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: synthetic.hash, direction: "before", lines: ["x"] },
        undefined, undefined, ctx,
      );
      expect(result.details?.status).toBe("warning");
      expect(result.details?.errorCode).toBe("E_FILE_LOCKED");
      expect(textOf(result.content)).toContain("[E_FILE_LOCKED]");
      expect(await readFile(path, "utf-8")).toBe("");

      await holder!.release();
    });
  });

  it("publishes a trailing blank insert's served rows under the boundary for an immediate chained replace", async () => {
    await withTempDir("boundary-insert-blankchain-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "aaa\nbbb", "utf-8");
      const ctx = makeTestCtx(cwd);
      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;

      const insert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const inserted = await insert.execute(
        "insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: [""] },
        undefined, undefined, ctx,
      );
      expect(inserted.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n\n");

      // The re-added anchor row is served from the authoritative diff, so the
      // chained replace verifies without another read.
      const reAdded = /^\+([A-Za-z0-9]{3})│bbb$/m.exec(inserted.details.diff ?? "")?.[1];
      expect(reAdded, "the diff carries the re-added anchor row").toBeTruthy();
      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const replaced = await replace.execute(
        "replace-1",
        { path: "sample.txt", remove_from: reAdded!, remove_to: reAdded!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\n\n");
    });
  });
});

describe("operation boundary — child insert (#287)", () => {
  const CHILD = "subagent_insert_boundary";

  /** Serves the sample rows to the child owner so its insert authorization
   *  verifies exactly as a real child read would have. */
  const setupChildServed = async (cwd: string) => {
    const store = await loadAnchoredHashStore(anchoredStoreDir(testSessionDir(cwd), cwd), CHILD);
    try {
      store.mergeServed(join(cwd, "sample.txt"), [..._lineHashesPure(SAMPLE)], SAMPLE);
    } finally {
      store.release();
    }
  };

  it("a child insert held before its commit blocks a parent replace on the same target until the insert publishes", async () => {
    await withTempDir("boundary-cinsert-preplace-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      await setupChildServed(cwd);
      const hashes = _lineHashesPure(SAMPLE);

      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          insertBarrier.beforeCommit = undefined;
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const insert = createChildAnchoredInsertTool(cwd, CHILD, testSessionDir(cwd));
      const insertPromise = insert.execute(
        "child-insert-1",
        { path: "sample.txt", anchor: hashes[1]!, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      await insertEntered;

      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const replacePromise = replace.execute(
        "parent-replace-1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);

      releaseInsert();
      const inserted = await insertPromise;
      expect(inserted.details.metrics?.classification).toBe("applied");
      const replaced = await replacePromise;
      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nNEW\nccc\n");
    });
  });

  it("a parent insert held before its commit blocks a child insert; the queued child validates against the inserted bytes and its stale authorization refuses", async () => {
    await withTempDir("boundary-pinsert-cinsert-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      // The parent's own read serves its owner (insert authorization is
      // mandatory for every owner), and the child's partition carries rows
      // for the same version.
      const read = await anchoredReadOf(cwd, ctx);
      const bbb = rowsOf(read.content).find((row) => row.text === "bbb")!;
      await setupChildServed(cwd);
      const hashes = _lineHashesPure(SAMPLE);

      let releaseInsert!: () => void;
      const insertEntered = new Promise<void>((resolveEntered) => {
        insertBarrier.beforeCommit = () => {
          // One-shot: the queued child insert must not park on the same gate.
          insertBarrier.beforeCommit = undefined;
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseInsert = resolveRelease; });
        };
      });
      const parentInsert = createAnchoredInsertToolDefinition(cwd, () => true, PARENT_OWNER);
      const parentPromise = parentInsert.execute(
        "parent-insert-1",
        { path: "sample.txt", anchor: bbb.hash, direction: "after", lines: ["NEW"] },
        undefined, undefined, ctx,
      );
      await insertEntered;

      const childInsert = createChildAnchoredInsertTool(cwd, CHILD, testSessionDir(cwd));
      const childPromise = childInsert.execute(
        "child-insert-1",
        { path: "sample.txt", anchor: hashes[1]!, direction: "before", lines: ["CHILD"] },
        undefined, undefined, ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);

      releaseInsert();
      const inserted = await parentPromise;
      expect(inserted.details.metrics?.classification).toBe("applied");

      // The child insert ran strictly after the parent's publication: it
      // observed the inserted bytes, and its rows — recorded for the previous
      // content version — authorize nothing, so it refuses recoverably and
      // changes nothing on top of the parent's mutation.
      const refused = await childPromise;
      expect(refused.details.status).toBe("warning");
      expect(refused.details.errorCode).toBe("E_RANGE_STALE");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nNEW\nccc\n");
    });
  });
});
