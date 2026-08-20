import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredEditTools } = await load("../../src/anchored-edit/child-edit.ts");
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { createChildAnchoredWriteTool } = await load("../../src/anchored-edit/child-write.ts");
const { createAnchoredReplaceToolDefinition } = await load("../../src/anchored-edit/workspace-replace.ts");
const { createAnchoredRevertToolDefinition, registerAnchoredRevert } = await load("../../src/anchored-edit/workspace-revert.ts");
const { registerAnchoredAutoRead } = await load("../../src/anchored-edit/auto-read.ts");
const { loadProjectHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { getUndoEntry, shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { getUndoRecord, saveUndo } = await load("../../src/anchored-edit/replace-undo.ts");
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

function anchorsOf(result) {
  return readRows(result.content).map((row) => row.hash);
}

const root = mkdtempSync(join(tmpdir(), "pi-square-revert-authority-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const ctx = { cwd: workspace };
const source = join(workspace, "a.txt");

/** Replaces the middle line with its uppercase form. */
async function replaceLine(path, anchors, replacement, owner) {
  const middle = anchors[1];
  const replace = owner === PARENT_OWNER
    ? createAnchoredReplaceToolDefinition(workspace)
    : createChildAnchoredEditTools(workspace, owner)[0];
  return replace.execute(
    "replace-line",
    { path, remove_from: middle, remove_to: middle, replacement_text: replacement },
    undefined,
    undefined,
    ctx,
  );
}

async function readAnchors(path, owner) {
  const read = createChildAnchoredReadTool(workspace, owner);
  const result = await read.execute("read-line", { path }, undefined, undefined, ctx);
  return anchorsOf(result);
}

try {
  // Criterion 1: the parent can revert the most recent edit regardless of which
  // agent made it. A child's edit leaves a single file-global record under the
  // child's owner; the parent's revert consumes it and restores the file.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  const childAnchors = await readAnchors("a.txt", CHILD_ONE);
  await replaceLine("a.txt", childAnchors, "BETA", CHILD_ONE);
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA\ngamma\n");
  const afterChildEdit = await getUndoRecord(source, await loadProjectHashStore(workspace, PARENT_OWNER));
  assert.ok(afterChildEdit, "the child's edit leaves a revert record");
  assert.equal(afterChildEdit.owner, CHILD_ONE, "the single record is owned by the editing child");
  assert.equal(
    await getUndoEntry(await loadProjectHashStore(workspace, PARENT_OWNER), source),
    undefined,
    "the parent partition holds no separate record for the same file",
  );

  const parentRevert = createAnchoredRevertToolDefinition(workspace, () => true, PARENT_OWNER, true);
  const parentReverted = await parentRevert.execute("parent-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(parentReverted.details?.status, undefined, "the parent reverts the child's edit without a warning");
  assert.equal(readFileSync(source, "utf8"), "alpha\nbeta\ngamma\n", "the parent restores the file the child edited");
  assert.equal(
    await getUndoRecord(source, await loadProjectHashStore(workspace, PARENT_OWNER)),
    undefined,
    "the parent's revert consumes the single record",
  );

  // Criterion 2 + 8: a child is refused when it tries to revert a record it
  // does not own, the refusal names the owning agent, and the code is distinct
  // from E_UNDO_STALE (a modified file).
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  const parentAnchors = await readAnchors("a.txt", PARENT_OWNER);
  await replaceLine("a.txt", parentAnchors, "BETA", PARENT_OWNER);
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA\ngamma\n");
  const childRevert = createChildAnchoredEditTools(workspace, CHILD_ONE)[1];
  const refusedParentRecord = await childRevert.execute("child-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(refusedParentRecord.details?.status, "warning", "the child revert of a parent-owned record is a completed warning");
  assert.equal(refusedParentRecord.details?.errorCode, "E_UNDO_OWNER", "the ownership refusal uses E_UNDO_OWNER");
  assert.match(textOf(refusedParentRecord.content), /the parent session/, "the refusal names the owning parent session");
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA\ngamma\n", "the refused child revert leaves the file untouched");
  assert.ok(
    await getUndoRecord(source, await loadProjectHashStore(workspace, PARENT_OWNER)),
    "the refused child revert leaves the parent's record intact",
  );

  // Criterion 2: the refusal also names another child when that child owns the
  // record.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  const childTwoAnchors = await readAnchors("a.txt", CHILD_TWO);
  await replaceLine("a.txt", childTwoAnchors, "BETA", CHILD_TWO);
  const refusedOtherChild = await childRevert.execute("child-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(refusedOtherChild.details?.errorCode, "E_UNDO_OWNER");
  assert.ok(
    textOf(refusedOtherChild.content).includes(CHILD_TWO),
    "the refusal names the owning child subagent",
  );

  // Criterion 3: a child can revert its own most recent edit.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  const ownAnchors = await readAnchors("a.txt", CHILD_ONE);
  const [ownReplace, ownRevert] = createChildAnchoredEditTools(workspace, CHILD_ONE);
  await ownReplace.execute(
    "own-replace",
    { path: "a.txt", remove_from: ownAnchors[1], remove_to: ownAnchors[1], replacement_text: "BETA" },
    undefined,
    undefined,
    ctx,
  );
  const ownReverted = await ownRevert.execute("own-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(ownReverted.details?.status, undefined, "a child reverts its own edit without a warning");
  assert.equal(readFileSync(source, "utf8"), "alpha\nbeta\ngamma\n");

  // Criterion 4: revert stays single-level per file across all owners — one
  // record per file, not one per owner. A later edit by any agent replaces the
  // prior record.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", PARENT_OWNER), "B1", PARENT_OWNER);
  assert.ok(
    await getUndoEntry(await loadProjectHashStore(workspace, PARENT_OWNER), source),
    "the parent's edit records under the parent owner",
  );
  assert.equal(
    await getUndoEntry(await loadProjectHashStore(workspace, CHILD_ONE), source),
    undefined,
    "no child record exists yet",
  );
  await replaceLine("a.txt", await readAnchors("a.txt", CHILD_ONE), "B2", CHILD_ONE);
  assert.equal(
    await getUndoEntry(await loadProjectHashStore(workspace, PARENT_OWNER), source),
    undefined,
    "the child's edit replaced the parent's record (one record per file)",
  );
  let singleRecord = await getUndoRecord(source, await loadProjectHashStore(workspace, PARENT_OWNER));
  assert.equal(singleRecord?.owner, CHILD_ONE, "the single record is owned by the most recent editor");
  await replaceLine("a.txt", await readAnchors("a.txt", PARENT_OWNER), "B3", PARENT_OWNER);
  assert.equal(
    await getUndoEntry(await loadProjectHashStore(workspace, CHILD_ONE), source),
    undefined,
    "the parent's edit replaced the child's record (one record per file)",
  );
  singleRecord = await getUndoRecord(source, await loadProjectHashStore(workspace, PARENT_OWNER));
  assert.equal(singleRecord?.owner, PARENT_OWNER, "the single record follows the most recent editor");

  // Criterion 6: a file modified after the recorded edit refuses the revert for
  // the parent as well as for a child, with the E_UNDO_STALE code.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", CHILD_ONE), "BETA", CHILD_ONE);
  writeFileSync(source, "alpha\nexternal\ngamma\n");
  const staleChild = await ownRevert.execute("stale-child-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(staleChild.details?.status, "warning", "a child revert of a modified file is a completed warning");
  assert.equal(staleChild.details?.errorCode, "E_UNDO_STALE", "a modified file refuses the child with E_UNDO_STALE");
  assert.equal(readFileSync(source, "utf8"), "alpha\nexternal\ngamma\n", "the stale child revert leaves newer content untouched");

  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", PARENT_OWNER), "BETA", PARENT_OWNER);
  writeFileSync(source, "alpha\nexternal\ngamma\n");
  const staleParent = await parentRevert.execute("stale-parent-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(staleParent.details?.status, "warning", "a parent revert of a modified file is a completed warning");
  assert.equal(staleParent.details?.errorCode, "E_UNDO_STALE", "a modified file refuses the parent with E_UNDO_STALE");
  assert.ok(
    staleChild.details?.errorCode !== refusedParentRecord.details?.errorCode,
    "the ownership refusal and the modified-file refusal are distinguishable codes",
  );

  // Criterion 7: a successful write clears that file's revert record whichever
  // agent wrote it; a failed write keeps it.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", CHILD_ONE), "BETA", CHILD_ONE);
  assert.ok(
    await getUndoRecord(source, await loadProjectHashStore(workspace, CHILD_ONE)),
    "a child edit leaves a record",
  );
  const childWrite = createChildAnchoredWriteTool(workspace, CHILD_ONE);
  const childWrote = await childWrite.execute("child-write", { path: "a.txt", content: "new content\n" }, undefined, undefined, ctx);
  assert.match(textOf(childWrote.content), /Successfully wrote/, "the child write tool writes the file");
  assert.equal(readFileSync(source, "utf8"), "new content\n");
  assert.equal(
    await getUndoRecord(source, await loadProjectHashStore(workspace, CHILD_ONE)),
    undefined,
    "a child's successful write clears the file's single record",
  );

  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", CHILD_ONE), "BETA", CHILD_ONE);
  const dirPath = join(workspace, "adir");
  mkdirSync(dirPath);
  await assert.rejects(
    () => childWrite.execute("child-write-fail", { path: "adir", content: "x" }, undefined, undefined, ctx),
    "a child write to a directory fails",
  );
  assert.ok(
    await getUndoRecord(source, await loadProjectHashStore(workspace, CHILD_ONE)),
    "a failed write keeps the file's record",
  );

  // Criterion 7 (parent side): the parent's auto-read write-clear consumes a
  // child-owned record, so the parent's write clears whichever owner made the
  // recorded edit.
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", CHILD_ONE), "BETA", CHILD_ONE);
  const tools = new Map();
  const events = new Map();
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
  };
  registerAnchoredAutoRead(pi, () => ({ anchoredEditing: { enabled: true, autoRead: false } }), () => true);
  const toolCallHandlers = events.get("tool_call") ?? [];
  const toolResultHandlers = events.get("tool_result") ?? [];
  const writeCallId = "write-1";
  for (const handler of toolCallHandlers) {
    await handler({ toolName: "write", toolCallId: writeCallId, input: { path: "a.txt", content: "parent wrote\n" } }, ctx);
  }
  for (const handler of toolResultHandlers) {
    await handler({ toolName: "write", toolCallId: writeCallId, isError: false, input: { path: "a.txt" } }, ctx);
  }
  assert.equal(
    await getUndoRecord(source, await loadProjectHashStore(workspace, CHILD_ONE)),
    undefined,
    "a parent's successful write clears the child-owned record",
  );

  // Session assembly: a writable child with anchored editing on receives the
  // write-clear wrapper; read-only roles and disabled editing receive none.
  const assembled = { definitions: [] };
  const writeAdded = __testables.appendChildAnchoredWrite(assembled, {
    anchoredEditing: true,
    builtInTools: ["read", "write", "edit"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(writeAdded, true, "a writable child gets the anchored write");
  assert.equal(assembled.definitions.length, 1, "exactly one write definition is appended");
  assert.equal(assembled.definitions[0].name, "write", "the appended tool carries the built-in write name");

  const readOnly = { definitions: [] };
  assert.equal(
    __testables.appendChildAnchoredWrite(readOnly, {
      anchoredEditing: true,
      builtInTools: ["read", "ls"],
      cwd: workspace,
      owner: CHILD_ONE,
    }),
    false,
    "read-only roles receive no anchored write",
  );
  assert.equal(readOnly.definitions.length, 0);

  const disabled = { definitions: [] };
  assert.equal(
    __testables.appendChildAnchoredWrite(disabled, {
      anchoredEditing: false,
      builtInTools: ["read", "write", "edit"],
      cwd: workspace,
      owner: CHILD_ONE,
    }),
    false,
    "disabled anchored editing adds no anchored write",
  );
  assert.equal(disabled.definitions.length, 0);

  // Parent registration grants the parent revert authority over any owner.
  const registerTools = new Map();
  const registerEvents = new Map();
  const registerPi = {
    registerTool(definition) { registerTools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = registerEvents.get(name) ?? [];
      handlers.push(handler);
      registerEvents.set(name, handlers);
    },
  };
  registerAnchoredRevert(
    registerPi,
    () => ({ anchoredEditing: { enabled: true } }),
    undefined,
    () => true,
  );
  for (const handler of registerEvents.get("session_start") ?? []) {
    await handler({ type: "session_start" }, ctx);
  }
  writeFileSync(source, "alpha\nbeta\ngamma\n");
  await replaceLine("a.txt", await readAnchors("a.txt", CHILD_ONE), "BETA", CHILD_ONE);
  const registeredParentRevert = registerTools.get("revert");
  assert.ok(registeredParentRevert, "the parent registers revert");
  const registeredReverted = await registeredParentRevert.execute("registered-revert", { path: "a.txt" }, undefined, undefined, ctx);
  assert.equal(registeredReverted.details?.status, undefined, "the registered parent revert consumes the child's record");
  assert.equal(readFileSync(source, "utf8"), "alpha\nbeta\ngamma\n");

  // Criterion 4 (unit level): saveUndo keeps one record per file and its
  // rollback restores the prior record under the owner who made that edit, so
  // a failed replace never misattributes or drops the previous record.
  const unitPath = join(workspace, "unit.txt");
  writeFileSync(unitPath, "alpha\nbeta\ngamma\n");
  const parentUnitStore = await loadProjectHashStore(workspace, PARENT_OWNER);
  await saveUndo(
    unitPath,
    { content: "alpha\nbeta\ngamma\n", bom: "", originalEnding: "\n", hashes: [], resultContent: "alpha\nBETA\ngamma\n" },
    parentUnitStore,
  );
  parentUnitStore.release();
  const childUnitStore = await loadProjectHashStore(workspace, CHILD_ONE);
  const childUndo = await saveUndo(
    unitPath,
    { content: "alpha\nbeta\ngamma\n", bom: "", originalEnding: "\n", hashes: [], resultContent: "alpha\nGAMMA\ngamma\n" },
    childUnitStore,
  );
  assert.equal(childUndo.persisted, true, "the child's saveUndo persists");
  let unitRecord = await getUndoRecord(unitPath, await loadProjectHashStore(workspace, PARENT_OWNER));
  assert.equal(unitRecord?.owner, CHILD_ONE, "the child's record replaced the parent's (one record per file)");
  await childUndo.restore();
  unitRecord = await getUndoRecord(unitPath, await loadProjectHashStore(workspace, PARENT_OWNER));
  assert.equal(unitRecord?.owner, PARENT_OWNER, "the rollback restores the prior record under the parent owner");
  childUnitStore.release();

  console.log("asymmetric revert authority tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
