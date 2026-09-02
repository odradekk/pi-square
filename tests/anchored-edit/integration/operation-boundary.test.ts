import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { link, mkdir, readFile, stat, writeFile } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAnchoredWriteSession,
  readBarrier,
  replaceBarrier,
  resolveAnchoredTarget,
  writeBarrier,
} from "../../../src/anchored-edit/operations";
import { createAnchoredReplaceToolDefinition } from "../../../src/anchored-edit/workspace-replace";
import { createChildAnchoredWriteTool } from "../../../src/anchored-edit/child-write";
import { PARENT_OWNER, loadAnchoredHashStore } from "../../../src/anchored-edit/workspace-support";
import { anchoredStoreDir } from "../../../src/anchored-edit/paths";
import { lockFilePath } from "../../../src/anchored-edit/file-lock";
import { loadHashStoreAt, shutdownHashStore, type HashStoreHandle } from "../../../src/anchored-edit/hash-store";
import { _lineHashesPure } from "../../../src/anchored-edit/hashline";
import { makeTestCtx, testSessionDir, withTempDir } from "../support/fixtures";

const SAMPLE = "aaa\nbbb\nccc\n";

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

/** Version-bound served lookup: the served set only when rows exist for the
 *  exact current content version. */
async function servedFor(store: HashStoreHandle, path: string, content: string): Promise<Set<string> | undefined> {
  const lookup = store.getServedState(path, content);
  return lookup !== undefined && "served" in lookup ? lookup.served : undefined;
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
    async (content: unknown, value: unknown, executionCwd: string, sessionDir: string, signal?: AbortSignal) =>
      transformAnchoredReadContent(content as never, value, executionCwd, PARENT_OWNER, { sessionDir }, signal),
  );
  return readTool.execute("read-boundary", { path: "sample.txt" }, undefined, undefined, ctx as never);
}

afterEach(() => {
  readBarrier.onBytes = undefined;
  replaceBarrier.beforeCommit = undefined;
  writeBarrier.beforeWrite = undefined;
});

describe("operation boundary — replace preparation is pure (#264)", () => {
  it("a failed filesystem commit leaves bytes, snapshot, served state, cache, and subsequent anchors unchanged", async () => {
    await withTempDir("boundary-precommit-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const userTemp = join(cwd, ".tmp-user-file.txt");
      await writeFile(userTemp, "precious", "utf-8");
      const ctx = makeTestCtx(cwd);

      const read = await anchoredReadOf(cwd, ctx);
      const readHashes = rowsOf(read.content);
      expect(readHashes.length).toBe(3);

      const before = await parentStoreFor(cwd);
      const beforeServed = await servedFor(before, path, SAMPLE);
      const beforeSnapshot = before.getSnapshot(path, SAMPLE);
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

      expect(await readFile(path, "utf-8"), "disk bytes unchanged").toBe(SAMPLE);
      expect(await readFile(userTemp, "utf-8"), "unrelated temp-named files untouched by the failed replace").toBe("precious");
      const after = await parentStoreFor(cwd);
      expect(after.getSnapshot(path, SAMPLE)).toEqual(beforeSnapshot);
      expect(await servedFor(after, path, SAMPLE)).toEqual(beforeServed);
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

  it("a post-commit publication failure reports truthful success and leaves stale state unable to authorize any row, changed or unchanged (#264 P1)", async () => {
    await withTempDir("boundary-postcommit-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure(SAMPLE);
      const store = await parentStoreFor(cwd);
      store.mergeServed(path, [...hashes], SAMPLE);
      store.release();

      const hashStoreModule = await import("../../../src/anchored-edit/hash-store");
      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const spy = vi.spyOn(hashStoreModule.__testables.HashStoreHandleImpl.prototype, "publishMutation")
        .mockImplementation(() => {
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
      expect(applied.details.warnings?.some((w) => w.includes("[E_STATE_UNAVAILABLE]"))).toBe(true);
      expect(applied.details.diff, "no fresh anchors served from the failed publication").toBe("");
      expect(await readFile(path, "utf-8"), "the file changed and the result says so").toBe("aaa\nBBB\nccc\n");

      // Authorization is version-bound: rows recorded for the pre-mutation
      // content authorize nothing against the changed bytes — not even the
      // unchanged rows the reviewer's reproduction used.
      const staleUnchanged = await replace.execute(
        "replace-2",
        { path: "sample.txt", remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "AAA" },
        undefined, undefined, ctx,
      );
      expect(staleUnchanged.details.errorCode).toBe("E_RANGE_STALE");
      expect(textOf(staleUnchanged.content)).toContain("Nothing was modified");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");

      const staleChanged = await replace.execute(
        "replace-3",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "XXX" },
        undefined, undefined, ctx,
      );
      // The removed line's anchor no longer exists in the file at all, so the
      // refusal is the anchor-resolution stale code; either way nothing was
      // modified and the old authorization applied nothing.
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(staleChanged.details.errorCode);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");

      // A fresh anchored read repairs the state: it republishes the current
      // content's snapshot and served rows, and the retry applies.
      const read = await anchoredReadOf(cwd, ctx);
      const fresh = rowsOf(read.content);
      const repaired = await replace.execute(
        "replace-4",
        { path: "sample.txt", remove_from: fresh[1]!, remove_to: fresh[1]!, replacement_text: "XXX" },
        undefined, undefined, ctx,
      );
      expect(repaired.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nXXX\nccc\n");
    });
  });

  it("a write whose post-commit state update fails reports truthful success with a bounded actionable note (#264 P1)", async () => {
    await withTempDir("boundary-write-postcommit-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);

      // The store itself fails only after the write: clearServed throws, so
      // the injected write operation's post-commit block reports the note.
      const hashStoreModule = await import("../../../src/anchored-edit/hash-store");
      const spy = vi.spyOn(hashStoreModule.__testables.HashStoreHandleImpl.prototype, "clearServed")
        .mockImplementation(() => {
          throw new Error("store down");
        });
      const session = createAnchoredWriteSession({
        cwd,
        owner: PARENT_OWNER,
        sessionDir: testSessionDir(cwd),
        autoRead: () => true,
      });
      const definition = createWriteToolDefinition(cwd, { operations: session.operations });
      const result = await definition.execute("w1", { path: "sample.txt", content: "written\n" }, undefined, undefined, ctx);
      spy.mockRestore();

      expect(textOf(result.content)).toContain("Successfully wrote");
      expect(await readFile(path, "utf-8"), "the write is not presented as failed").toBe("written\n");

      const outcome = session.takeOutcome(join(cwd, "sample.txt"));
      expect(outcome?.appendix).toContain("call read to get fresh anchors");

      // The unpublished state authorizes nothing: an immediate replace with
      // the pre-write version's anchors is refused.
      const hashes = _lineHashesPure(SAMPLE);
      const store = await parentStoreFor(cwd);
      store.mergeServed(path, [...hashes], SAMPLE);
      store.release();
      const replace = createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false);
      const refused = await replace.execute(
        "r1",
        { path: "sample.txt", remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_text: "AAA" },
        undefined, undefined, ctx,
      );
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refused.details.errorCode);
      expect(await readFile(path, "utf-8")).toBe("written\n");
    });
  });
});

describe("operation boundary — read/replace ordering (#264)", () => {
  it("a read's returned content, snapshot, and served hashes describe one file version even when a replace follows immediately", async () => {
    await withTempDir("boundary-readreplace-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure(SAMPLE);

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
      let releaseReplace!: () => void;
      const replaceEntered = new Promise<void>((resolveEntered) => {
        replaceBarrier.beforeCommit = () => {
          resolveEntered();
          return new Promise<void>((resolveRelease) => { releaseReplace = resolveRelease; });
        };
      });
      const replacePromise = replace.execute(
        "replace-1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );

      releaseRead();
      const read = await readPromise;
      await replaceEntered;

      // The read observed and published one version: every anchor it returned
      // is served for exactly that version, and the content it returned is
      // the pre-replace version. (The replace is held before its commit, so
      // its own publication cannot have replaced these rows yet.)
      const readRows = textOf(read.content);
      expect(readRows).toContain("│bbb");
      const readAnchors = rowsOf(read.content);
      const store = await parentStoreFor(cwd);
      const served = await servedFor(store, path, SAMPLE);
      for (const hash of readAnchors) expect(served?.has(hash)).toBe(true);
      store.release();
      expect(textOf(read.content)).not.toContain("BBB");

      // The replace then applied cleanly: no straddle, no lost update.
      releaseReplace();
      const replaced = await replacePromise;
      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("holds the target boundary from the byte read through the store publication, so a same-target replace waits (#264 P1)", async () => {
    await withTempDir("boundary-readlock-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure(SAMPLE);
      const store = await parentStoreFor(cwd);
      store.mergeServed(path, [...hashes], SAMPLE);
      store.release();

      // Pause the read between reading the bytes and publishing its rows.
      let releaseRead!: () => void;
      const readEntered = new Promise<void>((resolveEntered) => {
        readBarrier.onBytes = () => {
          resolveEntered();
          return new Promise<void>((resolveRead2) => { releaseRead = resolveRead2; });
        };
      });
      const readPromise = anchoredReadOf(cwd, ctx);
      await readEntered;

      const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
      const replacePromise = replace.execute(
        "replace-1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      // The replace cannot enter the boundary while the read holds it: it
      // waits the bounded budget and reports classified contention without
      // touching the file.
      const refusal = await replacePromise;
      releaseRead();
      await readPromise;

      expect(refusal.details.errorCode).toBe("E_FILE_LOCKED");
      expect(await readFile(path, "utf-8")).toBe(SAMPLE);
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
    await writeFile(join(cwd, "sample.txt"), SAMPLE, "utf-8");
    const ctx = makeTestCtx(cwd);
    const hashes = _lineHashesPure(SAMPLE);
    const store = await parentStoreFor(cwd);
    store.mergeServed(join(cwd, "sample.txt"), [...hashes], SAMPLE);
    store.release();
    const writeSession = createAnchoredWriteSession({
      cwd,
      owner: PARENT_OWNER,
      sessionDir: testSessionDir(cwd),
      autoRead: () => false,
    });
    const parentWrite = createWriteToolDefinition(cwd, { operations: writeSession.operations });
    const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
    const childWrite = createChildAnchoredWriteTool(cwd, "subagent_boundary", testSessionDir(cwd), () => false);
    return { ctx, hashes, parentWrite, replace, childWrite, writeSession };
  };

  /** Gate that resolves once the barrier function has been entered. */
  function holdAt(barrier: { beforeWrite?: (info: { canonicalPath: string }) => Promise<void> }): {
    entered: Promise<string>;
    release: () => void;
  } {
    let releaseFn!: () => void;
    const entered = new Promise<string>((resolveEntered) => {
      barrier.beforeWrite = (info) => {
        resolveEntered(info.canonicalPath);
        return new Promise<void>((resolveRelease) => { releaseFn = resolveRelease; });
      };
    });
    return { entered, release: () => releaseFn() };
  }

  it("write first, replace queued behind: the replace validates against the written bytes and never interleaves (#264)", async () => {
    await withTempDir("boundary-pw-replace-", async (cwd) => {
      const { ctx, hashes, parentWrite, replace } = await setup(cwd);
      const gate = holdAt(writeBarrier);

      const writePromise = parentWrite.execute("w1", { path: "sample.txt", content: "written\n" }, undefined, undefined, ctx);
      // Deterministic: the write is inside the mutation queue and the target
      // boundary, paused immediately before its irreversible filesystem write.
      expect(await gate.entered).toBe(join(cwd, "sample.txt"));

      const replacePromise = replace.execute(
        "r1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      gate.release();
      await writePromise;

      // The replace ran strictly after the write against the written bytes:
      // its anchors no longer exist, and the refusal changed nothing.
      const replaced = await replacePromise;
      expect(replaced.details.status).toBe("warning");
      expect(await readFile(join(cwd, "sample.txt"), "utf-8")).toBe("written\n");
    });
  });

  it("replace first, write queued behind: the write lands after the committed replace (#264)", async () => {
    await withTempDir("boundary-replace-pw-", async (cwd) => {
      const { ctx, hashes, parentWrite, replace } = await setup(cwd);
      let releaseReplace!: () => void;
      const replaceEntered = new Promise<string>((resolveEntered) => {
        replaceBarrier.beforeCommit = (info) => {
          resolveEntered(info.canonicalPath);
          return new Promise<void>((resolveRelease) => { releaseReplace = resolveRelease; });
        };
      });

      const replacePromise = replace.execute(
        "r1",
        { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
        undefined, undefined, ctx,
      );
      expect(await replaceEntered).toBe(join(cwd, "sample.txt"));

      const writePromise = parentWrite.execute("w1", { path: "sample.txt", content: "written\n" }, undefined, undefined, ctx);
      releaseReplace();
      const replaced = await replacePromise;
      await writePromise;

      expect(replaced.details.metrics?.classification).toBe("applied");
      expect(await readFile(join(cwd, "sample.txt"), "utf-8"), "the queued write lands after the replace").toBe("written\n");
    });
  });

  it("child write versus replace: both settle without deadlock or false stale state (#264)", async () => {
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

  it("parent versus child write: both settle without deadlock and last-writer-wins (#264)", async () => {
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
      await writeFile(original, SAMPLE, "utf-8");
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
      const hashes = _lineHashesPure(SAMPLE);
      try {
        const store = await parentStoreFor(cwd);
        store.mergeServed(targetA.canonicalPath, [...hashes], SAMPLE);
        store.release();
        const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
        const blocked = await replace.execute(
          "replace-1",
          { path: "original.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
          undefined, undefined, ctx,
        );
        expect(blocked.details.errorCode).toBe("E_FILE_LOCKED");
        expect(await readFile(original, "utf-8")).toBe(SAMPLE);
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
        view.mergeServed("/gone-a.ts", ["AAA"], "a\n");
        view.upsertSnapshot("/gone-b.ts", "c2", 1, ["BBB"]);
        view.mergeServed("/gone-b.ts", ["BBB"], "b\n");
        // Both paths are missing; the first delete throws, so the whole
        // pruning transaction rolls back.
        const entry = __testables.storeEntryOf(view);
        const deleteSpy = vi.spyOn(entry.stmts, "deleteSnapshot").mockImplementationOnce(() => {
          throw new Error("db exploded");
        });
        await expect(pruneMissing(view)).rejects.toThrow("db exploded");
        deleteSpy.mockRestore();
        expect(view.allPaths().sort()).toEqual(["/gone-a.ts", "/gone-b.ts"]);
        expect(view.getServedState("/gone-a.ts", "a\n")).toEqual({ served: new Set(["AAA"]) });
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

  async function pruneMissing(view: HashStoreHandle): Promise<void> {
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
      store.mergeServed(join(cwd, "a.txt"), [..._lineHashesPure("aaa\nbbb\n")], "aaa\nbbb\n");
      store.mergeServed(join(cwd, "b.txt"), [..._lineHashesPure("ccc\nddd\n")], "ccc\nddd\n");
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

describe("operation boundary — cancellation during the lock wait (#264 P1)", () => {
  it("an aborted replace wait reports E_FILE_LOCKED without modifying the file", async () => {
    await withTempDir("boundary-cancel-replace-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);
      const hashes = _lineHashesPure(SAMPLE);
      const store = await parentStoreFor(cwd);
      store.mergeServed(path, [...hashes], SAMPLE);
      store.release();

      const target = await resolveAnchoredTarget(cwd, "sample.txt");
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      const holder = await (await import("../../../src/anchored-edit/operations")).enterTargetBoundary(storeDir, target, { waitMs: 5000 });
      expect(holder).not.toBeNull();
      try {
        const controller = new AbortController();
        const replace = createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false);
        const promise = replace.execute(
          "r1",
          { path: "sample.txt", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "BBB" },
          controller.signal, undefined, ctx,
        );
        // The wait is observing the held lock; aborting it must end the wait
        // as classified contention, deterministically, without touching bytes.
        controller.abort();
        const refusal = await promise;
        expect(refusal.details.errorCode).toBe("E_FILE_LOCKED");
        expect(await readFile(path, "utf-8")).toBe(SAMPLE);
      } finally {
        await holder!.release();
      }
    });
  });

  it("an aborted write lock wait reports E_FILE_LOCKED without writing the file", async () => {
    await withTempDir("boundary-cancel-write-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");

      const target = await resolveAnchoredTarget(cwd, "sample.txt");
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      const holder = await (await import("../../../src/anchored-edit/operations")).enterTargetBoundary(storeDir, target, { waitMs: 5000 });
      expect(holder).not.toBeNull();
      try {
        const operations = await import("../../../src/anchored-edit/operations");
        const writeSession = operations.createAnchoredWriteSession({
          cwd,
          owner: PARENT_OWNER,
          sessionDir: testSessionDir(cwd),
          autoRead: () => true,
        });
        const controller = new AbortController();
        // The definition's execution wrapper runs the factory in exactly this
        // signal context; driving the injected operation here isolates the
        // lock-wait cancellation from the factory's own pre-execution abort
        // semantics (which stay Pi's).
        const promise = operations.runWithWriteSignal(
          controller.signal,
          () => writeSession.operations.writeFile(path, "written\n") as Promise<void>,
        );
        controller.abort();
        await expect(promise).rejects.toThrow("[E_FILE_LOCKED]");
        expect(await readFile(path, "utf-8")).toBe(SAMPLE);
      } finally {
        await holder!.release();
      }
    });
  });

  it("an aborted read wait reports classified contention without serving anchors", async () => {
    await withTempDir("boundary-cancel-read-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const target = await resolveAnchoredTarget(cwd, "sample.txt");
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      const holder = await (await import("../../../src/anchored-edit/operations")).enterTargetBoundary(storeDir, target, { waitMs: 5000 });
      expect(holder).not.toBeNull();
      try {
        const transform = await import("../../../src/anchored-edit/read-transform");
        const controller = new AbortController();
        const promise = transform.transformAnchoredReadContent(
          [{ type: "text", text: "factory content" }],
          { path: "sample.txt" },
          cwd,
          PARENT_OWNER,
          { sessionDir: testSessionDir(cwd) },
          controller.signal,
        );
        controller.abort();
        const content = await promise;
        expect(textOf(content)).toContain("[E_FILE_LOCKED]");
        expect(textOf(content)).not.toContain("│aaa");
      } finally {
        await holder!.release();
      }
    });
  });
});

describe("operation boundary — anchored write availability gate (#264 P1)", () => {
  it("an unavailable anchored surface executes the plain native write: no lock, no store writes", async () => {
    await withTempDir("boundary-gate-off-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);

      const { createAnchoredWriteDefinition } = await import("../../../src/anchored-edit/operations");
      const session = createAnchoredWriteSession({
        cwd,
        owner: PARENT_OWNER,
        sessionDir: testSessionDir(cwd),
        autoRead: () => true,
      });
      const definition = createAnchoredWriteDefinition(cwd, { session, isAvailable: () => false });
      const result = await definition.execute("w1", { path: "sample.txt", content: "plain\n" }, undefined, undefined, ctx);

      expect(textOf(result.content)).toContain("Successfully wrote");
      expect(await readFile(path, "utf-8")).toBe("plain\n");
      // No half-activated anchored write: the boundary never engaged.
      const storeDir = anchoredStoreDir(testSessionDir(cwd), cwd);
      const locks = join(storeDir, "locks");
      const lockEntries = await import("fs/promises").then((fs) => fs.readdir(locks).catch(() => [] as string[]));
      expect(lockEntries).toEqual([]);
      const store = await parentStoreFor(cwd);
      expect(store.getServedState(path, "plain\n")).toBeUndefined();
      store.release();
      expect(session.takeOutcome(path)).toBeUndefined();
    });
  });

  it("an available anchored surface engages the boundary: the lock is taken and released, and state is published", async () => {
    await withTempDir("boundary-gate-on-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, SAMPLE, "utf-8");
      const ctx = makeTestCtx(cwd);

      const { createAnchoredWriteDefinition } = await import("../../../src/anchored-edit/operations");
      const session = createAnchoredWriteSession({
        cwd,
        owner: PARENT_OWNER,
        sessionDir: testSessionDir(cwd),
        autoRead: () => true,
      });
      const definition = createAnchoredWriteDefinition(cwd, { session, isAvailable: () => true });
      const result = await definition.execute("w1", { path: "sample.txt", content: "anchored\n" }, undefined, undefined, ctx);

      expect(textOf(result.content)).toContain("Successfully wrote");
      expect(await readFile(path, "utf-8")).toBe("anchored\n");
      const store = await parentStoreFor(cwd);
      expect(store.getServedState(path, "anchored\n")).toBeDefined();
      store.release();
      // The appendix was precomputed for the presentation handlers.
      expect(session.takeOutcome(path)?.appendix).toContain("Auto-read");
    });
  });
});
