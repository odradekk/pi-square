import assert from "node:assert/strict";
import { Type } from "typebox";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
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
  ["github_search", { kind: "code", query: "repo:owner/name ghp_SECRET" }, /repo:owner\/name/],
  ["github_read", { repo: "owner/name", path: "README.md", ref: "main" }, /README\.md/],
  ["github_tree", { repo: "owner/name", path: "src", ref: "main" }, /src/],
  ["github_commit", { repo: "owner/name", ref: "abcdef" }, /abcdef/],
  ["ask", { questions: [{ id: "secret-question", text: "private question", options: [] }] }, /questions=1/],
  ["todo", { action: "set", todos: [{ text: "private task" }] }, /set/],
  ["subagent_delegate", { agent: "explorer", mode: "fg", task: "inspect runtime" }, /inspect runtime/],
  ["subagent_resume", { id: "subagent_12345678", task: "continue review" }, /continue review/],
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
  assert.doesNotMatch(collapsed.render(80).join("\n"), /private result body/);
  const expanded = decorated.renderResult(result, { expanded: true, isPartial: false }, theme, context(args, { expanded: true }));
  assert.match(expanded.render(80).join("\n"), /private result body/);
}

for (const child of createChildTools([
  "search", "fetch", "libs", "docs", "github_search", "github_read", "github_tree", "github_commit",
]).definitions) {
  assert.notEqual(child.renderShell, "self", `${child.name} child factory remains runtime-independent`);
}

runtime.dispose();
console.log("display remote/agent migration tests: OK");
