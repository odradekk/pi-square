import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  formatToolCall,
  latestManagerToolCallSummary,
  latestRosterToolCallSummary,
  managerToolArgsDisplay,
  rosterToolArgsDisplay,
  sanitizeToolActivityArgs,
} = await load(join(packageRoot, "src", "subagents", "tool-display.ts"));

test("shared summaries keep their existing bounded activity evidence", () => {
  assert.equal(
    formatToolCall("web_search", { queries: ["installation guide"], no_cache: true, secret: "private" }),
    "web_search 1 query: installation guide",
  );
  assert.equal(formatToolCall("replace", { path: "src/a.txt", replacement_text: "private" }), "replace src/a.txt");
  assert.equal(formatToolCall("read", { path: "src/a.txt", offset: 10, limit: 40 }), "read src/a.txt:10-49");
});

test("unknown tools never expose arbitrary arguments", () => {
  assert.equal(formatToolCall("mystery", { password: "private", payload: "secret" }), "mystery called");
  assert.equal(rosterToolArgsDisplay("mystery", { password: "private" }).tool, "tool");
  assert.equal(managerToolArgsDisplay("mystery", { password: "private" }).summary, "called");
});

test("timeline summaries read structured fields, never the human text line", () => {
  const timeline = [
    { kind: "tool", phase: "start", tool: "read", args: { path: "src/a.txt", offset: 10, limit: 40 }, text: "read src/a.txt:10-49" },
    { kind: "tool", phase: "end", tool: "read", text: "read: ok" },
  ];
  assert.equal(latestManagerToolCallSummary(timeline), "read src/a.txt:10-49");
  assert.equal(latestRosterToolCallSummary(timeline), "read lines 10-49");
});

test("manager summaries ignore result payloads and redact credentials", () => {
  const summary = latestManagerToolCallSummary([
    { kind: "tool", phase: "start", tool: "grep", args: { pattern: "bearer ghp_secret", path: "." }, text: "grep /bearer ghp_secret/ in ." },
    { kind: "tool", phase: "end", tool: "grep", text: "grep: SECRET RESULT" },
  ]);
  assert.equal(summary, "grep /bearer [REDACTED]/ in .");
  assert.doesNotMatch(summary, /SECRET RESULT|ghp_secret/);
});

test("the default projection never lets free-form arguments appear verbatim", () => {
  const item = {
    kind: "tool",
    phase: "start",
    tool: "read",
    args: sanitizeToolActivityArgs({ path: "/tmp/ghp_secret", offset: 10, limit: 40, password: "hunter2" }),
    text: "read /tmp/ghp_secret:10-49",
  };
  const summary = latestRosterToolCallSummary([item]);
  assert.equal(summary, "read lines 10-49");
  assert.doesNotMatch(summary, /ghp_secret|hunter2|\/tmp/);

  const direct = rosterToolArgsDisplay("grep", { pattern: "sk-proj-THIS_IS_A_CREDENTIAL", path: "." });
  assert.deepEqual(direct, { tool: "grep", summary: "called" });
  const search = rosterToolArgsDisplay("web_search", { queries: ["sk-proj-THIS_IS_A_CREDENTIAL"] });
  assert.deepEqual(search, { tool: "web_search", summary: "1 query" });
  assert.doesNotMatch(`${search.tool} ${search.summary}`, /sk-proj/);
});

test("non-catalog tool identities never render as a known tool", () => {
  for (const tool of ["swordfish", "credential_tool", "read credential", ""]) {
    const display = rosterToolArgsDisplay(tool, { path: "src/a.txt" });
    assert.equal(display.tool, "tool", `identity '${tool}' stays anonymous`);
    assert.equal(display.summary, "called");
  }
  const summary = latestRosterToolCallSummary([
    { kind: "tool", phase: "start", tool: "ghp_deadbeef", args: { ran: true }, text: "ghp_deadbeef: ran" },
  ]);
  assert.equal(summary, "tool called");
});

test("legacy text-only entries degrade to an anonymous tool", () => {
  // Entries persisted before the structured form carry no tool/args; the
  // projections must not adopt an identity from the human text line.
  const summary = latestRosterToolCallSummary([
    { kind: "tool", phase: "start", text: "read src/a.txt:10-49" },
  ]);
  assert.equal(summary, "tool called");
  const wide = latestManagerToolCallSummary([
    { kind: "tool", phase: "start", text: "read src/a.txt:10-49" },
  ]);
  assert.equal(wide, "tool called");
  assert.doesNotMatch(wide, /src\/a\.txt/);
});

test("roster summaries expose only cataloged identity and structural metadata", () => {
  const cases = [
    [{ tool: "read", args: { path: "src/a.txt", offset: 10, limit: 40 } }, "read lines 10-49"],
    [{ tool: "web_search", args: { queries: ["credential-shaped query", "second"] } }, "web_search 2 queries"],
    [{ tool: "web_fetch", args: { urls: ["https://a.test", "https://b.test", "https://c.test"] } }, "web_fetch 3 URLs"],
    [{ tool: "grep", args: { pattern: "credential-shaped", path: "." } }, "grep called"],
    [{ tool: "bash", args: { command: "curl -u alice:swordfish" } }, "bash called"],
  ];
  for (const [activity, expected] of cases) {
    const summary = latestRosterToolCallSummary([
      { kind: "tool", phase: "start", text: "ignored", ...activity },
    ]);
    assert.equal(summary, expected);
  }
});

test("timeline activity stays bounded under hostile structured input", () => {
  const longCount = latestRosterToolCallSummary([{
    kind: "tool",
    phase: "start",
    tool: "web_search",
    args: { queries: Array.from({ length: 500 }, () => "secret") },
    text: `web_search ${"9".repeat(500)} queries: secret`,
  }]);
  assert.ok(Array.from(longCount).length <= 64 + 1 + 120, "roster activity remains bounded");
  assert.doesNotMatch(longCount, /secret/);

  const wide = latestManagerToolCallSummary([{
    kind: "tool",
    phase: "start",
    tool: "bash",
    args: { command: `x${"y".repeat(10_000)}` },
    text: "bash called",
  }]);
  assert.ok(Array.from(wide).length <= 64 + 1 + 120, "manager activity remains bounded");
});

test("sanitizeToolActivityArgs keeps structure safe, bounded, and frozen", () => {
  const args = sanitizeToolActivityArgs({
    path: "src/a.txt",
    offset: 10,
    limit: 40,
    nested: { command: "deploy \u001b[31m--token swordfish" },
    list: [1, "two", null, true, undefined, () => {}],
    huge: "z".repeat(5000),
    deep: { a: { b: { c: { d: { e: "lost" } } } } },
  });
  assert.equal(args.path, "src/a.txt");
  assert.equal(args.offset, 10);
  assert.equal(args.limit, 40);
  assert.doesNotMatch(String(args.nested.command), /\u001b|swordfish/);
  assert.deepEqual(args.list.slice(0, 4), [1, "two", null, true]);
  assert.ok(Array.from(String(args.huge)).length <= 203, "long strings clip to the per-value bound");
  assert.deepEqual(args.deep, { a: { b: {} } }, "nesting deeper than the depth bound is pruned");
  assert.ok(Object.isFrozen(args), "stored args are frozen against snapshot sharing");
  assert.equal(sanitizeToolActivityArgs("not an object").huge, undefined);
  assert.equal(sanitizeToolActivityArgs(null).path, undefined);
});

await run();
