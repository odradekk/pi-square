import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { transformAnchoredReadContent } = await load("../../src/anchored-edit/read-transform.ts");
const { createAnchoredReplaceToolDefinition } = await load("../../src/anchored-edit/workspace-replace.ts");
const { lockFilePath, acquireFileLock } = await load("../../src/anchored-edit/file-lock.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

function readRows(content) {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
      return match ? [{ hash: match[1], text: match[2] }] : [];
    });
}

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-cross-workspace-"));
const workspaceA = join(root, "ws-a");
const workspaceB = join(root, "ws-b");
mkdirSync(workspaceA, { recursive: true });
mkdirSync(workspaceB, { recursive: true });

const sessionDirA = join(workspaceA, ".test-session");
const sessionDirB = join(workspaceB, ".test-session");
const storeDirOf = (workspace, sessionDir) => anchoredStoreDir(sessionDir, realpathSync(workspace));

// One external canonical target edited from two different workspaces. The
// accepted limitation (#185): each workspace keeps its own snapshot/served
// state and its own lock area for the external target, so two workspaces
// never coordinate on it — matching Pi's native cross-workspace
// last-write-wins possibility. Two sessions in the SAME workspace still
// coordinate through that workspace's shared lock.
const external = join(root, "shared-external.txt");
writeFileSync(external, "one\ntwo\nthree\n", "utf8");
const canonical = realpathSync(external);

try {
  const readIn = (workspace, sessionDir) => transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "../shared-external.txt" },
    workspace,
    "parent",
    { confineToWorkspace: false, sessionDir },
  );
  const replaceIn = (workspace, sessionDir) => createAnchoredReplaceToolDefinition(workspace, undefined, undefined, undefined, false, sessionDir);

  const readA1 = readRows(await readIn(workspaceA, sessionDirA));
  const readB1 = readRows(await readIn(workspaceB, sessionDirB));
  const twoA = readA1.find((row) => row.text === "two");
  const threeB = readB1.find((row) => row.text === "three");
  assert.ok(twoA && threeB, "both workspaces serve anchors for the same external file");

  await replaceIn(workspaceA, sessionDirA).execute(
    "replace-a",
    { path: "../shared-external.txt", remove_from: twoA.hash, remove_to: twoA.hash, replacement_text: "TWO-a" },
    undefined,
    undefined,
    { cwd: workspaceA },
  );
  const readB2 = readRows(await readIn(workspaceB, sessionDirB));
  const threeB2 = readB2.find((row) => row.text === "three");
  assert.ok(threeB2, "workspace B re-reads the externally edited file through its own store");
  await replaceIn(workspaceB, sessionDirB).execute(
    "replace-b",
    { path: "../shared-external.txt", remove_from: threeB2.hash, remove_to: threeB2.hash, replacement_text: "THREE-b" },
    undefined,
    undefined,
    { cwd: workspaceB },
  );
  assert.equal(readFileSync(external, "utf8"), "one\nTWO-a\nTHREE-b\n", "both workspaces' edits apply to the shared file");

  const storeA = join(sessionDirA, "anchored-edit", "hash-store.sqlite");
  const storeB = join(sessionDirB, "anchored-edit", "hash-store.sqlite");
  assert.notEqual(realpathSync(storeA), realpathSync(storeB), "the two workspaces keep separate anchor stores");
  for (const storePath of [storeA, storeB]) {
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      assert.ok(
        store.prepare("SELECT COUNT(*) AS count FROM served WHERE path = ?").get(canonical).count > 0,
        "each workspace's store records its own served rows for the external target",
      );
    } finally {
      store.close();
    }
  }

  // Lock independence: while workspace A holds its own lock for the external
  // target, workspace B's replace proceeds untouched — the lock roots are
  // per-workspace, so cross-workspace coordination is intentionally absent
  // and a concurrent pair can interleave (accepted last-write-wins).
  const held = await acquireFileLock(lockFilePath(storeDirOf(workspaceA, sessionDirA), canonical));
  try {
    const readA2 = readRows(await readIn(workspaceA, sessionDirA));
    const oneA2 = readA2.find((row) => row.text === "one");
    assert.ok(oneA2, "workspace A can still read while holding its own lock");
    const blocked = await replaceIn(workspaceA, sessionDirA).execute(
      "replace-a-locked",
      { path: "../shared-external.txt", remove_from: oneA2.hash, remove_to: oneA2.hash, replacement_text: "must not apply" },
      undefined,
      undefined,
      { cwd: workspaceA },
    );
    assert.match(
      blocked.content[0].text,
      /\[E_RANGE_STALE\].*write lock/,
      "a same-workspace contender is still refused by the shared lock",
    );

    const readB3 = readRows(await readIn(workspaceB, sessionDirB));
    const oneB3 = readB3.find((row) => row.text === "one");
    await replaceIn(workspaceB, sessionDirB).execute(
      "replace-b-unlocked",
      { path: "../shared-external.txt", remove_from: oneB3.hash, remove_to: oneB3.hash, replacement_text: "ONE-b" },
      undefined,
      undefined,
      { cwd: workspaceB },
    );
    assert.equal(readFileSync(external, "utf8"), "ONE-b\nTWO-a\nTHREE-b\n", "the other workspace is not blocked by a foreign workspace's lock");
  } finally {
    await held.release();
  }
  assert.equal(existsSync(lockFilePath(storeDirOf(workspaceA, sessionDirA), canonical)), false, "the held lock is released");

  console.log("anchored cross-workspace tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
