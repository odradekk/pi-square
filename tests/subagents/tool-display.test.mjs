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

test("PDF search summaries expose only bounded query and path arguments", () => {
  assert.equal(
    formatToolCall("pdf_search", { query: "installation guide", path: "manual.pdf", secret: "private" }),
    "pdf_search installation guide in manual.pdf",
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
  const pdf = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "pdf_search {\"query\":\"installation guide\",\"path\":\"manual.pdf\"}",
  });
  assert.deepEqual(pdf, { tool: "pdf_search", summary: "installation guide in manual.pdf" });
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
