import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredEditTools } = await load("../../src/anchored-edit/child-edit.ts");
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { loadProjectHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { getServed } = await load("../../src/anchored-edit/served.ts");
const { getUndo } = await load("../../src/anchored-edit/replace-undo.ts");
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

const root = mkdtempSync(join(tmpdir(), "pi-square-child-anchored-edit-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const ctx = { cwd: workspace };

async function childReplace(owner) {
  const [replace] = createChildAnchoredEditTools(workspace, owner);
  return replace;
}

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta\n");

  // The child editing tools are exactly replace and revert, carry the parent's
  // schemas, and are renderer-free so child tool construction needs no display
  // runtime.
  const [replace, revert] = createChildAnchoredEditTools(workspace, CHILD_ONE);
  assert.equal(replace.name, "replace", "the child editing tool is the anchored replace");
  assert.equal(revert.name, "revert", "the child editing tool is the anchored revert");
  assert.equal(replace.renderShell, undefined, "child replace carries no pi-square display shell");
  assert.equal(revert.renderShell, undefined, "child revert carries no pi-square display shell");
  assert.equal(replace.renderCall, undefined, "child replace stays renderer-free");
  assert.equal(replace.renderResult, undefined, "child replace stays renderer-free");
  assert.equal(revert.renderCall, undefined, "child revert stays renderer-free");
  assert.equal(revert.renderResult, undefined, "child revert stays renderer-free");
  assert.equal(replace.parameters.type, "object");
  assert.equal(replace.parameters.anyOf, undefined);
  assert.equal(replace.parameters.additionalProperties, false);
  assert.deepEqual(replace.parameters.required, ["remove_from", "remove_to", "replacement_text"]);
  assert.equal(revert.parameters.type, "object");
  assert.equal(revert.parameters.anyOf, undefined);
  assert.equal(revert.parameters.additionalProperties, false);
  assert.deepEqual(revert.parameters.required, ["path"]);

  // A child editing a region it read itself succeeds.
  const childRead = createChildAnchoredReadTool(workspace, CHILD_ONE);
  const readResult = await childRead.execute("child-read", { path: "source.txt" }, undefined, undefined, ctx);
  const anchors = readRows(readResult.content).map((row) => row.hash);
  const ownRegion = await replace.execute(
    "child-own",
    { path: "source.txt", remove_from: anchors[1], remove_to: anchors[2], replacement_text: "BETA2" },
    undefined, undefined, ctx,
  );
  assert.equal(ownRegion.details?.status, undefined, "a child editing a region it read itself succeeds");
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA2\ndelta\n", "the file changed as intended");

  // The replace wrote its undo record under the editing child's own owner; the
  // parent's partition does not see it.
  assert.ok(
    await getUndo(source, await loadProjectHashStore(workspace, CHILD_ONE)),
    "the child replace persists a revert record under the child's own owner",
  );
  assert.equal(
    await getUndo(source, await loadProjectHashStore(workspace, PARENT_OWNER)),
    undefined,
    "the parent's revert record is not affected by the child's edit",
  );

  // The child revert restores the file and clears the child's undo record.
  const revertResult = await revert.execute("child-revert", { path: "source.txt" }, undefined, undefined, ctx);
  assert.match(textOf(revertResult.content), /Reverted the last replace/, "the child revert restores the file");
  assert.equal(readFileSync(source, "utf8"), "alpha\nbeta\ngamma\ndelta\n", "the file is restored");
  assert.equal(
    await getUndo(source, await loadProjectHashStore(workspace, CHILD_ONE)),
    undefined,
    "the child revert clears the child's undo record",
  );

  // A child editing a region only the parent read is refused with the
  // recoverable stale-range code: the parent read serves rows under its own
  // owner only, and the child's replace always verifies against its own record.
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta\n");
  const parentRead = createChildAnchoredReadTool(workspace, PARENT_OWNER);
  const parentResult = await parentRead.execute("parent-read", { path: "source.txt" }, undefined, undefined, ctx);
  const parentAnchors = readRows(parentResult.content).map((row) => row.hash);

  const [childTwoReplace] = createChildAnchoredEditTools(workspace, CHILD_TWO);
  const refused = await childTwoReplace.execute(
    "child-two",
    { path: "source.txt", remove_from: parentAnchors[1], remove_to: parentAnchors[2], replacement_text: "BETA2" },
    undefined, undefined, ctx,
  );
  assert.equal(refused.details?.status, "warning", "the blind child edit is refused");
  assert.equal(refused.details?.errorCode, "E_RANGE_STALE", "the refusal uses the recoverable stale-range code");
  assert.match(textOf(refused.content), /Current range with fresh anchors/, "the refusal carries the current range as anchored rows");
  assert.equal(readFileSync(source, "utf8"), "alpha\nbeta\ngamma\ndelta\n", "nothing was modified by the refusal");

  // The refusal made the current range served for that child, so its immediate
  // retry with the same anchors is not refused again.
  const servedAfterRefusal = getServed(await loadProjectHashStore(workspace, CHILD_TWO), source);
  assert.ok(servedAfterRefusal && servedAfterRefusal.size > 0, "the refusal serves the current range under the child");
  const retry = await childTwoReplace.execute(
    "child-two-retry",
    { path: "source.txt", remove_from: parentAnchors[1], remove_to: parentAnchors[2], replacement_text: "BETA2" },
    undefined, undefined, ctx,
  );
  assert.equal(retry.details?.status, undefined, "the child's immediate retry is not refused again");
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA2\ndelta\n", "the retry applied the edit");

  // Two children keep separate served records: a second child's read never
  // makes a first child's edit legal.
  const other = join(workspace, "other.txt");
  writeFileSync(other, "one\ntwo\nthree\n");
  const thirdRead = createChildAnchoredReadTool(workspace, CHILD_TWO);
  const thirdReadResult = await thirdRead.execute("third-read", { path: "other.txt" }, undefined, undefined, ctx);
  const thirdAnchors = readRows(thirdReadResult.content).map((row) => row.hash);
  const [childOneAgain] = createChildAnchoredEditTools(workspace, CHILD_ONE);
  const thirdRefused = await childOneAgain.execute(
    "child-one",
    { path: "other.txt", remove_from: thirdAnchors[1], remove_to: thirdAnchors[2], replacement_text: "TWO" },
    undefined, undefined, ctx,
  );
  assert.equal(thirdRefused.details?.errorCode, "E_RANGE_STALE", "verification consults only the calling child's own record");

  // ── Native path authority (#186): the child replace edits an external file
  // only through its own served record. A blind anchor from another agent's
  // read is refused recoverably and serves the current range; after the child
  // itself reads the range, the same edit applies. Stale and ambiguous
  // anchors stay recoverable safety refusals rather than tool failures.
  const externalFile = join(root, "external-edit.txt");
  writeFileSync(externalFile, "ext-alpha\next-beta\next-gamma\n");
  const [externalBlind] = createChildAnchoredEditTools(workspace, CHILD_TWO);
  const parentExternalRead = createChildAnchoredReadTool(workspace, PARENT_OWNER);
  const parentExternalRows = readRows(
    (await parentExternalRead.execute("parent-external-read", { path: "../external-edit.txt" }, undefined, undefined, ctx)).content,
  );
  const externalBeta = parentExternalRows.find((row) => row.text === "ext-beta").hash;
  const blindRefusal = await externalBlind.execute(
    "child-external-blind",
    { path: "../external-edit.txt", remove_from: externalBeta, remove_to: externalBeta, replacement_text: "EDITED" },
    undefined, undefined, ctx,
  );
  assert.equal(blindRefusal.details?.status, "warning", "a child naming anchors another agent read is refused");
  assert.ok(
    ["E_RANGE_STALE", "E_STALE_ANCHOR", "E_AMBIGUOUS_ANCHOR"].includes(blindRefusal.details?.errorCode),
    `the external blind refusal stays recoverable (${blindRefusal.details?.errorCode})`,
  );
  assert.match(textOf(blindRefusal.content), /fresh anchors|Current range|Call read/i, "the refusal carries recoverable feedback");
  assert.equal(readFileSync(externalFile, "utf8"), "ext-alpha\next-beta\next-gamma\n", "the external file is untouched by the refusal");

  const childExternalRead = createChildAnchoredReadTool(workspace, CHILD_ONE);
  const childExternalRows = readRows(
    (await childExternalRead.execute("child-external-read", { path: "../external-edit.txt" }, undefined, undefined, ctx)).content,
  );
  const childExternalBeta = childExternalRows.find((row) => row.text === "ext-beta").hash;
  const externalEdit = await (await childReplace(CHILD_ONE)).execute(
    "child-external-edit",
    { path: "../external-edit.txt", remove_from: childExternalBeta, remove_to: childExternalBeta, replacement_text: "EDITED" },
    undefined, undefined, ctx,
  );
  assert.equal(externalEdit.details?.status, undefined, "a child editing an external range it read itself succeeds");
  assert.equal(readFileSync(externalFile, "utf8"), "ext-alpha\nEDITED\next-gamma\n", "the external file changed as intended");

  assert.ok(
    await getUndo(realpathSync(externalFile), await loadProjectHashStore(workspace, CHILD_ONE)),
    "the external child replace persists its revert record in the initiating workspace under the child owner",
  );

  // A stale external anchor is a recoverable warning with fresh rows.
  writeFileSync(externalFile, "ext-alpha\nchanged-on-disk\next-gamma\n");
  const staleExternal = await (await childReplace(CHILD_ONE)).execute(
    "child-external-stale",
    { path: "../external-edit.txt", remove_from: childExternalBeta, remove_to: childExternalBeta, replacement_text: "SHOULD NOT APPLY" },
    undefined, undefined, ctx,
  );
  assert.equal(staleExternal.details?.status, "warning", "a stale external anchor is a completed warning");
  assert.ok(
    ["E_RANGE_STALE", "E_STALE_ANCHOR", "E_AMBIGUOUS_ANCHOR"].includes(staleExternal.details?.errorCode),
    `the stale external refusal stays recoverable (${staleExternal.details?.errorCode})`,
  );
  assert.match(
    textOf(staleExternal.content),
    /Call read\(\) to get fresh anchors/,
    "the stale refusal carries recoverable fresh-anchor feedback",
  );

  // The child revert follows the external replace through the same authority.
  // The child revert is owner-scoped (revertAnyOwner: false), so it is built
  // from the same child that made the edit.
  const [, childOneRevert] = createChildAnchoredEditTools(workspace, CHILD_ONE);
  writeFileSync(externalFile, "ext-alpha\next-beta\next-gamma\n");
  const revertRange = readRows(
    (await childExternalRead.execute("child-external-re-read", { path: "../external-edit.txt" }, undefined, undefined, ctx)).content,
  ).find((row) => row.text === "ext-beta").hash;
  await (await childReplace(CHILD_ONE)).execute(
    "child-external-replace",
    { path: "../external-edit.txt", remove_from: revertRange, remove_to: revertRange, replacement_text: "REPLACED" },
    undefined, undefined, ctx,
  );
  const externalRevertResult = await childOneRevert.execute(
    "child-external-revert",
    { path: "../external-edit.txt" },
    undefined, undefined, ctx,
  );
  assert.match(textOf(externalRevertResult.content), /Reverted the last replace/, "the child revert restores an external file");
  assert.equal(readFileSync(externalFile, "utf8"), "ext-alpha\next-beta\next-gamma\n", "the external file is restored");

  // A missing external file is refused, never created by the child replace.
  const missingChildReplace = await childReplace(CHILD_ONE);
  await assert.rejects(
    () => missingChildReplace.execute(
      "child-external-missing",
      { path: "../created-externally-by-child.txt", remove_from: revertRange, remove_to: revertRange, replacement_text: "no" },
      undefined, undefined, ctx,
    ),
    /E_NOT_FOUND/,
    "a missing external file is refused, never created by the child replace",
  );

  // Session assembly: a writable child that declares edit with anchored editing
  // on gets the anchored replace and revert appended; read-only roles and
  // disabled editing get none.
  const assembled = { definitions: [] };
  const replaced = __testables.appendChildAnchoredEdit(assembled, {
    anchoredEditing: true,
    builtInTools: ["read", "write", "edit"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(replaced, true, "a writable child that declares edit replaces the capability");
  assert.deepEqual(
    assembled.definitions.map((definition) => definition.name),
    ["replace", "revert"],
    "the edit capability resolves to the anchored replace and revert",
  );

  const readOnly = { definitions: [] };
  const readOnlyReplaced = __testables.appendChildAnchoredEdit(readOnly, {
    anchoredEditing: true,
    builtInTools: ["read", "ls"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(readOnlyReplaced, false, "read-only roles receive no editing capability");
  assert.equal(readOnly.definitions.length, 0, "read-only roles receive no anchored tools");

  const writeOnly = { definitions: [] };
  const writeOnlyReplaced = __testables.appendChildAnchoredEdit(writeOnly, {
    anchoredEditing: true,
    builtInTools: ["read", "write"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(writeOnlyReplaced, false, "a child without the edit capability receives no anchored edit tools");

  const disabled = { definitions: [] };
  const disabledReplaced = __testables.appendChildAnchoredEdit(disabled, {
    anchoredEditing: false,
    builtInTools: ["read", "write", "edit"],
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(disabledReplaced, false, "disabled anchored editing adds no anchored tools");

  // Capability resolution of the effective allowlist: replacing edit removes
  // the built-in edit tool and adds the anchored tool names, so the child has
  // exactly one editing path and the custom definitions stay active.
  const replacedList = __testables.resolveChildToolAllowlist(["read", "write", "edit", "ls"], true);
  assert.deepEqual(replacedList, ["read", "write", "ls", "replace", "revert"], "edit is removed and replace/revert are added");
  const plainList = __testables.resolveChildToolAllowlist(["read", "write", "edit"], false);
  assert.deepEqual(plainList, ["read", "write", "edit"], "without replacement the allowlist is unchanged");

  // Resume re-resolves the capability against the current configuration rather
  // than a frozen set: the persisted selection keeps the logical edit tool, and
  // the mapping is re-derived on every run from the current anchoredEditing
  // flag. A frozen resolution would persist replace/revert by name, which the
  // capability gate forbids.
  const { resolveSubagentTools } = await load("../../src/subagents/tool-policy.ts");
  const generalist = resolveSubagentTools({
    tools: ["read", "write", "edit", "shell", "ls"],
    extensionTools: ["rg", "fd", "codegraph", "search", "fetch", "libs", "docs"],
  }, "linux");
  assert.ok(!generalist.persistedTools.includes("replace"), "the persisted selection never freezes the anchored tool names");
  assert.ok(generalist.persistedTools.includes("edit"), "the persisted selection keeps the logical edit capability");
  const resumedOn = { definitions: [] };
  const resumedOnReplaced = __testables.appendChildAnchoredEdit(resumedOn, {
    anchoredEditing: true,
    builtInTools: generalist.builtInTools,
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(resumedOnReplaced, true, "resume with anchored editing on re-maps the edit capability to the anchored tools");
  const resumedOff = { definitions: [] };
  const resumedOffReplaced = __testables.appendChildAnchoredEdit(resumedOff, {
    anchoredEditing: false,
    builtInTools: generalist.builtInTools,
    cwd: workspace,
    owner: CHILD_ONE,
  });
  assert.equal(resumedOffReplaced, false, "resume with anchored editing off keeps Pi's built-in edit and no anchored tools");

  console.log("child anchored edit tests: OK");
} finally {
  shutdownHashStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
