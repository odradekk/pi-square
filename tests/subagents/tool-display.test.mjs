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

test("summaries carry only tool identity and structurally safe metadata", () => {
  assert.equal(
    formatToolCall("web_search", { queries: ["installation guide"], no_cache: true, secret: "private" }),
    "web_search 1 query",
  );
  assert.equal(formatToolCall("web_fetch", { urls: ["https://a.test", "https://b.test"] }), "web_fetch 2 URLs");
  assert.equal(formatToolCall("read", { path: "/tmp/ghp_secret", offset: 10, limit: 40 }), "read lines 10-49");
  assert.equal(formatToolCall("read", { path: "/tmp/ghp_secret" }), "read called");
  assert.equal(formatToolCall("grep", { pattern: "sk-proj-THIS_IS_A_CREDENTIAL", path: "." }), "grep called");
  assert.equal(formatToolCall("find", { pattern: "ghp_secret", path: "." }), "find called");
  assert.equal(formatToolCall("ls", { path: "/tmp/ghp_secret" }), "ls called");
  assert.equal(formatToolCall("library_search", { libraryName: "sk-proj-THIS_IS_A_CREDENTIAL" }), "library_search called");
  assert.equal(formatToolCall("library_docs", { libraryId: "x/ghp_secret" }), "library_docs called");
  assert.equal(formatToolCall("replace", { path: "/tmp/ghp_secret" }), "replace called");
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
    text: "web_search {\"queries\":[\"installation guide\",\"second\"],\"limit\":5}",
  });
  assert.deepEqual(webSearch, { tool: "web_search", summary: "2 queries" });
  const grep = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: "grep {\"pattern\":\"sk-proj-THIS_IS_A_CREDENTIAL\",\"path\":\".\"}",
  });
  assert.deepEqual(grep, { tool: "grep", summary: "called" });
});

test("latest summaries render identity only for free-form timeline text", () => {
  const summary = latestToolCallSummary([
    { kind: "tool", phase: "start", text: "docs search: bearer ghp_secret" },
    { kind: "tool", phase: "end", text: "docs: SECRET RESULT" },
  ]);
  assert.equal(summary, "docs called");
  assert.doesNotMatch(summary, /SECRET RESULT|ghp_secret|bearer/);
});

test("shell tools expose only a generic summary; command text never displays", () => {
  const hostile = [
    "curl -ualice:swordfish https://api.test",
    "curl --user=alice:swordfish https://api.test",
    "curl https://alice:swordfish@example.test",
    "AWS_SECRET_ACCESS_KEY=swordfish aws s3 ls",
    "aws configure set aws_secret_access_key swordfish",
    'deploy --token "my secret value"',
  ];
  for (const command of hostile) {
    assert.deepEqual(toolDisplayFromArgs("bash", { command }), { tool: "bash", summary: "called" });
    assert.deepEqual(toolDisplayFromArgs("pwsh", { command }), { tool: "pwsh", summary: "called" });
    assert.equal(formatToolCall("bash", { command }), "bash called");
    const call = formatToolCall("pwsh", { command });
    assert.doesNotMatch(call, /swordfish|alice|my secret|AWS_SECRET|example\.test/);
  }
  // The JSON-envelope timeline form a child run actually produces.
  const timeline = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: `bash ${JSON.stringify({ command: hostile[0] })}`,
  });
  assert.deepEqual(timeline, { tool: "bash", summary: "called" });
  assert.equal(latestToolCallSummary([
    { kind: "tool", phase: "start", text: `bash ${JSON.stringify({ command: hostile[3] })}` },
    { kind: "tool", phase: "end", text: "SECRET RESULT" },
  ]), "bash called");
});

await run();
