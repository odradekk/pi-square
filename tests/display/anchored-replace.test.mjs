import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
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
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");

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

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "first\nmiddle\nlast\n", { encoding: "utf8", flag: "w" });
  await initializeAnchoredReadStore(workspace);

  const initialRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
  );
  const initialRows = readRows(initialRead);
  const first = initialRows.find((row) => row.text === "first");
  const middle = initialRows.find((row) => row.text === "middle");
  const last = initialRows.find((row) => row.text === "last");
  assert.ok(first && middle && last, "anchored read serves each source row");

  const replace = createAnchoredReplaceToolDefinition(workspace);
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
  ).render(100).join("\n"));
  assert.match(warningText, /^! Replace/, "anchor refusals render as completed warnings");
  assert.equal((warningText.match(/Nothing was modified/g) ?? []).length, 1, "the anchored refusal text is rendered once");

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

  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside\n", "utf8");
  await assert.rejects(
    () => replace.execute(
      "replace-outside",
      {
        path: "../outside.txt",
        remove_from: first.hash,
        remove_to: first.hash,
        replacement_text: "blocked",
      },
      undefined,
      undefined,
      { cwd: workspace },
    ),
    /E_OUTSIDE_WORKSPACE.*Disable anchoredEditing\.enabled/s,
    "outside paths are refused with the named built-in alternative",
  );
  assert.equal(readFileSync(outside, "utf8"), "outside\n", "an outside refusal does not alter the file");

  console.log("anchored replace integration tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
