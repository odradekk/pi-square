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

// ═══════════════════════ LIBS ═══════════════════════════════════════

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
  const decorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  assert.equal(decorated.renderShell, "self", "libs uses self render shell");

  const args = { libraryName: "react", query: "context provider" };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "[1] React" }], details: { libraryName: "react", query: "context provider", status: "ready", mode: "quality", limit: 5, candidates: [], counts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 }, phase: "done" } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders bullet");

  runtime.dispose();
}

// ─── 2. Libs title retains library name, no metadata duplication ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  const args = { libraryName: "react", query: "how to create a context provider", mode: "quality", limit: 5 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /Library search/, "call shows Library search title");
  assert.match(text, /\breact\b/, "call target shows library name");
  // Web tools carry no key=value metadata in the header
  assert.doesNotMatch(text, /library=/, "no library key=value metadata in header");
  assert.doesNotMatch(text, /libraryName=/, "no raw libraryName label in header");

  runtime.dispose();
}

// ─── 3. Libs expanded results preserve ranking, IDs, metadata ───────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  const args = { libraryName: "react", query: "context", mode: "quality", limit: 5 };
  const details = {
    libraryName: "react", query: "context", status: "ready", mode: "quality", limit: 5,
    searchFilterApplied: true, total: 4,
    candidates: [
      { rank: 1, id: "/facebook/react", title: "React", description: "The library for web and native UIs", stars: 234000, totalSnippets: 5000, trustScore: 99, lastUpdateDate: "2024-12-01" },
      { rank: 2, id: "/vercel/next.js", title: "Next.js", description: "The React framework", stars: 130000 },
    ],
    counts: { received: 8, invalid: 1, eligible: 7, returned: 5, oversized: 0, omitted: 2 },
    phase: "done",
  };
  const result = renderResult(decorated, args, details, "[1] React\n    /facebook/react", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /\/facebook\/react/, "expanded preserves exact library ID");
  // Two-row records: rank + title with ID, then metrics line muted
  assert.match(text, /1\s+React/, "expanded shows ranked record title");
  assert.match(text, /234k stars/, "expanded shows star count in record body");
  // Ranking order: first candidate before second
  assert.ok(text.indexOf("/facebook/react") < text.indexOf("/vercel/next.js"), "expanded preserves ranking order");
  assert.match(text, /4 candidates/, "summary row shows total candidate count");
  assert.match(text, /2 omitted/, "summary row shows omitted count");

  runtime.dispose();
}

// ─── 4. Libs empty results state ────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  const args = { libraryName: "nonexistent", query: "test", mode: "quality", limit: 5 };
  const details = { libraryName: "nonexistent", query: "test", status: "ready", mode: "quality", limit: 5, candidates: [], counts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 }, phase: "done" };
  const result = renderResult(decorated, args, details, "No libraries found.", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "empty results renders completed");
  assert.match(text, /No candidates for nonexistent/, "empty state shows summary row");

  runtime.dispose();
}

// ─── 5. Libs error visible without isError (actual tool behavior) ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  const args = { libraryName: "react", query: "test", mode: "quality", limit: 5 };
  const details = { libraryName: "react", query: "test", status: "error", mode: "quality", limit: 5, candidates: [], counts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 }, phase: "done", error: "Missing CONTEXT7_API_KEY" };
  // NOTE: no isError — these tools use details.status="error" + details.error
  const result = renderResult(decorated, args, details, "Error: Missing CONTEXT7_API_KEY", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "error renders failed marker (status=error → error status)");

  runtime.dispose();
}

// ─── 6. Libs pending with retry hint ────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  const args = { libraryName: "react", query: "test", mode: "quality", limit: 5 };
  const details = { libraryName: "react", query: "test", status: "pending", mode: "quality", limit: 5, candidates: [], counts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 }, phase: "done", retryAfter: 30 };
  const result = renderResult(decorated, args, details, "Library search pending. Retry in 30s.", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "pending renders completed lifecycle");

  runtime.dispose();
}

// ═══════════════════════ DOCS ═══════════════════════════════════════

// ─── 7. Lifecycle markers through production decoration path ─────────

{
  const clock = {
    callbacks: new Map(),
    next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); },
    unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);

  const args = { libraryId: "/facebook/react", query: "useState", mode: "quality", kind: "all", max_tokens: 12000 };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: queued }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  runtime.dispose();
}

// ─── 8. Docs title retains library ID, no metadata duplication ──────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "/facebook/react", query: "how to use useState", mode: "quality", kind: "all", max_tokens: 12000 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /Library docs/, "call shows Library docs title");
  assert.match(text, /\/facebook\/react/, "call target shows library ID");
  // Web tools carry no key=value metadata in the header
  assert.doesNotMatch(text, /library=/, "no library key=value metadata in header");
  assert.doesNotMatch(text, /libraryId=/, "no raw libraryId label in header");
  assert.doesNotMatch(text, /maxTokens=/, "no maxTokens key=value metadata in header");
  assert.doesNotMatch(text, /max_tokens=/, "no raw max_tokens label in header");
  assert.doesNotMatch(text, /mode=/, "no mode key=value metadata in header");
  assert.doesNotMatch(text, /kind=/, "no kind key=value metadata in header");

  runtime.dispose();
}

// ─── 9. Docs expanded preserves code snippets, provenance, tokens ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "/facebook/react", query: "how to use useState", mode: "quality", kind: "code", max_tokens: 12000 };
  const details = {
    libraryId: "/facebook/react", finalLibraryId: "/facebook/react", query: "...", status: "ready", redirected: false,
    kind: "code", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [
      { title: "Basic useState", language: "tsx", source: "https://react.dev/reference/react/useState", pageTitle: "Hooks API", tokens: 120,
        codeList: [{ language: "tsx", code: "const [count, setCount] = useState(0);" }] },
    ],
    infoSnippets: [],
    codeCounts: { received: 3, invalid: 0, eligible: 3, returned: 1, oversized: 0, omitted: 2 },
    infoCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    estimatedTokens: 120, phase: "done",
  };
  const result = renderResult(decorated, args, details, "### Basic useState\n\n```tsx\nconst [count, setCount] = useState(0);\n```", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Basic useState/, "code snippet preserves title");
  // Two-row record: rank + title, then secondary line with language and tokens
  assert.match(text, /tsx/, "code snippet shows language in record body");
  assert.match(text, /120 tokens/, "code snippet shows token count in record body");
  // Expanded Sources section shows the provenance path
  assert.match(text, /reference\/react\/useState/, "expanded Sources section shows snippet source path");

  runtime.dispose();
}

// ─── 10. Docs expanded preserves info snippets, breadcrumb ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "/facebook/react", query: "useState", mode: "quality", kind: "info", max_tokens: 12000 };
  const details = {
    libraryId: "/facebook/react", finalLibraryId: "/facebook/react", query: "...", status: "ready", redirected: false,
    kind: "info", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [],
    infoSnippets: [
      { content: "useState is a React Hook that lets you add a state variable.", source: "https://react.dev/reference/react/useState", breadcrumb: "Reference > Hooks > useState", tokens: 80 },
    ],
    codeCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    infoCounts: { received: 2, invalid: 0, eligible: 2, returned: 1, oversized: 0, omitted: 1 },
    estimatedTokens: 80, phase: "done",
  };
  const result = renderResult(decorated, args, details, "### Reference > Hooks > useState\n\nuseState is a React Hook...", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Reference > Hooks > useState/, "info snippet preserves breadcrumb as title");
  // Expanded Sources section shows the provenance path
  assert.match(text, /reference\/react\/useState/, "expanded Sources section shows info snippet source path");

  runtime.dispose();
}

// ─── 11. Docs summary shows token budget and code/info counts ───────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "/facebook/react", query: "useState", mode: "quality", kind: "all", max_tokens: 12000 };
  const details = {
    libraryId: "/facebook/react", finalLibraryId: "/facebook/react", query: "...", status: "ready", redirected: false,
    kind: "all", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [{ title: "t", tokens: 120, codeList: [{ code: "x" }] }],
    infoSnippets: [{ content: "doc", tokens: 80 }],
    codeCounts: { received: 3, invalid: 1, eligible: 2, returned: 1, oversized: 1, omitted: 1 },
    infoCounts: { received: 2, invalid: 1, eligible: 1, returned: 1, oversized: 1, omitted: 0 },
    estimatedTokens: 200, phase: "done",
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  // Wide-tier column so the full summary fits beside the natural title.
  const text = stripVTControlCharacters(result.render(160).join("\n"));
  // Summary row shows snippet counts, token budget, and omitted count
  assert.match(text, /1 code and 1 info snippets/, "summary shows code and info snippet counts");
  assert.match(text, /200 of 12000 tokens/, "summary shows token budget");
  assert.match(text, /1 omitted/, "summary shows omitted count");

  runtime.dispose();
}

// ─── 12. Docs redirect is distinctly visible ────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "/old/react", query: "test", mode: "quality", kind: "all", max_tokens: 12000 };
  const details = {
    libraryId: "/old/react", finalLibraryId: "/facebook/react", query: "test", status: "ready",
    redirected: true, kind: "all", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [], infoSnippets: [{ content: "doc", source: "https://ex.com", breadcrumb: "Info", tokens: 10 }],
    codeCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    infoCounts: { received: 1, invalid: 0, eligible: 1, returned: 1, oversized: 0, omitted: 0 },
    estimatedTokens: 10, phase: "done",
  };
  const result = renderResult(decorated, args, details, "doc content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Info/, "docs content visible after redirect");

  runtime.dispose();
}

// ─── 13. Docs error (invalid libraryId) is distinct ─────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "bad-id", query: "test", mode: "quality", kind: "all", max_tokens: 12000 };
  const details = {
    libraryId: "bad-id", finalLibraryId: "bad-id", query: "test", status: "error", redirected: false,
    kind: "all", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [], infoSnippets: [],
    codeCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    infoCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    estimatedTokens: 0, phase: "done", error: "Invalid libraryId: must match pattern",
  };
  const result = renderResult(decorated, args, details, "Error: Invalid libraryId", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "invalid libraryId renders failed marker");

  runtime.dispose();
}

// ─── 14. Docs pending with retry hint ───────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const args = { libraryId: "/facebook/react", query: "test", mode: "quality", kind: "all", max_tokens: 12000 };
  const details = {
    libraryId: "/facebook/react", finalLibraryId: "/facebook/react", query: "test", status: "pending", redirected: false,
    kind: "all", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [], infoSnippets: [],
    codeCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    infoCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    estimatedTokens: 0, phase: "done", retryAfter: 30,
  };
  const result = renderResult(decorated, args, details, "Documentation pending (library not finalized). Retry in 30s.", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^✓/, "pending renders completed lifecycle");

  runtime.dispose();
}

// ─── 15. No result content or arbitrary payload leaks into activity ─

{
  const runtime = newRuntime();
  // Libs: the activity summary should NOT contain the candidate
  // descriptions or arbitrary remote metadata in the header line
  const libsDecorated = decorateInternalTool(makeDef("library_search"), () => runtime);
  const libsArgs = { libraryName: "react", query: "context", mode: "quality", limit: 5 };
  const libsDetails = {
    libraryName: "react", query: "context", status: "ready", mode: "quality", limit: 5,
    candidates: [
      { rank: 1, id: "/facebook/react", title: "React", description: "SECRET_DESCRIPTION_THAT_SHOULD_NOT_LEAK" },
    ],
    counts: { received: 1, invalid: 0, eligible: 1, returned: 1, oversized: 0, omitted: 0 },
    phase: "done",
  };
  const libsResult = renderResult(libsDecorated, libsArgs, libsDetails, "SECRET_DESCRIPTION_THAT_SHOULD_NOT_LEAK", { expanded: false });
  const libsText = stripVTControlCharacters(libsResult.render(100).join("\n"));
  // Header line (line 2) should NOT contain the description
  const libsHeaderLine = libsText.split("\n")[1] ?? "";
  assert.doesNotMatch(libsHeaderLine, /SECRET_DESCRIPTION/, "candidate description does not leak into activity header");

  // Docs: code snippet bodies should not leak into header
  const docsDecorated = decorateInternalTool(makeDef("library_docs"), () => runtime);
  const docsArgs = { libraryId: "/facebook/react", query: "test", mode: "quality", kind: "all", max_tokens: 12000 };
  const docsDetails = {
    libraryId: "/facebook/react", finalLibraryId: "/facebook/react", query: "test", status: "ready", redirected: false,
    kind: "all", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false,
    codeSnippets: [{ title: "t", tokens: 10, codeList: [{ code: "SECRET_CODE_BODY" }] }],
    infoSnippets: [], codeCounts: { received: 1, invalid: 0, eligible: 1, returned: 1, oversized: 0, omitted: 0 },
    infoCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 },
    estimatedTokens: 10, phase: "done",
  };
  const docsResult = renderResult(docsDecorated, docsArgs, docsDetails, "SECRET_CODE_BODY", { expanded: false });
  const docsText = stripVTControlCharacters(docsResult.render(100).join("\n"));
  const docsHeaderLine = docsText.split("\n")[1] ?? "";
  assert.doesNotMatch(docsHeaderLine, /SECRET_CODE_BODY/, "code snippet body does not leak into activity header");

  runtime.dispose();
}

// ─── 16. Collapsed/expanded bounds at all widths ────────────────────

{
  const runtime = newRuntime();
  for (const [name, args, details, text] of [
    ["library_search",
      { libraryName: "react", query: "context provider", mode: "quality", limit: 5 },
      { libraryName: "react", query: "...", status: "ready", mode: "quality", limit: 5, candidates: [{ rank: 1, id: "/facebook/react", title: "React", description: "UI lib" }], counts: { received: 1, invalid: 0, eligible: 1, returned: 1, oversized: 0, omitted: 0 }, phase: "done" },
      "[1] React\n    /facebook/react"],
    ["library_docs",
      { libraryId: "/facebook/react", query: "useState", mode: "quality", kind: "all", max_tokens: 12000 },
      { libraryId: "/facebook/react", finalLibraryId: "/facebook/react", query: "...", status: "ready", redirected: false, kind: "all", mode: "quality", maxTokens: 12000, rules: null, rulesOmitted: false, codeSnippets: [{ title: "t", tokens: 10, codeList: [{ code: "x" }] }], infoSnippets: [], codeCounts: { received: 1, invalid: 0, eligible: 1, returned: 1, oversized: 0, omitted: 0 }, infoCounts: { received: 0, invalid: 0, eligible: 0, returned: 0, oversized: 0, omitted: 0 }, estimatedTokens: 10, phase: "done" },
      "content"],
  ]) {
    const decorated = decorateInternalTool(makeDef(name), () => runtime);
    const expanded = renderResult(decorated, args, details, text, { expanded: true });
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width), `${name} expanded bounded at ${width}`);
    }
    const collapsed = renderResult(decorated, args, details, text, { expanded: false });
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      assert.ok(collapsed.render(width).every((line) => visibleWidth(line) <= width), `${name} collapsed bounded at ${width}`);
    }
  }
  runtime.dispose();
}

// ─── 17. Execution unchanged ────────────────────────────────────────

{
  const runtime = newRuntime();
  for (const name of ["library_search", "library_docs"]) {
    const def = makeDef(name);
    const decorated = decorateInternalTool(def, () => runtime);
    assert.equal(decorated.execute, def.execute, `${name} execute unchanged`);
    assert.deepEqual(decorated.parameters, def.parameters, `${name} parameters unchanged`);
  }
  runtime.dispose();
}

console.log("Context7 library and docs display tests: OK");
