import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { createChildAnchoredEditTools } = await load("../../src/anchored-edit/child-edit.ts");
const { createChildAnchoredWriteTool } = await load("../../src/anchored-edit/child-write.ts");
const { lockFilePath, acquireFileLock } = await load("../../src/anchored-edit/file-lock.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

const CHILD_ONE = "subagent_00000000-0000-4000-8000-000000000001";
const CHILD_TWO = "subagent_00000000-0000-4000-8000-000000000002";

function textOf(content) {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function readRows(content) {
  return textOf(content).split("\n").flatMap((line) => {
    const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
    return match ? [{ hash: match[1], text: match[2] }] : [];
  });
}

const root = mkdtempSync(join(tmpdir(), "pi-square-child-anchored-external-write-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const ctx = { cwd: workspace };

try {
  // ── Native path authority (#186): a writable child's write on an external
  // path takes the cross-process lock from the initiating workspace, clears
  // only that child's served rows, appends bounded fresh anchors for supported
  // changed UTF-8 text, and creates missing files exactly as Pi's write
  // factory does. Read-only roles keep their assembly gates.
  const external = join(root, "external-write.txt");
  writeFileSync(external, "one\ntwo\nthree\n", "utf8");
  const canonical = realpathSync(external);

  const childRead = createChildAnchoredReadTool(workspace, CHILD_ONE);
  await childRead.execute("seed", { path: "../external-write.txt" }, undefined, undefined, ctx);

  const childWrite = createChildAnchoredWriteTool(workspace, CHILD_ONE);
  const writeResult = await childWrite.execute(
    "child-write-external",
    { path: "../external-write.txt", content: "one\nTWO\nthree\n" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(writeResult.content), /Successfully wrote/, "the child write succeeds on an external path");
  assert.equal(readFileSync(external, "utf8"), "one\nTWO\nthree\n", "the external file was written");
  assert.match(
    textOf(writeResult.content),
    /--- Auto-read \(hashline anchors\) ---\n[A-Za-z0-9]{3}│one\n[A-Za-z0-9]{3}│TWO\n[A-Za-z0-9]{3}│three/,
    "a changed external write appends bounded fresh anchors",
  );
  {
    // The appended anchors are served to the writing child only.
    const store = new DatabaseSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite"), { timeout: 500 });
    try {
      const fresh = textOf(writeResult.content).match(/([A-Za-z0-9]{3})│TWO/)?.[1];
      assert.ok(fresh, "the fresh anchor is identified");
      const served = store.prepare("SELECT hashes FROM served WHERE owner = ? AND path = ?").get(CHILD_ONE, canonical);
      assert.ok(served && JSON.parse(served.hashes).includes(fresh), "the write's auto-read serves the fresh anchor under the writing child");
    } finally {
      store.close();
    }
  }

  // An unchanged external write appends nothing: the pre-write comparison sees
  // identical bytes.
  const unchangedResult = await createChildAnchoredWriteTool(workspace, CHILD_ONE).execute(
    "child-write-unchanged",
    { path: "../external-write.txt", content: "one\nTWO\nthree\n" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(unchangedResult.content), /Successfully wrote/);
  assert.doesNotMatch(textOf(unchangedResult.content), /Auto-read/, "an unchanged write appends no anchors");

  // An unsupported (over-limit) external write keeps the factory result
  // without an anchor appendix: the appendix bounds reject the target.
  const huge = `${"a\n".repeat(240_000)}end`;
  const hugeResult = await createChildAnchoredWriteTool(workspace, CHILD_ONE).execute(
    "child-write-huge",
    { path: "../external-huge.txt", content: huge },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(hugeResult.content), /Successfully wrote/, "the over-limit write still succeeds through the factory");
  assert.doesNotMatch(textOf(hugeResult.content), /Auto-read/, "an unsupported write keeps its native result without anchors");

  // Only the writing child's served rows were cleared; the parent and another
  // child's partitions keep their rows for the same canonical file.
  {
    const readTwo = createChildAnchoredReadTool(workspace, CHILD_TWO);
    await readTwo.execute("seed-two", { path: "../external-write.txt" }, undefined, undefined, ctx);
    await childWrite.execute(
      "child-write-external-again",
      { path: "../external-write.txt", content: "one\ntwo\nthree\n" },
      undefined,
      undefined,
      ctx,
    );
    const store = new DatabaseSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite"), { timeout: 500 });
    try {
      const childTwoServed = store
        .prepare("SELECT COUNT(*) AS count FROM served WHERE owner = ? AND path = ?")
        .get(CHILD_TWO, canonical).count;
      assert.ok(childTwoServed > 0, "a sibling child's external served rows survive the other child's write");
    } finally {
      store.close();
    }
  }

  // The lock is taken and released through the initiating workspace's lock
  // area: while this test process holds the same lock file, the child write
  // refuses recoverably instead of writing past it.
  {
    const held = await acquireFileLock(lockFilePath(realpathSync(workspace), canonical));
    try {
      await assert.rejects(
        () => childWrite.execute(
          "child-write-locked",
          { path: "../external-write.txt", content: "must not apply\n" },
          undefined,
          undefined,
          ctx,
        ),
        /\[E_FILE_LOCKED\].*write/,
        "a locked external target refuses the child write recoverably",
      );
      assert.equal(readFileSync(external, "utf8"), "one\ntwo\nthree\n", "the locked refusal modified nothing");
    } finally {
      await held.release();
    }
    const afterLockWrite = await childWrite.execute(
      "child-write-after-lock",
      { path: "../external-write.txt", content: "one\ntwo\nthree\nfinal\n" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(textOf(afterLockWrite.content), /Successfully wrote/, "the write proceeds after the lock is released");
  }

  // A missing external file is created by write — the only creation path.
  const created = join(root, "external-created.txt");
  const createdResult = await childWrite.execute(
    "child-write-create",
    { path: "../external-created.txt", content: "fresh file\n" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(createdResult.content), /Successfully wrote/, "the child write creates a missing external file");
  assert.equal(readFileSync(created, "utf8"), "fresh file\n", "the new external file exists");

  // A failed write (unwritable directory) leaves served state intact.
  const deniedDir = join(root, "denied");
  mkdirSync(deniedDir);
  writeFileSync(join(deniedDir, "target.txt"), "keep\n");
  chmodSync(join(deniedDir, "target.txt"), 0o444);
  try {
    const deniedPath = join(deniedDir, "target.txt");
    await childRead.execute("seed-denied", { path: deniedPath }, undefined, undefined, ctx);
    const seeded = new DatabaseSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite"), { timeout: 500 });
    let seededCount = 0;
    try {
      seededCount = seeded
        .prepare("SELECT COUNT(*) AS count FROM served WHERE owner = ? AND path = ?")
        .get(CHILD_ONE, realpathSync(deniedPath)).count;
    } finally {
      seeded.close();
    }
    assert.ok(seededCount > 0, "the denied target seeded served rows");

    await assert.rejects(
      () => childWrite.execute(
        "child-write-denied",
        { path: deniedPath, content: "must fail\n" },
        undefined,
        undefined,
        ctx,
      ),
      "the unwritable target fails the write",
    );
    assert.equal(readFileSync(deniedPath, "utf8"), "keep\n", "the failed write modified nothing");
    const afterFail = new DatabaseSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite"), { timeout: 500 });
    try {
      const afterFailCount = afterFail
        .prepare("SELECT COUNT(*) AS count FROM served WHERE owner = ? AND path = ?")
        .get(CHILD_ONE, realpathSync(deniedPath)).count;
      assert.equal(afterFailCount, seededCount, "a failed write leaves the child's served state intact");
    } finally {
      afterFail.close();
    }
  } finally {
    chmodSync(join(deniedDir, "target.txt"), 0o644);
  }

  // A child replace and write on the same external file coordinate through the
  // initiating workspace's shared lock (same-workspace discipline, #186 AC7).
  {
    const [childReplace] = createChildAnchoredEditTools(workspace, CHILD_TWO);
    const writeTwo = createChildAnchoredWriteTool(workspace, CHILD_TWO);
    const rows = readRows(
      (await createChildAnchoredReadTool(workspace, CHILD_TWO).execute("lock-race-seed", { path: "../external-write.txt" }, undefined, undefined, ctx)).content,
    );
    const finalRow = rows.find((row) => row.text === "final");
    assert.ok(finalRow, "the seeded final row exists");
    const editResult = await childReplace.execute(
      "child-replace-external",
      { path: "../external-write.txt", remove_from: finalRow.hash, remove_to: finalRow.hash, replacement_text: "replaced-final" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(editResult.details?.status, undefined, "the child replace edits the external file");
    assert.equal(readFileSync(external, "utf8"), "one\ntwo\nthree\nreplaced-final\n", "the child replace applied");
  }

  console.log("child anchored external write tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
