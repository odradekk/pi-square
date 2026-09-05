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
  createAnchoredInsertToolDefinition,
} = await load("../../src/anchored-edit/workspace-insert.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { getCatalogEntry } = await load("../../src/display/catalog.ts");
const { MUTATION_FAMILY_TOOLS } = await load("../../src/display/adapter-utils.ts");

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

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-insert-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const sessionDir = join(workspace, ".test-session");

function renderResult(decorated, result, args, options, runtimeOptions) {
  return stripVTControlCharacters(decorated.renderResult(
    result,
    options,
    plainTheme,
    {
      args,
      toolCallId: "insert-render",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: workspace,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      showImages: false,
      isError: false,
      ...runtimeOptions,
    },
  ).render(120).join("\n"));
}

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "first\nmiddle\nlast\n", { encoding: "utf8", flag: "w" });
  await initializeAnchoredReadStore(workspace, sessionDir);

  // Catalog: insert is a parent-only filesystem mutation.
  const entry = getCatalogEntry("insert");
  assert.ok(entry, "the display catalog has an insert entry");
  assert.equal(entry.family, "filesystem");
  assert.equal(entry.parent, true);
  assert.equal(entry.child, false);
  assert.ok(MUTATION_FAMILY_TOOLS.has("insert"), "insert belongs to the mutation family");

  const initialRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const middle = readRows(initialRead).find((row) => row.text === "middle");
  assert.ok(middle, "anchored read serves the middle row");

  const insert = createAnchoredInsertToolDefinition(workspace, undefined, undefined, sessionDir);
  const changed = await insert.execute(
    "insert-1",
    { path: "source.txt", anchor: middle.hash, direction: "after", lines: ["inserted-a", "inserted-b"] },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(readFileSync(source, "utf8"), "first\nmiddle\ninserted-a\ninserted-b\nlast\n");
  assert.equal(changed.details.metrics.added_lines, 2);
  assert.equal(changed.details.metrics.removed_lines, 0);
  const changedRows = diffRows(changed.details.diff);
  assert.ok(changedRows.some((row) => row.marker === "+" && row.text === "inserted-a"), "the diff carries the inserted rows with fresh anchors");
  assert.ok(changedRows.some((row) => row.marker === "+" && row.text === "inserted-b"), "the diff carries every inserted line");
  assert.ok(changedRows.some((row) => row.marker === " " && row.hash === middle.hash && row.text === "middle"), "the untouched anchor row keeps its hash");
  assert.ok(!changedRows.some((row) => row.marker === "-"), "a pure insert has no removed rows");

  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const decorated = decorateInternalTool(createAnchoredInsertToolDefinition(workspace), () => runtime);
  const insertedArgs = { path: "source.txt", anchor: middle.hash, direction: "after", lines: ["inserted-a", "inserted-b"] };

  const callComponent = decorated.renderCall(
    insertedArgs,
    plainTheme,
    {
      args: insertedArgs,
      toolCallId: "insert-render",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: workspace,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
    },
  );
  const callText = stripVTControlCharacters(callComponent.render(120).join("\n"));
  assert.match(callText, /Insert/, "the running call carries the Insert title");
  assert.match(callText, /source\.txt/, "the call targets the normalized workspace-relative path");

  // Collapsed success: the authoritative diff is the only evidence body.
  const collapsedText = renderResult(decorated, changed, insertedArgs, { expanded: false, isPartial: false });
  assert.match(collapsedText, /2 lines inserted/, "the collapsed summary reports the inserted line count");
  assert.match(collapsedText, /\+2\/-0 lines/, "the collapsed summary reports the added/removed metrics");
  assert.match(collapsedText, /inserted-a/, "the collapsed mutation-family body renders the authoritative diff");
  assert.match(collapsedText, /middle/, "the collapsed diff keeps the unchanged anchor row as context");
  assert.doesNotMatch(collapsedText, /Warnings/, "a clean insert renders no warning block");

  const expandedText = renderResult(decorated, changed, insertedArgs, { expanded: true, isPartial: false });
  assert.match(expandedText, /inserted-b/, "the expanded body renders the full authoritative diff");
  assert.doesNotMatch(expandedText, /PROJECTED/, "insert diffs are authoritative");
  assert.equal(
    (expandedText.match(/inserted-a/g) ?? []).length,
    1,
    "the diff payload renders exactly once",
  );

  // A refusal renders as a completed warning with one concise summary.
  const stale = join(workspace, "stale.txt");
  writeFileSync(stale, "first\nmiddle\nlast\n", "utf8");
  const staleRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "stale.txt" },
    workspace,
    undefined,
    { sessionDir },
  );
  const staleMiddle = readRows(staleRead).find((row) => row.text === "middle");
  writeFileSync(stale, "first\nexternal\nlast\n", "utf8");
  const refusal = await insert.execute(
    "insert-stale",
    { path: "stale.txt", anchor: staleMiddle.hash, direction: "after", lines: ["x"] },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(refusal.details.status, "warning");
  assert.match(textOf(refusal.content), /\[E_STALE_ANCHOR\]/);
  assert.equal(readFileSync(stale, "utf8"), "first\nexternal\nlast\n", "a stale anchor does not write the file");

  const warningText = renderResult(
    decorated,
    refusal,
    { path: "stale.txt", anchor: staleMiddle.hash, direction: "after", lines: ["x"] },
    { expanded: true, isPartial: false },
  );
  assert.match(warningText, /Insert/, "anchor refusals render through the Insert entry");
  assert.equal(
    (warningText.match(/Nothing was modified · insert refused/g) ?? []).length,
    1,
    "the concise anchored-refusal summary renders once",
  );

  // A thrown environment failure renders with the failed lifecycle.
  const failureText = renderResult(
    decorated,
    {
      content: [{ type: "text", text: "Could not open file\nEACCES raw platform detail" }],
      isError: true,
      details: {},
    },
    { path: "missing.txt", anchor: "abc", direction: "after", lines: ["x"] },
    { expanded: true, isPartial: false },
    { isError: true },
  );
  assert.match(failureText, /EACCES raw platform detail/, "raw platform error text renders once");
  assert.equal((failureText.match(/EACCES raw platform detail/g) ?? []).length, 1);

  // Auto-read disabled: no diff body, truthful text result.
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
  const silentInsert = createAnchoredInsertToolDefinition(workspace, () => false, undefined, sessionDir);
  const silentResult = await silentInsert.execute(
    "insert-silent",
    { path: "silent.txt", anchor: silentRow.hash, direction: "after", lines: ["after"] },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(silentResult.details.diff, "", "disabled auto-read suppresses insert post-edit anchors");
  assert.match(textOf(silentResult.content), /inserted/, "the silent success text reports the insert");
  const silentText = renderResult(decorated, silentResult, { path: "silent.txt", anchor: silentRow.hash, direction: "after", lines: ["after"] }, { expanded: true, isPartial: false });
  assert.doesNotMatch(silentText, /after│/, "no anchored diff rows are rendered when auto-read is off");

  runtime.dispose();
  console.log("anchored insert display tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
