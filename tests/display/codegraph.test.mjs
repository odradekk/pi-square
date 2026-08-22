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

function makeCodeGraphDef() {
  return {
    name: "codegraph",
    label: "CodeGraph",
    description: "codegraph tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

function statusValue(overrides = {}) {
  return {
    initialized: true,
    fileCount: 120,
    nodeCount: 5000,
    edgeCount: 9000,
    dbSizeBytes: 2048000,
    lastIndexed: "2024-01-01T00:00:00Z",
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    ...overrides,
  };
}

function renderResult(decorated, args, content, details, opts = {}) {
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  return decorated.renderResult(
    { content: [{ type: "text", text: content }], details, ...(opts.isError ? { isError: true } : {}) },
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
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  assert.equal(decorated.renderShell, "self", "codegraph uses self render shell");

  const args = { operation: "explore", query: "how does auth work" };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "some source explanation" }], details: { version: 1, operation: "explore", phase: "done", projectPath: "/tmp" } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running, isError: false }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders bullet");
  assert.deepEqual(running.render(80), [], "call slot empties when result arrives");

  runtime.dispose();
}

// ─── 2. Operation-specific titles and targets ────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const cases = [
    [{ operation: "explore", query: "how does auth work" }, /CodeGraph explore/, /how does auth work/],
    [{ operation: "status", projectPath: "." }, /CodeGraph status/, /\./],
    [{ operation: "sync", projectPath: "src" }, /CodeGraph sync/, /src/],
    [{ operation: "init", projectPath: "." }, /CodeGraph init/, /\./],
    [{ operation: "reindex", projectPath: "." }, /CodeGraph reindex/, /\./],
  ];
  for (const [args, titlePattern, targetPattern] of cases) {
    const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
    const text = stripVTControlCharacters(call.render(100).join("\n"));
    assert.match(text, titlePattern, `${args.operation} shows operation-specific title`);
    assert.match(text, targetPattern, `${args.operation} shows operation-specific target`);
  }

  runtime.dispose();
}

// ─── 3. Status result shows structured index health, not raw JSON ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "status", projectPath: "." };
  const details = { version: 1, operation: "status", phase: "done", projectPath: "/tmp", status: statusValue({ pendingChanges: { added: 2, modified: 1, removed: 0 } }) };
  const result = renderResult(decorated, args, JSON.stringify({ version: 1, status: "done", operation: "status", projectPath: "/tmp", index: details.status }), details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.ok(!text.includes("├─ Index"), "a lone Index section draws no title (C9)");
  assert.match(text, /files=120/, "index content shows file count");
  assert.match(text, /nodes=5000/, "index section shows node count");
  assert.match(text, /edges=9000/, "index section shows edge count");
  assert.match(text, /size=2\.0 MB/, "index section shows human-readable size");
  assert.match(text, /lastIndexed=2024-01-01/, "index section shows last indexed timestamp");
  assert.match(text, /pending=3/, "index section shows pending change count");
  assert.doesNotMatch(text, /\[object Object\]/, "the status object is never stringified as [object Object]");
  assert.doesNotMatch(text, /"initialized":true/, "the raw status JSON is never dumped into the display");

  runtime.dispose();
}

// ─── 4. Metadata never leaks the raw status object as a badge ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "status", projectPath: "." };
  const details = { version: 1, operation: "status", phase: "done", projectPath: "/tmp", status: statusValue() };
  const result = renderResult(decorated, args, "{}", details);
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.doesNotMatch(text, /status=\{/, "header metadata never shows a raw status object badge");
  assert.doesNotMatch(text, /\[object Object\]/, "header metadata never shows [object Object]");

  runtime.dispose();
}

// ─── 4b. Compact Index/Result sections stay visible when expanded ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);

  const statusArgs = { operation: "status", projectPath: "." };
  const statusDetails = { version: 1, operation: "status", phase: "done", projectPath: "/tmp", status: statusValue({ pendingChanges: { added: 2, modified: 1, removed: 0 } }) };
  const statusExpanded = renderResult(decorated, statusArgs, "{}", statusDetails, { expanded: true });
  const statusExpandedText = stripVTControlCharacters(statusExpanded.render(100).join("\n"));
  assert.match(statusExpandedText, /files=120/, "status result shows the index health content when expanded");
  assert.doesNotMatch(statusExpandedText, /QUERY/, "status result omits the restating Query section");

  const recoverableArgs = { operation: "explore", query: "how does auth work" };
  const recoverableDetails = { version: 1, operation: "explore", phase: "recoverable", projectPath: "/tmp", code: "NOT_INDEXED", message: "No CodeGraph index exists here; request operation=init once" };
  // C4 revision: a collapsed entry is exactly one row; the recoverable
  // message is the inline summary.
  const recoverableCollapsed = renderResult(decorated, recoverableArgs, "{}", recoverableDetails, { expanded: false });
  const recoverableCollapsedLines = stripVTControlCharacters(recoverableCollapsed.render(100).join("\n"));
  assert.equal(recoverableCollapsed.render(100).length, 1, "collapsed recoverable renders exactly one row");
  assert.match(recoverableCollapsedLines, /No CodeGraph/, "collapsed recoverable message stays visible as the inline summary");
  assert.match(recoverableCollapsedLines, /on=init once/, "the inline summary keeps the action tail");

  runtime.dispose();
}

// ─── 5. Explore result shows prose as Results; genuinely empty is distinct ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "explore", query: "how does auth work" };
  const details = { version: 1, operation: "explore", phase: "done", projectPath: "/tmp" };

  const withResults = renderResult(decorated, args, "Auth flows through middleware.js and validates JWTs.", details, { expanded: true });
  const withResultsText = stripVTControlCharacters(withResults.render(100).join("\n"));
  assert.match(withResultsText, /Auth flows through middleware\.js/, "explore prose is visible");
  assert.ok(!withResultsText.includes("Results"), "a lone Results section draws no title (C9)");

  const empty = renderResult(decorated, args, "CodeGraph returned no relevant source for this query.", details, { expanded: true });
  const emptyText = stripVTControlCharacters(empty.render(100).join("\n"));
  assert.match(emptyText, /^✓/, "empty explore still renders completed (not failed)");
  assert.match(emptyText, /No relevant source/, "empty explore shows an explicit empty message in the summary row");

  runtime.dispose();
}

// ─── 6. Recoverable states render distinctly (warning marker, no raw JSON) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "explore", query: "how does auth work" };
  const raw = { version: 1, status: "recoverable", operation: "explore", projectPath: "/tmp", code: "NOT_INDEXED", message: "No CodeGraph index exists here; request operation=init once" };
  const details = { version: 1, operation: "explore", phase: "recoverable", projectPath: "/tmp", code: "NOT_INDEXED", message: raw.message };
  const result = renderResult(decorated, args, JSON.stringify(raw), details);
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^!/, "recoverable renders the completed-with-warning marker");
  assert.match(text, /No CodeGraph/, "recoverable shows the actionable message");
  assert.match(text, /on=init once/, "the inline summary keeps the action tail");
  assert.doesNotMatch(text, /"version":1,"status":"recoverable"/, "recoverable does not dump raw JSON");

  // recoverable results that also carry a status object (e.g.
  // REINDEX_REQUIRED, WORKTREE_MISMATCH, SYNC_INCOMPLETE) show the index
  // health context alongside the actionable message, not just the message.
  const withStatusDetails = {
    version: 1,
    operation: "explore",
    phase: "recoverable",
    projectPath: "/tmp",
    code: "WORKTREE_MISMATCH",
    message: "The CodeGraph index belongs to a different Git worktree",
    status: statusValue({ worktreeMismatch: true }),
  };
  const withStatus = renderResult(decorated, args, JSON.stringify({ ...raw, code: "WORKTREE_MISMATCH", message: withStatusDetails.message }), withStatusDetails, { expanded: true });
  const withStatusText = stripVTControlCharacters(withStatus.render(100).join("\n"));
  assert.match(withStatusText, /Result/, "recoverable with status still shows the Result message section");
  assert.match(withStatusText, /different Git worktree/, "recoverable with status shows the actionable message");
  assert.match(withStatusText, /Index/, "recoverable with status also shows the Index health section");
  assert.match(withStatusText, /worktree=mismatch/, "recoverable with status surfaces the worktree mismatch field");

  runtime.dispose();
}

// ─── 7. Declined confirmation is distinct: no write, no raw JSON ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "init", projectPath: "." };
  const raw = { version: 1, status: "declined", operation: "init", projectPath: "/tmp", code: "USER_DECLINED", message: "CodeGraph initialization was declined" };
  const details = { version: 1, operation: "init", phase: "declined", projectPath: "/tmp", code: "USER_DECLINED", message: raw.message };
  const result = renderResult(decorated, args, JSON.stringify(raw), details);
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /CodeGraph initial/, "declined shows the decline message head");
  assert.match(text, /tion was declined/, "declined keeps the decline message tail");
  assert.doesNotMatch(text, /"version":1,"status":"declined"/, "declined does not dump raw JSON");

  runtime.dispose();
}

// ─── 8. Aborted renders the aborted marker, distinct from failed ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "reindex", projectPath: "." };
  const raw = { version: 1, status: "aborted", operation: "reindex", projectPath: "/tmp", code: "ABORTED", message: "CodeGraph reindex was cancelled" };
  const details = { version: 1, operation: "reindex", phase: "aborted", projectPath: "/tmp", code: "ABORTED", message: raw.message };
  const result = renderResult(decorated, args, JSON.stringify(raw), details, { isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^·/, "aborted renders the · marker, not the · failed marker");
  assert.match(text, /CodeGraph reindex was cancelled/, "aborted shows the cancellation message once");
  assert.equal((text.match(/CodeGraph reindex was cancelled/g) ?? []).length, 1, "the cancellation message is not duplicated");

  runtime.dispose();
}

// ─── 9. Hard errors render the failed marker with a safe message ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "status", projectPath: "." };
  const raw = { version: 1, status: "error", operation: "status", projectPath: "/tmp", code: "BINARY_UNAVAILABLE", message: "Cannot resolve CodeGraph binary for this platform" };
  const details = { version: 1, operation: "status", phase: "error", projectPath: "/tmp", code: "BINARY_UNAVAILABLE", message: raw.message };
  const result = renderResult(decorated, args, JSON.stringify(raw), details, { isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "hard error renders the failed marker");
  assert.match(text, /CodeGraph is una…or this platform/, "hard error shows the mapped safe message");
  assert.equal((text.match(/CodeGraph is una…or this platform/g) ?? []).length, 1, "the error message is not duplicated across preview and error field");

  runtime.dispose();
}

// ─── 10. Running progress surfaces the streaming message ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "explore", query: "how does auth work" };
  const raw = { version: 1, status: "running", operation: "explore", projectPath: "/tmp", message: "exploring semantic graph" };
  const details = { version: 1, operation: "explore", phase: "running", projectPath: "/tmp", message: raw.message };
  const result = renderResult(decorated, args, JSON.stringify(raw), details, { isPartial: true });
  // Render wide enough that the message is not middle-elided, so the
  // assertion does not depend on the exact elision cut.
  const text = stripVTControlCharacters(result.render(160).join("\n"));
  assert.match(text, /exploring semantic graph/, "running progress message is visible inline");
  assert.equal((text.match(/exploring semantic graph/g) ?? []).length, 1, "the progress message renders exactly once, not inline and in the right element");
  assert.doesNotMatch(text, /"version":1,"status":"running"/, "running does not dump the raw streaming envelope as a fallback");

  runtime.dispose();
}

// ─── 11. Truncation is visible when expanded ─────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "explore", query: "how does auth work" };
  const details = { version: 1, operation: "explore", phase: "done", projectPath: "/tmp", outputTruncated: true, outputChars: 24000 };
  const result = renderResult(decorated, args, "some long explanation\n\n[CodeGraph output truncated by pi-square]", details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /truncated by model-facing budget/, "output truncation is visible when expanded");

  runtime.dispose();
}

// ─── 12. Malformed/unrecognized details fall back to raw text (no info lost) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "explore", query: "how does auth work" };
  // A details shape lacking the expected phase/operation fields must not
  // silently render nothing; the raw content still surfaces.
  const result = renderResult(decorated, args, "unexpected raw content", { status: "success", returned: 2 }, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /unexpected raw content/, "unrecognized details fall back to showing raw content");

  // A present but unrecognized phase string (not merely an absent phase)
  // must also fall back rather than silently producing no domain content.
  const bogusPhaseDetails = { version: 1, operation: "explore", phase: "bogus", projectPath: "/tmp" };
  const bogusResult = renderResult(decorated, args, "content under an unrecognized phase value", bogusPhaseDetails, { expanded: true });
  const bogusText = stripVTControlCharacters(bogusResult.render(100).join("\n"));
  assert.match(bogusText, /content under an unrecognized phase value/, "an unrecognized (but present) phase string also falls back to raw content");

  runtime.dispose();
}

// ─── 13. Narrow widths prioritize marker, identity, target ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "status", projectPath: "." };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  for (const width of [39, 40]) {
    const line = stripVTControlCharacters(call.render(width)[0]);
    assert.match(line, /^●/, `marker visible at width ${width}`);
    assert.match(line, /CodeGraph/, `identity visible at width ${width}`);
  }

  runtime.dispose();
}

// ─── 14. Bounded at all widths ───────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeCodeGraphDef(), () => runtime);
  const args = { operation: "status", projectPath: "." };
  const details = { version: 1, operation: "status", phase: "done", projectPath: "/tmp", status: statusValue({ pendingChanges: { added: 2, modified: 1, removed: 0 } }) };
  const result = renderResult(decorated, args, "{}", details, { expanded: true });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = result.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `codegraph result bounded at ${width}`);
  }

  runtime.dispose();
}

// ─── 15. Execution unchanged ─────────────────────────────────────────

{
  const runtime = newRuntime();
  const cgDef = makeCodeGraphDef();
  const decorated = decorateInternalTool(cgDef, () => runtime);
  assert.equal(decorated.execute, cgDef.execute, "codegraph execute unchanged");
  assert.deepEqual(decorated.parameters, cgDef.parameters, "codegraph parameters unchanged");

  runtime.dispose();
}

console.log("codegraph display tests: OK");
