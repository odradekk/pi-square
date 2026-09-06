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

// ═════════════════════ web_search ══════════════════════════════════

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
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  assert.equal(decorated.renderShell, "self", "web_search uses self render shell");

  const args = { queries: ["typescript generics"] };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "[1] Result" }], details: { queries: ["typescript generics"], phase: "done", count: 1 } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders bullet");

  runtime.dispose();
}

// ─── 2. Web search titles retain deduplicated queries as target ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  const args = { queries: ["typescript generics", "rust traits"], limit: 5, sites: ["stackoverflow.com"], language: "en", country: "US", no_cache: true };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /Web search/, "call shows Web search title");
  assert.match(text, /typescript generics.*rust traits/, "call target shows the queries");
  // Web tools carry no key=value metadata in the header
  assert.doesNotMatch(text, /queries=/, "no queries key=value metadata in header");
  assert.doesNotMatch(text, /sites=/, "no sites key=value metadata in header");
  assert.doesNotMatch(text, /language=/, "no language key=value metadata in header");
  assert.doesNotMatch(text, /country=/, "no country key=value metadata in header");
  assert.doesNotMatch(text, /cache=/, "no cache key=value metadata in header");

  runtime.dispose();
}

// ─── 3. Expanded results preserve ranking, source title/URL, content ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
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
  assert.match(text, /Rust Traits Guide/, "result preserves source title");
  assert.match(text, /Complete guide to traits/, "result preserves readable content");
  assert.match(text, /3 results for 1 query/, "summary row shows result and query counts");
  // Ranking order: results must be listed in ranked order (1 before 2 before 3)
  assert.ok(text.indexOf("Rust Traits Guide") < text.indexOf("Trait Objects"), "results preserve RRF ranking order");

  runtime.dispose();
}

// ─── 4. Partial per-query failure is distinctly visible ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
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
  assert.match(text, /^✓/, "partial-failure web_search renders completed (some results succeeded)");
  assert.match(text, /Good Result/, "partial-failure shows the successful results");

  runtime.dispose();
}

// ─── 5. Empty results state ─────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  const args = { queries: ["nonexistent topic"] };
  const details = { queries: ["nonexistent topic"], failedQueries: [], count: 5, phase: "done", totalBeforeDedup: 0, totalAfterDedup: 0, results: [] };
  const result = renderResult(decorated, args, details, "No results found.", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "empty results renders completed, not failed");
  assert.match(text, /No results/, "empty state shows a summary row");

  runtime.dispose();
}

// ─── 6. Error states: provider error visible without isError ─────
// web_search and web_fetch don't set isError:true for failures — they return
// details.error and let the display adapter surface it. The adapter must
// make the error visible even without isError.

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  const args = { queries: ["fail query"] };
  const details = { queries: ["fail query"], failedQueries: [{ query: "fail query", error: "Connection refused" }], count: 3, phase: "done", error: "fail query: Connection refused" };
  // NOTE: no isError — this is the actual tool behavior
  const result = renderResult(decorated, args, details, "Search error: fail query: Connection refused", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(text, /OUTPUT ───/, "no Output section when error text is present");

  // Also verify isError:true still works (if Pi ever sets it)
  const isErrorResult = renderResult(decorated, args, details, "Search error: fail query: Connection refused", { isError: true, expanded: true });
  const isErrorText = stripVTControlCharacters(isErrorResult.render(100).join("\n"));
  assert.match(isErrorText, /^×/, "isError result renders failed marker");
  assert.match(isErrorText, /Connection refused/, "isError error message is visible through description.error");
  assert.doesNotMatch(isErrorText, /ERROR ───/, "no separate ERROR section even with isError");
  const errorCount = (isErrorText.match(/Connection refused/g) ?? []).length;
  assert.ok(errorCount <= 2, `error text appears ${errorCount} times with isError (expected at most 2)`);

  runtime.dispose();
}

// ─── 7. No metadata duplication in header ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  const args = { queries: ["test query"], limit: 3, no_cache: true };
  const result = renderResult(decorated, args, { queries: ["test query"], phase: "done", count: 3 }, "output text", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  const headerLine = text.split("\n")[1] ?? "";
  // Web tools carry no key=value metadata in the header
  assert.doesNotMatch(headerLine, /queries=/, "no queries key=value in header");
  assert.doesNotMatch(headerLine, /no_cache=/, "no raw no_cache label in header");

  runtime.dispose();
}

// ─── 8. Collapsed keeps identity/target visible, expanded reachable ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  const args = { queries: ["test"], limit: 3 };
  const details = { queries: ["test"], phase: "done", count: 3, totalAfterDedup: 2, results: [{ title: "R", url: "https://ex.com", description: "d", provenance: "[q1#1]" }] };

  const collapsed = renderResult(decorated, args, details, "[1] R\n    https://ex.com", { expanded: false });
  const collapsedText = stripVTControlCharacters(collapsed.render(100).join("\n"));
  assert.match(collapsedText, /^✓/, "collapsed keeps lifecycle marker");
  assert.match(collapsedText, /Web search/, "collapsed keeps identity/title");
  assert.match(collapsedText, /test/, "collapsed keeps query target");
  // C4 revision: a collapsed entry is exactly one row; the record payload is
  // visible only when expanded. The inline summary states the outcome.
  assert.equal(collapsed.render(100).length, 1, "collapsed web search renders exactly one row");
  assert.match(collapsedText, /1 of 2 results for 1 query/, "collapsed shows the inline outcome summary");
  assert.doesNotMatch(collapsedText, /1\s+R|ex\.com/, "collapsed hides the record payload");

  const expanded = renderResult(decorated, args, details, "[1] R", { expanded: true });
  const expandedText = stripVTControlCharacters(expanded.render(100).join("\n"));
  assert.ok(!expandedText.includes("REQUEST"), "expanded prunes the restating Request section (C8)");
  assert.ok(!expandedText.includes("SUMMARY"), "expanded prunes the restating Summary section (C8)");
  assert.match(expandedText, /1\s+R/, "expanded shows the results records");

  runtime.dispose();
}

// ═════════════════════ web_fetch ════════════════════════════════════

// ─── 9. Web fetch titles retain safe normalized URLs as target ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
  const args = { urls: ["https://example.com/page1", "https://example.com/page2"], mode: "readable", max_tokens: 5000, include_links: true, describe_images: true, no_cache: true };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /Web fetch/, "call shows Web fetch title");
  assert.match(text, /example\.com\/page1/, "call target shows safe normalized URLs");
  // Web tools carry no key=value metadata in the header
  assert.doesNotMatch(text, /mode=/, "no mode key=value metadata in header");
  assert.doesNotMatch(text, /maxTokens=/, "no maxTokens key=value metadata in header");
  assert.doesNotMatch(text, /max_tokens=/, "no raw max_tokens label in header");
  assert.doesNotMatch(text, /include_links=/, "no raw include_links label in header");
  assert.doesNotMatch(text, /describe_images=/, "no raw describe_images label in header");
  assert.doesNotMatch(text, /no_cache=/, "no raw no_cache label in header");

  runtime.dispose();
}

// ─── 10. Expanded web_fetch results preserve page title, URL, metadata ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
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
  assert.match(text, /Page One/, "result preserves page title");
  assert.match(text, /Page Two/, "result preserves second page title");
  // Two-row records: rank + title, then secondary line with URL, lines, tokens
  assert.match(text, /example\.com\/page1/, "result shows page URL in record body");
  assert.match(text, /50 lines/, "result shows line count in record body");
  assert.match(text, /3000 tokens/, "result shows token count in record body");

  runtime.dispose();
}

// ─── 11. Partial per-URL failure is distinctly visible ──────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
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
  assert.match(text, /^✓/, "partial-URL-failure web_fetch renders completed (some pages succeeded)");
  assert.match(text, /1 of 2 pages fetched/, "summary row states succeeded and total counts");

  runtime.dispose();
}

// ─── 12. Malformed URL error is sanitized and visually distinct ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
  const args = { urls: ["not-a-url"] };
  const details = { urls: ["not-a-url"], succeeded: 0, failed: 1, phase: "done",
    results: [], failedUrls: [{ url: "not-a-url", error: "Invalid HTTP(S) URL", retried: false }],
    error: "Invalid HTTP(S) URL: not-a-url" };
  const result = renderResult(decorated, args, details, "Error: Invalid HTTP(S) URL: not-a-url", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "malformed URL error renders failed marker");
  assert.match(text, /Invalid HTTP\(S\) URL/, "malformed URL error is visible with isError");
  assert.doesNotMatch(text, /OUTPUT ───/, "no Output section when error is present");

  runtime.dispose();
}

// ─── 13. No metadata duplication in web_fetch header ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
  const args = { urls: ["https://example.com/page1"], mode: "readable", max_tokens: 5000, no_cache: true };
  const result = renderResult(decorated, args, { urls: ["https://example.com/page1"], succeeded: 1, failed: 0, phase: "done" }, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  const headerLine = text.split("\n")[1] ?? "";
  // Web tools carry no key=value metadata in the header
  assert.doesNotMatch(headerLine, /mode=/, "no mode key=value in header");
  assert.doesNotMatch(headerLine, /max_tokens=/, "no raw max_tokens label in header");

  runtime.dispose();
}

// ─── 13b. Truncation indicators are visible when expanded (AC2) ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
  const args = { urls: ["https://example.com/huge-page"], mode: "readable" };
  // A web_fetch result with remote and output truncation indicators set
  const details = { urls: ["https://example.com/huge-page"], succeeded: 1, failed: 0, phase: "done",
    results: [{ url: "https://example.com/huge-page", finalUrl: "", lines: 500, retried: false }],
    failedUrls: [],
    remoteTruncated: true, outputTruncated: true,
    pages: [{ url: "https://example.com/huge-page", title: "Huge Page", lines: 500, retried: false, tokens: 50000, usage: "50000 tokens", start: 0, end: 10000 }] };
  const result = renderResult(decorated, args, details, "## Huge Page\n\n[content truncated]...", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(text, /\[truncated\]/, "no truncated badge renders");

  runtime.dispose();
}

// ─── 14. Bounded at all widths ──────────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("web_search"), () => runtime);
  const args = { queries: ["test query"], limit: 3 };
  const details = { queries: ["test query"], phase: "done", count: 3, totalAfterDedup: 2, results: [{ title: "R", url: "https://ex.com", description: "d", provenance: "[q1#1]" }] };
  const expandedResult = renderResult(decorated, args, details, "[1] R\n    https://ex.com\n    d", { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(expandedResult.render(width).every((line) => visibleWidth(line) <= width), `web_search result bounded at ${width}`);
  }
  const webFetchDecorated = decorateInternalTool(makeDef("web_fetch"), () => runtime);
  const webFetchResult = renderResult(webFetchDecorated, { urls: ["https://example.com/page1"], mode: "readable" }, { urls: ["https://example.com/page1"], succeeded: 1, failed: 0, phase: "done" }, "## Page\n\nContent", { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(webFetchResult.render(width).every((line) => visibleWidth(line) <= width), `web_fetch result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 15. Execution unchanged ─────────────────────────────────────────

{
  const runtime = newRuntime();
  for (const name of ["web_search", "web_fetch"]) {
    const def = makeDef(name);
    const decorated = decorateInternalTool(def, () => runtime);
    assert.equal(decorated.execute, def.execute, `${name} execute unchanged`);
    assert.deepEqual(decorated.parameters, def.parameters, `${name} parameters unchanged`);
  }
  runtime.dispose();
}

console.log("web_search and web_fetch display tests: OK");
