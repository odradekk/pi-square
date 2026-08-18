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
const {
  createAnchoredRevertToolDefinition,
  registerAnchoredRevert,
} = await load("../../src/anchored-edit/workspace-revert.ts");
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

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-revert-"));
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
  const originalBytes = Buffer.from("\uFEFFfirst\r\nmiddle\r\nlast\r\n", "utf8");
  writeFileSync(source, originalBytes);
  await initializeAnchoredReadStore(workspace);

  const read = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
  );
  const middle = readRows(read).find((row) => row.text === "middle");
  assert.ok(middle, "anchored read serves the line to replace");

  const replace = createAnchoredReplaceToolDefinition(workspace);
  const replaced = await replace.execute(
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
  const replacedRow = diffRows(replaced.details.diff).find(
    (row) => row.marker === "+" && row.text === "replaced",
  );
  assert.ok(replacedRow, "replace returns the changed row anchor");

  const revert = createAnchoredRevertToolDefinition(workspace);
  const result = await revert.execute(
    "revert-1",
    { path: "source.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );

  assert.equal(result.isError, undefined, "revert completes successfully");
  assert.deepEqual(readFileSync(source), originalBytes, "revert restores the original bytes including BOM and CRLF endings");
  const rows = diffRows(result.details.diff);
  assert.ok(
    rows.some((row) => row.marker === "-" && row.hash === replacedRow.hash && row.text === "replaced"),
    "revert diff includes the removed replacement anchor",
  );
  assert.ok(
    rows.some((row) => row.marker === "+" && row.hash === middle.hash && row.text === "middle"),
    "revert diff restores the original valid anchor",
  );

  const silentRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "source.txt" },
    workspace,
  );
  const silentMiddle = readRows(silentRead).find((row) => row.text === "middle");
  assert.ok(silentMiddle);
  await createAnchoredReplaceToolDefinition(workspace).execute(
    "replace-silent-revert",
    { path: "source.txt", remove_from: silentMiddle.hash, remove_to: silentMiddle.hash, replacement_text: "again" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  const silentRevert = await createAnchoredRevertToolDefinition(workspace, () => false).execute(
    "revert-silent",
    { path: "source.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(silentRevert.details.diff, "", "disabled auto-read suppresses revert post-edit anchors");
  assert.doesNotMatch(textOf(silentRevert.content), /diff anchors/, "disabled auto-read does not promise a returned diff");

  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const decoratedRevert = decorateInternalTool(createAnchoredRevertToolDefinition(workspace), () => runtime);
  const rendered = stripVTControlCharacters(decoratedRevert.renderResult(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    {
      args: { path: "source.txt" },
      toolCallId: "revert-1",
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
  assert.match(rendered, /^✓ Revert/, "revert uses the shared operational display fallback marker");
  assert.match(rendered, /replaced/, "revert renders the authoritative removed row");
  assert.match(rendered, /middle/, "revert renders the authoritative restored row");
  runtime.dispose();

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
  registerAnchoredRevert(
    pi,
    () => ({ anchoredEditing: { enabled: true } }),
    undefined,
    () => true,
  );
  for (const handler of events.get("session_start") ?? []) {
    await handler({ type: "session_start" }, { cwd: workspace });
  }
  const registeredRevert = tools.get("revert");
  assert.ok(registeredRevert, "enabled parent sessions register revert");

  const cleared = join(workspace, "cleared.txt");
  writeFileSync(cleared, "one\ntwo\nthree\n", "utf8");
  const clearedRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "cleared.txt" },
    workspace,
  );
  const clearedRow = readRows(clearedRead).find((row) => row.text === "two");
  assert.ok(clearedRow);
  await replace.execute(
    "replace-cleared",
    { path: "cleared.txt", remove_from: clearedRow.hash, remove_to: clearedRow.hash, replacement_text: "TWO" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  writeFileSync(cleared, "explicit rewrite\n", "utf8");
  for (const handler of events.get("tool_result") ?? []) {
    await handler(
      { toolName: "write", isError: false, input: { path: "cleared.txt" } },
      { cwd: workspace },
    );
  }
  const noHistory = await registeredRevert.execute(
    "revert-cleared",
    { path: "cleared.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(noHistory.details.status, "warning", "a successful explicit write clears revert history");

  const retained = join(workspace, "retained.txt");
  writeFileSync(retained, "one\ntwo\nthree\n", "utf8");
  const retainedRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "retained.txt" },
    workspace,
  );
  const retainedRow = readRows(retainedRead).find((row) => row.text === "two");
  assert.ok(retainedRow);
  await replace.execute(
    "replace-retained",
    { path: "retained.txt", remove_from: retainedRow.hash, remove_to: retainedRow.hash, replacement_text: "TWO" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  for (const handler of events.get("tool_result") ?? []) {
    await handler(
      { toolName: "write", isError: true, input: { path: "retained.txt" } },
      { cwd: workspace },
    );
  }
  const retainedRevert = await registeredRevert.execute(
    "revert-retained",
    { path: "retained.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(retainedRevert.isError, undefined, "a failed explicit write retains revert history");
  assert.equal(readFileSync(retained, "utf8"), "one\ntwo\nthree\n");

  const stale = join(workspace, "stale.txt");
  writeFileSync(stale, "one\ntwo\nthree\n", "utf8");
  const staleRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "stale.txt" },
    workspace,
  );
  const staleRow = readRows(staleRead).find((row) => row.text === "two");
  assert.ok(staleRow);
  await replace.execute(
    "replace-stale",
    { path: "stale.txt", remove_from: staleRow.hash, remove_to: staleRow.hash, replacement_text: "TWO" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  writeFileSync(stale, "one\nexternal\nthree\n", "utf8");
  const staleResult = await revert.execute(
    "revert-stale",
    { path: "stale.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(staleResult.isError, undefined, "stale reverts are completed warnings");
  assert.equal(staleResult.details.status, "warning");
  assert.equal(staleResult.details.errorCode, "E_UNDO_STALE");
  assert.equal(readFileSync(stale, "utf8"), "one\nexternal\nthree\n", "stale revert leaves newer content untouched");

  const staleRuntime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const staleDecorated = decorateInternalTool(createAnchoredRevertToolDefinition(workspace), () => staleRuntime);
  const staleRendered = stripVTControlCharacters(staleDecorated.renderResult(
    staleResult,
    { expanded: true, isPartial: false },
    plainTheme,
    {
      args: { path: "stale.txt" },
      toolCallId: "revert-stale",
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
  assert.match(staleRendered, /^! Revert/, "stale revert renders as a completed warning");
  const failureRendered = stripVTControlCharacters(staleDecorated.renderResult(
    {
      content: [{ type: "text", text: "Could not restore file\nEACCES raw platform detail" }],
      isError: true,
      details: {},
    },
    { expanded: true, isPartial: false },
    plainTheme,
    {
      args: { path: "stale.txt" },
      toolCallId: "revert-error",
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
  assert.match(failureRendered, /^× Revert/, "environment failures render with a failed lifecycle");
  assert.equal((failureRendered.match(/EACCES raw platform detail/g) ?? []).length, 1, "raw platform text renders once");
  staleRuntime.dispose();

  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside\n", "utf8");
  await assert.rejects(
    () => revert.execute(
      "revert-outside",
      { path: "../outside.txt" },
      undefined,
      undefined,
      { cwd: workspace },
    ),
    /E_OUTSIDE_WORKSPACE.*Disable anchoredEditing\.enabled/s,
    "outside paths are refused with the named built-in alternative",
  );

  const deleted = join(workspace, "deleted.txt");
  writeFileSync(deleted, "one\ntwo\nthree\n", "utf8");
  const deletedRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "deleted.txt" },
    workspace,
  );
  const deletedRow = readRows(deletedRead).find((row) => row.text === "two");
  assert.ok(deletedRow);
  await replace.execute(
    "replace-deleted",
    { path: "deleted.txt", remove_from: deletedRow.hash, remove_to: deletedRow.hash, replacement_text: "TWO" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  rmSync(deleted);
  const deletedResult = await revert.execute(
    "revert-deleted",
    { path: "deleted.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(deletedResult.details.status, "warning", "deleted targets refuse revert as warnings");
  assert.equal(deletedResult.details.errorCode, "E_UNDO_STALE");

  const history = join(workspace, "history.txt");
  writeFileSync(history, "one\ntwo\nthree\n", "utf8");
  const historyRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "history.txt" },
    workspace,
  );
  const historyRow = readRows(historyRead).find((row) => row.text === "two");
  assert.ok(historyRow);
  const firstReplace = await replace.execute(
    "replace-history-1",
    { path: "history.txt", remove_from: historyRow.hash, remove_to: historyRow.hash, replacement_text: "TWO" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  const firstReplacementRow = diffRows(firstReplace.details.diff).find(
    (row) => row.marker === "+" && row.text === "TWO",
  );
  assert.ok(firstReplacementRow);
  await replace.execute(
    "replace-history-2",
    { path: "history.txt", remove_from: firstReplacementRow.hash, remove_to: firstReplacementRow.hash, replacement_text: "second" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  const historyRevert = await revert.execute(
    "revert-history",
    { path: "history.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(historyRevert.isError, undefined);
  assert.equal(readFileSync(history, "utf8"), "one\nTWO\nthree\n", "only the most recent replace is revertible");
  const noSecondHistory = await revert.execute(
    "revert-history-again",
    { path: "history.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(noSecondHistory.details.status, "warning", "a successful revert consumes single-level history");

  const restarted = join(workspace, "restarted.txt");
  writeFileSync(restarted, "one\ntwo\nthree\n", "utf8");
  const restartedRead = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "restarted.txt" },
    workspace,
  );
  const restartedRow = readRows(restartedRead).find((row) => row.text === "two");
  assert.ok(restartedRow);
  await replace.execute(
    "replace-restarted",
    { path: "restarted.txt", remove_from: restartedRow.hash, remove_to: restartedRow.hash, replacement_text: "TWO" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  shutdownHashStore();
  const restartRevert = await createAnchoredRevertToolDefinition(workspace).execute(
    "revert-restarted",
    { path: "restarted.txt" },
    undefined,
    undefined,
    { cwd: workspace },
  );
  assert.equal(restartRevert.isError, undefined, "revert history survives a store restart");
  assert.equal(readFileSync(restarted, "utf8"), "one\ntwo\nthree\n");

  console.log("anchored revert integration tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
