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

function makeSearchDef(name) {
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
  assert.match(text, new RegExp(`^● Grep TODO`), "call target shows the pattern after the natural title");

  runtime.dispose();
}

// ─── 3. Result shows structured matches (path:line + excerpt) ───────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const call = decorated.renderCall({ pattern: "const" }, plainTheme, makeCtx({ pattern: "const" }, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;\na.ts:2:const y = 2;" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.ok(!text.includes("Matches"), "a lone Matches section draws no title rule (C9)");
  assert.match(text, /a\.ts/, "result shows the file header once for both matches");
  assert.match(text, /1 {2}const x = 1;/, "result shows the line number and excerpt for the first match");
  assert.match(text, /2 {2}const y = 2;/, "result shows the line number and excerpt for the second match");

  runtime.dispose();
}

// ─── 3b. Case, regex/literal, glob, and context metadata surfaced ────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createGrepToolDefinition(TMP), TMP, () => runtime);
  const args = { pattern: "TODO", glob: "*.ts", ignoreCase: true, literal: true, context: 2 };

  // No key=value metadata row renders in the call body (design: only the
  // header target carries the search identity).
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.doesNotMatch(callText, /glob=/, "call body has no key=value metadata");
  assert.doesNotMatch(callText, /case=/, "call body has no case metadata");
  assert.doesNotMatch(callText, /literal=/, "call body has no literal metadata");
  assert.doesNotMatch(callText, /context=/, "call body has no context metadata");
  assert.match(callText, new RegExp(`● Grep TODO`), "call header shows the pattern target after the natural title");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const resultText = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(resultText, /a\.ts/, "expanded result shows the file header");
  assert.match(resultText, /1 {2}const x = 1;/, "expanded result shows the match content");

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
  // C4 revision: a collapsed entry is exactly one row; the match payload is
  // visible only when expanded. The inline summary carries the counts.
  assert.equal(collapsed.render(80).length, 1, "collapsed grep renders exactly one row");
  assert.doesNotMatch(collapsedText, /Matches|a\.ts|const x = 1/, "collapsed hides the match payload");
  assert.match(collapsedText, /1 match in 1 file/, "collapsed shows the inline summary");
  assert.doesNotMatch(collapsedText, /QUERY/, "collapsed omits QUERY summary");

  const expanded = decorated.renderResult(
    { content: [{ type: "text", text: "a.ts:1:const x = 1;" }], details: {} },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "const", path: "." }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
  assert.ok(!expandedText.includes("QUERY"), "expanded prunes the restating QUERY section (C8)");
  assert.match(expandedText, /a\.ts/, "expanded shows the file header");
  assert.match(expandedText, /1 {2}const x = 1;/, "expanded shows match content");
  assert.ok(!expandedText.includes("Matches"), "a lone Matches section draws no title rule (C9)");

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


// ═══ 20. Blast-radius regression: shared search-adapters.ts fixes ═══
// pdf_search and codegraph share the metadata-dedup, empty-message, and
// error-suppression logic fixed for rg/grep. These are out of #22's scope
// but must not regress from the shared-file changes.

{
  const runtime = newRuntime();

  // pdf_search: genuine empty (top-level details.returned) shows explicit message
  {
    const decorated = decorateInternalTool(makeSearchDef("pdf_search"), () => runtime);
    const call = decorated.renderCall({ query: "retention", path: "manual.pdf" }, plainTheme, makeCtx({ query: "retention", path: "manual.pdf" }, {}, { argsComplete: true, executionStarted: true }));
    const empty = decorated.renderResult(
      { content: [{ type: "text", text: "pdf_search returned=0" }], details: { returned: 0 } },
      { expanded: true, isPartial: false },
      plainTheme,
      makeCtx({ query: "retention", path: "manual.pdf" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
    );
    const emptyText = stripVTControlCharacters(empty.render(80).join("\n"));
    assert.match(emptyText, /No matches/, "pdf_search genuine empty shows explicit message");
  }

  // codegraph: unaffected by structuredDomain suppression (explicitly excluded)
  {
    const decorated = decorateInternalTool(makeSearchDef("codegraph"), () => runtime);
    const call = decorated.renderCall({ operation: "explore", query: "runtime" }, plainTheme, makeCtx({ operation: "explore", query: "runtime" }, {}, { argsComplete: true, executionStarted: true }));
    const result = decorated.renderResult(
      { content: [{ type: "text", text: "codegraph explore output" }], details: { status: "success" } },
      { expanded: true, isPartial: false },
      plainTheme,
      makeCtx({ operation: "explore", query: "runtime" }, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
    );
    const text = stripVTControlCharacters(result.render(80).join("\n"));
    assert.match(text, /codegraph explore output/, "codegraph raw text still renders through its own domain/preview path");
  }

  runtime.dispose();
}

// Cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("text search tests: OK");
