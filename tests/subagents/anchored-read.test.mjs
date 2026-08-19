import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { transformAnchoredReadContent } = await load("../../src/anchored-edit/read-transform.ts");
const { loadProjectHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { getServed, recordServed } = await load("../../src/anchored-edit/served.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { __testables } = await load("../../src/subagents/session.ts");

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

const root = mkdtempSync(join(tmpdir(), "pi-square-child-anchored-read-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "first\nmiddle\nlast\n");
  writeFileSync(join(workspace, "pages.txt"), "one\ntwo\nthree\nfour\nfive");
  writeFileSync(join(workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(join(workspace, "long.txt"), `${"x".repeat(201 * 1024)}\nshort`);
  mkdirSync(join(workspace, "directory"));

  // The child read carries the built-in read name, keeps Pi's native renderers,
  // and carries no pi-square display shell, so child tool construction needs no
  // parent display runtime.
  const childRead = createChildAnchoredReadTool(workspace, CHILD_ONE);
  assert.equal(childRead.name, "read", "the anchored read is offered under the built-in read name");
  assert.equal(childRead.renderShell, undefined, "child read carries no pi-square display shell");
  assert.equal(typeof childRead.renderCall, "function", "child read keeps Pi's native call renderer");
  assert.equal(typeof childRead.renderResult, "function", "child read keeps Pi's native result renderer");
  assert.ok(
    childRead.promptGuidelines.some((guideline) => /Do not invent anchors/.test(guideline)),
    "child read carries the anchored-read evidence guidelines",
  );

  // Every workspace text line is prefixed by a three-character anchor, and the
  // anchors match the parent's transform for the same file.
  const parentTransform = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
  );
  const childResult = await childRead.execute("child-read", { path: "source.txt" }, undefined, undefined, { cwd: workspace });
  const childRows = readRows(childResult.content);
  const parentRows = readRows(parentTransform);
  assert.deepEqual(
    childRows.map((row) => row.hash),
    parentRows.map((row) => row.hash),
    "the child read returns the same anchors the parent read returns for the file",
  );
  assert.equal(childRows.length, 3, "every text line is served");
  assert.ok(childRows.every((row) => /^[A-Za-z0-9]{3}$/.test(row.hash)), "each row carries a three-character anchor");
  assert.notEqual(childRows[0].hash, childRows[1].hash, "byte-identical lines have distinct anchors");

  // Pi's paging and continuation hint reach the child unchanged.
  const paged = await childRead.execute("child-paged", { path: "pages.txt", offset: 2, limit: 2 }, undefined, undefined, { cwd: workspace });
  const pagedRows = readRows(paged.content);
  assert.deepEqual(pagedRows.map((row) => row.text), ["two", "three"], "offset/limit paging is honored");
  assert.match(paged.content[0].text, /\n*\[Showing lines 2-3 of 5\. Use offset=4 to continue\.\]/, "the factory continuation text is preserved");

  // Pi's byte budget and error text reach the child unchanged.
  const long = await childRead.execute("child-long", { path: "long.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(long.content[0].text, /exceeds 200\.0KB/i, "long lines use the factory bounded response");

  const directory = await childRead.execute("child-directory", { path: "directory" }, undefined, undefined, { cwd: workspace });
  assert.match(directory.content[0].text, /Path is a directory.*Use ls/s, "directories give the standard alternative");

  // A path outside the workspace is refused with the same named error as the parent.
  writeFileSync(join(root, "outside.txt"), "outside");
  const childOutside = await childRead.execute("child-outside", { path: "../outside.txt" }, undefined, undefined, { cwd: workspace });
  const parentOutside = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "../outside.txt" },
    workspace,
  );
  assert.match(childOutside.content[0].text, /E_OUTSIDE_WORKSPACE.*Disable anchoredEditing\.enabled/s, "child outside path has the named error");
  assert.equal(
    textOf(childOutside.content),
    textOf(parentOutside),
    "the child outside-path error matches the parent's exactly",
  );

  // Supported images retain Pi attachments (image behaviour unchanged).
  const image = await childRead.execute("child-image", { path: "pixel.png" }, undefined, undefined, { cwd: workspace });
  assert.ok(image.content.some((part) => part.type === "image"), "supported images keep Pi attachments");

  // Served rows are recorded under the child's own owner in the shared store,
  // and each owner's partition never mixes with another's.
  assert.ok(
    getServed(await loadProjectHashStore(workspace, CHILD_ONE), source),
    "the child read records served rows under the child owner",
  );
  const secondChild = createChildAnchoredReadTool(workspace, CHILD_TWO);
  await secondChild.execute("child-two", { path: "source.txt" }, undefined, undefined, { cwd: workspace });
  assert.ok(
    getServed(await loadProjectHashStore(workspace, CHILD_TWO), source),
    "the second child records its own served rows",
  );

  // A write into one owner's partition never leaks into another owner's.
  await recordServed(await loadProjectHashStore(workspace, CHILD_TWO), source, ["aaa"]);
  assert.ok(
    getServed(await loadProjectHashStore(workspace, CHILD_ONE), source)
      && !getServed(await loadProjectHashStore(workspace, CHILD_ONE), source).has("aaa"),
    "a second child's served write stays in its own partition",
  );

  // The store keeps one served partition per owner: parent, child one, child two.
  const { DatabaseSync } = await import("node:sqlite");
  const store = new DatabaseSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite"), { timeout: 500 });
  try {
    const owners = store.prepare("SELECT owner, COUNT(*) AS count FROM served GROUP BY owner").all();
    const byOwner = Object.fromEntries(owners.map((row) => [row.owner, row.count]));
    assert.ok(byOwner[PARENT_OWNER] >= 1, "the parent transform records served rows under the parent owner");
    assert.ok(byOwner[CHILD_ONE] >= 1, "the first child records served rows under its own owner");
    assert.ok(byOwner[CHILD_TWO] >= 1, "the second child records served rows under its own owner");
    assert.equal(Object.keys(byOwner).length, 3, "parent and both children keep separate served partitions");
  } finally {
    store.close();
  }

  // Session assembly: a writable child with anchored editing enabled gets the
  // anchored read appended; read-only children and disabled editing get none.
  const assembled = { definitions: [] };
  __testables.appendChildAnchoredRead(assembled, {
    anchoredEditing: true,
    builtInTools: ["read", "write"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(assembled.definitions.length, 1, "a writable child with anchored editing gets the anchored read");
  assert.equal(assembled.definitions[0].name, "read", "the appended tool is the anchored read");

  const readOnly = { definitions: [] };
  __testables.appendChildAnchoredRead(readOnly, {
    anchoredEditing: true,
    builtInTools: ["read", "ls"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(readOnly.definitions.length, 0, "read-only roles (read but no write/edit) receive no anchored read");

  const writableWithoutRead = { definitions: [] };
  __testables.appendChildAnchoredRead(writableWithoutRead, {
    anchoredEditing: true,
    builtInTools: ["write"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(writableWithoutRead.definitions.length, 0, "a child that did not request read gets no anchored read");

  const disabled = { definitions: [] };
  __testables.appendChildAnchoredRead(disabled, {
    anchoredEditing: false,
    builtInTools: ["read", "write"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(disabled.definitions.length, 0, "disabled anchored editing adds no anchored tools");

  console.log("child anchored read tests: OK");
} finally {
  shutdownHashStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
