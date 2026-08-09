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

function makePdfSearchDef() {
  return {
    name: "pdf_search",
    label: "PDF Search",
    description: "pdf_search tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

function baseDetails(overrides = {}) {
  return {
    version: 1,
    phase: "done",
    status: "success",
    path: "reports/q3.pdf",
    query: "revenue",
    limit: 10,
    pageCount: 12,
    searchedPages: 12,
    extractedTextUnits: 40_000,
    cacheHit: false,
    totalMatches: 2,
    returned: 2,
    hasMore: false,
    durationMs: 123,
    matches: [
      { page: 3, type: "exact", score: 1, edits: 0, context: "Total revenue increased by 12% year over year.", matchedText: "revenue" },
      { page: 9, type: "fuzzy", score: 0.82, edits: 1, context: "Net revenues for the quarter were strong.", matchedText: "revenues" },
    ],
    ...overrides,
  };
}

function renderResult(decorated, args, details, opts = {}) {
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  return decorated.renderResult(
    { content: [{ type: "text", text: opts.text ?? JSON.stringify(details) }], details, ...(opts.isError ? { isError: true } : {}) },
    { expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false },
    plainTheme,
    makeCtx(args, {}, {
      argsComplete: true,
      executionStarted: true,
      lastComponent: call,
      isError: opts.isError ?? false,
      expanded: opts.expanded ?? false,
      isPartial: opts.isPartial ?? false,
    }),
  );
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
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  assert.equal(decorated.renderShell, "self", "pdf_search uses self render shell");

  const args = { path: "reports/q3.pdf", query: "revenue" };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(baseDetails()) }], details: baseDetails() },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders bullet");
  assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

  runtime.dispose();
}

// ─── 2. Calls keep workspace-relative PDF identity and query visible ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue", limit: 5 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /PDF search/, "call shows the PDF search title");
  assert.match(text, /revenue/, "call target shows the query");
  assert.match(text, /path=reports\/q3\.pdf/, "call metadata shows the workspace-relative path");
  assert.match(text, /query=revenue/, "call metadata shows the query");
  assert.match(text, /limit=5/, "call metadata shows the limit");

  runtime.dispose();
}

// ─── 3. Exact vs. fuzzy matches are visually and textually distinct ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const result = renderResult(decorated, args, baseDetails(), { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /MATCHES/, "result shows a Matches section");
  assert.match(text, /reports\/q3\.pdf:3/, "exact match shows page 3 as the ranked page number");
  assert.match(text, /exact · score 1 · edits 0/, "exact match is labeled exact with score and edit distance");
  assert.match(text, /Total revenue increased by 12% year over year\./, "exact match shows bounded context");
  assert.match(text, /reports\/q3\.pdf:9/, "fuzzy match shows page 9 as the ranked page number");
  assert.match(text, /fuzzy · score 0\.82 · edits 1/, "fuzzy match is labeled fuzzy with score and edit distance, distinct from exact");
  assert.match(text, /Net revenues for the quarter were strong\./, "fuzzy match shows bounded context");
  // Ranking: exact-type matches must be listed before fuzzy-type matches.
  assert.ok(text.indexOf("reports/q3.pdf:3") < text.indexOf("reports/q3.pdf:9"), "exact match is ranked ahead of fuzzy match");

  // Same-type ranking: matcher.ts pre-sorts same-type matches (exact
  // before exact, by page); the display must preserve that source order
  // rather than re-sorting or reversing it.
  const sameTypeDetails = baseDetails({
    matches: [
      { page: 2, type: "exact", score: 1, edits: 0, context: "Revenue grew steadily.", matchedText: "revenue" },
      { page: 6, type: "exact", score: 1, edits: 0, context: "Revenue figures restated.", matchedText: "revenue" },
    ],
    totalMatches: 2,
    returned: 2,
  });
  const sameTypeResult = renderResult(decorated, args, sameTypeDetails, { expanded: true });
  const sameTypeText = stripVTControlCharacters(sameTypeResult.render(100).join("\n"));
  assert.ok(
    sameTypeText.indexOf("reports/q3.pdf:2") < sameTypeText.indexOf("reports/q3.pdf:6"),
    "same-type matches preserve the source-ranked page order (page 2 before page 6)",
  );

  runtime.dispose();
}

// ─── 4. Document, page, result, and cache budgets are visible ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue", limit: 1 };
  const details = baseDetails({ limit: 1, returned: 1, totalMatches: 5, hasMore: true, cacheHit: true, matches: [baseDetails().matches[0]] });
  const result = renderResult(decorated, args, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /pages=12/, "document page budget (total page count) is visible");
  assert.match(text, /totalMatches=5/, "total match count is visible");
  assert.match(text, /returned=1/, "returned count is visible, distinct from total");
  assert.match(text, /hasMore=true/, "the result budget signals more matches exist beyond the returned/limit set");
  assert.match(text, /cacheHit=true/, "the cache budget/hit state is visible");

  runtime.dispose();
}

// ─── 5. Empty matches render a distinct, explicit empty state ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "unicorn" };
  const details = baseDetails({ query: "unicorn", totalMatches: 0, returned: 0, hasMore: false, matches: [] });
  const result = renderResult(decorated, args, details);
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^✓/, "empty matches still render completed, not failed");
  assert.match(text, /No matches/, "empty matches show an explicit empty message");
  assert.doesNotMatch(text, /MATCHES/, "no Matches section header renders for a confirmed-empty result");

  runtime.dispose();
}

// ─── 6. Distinct error states: textless, encrypted, oversized, over-page-limit, timeout, resource failure, changed-during-read ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const errorCases = [
    ["NO_EXTRACTABLE_TEXT", "PDF contains no extractable text; scanned PDFs require OCR and are not supported"],
    ["ENCRYPTED_PDF", "Encrypted or password-protected PDFs are not supported"],
    ["PDF_TOO_LARGE", "PDF exceeds the 50 MB safety limit"],
    ["PDF_PAGE_LIMIT", "PDF contains 1400 pages; pdf_search supports at most 1000"],
    ["PDF_SEARCH_TIMEOUT", "PDF search exceeded the 30000-ms time limit"],
    ["PDFJS_ASSETS_UNAVAILABLE", "Required PDF.js asset directory is unavailable"],
    ["PDF_CHANGED_DURING_READ", "PDF changed while it was being read; retry the search"],
  ];
  const renderedTexts = [];
  for (const [errorCode, message] of errorCases) {
    const details = baseDetails({ phase: "done", status: "error", errorCode, error: message, matches: [], returned: undefined, totalMatches: undefined });
    const result = renderResult(decorated, args, details, { text: `Error: ${message}`, isError: true, expanded: true });
    const text = stripVTControlCharacters(result.render(100).join("\n"));
    assert.match(text, /^×/, `${errorCode} renders the failed marker`);
    assert.match(text, new RegExp(`code=${errorCode}`), `${errorCode} is visible in header metadata even before expanding`);
    assert.match(text, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${errorCode} shows its own distinct message`);
    renderedTexts.push(text);
  }
  // Cross-check: every error case renders visibly distinct text (no two
  // error codes collapse to the same rendered output).
  const unique = new Set(renderedTexts);
  assert.equal(unique.size, errorCases.length, "each error code renders visibly distinct content");

  runtime.dispose();
}

// ─── 7. Aborted cancellation renders the aborted marker, distinct from failed ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const details = baseDetails({ phase: "done", status: "aborted", errorCode: "ABORTED", error: "PDF search was cancelled", matches: [], returned: undefined, totalMatches: undefined });
  const result = renderResult(decorated, args, details, { text: "Error: PDF search was cancelled", isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^·/, "aborted renders the · marker, not the × failed marker");
  assert.match(text, /PDF search was cancelled/, "aborted shows the cancellation message");
  assert.equal((text.match(/PDF search was cancelled/g) ?? []).length, 1, "the cancellation message is not duplicated");

  runtime.dispose();
}

// ─── 8. No partial result is presented after timeout or resource failure ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  // A timeout/resource failure carries no matches at all (tool.ts never
  // returns partial matches on failure) — the rendered result must not
  // show a Matches section or any match content.
  const timeoutDetails = baseDetails({ phase: "done", status: "error", errorCode: "PDF_SEARCH_TIMEOUT", error: "PDF search exceeded the 30000-ms time limit", matches: [], returned: undefined, totalMatches: undefined });
  const timeoutResult = renderResult(decorated, args, timeoutDetails, { text: "Error: PDF search exceeded the 30000-ms time limit", isError: true, expanded: true });
  const timeoutText = stripVTControlCharacters(timeoutResult.render(100).join("\n"));
  assert.doesNotMatch(timeoutText, /MATCHES/, "timeout does not render a Matches section");
  assert.doesNotMatch(timeoutText, /Total revenue/, "timeout shows no partial match content");

  const resourceDetails = baseDetails({ phase: "done", status: "error", errorCode: "PDFJS_ASSETS_UNAVAILABLE", error: "Required PDF.js asset directory is unavailable", matches: [], returned: undefined, totalMatches: undefined });
  const resourceResult = renderResult(decorated, args, resourceDetails, { text: "Error: Required PDF.js asset directory is unavailable", isError: true, expanded: true });
  const resourceText = stripVTControlCharacters(resourceResult.render(100).join("\n"));
  assert.doesNotMatch(resourceText, /MATCHES/, "resource failure does not render a Matches section");

  runtime.dispose();
}

// ─── 9. UI never claims OCR or semantic search, never a remote-fetch path ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const result = renderResult(decorated, args, baseDetails(), { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(text, /\bOCR\b/i, "successful result text never claims OCR capability");
  assert.doesNotMatch(text, /semantic search/i, "successful result text never claims semantic search capability");
  assert.doesNotMatch(text, /https?:\/\//, "successful result text never exposes a remote-fetch URL");

  runtime.dispose();
}

// ─── 10. Collapsed view keeps critical identity/lifecycle/target/error visible ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };

  const okCollapsed = renderResult(decorated, args, baseDetails(), { expanded: false });
  const okText = stripVTControlCharacters(okCollapsed.render(100).join("\n"));
  assert.match(okText, /^✓/, "collapsed success keeps the lifecycle marker visible");
  assert.match(okText, /PDF search/, "collapsed success keeps the identity/title visible");
  assert.match(okText, /revenue/, "collapsed success keeps the target/query visible");
  assert.match(okText, /MATCHES/, "collapsed success still shows the compact Matches section");

  const errDetails = baseDetails({ phase: "done", status: "error", errorCode: "PDF_TOO_LARGE", error: "PDF exceeds the 50 MB safety limit", matches: [], returned: undefined, totalMatches: undefined });
  const errCollapsed = renderResult(decorated, args, errDetails, { text: "Error: PDF exceeds the 50 MB safety limit", isError: true, expanded: false });
  const errText = stripVTControlCharacters(errCollapsed.render(100).join("\n"));
  assert.match(errText, /^×/, "collapsed error keeps the failed marker visible");
  assert.match(errText, /code=PDF_TOO_LARGE/, "collapsed error keeps the error code visible in header metadata");
  assert.match(errText, /PDF exceeds the 50 MB safety limit/, "collapsed error keeps the error message visible");

  // Expanded-only content (Query section) must not leak into collapsed view.
  assert.doesNotMatch(okText, /QUERY ───/, "collapsed view omits the non-compact Query section");

  runtime.dispose();
}

// ─── 11. Truncation/hasMore reachable when expanded, absent when collapsed for non-critical detail ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue", limit: 1 };
  const details = baseDetails({ limit: 1, returned: 1, totalMatches: 5, hasMore: true, matches: [baseDetails().matches[0]] });

  const expanded = renderResult(decorated, args, details, { expanded: true });
  const expandedText = stripVTControlCharacters(expanded.render(100).join("\n"));
  assert.match(expandedText, /hasMore=true/, "hasMore is reachable when expanded");

  const collapsed = renderResult(decorated, args, details, { expanded: false });
  const collapsedText = stripVTControlCharacters(collapsed.render(100).join("\n"));
  assert.doesNotMatch(collapsedText, /hasMore=true/, "hasMore is not shown collapsed (the Summary section is non-compact)");

  // The remaining budget fields (document page count, total match count,
  // cache hit) follow the same Summary-section compact=false rule: they
  // are reachable when expanded and absent when collapsed, not silently
  // dropped either way.
  assert.match(expandedText, /pages=12/, "pages is reachable when expanded");
  assert.match(expandedText, /totalMatches=5/, "totalMatches is reachable when expanded");
  assert.doesNotMatch(collapsedText, /pages=12/, "pages is not shown collapsed");
  assert.doesNotMatch(collapsedText, /totalMatches=5/, "totalMatches is not shown collapsed");

  runtime.dispose();
}

// ─── 11b. pdfSearchLifecycle does not fire for a non-aborted error status ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  // A genuine hard failure reports status "error", never "aborted"; the
  // lifecycle override must not fire here, leaving the shared runtime's
  // isError-forces-error bridge to render the failed marker as normal.
  const details = baseDetails({ phase: "done", status: "error", errorCode: "INVALID_PDF", error: "File does not contain a PDF header", matches: [], returned: undefined, totalMatches: undefined });
  const result = renderResult(decorated, args, details, { text: "Error: File does not contain a PDF header", isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "a non-aborted error status renders the failed marker, confirming pdfSearchLifecycle did not override it to aborted");
  assert.doesNotMatch(text, /^·/, "a non-aborted error status never renders the aborted marker");

  runtime.dispose();
}

// ─── 12. Bounded at all widths ───────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const result = renderResult(decorated, args, baseDetails(), { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `pdf_search result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 13. Narrow widths prioritize marker, identity, target ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  for (const width of [39, 40]) {
    const line = stripVTControlCharacters(call.render(width)[0]);
    assert.match(line, /^●/, `marker visible at width ${width}`);
    assert.match(line, /PDF search|revenue/, `identity or target visible at width ${width}`);
  }

  runtime.dispose();
}

// ─── 14. Ambiguous/malformed details fall back to raw text, not silent loss ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  // Details lacking recognizable domain fields (no matches array reachable
  // as PdfPageMatch entries, no confirmed-zero returned count) must not
  // silently render nothing.
  const result = renderResult(decorated, args, { status: "success", note: "unexpected shape" }, { text: "unexpected raw content", expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /unexpected raw content/, "unrecognized/malformed details fall back to showing raw content");

  runtime.dispose();
}

// ─── 15. Sanitization: control characters in match context are stripped ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makePdfSearchDef(), () => runtime);
  const args = { path: "reports/q3.pdf", query: "revenue" };
  const details = baseDetails({
    matches: [{ page: 1, type: "exact", score: 1, edits: 0, context: "Revenue \x1b[31mspiked\x1b[0m this quarter.", matchedText: "revenue" }],
    totalMatches: 1,
    returned: 1,
  });
  const result = renderResult(decorated, args, details, { expanded: true });
  const raw = result.render(100).join("\n");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(stripVTControlCharacters(raw), /\x1b\[31m/, "raw ANSI escape sequences embedded in PDF text are sanitized before display");

  runtime.dispose();
}

// ─── 16. Execution unchanged ─────────────────────────────────────────

{
  const runtime = newRuntime();
  const pdfDef = makePdfSearchDef();
  const decorated = decorateInternalTool(pdfDef, () => runtime);
  assert.equal(decorated.execute, pdfDef.execute, "pdf_search execute unchanged");
  assert.deepEqual(decorated.parameters, pdfDef.parameters, "pdf_search parameters unchanged");

  runtime.dispose();
}

console.log("pdf_search display tests: OK");
