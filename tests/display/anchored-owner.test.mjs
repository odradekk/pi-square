import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  initializeAnchoredReadStore,
  transformAnchoredReadContent,
} = await load("../../src/anchored-edit/read-transform.ts");
const {
  createAnchoredReplaceToolDefinition,
} = await load("../../src/anchored-edit/workspace-replace.ts");
const {
  createAnchoredRevertToolDefinition,
} = await load("../../src/anchored-edit/workspace-revert.ts");
const {
  loadProjectHashStore,
  PARENT_OWNER,
} = await load("../../src/anchored-edit/workspace-support.ts");
const { getUndoEntry, shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { getServed } = await load("../../src/anchored-edit/served.ts");

const CHILD_OWNER = "child";

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

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-owner-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "first\nmiddle\nlast\n", { encoding: "utf8", flag: "w" });
  await initializeAnchoredReadStore(workspace);

  // Stores are acquired immediately before each inspection: the module keeps a
  // single cached database, so switching owners closes the previous one and
  // stale store references become invalid.
  assert.equal(
    (await loadProjectHashStore(workspace)).owner,
    PARENT_OWNER,
    "default project store owner is the parent",
  );
  assert.equal(
    (await loadProjectHashStore(workspace, CHILD_OWNER)).owner,
    CHILD_OWNER,
    "an explicit project store owner is honored",
  );

  // A read under the parent owner records served rows in the parent partition.
  const parentRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
  );
  assert.ok(readRows(parentRead).length > 0, "parent read serves anchored rows");
  assert.ok(
    getServed(await loadProjectHashStore(workspace), source),
    "parent read records served rows under the parent owner",
  );

  // A child-owner read serves the same anchors and records them separately.
  const childRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
    CHILD_OWNER,
  );
  const middle = readRows(childRead).find((row) => row.text === "middle");
  assert.ok(middle, "child read serves anchored rows");
  assert.ok(
    getServed(await loadProjectHashStore(workspace, CHILD_OWNER), source),
    "read transform records served rows under the child owner",
  );

  // A child-owner replace writes its undo record only into the child partition.
  const childReplace = createAnchoredReplaceToolDefinition(workspace, () => true, CHILD_OWNER);
  const changed = await childReplace.execute(
    "replace-1",
    {
      path: "source.txt",
      remove_from: middle.hash,
      remove_to: middle.hash,
      replacement_text: "replaced",
    },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(readFileSync(source, "utf8"), "first\nreplaced\nlast\n");
  assert.equal(changed.details.status, undefined, "child replace applies without a warning");
  assert.ok(
    getUndoEntry(await loadProjectHashStore(workspace, CHILD_OWNER), source),
    "replace undo persists under the child owner",
  );
  assert.equal(
    getUndoEntry(await loadProjectHashStore(workspace), source),
    undefined,
    "the parent partition stays isolated from child undo records",
  );

  // A child-owner revert consumes the child undo record and leaves the parent alone.
  const childRevert = createAnchoredRevertToolDefinition(workspace, () => true, CHILD_OWNER);
  const reverted = await childRevert.execute(
    "revert-1",
    { path: "source.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(readFileSync(source, "utf8"), "first\nmiddle\nlast\n");
  assert.equal(reverted.details.status, undefined, "child revert applies without a warning");
  assert.equal(
    getUndoEntry(await loadProjectHashStore(workspace, CHILD_OWNER), source),
    undefined,
    "revert clears the child undo record",
  );
  assert.equal(
    getUndoEntry(await loadProjectHashStore(workspace), source),
    undefined,
    "the parent partition stays isolated after child revert",
  );

  console.log("anchored owner partition tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
