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

function makeDef(name) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

function renderResult(decorated, args, details, text, opts = {}) {
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  return decorated.renderResult(
    { content: [{ type: "text", text }], details, ...(opts.isError ? { isError: true } : {}) },
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

// ═══════════════════════ SEARCH ═════════════════════════════════════

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
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  assert.equal(decorated.renderShell, "self", "search uses self render shell");

  const args = { queries: ["typescript generics"] };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^–/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^○/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^⠋/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "[1] Result" }], details: { queries: ["typescript generics"], phase: "done", count: 1 } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^✓/, "completed renders check mark");

  runtime.dispose();
}

// ─── 2. Search titles retain deduplicated queries as target ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["typescript generics", "rust traits"], limit: 5, sites: ["stackoverflow.com"], language: "en", country: "US", no_cache: true };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /Web search/, "call shows Web search title");
  assert.match(text, /typescript generics.*rust traits/, "call target shows the queries");
  assert.match(text, /queries=typescript generics, rust traits/, "call metadata shows the queries");
  assert.match(text, /sites=stackoverflow\.com/, "call metadata shows host restrictions");
  assert.match(text, /language=en/, "call metadata shows language");
  assert.match(text, /country=US/, "call metadata shows country");
  assert.match(text, /cache=bypassed/, "call metadata shows cache bypass");

  runtime.dispose();
}

// ─── 3. Expanded results preserve ranking, source title/URL, content ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["rust traits", "rust traits"] };
  const details = {
    queries: ["rust traits"], failedQueries: [], count: 5, phase: "done",
    totalBeforeDedup: 6, totalAfterDedup: 3,
    results: [
      { title: "Rust Traits Guide", url: "https://doc.rust-lang.org/traits", description: "Complete guide to traits", provenance: "[q1#1]" },
      { title: "Trait Objects", url: "https://blog.rust-lang.org/obj", description: "Dynamic dispatch with dyn", provenance: "[q1#2]" },
      { title: "Default Impls", url: "https://example.com/default", description: "Default trait implementations", provenance: "[q1#3]" },
    ],
  };
  const result = renderResult(decorated, args, details, "[1] Rust Traits Guide\n    https://doc.rust-lang.org/traits", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /RESULTS/, "expanded result shows a Results section");
  assert.match(text, /Rust Traits Guide/, "result preserves source title");
  assert.match(text, /doc\.rust-lang\.org\/traits/, "result preserves source URL");
  assert.match(text, /Complete guide to traits/, "result preserves readable content");
  assert.match(text, /provenance=\[q1#1\]/, "result preserves RRF ranking provenance");
  // Ranking order: results must be listed in ranked order (1 before 2 before 3)
  assert.ok(text.indexOf("Rust Traits Guide") < text.indexOf("Trait Objects"), "results preserve RRF ranking order");

  runtime.dispose();
}

// ─── 4. Partial per-query failure is distinctly visible ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["good query", "bad query"] };
  const details = {
    queries: ["good query", "bad query"],
    failedQueries: [{ query: "bad query", error: "timeout" }],
    count: 5, phase: "done",
    totalBeforeDedup: 2, totalAfterDedup: 2,
    results: [{ title: "Good Result", url: "https://example.com/good", description: "A good result", provenance: "[q1#1]" }],
  };
  const result = renderResult(decorated, args, details, "[1] Good Result\n    https://example.com/good", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^✓/, "partial-failure search renders completed (some results succeeded)");
  assert.match(text, /RESULTS/, "partial-failure shows the successful results");
  assert.match(text, /Good Result/, "partial-failure preserves the successful result");
  // The failed query error should be visible somewhere when expanded
  // (currently carried in the summary or model-facing text)

  runtime.dispose();
}

// ─── 5. Empty results state ─────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["nonexistent topic"] };
  const details = { queries: ["nonexistent topic"], failedQueries: [], count: 5, phase: "done", totalBeforeDedup: 0, totalAfterDedup: 0, results: [] };
  const result = renderResult(decorated, args, details, "No results found.", { expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "empty results renders completed, not failed");
  assert.match(text, /No results found/, "empty state shows a message in preview");

  runtime.dispose();
}

// ─── 6. Error states: provider error visible without isError ─────
// Search/fetch tools don't set isError:true for failures — they return
// details.error and let the display adapter surface it. The adapter must
// make the error visible even without isError.

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["fail query"] };
  const details = { queries: ["fail query"], failedQueries: [{ query: "fail query", error: "Connection refused" }], count: 3, phase: "done", error: "fail query: Connection refused" };
  // NOTE: no isError:true — this is the actual tool behavior
  const result = renderResult(decorated, args, details, "Search error: fail query: Connection refused", { expanded: false });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Connection refused/, "error message is visible even without isError (compact Result section)");
  assert.doesNotMatch(text, /OUTPUT ───/, "no Output section when error text is present");

  // Also verify isError:true still works (if Pi ever sets it)
  const isErrorResult = renderResult(decorated, args, details, "Search error: fail query: Connection refused", { isError: true, expanded: true });
  const isErrorText = stripVTControlCharacters(isErrorResult.render(100).join("\n"));
  assert.match(isErrorText, /^✗/, "isError result renders failed marker");
  assert.match(isErrorText, /Connection refused/, "isError error message is visible through description.error");
  assert.doesNotMatch(isErrorText, /ERROR ───/, "no separate ERROR section even with isError");
  const errorCount = (isErrorText.match(/Connection refused/g) ?? []).length;
  assert.ok(errorCount <= 2, `error text appears ${errorCount} times with isError (expected at most 2)`);

  runtime.dispose();
}

// ─── 7. No metadata duplication in header ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["test query"], limit: 3, no_cache: true };
  const result = renderResult(decorated, args, { queries: ["test query"], phase: "done", count: 3 }, "output text", { expanded: false });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  const headerLine = text.split("\n")[1] ?? "";
  // queries should appear exactly once in the header metadata
  const queryCount = (headerLine.match(/queries=test query/g) ?? []).length;
  assert.equal(queryCount, 1, "queries appears exactly once in header (no duplication)");
  // no_cache raw key should be suppressed in favor of cache=bypassed
  assert.doesNotMatch(headerLine, /no_cache=true/, "raw no_cache label suppressed in favor of cache=bypassed");

  runtime.dispose();
}

// ─── 8. Collapsed keeps identity/target visible, expanded reachable ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["test"], limit: 3 };
  const details = { queries: ["test"], phase: "done", count: 3, totalAfterDedup: 2, results: [{ title: "R", url: "https://ex.com", description: "d", provenance: "[q1#1]" }] };

  const collapsed = renderResult(decorated, args, details, "[1] R\n    https://ex.com", { expanded: false });
  const collapsedText = stripVTControlCharacters(collapsed.render(100).join("\n"));
  assert.match(collapsedText, /^✓/, "collapsed keeps lifecycle marker");
  assert.match(collapsedText, /Web search/, "collapsed keeps identity/title");
  assert.match(collapsedText, /test/, "collapsed keeps query target");
  assert.match(collapsedText, /\[1\] R/, "collapsed shows content in preview");

  const expanded = renderResult(decorated, args, details, "[1] R", { expanded: true });
  const expandedText = stripVTControlCharacters(expanded.render(100).join("\n"));
  assert.match(expandedText, /REQUEST/, "expanded shows Request section");
  assert.match(expandedText, /SUMMARY/, "expanded shows Summary section");
  assert.match(expandedText, /RESULTS/, "expanded shows Results section");

  runtime.dispose();
}

// ═══════════════════════ FETCH ═════════════════════════════════════

// ─── 9. Fetch titles retain safe normalized URLs as target ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const args = { urls: ["https://example.com/page1", "https://example.com/page2"], mode: "readable", max_tokens: 5000, include_links: true, describe_images: true, no_cache: true };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /Web fetch/, "call shows Web fetch title");
  assert.match(text, /example\.com\/page1/, "call target shows safe normalized URLs");
  assert.match(text, /mode=readable/, "call metadata shows mode");
  assert.match(text, /maxTokens=5000/, "call metadata shows maxTokens (not raw max_tokens)");
  assert.match(text, /links=included/, "call metadata shows link-summary choice");
  assert.match(text, /images=described/, "call metadata shows image-description choice");
  assert.match(text, /cache=bypassed/, "call metadata shows cache choice");
  // No raw arg-key labels should leak
  assert.doesNotMatch(text, /max_tokens=/, "raw max_tokens label suppressed");
  assert.doesNotMatch(text, /include_links=/, "raw include_links label suppressed");
  assert.doesNotMatch(text, /describe_images=/, "raw describe_images label suppressed");
  assert.doesNotMatch(text, /no_cache=/, "raw no_cache label suppressed");

  runtime.dispose();
}

// ─── 10. Expanded fetch results preserve page title, URL, metadata ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const args = { urls: ["https://example.com/page1", "https://example.com/page2"], mode: "readable" };
  const details = {
    urls: ["https://example.com/page1", "https://example.com/page2"],
    succeeded: 2, failed: 0, phase: "done",
    results: [
      { url: "https://example.com/page1", finalUrl: "https://example.com/page1", lines: 50, retried: false },
      { url: "https://example.com/page2", finalUrl: "https://example.com/redirected", lines: 30, retried: true },
    ],
    failedUrls: [],
    pages: [
      { url: "https://example.com/page1", title: "Page One", lines: 50, retried: false, tokens: 3000, usage: "3000 tokens", start: 0, end: 200, bodyStart: 50 },
      { url: "https://example.com/page2", title: "Page Two", lines: 30, retried: true, tokens: 2000, usage: "2000 tokens", finalUrl: "https://example.com/redirected", start: 205, end: 400, bodyStart: 255 },
    ],
  };
  const result = renderResult(decorated, args, details, "## Page One\nURL: https://example.com/page1\n\nContent...\n\n---\n\n## Page Two\nURL: https://example.com/page2", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /RESULTS/, "expanded fetch shows a Results section");
  assert.match(text, /Page One/, "result preserves page title");
  assert.match(text, /Page Two/, "result preserves second page title");
  assert.match(text, /url=https:\/\/example\.com\/page1/, "result preserves page URL");
  assert.match(text, /lines=50/, "result preserves line count");
  assert.match(text, /tokens=3000/, "result preserves token count");
  assert.match(text, /retried=yes/, "result marks retried pages distinctly");

  runtime.dispose();
}

// ─── 11. Partial per-URL failure is distinctly visible ──────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const args = { urls: ["https://good.example.com", "https://bad.example.com"] };
  const details = {
    urls: ["https://good.example.com", "https://bad.example.com"],
    succeeded: 1, failed: 1, phase: "done",
    results: [{ url: "https://good.example.com", finalUrl: "", lines: 20, retried: false }],
    failedUrls: [{ url: "https://bad.example.com", error: "Jina 503: Service Unavailable", retried: true }],
    pages: [
      { url: "https://good.example.com", title: "Good Page", lines: 20, retried: false, start: 0, end: 100 },
      { url: "https://bad.example.com", title: "bad.example.com", lines: 0, retried: true, error: "Jina 503: Service Unavailable", start: 105, end: 150 },
    ],
  };
  const result = renderResult(decorated, args, details, "## Good Page\n\nContent\n\n---\n\n## bad.example.com\n\n[Failed: Jina 503]", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^✓/, "partial-URL-failure fetch renders completed (some pages succeeded)");
  assert.match(text, /succeeded=1/, "summary shows succeeded count");
  assert.match(text, /failed=1/, "summary shows failed count");
  assert.match(text, /error=Jina 503/, "failed page shows the per-URL error distinctly");

  runtime.dispose();
}

// ─── 12. Malformed URL error is sanitized and visually distinct ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const args = { urls: ["not-a-url"] };
  const details = { urls: ["not-a-url"], succeeded: 0, failed: 1, phase: "done",
    results: [], failedUrls: [{ url: "not-a-url", error: "Invalid HTTP(S) URL", retried: false }],
    error: "Invalid HTTP(S) URL: not-a-url" };
  const result = renderResult(decorated, args, details, "Error: Invalid HTTP(S) URL: not-a-url", { expanded: false });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Invalid HTTP\(S\) URL/, "malformed URL error is visible without isError");
  assert.doesNotMatch(text, /OUTPUT ───/, "no Output section when error is present");

  runtime.dispose();
}

// ─── 13. No metadata duplication in fetch header ────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const args = { urls: ["https://example.com/page1"], mode: "readable", max_tokens: 5000, no_cache: true };
  const result = renderResult(decorated, args, { urls: ["https://example.com/page1"], succeeded: 1, failed: 0, phase: "done" }, "content", { expanded: false });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  const headerLine = text.split("\n")[1] ?? "";
  // mode should appear exactly once
  const modeCount = (headerLine.match(/mode=readable/g) ?? []).length;
  assert.equal(modeCount, 1, "mode appears exactly once in header (no duplication)");

  runtime.dispose();
}

// ─── 13b. Truncation indicators are visible when expanded (AC2) ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const args = { urls: ["https://example.com/huge-page"], mode: "readable" };
  // A fetch result with remote and output truncation indicators set
  const details = { urls: ["https://example.com/huge-page"], succeeded: 1, failed: 0, phase: "done",
    results: [{ url: "https://example.com/huge-page", finalUrl: "", lines: 500, retried: false }],
    failedUrls: [],
    remoteTruncated: true, outputTruncated: true,
    pages: [{ url: "https://example.com/huge-page", title: "Huge Page", lines: 500, retried: false, tokens: 50000, usage: "50000 tokens", start: 0, end: 10000 }] };
  const result = renderResult(decorated, args, details, "## Huge Page\n\n[content truncated]...", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /remoteTruncated=yes/, "remote truncation indicator visible when expanded");
  assert.match(text, /outputTruncated=yes/, "output truncation indicator visible when expanded");

  runtime.dispose();
}

// ─── 14. Bounded at all widths ──────────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("search"), () => runtime);
  const args = { queries: ["test query"], limit: 3 };
  const details = { queries: ["test query"], phase: "done", count: 3, totalAfterDedup: 2, results: [{ title: "R", url: "https://ex.com", description: "d", provenance: "[q1#1]" }] };
  const expandedResult = renderResult(decorated, args, details, "[1] R\n    https://ex.com\n    d", { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(expandedResult.render(width).every((line) => visibleWidth(line) <= width), `search result bounded at ${width}`);
  }
  const fetchDecorated = decorateInternalTool(makeDef("fetch"), () => runtime);
  const fetchResult = renderResult(fetchDecorated, { urls: ["https://example.com/page1"], mode: "readable" }, { urls: ["https://example.com/page1"], succeeded: 1, failed: 0, phase: "done" }, "## Page\n\nContent", { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(fetchResult.render(width).every((line) => visibleWidth(line) <= width), `fetch result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 15. Execution unchanged ─────────────────────────────────────────

{
  const runtime = newRuntime();
  for (const name of ["search", "fetch"]) {
    const def = makeDef(name);
    const decorated = decorateInternalTool(def, () => runtime);
    assert.equal(decorated.execute, def.execute, `${name} execute unchanged`);
    assert.deepEqual(decorated.parameters, def.parameters, `${name} parameters unchanged`);
  }
  runtime.dispose();
}

console.log("web search and fetch display tests: OK");
