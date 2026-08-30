import assert from "node:assert/strict";
import { Type } from "typebox";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { decorateSubagentTool } = await load("../../src/subagents/display-adapter.ts");
const { createChildTools } = await load("../../src/tool-catalog.ts");

const theme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });

function fake(name) {
  const execute = async () => ({ content: [{ type: "text", text: "private result body" }], details: { status: "success", returned: 1 } });
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute,
  };
}
function context(args, overrides = {}) {
  return {
    args,
    toolCallId: "remote",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

const cases = [
  ["search", { queries: ["display systems"], sites: ["example.test"], limit: 5 }, /display systems/],
  ["fetch", { urls: ["https://example.test/a"], mode: "readable" }, /example\.test/],
  ["libs", { libraryName: "react", query: "context" }, /react/],
  ["docs", { libraryId: "/facebook/react", query: "context" }, /facebook\/react/],
  ["parse", { path: "manual.pdf", pages: "1-3", mode: "auto" }, /manual\.pdf/],
  ["github", { operation: "search", kind: "code", query: "repo:owner/name ghp_SECRET" }, /repo:owner\/name/],
  ["github", { operation: "read", repo: "owner/name", path: "README.md", ref: "main" }, /README\.md/],
  ["github", { operation: "tree", repo: "owner/name", path: "src", ref: "main" }, /src/],
  ["github", { operation: "commit", repo: "owner/name", ref: "abcdef" }, /abcdef/],
  ["ask", { questions: [{ id: "secret-question", text: "private question", options: [] }] }, /Questions/],
  ["todo", { action: "set", todos: [{ text: "private task" }] }, /set/],
  ["delegate", { agent: "explorer", mode: "fg", task: "inspect runtime" }, /inspect runtime/],
  ["resume", { id: "subagent_12345678", task: "continue review" }, /continue review/],
];

for (const [name, args, expected] of cases) {
  const original = fake(name);
  const decorated = decorateInternalTool(original, runtime);
  assert.equal(decorated.execute, original.execute);
  assert.equal(decorated.renderShell, "self");
  const call = decorated.renderCall(args, theme, context(args));
  const callText = call.render(80).join("\n");
  assert.match(callText, expected, `${name} identity`);
  assert.doesNotMatch(callText, /ghp_SECRET|private question|private task/);
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(call.render(width).every((line) => visibleWidth(line) <= width), `${name} exceeded ${width}`);
  }

  const result = { content: [{ type: "text", text: "private result body" }], details: { status: "success", returned: 1 } };
  const collapsed = decorated.renderResult(result, { expanded: false, isPartial: false }, theme, context(args));
  const collapsedText = collapsed.render(80).join("\n");
  const resultIdentity = name === "delegate"
    ? /explorer/
    : name === "resume"
      ? /subagent_12345678/
      : expected;
  assert.match(collapsedText, resultIdentity, `${name} result identity`);
  // C4 revision: collapsed entries are exactly one row. The inline summary
  // states the outcome; payload content is visible only when expanded.
  assert.doesNotMatch(collapsedText, /private result body/, `${name} collapsed hides the payload`);
  const expanded = decorated.renderResult(result, { expanded: true, isPartial: false }, theme, context(args, { expanded: true }));
  const expandedText = expanded.render(80).join("\n");
  // Tools with structured domain sections (tree/commit) carry content
  // through records or empty-state indicators rather than the raw text
  // fallback; other tools expose the text via output fallback or a
  // content/markdown section.
  const hasStructuredDomain = name === "github" || name === "todo" || name === "ask";
  const isWebTool = ["search", "fetch", "libs", "docs", "parse"].includes(name);
  if (!hasStructuredDomain && !isWebTool) {
    assert.match(expandedText, /private result body/);
  }
  // REQUEST, SUMMARY, ACTION, and RESULT sections are pruned restating titles (C8).
}

const subagentArgs = { agent: "explorer", mode: "fg", task: "inspect runtime" };
const subagent = decorateSubagentTool(fake("delegate"), runtime);
const subagentDetails = {
  version: 3,
  id: "subagent_12345678-1234-4123-8123-123456789abc",
  mode: "fg",
  phase: "running",
  agent: { name: "explorer", effort: "high" },
  task: "inspect runtime",
  cwd: process.cwd(),
  model: "provider/model",
  startedAt: Date.now() - 4_200,
  finalText: "",
  liveText: "scanning repository for candidates\nfound 3 matches",
  retries: 0,
  toolErrors: [],
  usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  timeline: [{ kind: "tool", phase: "start", text: 'rg {"pattern":"needle","path":"src"}' }],
};
const running = subagent.renderResult(
  { content: [{ type: "text", text: subagentDetails.liveText }], details: subagentDetails },
  { expanded: false, isPartial: true },
  theme,
  context(subagentArgs, { isPartial: true }),
).render(80).join("\n");
assert.match(running, /explorer/);
// C4 revision: the collapsed running entry is one row; the inline summary
// states the running outcome, and the live text is visible only expanded.
assert.match(running, /running · 1 turns/, "collapsed running shows the inline outcome head");
  assert.match(running, /run 12345678/, "collapsed running keeps the run id tail through elision");
assert.doesNotMatch(running, /scanning repository|found 3 matches/, "collapsed running hides the live text");
// Activity rows never appear in the collapsed body
assert.doesNotMatch(running, /Activity/);
const expandedSubagent = subagent.renderResult(
  { content: [{ type: "text", text: subagentDetails.liveText }], details: subagentDetails },
  { expanded: true, isPartial: true },
  theme,
  context(subagentArgs, { isPartial: true, expanded: true }),
).render(80).join("\n");
assert.match(expandedSubagent, /Live/);
assert.match(expandedSubagent, /Activity/);
assert.match(expandedSubagent, /Usage/);
assert.doesNotMatch(running, /Completed/);

const webSearch = decorateInternalTool(fake("search"), runtime);
const webExpanded = webSearch.renderResult({
  content: [{ type: "text", text: "model output" }],
  details: {
    queries: ["Pi coding agent GitHub repository"],
    failedQueries: [],
    count: 1,
    phase: "done",
    totalBeforeDedup: 1,
    totalAfterDedup: 1,
    results: [{ title: "earendil-works/pi", url: "https://github.com/earendil-works/pi", description: "Pi agent toolkit", provenance: "[q1#1]" }],
  },
}, { expanded: true, isPartial: false }, theme, context({ queries: ["Pi coding agent GitHub repository"], limit: 5 }, { expanded: true })).render(100);
const resultTitleLine = webExpanded.find((line) => line.includes("earendil-works/pi"));
assert.ok(webExpanded[0]?.startsWith("● Web search"), "tool header remains flush-left");
assert.ok(resultTitleLine?.startsWith("  ") && resultTitleLine?.includes("earendil-works/pi"), "result record is indented under the quiet body indent");

for (const child of createChildTools([
  "search", "fetch", "libs", "docs", "github_search", "github_read", "github_tree", "github_commit",
]).definitions) {
  assert.notEqual(child.renderShell, "self", `${child.name} child factory remains runtime-independent`);
}

runtime.dispose();
console.log("display remote/agent migration tests: OK");
