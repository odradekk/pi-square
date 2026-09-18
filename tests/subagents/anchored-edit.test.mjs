import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredReplaceTool, createChildAnchoredInsertTool } = await load("../../src/anchored-edit/child-edit.ts");
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { loadAnchoredHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
function servedLookup(store, path, content) {
  const lookup = store.getServedState(path, content);
  return lookup !== undefined && "served" in lookup ? lookup.served : undefined;
}

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

const sessionDir = join(workspace, ".test-session");
const ctx = { cwd: workspace };
const storeDir = anchoredStoreDir(sessionDir, workspace);
const openStore = (owner) => loadAnchoredHashStore(storeDir, owner);

async function childReplace(owner) {
  return createChildAnchoredReplaceTool(workspace, owner, sessionDir);
}

async function childInsert(owner) {
  return createChildAnchoredInsertTool(workspace, owner, sessionDir);
}

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta\n");

  // The child editing tool is exactly replace (#187: revert and the undo store
  // are gone), carries the parent's schema, and is renderer-free so child tool
  // construction needs no display runtime.
  const replace = createChildAnchoredReplaceTool(workspace, CHILD_ONE, sessionDir);
  assert.equal(replace.name, "replace", "the child editing tool is the anchored replace");
  assert.equal(replace.renderShell, undefined, "child replace carries no pi-square display shell");
  assert.equal(replace.renderCall, undefined, "child replace stays renderer-free");
  assert.equal(replace.renderResult, undefined, "child replace stays renderer-free");
  assert.equal(replace.parameters.type, "object");
  assert.equal(replace.parameters.anyOf, undefined);
  assert.equal(replace.parameters.additionalProperties, false);
  assert.deepEqual(replace.parameters.required, ["remove_from", "remove_to", "replacement_text"]);

  // A child editing a region it read itself succeeds.
  const childRead = createChildAnchoredReadTool(workspace, CHILD_ONE, sessionDir);
  const readResult = await childRead.execute("child-read", { path: "source.txt" }, undefined, undefined, ctx);
  const anchors = readRows(readResult.content).map((row) => row.hash);
  const ownRegion = await replace.execute(
    "child-own",
    { path: "source.txt", remove_from: anchors[1], remove_to: anchors[2], replacement_text: "BETA2" },
    undefined, undefined, ctx,
  );
  assert.equal(ownRegion.details?.status, undefined, "a child editing a region it read itself succeeds");
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA2\ndelta\n", "the file changed as intended");

  // The replace recorded its post-edit rows under the editing child's own
  // owner; the parent's partition is not credited with the fresh anchor.
  const freshAnchor = ownRegion.details.diff.match(/([A-Za-z0-9]{3})│BETA2/)?.[1];
  assert.ok(freshAnchor, "the child replace carries a fresh anchor for the changed line");
  const childServedRows = servedLookup(await openStore(CHILD_ONE), source, "alpha\nBETA2\ndelta\n");
  assert.ok(childServedRows?.has(freshAnchor), "the child replace records post-edit rows under the child owner");
  const parentServedRows = servedLookup(await openStore(PARENT_OWNER), source, "alpha\nBETA2\ndelta\n");
  assert.ok(!parentServedRows?.has(freshAnchor), "the parent partition is not credited with the child's fresh anchor");

  // A child editing a region only the parent read is refused with the
  // recoverable stale-range code: the parent read serves rows under its own
  // owner only, and the child's replace always verifies against its own record.
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta\n");
  const parentRead = createChildAnchoredReadTool(workspace, PARENT_OWNER, sessionDir);
  const parentResult = await parentRead.execute("parent-read", { path: "source.txt" }, undefined, undefined, ctx);
  const parentAnchors = readRows(parentResult.content).map((row) => row.hash);

  const childTwoReplace = createChildAnchoredReplaceTool(workspace, CHILD_TWO, sessionDir);
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
  const servedAfterRefusal = servedLookup(await openStore(CHILD_TWO), source, "alpha\nbeta\ngamma\ndelta\n");
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
  const thirdRead = createChildAnchoredReadTool(workspace, CHILD_TWO, sessionDir);
  const thirdReadResult = await thirdRead.execute("third-read", { path: "other.txt" }, undefined, undefined, ctx);
  const thirdAnchors = readRows(thirdReadResult.content).map((row) => row.hash);
  const childOneAgain = createChildAnchoredReplaceTool(workspace, CHILD_ONE, sessionDir);
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
  const externalBlind = createChildAnchoredReplaceTool(workspace, CHILD_TWO, sessionDir);
  const parentExternalRead = createChildAnchoredReadTool(workspace, PARENT_OWNER, sessionDir);
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

  const childExternalRead = createChildAnchoredReadTool(workspace, CHILD_ONE, sessionDir);
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

  const externalServed = servedLookup(await openStore(CHILD_ONE), realpathSync(externalFile), "ext-alpha\nEDITED\next-gamma\n");
  assert.ok(externalServed && externalServed.size > 0, "the external child replace records served rows in the initiating workspace under the child owner");

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

  // A follow-up external replace through the served rows left by the previous
  // edit applies without another read (replace is the only path; there is no
  // revert, so the post-edit rows are the recovery surface).
  writeFileSync(externalFile, "ext-alpha\next-beta\next-gamma\n");
  const followUpRange = readRows(
    (await childExternalRead.execute("child-external-re-read", { path: "../external-edit.txt" }, undefined, undefined, ctx)).content,
  ).find((row) => row.text === "ext-beta").hash;
  await (await childReplace(CHILD_ONE)).execute(
    "child-external-replace",
    { path: "../external-edit.txt", remove_from: followUpRange, remove_to: followUpRange, replacement_text: "REPLACED" },
    undefined, undefined, ctx,
  );
  assert.equal(readFileSync(externalFile, "utf8"), "ext-alpha\nREPLACED\next-gamma\n", "the external file changed as intended");

  // A missing external file is refused, never created by the child replace.
  const missingChildReplace = await childReplace(CHILD_ONE);
  await assert.rejects(
    () => missingChildReplace.execute(
      "child-external-missing",
      { path: "../created-externally-by-child.txt", remove_from: followUpRange, remove_to: followUpRange, replacement_text: "no" },
      undefined, undefined, ctx,
    ),
    /E_NOT_FOUND/,
    "a missing external file is refused, never created by the child replace",
  );

  // ── Child insert (#287): the edit capability grants the anchored insert
  // next to replace, under the child's own owner partition, with the parent's
  // schema and no renderer fields.
  const insertTool = await childInsert(CHILD_ONE);
  assert.equal(insertTool.name, "insert", "the child editing surface carries the anchored insert");
  assert.equal(insertTool.renderShell, undefined, "child insert carries no pi-square display shell");
  assert.equal(insertTool.renderCall, undefined, "child insert stays renderer-free");
  assert.equal(insertTool.renderResult, undefined, "child insert stays renderer-free");
  assert.equal(insertTool.parameters.type, "object");
  assert.equal(insertTool.parameters.anyOf, undefined);
  assert.equal(insertTool.parameters.additionalProperties, false);
  assert.deepEqual(insertTool.parameters.required, ["anchor", "direction", "lines"]);

  // A child inserting after an anchor its own read served succeeds; one
  // empty-string item is one real blank logical line.
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta\n");
  const insertRead = createChildAnchoredReadTool(workspace, CHILD_ONE, sessionDir);
  const insertReadRows = readRows(
    (await insertRead.execute("child-insert-read", { path: "source.txt" }, undefined, undefined, ctx)).content,
  );
  const betaAnchor = insertReadRows.find((row) => row.text === "beta").hash;
  const inserted = await (await childInsert(CHILD_ONE)).execute(
    "child-insert",
    { path: "source.txt", anchor: betaAnchor, direction: "after", lines: ["BETA-NEXT", ""] },
    undefined, undefined, ctx,
  );
  assert.equal(inserted.details?.status, undefined, "a child inserting after an anchor it read itself succeeds");
  assert.equal(
    readFileSync(source, "utf8"),
    "alpha\nbeta\nBETA-NEXT\n\ngamma\ndelta\n",
    "the literal block landed with one real blank logical line",
  );

  // The insert recorded its served rows under the editing child's own owner;
  // the parent's partition is not credited with the inserted rows.
  const insertFresh = inserted.details.diff.match(/([A-Za-z0-9]{3})│BETA-NEXT/)?.[1];
  assert.ok(insertFresh, "the child insert carries a fresh anchor for the inserted line");
  const insertChildServed = servedLookup(await openStore(CHILD_ONE), source, "alpha\nbeta\nBETA-NEXT\n\ngamma\ndelta\n");
  assert.ok(insertChildServed?.has(insertFresh), "the child insert records served rows under the child owner");
  const insertParentServed = servedLookup(await openStore(PARENT_OWNER), source, "alpha\nbeta\nBETA-NEXT\n\ngamma\ndelta\n");
  assert.ok(!insertParentServed?.has(insertFresh), "the parent partition is not credited with the child's inserted rows");

  // The insert's returned rows authorize the child's next mutation without
  // another read (the child keeps auto-read on).
  const chained = await (await childInsert(CHILD_ONE)).execute(
    "child-insert-chain",
    { path: "source.txt", anchor: insertFresh, direction: "before", lines: ["BEFORE-BETA-NEXT"] },
    undefined, undefined, ctx,
  );
  assert.equal(chained.details?.status, undefined, "the insert's fresh rows authorize an immediate chained insert");
  assert.equal(
    readFileSync(source, "utf8"),
    "alpha\nbeta\nBEFORE-BETA-NEXT\nBETA-NEXT\n\ngamma\ndelta\n",
    "the chained insert landed literally at the fresh anchor",
  );

  // A child that never read the file cannot insert: authorization is mandatory
  // for every owner. The refusal is recoverable and serves the current
  // context to that child, so its immediate retry succeeds.
  const blindInsert = await (await childInsert(CHILD_TWO)).execute(
    "child-two-blind-insert",
    { path: "source.txt", anchor: betaAnchor, direction: "after", lines: ["NOPE"] },
    undefined, undefined, ctx,
  );
  assert.equal(blindInsert.details?.status, "warning", "an insert naming an anchor the child was never served is refused");
  assert.equal(blindInsert.details?.errorCode, "E_RANGE_STALE", "the unserved insert refusal uses the recoverable stale-range code");
  assert.match(textOf(blindInsert.content), /fresh anchors/, "the refusal carries the current context as anchored rows");
  const blindRetryRows = readRows(blindInsert.content);
  assert.ok(blindRetryRows.length > 0, "the refusal serves fresh rows for the retry");
  const blindRetry = await (await childInsert(CHILD_TWO)).execute(
    "child-two-blind-retry",
    { path: "source.txt", anchor: blindRetryRows[0].hash, direction: "after", lines: ["RETRY"] },
    undefined, undefined, ctx,
  );
  assert.equal(blindRetry.details?.status, undefined, "the refusal's fresh rows authorize the immediate retry");
  assert.equal(
    readFileSync(source, "utf8"),
    "alpha\nRETRY\nbeta\nBEFORE-BETA-NEXT\nBETA-NEXT\n\ngamma\ndelta\n",
    "the retry inserted exactly once after the first served row",
  );

  // An external modification invalidates the previous version's served rows
  // even when the anchor line still exists: version-bound authorization
  // refuses recoverably, and a fresh read republishes rows for the retry.
  writeFileSync(source, "one\ntwo\nthree\n");
  const staleReadRows = readRows(
    (await insertRead.execute("child-stale-read", { path: "source.txt" }, undefined, undefined, ctx)).content,
  );
  const twoAnchor = staleReadRows.find((row) => row.text === "two").hash;
  writeFileSync(source, "zero\none\ntwo\nthree\n");
  const staleInsert = await (await childInsert(CHILD_ONE)).execute(
    "child-stale-insert",
    { path: "source.txt", anchor: twoAnchor, direction: "after", lines: ["STALE"] },
    undefined, undefined, ctx,
  );
  assert.equal(staleInsert.details?.status, "warning", "a version-stale anchor is refused");
  assert.equal(staleInsert.details?.errorCode, "E_RANGE_STALE", "the stale-version refusal uses the recoverable code");
  assert.equal(readFileSync(source, "utf8"), "zero\none\ntwo\nthree\n", "nothing was inserted by the stale refusal");
  const rereadRows = readRows(
    (await insertRead.execute("child-stale-reread", { path: "source.txt" }, undefined, undefined, ctx)).content,
  );
  const freshTwo = rereadRows.find((row) => row.text === "two").hash;
  const staleRetry = await (await childInsert(CHILD_ONE)).execute(
    "child-stale-retry",
    { path: "source.txt", anchor: freshTwo, direction: "after", lines: ["AFTER-TWO"] },
    undefined, undefined, ctx,
  );
  assert.equal(staleRetry.details?.status, undefined, "a fresh read republishes rows that authorize the retry");
  assert.equal(readFileSync(source, "utf8"), "zero\none\ntwo\nAFTER-TWO\nthree\n", "the retried insert applied");

  // An empty file initializes through its served synthetic anchor; before
  // and after are the same initialization and a blank item stays a real line.
  const emptyTarget = join(workspace, "empty-init.txt");
  writeFileSync(emptyTarget, "");
  const emptyRows = readRows(
    (await insertRead.execute("child-empty-read", { path: "empty-init.txt" }, undefined, undefined, ctx)).content,
  );
  assert.equal(emptyRows.length, 1, "an empty-file read serves exactly the synthetic anchor row");
  const emptyInit = await (await childInsert(CHILD_ONE)).execute(
    "child-empty-init",
    { path: "empty-init.txt", anchor: emptyRows[0].hash, direction: "before", lines: ["first", ""] },
    undefined, undefined, ctx,
  );
  assert.equal(emptyInit.details?.status, undefined, "an empty file initializes through its synthetic anchor");
  assert.equal(readFileSync(emptyTarget, "utf8"), "first\n\n", "initialization kept the blank item as one real logical line");

  // Native path authority (#186): the child insert edits an existing external
  // target it read itself, and its served rows land in the initiating
  // workspace under the child owner.
  const externalInsertFile = join(root, "external-insert.txt");
  writeFileSync(externalInsertFile, "ext-one\next-two\n");
  const extInsertRows = readRows(
    (await insertRead.execute("child-ext-insert-read", { path: "../external-insert.txt" }, undefined, undefined, ctx)).content,
  );
  const extTwoAnchor = extInsertRows.find((row) => row.text === "ext-two").hash;
  const extInsert = await (await childInsert(CHILD_ONE)).execute(
    "child-ext-insert",
    { path: "../external-insert.txt", anchor: extTwoAnchor, direction: "after", lines: ["EXT-NEW"] },
    undefined, undefined, ctx,
  );
  assert.equal(extInsert.details?.status, undefined, "a child inserting into an external target it read itself succeeds");
  assert.equal(readFileSync(externalInsertFile, "utf8"), "ext-one\next-two\nEXT-NEW\n", "the external file changed as intended");
  const extInsertServed = servedLookup(await openStore(CHILD_ONE), realpathSync(externalInsertFile), "ext-one\next-two\nEXT-NEW\n");
  assert.ok(extInsertServed && extInsertServed.size > 0, "the external child insert records served rows under the child owner");

  // A missing target is refused, never created by the child insert.
  await assert.rejects(
    async () => (await childInsert(CHILD_ONE)).execute(
      "child-missing-insert",
      { path: "../never-created-by-child-insert.txt", anchor: "abc", direction: "after", lines: ["x"] },
      undefined, undefined, ctx,
    ),
    /E_NOT_FOUND/,
    "a missing target is refused, never created by the child insert",
  );
  assert.ok(!existsSync(join(root, "never-created-by-child-insert.txt")), "insert never creates a missing target");

  // Session assembly: a writable child that declares edit with anchored editing
  // on gets the anchored replace and insert appended; read-only roles and
  // disabled editing get none.
  const assembled = { definitions: [] };
  const replaced = __testables.appendChildAnchoredEdit(assembled, {
    anchoredEditing: true,
    builtInTools: ["read", "write", "edit"],
    cwd: workspace,
    owner: CHILD_ONE,
    sessionDir,
  });
  assert.equal(replaced, true, "a writable child that declares edit replaces the capability");
  assert.deepEqual(
    assembled.definitions.map((definition) => definition.name),
    ["replace", "insert"],
    "the edit capability resolves to the anchored replace and insert only",
  );

  const readOnly = { definitions: [] };
  const readOnlyReplaced = __testables.appendChildAnchoredEdit(readOnly, {
    anchoredEditing: true,
    builtInTools: ["read", "ls"],
    cwd: workspace,
    owner: CHILD_ONE,
    sessionDir,
  });
  assert.equal(readOnlyReplaced, false, "read-only roles receive no editing capability");
  assert.equal(readOnly.definitions.length, 0, "read-only roles receive no anchored tools");

  const writeOnly = { definitions: [] };
  const writeOnlyReplaced = __testables.appendChildAnchoredEdit(writeOnly, {
    anchoredEditing: true,
    builtInTools: ["read", "write"],
    cwd: workspace,
    owner: CHILD_ONE,
    sessionDir,
  });
  assert.equal(writeOnlyReplaced, false, "a child without the edit capability receives no anchored edit tools");

  const disabled = { definitions: [] };
  const disabledReplaced = __testables.appendChildAnchoredEdit(disabled, {
    anchoredEditing: false,
    builtInTools: ["read", "write", "edit"],
    cwd: workspace,
    owner: CHILD_ONE,
    sessionDir,
  });
  assert.equal(disabledReplaced, false, "disabled anchored editing adds no anchored tools");

  // Capability resolution of the effective allowlist: replacing edit removes
  // the built-in edit tool and adds both anchored tool names, so the custom
  // definitions stay active and no unrelated capability is broadened.
  const replacedList = __testables.resolveChildToolAllowlist(["read", "write", "edit", "ls"], true);
  assert.deepEqual(replacedList, ["read", "write", "ls", "replace", "insert"], "edit is removed and both anchored mutation names are added");
  const plainList = __testables.resolveChildToolAllowlist(["read", "write", "edit"], false);
  assert.deepEqual(plainList, ["read", "write", "edit"], "without replacement the allowlist is unchanged");

  // Resume re-resolves the capability against the current configuration rather
  // than a frozen set: the persisted selection keeps the logical edit tool, and
  // the mapping is re-derived on every run from the current anchoredEditing
  // flag. A frozen resolution would persist replace by name, which the
  // capability gate forbids.
  const { resolveSubagentTools } = await load("../../src/subagents/tool-policy.ts");
  const generalist = resolveSubagentTools({
    tools: ["read", "write", "edit", "shell", "ls"],
    extensionTools: ["web_search", "web_fetch", "library_search", "library_docs"],
  }, "linux");
  assert.ok(!generalist.persistedTools.includes("replace"), "the persisted selection never freezes the anchored tool names");
  assert.ok(!generalist.persistedTools.includes("insert"), "the persisted selection never freezes the anchored insert name");
  assert.ok(!generalist.builtInTools.includes("insert"), "insert is never resolved as an ordinary built-in tool");
  assert.ok(generalist.persistedTools.includes("edit"), "the persisted selection keeps the logical edit capability");
  const resumedOn = { definitions: [] };
  const resumedOnReplaced = __testables.appendChildAnchoredEdit(resumedOn, {
    anchoredEditing: true,
    builtInTools: generalist.builtInTools,
    cwd: workspace,
    owner: CHILD_ONE,
    sessionDir,
  });
  assert.equal(resumedOnReplaced, true, "resume with anchored editing on re-maps the edit capability to both anchored tools");
  assert.deepEqual(
    resumedOn.definitions.map((definition) => definition.name),
    ["replace", "insert"],
    "a resumed writable child receives the same replace-plus-insert surface as a fresh one",
  );
  const resumedOff = { definitions: [] };
  const resumedOffReplaced = __testables.appendChildAnchoredEdit(resumedOff, {
    anchoredEditing: false,
    builtInTools: generalist.builtInTools,
    cwd: workspace,
    owner: CHILD_ONE,
    sessionDir,
  });
  assert.equal(resumedOffReplaced, false, "resume with anchored editing off keeps Pi's built-in edit and no anchored tools");

  console.log("child anchored edit tests: OK");
} finally {
  shutdownHashStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
