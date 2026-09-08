import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  formatToolCall,
  latestRosterToolCallSummary,
  latestToolCallSummary,
  toolEventDisplay,
} = await load(join(packageRoot, "src", "subagents", "tool-display.ts"));

test("shared summaries keep their existing bounded activity evidence", () => {
  assert.equal(
    formatToolCall("web_search", { queries: ["installation guide"], no_cache: true, secret: "private" }),
    "web_search 1 query: installation guide",
  );
  assert.equal(formatToolCall("replace", { path: "src/a.txt", replacement_text: "private" }), "replace src/a.txt");
  assert.equal(formatToolCall("read", { path: "src/a.txt", offset: 10, limit: 40 }), "read src/a.txt:10-49");
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
  const webSearch = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "web_search {\"queries\":[\"installation guide\"],\"limit\":5}",
  });
  assert.deepEqual(webSearch, { tool: "web_search", summary: "1 query: installation guide" });
});

test("latest shared summaries ignore result payloads and redact credentials", () => {
  const summary = latestToolCallSummary([
    { kind: "tool", phase: "start", text: "docs search: bearer ghp_secret" },
    { kind: "tool", phase: "end", text: "docs: SECRET RESULT" },
  ]);
  assert.equal(summary, "docs search: bearer [REDACTED]");
  assert.doesNotMatch(summary, /SECRET RESULT|ghp_secret/);
});

test("roster summaries expose only cataloged identity and structural metadata", () => {
  const cases = [
    ["read src/a.txt:10-49", "read lines 10-49"],
    ["web_search 2 queries: credential-shaped query", "web_search 2 queries"],
    ["web_fetch 3 URLs", "web_fetch 3 URLs"],
    ["grep /credential-shaped/ in .", "grep called"],
    ["bash curl -u alice:swordfish", "bash called"],
    ["swordfish payload", "tool called"],
    ["ghp_deadbeef: ran", "tool called"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(
      latestRosterToolCallSummary([{ kind: "tool", phase: "start", text }]),
      expected,
    );
  }
});

test("roster summaries safely project legacy structured calls", () => {
  assert.equal(latestRosterToolCallSummary([{
    kind: "tool",
    phase: "start",
    text: 'read {"path":"/tmp/ghp_secret","offset":10,"limit":40}',
  }]), "read lines 10-49");
  assert.equal(latestRosterToolCallSummary([{
    kind: "tool",
    phase: "start",
    text: 'grep {"pattern":"sk-proj-secret","path":"."}',
  }]), "grep called");
  assert.equal(latestRosterToolCallSummary([{
    kind: "tool",
    phase: "start",
    text: 'mystery {"password":"private"}',
  }]), "tool called");
  const longCount = latestRosterToolCallSummary([{
    kind: "tool",
    phase: "start",
    text: `web_search ${"9".repeat(500)} queries: secret`,
  }]);
  assert.ok(Array.from(longCount).length <= 64 + 1 + 120, "roster activity remains bounded");
  assert.doesNotMatch(longCount, /secret/);
});

await run();
