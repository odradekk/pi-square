import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  initializeAnchoredReadStore,
  transformAnchoredReadContent,
} = await load("../../src/anchored-edit/read-transform.ts");
const {
  createAnchoredReplaceToolDefinition,
} = await load("../../src/anchored-edit/workspace-replace.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");

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

function diffRows(diff) {
  return diff.split("\n").flatMap((line) => {
    const match = /^([ +\-])([A-Za-z0-9]{3})│(.*)$/.exec(line);
    return match ? [{ marker: match[1], hash: match[2], text: match[3] }] : [];
  });
}

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-replace-"));
const workspace = join(root, "workspace");
const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
mkdirSync(workspace, { recursive: true });

const sessionDir = join(workspace, ".test-session");
const storePath = join(sessionDir, "anchored-edit", "hash-store.sqlite");
const lockDirOf = () => join(sessionDir, "anchored-edit", "locks");

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "first\nmiddle\nlast\n", { encoding: "utf8", flag: "w" });
  await initializeAnchoredReadStore(workspace, sessionDir);

  const initialRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const initialRows = readRows(initialRead);
  const first = initialRows.find((row) => row.text === "first");
  const middle = initialRows.find((row) => row.text === "middle");
  const last = initialRows.find((row) => row.text === "last");
  assert.ok(first && middle && last, "anchored read serves each source row");

  const replace = createAnchoredReplaceToolDefinition(workspace, undefined, undefined, undefined, undefined, sessionDir);
  const changed = await replace.execute(
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
  const changedDiff = changed.details.diff;
  const changedRows = diffRows(changedDiff);
  assert.ok(changedRows.some((row) => row.marker === "-" && row.hash === middle.hash && row.text === "middle"), "result keeps the removed row's former anchor");
  assert.ok(changedRows.some((row) => row.marker === " " && row.hash === first.hash && row.text === "first"), "an untouched preceding row keeps its anchor");
  assert.ok(changedRows.some((row) => row.marker === " " && row.hash === last.hash && row.text === "last"), "an untouched following row keeps its anchor");
  const replaced = changedRows.find((row) => row.marker === "+" && row.text === "replaced");
  assert.ok(replaced, "result contains the replacement with a fresh anchor");
  assert.notEqual(replaced.hash, middle.hash, "a changed line receives a new anchor instead of the removed line's anchor");

  const silent = join(workspace, "silent.txt");
  writeFileSync(silent, "before\n", "utf8");
  const silentRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "silent.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const silentRow = readRows(silentRead)[0];
  assert.ok(silentRow);
  const silentReplace = await createAnchoredReplaceToolDefinition(workspace, () => false, undefined, undefined, undefined, sessionDir).execute(
    "replace-silent",
    { path: "silent.txt", remove_from: silentRow.hash, remove_to: silentRow.hash, replacement_text: "after" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(silentReplace.details.diff, "", "disabled auto-read suppresses replace post-edit anchors");

  await replace.execute(
    "replace-2",
    {
      path: "source.txt",
      remove_from: replaced.hash,
      remove_to: replaced.hash,
      replacement_text: "again",
    },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(readFileSync(source, "utf8"), "first\nagain\nlast\n", "post-edit rows make a second replace possible without another read");

  const stale = join(workspace, "stale.txt");
  writeFileSync(stale, "first\nmiddle\nlast\n", "utf8");
  const staleRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "stale.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const staleRows = readRows(staleRead);
  const staleFirst = staleRows.find((row) => row.text === "first");
  const staleLast = staleRows.find((row) => row.text === "last");
  assert.ok(staleFirst && staleLast);
  writeFileSync(stale, "first\nexternal\nlast\n", "utf8");

  const refusal = await replace.execute(
    "replace-stale",
    {
      path: "stale.txt",
      remove_from: staleFirst.hash,
      remove_to: staleLast.hash,
      replacement_text: "first\nchanged\nlast",
    },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(refusal.isError, undefined, "anchor refusals are completed warning results");
  assert.equal(refusal.details.status, "warning");
  assert.match(textOf(refusal.content), /\[E_RANGE_STALE\]/);
  assert.equal(readFileSync(stale, "utf8"), "first\nexternal\nlast\n", "a stale range does not write the file");
  const refusalRows = readRows(refusal.content);
  assert.deepEqual(refusalRows.map((row) => row.text), ["first", "external", "last"], "a refusal returns the current range as anchored rows");

  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const decoratedReplace = decorateInternalTool(createAnchoredReplaceToolDefinition(workspace), () => runtime);
  const warningText = stripVTControlCharacters(decoratedReplace.renderResult(
    refusal,
    { expanded: true, isPartial: false },
    plainTheme,
    {
      args: {
        path: "stale.txt",
        remove_from: staleFirst.hash,
        remove_to: staleLast.hash,
        replacement_text: "first\nchanged\nlast",
      },
      toolCallId: "replace-stale",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: workspace,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    },
  ).render(120).join("\n"));
  assert.match(warningText, /^! Replace/, "anchor refusals render as completed warnings");
  assert.equal(
    (warningText.match(/Nothing was modified · stale range/g) ?? []).length,
    1,
    "the concise anchored-refusal summary renders once in the header",
  );

  const diffText = stripVTControlCharacters(decoratedReplace.renderResult(
    changed,
    { expanded: true, isPartial: false },
    plainTheme,
    {
      args: {
        path: "source.txt",
        remove_from: middle.hash,
        remove_to: middle.hash,
        replacement_text: "replaced",
      },
      toolCallId: "replace-1",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: workspace,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    },
  ).render(100).join("\n"));
  assert.match(diffText, /middle/, "replace renders removed rows through the production diff adapter");
  assert.match(diffText, /replaced/, "replace renders added rows through the production diff adapter");
  assert.doesNotMatch(diffText, /PROJECTED/, "replace diffs are authoritative");

  const failureText = stripVTControlCharacters(decoratedReplace.renderResult(
    {
      content: [{ type: "text", text: "Could not open file\nEACCES raw platform detail" }],
      isError: true,
      details: {},
    },
    { expanded: true, isPartial: false },
    plainTheme,
    {
      args: { path: "missing.txt", remove_from: "abc", remove_to: "abc", replacement_text: "x" },
      toolCallId: "replace-error",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: workspace,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: true,
    },
  ).render(100).join("\n"));
  assert.match(failureText, /^× Replace/, "environment errors render with a failed lifecycle");
  assert.equal((failureText.match(/EACCES raw platform detail/g) ?? []).length, 1, "raw platform error text renders once");
  runtime.dispose();

  await replace.execute(
    "replace-retry",
    {
      path: "stale.txt",
      remove_from: refusalRows[0].hash,
      remove_to: refusalRows[2].hash,
      replacement_text: "first\nchanged\nlast",
    },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(readFileSync(stale, "utf8"), "first\nchanged\nlast\n", "refusal rows count as served for an immediate retry");

  const resolvedPath = join(workspace, "resolved.txt");
  writeFileSync(resolvedPath, "left\ntarget\nright\n", "utf8");
  const resolvedRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "resolved.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const target = readRows(resolvedRead).find((row) => row.text === "target");
  assert.ok(target, "anchored read records the only matching path");
  const omittedPath = await replace.execute(
    "replace-omitted-path",
    {
      remove_from: target.hash,
      remove_to: target.hash,
      replacement_text: "resolved",
    },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(readFileSync(resolvedPath, "utf8"), "left\nresolved\nright\n", "a unique anchor pair resolves an omitted path from project state");
  assert.match(textOf(omittedPath.content), /missing "path" resolved/, "omitted-path correction is reported");

  const malformedPath = join(workspace, "malformed.txt");
  writeFileSync(malformedPath, "left\nmalformed\nright\n", "utf8");
  const malformedRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "malformed.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const malformedAnchor = readRows(malformedRead).find((row) => row.text === "malformed");
  assert.ok(malformedAnchor);
  await assert.rejects(
    () => replace.execute(
      "replace-malformed-path",
      {
        path: null,
        remove_from: malformedAnchor.hash,
        remove_to: malformedAnchor.hash,
        replacement_text: "must not write",
      },
      undefined,
      undefined,
      { cwd: workspace },
    ),
    /E_BAD_SHAPE/,
    "an invalid path type is not inferred as an omitted path",
  );
  assert.equal(readFileSync(malformedPath, "utf8"), "left\nmalformed\nright\n", "a malformed request leaves the named file untouched");

  // ── Native path authority (#185): the parent replace edits existing
  // external regular text files under the same validation, mutation queue,
  // and the initiating workspace's canonical-target lock key. The child
  // definition keeps the workspace-containment refusal until its own slice.
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside\nexternal-middle\n", "utf8");
  const externalRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "../outside.txt" },
    workspace,
    "parent",
    { confineToWorkspace: false, sessionDir },
  );
  const externalMiddle = readRows(externalRead).find((row) => row.text === "external-middle");
  assert.ok(externalMiddle, "the parent anchored read serves external rows");

  const parentReplace = createAnchoredReplaceToolDefinition(workspace, undefined, undefined, undefined, false, sessionDir);
  const externalEdit = await parentReplace.execute(
    "replace-external",
    {
      path: "../outside.txt",
      remove_from: externalMiddle.hash,
      remove_to: externalMiddle.hash,
      replacement_text: "edited externally",
    },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(externalEdit.details.status, undefined, "an external replace succeeds");
  assert.equal(readFileSync(outside, "utf8"), "outside\nedited externally\n", "the external file is edited in place");

  const externalStore = new DatabaseSync(storePath, { timeout: 500 });
  try {
    assert.ok(
      externalStore.prepare("SELECT COUNT(*) AS count FROM served WHERE path = ?").get(realpathSync(outside)).count > 0,
      "an external replace records its served rows in the initiating workspace's store",
    );
    assert.equal(
      externalStore.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'undo'").get().count,
      0,
      "the undo-free store creates no undo table (#187)",
    );
  } finally {
    externalStore.close();
  }
  const lockDir = lockDirOf();
  assert.ok(
    !existsSync(lockDir) || readdirSync(lockDir).length === 0,
    "a completed external replace leaves no lock residue in the initiating workspace",
  );

  await assert.rejects(
    () => parentReplace.execute(
      "replace-external-missing",
      {
        path: "../created-by-replace.txt",
        remove_from: externalMiddle.hash,
        remove_to: externalMiddle.hash,
        replacement_text: "must not create",
      },
      undefined,
      undefined,
      { cwd: workspace },
    ),
    /E_NOT_FOUND/,
    "a missing external file is refused, never created by replace",
  );
  assert.equal(existsSync(join(root, "created-by-replace.txt")), false, "replace did not create the external file");

  // #186: the child composition (requireServed, native paths) refuses a
  // parent-served external anchor recoverably — the child must read the range
  // itself — instead of refusing the external path.
  {
    const childComposition = createAnchoredReplaceToolDefinition(workspace, undefined, "subagent_child_probe", true, false, sessionDir);
    const servedChildRead = await transformAnchoredReadContent(
      [{ type: "text", text: "factory content" }],
      { path: "../outside.txt" },
      workspace,
      "subagent_child_probe",
      { confineToWorkspace: false, sessionDir },
    );
    const servedRow = readRows(servedChildRead).find((row) => row.text === "edited externally");
    assert.ok(servedRow, "the child-surface read serves the external row");
    // Name an anchor the parent served but this child never read.
    const refusedChild = await childComposition.execute(
      "replace-outside-child",
      {
        path: "../outside.txt",
        remove_from: externalMiddle.hash,
        remove_to: externalMiddle.hash,
        replacement_text: "blocked",
      },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.equal(refusedChild.details.status, "warning", "the child external refusal is a completed warning");
    assert.ok(
      ["E_RANGE_STALE", "E_STALE_ANCHOR", "E_AMBIGUOUS_ANCHOR"].includes(refusedChild.details.errorCode),
      `the child external refusal stays recoverable (${refusedChild.details.errorCode})`,
    );
    assert.equal(readFileSync(outside, "utf8"), "outside\nedited externally\n", "the refusal modifies nothing");

    const childEdit = await childComposition.execute(
      "replace-outside-child-served",
      {
        path: "../outside.txt",
        remove_from: servedRow.hash,
        remove_to: servedRow.hash,
        replacement_text: "child edited",
      },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.equal(childEdit.details.status, undefined, "the child surface edits an external range it read itself");
    assert.equal(readFileSync(outside, "utf8"), "outside\nchild edited\n", "the child edit applied");
  }

  console.log("anchored replace integration tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
