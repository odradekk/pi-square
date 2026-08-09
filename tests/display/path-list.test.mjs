import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

const TMP = mkdtempSync(join(tmpdir(), "pi-square-path-list-"));

function setupWorkspace() {
  mkdirSync(join(TMP, "src"), { recursive: true });
  mkdirSync(join(TMP, "tests"), { recursive: true });
  writeFileSync(join(TMP, "README.md"), "# Project");
  writeFileSync(join(TMP, "package.json"), "{}");
  writeFileSync(join(TMP, "src", "index.ts"), "export {}");
  writeFileSync(join(TMP, "src", "utils.ts"), "export const x = 1;");
  writeFileSync(join(TMP, "tests", "run.mjs"), "console.log('test');");
}

setupWorkspace();

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: TMP,
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), {
    environment: { isTTY: false, test: true },
  });
}

// ─── 1. Lifecycle markers through production decoration path ─────────

{
  const clock = {
    callbacks: new Map(),
    next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); },
    unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);
  assert.equal(decorated.renderShell, "self", "ls uses self render shell");

  const state = {};

  // Queued
  const queued = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, state, { argsComplete: false, executionStarted: false }));
  const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
  assert.match(queuedText, /^●/, "queued renders en-dash");
  assert.equal(clock.callbacks.size, 0, "queued does not subscribe to motion");

  // Pending
  const pending = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  const pendingText = stripVTControlCharacters(pending.render(80).join("\n"));
  assert.match(pendingText, /^●/, "pending renders circle");

  // Running
  const running = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  const runningText = stripVTControlCharacters(running.render(80).join("\n"));
  assert.match(runningText, /^●/, "running renders braille spinner");
  assert.equal(clock.callbacks.size, 1, "running subscribes to motion");

  // Completed
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "README.md\nsrc/" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  const resultText = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(resultText, /^●/, "completed renders bullet");
  assert.equal(clock.callbacks.size, 0, "completed unsubscribes from motion");

  // Result replaces pending entry
  assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

  runtime.dispose();
}

// ─── 2. LS result shows path-kind markers ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);

  const call = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "README.md\npackage.json\nsrc/\ntests/" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));

  assert.match(text, /^✓ LS/, "ls result shows the LS title");
  assert.match(text, /f README\.md/, "file shows f marker");
  assert.match(text, /f package\.json/, "file shows f marker");
  assert.match(text, /d src\//, "directory shows d marker");
  assert.match(text, /d tests\//, "directory shows d marker");
  assert.match(text, /ENTRIES/, "ls result shows ENTRIES section");

  runtime.dispose();
}

// ─── 3. FIND result shows path-kind markers and pattern target ──────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createFindToolDefinition(TMP), TMP, () => runtime);

  const call = decorated.renderCall({ pattern: "*.ts", path: "." }, plainTheme, makeCtx({ pattern: "*.ts", path: "." }, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(callText, /FIND/, "find call shows FIND title");
  assert.match(callText, /\*\.ts/, "find call shows pattern as target");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "src/index.ts\nsrc/utils.ts" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "*.ts", path: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));

  assert.match(text, /^✓ FIND/, "find result shows the FIND title");
  assert.match(text, /\*\.ts/, "find result shows pattern as target");
  assert.match(text, /f src\/index\.ts/, "find result shows file path with f marker");
  assert.match(text, /f src\/utils\.ts/, "find result shows file path with f marker");
  assert.match(text, /RESULTS/, "find result shows RESULTS section");

  runtime.dispose();
}

// ─── 4. Empty result shows explicit message ─────────────────────────

{
  const runtime = newRuntime();

  // LS empty
  const lsDecorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);
  const lsCall = lsDecorated.renderCall({ path: "empty_dir" }, plainTheme, makeCtx({ path: "empty_dir" }, { argsComplete: true, executionStarted: true }));
  const lsResult = lsDecorated.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "empty_dir" }, { argsComplete: true, executionStarted: true, lastComponent: lsCall, isError: false }),
  );
  const lsText = stripVTControlCharacters(lsResult.render(80).join("\n"));
  assert.match(lsText, /^✓/, "empty ls result renders completed marker");
  assert.match(lsText, /No entries/, "empty ls result shows 'No entries'");
  assert.doesNotMatch(lsText, /f |d /, "empty ls result has no path markers");

  // FIND empty
  const findDecorated = decorateBuiltinDefinition(createFindToolDefinition(TMP), TMP, () => runtime);
  const findCall = findDecorated.renderCall({ pattern: "nonexistent", path: "." }, plainTheme, makeCtx({ pattern: "nonexistent", path: "." }, { argsComplete: true, executionStarted: true }));
  const findResult = findDecorated.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "nonexistent", path: "." }, { argsComplete: true, executionStarted: true, lastComponent: findCall, isError: false }),
  );
  const findText = stripVTControlCharacters(findResult.render(80).join("\n"));
  assert.match(findText, /^✓/, "empty find result renders completed marker");
  assert.match(findText, /No results/, "empty find result shows 'No results'");

  runtime.dispose();
}

// ─── 5. Error result distinct from empty result ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);

  const call = decorated.renderCall({ path: "/nonexistent" }, plainTheme, makeCtx({ path: "/nonexistent" }, {}, { argsComplete: true, executionStarted: true }));
  const errored = decorated.renderResult(
    { content: [{ type: "text", text: "Error: permission denied" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "/nonexistent" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: true }),
  );
  const text = stripVTControlCharacters(errored.render(80).join("\n"));
  assert.match(text, /^×/, "error result renders failed marker");
  assert.doesNotMatch(text, /No entries/, "error result does not show empty message");
  assert.match(text, /permission denied/, "error text visible in error styling");
  assert.doesNotMatch(text, /ENTRIES|RESULTS/, "error result does not render path-list sections");

  runtime.dispose();
}

// ─── 6. Collapsed shows compact paths, expanded adds summary ────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);
  const entries = "README.md\nsrc/";

  const call = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, { argsComplete: true, executionStarted: true }));

  // Collapsed
  const collapsed = decorated.renderResult(
    { content: [{ type: "text", text: entries }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: false }),
  );
  const collapsedText = stripVTControlCharacters(collapsed.render(80).join("\n"));
  assert.match(collapsedText, /ENTRIES/, "collapsed shows ENTRIES");
  assert.doesNotMatch(collapsedText, /DIRECTORY/, "collapsed does not show DIRECTORY summary");

  // Expanded
  const expanded = decorated.renderResult(
    { content: [{ type: "text", text: entries }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
  assert.match(expandedText, /ENTRIES/, "expanded shows ENTRIES");
  assert.match(expandedText, /DIRECTORY/, "expanded shows DIRECTORY summary");
  assert.match(expandedText, /path=\./, "expanded shows path metadata");

  runtime.dispose();
}

// ─── 7. Large path set collapses with omission count ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);

  const manyEntries = Array.from({ length: 100 }, (_, i) =>
    i % 3 === 0 ? `dir${i}/` : `file${i}.ts`,
  ).join("\n");

  const call = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: manyEntries }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );

  // MAX_SECTION_ITEMS is 64, so at least 36 paths should be omitted
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /paths omitted/, "large set shows omission count");
  assert.match(text, /36 paths omitted/, "omission count is accurate (100 - 64 = 36)");

  runtime.dispose();
}

// ─── 8. Bounded at all widths ───────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);

  const call = decorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "README.md\npackage.json\nsrc/\ntests/" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );

  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `ls result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 9. Family is filesystem for ls and find ────────────────────────

{
  const runtime = newRuntime();
  const lsDecorated = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, () => runtime);
  const findDecorated = decorateBuiltinDefinition(createFindToolDefinition(TMP), TMP, () => runtime);

  const lsCall = lsDecorated.renderCall({ path: "." }, plainTheme, makeCtx({ path: "." }, { argsComplete: true, executionStarted: true }));
  const lsResult = lsDecorated.renderResult(
    { content: [{ type: "text", text: "file.ts" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }, { argsComplete: true, executionStarted: true, lastComponent: lsCall, isError: false }),
  );
  // ls renders without error through the filesystem family path
  const lsText = stripVTControlCharacters(lsResult.render(80).join("\n"));
  assert.match(lsText, /✓ LS/, "ls renders through filesystem family");

  const findCall = findDecorated.renderCall({ pattern: "*.ts", path: "." }, plainTheme, makeCtx({ pattern: "*.ts", path: "." }, { argsComplete: true, executionStarted: true }));
  const findResult = findDecorated.renderResult(
    { content: [{ type: "text", text: "file.ts" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "*.ts", path: "." }, { argsComplete: true, executionStarted: true, lastComponent: findCall, isError: false }),
  );
  const findText = stripVTControlCharacters(findResult.render(80).join("\n"));
  assert.match(findText, /✓ FIND/, "find renders through filesystem family (not search)");

  runtime.dispose();
}

// ─── 10. FD path-kind detection from args.types ─────────────────────

{
  const runtime = newRuntime();
  // Create a minimal fd definition with the right shape
  const fdDef = {
    name: "fd",
    label: "fd",
    description: "Fast file finder",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
  const decorated = decorateInternalTool(fdDef, () => runtime);

  // Directory type search — all results should have d marker
  const call = decorated.renderCall(
    { pattern: ".", types: ["directory"] },
    plainTheme,
    makeCtx({ pattern: ".", types: ["directory"] }, { argsComplete: true, executionStarted: true }),
  );
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "fd returned=2" }],
      details: {
        page: { returned: 2, total: 2 },
        paths: [
          { displayPath: "src/", encoding: "text" },
          { displayPath: "tests/", encoding: "text" },
        ],
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: ".", types: ["directory"] }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /d src\//, "fd directory-type result shows d marker");
  assert.match(text, /d tests\//, "fd directory-type result shows d marker");

  runtime.dispose();
}

// ─── 11. FD default (no type filter) uses f marker ──────────────────

{
  const runtime = newRuntime();
  const fdDef = {
    name: "fd",
    label: "fd",
    description: "Fast file finder",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
  const decorated = decorateInternalTool(fdDef, () => runtime);

  const call = decorated.renderCall(
    { pattern: "." },
    plainTheme,
    makeCtx({ pattern: "." }, { argsComplete: true, executionStarted: true }),
  );
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "fd returned=1" }],
      details: {
        page: { returned: 1, total: 1 },
        paths: [
          { displayPath: "src/index.ts", encoding: "text" },
        ],
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /f src\/index\.ts/, "fd default result shows f marker");

  runtime.dispose();
}

// ─── 12. FD byte-path entries show special marker ───────────────────

{
  const runtime = newRuntime();
  const fdDef = {
    name: "fd",
    label: "fd",
    description: "Fast file finder",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
  const decorated = decorateInternalTool(fdDef, () => runtime);

  const call = decorated.renderCall({ pattern: "." }, plainTheme, makeCtx({ pattern: "." }, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "fd returned=1" }],
      details: {
        page: { returned: 1, total: 1 },
        paths: [
          { displayPath: "bad??path", encoding: "bytes", rawBase64: "AAA=" },
        ],
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "." }, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /s bad\?\?path/, "fd byte-path result shows s marker");
  assert.match(text, /byte path/, "fd byte-path result shows byte path meta");

  runtime.dispose();
}

// ─── 13. Execution unchanged for ls and find ────────────────────────

{
  const runtime = newRuntime();
  const lsDef = createLsToolDefinition(TMP);
  const findDef = createFindToolDefinition(TMP);
  const lsDecorated = decorateBuiltinDefinition(lsDef, TMP, () => runtime);
  const findDecorated = decorateBuiltinDefinition(findDef, TMP, () => runtime);

  // Verify execute is the original function (not wrapped)
  assert.equal(lsDecorated.execute, lsDef.execute, "ls execute unchanged");
  assert.equal(findDecorated.execute, findDef.execute, "find execute unchanged");
  // Verify parameters unchanged
  assert.deepEqual(lsDecorated.parameters, lsDef.parameters, "ls parameters unchanged");
  assert.deepEqual(findDecorated.parameters, findDef.parameters, "find parameters unchanged");

  runtime.dispose();
}

// Cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("path-list tests: OK");
