import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");
const { renderDisplaySections } = await load("../../src/display/sections.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");

const root = join(import.meta.dirname, "..", "..");
const themeModulePath = pathToFileURL(join(
  root, "node_modules", "@earendil-works", "pi-coding-agent",
  "dist", "modes", "interactive", "theme", "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const themes = [
  ["plain", plainTheme],
  ["dark", loadThemeFromPath(join(root, "themes", "pi-square-theme-dark.json"))],
  ["light", loadThemeFromPath(join(root, "themes", "pi-square-theme-light.json"))],
];
const acceptanceWidths = [39, 40, 63, 64, 80, 99, 100, 120];

const TMP = mkdtempSync(join(tmpdir(), "pi-square-body-grammar-"));
mkdirSync(join(TMP, "src"), { recursive: true });
writeFileSync(join(TMP, "src", "a.ts"), "export {}\n");
writeFileSync(join(TMP, "src", "b.ts"), "export {}\n");
writeFileSync(join(TMP, "notes.txt"), `${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), {
    environment: { isTTY: false, test: true },
  });
}

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: TMP,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function stub(name) {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute() { return { content: [] }; },
  };
}

function renderLines(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

/** Body rows are the rendered lines after the one header row. */
function bodyLines(component, width = 80) {
  return renderLines(component, width).slice(1);
}

function countOccurrences(lines, needle) {
  return lines.reduce((count, line) => count + line.split(needle).length - 1, 0);
}

function assertNoTrailingEmptyRow(lines, label) {
  const last = lines.at(-1) ?? "";
  assert.ok(
    last.replace(/^[│└─\s]+/, "").length > 0,
    `${label}: body ends with an empty row: ${JSON.stringify(last)}`,
  );
}

// ---------------------------------------------------------------- C9 rules
{
  const twoSections = renderDisplaySections(
    [
      { title: "Alpha", blocks: [{ kind: "text", text: "one" }] },
      { title: "Beta", blocks: [{ kind: "text", text: "two" }] },
    ],
    DEFAULT_DISPLAY_POLICY,
    plainTheme,
    80,
    true,
  ).map((line) => stripVTControlCharacters(line));
  assert.ok(twoSections.some((line) => line.includes("Alpha")), "two sections draw the first title");
  assert.ok(twoSections.some((line) => line.includes("Beta")), "two sections draw the second title");

  const oneSection = renderDisplaySections(
    [{ title: "Alpha", blocks: [{ kind: "text", text: "one" }] }],
    DEFAULT_DISPLAY_POLICY,
    plainTheme,
    80,
    true,
  ).map((line) => stripVTControlCharacters(line));
  assert.ok(!oneSection.some((line) => line.includes("Alpha")), "a single section draws no title");
  assert.ok(oneSection.some((line) => line.includes("one")), "the single section content still renders");
}

// C9 through the production path: read expanded holds exactly one section.
{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(createReadToolDefinition(TMP), TMP, runtime);
  const text = Array.from({ length: 60 }, (_, i) => `${i + 1}\tline ${i + 1}`).join("\n");
  const result = {
    content: [{ type: "text", text }],
    details: { path: "notes.txt", returnedLines: 60, hasMore: false, truncatedLines: 0 },
  };
  const component = read.renderResult(result, { expanded: true, isPartial: false }, plainTheme, makeCtx({ path: "notes.txt" }));
  const body = bodyLines(component);
  assert.ok(!body.some((line) => line.includes("Content")), "one expanded section draws no CONTENT rule");
  assert.ok(body.some((line) => line.includes("line 1")), "the content itself still renders");
  runtime.dispose();
}

// ------------------------------------------------------- C4 collapsed body
// C4 revision: a collapsed entry is exactly one row. The outcome summary
// (or one-sentence failure) renders inline in that row; no body row follows
// for any tool outside the mutation family.
{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(createReadToolDefinition(TMP), TMP, runtime);
  const text = Array.from({ length: 60 }, (_, i) => `${i + 1}\tline ${i + 1}`).join("\n");
  const result = {
    content: [{ type: "text", text }],
    details: { path: "notes.txt", returnedLines: 60, hasMore: false, truncatedLines: 0 },
  };
  const component = read.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ path: "notes.txt" }));
  const rendered = renderLines(component);
  assert.equal(rendered.length, 1, "collapsed read renders exactly one row");
  assert.match(rendered[0], /60 lines/, "the inline summary states the line count");
  assert.match(rendered[0], /\d+(\.\d+)?\s?[KM]?B\b/, "the inline summary states the size");
  assertNoTrailingEmptyRow(rendered, "read collapsed");
  runtime.dispose();
}

{
  const runtime = newRuntime();
  const ls = decorateBuiltinDefinition(createLsToolDefinition(TMP), TMP, runtime);
  const result = {
    content: [{ type: "text", text: "src\nnotes.txt\nREADME.md" }],
    details: { entries: 3 },
  };
  const component = ls.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ path: "." }));
  const rendered = renderLines(component);
  assert.equal(rendered.length, 1, "collapsed ls renders exactly one row");
  assert.match(rendered[0], /3 files/, "the inline summary states the file count");
  runtime.dispose();

  const find = decorateBuiltinDefinition(createFindToolDefinition(TMP), TMP, runtime);
  const findResult = {
    content: [{ type: "text", text: `${join(TMP, "src", "a.ts")}\n${join(TMP, "src", "b.ts")}` }],
    details: { files: 2 },
  };
  const findComponent = find.renderResult(findResult, { expanded: false, isPartial: false }, plainTheme, makeCtx({ pattern: "*.ts", path: "src" }));
  const findRendered = renderLines(findComponent);
  assert.equal(findRendered.length, 1, "collapsed find renders exactly one row");
  assert.match(findRendered[0], /2 files in src/, "the inline summary states the count and the root");

  const emptyFind = find.renderResult(
    { content: [{ type: "text", text: "" }], details: { files: 0 } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "*.xyz", path: "src" }),
  );
  const emptyRendered = renderLines(emptyFind);
  assert.equal(emptyRendered.length, 1, "an empty find still renders one row");
  assert.match(emptyRendered[0], /No files found/, "the inline summary states no match");
}

{
  const runtime = newRuntime();
  const todo = decorateInternalTool(stub("todo"), () => runtime);
  const result = {
    content: [{ type: "text", text: "{\"version\":3}" }],
    details: {
      action: "set",
      version: 3,
      counts: { total: 4, pending: 2, inProgress: 1, completed: 1 },
      items: [
        { id: "a", text: "Write tests", status: "completed" },
        { id: "b", text: "Implement C4", status: "in_progress" },
      ],
    },
  };
  const component = todo.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ action: "set" }));
  const rendered = renderLines(component);
  assert.equal(rendered.length, 1, "collapsed todo renders exactly one row");
  assert.match(rendered[0], /1 of 4 done/, "the inline summary states the total and completed count");
  assert.ok(!rendered[0].includes("action=set"), "no key=value metadata noise in the row");
  runtime.dispose();
}

{
  const runtime = newRuntime();
  const rg = decorateInternalTool(stub("rg"), () => runtime);
  const result = {
    content: [{ type: "text", text: "src/f0.ts:1:3:needle();" }],
    details: {
      status: "ok",
      returned: 12,
      totalMatches: 60,
      page: { returned: 12, total: 60, hasMore: true, nextOffset: 12 },
      truncation: { lineExcerpts: 0, contextLinesOmitted: 0, contentBudgetReached: false },
    },
  };
  const component = rg.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ pattern: "needle" }));
  const rendered = renderLines(component);
  assert.equal(rendered.length, 1, "collapsed rg renders exactly one row");
  assert.match(rendered[0], /12 of 60 matches/, "the inline summary states returned and total");
  assert.match(rendered[0], /continue at offset 12/, "the inline summary states how to continue");
  assert.ok(!rendered[0].includes("pattern=needle"), "no key=value metadata row in the collapsed row");
  runtime.dispose();
}

{
  const runtime = newRuntime();
  const grep = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, runtime);
  const lines = Array.from({ length: 12 }, (_, i) => `${join(TMP, "src", `f${i}.ts`)}:${i + 1}:needle();`);
  const result = {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { matches: 12, files: 12 },
  };
  const component = grep.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ pattern: "needle" }));
  const rendered = renderLines(component);
  assert.equal(rendered.length, 1, "collapsed grep renders exactly one row");
  assert.match(rendered[0], /12 matches in 12 files/, "the inline summary states matches and files");
  runtime.dispose();
}

{
  const runtime = newRuntime();
  const bash = decorateBuiltinDefinition(createBashToolDefinition(TMP), TMP, runtime);
  const result = {
    content: [{ type: "text", text: "a.ts\nb.ts" }],
    details: { exitCode: 0, durationMs: 3, truncated: false },
  };
  const component = bash.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ command: "ls" }));
  const rendered = renderLines(component);
  assert.equal(rendered.length, 1, "collapsed bash renders exactly one row");
  assert.match(rendered[0], /2 lines/, "the inline summary states the output size");
  assert.doesNotMatch(rendered[0], /a\.ts/, "no live output tail in the collapsed row");

  const empty = bash.renderResult(
    { content: [{ type: "text", text: "" }], details: { exitCode: 0, durationMs: 1, truncated: false } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ command: "true" }),
  );
  const emptyRendered = renderLines(empty);
  assert.equal(emptyRendered.length, 1, "a command with no output renders exactly one row");
  assert.match(emptyRendered[0], /No output/, "the inline summary states no output");
  runtime.dispose();
}

// ------------------------------------------------------------- C6 failures
{
  const runtime = newRuntime();
  const read = decorateBuiltinDefinition(createReadToolDefinition(TMP), TMP, runtime);
  const raw = `ENOENT: no such file or directory, access '${join(TMP, "missing.txt")}'`;
  const result = {
    content: [{ type: "text", text: raw }],
    details: { error: "File does not exist" },
    isError: true,
  };
  const collapsed = read.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ path: "missing.txt" }, {}, { isError: true }));
  const collapsedLines = renderLines(collapsed);
  assert.equal(collapsedLines.length, 1, "a collapsed failure renders exactly one row");
  assert.match(collapsedLines[0], /File does not exist/, "the sentence states the failure inline");
  assert.ok(!collapsedLines[0].includes("ENOENT"), "the raw platform text stays out of the collapsed row");

  const expanded = read.renderResult(result, { expanded: true, isPartial: false }, plainTheme, makeCtx({ path: "missing.txt" }, {}, { isError: true }));
  const expandedLines = renderLines(expanded);
  assert.equal(countOccurrences(expandedLines, "ENOENT"), 1, "the raw text appears exactly once when expanded");
  assert.equal(countOccurrences(expandedLines, "File does not exist"), 1, "the sentence appears exactly once when expanded");
  runtime.dispose();
}

{
  const runtime = newRuntime();
  const pwsh = decorateInternalTool(stub("pwsh"), () => runtime);
  const result = {
    content: [{ type: "text", text: "Write-Error: boom" }],
    details: { exitCode: 1, durationMs: 42, error: "Write-Error: boom" },
    isError: true,
  };
  const expanded = pwsh.renderResult(result, { expanded: true, isPartial: false }, plainTheme, makeCtx({ command: "boom" }, {}, { isError: true }));
  const lines = renderLines(expanded);
  assert.equal(countOccurrences(lines, "Write-Error: boom"), 1, "the pwsh failure body renders the raw text exactly once");
  const collapsed = pwsh.renderResult(result, { expanded: false, isPartial: false }, plainTheme, makeCtx({ command: "boom" }, {}, { isError: true }));
  const collapsedLines = renderLines(collapsed);
  assert.equal(collapsedLines.length, 1, "the collapsed pwsh failure renders exactly one row");
  assert.ok(collapsedLines[0].includes("Exited with code 1"), "the collapsed pwsh failure states the exit code inline");
  runtime.dispose();
}

// ------------------------------------------------------- C8 restating body
{
  const runtime = newRuntime();
  const todo = decorateInternalTool(stub("todo"), () => runtime);
  const result = {
    content: [{ type: "text", text: "{\"version\":3}" }],
    details: {
      action: "set",
      version: 3,
      counts: { total: 2, pending: 1, inProgress: 1, completed: 0 },
      items: [{ id: "a", text: "Write tests", status: "pending" }],
    },
  };
  const component = todo.renderResult(result, { expanded: true, isPartial: false }, plainTheme, makeCtx({ action: "set" }));
  const body = bodyLines(component);
  assert.ok(!body.some((line) => line.includes("ACTION")), "no ACTION section that restates the header");
  assert.ok(!body.some((line) => line.includes("STATUS")), "no STATUS section that restates the header");
  runtime.dispose();

  const rgRuntime = newRuntime();
  const rg = decorateInternalTool(stub("rg"), () => rgRuntime);
  const rgResult = {
    content: [{ type: "text", text: "src/f0.ts:1:needle();" }],
    details: {
      status: "ok",
      returned: 1,
      totalMatches: 1,
      page: { returned: 1, total: 1, hasMore: false },
      truncation: { lineExcerpts: 0, contextLinesOmitted: 0, contentBudgetReached: false },
      matches: [{ path: "src/f0.ts", line: 1, text: "needle();", kind: "match" }],
    },
  };
  const rgComponent = rg.renderResult(rgResult, { expanded: true, isPartial: false }, plainTheme, makeCtx({ pattern: "needle" }));
  const rgBody = bodyLines(rgComponent);
  assert.ok(!rgBody.some((line) => line.includes("QUERY")), "no QUERY section that restates the header");
  assert.ok(!rgBody.some((line) => line.includes("SUMMARY")), "no SUMMARY section that restates the header");
  rgRuntime.dispose();
}

// --------------------------------------- truncation notice is never numbered
{
  const longCode = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  const lines = renderDisplaySections(
    [{ title: "Content", blocks: [{ kind: "code", text: longCode, language: "text" }] }],
    DEFAULT_DISPLAY_POLICY,
    plainTheme,
    80,
    true,
  ).map((line) => stripVTControlCharacters(line));
  const notice = lines.find((line) => line.includes("lines omitted"));
  assert.ok(notice, "a bounded code section states the omitted lines");
  assert.ok(!/^\s*\d+\s{2}/.test(notice), "the truncation notice carries no line number");
}

// ------------------------------------------------- bounded at every width
for (const [label, theme] of themes) {
  for (const width of acceptanceWidths) {
    const runtime = newRuntime();
    const read = decorateBuiltinDefinition(createReadToolDefinition(TMP), TMP, runtime);
    const text = Array.from({ length: 60 }, (_, i) => `${i + 1}\tline ${i + 1}`).join("\n");
    const result = {
      content: [{ type: "text", text }],
      details: { path: "notes.txt", returnedLines: 60, hasMore: false, truncatedLines: 0 },
    };
    for (const expanded of [false, true]) {
      const component = read.renderResult(result, { expanded, isPartial: false }, theme, makeCtx({ path: "notes.txt" }));
      const rendered = component.render(width);
      for (const line of rendered) {
        assert.ok(visibleWidth(line) <= width, `${label} read expanded=${expanded} row exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
    // A collapsed failure also stays bounded and keeps its single row.
    const failure = read.renderResult(
      {
        content: [{ type: "text", text: `ENOENT: no such file or directory, access '${join(TMP, "missing.txt")}'` }],
        details: { error: "File does not exist" },
        isError: true,
      },
      { expanded: false, isPartial: false },
      theme,
      makeCtx({ path: "missing.txt" }, {}, { isError: true }),
    );
    const failureLines = failure.render(width);
    assert.equal(failureLines.length, 1, `${label} collapsed failure keeps exactly one row at ${width}`);
    for (const line of failureLines) {
      assert.ok(visibleWidth(line) <= width, `${label} failure row exceeds ${width}`);
    }
    runtime.dispose();
  }
}

// -------------------------------------------------- model output unchanged
{
  const runtime = newRuntime();
  const rg = decorateInternalTool(stub("rg"), () => runtime);
  const result = {
    content: [{ type: "text", text: "src/f0.ts:1:needle();" }],
    details: {
      status: "ok",
      page: { returned: 1, total: 1, hasMore: false },
      truncation: { lineExcerpts: 0, contextLinesOmitted: 0, contentBudgetReached: false },
    },
  };
  const frozen = structuredClone(result);
  Object.freeze(result);
  Object.freeze(result.content);
  Object.freeze(result.details);
  rg.renderResult(result, { expanded: true, isPartial: false }, plainTheme, makeCtx({ pattern: "needle" }));
  assert.deepEqual(result, frozen, "rendering never mutates the model-facing result");
  runtime.dispose();
}

console.log("display body grammar tests: OK");
