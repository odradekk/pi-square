import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

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
    environment: { isTTY: true },
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

const baseDetails = {
  version: 1,
  phase: "done",
  status: "success",
  path: "doc.pdf",
  pages: [1, 3, 4, 5, 10],
  normalizedPages: "1, 3-5, 10",
  pageCount: 5,
  sourceTotalPages: 20,
  mode: "auto",
  timeoutMs: 30000,
  maxTokens: 12000,
  sourceBytes: 1024000,
  uploadBytes: 256000,
  outputLines: 150,
  estimatedTokens: 4800,
};

// ═══════════════════════════════════════════════════════════════════

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
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  assert.equal(decorated.renderShell, "self", "parse uses self render shell");

  const args = { path: "doc.pdf", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^–/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^○/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^⠋/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "content" }], details: { ...baseDetails } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^✓/, "completed renders check mark");

  runtime.dispose();
}

// ─── 2. Title retains document identity, no metadata duplication ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1, 3-5, 10", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /PDF parse/, "call shows PDF parse title");
  assert.match(text, /doc\.pdf/, "call target shows document path");
  assert.match(text, /pages=1, 3-5, 10/, "metadata shows page selection");
  assert.match(text, /mode=auto/, "metadata shows parser mode");
  assert.match(text, /timeout=30000/, "metadata shows timeout");
  assert.match(text, /maxTokens=12000/, "metadata shows maxTokens");
  assert.doesNotMatch(text, /max_tokens=12000/, "raw max_tokens label suppressed");

  runtime.dispose();
}

// ─── 3. Success result shows uploaded size and token budget in summary ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1, 3-5, 10", mode: "auto", timeout: 30000, max_tokens: 12000 };
  // Use expanded to see the Summary section
  const result = renderResult(decorated, args, { ...baseDetails }, "# Parsed PDF\n\ncontent", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /SUMMARY/, "expanded shows Summary section");
  assert.match(text, /uploaded=250\.0 KB/, "summary shows uploaded size (privacy: data left workspace)");
  assert.match(text, /tokens=4800\/12000/, "summary shows consumed token budget");
  assert.match(text, /pageCount=5/, "summary shows page count");

  runtime.dispose();
}

// ─── 4. Declined renders aborted marker (×), not success (✓) ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails, status: "declined", pages: [1], normalizedPages: "1", pageCount: 1, sourceTotalPages: 10, sourceBytes: 512000, uploadBytes: undefined, estimatedTokens: undefined, outputLines: undefined };
  const result = renderResult(decorated, args, details, "PDF upload declined by the user.");
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^×/, "declined renders aborted marker (×), not success");
  assert.match(text, /declined/i, "declined message visible");

  runtime.dispose();
}

// ─── 5. Aborted (with isError) renders aborted marker (×), not failed ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails, status: "aborted", pages: [1], normalizedPages: "1", pageCount: 1, sourceTotalPages: 10, sourceBytes: 512000, uploadBytes: undefined, estimatedTokens: undefined, outputLines: undefined, errorCode: "ABORTED", error: "PDF parse was cancelled" };
  // isError:true is what the tool actually returns for aborted via failure()
  const result = renderResult(decorated, args, details, "Error: PDF parse was cancelled", { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^×/, "aborted renders aborted marker (×) despite isError:true");

  runtime.dispose();
}

// ─── 6. Error states are distinct and sanitized ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "locked.pdf", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails, status: "error", path: "locked.pdf", pages: [1], normalizedPages: "1", pageCount: 1, sourceTotalPages: 10, sourceBytes: 512000, uploadBytes: undefined, estimatedTokens: undefined, outputLines: undefined, errorCode: "PDF_ENCRYPTED", error: "The PDF is encrypted. Set an owner or user password." };
  const result = renderResult(decorated, args, details, "Error: The PDF is encrypted.", { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✗/, "error renders failed marker (✗)");
  assert.match(text, /encrypted/i, "error message visible");
  assert.match(text, /code=PDF_ENCRYPTED/, "error code visible in metadata");
  assert.doesNotMatch(text, /fc-[A-Za-z0-9_-]+/, "no API key pattern in output");

  runtime.dispose();
}

// ─── 7. Oversized PDF error is distinct ─────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "huge.pdf", pages: "1-100", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails, status: "error", path: "huge.pdf", pages: Array.from({ length: 100 }, (_, i) => i + 1), normalizedPages: "1-100", pageCount: 100, sourceTotalPages: 100, mode: "auto", timeoutMs: 30000, maxTokens: 12000, sourceBytes: 60000000, uploadBytes: undefined, estimatedTokens: undefined, outputLines: undefined, errorCode: "PDF_OVERSIZE", error: "PDF exceeds 50 MB limit (57.2 MB)" };
  const result = renderResult(decorated, args, details, "Error: PDF exceeds 50 MB limit", { isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^✗/, "oversized renders failed marker");
  assert.match(text, /PDF exceeds 50 MB limit/, "oversized error message visible");

  runtime.dispose();
}

// ─── 8. Out-of-workspace error is distinct ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "../../../etc/passwd", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails, status: "error", path: "../../../etc/passwd", pages: [1], normalizedPages: "1", pageCount: 1, sourceTotalPages: 1, sourceBytes: undefined, uploadBytes: undefined, estimatedTokens: undefined, outputLines: undefined, errorCode: "PATH_OUTSIDE_WORKSPACE", error: "Path resolves outside the workspace" };
  const result = renderResult(decorated, args, details, "Error: Path resolves outside the workspace", { isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^✗/, "out-of-workspace renders failed marker");
  assert.match(text, /outside the workspace/, "out-of-workspace error visible");

  runtime.dispose();
}

// ─── 9. Model-output truncation is explicit ─────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "big.pdf", pages: "1-50", mode: "auto", timeout: 60000, max_tokens: 500 };
  const details = { ...baseDetails, status: "success", path: "big.pdf", pages: Array.from({ length: 50 }, (_, i) => i + 1), normalizedPages: "1-50", pageCount: 50, sourceTotalPages: 50, mode: "auto", timeoutMs: 60000, maxTokens: 500, sourceBytes: 5000000, uploadBytes: 4000000, outputLines: 5, estimatedTokens: 500, truncated: true, metadata: { title: "Big Doc", numPages: 50 } };
  // Collapsed
  const collapsedResult = renderResult(decorated, args, details, "# Parsed PDF\n\n[truncated]");
  const collapsedText = stripVTControlCharacters(collapsedResult.render(100).join("\n"));
  assert.match(collapsedText, /^✓/, "truncated result renders completed (operation succeeded)");
  // Expanded — truncation indicator should be reachable
  const expandedResult = renderResult(decorated, args, details, "# Parsed PDF", { expanded: true });
  const expandedText = stripVTControlCharacters(expandedResult.render(100).join("\n"));
  assert.match(expandedText, /truncated=yes/, "expanded summary shows truncation indicator");
  assert.match(expandedText, /uploaded=3\.8 MB/, "expanded summary shows uploaded size");

  runtime.dispose();
}

// ─── 10. No API key or confirmation internals leak into content ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  // Simulate a result with a redacted API key pattern
  const details = { ...baseDetails, status: "error", pages: [1], normalizedPages: "1", pageCount: 1, sourceTotalPages: 10, sourceBytes: 512000, uploadBytes: undefined, estimatedTokens: undefined, outputLines: undefined, errorCode: "FIRECRAWL_HTTP_401", error: "Firecrawl 401: Unauthorized" };
  const result = renderResult(decorated, args, details, "Error: Firecrawl 401: Unauthorized", { isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(text, /fc-[A-Za-z0-9_-]+/, "no API key pattern in rendered output");
  assert.doesNotMatch(text, /FIRECRAWL_API_KEY/, "no env var name in rendered output");
  assert.doesNotMatch(text, /authorization/i, "no auth header in rendered output");

  runtime.dispose();
}

// ─── 11. No remote payload or unrequested pages leak into header ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1", mode: "auto", timeout: 30000, max_tokens: 12000 };
  // The result text contains content from pages 1-10 (simulating a provider
  // returning more than requested), but only page 1 was requested
  const details = { ...baseDetails, pages: [1], normalizedPages: "1", pageCount: 1, sourceTotalPages: 10 };
  const result = renderResult(decorated, args, details, "SECRET_REMOTE_PAGE_CONTENT_FROM_PAGES_2_TO_10");
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // The header line should show pages=1 (only the requested page)
  const headerLine = text.split("\n")[1] ?? "";
  assert.match(headerLine, /pages=1/, "header shows only requested page selection");
  assert.doesNotMatch(headerLine, /SECRET_REMOTE_PAGE_CONTENT/, "remote payload does not leak into activity header");

  runtime.dispose();
}

// ─── 12. Incomplete result (fewer pages returned) is visible ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1-5", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails, status: "success", pages: [1, 2, 3, 4, 5], normalizedPages: "1-5", pageCount: 5, sourceTotalPages: 10, incomplete: true, metadata: { title: "Doc", numPages: 3 } };
  const result = renderResult(decorated, args, details, "# Parsed PDF", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /incomplete=yes/, "expanded summary shows incomplete indicator");

  runtime.dispose();
}

// ─── 13. Collapsed/expanded bounds at all widths ────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("parse"), () => runtime);
  const args = { path: "doc.pdf", pages: "1, 3-5, 10", mode: "auto", timeout: 30000, max_tokens: 12000 };
  const details = { ...baseDetails };
  for (const expanded of [false, true]) {
    const result = renderResult(decorated, args, details, "# Parsed PDF\n\nContent", { expanded });
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `parse ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
    }
  }

  runtime.dispose();
}

// ─── 14. Execution unchanged ────────────────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef("parse");
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "parameters unchanged");

  runtime.dispose();
}

console.log("Firecrawl parse display tests: OK");
