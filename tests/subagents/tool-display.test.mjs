import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  latestRosterToolCallSummary,
  rosterToolArgsDisplay,
  sanitizeToolActivityArgs,
  toolArgCounts,
} = await load(join(packageRoot, "src", "subagents", "tool-display.ts"));
const {
  latestManagerToolCallSummary,
  managerToolArgsDisplay,
  managerToolCallText,
} = await load(join(packageRoot, "src", "subagents", "manager-tool-display.ts"));
test("shared summaries keep their existing bounded activity evidence", () => {
  assert.equal(
    managerToolCallText("web_search", { queries: ["installation guide"], no_cache: true, secret: "private" }),
    "web_search 1 query: installation guide",
  );
  assert.equal(managerToolCallText("replace", { path: "src/a.txt", replacement_text: "private" }), "replace src/a.txt");
  assert.equal(managerToolCallText("read", { path: "src/a.txt", offset: 10, limit: 40 }), "read src/a.txt:10-49");
});

test("unknown tools never expose arbitrary arguments", () => {
  assert.equal(managerToolCallText("mystery", { password: "private", payload: "secret" }), "mystery called");
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

test("construction-point list counts keep the true cardinality after truncation", () => {
  // 40 short queries exceed the 32-item cap; the parent-authored count on
  // the item keeps the projection truthful and matches the human `text` line.
  const rawMany = { queries: Array.from({ length: 40 }, (_, i) => `q${i}`) };
  const argsMany = sanitizeToolActivityArgs(rawMany);
  const countsMany = toolArgCounts("web_search", rawMany);
  assert.deepEqual(countsMany, { queries: 40 });
  assert.equal(rosterToolArgsDisplay("web_search", argsMany, countsMany).summary, "40 queries");
  assert.equal(managerToolArgsDisplay("web_search", argsMany, countsMany).summary.startsWith("40 queries: q0"), true);
  assert.equal(latestRosterToolCallSummary([
    { kind: "tool", phase: "start", tool: "web_search", args: argsMany, listCounts: countsMany, text: "web_search 40 queries: q0" },
  ]), "web_search 40 queries");

  // 12 long queries exceed the character budget partway; the count stays 12.
  const rawLong = { queries: Array.from({ length: 12 }, () => "query ".repeat(40)) };
  assert.equal(rosterToolArgsDisplay("web_search", sanitizeToolActivityArgs(rawLong), toolArgCounts("web_search", rawLong)).summary, "12 queries");

  const rawUrls = { urls: Array.from({ length: 40 }, (_, i) => `https://example.test/${i}`) };
  assert.equal(rosterToolArgsDisplay("web_fetch", sanitizeToolActivityArgs(rawUrls), toolArgCounts("web_fetch", rawUrls)).summary, "40 URLs");
});

test("a model-crafted { count, items } object never projects a fabricated number", () => {
  const forged = { queries: { count: 999999999, items: ["x"] } };
  // Sanitized timeline path: the forged object survives cleaning as an
  // ordinary argument value; neither tier renders it as a count.
  const args = sanitizeToolActivityArgs(forged);
  assert.deepEqual(rosterToolArgsDisplay("web_search", args, toolArgCounts("web_search", forged)), { tool: "web_search", summary: "called" });
  assert.deepEqual(managerToolArgsDisplay("web_search", args, toolArgCounts("web_search", forged)), { tool: "web_search", summary: "called" });
  // Raw session-arguments path (transcript paging, live events): same rule.
  assert.deepEqual(rosterToolArgsDisplay("web_search", forged), { tool: "web_search", summary: "called" });
  // A parent-authored count still wins over the truncated stored array.
  const truncated = sanitizeToolActivityArgs({ queries: Array.from({ length: 40 }, (_, i) => `q${i}`) });
  assert.equal(Array.isArray(truncated.queries) && truncated.queries.length, 32, "the sanitizer truncates the stored array");
  assert.equal(rosterToolArgsDisplay("web_search", truncated, { queries: 40 }).summary, "40 queries");
});

test("toolArgCounts records only real arrays for the counted tools", () => {
  assert.deepEqual(toolArgCounts("web_search", { queries: ["a", "b"] }), { queries: 2 });
  assert.equal(toolArgCounts("web_search", { queries: { count: 9, items: ["x"] } }), undefined);
  assert.equal(toolArgCounts("web_search", {}), undefined);
  assert.deepEqual(toolArgCounts("web_fetch", { urls: ["u"] }), { urls: 1 });
  assert.equal(toolArgCounts("read", { path: "x" }), undefined);
  assert.equal(toolArgCounts("web_search", null), undefined);
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

test("sanitizeToolActivityArgs keeps structure safe, bounded, and truthful", () => {
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
  assert.deepEqual(args.list, [1, "two", null, true], "arrays truncate to the item cap and drop non-JSON values");
  assert.ok(Array.from(String(args.huge)).length <= 203, "long strings clip to the per-value bound");
  assert.deepEqual(args.deep, { a: { b: {} } }, "nesting deeper than the depth bound is pruned");
  assert.ok(Object.isFrozen(args), "stored args are frozen against snapshot sharing");
  assert.deepEqual(sanitizeToolActivityArgs("not an object"), {});
  assert.deepEqual(sanitizeToolActivityArgs(null), {});
});

await run();
