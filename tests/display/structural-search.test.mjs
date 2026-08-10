import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: "/tmp",
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

function makeSgDef() {
  return {
    name: "sg",
    label: "sg",
    description: "sg tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

function sgMatch(overrides = {}) {
  return {
    path: "src/a.ts",
    language: "typescript",
    text: "foo(bar, baz)",
    displayText: "foo(bar, baz)",
    range: { byteOffset: { start: 0, end: 13 }, start: { line: 5, column: 2 }, end: { line: 5, column: 15 } },
    metaVariables: [{ name: "FUNC", text: "foo" }, { name: "ARGS", text: "bar, baz" }],
    ...overrides,
  };
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
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  assert.equal(decorated.renderShell, "self", "sg uses self render shell");

  const state = {};
  const queued = decorated.renderCall({ pattern: "$X" }, plainTheme, makeCtx({ pattern: "$X" }, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall({ pattern: "$X" }, plainTheme, makeCtx({ pattern: "$X" }, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall({ pattern: "$X" }, plainTheme, makeCtx({ pattern: "$X" }, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "sg returned=1" }], details: { page: { offset: 0, returned: 1, total: 1 }, matches: [sgMatch()] } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ pattern: "$X" }, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders bullet");
  assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

  runtime.dispose();
}

// ─── 2. Pattern mode: target shown, no key=value metadata ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$FUNC($$$ARGS)", selector: "call_expression", strictness: "ast", language: "ts", path: "src" };
  // No key=value metadata row renders in the call body (design: only the
  // header target carries the search identity).
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /\$FUNC\(\$\$\$ARGS\)/, "call target shows the pattern");
  assert.doesNotMatch(text, /pattern=/, "no key=value pattern metadata");
  assert.doesNotMatch(text, /selector=/, "no key=value selector metadata");
  assert.doesNotMatch(text, /strictness=/, "no key=value strictness metadata");
  assert.doesNotMatch(text, /language=ts/, "no key=value language metadata");
  assert.doesNotMatch(text, /path=src/, "no key=value path metadata");

  runtime.dispose();
}

// ─── 3. Kind mode: target shown, no key=value metadata ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { kind: "call_expression", selector: "ignored", strictness: "ast", language: "ts", path: "src" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /call_expression/, "call target shows the kind");
  assert.doesNotMatch(text, /kind=/, "no key=value kind metadata");
  assert.doesNotMatch(text, /language=ts/, "no key=value language metadata");
  assert.doesNotMatch(text, /path=src/, "no key=value path metadata");
  assert.doesNotMatch(text, /selector=/, "no key=value selector metadata");
  assert.doesNotMatch(text, /strictness=/, "no key=value strictness metadata");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "sg returned=1" }], details: { page: { offset: 0, returned: 1, total: 1 }, matches: [sgMatch({ metaVariables: [] })] } },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const resultText = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(resultText, /kind=|language=/, "expanded result carries no key=value metadata row (C8)");
  assert.doesNotMatch(resultText, /selector=/, "expanded result also suppresses selector in kind mode");
  assert.doesNotMatch(resultText, /strictness=/, "expanded result also suppresses strictness in kind mode");

  runtime.dispose();
}

// ─── 4. Matches preserve path, line, and excerpt (no column, no language, no captures) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$FUNC($$$ARGS)" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "sg returned=1" }], details: { page: { offset: 0, returned: 1, total: 1 }, matches: [sgMatch()] } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.ok(!text.includes("Matches"), "a lone Matches section draws no title rule (C9)");
  assert.match(text, /src\/a\.ts/, "result shows the file header (no column)");
  assert.match(text, /5 {2}foo\(bar, baz\)/, "result shows the line number and excerpt");
  assert.doesNotMatch(text, /typescript/, "result no longer shows the match language");
  assert.doesNotMatch(text, /FUNC=foo/, "result no longer shows metavariable capture FUNC");
  assert.doesNotMatch(text, /ARGS=bar, baz/, "result no longer shows metavariable capture ARGS");

  runtime.dispose();
}

// ─── 5. No raw CLI arguments or rewrite affordances in output ───────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$X", path: "src", includeGlobs: ["*.ts"], excludeGlobs: ["*.test.ts"] };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "sg returned=1" }], details: { page: { offset: 0, returned: 1, total: 1 }, matches: [sgMatch()], binary: "/usr/local/bin/ast-grep" } },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(text, /--json|ast-grep run|--pattern\b/, "no raw ast-grep CLI invocation surfaces");
  assert.doesNotMatch(text, /rewrite|--update-all|-U\b/, "no rewrite affordance surfaces");

  runtime.dispose();
}

// ─── 6. Distinct error states: invalid pattern, unsupported language, ─
// ─── timeout, binary-resolution failure ──────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "invalid(((" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));

  const scenarios = [
    ["sg failed with exit code 1: Pattern parse error at line 1", /Pattern parse error/],
    ["sg failed with exit code 1: unsupported language xyz", /unsupported language xyz/],
    ["sg timed out", /sg timed out/],
    ["Cannot resolve ast-grep binary for this platform", /Cannot resolve ast-grep binary/],
  ];
  const seenTexts = [];
  for (const [errorText, expectedPattern] of scenarios) {
    const errored = decorated.renderResult(
      { content: [{ type: "text", text: errorText }], isError: true, details: {} },
      { expanded: false, isPartial: false },
      plainTheme,
      makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: true }),
    );
    const text = stripVTControlCharacters(errored.render(90).join("\n"));
    assert.match(text, /^×/, `error state '${errorText}' renders failed marker`);
    assert.match(text, expectedPattern, `error state '${errorText}' shows its distinct safe message`);
    assert.doesNotMatch(text, /No matches/, `error state '${errorText}' is distinct from empty`);
    seenTexts.push(text);
  }
  // Confirm the four scenarios actually produced textually distinct output
  // (not just four scenarios collapsing into an identical generic message).
  assert.equal(new Set(seenTexts).size, seenTexts.length, "all four error scenarios render distinct text");

  // Production sg.ts embeds raw process stderr verbatim into the thrown
  // error message (`sg failed with exit code ${code}: ${stderr}`). Prove
  // the display boundary sanitizes it rather than relying on ast-grep's
  // stderr always being pre-sanitized plain text.
  const rawStderrError = "sg failed with exit code 1: \x1b[31merror\x1b[0m: unexpected token\x07 at --pattern flag";
  const unsanitized = decorated.renderResult(
    { content: [{ type: "text", text: rawStderrError }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: true }),
  );
  const rawRendered = unsanitized.render(90).join("\n");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(rawRendered, /\x1b\[31m|\x1b\[0m|\x07/, "raw ANSI/control sequences embedded in process stderr are sanitized before display");
  assert.match(stripVTControlCharacters(rawRendered), /unexpected token/, "the underlying error message remains readable after sanitization");

  runtime.dispose();
}

// ─── 7. Genuinely empty result is distinct from errors and matches ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$NOMATCH" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "sg returned=0" }], details: { page: { offset: 0, returned: 0, total: 0 } } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "genuine empty renders completed marker (not failed)");
  assert.match(text, /No matches/, "genuine empty shows explicit message");
  assert.doesNotMatch(text, /sg returned=0/, "genuine empty does not also show raw text fallback");

  runtime.dispose();
}

// ─── 8. Truncation is visible when expanded ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$X" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "sg returned=1" }],
      details: {
        page: { offset: 0, returned: 1, total: 50, hasMore: true, nextOffset: 1 },
        truncation: { lineExcerpts: 3, contextLinesOmitted: 5, contentBudgetReached: true },
        matches: [sgMatch({ metaVariables: [] })],
      },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /\[truncated\]/, "content budget and pagination raise the truncated badge");
  assert.match(text, /1 of 50 matches in 1 file · continue at offset 1/, "the summary row states pagination and continuation");

  runtime.dispose();
}

// ─── 9. Terminal control characters in matches are sanitized ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$X" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const malicious = sgMatch({
    language: "ts\x1b[31minjected",
    text: "danger\x07bell",
    displayText: "danger\x1b[31minjected\x07bell",
    metaVariables: [{ name: "X\x1b[31m", text: "val\x07ue" }],
  });
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "sg returned=1" }], details: { page: { offset: 0, returned: 1, total: 1 }, matches: [malicious] } },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const rendered = result.render(100).join("\n");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(rendered, /\x1b\[31m|\x07/, "raw ANSI/control sequences are not present in rendered output");

  runtime.dispose();
}

// ─── 10. Narrow widths prioritize marker, identity, target ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$X" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  for (const width of [39, 40]) {
    const line = stripVTControlCharacters(call.render(width)[0]);
    assert.match(line, /^●/, `marker visible at width ${width}`);
    assert.match(line, /Structural search/, `search identity visible at width ${width}`);
    assert.ok(visibleWidth(call.render(width)[0]) <= width, `call line bounded at width ${width}`);
  }

  runtime.dispose();
}

// ─── 11. Secondary metadata omitted collapsed, reachable expanded ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$X" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));

  const collapsed = decorated.renderResult(
    {
      content: [{ type: "text", text: "sg returned=1" }],
      details: { page: { offset: 0, returned: 1, total: 5, hasMore: true, nextOffset: 1 }, matches: [sgMatch({ metaVariables: [] })] },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: false }),
  );
  const collapsedText = stripVTControlCharacters(collapsed.render(80).join("\n"));
  assert.doesNotMatch(collapsedText, /QUERY/, "collapsed omits QUERY summary");
  assert.match(collapsedText, /\[truncated\]/, "collapsed shows the truncated badge for pagination");
  assert.match(collapsedText, /1 of 5 matches in 1 file · continue at offset 1/, "collapsed summary row states pagination and continuation");

  const expanded = decorated.renderResult(
    {
      content: [{ type: "text", text: "sg returned=1" }],
      details: { page: { offset: 0, returned: 1, total: 5, hasMore: true, nextOffset: 1 }, matches: [sgMatch({ metaVariables: [] })] },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
  assert.doesNotMatch(expandedText, /total=/, "expanded result carries no key=value metadata row (C8)");
  assert.match(expandedText, /1 of 5 matches in 1 file · continue at offset 1/, "expanded summary row states pagination and continuation");

  runtime.dispose();
}

// ─── 12. Bounded at all widths ───────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeSgDef(), () => runtime);
  const args = { pattern: "$X" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    {
      content: [{ type: "text", text: "sg returned=1" }],
      details: {
        page: { offset: 0, returned: 1, total: 1 },
        matches: [sgMatch({ text: "foo bar baz".repeat(5), displayText: "foo bar baz".repeat(5) })],
      },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isError: false, expanded: true }),
  );
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `sg result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 13. Execution unchanged ─────────────────────────────────────────

{
  const runtime = newRuntime();
  const sgDef = makeSgDef();
  const decorated = decorateInternalTool(sgDef, () => runtime);
  assert.equal(decorated.execute, sgDef.execute, "sg execute unchanged");
  assert.deepEqual(decorated.parameters, sgDef.parameters, "sg parameters unchanged");

  runtime.dispose();
}

console.log("structural search tests: OK");
