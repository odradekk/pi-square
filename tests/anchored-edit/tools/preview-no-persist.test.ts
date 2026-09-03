import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lineHashes } from "../../../src/anchored-edit/hashline";
import { prepareReplace } from "../../../src/anchored-edit/replace";
import { withTempFile, loadTestStore, anchoredStoreFile } from "../support/fixtures";
import { __testables } from "../../../src/anchored-edit/hash-store";

describe("execPipeline no-persist guarantee", () => {

  it("does not populate or refresh the snapshot cache during preparation", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../../src/anchored-edit/fs-write")).resolveTarget(
        await (await import("../../../src/anchored-edit/paths")).toCwd("sample.txt", cwd),
      );
      const store = await loadTestStore(cwd);
      try {
        const hashes = await lineHashes(content, absolutePath, undefined, store);
        const entry = __testables.storeEntryOf(store);
        entry.snapshots.clear();

        await prepareReplace(
          {
            path: "sample.txt",
            remove_from: hashes[0]!, remove_to: hashes[0]!,
            replacement_text: "A",
          },
          cwd,
          { accessMode: constants.R_OK, store },
        );

        expect(entry.snapshots.size).toBe(0);
      } finally {
        store.release();
      }
    });
  });

  it("does not persist hypothetical result to hash store", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../../src/anchored-edit/fs-write")).resolveTarget(
        await (await import("../../../src/anchored-edit/paths")).toCwd("sample.txt", cwd)
      );

      const store = await loadTestStore(cwd);
      try {
        const hashes = await lineHashes(content, absolutePath, undefined, store);

        const beforeHashes = store.getSnapshot(absolutePath, content);
        expect(beforeHashes).toBeDefined();
        expect(beforeHashes).toEqual(hashes);
        const bHash = hashes[1]!;
        const cHash = hashes[2]!;

        const pipeline = await prepareReplace(
          {
            path: "sample.txt",
            remove_from: bHash, remove_to: cHash,
            replacement_text: "B",
          },
          cwd,
          { accessMode: constants.R_OK, store },
        );
        expect(pipeline.result).toBe("a\nB\nb\nd\n");

        const afterHashes = store.getSnapshot(absolutePath, content);
        expect(afterHashes).toBeDefined();
        expect(afterHashes).toEqual(hashes);
      } finally {
        store.release();
      }
    });
  });

  it("does not leave hypothetical snapshot behind after abandoned preview", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../../src/anchored-edit/fs-write")).resolveTarget(
        await (await import("../../../src/anchored-edit/paths")).toCwd("sample.txt", cwd)
      );

      const store = await loadTestStore(cwd);
      try {
        const hashes = await lineHashes(content, absolutePath, undefined, store);

        await prepareReplace(
          {
            path: "sample.txt",
            remove_from: hashes[1]!, remove_to: hashes[2]!,
            replacement_text: "X\nY",
          },
          cwd,
          { accessMode: constants.R_OK, store },
        );

        expect(store.getSnapshot(absolutePath, content)).toEqual(hashes);
      } finally {
        store.release();
      }
    });
  });

  it("does not invalidate anchors that were valid before preview", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../../src/anchored-edit/fs-write")).resolveTarget(
        await (await import("../../../src/anchored-edit/paths")).toCwd("sample.txt", cwd)
      );

      const store = await loadTestStore(cwd);
      try {
        const hashes = await lineHashes(content, absolutePath, undefined, store);

        const pipeline = await prepareReplace(
          {
            path: "sample.txt",
            remove_from: hashes[0]!, remove_to: hashes[2]!,
            replacement_text: "x",
          },
          cwd,
          { accessMode: constants.R_OK, store },
        );
        expect(pipeline.result).toBeDefined();

        const freshHashes = await lineHashes(content, absolutePath, undefined, store);
        expect(freshHashes).toEqual(hashes);
      } finally {
        store.release();
      }
    });
  });

  it("does not delete a corrupt snapshot row during preview", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../../src/anchored-edit/fs-write")).resolveTarget(
        await (await import("../../../src/anchored-edit/paths")).toCwd("sample.txt", cwd)
      );

      const store = await loadTestStore(cwd);
      try {
        const hashes = await lineHashes(content, absolutePath, undefined, store);
        store.release();
        const db = new DatabaseSync(anchoredStoreFile(cwd), { defensive: false } as any);
        db.prepare("UPDATE snapshots SET hashes = ? WHERE path = ?").run('["ZZ", "ZZZZ"]', absolutePath);
        db.close();

        const previewStore = await loadTestStore(cwd);
        try {
          const pipeline = await prepareReplace(
            {
              path: "sample.txt",
              remove_from: hashes[0]!, remove_to: hashes[1]!,
              replacement_text: "X",
            },
            cwd,
            { accessMode: constants.R_OK, store: previewStore },
          );
          expect(pipeline.result).toBeDefined();
        } finally {
          previewStore.release();
        }

        const check = new DatabaseSync(anchoredStoreFile(cwd), { defensive: false } as any);
        const remaining = check.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?").get(absolutePath) as { n: number };
        check.close();
        expect(remaining.n).toBe(1);
      } finally {
        store.release();
      }
    });
  });
});
