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
    args, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state,
    cwd: "/tmp", executionStarted: false, argsComplete: false, isPartial: false,
    expanded: false, showImages: false, isError: false, ...overrides,
  };
}

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });
}

function makeDef(name) {
  return {
    name, label: name, description: `${name} tool`,
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
      argsComplete: true, executionStarted: true, lastComponent: call,
      isError: opts.isError ?? false, expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Lifecycle markers through production decoration path ─────────

{
  const clock = {
    callbacks: new Map(), next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); }, unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  assert.equal(decorated.renderShell, "self", "github_search uses self render shell");

  const args = { kind: "repositories", query: "react" };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");

  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");

  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille spinner");

  const result = decorated.renderResult(
    { content: [{ type: "text", text: "result" }], details: { tool: "search", phase: "done", kind: "repositories", query: "react", page: 1, limit: 10, total: 0, returned: 0, omitted: 0, incomplete: false, hasMore: false } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders check mark");

  runtime.dispose();
}

// ─── 2. Search title retains kind and query identity ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  const args = { kind: "code", query: "repo:owner/name fn main", page: 1, limit: 10 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /GitHub search/, "call shows GitHub search title");
  assert.match(text, /repo:owner\/name fn main/, "query appears as target");

  runtime.dispose();
}

// ─── 3. Search expanded preserves ranking, text-match snippets, rate ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  const args = { kind: "code", query: "fn main", page: 1, limit: 5 };
  const details = {
    tool: "search", phase: "done", kind: "code", query: "fn main", page: 1, limit: 5,
    total: 42, returned: 2, omitted: 0, incomplete: true, hasMore: true,
    items: [
      { repo: "owner/name", path: "src/main.rs", name: "main.rs", url: "https://github.com/owner/name/blob/main/src/main.rs", sha: "abc123", fragments: ["fn main() {", "    println!"] },
      { repo: "other/repo", path: "lib.rs", name: "lib.rs", url: "https://github.com/other/repo/blob/main/lib.rs", sha: "def456" },
    ],
    rate: { limit: 30, remaining: 25, used: 5 },
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /owner\/name \u00b7 src\/main\.rs/, "expanded preserves repo:path identity");
  assert.match(text, /fn main\(\)/, "expanded preserves text-match snippet content");
  // Ranking order
  assert.ok(text.indexOf("owner/name") < text.indexOf("other/repo"), "expanded preserves ranking order");
  // Rate limit and incomplete indicators were in the Summary section (C8-pruned);
  // pagination hasMore now raises the [truncated] badge.
  assert.match(text, /\[truncated\]/, "pagination hasMore raises the truncated badge");

  runtime.dispose();
}

// ─── 4. Search empty results state ──────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  const args = { kind: "repositories", query: "nonexistent-xyz-123" };
  const details = { tool: "search", phase: "done", kind: "repositories", query: "nonexistent-xyz-123", page: 1, limit: 10, total: 0, returned: 0, omitted: 0, incomplete: false, hasMore: false };
  const result = renderResult(decorated, args, details, "No results found.");
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "empty results renders completed");
  assert.match(text, /No results/, "empty state shows explicit message in summary row");

  runtime.dispose();
}

// ─── 5. Error states render failed marker (no isError needed) ───────

{
  const runtime = newRuntime();
  // Missing token error — tool never sets isError:true
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  const args = { kind: "repositories", query: "test" };
  const details = { tool: "search", phase: "done", kind: "repositories", query: "test", page: 1, limit: 10, total: 0, returned: 0, omitted: 0, incomplete: false, hasMore: false, errorCode: "MISSING_GITHUB_TOKEN", error: "Missing GITHUB_TOKEN." };
  const result = renderResult(decorated, args, details, "Error: Missing GITHUB_TOKEN.", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "missing-token error renders failed marker without isError");
  assert.match(text, /Missing GITHUB_TOKEN/, "error message visible");

  runtime.dispose();
}

// ─── 6. Rate-limited state is distinct ──────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  const args = { kind: "repositories", query: "test" };
  const details = { tool: "search", phase: "done", kind: "repositories", query: "test", page: 1, limit: 10, total: 0, returned: 0, omitted: 0, incomplete: false, hasMore: false, errorCode: "RATE_LIMITED", error: "GitHub API rate limit exceeded", rate: { limit: 30, remaining: 0, used: 30, reset: 1700000000, resource: "search", retryAfter: 60 } };
  const result = renderResult(decorated, args, details, "Error: rate limit exceeded.", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "rate-limited renders failed marker");
  assert.match(text, /GitHub rate limit reached/, "rate-limit error sentence visible");

  runtime.dispose();
}

// ─── 7. Read preserves repo, ref, path, line bounds, sha ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_read"), () => runtime);
  const args = { repo: "owner/name", path: "src/index.ts", ref: "main", line: 1, limit: 200 };
  const details = { tool: "read", phase: "done", repo: "owner/name", path: "src/index.ts", ref: "main", resolvedPath: "src/index.ts", sha: "abcdef1234567890", size: 1024, binary: false, line: 1, limit: 200, returnedLines: 50, totalLines: 150, hasMore: true, rate: { limit: 5000, remaining: 4999, used: 1 } };
  const result = renderResult(decorated, args, details, "1: import { foo } from 'bar';", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /owner\/name:src\/index\.ts/, "target preserves repo and path");
  assert.match(text, /lines 1-50 of 150 · continue at line 51/, "summary row states returned lines and continuation");
  assert.match(text, /\[truncated\]/, "pagination hasMore raises the truncated badge");

  runtime.dispose();
}

// ─── 8. Read binary file renders distinct state ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_read"), () => runtime);
  const args = { repo: "owner/name", path: "logo.png", ref: "main" };
  const details = { tool: "read", phase: "done", repo: "owner/name", path: "logo.png", ref: "main", resolvedPath: "logo.png", sha: "abcdef", size: 51200, binary: true, line: 1, limit: 200, returnedLines: 0, hasMore: false, errorCode: "UNSUPPORTED_CONTENT_TYPE", error: "Binary file · content omitted" };
  const result = renderResult(decorated, args, details, "Binary file · 51200 bytes · content omitted", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Binary file/, "binary message visible");
  assert.match(text, /content omitted/, "binary content-omitted notice visible");

  runtime.dispose();
}

// ─── 9. Read oversized file is distinct ─────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_read"), () => runtime);
  const args = { repo: "owner/name", path: "huge.ts", ref: "main" };
  const details = { tool: "read", phase: "done", repo: "owner/name", path: "huge.ts", ref: "main", resolvedPath: "huge.ts", size: 3_000_000, binary: true, line: 1, limit: 200, returnedLines: 0, hasMore: false, errorCode: "FILE_TOO_LARGE", error: "GitHub file is 3000000 bytes; the local read cap is 2097152 bytes" };
  const result = renderResult(decorated, args, details, "Error: file too large", { expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "oversized renders failed marker");

  runtime.dispose();
}

// ─── 10. Tree preserves repo, ref, depth, entries, completeness ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_tree"), () => runtime);
  const args = { repo: "owner/name", path: "src", ref: "main", depth: 2, offset: 0, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", path: "src", ref: "main", depth: 2, offset: 0, limit: 100,
    returned: 3, total: 5, hasMore: true, remoteTruncated: false, requestBudgetExhausted: true, requestsUsed: 20,
    entries: [
      { path: "src/index.ts", type: "file", size: 1024, sha: "abc" },
      { path: "src/utils", type: "directory" },
      { path: "src/test.ts", type: "file", size: 512 },
    ],
    rate: { limit: 5000, remaining: 4980, used: 20 },
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /index\.ts/, "expanded preserves entry path");
  assert.match(text, /index\.ts/, "expanded preserves file entry path (relative to browse path)");
  assert.match(text, /utils\//, "expanded shows directory with trailing slash");
  assert.match(text, /\[truncated\]/, "pagination hasMore raises the truncated badge");

  runtime.dispose();
}

// ─── 11. Tree remote truncation is visible ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_tree"), () => runtime);
  const args = { repo: "owner/name", path: ".", ref: "main", depth: 1, offset: 0, limit: 100 };
  const details = { tool: "tree", phase: "done", repo: "owner/name", ref: "main", depth: 1, offset: 0, limit: 100, returned: 100, hasMore: true, remoteTruncated: true, requestBudgetExhausted: false, requestsUsed: 1, entries: [], rate: { limit: 5000, remaining: 4999 } };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /\[truncated\]/, "expanded shows the truncated badge for directory-limit and pagination");

  runtime.dispose();
}

// ─── 12. Commit preserves metadata, file patches, stats ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_commit"), () => runtime);
  const args = { repo: "owner/name", ref: "abcdef1234567890", page: 1, limit: 20 };
  const details = {
    tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef1234567890",
    sha: "abcdef1234567890abcdef1234567890abcdef1234567890",
    page: 1, limit: 20, message: "Fix critical bug", author: "alice", authoredAt: "2024-01-15",
    verified: true, additions: 15, deletions: 3, changes: 18, returned: 2, hasMore: false, omittedPatches: 1,
    files: [
      { filename: "src/index.ts", status: "modified", additions: 10, deletions: 2, changes: 12, patchState: "included" },
      { filename: "src/logo.png", status: "added", additions: 5, deletions: 1, changes: 6, patchState: "missing" },
    ],
    rate: { limit: 5000, remaining: 4999 },
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /src\/index\.ts/, "expanded preserves changed filename");
  assert.match(text, /M  src\/index\.ts/, "expanded shows modified status letter");
  assert.match(text, /A  src\/logo\.png/, "expanded shows added status letter");

  runtime.dispose();
}

// ─── 13. No auth data or raw API payload leaks into header ──────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github_search"), () => runtime);
  const args = { kind: "code", query: "repo:owner/name ghp_SECRET_TOKEN_123" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  // Token-shaped patterns are redacted by the shared sanitizer before
  // rendering — they must never appear in any display line.
  assert.doesNotMatch(callText, /ghp_SECRET_TOKEN_123/, "token-shaped pattern in query is redacted in display");

  // Read result: file content with embedded token-like patterns should
  // not leak into the header
  const readDecorated = decorateInternalTool(makeDef("github_read"), () => runtime);
  const readArgs = { repo: "owner/name", path: "config.ts", ref: "main" };
  const readDetails = { tool: "read", phase: "done", repo: "owner/name", path: "config.ts", ref: "main", returnedLines: 10, hasMore: false };
  const readResult = renderResult(readDecorated, readArgs, readDetails, "API_KEY = ghp_EMBEDDED_SECRET_BODY");
  const readText = stripVTControlCharacters(readResult.render(100).join("\n"));
  const headerLine = readText.split("\n")[1] ?? "";
  assert.doesNotMatch(headerLine, /ghp_EMBEDDED_SECRET_BODY/, "embedded token pattern does not leak into activity header");

  runtime.dispose();
}

// ─── 14. Collapsed/expanded bounds at all widths ────────────────────

{
  const runtime = newRuntime();
  for (const [name, args, details, text] of [
    ["github_search", { kind: "code", query: "test", page: 1, limit: 10 },
      { tool: "search", phase: "done", kind: "code", query: "test", page: 1, limit: 10, total: 1, returned: 1, omitted: 0, incomplete: false, hasMore: false, items: [{ repo: "o/n", name: "f", url: "https://github.com/o/n" }] },
      "content"],
    ["github_read", { repo: "owner/name", path: "README.md", ref: "main" },
      { tool: "read", phase: "done", repo: "owner/name", path: "README.md", ref: "main", returnedLines: 10, hasMore: false },
      "content"],
    ["github_tree", { repo: "owner/name", path: "src", ref: "main", depth: 1, offset: 0, limit: 100 },
      { tool: "tree", phase: "done", repo: "owner/name", path: "src", ref: "main", depth: 1, offset: 0, limit: 100, returned: 1, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 1, entries: [{ path: "src/f.ts", type: "file" }] },
      "content"],
    ["github_commit", { repo: "owner/name", ref: "abcdef1234567890abcdef1234567890abcdef12", page: 1, limit: 20 },
      { tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef", returned: 1, hasMore: false, omittedPatches: 0, files: [{ filename: "f.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patchState: "included" }] },
      "content"],
  ]) {
    const decorated = decorateInternalTool(makeDef(name), () => runtime);
    for (const expanded of [false, true]) {
      const result = renderResult(decorated, args, details, text, { expanded });
      for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
        assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `${name} ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
      }
    }
  }
  runtime.dispose();
}

// ─── 15. Execution unchanged ────────────────────────────────────────

{
  const runtime = newRuntime();
  for (const name of ["github_search", "github_read", "github_tree", "github_commit"]) {
    const def = makeDef(name);
    const decorated = decorateInternalTool(def, () => runtime);
    assert.equal(decorated.execute, def.execute, `${name} execute unchanged`);
    assert.deepEqual(decorated.parameters, def.parameters, `${name} parameters unchanged`);
  }
  runtime.dispose();
}

console.log("GitHub tools display tests: OK");
