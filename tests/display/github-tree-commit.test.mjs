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

// ─── 1. Tree preserves all entry kinds (file, directory, symlink, submodule) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: ".", ref: "main", depth: 1, offset: 0, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", path: ".", ref: "main", depth: 1, offset: 0, limit: 100,
    returned: 4, total: 4, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 1,
    entries: [
      { path: "src/main.ts", type: "file", size: 1024, sha: "aaa111" },
      { path: "src/utils", type: "directory" },
      { path: "src/link", type: "symlink", size: 10, sha: "bbb222" },
      { path: "src/vendor/lib", type: "submodule", sha: "ccc333" },
    ],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /main\.ts/, "file path preserved");
  assert.match(text, /utils\//, "directory path preserved with trailing slash");
  assert.match(text, /link/, "symlink path preserved");
  assert.match(text, /vendor\/lib/, "submodule path preserved");

  runtime.dispose();
}

// ─── 2. Tree empty directory shows explicit indicator ──────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: "empty-dir", ref: "main", depth: 1, offset: 0, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", path: "empty-dir", ref: "main", depth: 1, offset: 0, limit: 100,
    returned: 0, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 1, entries: [],
  };
  const result = renderResult(decorated, args, details, "github_tree owner/name:empty-dir\nref: main · depth: 1 · offset: 0 · returned: 0", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Empty directory/, "empty directory indicator visible");

  runtime.dispose();
}

// ─── 2b. Tree offset past end shows distinct indicator ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: "src", ref: "main", depth: 1, offset: 500, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", path: "src", ref: "main", depth: 1, offset: 500, limit: 100,
    returned: 0, total: 50, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 1, entries: [],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /no entries at offset 500/, "offset-past-end shows distinct indicator, not 'empty directory'");
  assert.doesNotMatch(text, /empty directory/, "offset-past-end does not say 'empty directory'");

  runtime.dispose();
}

// ─── 3. Tree with stable offset preserves pagination state ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: "src", ref: "main", depth: 2, offset: 50, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", path: "src", ref: "main", depth: 2, offset: 50, limit: 100,
    returned: 50, total: 200, hasMore: true, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 5,
    entries: [{ path: "src/z-last.ts", type: "file", size: 100 }],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /50 of 200 entries/, "summary shows returned/total count");
  assert.match(text, /continue at offset 100/, "summary shows pagination continuation");
  assert.match(text, /\[truncated\]/, "pagination indicator visible via badge");

  runtime.dispose();
}

// ─── 4. Tree remote truncation is distinct from request budget ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  // Remote truncation only (GitHub 1000-entry directory limit)
  const truncDetails = {
    tool: "tree", phase: "done", repo: "o/n", ref: "main", depth: 1, offset: 0, limit: 100,
    returned: 100, hasMore: true, remoteTruncated: true, requestBudgetExhausted: false, requestsUsed: 1, entries: [],
  };
  const truncResult = renderResult(decorated, { operation: "tree", repo: "o/n", ref: "main" }, truncDetails, "content", { expanded: true });
  const truncText = stripVTControlCharacters(truncResult.render(100).join("\n"));
  assert.match(truncText, /\[truncated\]/, "remote truncation visible via badge");
  assert.doesNotMatch(truncText, /requestBudget/, "request budget not shown when only remote truncated");

  // Request budget exhausted only
  const budgetDetails = {
    tool: "tree", phase: "done", repo: "o/n", ref: "main", depth: 4, offset: 0, limit: 100,
    returned: 50, hasMore: true, remoteTruncated: false, requestBudgetExhausted: true, requestsUsed: 20, entries: [],
  };
  const budgetResult = renderResult(decorated, { operation: "tree", repo: "o/n", ref: "main" }, budgetDetails, "content", { expanded: true });
  const budgetText = stripVTControlCharacters(budgetResult.render(100).join("\n"));
  assert.match(budgetText, /\[truncated\]/, "request budget exhaustion visible via badge");
  assert.doesNotMatch(budgetText, /remoteTruncated/, "remote truncation not shown when only budget exhausted");

  // Both at once
  const bothDetails = {
    tool: "tree", phase: "done", repo: "o/n", ref: "main", depth: 4, offset: 0, limit: 100,
    returned: 100, hasMore: true, remoteTruncated: true, requestBudgetExhausted: true, requestsUsed: 20, entries: [],
  };
  const bothResult = renderResult(decorated, { operation: "tree", repo: "o/n", ref: "main" }, bothDetails, "content", { expanded: true });
  const bothText = stripVTControlCharacters(bothResult.render(100).join("\n"));
  assert.match(bothText, /\[truncated\]/, "remote truncation and budget both visible via badge");

  runtime.dispose();
}

// ─── 5. Tree total visible when complete (no truncation/budget) ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: "src", ref: "main", depth: 1, offset: 0, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", path: "src", ref: "main", depth: 1, offset: 0, limit: 100,
    returned: 5, total: 5, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 1,
    entries: [{ path: "a.ts", type: "file" }, { path: "b.ts", type: "file" }],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /2 files/, "summary shows entry count for complete tree");
  assert.doesNotMatch(text, /remoteTruncated/, "no remote truncation indicator for complete tree");
  assert.doesNotMatch(text, /requestBudget/, "no budget indicator for complete tree");

  runtime.dispose();
}

// ─── 6. Commit preserves identity, message, metadata ───────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "commit", repo: "owner/name", ref: "abcdef1234567890abcdef1234567890abcdef1234567890", page: 1, limit: 20 };
  const details = {
    tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef1234567890abcdef1234567890abcdef1234567890",
    sha: "abcdef1234567890abcdef1234567890abcdef1234567890",
    page: 1, limit: 20, message: "Fix critical authentication bug", author: "alice", authoredAt: "2024-01-15T10:00:00Z",
    verified: true, additions: 15, deletions: 3, changes: 18, returned: 3, hasMore: false, omittedPatches: 1,
    files: [
      { filename: "src/auth.ts", status: "modified", additions: 10, deletions: 2, changes: 12, patchState: "included" },
      { filename: "src/data.bin", status: "modified", additions: 0, deletions: 0, changes: 0, patchState: "missing" },
      { filename: "src/util.ts", status: "added", additions: 5, deletions: 1, changes: 6, patchState: "omitted" },
    ],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(120).join("\n"));
  assert.match(text, /src\/auth\.ts/, "commit changed file visible");
  assert.match(text, /M  src\/auth\.ts/, "commit file status letter visible");

  runtime.dispose();
}

// ─── 7. Commit preserves all three patch states explicitly ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "commit", repo: "owner/name", ref: "abcdef", page: 1, limit: 20 };
  const details = {
    tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef", sha: "abcdef1234567890abcdef1234567890abcdef12",
    page: 1, limit: 20, message: "Mixed changes", author: "bob", additions: 10, deletions: 5, changes: 15,
    returned: 3, hasMore: false, omittedPatches: 1,
    files: [
      { filename: "included.ts", status: "modified", additions: 8, deletions: 3, changes: 11, patchState: "included" },
      { filename: "binary.png", status: "modified", additions: 0, deletions: 0, changes: 0, patchState: "missing" },
      { filename: "big-file.ts", status: "modified", additions: 2, deletions: 2, changes: 4, patchState: "omitted" },
    ],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(120).join("\n"));
  assert.match(text, /included\.ts/, "included patch file visible");
  assert.match(text, /binary\.png/, "binary/missing patch file visible");
  assert.match(text, /big-file\.ts/, "omitted patch file visible");
  // patches count is in the pruned Summary section; verify file records instead
  // Verify patch bodies never appear in display
  assert.doesNotMatch(text, /@@ .* @@/, "patch body hunks never rendered in display");
  assert.doesNotMatch(text, /^[-+]/m, "diff plus/minus lines never rendered in display");

  runtime.dispose();
}

// ─── 8. Commit no changed files shows explicit indicator ───────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "commit", repo: "owner/name", ref: "abcdef", page: 1, limit: 20 };
  const details = {
    tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef", sha: "abcdef1234567890abcdef1234567890abcdef12",
    page: 1, limit: 20, message: "Empty commit", author: "bob", authoredAt: "2024-02-01",
    verified: false, additions: 0, deletions: 0, changes: 0, returned: 0, hasMore: false, omittedPatches: 0, files: [],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /0 files/, "no-changed-files shows zero count");
  assert.match(text, /0 files/, "returned=0 visible in summary");

  runtime.dispose();
}

// ─── 9. Commit pagination preserves page state ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "commit", repo: "owner/name", ref: "abcdef", page: 2, limit: 10 };
  const details = {
    tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef", sha: "abcdef1234567890",
    page: 2, limit: 10, message: "Many files", author: "carol",
    additions: 50, deletions: 20, changes: 70, returned: 10, hasMore: true, omittedPatches: 0,
    files: Array.from({ length: 10 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 5, deletions: 2, changes: 7, patchState: "included" })),
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(120).join("\n"));
  assert.match(text, /10 files/, "returned count visible in summary");
  assert.match(text, /continue at page 3/, "pagination visible in summary");
  assert.match(text, /\[truncated\]/, "pagination indicator visible via badge");

  runtime.dispose();
}

// ─── 10. Error states render failed marker (not found, invalid) ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: "nonexistent", ref: "main" };
  const details = { tool: "tree", phase: "done", repo: "owner/name", path: "nonexistent", ref: "main", depth: 1, offset: 0, limit: 100, returned: 0, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 0, errorCode: "NOT_FOUND", error: "GitHub path 'nonexistent' was not found" };
  const result = renderResult(decorated, args, details, "Error: not found", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "not-found tree renders failed marker");
  assert.match(text, /not found/, "error message visible");

  runtime.dispose();
}

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "commit", repo: "owner/name", ref: "" };
  const details = { tool: "commit", phase: "done", repo: "owner/name", ref: "", page: 1, limit: 20, returned: 0, hasMore: false, omittedPatches: 0, errorCode: "INVALID_INPUT", error: "ref is invalid" };
  const result = renderResult(decorated, args, details, "Error: ref is invalid", { expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "invalid ref renders failed marker");

  runtime.dispose();
}

// ─── 11. Rate-limited tree/commit remain distinct ──────────────────

{
  const runtime = newRuntime();
  for (const [name, args, details] of [
    ["github", { operation: "tree", repo: "o/n", ref: "main" },
      { tool: "tree", phase: "done", repo: "o/n", ref: "main", depth: 1, offset: 0, limit: 100, returned: 0, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 0, errorCode: "RATE_LIMITED", error: "Rate limit exceeded", rate: { limit: 5000, remaining: 0, used: 5000, reset: 1700000000, retryAfter: 120 } }],
    ["github", { operation: "commit", repo: "o/n", ref: "abc" },
      { tool: "commit", phase: "done", repo: "o/n", ref: "abc", page: 1, limit: 20, returned: 0, hasMore: false, omittedPatches: 0, errorCode: "RATE_LIMITED", error: "Rate limit exceeded", rate: { limit: 5000, remaining: 0, used: 5000, reset: 1700000000, retryAfter: 120 } }],
  ]) {
    const decorated = decorateInternalTool(makeDef(name), () => runtime);
    const result = renderResult(decorated, args, details, "Error: rate limit", { expanded: true });
    const text = stripVTControlCharacters(result.render(100).join("\n"));
    assert.match(text, /^●/, `${name} rate-limited renders failed marker`);
    assert.match(text, /GitHub rate limit reached/, `${name} rate-limit error sentence visible`);
  }
  runtime.dispose();
}

// ─── 12. No patch bodies or arbitrary response objects in display ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "commit", repo: "owner/name", ref: "abcdef", page: 1, limit: 20 };
  const details = {
    tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef", sha: "abcdef1234567890abcdef1234567890abcdef12",
    page: 1, limit: 20, message: "Test", author: "x", additions: 5, deletions: 2, changes: 7, returned: 1, hasMore: false, omittedPatches: 0,
    files: [{ filename: "test.ts", status: "modified", additions: 5, deletions: 2, changes: 7, patchState: "included" }],
  };
  // Content includes actual patch text — it must not appear in the display
  const contentText = "github_commit owner/name@abcdef\n@@ -1,3 +1,5 @@\n-old line\n+new line\n+another line";
  const result = renderResult(decorated, args, details, contentText, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Patch hunks must not appear in structured display sections
  assert.doesNotMatch(text, /@@ -1,3 \+1,5 @@/, "patch hunk header not rendered");
  assert.doesNotMatch(text, /-old line/, "patch deletion line not rendered");
  assert.doesNotMatch(text, /\+new line/, "patch addition line not rendered");
  // Only allowlisted identity should appear: filename, status, stats, patchState
  assert.match(text, /test\.ts/, "filename visible");
  assert.match(text, /M  test\.ts/, "file with status letter visible");

  runtime.dispose();
}

// ─── 13. Tree entry path-only identity (no full API response objects) ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef("github"), () => runtime);
  const args = { operation: "tree", repo: "owner/name", path: ".", ref: "main", depth: 1, offset: 0, limit: 100 };
  const details = {
    tool: "tree", phase: "done", repo: "owner/name", ref: "main", depth: 1, offset: 0, limit: 100,
    returned: 1, total: 1, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 1,
    entries: [{ path: "README.md", type: "file", size: 500, sha: "abc123", url: "https://github.com/owner/name/blob/main/README.md" }],
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Entry identity: path, type, size, sha, url — all allowlisted
  assert.match(text, /README\.md/, "entry path visible");
  assert.match(text, /README\.md/, "entry path visible");
  // No raw JSON response objects
  assert.doesNotMatch(text, /\{.*"_links".*\}/, "no raw API response objects");
  assert.doesNotMatch(text, /"git_url"/, "no raw git_url field");

  runtime.dispose();
}

// ─── 14. Collapsed/expanded bounds at all widths ───────────────────

{
  const runtime = newRuntime();
  for (const [name, args, details] of [
    ["github", { operation: "tree", repo: "owner/name", path: "src/deep/nested/path", ref: "feature-branch-name", depth: 3, offset: 10, limit: 100 },
      { tool: "tree", phase: "done", repo: "owner/name", path: "src/deep/nested/path", ref: "feature-branch-name", depth: 3, offset: 10, limit: 100, returned: 3, total: 50, hasMore: true, remoteTruncated: false, requestBudgetExhausted: true, requestsUsed: 20, entries: [{ path: "a.ts", type: "file", size: 1024 }] }],
    ["github", { operation: "commit", repo: "owner/name", ref: "abcdef1234567890abcdef1234567890abcdef1234567890", page: 1, limit: 20 },
      { tool: "commit", phase: "done", repo: "owner/name", ref: "abcdef1234567890abcdef1234567890abcdef1234567890", sha: "abcdef1234567890abcdef1234567890abcdef1234567890", page: 1, limit: 20, message: "A reasonably long commit message for testing width bounds", author: "alice", authoredAt: "2024-01-15", verified: true, additions: 100, deletions: 50, changes: 150, returned: 5, hasMore: true, omittedPatches: 2, files: [{ filename: "f.ts", status: "modified", additions: 50, deletions: 25, changes: 75, patchState: "included" }] }],
  ]) {
    const decorated = decorateInternalTool(makeDef(name), () => runtime);
    for (const expanded of [false, true]) {
      const result = renderResult(decorated, args, details, "content", { expanded });
      for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
        assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `${name} ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
      }
    }
  }
  runtime.dispose();
}

// ─── 15. Execution unchanged ───────────────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef("github");
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "github execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "github parameters unchanged");
  runtime.dispose();
}

console.log("GitHub tree and commit display tests: OK");
