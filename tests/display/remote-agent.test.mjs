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
  ["ask", { questions: [{ id: "secret-question", text: "private question", options: [] }] }, /Questions/],
  ["todo", { action: "set", todos: [{ text: "private task" }] }, /set/],
  ["delegate_subagent", { agent: "explorer", task: "inspect runtime" }, /inspect runtime/],
  ["resume_subagent", { id: "subagent_12345678", task: "continue review" }, /continue review/],
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
  const resultIdentity = name === "delegate_subagent"
    ? /explorer/
    : name === "resume_subagent"
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
  const hasStructuredDomain = name === "todo" || name === "ask";
  const isWebTool = ["search", "fetch", "libs", "docs", "parse"].includes(name);
  if (!hasStructuredDomain && !isWebTool) {
    assert.match(expandedText, /private result body/);
  }
  // REQUEST, SUMMARY, ACTION, and RESULT sections are pruned restating titles (C8).
}

// The delegate tool returns immediately with the queued job record, so its
// collapsed result is the queued outcome and the expanded body carries the
// queued row plus the task evidence.
const subagentArgs = { agent: "explorer", task: "inspect runtime" };
const subagent = decorateSubagentTool(fake("delegate_subagent"), runtime);
const queuedDetails = {
  version: 4,
  id: "subagent_12345678-1234-4123-8123-123456789abc",
  operation: "delegate",
  phase: "queued",
  agent: { name: "explorer", effort: "high" },
  task: "inspect runtime",
  cwd: process.cwd(),
  model: "provider/model",
  startedAt: Date.now() - 4_200,
  finalText: "",
  retries: 0,
  toolErrors: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  timeline: [{ kind: "status", text: "queued background subagent job" }],
};
const queued = subagent.renderResult(
  { content: [{ type: "text", text: "Queued background subagent subagent_12345678." }], details: queuedDetails },
  { expanded: false, isPartial: false },
  theme,
  context(subagentArgs),
).render(80).join("\n");
assert.match(queued, /explorer/);
assert.match(queued, /Queued in the parent session · run 12345678/, "queued result states the queued outcome with the run id");
const unnamedQueued = subagent.renderResult(
  { content: [{ type: "text", text: "Queued background subagent subagent_12345678." }], details: { ...queuedDetails, agent: undefined } },
  { expanded: false, isPartial: false },
  theme,
  context({ task: "inspect runtime" }),
).render(80).join("\n");
assert.match(unnamedQueued, /Subagent 12345678/, "a queued generic run shows the short id as the target");
const expandedQueued = subagent.renderResult(
  { content: [{ type: "text", text: "Queued background subagent subagent_12345678." }], details: queuedDetails },
  { expanded: true, isPartial: false },
  theme,
  context(subagentArgs, { expanded: true }),
).render(80).join("\n");
assert.match(expandedQueued, /Queued in the parent session/);
assert.match(expandedQueued, /Task/);
assert.doesNotMatch(expandedQueued, /inspect runtime\n.*inspect runtime\n.*inspect runtime/, "task evidence stays bounded");

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

for (const child of createChildTools(["search", "fetch", "libs", "docs", "pdf_search"]).definitions) {
  assert.notEqual(child.renderShell, "self", `${child.name} child factory remains runtime-independent`);
}

runtime.dispose();
console.log("display remote/agent migration tests: OK");
