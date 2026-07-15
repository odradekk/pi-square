import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  formatToolCall,
  latestToolCallSummary,
  toolDisplayFromArgs,
  toolEventDisplay,
} = await load(join(packageRoot, "src", "subagents", "tool-display.ts"));

test("sg summaries show structural query, path, and language", () => {
  assert.deepEqual(toolDisplayFromArgs("sg", {
    pattern: "call($ARG)",
    path: "src",
    language: "ts",
    rewrite: "must-not-render",
  }), {
    tool: "sg",
    summary: "/call($ARG)/ in src · ts",
  });
  assert.equal(
    formatToolCall("sg", { kind: "function_declaration", path: "src/parser.ts" }),
    "sg kind:function_declaration in src/parser.ts",
  );
});

test("CodeGraph summaries expose only operation, query, and project path", () => {
  assert.equal(
    formatToolCall("codegraph", { operation: "explore", query: "How does auth work?", projectPath: "services/api", secret: "private" }),
    "codegraph explore: How does auth work? in services/api",
  );
  assert.equal(
    formatToolCall("codegraph", { operation: "reindex", projectPath: ".", secret: "private" }),
    "codegraph reindex .",
  );
});

test("PDF search summaries expose only bounded query and path arguments", () => {
  assert.equal(
    formatToolCall("pdf_search", { query: "installation guide", path: "manual.pdf", secret: "private" }),
    "pdf_search installation guide in manual.pdf",
  );
});

test("GitHub summaries expose only bounded identity and paging arguments", () => {
  assert.equal(
    formatToolCall("github_search", { kind: "code", query: "repo:owner/name symbol", password: "private" }),
    "github_search code: repo:owner/name symbol",
  );
  assert.equal(
    formatToolCall("github_read", { repo: "owner/name", path: "src/index.ts", ref: "main", line: 80, token: "private" }),
    "github_read owner/name:src/index.ts @main · line 80",
  );
  assert.equal(
    formatToolCall("github_tree", { repo: "owner/name", path: "src", ref: "v1", depth: 3, token: "private" }),
    "github_tree owner/name:src @v1 · depth 3",
  );
  assert.equal(
    formatToolCall("github_commit", { repo: "owner/name", ref: "abc123", page: 2, token: "private" }),
    "github_commit owner/name@abc123 · page 2",
  );
});

test("unknown tools and legacy malformed JSON never expose arbitrary arguments", () => {
  assert.equal(formatToolCall("mystery", { password: "private", payload: "secret" }), "mystery called");
  const malformed = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "mystery {\"password\":\"private",
  });
  assert.deepEqual(malformed, { tool: "mystery", summary: "called" });
  assert.doesNotMatch(`${malformed.tool} ${malformed.summary}`, /private|password/);
});

test("legacy JSON calls use the same specialized formatter", () => {
  const sg = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "sg {\"pattern\":\"foo($A)\",\"path\":\"src\",\"language\":\"ts\"}",
  });
  assert.deepEqual(sg, { tool: "sg", summary: "/foo($A)/ in src · ts" });
  const github = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "github_read {\"repo\":\"owner/name\",\"path\":\"README.md\"}",
  });
  assert.deepEqual(github, { tool: "github_read", summary: "owner/name:README.md" });
});

test("latest summaries ignore result payloads and redact credentials", () => {
  const summary = latestToolCallSummary([
    { kind: "tool", phase: "start", text: "sg {\"kind\":\"identifier\",\"path\":\"src\"}" },
    { kind: "tool", phase: "end", text: "sg: SECRET RESULT password=private" },
    { kind: "tool", phase: "start", text: "github_search code: bearer ghp_secret" },
    { kind: "tool", phase: "end", text: "github_search: SECRET RESULT" },
  ]);
  assert.equal(summary, "github_search code: bearer [REDACTED]");
  assert.doesNotMatch(summary, /SECRET RESULT|ghp_secret/);
});

await run();
