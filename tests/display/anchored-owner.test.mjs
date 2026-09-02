import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  loadAnchoredHashStore,
  PARENT_OWNER,
} = await load("../../src/anchored-edit/workspace-support.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
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

const sessionDir = join(workspace, ".test-session");
const storeDir = anchoredStoreDir(sessionDir, realpathSync(workspace));
const openStore = (owner) => loadAnchoredHashStore(storeDir, owner);

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "first\nmiddle\nlast\n", { encoding: "utf8", flag: "w" });
  await initializeAnchoredReadStore(workspace, sessionDir);

  // Stores are acquired immediately before each inspection: the module keeps a
  // single cached database, so switching owners closes the previous one and
  // stale store references become invalid.
  assert.equal(
    (await openStore(PARENT_OWNER)).owner,
    PARENT_OWNER,
    "default project store owner is the parent",
  );
  assert.equal(
    (await openStore(CHILD_OWNER)).owner,
    CHILD_OWNER,
    "an explicit project store owner is honored",
  );

  // A read under the parent owner records served rows in the parent partition.
  const parentRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  assert.ok(readRows(parentRead).length > 0, "parent read serves anchored rows");
  assert.ok(
    getServed(await openStore(PARENT_OWNER), source),
    "parent read records served rows under the parent owner",
  );

  // A child-owner read serves the same anchors and records them separately.
  const childRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
    CHILD_OWNER,
    { sessionDir },
  );
  const middle = readRows(childRead).find((row) => row.text === "middle");
  assert.ok(middle, "child read serves anchored rows");
  assert.ok(
    getServed(await openStore(CHILD_OWNER), source),
    "read transform records served rows under the child owner",
  );

  // A child-owner replace records its post-edit rows only in the child
  // partition (#187: replace is the only range-editing path; the undo store is
  // gone, so served rows are the per-owner state).
  const childReplace = createAnchoredReplaceToolDefinition(workspace, () => true, CHILD_OWNER, undefined, sessionDir);
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
  const childServed = getServed(await openStore(CHILD_OWNER), source);
  assert.ok(childServed, "the child replace records post-edit rows under the child owner");
  const parentServed = getServed(await openStore(PARENT_OWNER), source);
  const freshAnchor = changed.details.diff.match(/([A-Za-z0-9]{3})│replaced/)?.[1];
  assert.ok(freshAnchor, "the child's fresh anchor is identified");
  assert.ok(
    parentServed && !parentServed.has(freshAnchor),
    "the parent partition is not credited with the child's fresh anchor",
  );

  console.log("anchored owner partition tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
