import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

const WIDTHS = [39, 40, 63, 64, 80, 99, 100, 120];

function makeCtx(args, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
}

function strip(lines) {
  return stripVTControlCharacters(lines.join("\n"));
}

// ─── 1. Read: no file content in collapsed body ─────────────────────

{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(
    { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = read.renderResult(
    { content: [{ type: "text", text }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "src/index.ts" }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /^✓ Read/, "read collapsed header shows Read title");
  assert.match(rendered, /60 lines/, "summary states line count");
  assert.doesNotMatch(rendered, /line 1\b/, "no file content in collapsed body");
  assert.doesNotMatch(rendered, /line 50/, "no file content in collapsed body");
  runtime.dispose();
}

// ─── 2. Read: windowed header shows path:start-end ──────────────────

{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(
    { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const text = "line20\nline21\nline22\nline23\nline24\n\n[153 more lines in file. Use offset=25 to continue.]";
  const result = read.renderResult(
    { content: [{ type: "text", text }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "src/parser.ts", offset: 20, limit: 5 }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /src\/parser\.ts:20-24/, "header shows windowed range");
  assert.match(rendered, /5 of 177 lines/, "summary shows returned of total");
  assert.match(rendered, /continue at offset 25/, "summary shows next offset");
  assert.match(rendered, /\[truncated\]/, "truncated badge present");
  runtime.dispose();
}

// ─── 3. Read: expanded shows real line numbers ──────────────────────

{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(
    { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const text = "alpha\nbeta\ngamma\n\n[10 more lines in file. Use offset=4 to continue.]";
  const result = read.renderResult(
    { content: [{ type: "text", text }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ path: "notes.txt", offset: 1, limit: 3 }),
  );
  const rendered = strip(result.render(80));
  // Line numbers start at 1 (the offset)
  assert.match(rendered, /\b1\s+alpha/, "line 1 shows alpha");
  assert.match(rendered, /\b3\s+gamma/, "line 3 shows gamma");
  // Continuation hint is NOT a numbered line
  assert.doesNotMatch(rendered, /\d\s+more lines in file/, "hint not a numbered line");
  assert.match(rendered, /continue at offset 4/, "summary has continuation");
  runtime.dispose();
}

// ─── 4. Read: error sentence ────────────────────────────────────────

{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(
    { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = read.renderResult(
    { content: [{ type: "text", text: "ENOENT: no such file or directory, access '/absent.ts'" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "absent.ts" }, { isError: true }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /^× Read/, "error shows failed marker");
  assert.match(rendered, /File does not exist/, "human error sentence");
  assert.doesNotMatch(rendered, /ENOENT/, "raw error not in collapsed body");
  runtime.dispose();
}

// ─── 5. List: directory/file counts, sorted, no prefix ──────────────

{
  const runtime = newRuntime();
  const ls = decorateBuiltinDefinition(
    { name: "ls", label: "List", description: "List", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = ls.renderResult(
    { content: [{ type: "text", text: ".gitignore\nempty/\npackage.json\nsrc/" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ path: "." }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /^✓ List/, "header shows List title");
  assert.match(rendered, /2 directories · 2 files/, "summary shows counts");
  assert.doesNotMatch(rendered, /d empty\//, "no d prefix");
  assert.doesNotMatch(rendered, /f \.gitignore/, "no f prefix");
  // Directories before files
  const srcIdx = rendered.indexOf("src/");
  const gitIdx = rendered.indexOf(".gitignore");
  assert.ok(srcIdx > 0 && gitIdx > srcIdx, "directories sorted before files");
  runtime.dispose();
}

// ─── 6. List: empty directory ───────────────────────────────────────

{
  const runtime = newRuntime();
  const ls = decorateBuiltinDefinition(
    { name: "ls", label: "List", description: "List", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = ls.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "empty_dir" }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /Empty directory/, "empty shows 'Empty directory'");
  assert.doesNotMatch(rendered, /ENTRIES/, "no ENTRIES section");
  runtime.dispose();
}

// ─── 7. Edit: no @@ header, no (+N,-M) row, summary row ─────────────

{
  const runtime = newRuntime();
  const edit = decorateBuiltinDefinition(
    { name: "edit", label: "Edit", description: "Edit", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = edit.renderResult(
    {
      content: [{ type: "text", text: "Applied" }],
      details: { patch: "--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n alpha\n-old\n+new\n gamma\n" },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "f.ts", edits: [{ oldText: "old", newText: "new" }] }),
  );
  const rendered = strip(result.render(80));
  assert.doesNotMatch(rendered, /@@/, "no @@ hunk header");
  assert.doesNotMatch(rendered, /\(\+1, -1\)/, "no (+N,-M) row");
  assert.match(rendered, /1 replacement · \+1 −1/, "summary row with counts");
  assert.match(rendered, /old/, "removed content visible");
  assert.match(rendered, /new/, "added content visible");
  runtime.dispose();
}

// ─── 8. Edit: failed edit names index and renders no diff ───────────

{
  const runtime = newRuntime();
  const edit = decorateBuiltinDefinition(
    { name: "edit", label: "Edit", description: "Edit", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = edit.renderResult(
    {
      content: [{ type: "text", text: "Could not find edits[1] in f.ts. The oldText must match exactly including all whitespace and newlines." }],
      isError: true,
      details: {},
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "old", newText: "new" }] }, { isError: true }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /Edit 2 of 2 found no exact match/, "failed edit names index and total");
  assert.doesNotMatch(rendered, /old/, "no diff content for failed edit");
  runtime.dispose();
}

// ─── 9. Write: Created/Overwrote verb ───────────────────────────────

{
  const runtime = newRuntime();
  const write = decorateBuiltinDefinition(
    { name: "write", label: "Write", description: "Write", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  // Overwrite (state carries writePreviewKind)
  const result = write.renderResult(
    { content: [{ type: "text", text: "Successfully wrote 30 bytes to README.md" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "README.md", content: "# Project\n\nWritten." }, { state: { writePreviewKind: "overwrite" } }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /Overwrote · 3 lines/, "overwrite summary starts with Overwrote");

  // Create
  const createResult = write.renderResult(
    { content: [{ type: "text", text: "Successfully wrote 11 bytes to new.ts" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "new.ts", content: "line1\nline2" }, { state: { writePreviewKind: "create" } }),
  );
  const createRendered = strip(createResult.render(80));
  assert.match(createRendered, /Created · 2 lines/, "create summary starts with Created");
  runtime.dispose();
}

// ─── 10. Write: first rows preview, not head/tail split ─────────────

{
  const runtime = newRuntime();
  const write = decorateBuiltinDefinition(
    { name: "write", label: "Write", description: "Write", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const result = write.renderResult(
    { content: [{ type: "text", text: "Written" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "big.ts", content }, { state: { writePreviewKind: "create" } }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /line 0/, "first row visible");
  assert.match(rendered, /line 8/, "preview shows first rows");
  assert.doesNotMatch(rendered, /line 39/, "last row not visible (no tail)");
  assert.doesNotMatch(rendered, /hidden/, "no head/tail hidden message");
  assert.match(rendered, /… \+\d+ lines/, "overflow uses … +N lines format");
  assert.match(rendered, /\[truncated\]/, "truncated badge present");
  runtime.dispose();
}

// ─── 11. Find: file count, no prefix, empty state ───────────────────

{
  const runtime = newRuntime();
  const find = decorateBuiltinDefinition(
    { name: "find", label: "Find", description: "Find", parameters: Type.Object({ pattern: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = find.renderResult(
    { content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nsrc/c.ts" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "*.ts", path: "." }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /^✓ Find/, "header shows Find title");
  assert.match(rendered, /3 files/, "summary states file count");
  assert.doesNotMatch(rendered, /f src\/a\.ts/, "no f prefix");
  assert.match(rendered, /src\/a\.ts/, "path visible");

  // Empty
  const emptyResult = find.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "*.rs", path: "." }),
  );
  const emptyRendered = strip(emptyResult.render(80));
  assert.match(emptyRendered, /No files found/, "empty shows 'No files found'");
  assert.doesNotMatch(emptyRendered, /RESULTS/, "no RESULTS section for empty");
  runtime.dispose();
}

// ─── 12. All states bounded at boundary widths ──────────────────────

{
  const runtime = newRuntime();
  const tools = {
    read: decorateBuiltinDefinition(
      { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
      process.cwd(), runtime,
    ),
    ls: decorateBuiltinDefinition(
      { name: "ls", label: "List", description: "List", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
      process.cwd(), runtime,
    ),
    edit: decorateBuiltinDefinition(
      { name: "edit", label: "Edit", description: "Edit", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
      process.cwd(), runtime,
    ),
    write: decorateBuiltinDefinition(
      { name: "write", label: "Write", description: "Write", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute() { return { content: [], details: {} }; } },
      process.cwd(), runtime,
    ),
    find: decorateBuiltinDefinition(
      { name: "find", label: "Find", description: "Find", parameters: Type.Object({ pattern: Type.String() }), async execute() { return { content: [], details: {} }; } },
      process.cwd(), runtime,
    ),
  };

  const cases = [
    { tool: tools.read, args: { path: "src/parser.ts" }, result: { content: [{ type: "text", text: "alpha\nbeta" }], details: {} } },
    { tool: tools.ls, args: { path: "." }, result: { content: [{ type: "text", text: "src/\nREADME.md" }], details: {} } },
    { tool: tools.edit, args: { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }, result: { content: [{ type: "text", text: "OK" }], details: { patch: "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n" } } },
    { tool: tools.write, args: { path: "new.ts", content: "hello\nworld" }, result: { content: [{ type: "text", text: "Written" }], details: {} } },
    { tool: tools.find, args: { pattern: "*.ts", path: "." }, result: { content: [{ type: "text", text: "src/a.ts" }], details: {} } },
  ];

  for (const { tool, args, result } of cases) {
    for (const expanded of [false, true]) {
      const component = tool.renderResult(result, { expanded, isPartial: false }, plainTheme, makeCtx(args, { expanded }));
      for (const width of WIDTHS) {
        const lines = component.render(width);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${args.path ?? args.pattern} ${expanded ? "expanded" : "collapsed"} exceeded ${width}`,
        );
      }
    }
  }
  runtime.dispose();
}

// ─── 13. Read: byte-limit truncation hint is stripped from content ────

{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(
    { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  // Byte-limit truncation format from Pi read.js
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n[Showing lines 1-50 of 500 (50.0KB limit). Use offset=51 to continue.]";
  const result = read.renderResult(
    { content: [{ type: "text", text }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "big.txt" }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /50 of 500 lines/, "byte-truncated summary shows correct counts");
  assert.match(rendered, /continue at offset 51/, "byte-truncated summary shows next offset");
  assert.match(rendered, /\[truncated\]/, "truncated badge present");
  assert.doesNotMatch(rendered, /Showing lines/, "byte-limit hint stripped from content");
  runtime.dispose();
}

// ─── 14. Read: result header shows actual returned range ────────────

{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(
    { name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  // Requested offset=170 limit=50 but only 9 lines remain in the file
  const text = Array.from({ length: 9 }, (_, i) => `line ${170 + i}`).join("\n");
  const result = read.renderResult(
    { content: [{ type: "text", text }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "src/parser.ts", offset: 170, limit: 50 }),
  );
  const rendered = strip(result.render(80));
  // Header should show 170-178 (actual), not 170-219 (requested)
  assert.match(rendered, /src\/parser\.ts:170-178/, "result header shows actual returned range");
  assert.doesNotMatch(rendered, /170-219/, "result header does not show fabricated end line");
  runtime.dispose();
}

// ─── 15. Edit: EACCES error says Permission denied ──────────────────

{
  const runtime = newRuntime();
  const edit = decorateBuiltinDefinition(
    { name: "edit", label: "Edit", description: "Edit", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = edit.renderResult(
    {
      content: [{ type: "text", text: "Could not edit file: /locked.ts. Error code: EACCES." }],
      isError: true,
      details: {},
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "locked.ts", edits: [{ oldText: "a", newText: "b" }] }, { isError: true }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /Permission denied/, "EACCES error says Permission denied");
  assert.doesNotMatch(rendered, /File does not exist/, "EACCES error does not say File does not exist");
  runtime.dispose();
}

// ─── 16. Edit: ENOENT error says File does not exist ────────────────

{
  const runtime = newRuntime();
  const edit = decorateBuiltinDefinition(
    { name: "edit", label: "Edit", description: "Edit", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [], details: {} }; } },
    process.cwd(), runtime,
  );
  const result = edit.renderResult(
    {
      content: [{ type: "text", text: "Could not edit file: /absent.ts. Error code: ENOENT." }],
      isError: true,
      details: {},
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "absent.ts", edits: [{ oldText: "a", newText: "b" }] }, { isError: true }),
  );
  const rendered = strip(result.render(80));
  assert.match(rendered, /File does not exist/, "ENOENT error says File does not exist");
  runtime.dispose();
}

console.log("filesystem rework tests: OK");
