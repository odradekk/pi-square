import assert from "node:assert/strict";
import { Type } from "typebox";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { createTimeToolDefinition } = await load("../../src/time/index.ts");
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
  ["rg", { pattern: "needle", path: "src" }, /needle/],
  ["fd", { pattern: "*.ts", path: "src" }, /\*\.ts/],
  ["sg", { kind: "identifier", path: "src" }, /identifier/],
  ["pdf_search", { path: "manual.pdf", query: "retention", limit: 5 }, /retention/],
  ["codegraph", { operation: "explore", projectPath: ".", query: "runtime", maxFiles: 5 }, /explore/],
  ["bash", { command: "printf 'hello'", timeout: 10 }, /printf 'hello'/],
  ["pwsh", { command: "Get-ChildItem", timeoutMs: 1000 }, /Get-ChildItem/],
  ["scheme", { code: "(display \"ok\")", access: "readonly", timeoutMs: 1000 }, /display/],
  ["ssh", { operation: "secret_input", session: "session-1", prompt: "credential", data: "never-show" }, /secure input requested/],
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
  assert.doesNotMatch(collapsed.render(80).join("\n"), /model output/, `${name} summary hides preview`);
  const expanded = decorated.renderResult(result, { expanded: true, isPartial: false }, theme, context(args, { expanded: true }));
  assert.match(expanded.render(80).join("\n"), /model output/);
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
  }
}

const dynamic = decorateInternalTool(definition("rg"), () => runtime);
const result = { content: [{ type: "text", text: "dynamic preview" }], details: { returned: 1 } };
assert.doesNotMatch(dynamic.renderResult(result, { expanded: false, isPartial: false }, theme, context({ pattern: "x" })).render(80).join("\n"), /dynamic preview/);
runtime.dispose();
const previewConfig = structuredClone(DEFAULT_CONFIG);
previewConfig.display = {
  motion: "off",
  agent: { path: "/agent/config/pi-square.json", config: { tools: { rg: { resultMode: "preview" } } } },
};
runtime = new DisplayRuntime(previewConfig, { environment: { isTTY: true } });
assert.match(dynamic.renderResult(result, { expanded: false, isPartial: false }, theme, context({ pattern: "x" })).render(80).join("\n"), /dynamic preview/, "provider resolves replacement runtime");

const time = createTimeToolDefinition();
const timeResult = await time.execute("time", {}, undefined, undefined, {});
assert.match(timeResult.content[0].text, /^\d{4}-\d{2}-\d{2}/);
assert.match(timeResult.content[0].text, /ISO 8601:/);
assert.match(timeResult.content[0].text, /Timezone:/);

for (const child of createChildTools(["rg", "fd", "sg", "codegraph", "pdf_search", "scheme"]).definitions) {
  assert.notEqual(child.renderShell, "self", `${child.name} child construction stays independent of parent runtime`);
}
runtime.dispose();
console.log("display local/execution migration tests: OK");
