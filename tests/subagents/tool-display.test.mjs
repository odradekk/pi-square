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

test("web search summaries expose only bounded query arguments", () => {
  assert.equal(
    formatToolCall("web_search", { queries: ["installation guide"], no_cache: true, secret: "private" }),
    "web_search 1 query: installation guide",
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
  const webSearch = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "web_search {\"queries\":[\"installation guide\"],\"limit\":5}",
  });
  assert.deepEqual(webSearch, { tool: "web_search", summary: "1 query: installation guide" });
});

test("latest summaries ignore result payloads and redact credentials", () => {
  const summary = latestToolCallSummary([
    { kind: "tool", phase: "start", text: "docs search: bearer ghp_secret" },
    { kind: "tool", phase: "end", text: "docs: SECRET RESULT" },
  ]);
  assert.equal(summary, "docs search: bearer [REDACTED]");
  assert.doesNotMatch(summary, /SECRET RESULT|ghp_secret/);
});

await run();
