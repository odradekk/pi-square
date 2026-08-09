import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
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

const TMP = mkdtempSync(join(tmpdir(), "pi-square-text-search-"));
writeFileSync(join(TMP, "a.ts"), "const x = 1;\nconst y = 2;");

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

function makeFdRgDef(name) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

// ═══════════════════════ GREP (builtin) ═══════════════════════

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
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  assert.equal(decorated.renderShell, "self", "grep uses self render shell");

  const state = {};
  const queued = decorated.renderCall({ pattern: "const" }, plainTheme, makeCtx({ pattern: "const" }, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");
  assert.equal(clock.callbacks.size, 0, "queued does not subscribe to motion");

  const pending = decorated.renderCall({ pattern: "const" }, plainTheme, makeCtx({ pattern: "const" }, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall({ pattern: "const" }, plainTheme, makeCtx({ pattern: "const" }, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");
  assert.equal(clock.callbacks.size, 1, "running subscribes to motion");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const" }, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders bullet");
  assert.equal(clock.callbacks.size, 0, "completed unsubscribes from motion");
  assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

  runtime.dispose();
}

// ─── 2. Call target shows pattern, not path ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "TODO", path: "." }, plainTheme, makeCtx({ pattern: "TODO", path: "." }, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(text, /GREP TODO/, "call target shows the pattern");

  runtime.dispose();
}

// ─── 3. Result shows structured matches (path:line + excerpt) ───────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "const" }, plainTheme, makeCtx({ pattern: "const" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;\na.ts:2:const y = 2;" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /MATCHES/, "result shows MATCHES section");
  assert.match(text, /a\.ts:1/, "result shows path:line for first match");
  assert.match(text, /a\.ts:2/, "result shows path:line for second match");
  assert.match(text, /const x = 1;/, "result shows excerpt for first match");
  assert.match(text, /const y = 2;/, "result shows excerpt for second match");

  runtime.dispose();
}

// ─── 3b. Case, regex/literal, glob, and context metadata surfaced ────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const args = { pattern: "TODO", glob: "*.ts", ignoreCase: true, literal: true, context: 2 };

  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(callText, /glob=\*\.ts/, "call badges show glob");
  assert.match(callText, /case=insensitive/, "call badges show case sensitivity");
  assert.match(callText, /literal=true/, "call badges show literal/regex mode");
  assert.match(callText, /context=2/, "call badges show context lines");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const resultText = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(resultText, /glob=\*\.ts/, "expanded Query shows glob");
  assert.match(resultText, /case=insensitive/, "expanded Query shows case sensitivity");
  assert.match(resultText, /literal=true/, "expanded Query shows literal/regex mode");
  assert.match(resultText, /context=2/, "expanded Query shows context lines");

  runtime.dispose();
}

// ─── 4. Expanded adds Query summary; collapsed omits it ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "const", path: "." }, plainTheme, makeCtx({ pattern: "const", path: "." }, {}, { argsComplete: true, executionStarted: true }));

  const collapsed = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const", path: "." }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: false }),
  );
  const collapsedText = stripVTControlCharacters(collapsed.render(80).join("\n"));
  assert.match(collapsedText, /MATCHES/, "collapsed shows MATCHES");
  assert.doesNotMatch(collapsedText, /QUERY/, "collapsed omits QUERY summary");

  const expanded = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const", path: "." }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
  assert.match(expandedText, /QUERY/, "expanded shows QUERY summary");
  assert.match(expandedText, /pattern=const/, "expanded QUERY shows pattern field");
  assert.match(expandedText, /MATCHES/, "expanded also shows MATCHES");

  runtime.dispose();
}

// ─── 5. Empty result shows explicit "No matches" ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "nomatch" }, plainTheme, makeCtx({ pattern: "nomatch" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "nomatch" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "empty result renders completed marker");
  assert.match(text, /No matches/, "empty result shows explicit message");

  runtime.dispose();
}

// ─── 6. Error result is distinct from empty and from matches ────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "[invalid" }, plainTheme, makeCtx({ pattern: "[invalid" }, {}, { argsComplete: true, executionStarted: true }));
  const errored = decorated.renderResult(
    { content: [{ type: "text", text: "grep: invalid regex" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "[invalid" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: true }),
  );
  const text = stripVTControlCharacters(errored.render(80).join("\n"));
  assert.match(text, /^×/, "error renders failed marker");
  assert.match(text, /invalid regex/, "error text visible");
  assert.doesNotMatch(text, /MATCHES|No matches/, "error result does not render match sections");

  runtime.dispose();
}

// ─── 7. Terminal control characters in matches are sanitized ────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "danger" }, plainTheme, makeCtx({ pattern: "danger" }, {}, { argsComplete: true, executionStarted: true }));
  const malicious = "a.ts:1:danger\x1b[31minjected\x07bell";
  const result = decorated.renderResult(
    { content: [{ type: "text", text: malicious }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "danger" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const rendered = result.render(80).join("\n");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(rendered, /\x1b\[31m|\x07/, "raw ANSI/control sequences are not present in rendered output");

  runtime.dispose();
}

// ─── 8. Bounded at all widths ────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "const" }, plainTheme, makeCtx({ pattern: "const" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;\na.ts:2:const y = 2;" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `grep result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 9. Execution unchanged ──────────────────────────────────────────

{
  const runtime = newRuntime();
  const grepDef = createGrepToolDefinition(TMP);
  const decorated = decorateBuiltinDefinition(grepDef, TMP, () => runtime);
  assert.equal(decorated.execute, grepDef.execute, "grep execute unchanged");
  assert.deepEqual(decorated.parameters, grepDef.parameters, "grep parameters unchanged");

  runtime.dispose();
}

// ═══════════════════════ RG (extension tool) ═══════════════════════

// ─── 10. Lifecycle markers through production decoration path ────────

{
  const clock = {
    callbacks: new Map(),
    next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); },
    unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  assert.equal(decorated.renderShell, "self", "rg uses self render shell");

  const state = {};
  const queued = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "rg queued renders en-dash");

  const pending = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "rg pending renders circle");

  const running = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "rg running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "rg returned=1" }], details: { page: { offset: 0, returned: 1, total: 1 }, files: [{ path: "a.ts", lines: [{ kind: "match", line: 5, text: "foo bar" }] }] } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "foo" }, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "rg completed renders bullet");
  assert.deepEqual(running.render(80), [], "rg call slot empties when result arrives");

  runtime.dispose();
}

// ─── 11. Metadata is not duplicated (pattern/case/word appear once) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall(
    { pattern: "foo", case: "insensitive", word: true },
    plainTheme,
    makeCtx({ pattern: "foo", case: "insensitive", word: true }, {}, { argsComplete: true, executionStarted: true }),
  );
  const text = stripVTControlCharacters(call.render(80).join("\n"));
  const patternOccurrences = text.match(/pattern=foo/g) ?? [];
  const caseOccurrences = text.match(/case=insensitive/g) ?? [];
  assert.equal(patternOccurrences.length, 1, "pattern field appears exactly once");
  assert.equal(caseOccurrences.length, 1, "case field appears exactly once");

  runtime.dispose();
}

// ─── 12. Structured matches (path, line, column, excerpt) ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "rg returned=1" }],
      details: {
        page: { offset: 0, returned: 1, total: 1 },
        files: [{ path: "src/a.ts", lines: [{ kind: "match", line: 10, column: 3, text: "foo bar" }] }],
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /MATCHES/, "rg result shows MATCHES section");
  assert.match(text, /src\/a\.ts:10:3/, "rg result shows path:line:column");
  assert.match(text, /foo bar/, "rg result shows excerpt");

  runtime.dispose();
}

// ─── 13. Genuine empty result shows explicit "No matches" ───────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall({ pattern: "nomatch" }, plainTheme, makeCtx({ pattern: "nomatch" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "rg returned=0" }], details: { page: { offset: 0, returned: 0, total: 0 } } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "nomatch" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "genuine empty renders completed marker");
  assert.match(text, /No matches/, "genuine empty shows explicit message");
  assert.doesNotMatch(text, /rg returned=0/, "genuine empty does not also show raw text fallback");

  runtime.dispose();
}

// ─── 14. Ambiguous/malformed domain falls back to raw text, not "No matches" ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true }));
  // details lacks `page` and `files` entirely (malformed/unexpected shape),
  // so the display must not claim a confirmed empty result.
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "unexpected raw text" }], details: { status: "success" } },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.doesNotMatch(text, /No matches/, "ambiguous domain does not claim confirmed empty");
  assert.match(text, /unexpected raw text/, "ambiguous domain falls back to raw text so no information is lost");

  runtime.dispose();
}

// ─── 15. Error result distinct from matches and empty ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall({ pattern: "[invalid" }, plainTheme, makeCtx({ pattern: "[invalid" }, {}, { argsComplete: true, executionStarted: true }));
  const errored = decorated.renderResult(
    { content: [{ type: "text", text: "error: invalid regex" }], isError: true, details: { error: "invalid regex pattern" } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "[invalid" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: true }),
  );
  const text = stripVTControlCharacters(errored.render(80).join("\n"));
  assert.match(text, /^×/, "rg error renders failed marker");
  assert.match(text, /invalid regex/, "rg error text visible");
  assert.doesNotMatch(text, /No matches/, "rg error result does not show empty message");
  const errorLines = (text.match(/invalid regex/g) ?? []).length;
  assert.equal(errorLines, 1, "rg error text appears exactly once (not duplicated across preview/section/error field)");

  runtime.dispose();
}

// ─── 16. Pagination metadata reachable when expanded ─────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "rg returned=1" }],
      details: {
        page: { offset: 0, returned: 1, total: 5, hasMore: true, nextOffset: 1 },
        files: [{ path: "a.ts", lines: [{ kind: "match", line: 1, text: "foo" }] }],
      },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /hasMore=true/, "pagination hasMore is reachable when expanded");
  assert.match(text, /next=1/, "pagination next offset is reachable when expanded");
  assert.match(text, /total=5/, "pagination total is reachable when expanded");

  const collapsed = decorated.renderResult(
    {
      content: [{ type: "text", text: "rg returned=1" }],
      details: {
        page: { offset: 0, returned: 1, total: 5, hasMore: true, nextOffset: 1 },
        files: [{ path: "a.ts", lines: [{ kind: "match", line: 1, text: "foo" }] }],
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: false }),
  );
  const collapsedText = stripVTControlCharacters(collapsed.render(80).join("\n"));
  assert.doesNotMatch(collapsedText, /hasMore=true/, "collapsed omits hasMore; secondary paging metadata moves into expanded form");
  assert.doesNotMatch(collapsedText, /next=1/, "collapsed omits next offset");
  assert.match(collapsedText, /total=5/, "collapsed still shows total via header metadata (higher priority)");

  runtime.dispose();
}

// ─── 17. Narrow widths prioritize marker, identity, target ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall(
    { pattern: "foo" },
    plainTheme,
    makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true }),
  );
  for (const width of [39, 40]) {
    const line = stripVTControlCharacters(call.render(width)[0]);
    assert.match(line, /^●/, `marker visible at width ${width}`);
    assert.match(line, /Text search/, `identity visible at width ${width}`);
  }

  runtime.dispose();
}

// ─── 18. Bounded at all widths ───────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeFdRgDef("rg"), () => runtime);
  const call = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "rg returned=1" }],
      details: { page: { offset: 0, returned: 1, total: 1 }, files: [{ path: "src/a.ts", lines: [{ kind: "match", line: 10, text: "foo bar baz".repeat(5) }] }] },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `rg result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 19. Execution unchanged for rg ──────────────────────────────────

{
  const runtime = newRuntime();
  const rgDef = makeFdRgDef("rg");
  const decorated = decorateInternalTool(rgDef, () => runtime);
  assert.equal(decorated.execute, rgDef.execute, "rg execute unchanged");
  assert.deepEqual(decorated.parameters, rgDef.parameters, "rg parameters unchanged");

  runtime.dispose();
}

// ═══ 20. Blast-radius regression: shared search-adapters.ts fixes ═══
// fd, sg, pdf_search, and codegraph share the metadata-dedup, empty-
// message, and error-suppression logic fixed for rg/grep. These are out
// of #22's scope but must not regress from the shared-file changes.

{
  const runtime = newRuntime();

  // fd: metadata not duplicated, genuine empty shows explicit message
  {
    const decorated = decorateInternalTool(makeFdRgDef("fd"), () => runtime);
    const call = decorated.renderCall({ pattern: "*.ts" }, plainTheme, makeCtx({ pattern: "*.ts" }, {}, { argsComplete: true, executionStarted: true }));
    const callText = stripVTControlCharacters(call.render(80).join("\n"));
    assert.equal((callText.match(/pattern=\*\.ts/g) ?? []).length, 1, "fd pattern metadata appears exactly once");

    const empty = decorated.renderResult(
      { content: [{ type: "text", text: "fd returned=0" }], details: { page: { offset: 0, returned: 0, total: 0 } } },
      { expanded: false, isPartial: false },
      plainTheme,
      makeCtx({ pattern: "*.ts" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
    );
    const emptyText = stripVTControlCharacters(empty.render(80).join("\n"));
    assert.match(emptyText, /No results/, "fd genuine empty shows explicit message");
  }

  // sg: metadata not duplicated, genuine empty shows explicit message
  {
    const decorated = decorateInternalTool(makeFdRgDef("sg"), () => runtime);
    const call = decorated.renderCall({ pattern: "foo" }, plainTheme, makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true }));
    const callText = stripVTControlCharacters(call.render(80).join("\n"));
    assert.equal((callText.match(/pattern=foo/g) ?? []).length, 1, "sg pattern metadata appears exactly once");

    const empty = decorated.renderResult(
      { content: [{ type: "text", text: "sg returned=0" }], details: { page: { offset: 0, returned: 0, total: 0 } } },
      { expanded: false, isPartial: false },
      plainTheme,
      makeCtx({ pattern: "foo" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
    );
    const emptyText = stripVTControlCharacters(empty.render(80).join("\n"));
    assert.match(emptyText, /No matches/, "sg genuine empty shows explicit message");
  }

  // pdf_search: genuine empty (top-level details.returned) shows explicit message
  {
    const decorated = decorateInternalTool(makeFdRgDef("pdf_search"), () => runtime);
    const call = decorated.renderCall({ query: "retention", path: "manual.pdf" }, plainTheme, makeCtx({ query: "retention", path: "manual.pdf" }, {}, { argsComplete: true, executionStarted: true }));
    const empty = decorated.renderResult(
      { content: [{ type: "text", text: "pdf_search returned=0" }], details: { returned: 0 } },
      { expanded: false, isPartial: false },
      plainTheme,
      makeCtx({ query: "retention", path: "manual.pdf" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
    );
    const emptyText = stripVTControlCharacters(empty.render(80).join("\n"));
    assert.match(emptyText, /No matches/, "pdf_search genuine empty shows explicit message");
  }

  // codegraph: unaffected by structuredDomain suppression (explicitly excluded)
  {
    const decorated = decorateInternalTool(makeFdRgDef("codegraph"), () => runtime);
    const call = decorated.renderCall({ operation: "explore", query: "runtime" }, plainTheme, makeCtx({ operation: "explore", query: "runtime" }, {}, { argsComplete: true, executionStarted: true }));
    const result = decorated.renderResult(
      { content: [{ type: "text", text: "codegraph explore output" }], details: { status: "success" } },
      { expanded: false, isPartial: false },
      plainTheme,
      makeCtx({ operation: "explore", query: "runtime" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
    );
    const text = stripVTControlCharacters(result.render(80).join("\n"));
    assert.match(text, /codegraph explore output/, "codegraph raw text still renders through its own domain/preview path");
  }

  runtime.dispose();
}

// Cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("text search tests: OK");
