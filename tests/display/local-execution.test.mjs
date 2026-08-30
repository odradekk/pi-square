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

function definition(name) {
  const execute = async () => ({ content: [{ type: "text", text: "model output\nsecond line" }], details: { status: "success", returned: 2 } });
  return {
    name,
    label: name,
    description: `${name} description`,
    promptSnippet: `${name} snippet`,
    promptGuidelines: [`${name} guideline`],
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "parallel",
    execute,
    renderCall: () => ({ render: () => ["legacy"], invalidate() {} }),
    renderResult: () => ({ render: () => ["legacy"], invalidate() {} }),
  };
}

function context(args, overrides = {}) {
  return {
    args,
    toolCallId: "display-local",
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

let runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });
for (const [name, args, expected] of [
  ["pdf_search", { path: "manual.pdf", query: "retention", limit: 5 }, /retention/],
  ["codegraph", { operation: "explore", projectPath: ".", query: "runtime", maxFiles: 5 }, /CodeGraph explore/],
  ["bash", { command: "printf 'hello'", timeout: 10 }, /printf 'hello'/],
  ["pwsh", { command: "Get-ChildItem", timeoutMs: 1000 }, /Get-ChildItem/],
  ["ssh", { operation: "secret_input", session: "session-1", prompt: "credential", data: "never-show" }, /secret_input/],
]) {
  const original = definition(name);
  const decorated = decorateInternalTool(original, () => runtime);
  assert.equal(decorated.execute, original.execute);
  assert.equal(decorated.parameters, original.parameters);
  assert.equal(decorated.promptSnippet, original.promptSnippet);
  assert.equal(decorated.promptGuidelines, original.promptGuidelines);
  assert.equal(decorated.executionMode, original.executionMode);
  assert.equal(decorated.renderShell, "self");
  const call = decorated.renderCall(args, theme, context(args));
  const renderedCall = call.render(80).join("\n");
  assert.match(renderedCall, expected, `${name} call identity`);
  assert.doesNotMatch(renderedCall, /never-show/);

  const result = { content: [{ type: "text", text: "model output\nsecond line" }], details: { status: "success", returned: 2 } };
  const collapsed = decorated.renderResult(result, { expanded: false, isPartial: false }, theme, context(args));
  const collapsedText = collapsed.render(80).join("\n");
  // C4 revision: collapsed entries are exactly one row for every tool except
  // the mutation family. The outcome summary renders inline in that row;
  // payload output is visible only when expanded.
  assert.match(collapsedText, /2 (matches|files|results|lines)|Secret input sent/, `${name} collapsed shows the inline summary`);
  assert.doesNotMatch(collapsedText, /model output/, `${name} collapsed hides the payload`);
  const expanded = decorated.renderResult(result, { expanded: true, isPartial: false }, theme, context(args, { expanded: true }));
  const expandedText = expanded.render(80).join("\n");
  if (name === "ssh") {
    // The ssh call renders an expanded-only structured section; a visible
    // structured section takes priority over the flat text preview, so the
    // raw "model output" fallback does not render here.
  } else {
    assert.match(expandedText, /model output/);
  }
  if (name === "bash" || name === "pwsh") {
    // Execution tools show the output content in expanded mode. Short
    // commands do not get a Command section (C8/defect 45).
    assert.match(expandedText, /model output/);
  }

  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
  }
}

const dynamic = decorateInternalTool(definition("pdf_search"), () => runtime);
const result = { content: [{ type: "text", text: "dynamic preview" }], details: { returned: 1 } };
assert.match(dynamic.renderResult(result, { expanded: true, isPartial: false }, theme, context({ path: "manual.pdf", query: "x" }, { expanded: true })).render(80).join("\n"), /dynamic preview/, "expanded shows the preview content");
assert.doesNotMatch(dynamic.renderResult(result, { expanded: false, isPartial: false }, theme, context({ path: "manual.pdf", query: "x" })).render(80).join("\n"), /dynamic preview/, "collapsed hides the preview payload");
runtime.dispose();
const summaryConfig = structuredClone(DEFAULT_CONFIG);
summaryConfig.display = {
  motion: "off",
  agent: { path: "/agent/config/pi-square.json", config: { tools: { pdf_search: { resultMode: "summary" } } } },
};

for (const child of createChildTools(["codegraph", "pdf_search"]).definitions) {
  assert.notEqual(child.renderShell, "self", `${child.name} child construction stays independent of parent runtime`);
}
runtime.dispose();
console.log("display local/execution migration tests: OK");
