import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { initTheme } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
initTheme();
const toolExecutionModulePath = new URL(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js",
  import.meta.url,
).href;
const { ToolExecutionComponent } = await import(toolExecutionModulePath);
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateToolDefinition } = await load("../../src/display/tool-renderer.ts");

class FakeClock {
  callbacks = new Map();
  next = 1;
  setInterval = (callback) => { const id = this.next++; this.callbacks.set(id, callback); return id; };
  clearInterval = (id) => { this.callbacks.delete(id); };
  unref = () => {};
}

const execute = async () => ({ content: [{ type: "text", text: "done" }], details: { count: 1 } });
const parameters = Type.Object({ query: Type.String() }, { additionalProperties: false });
const definition = {
  name: "sample",
  label: "Sample",
  description: "sample description",
  promptSnippet: "sample snippet",
  promptGuidelines: ["keep sample behavior"],
  parameters,
  renderShell: "default",
  prepareArguments: (args) => args,
  executionMode: "parallel",
  execute,
  renderCall: () => ({ render: () => ["legacy"], invalidate() {} }),
  renderResult: () => ({ render: () => ["legacy result"], invalidate() {} }),
};

const clock = new FakeClock();
const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
const adapter = {
  describeCall(args) {
    return { version: 1, tool: "sample", family: "workflow", lifecycle: "running", title: "Sample", target: args.query };
  },
  describeResult(result, options) {
    return {
      version: 1,
      tool: "sample",
      family: "workflow",
      lifecycle: options.isPartial ? "running" : "completed",
      ...(options.isPartial ? { qualifiers: ["partial"] } : {}),
      title: "Sample",
      rows: [{ text: result.content[0].text }],
    };
  },
};
const decorated = decorateToolDefinition(definition, runtime, adapter);
for (const key of ["name", "label", "description", "promptSnippet", "promptGuidelines", "parameters", "prepareArguments", "executionMode", "execute"]) {
  assert.equal(decorated[key], definition[key], `${key} must retain identity`);
}
assert.equal(decorated.renderShell, "self");
assert.notEqual(decorated.renderCall, definition.renderCall);
assert.notEqual(decorated.renderResult, definition.renderResult);

const theme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const state = {};
let invalidations = 0;
function context(overrides = {}) {
  return {
    args: { query: "needle" },
    toolCallId: "call-1",
    invalidate() { invalidations += 1; },
    lastComponent: undefined,
    state,
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

const call = decorated.renderCall({ query: "needle" }, theme, context());
assert.match(call.render(80).join("\n"), /Sample.*needle/);
assert.equal(clock.callbacks.size, 1);
for (const callback of clock.callbacks.values()) callback();
assert.equal(invalidations, 1);
const callAgain = decorated.renderCall({ query: "needle" }, theme, context({ lastComponent: call }));
assert.equal(callAgain, call, "renderCall reuses last component");

const partialResult = { content: [{ type: "text", text: "working" }], details: { count: 0 } };
const partial = decorated.renderResult(
  partialResult,
  { expanded: false, isPartial: true },
  theme,
  context({ isPartial: true }),
);
assert.notEqual(partial, call, "Pi keeps distinct call and result renderer slots");
assert.deepEqual(call.render(80), [], "the call slot becomes empty as soon as a result exists");
assert.equal(
  [...call.render(80), ...partial.render(80)].join("\n").match(/Sample/g)?.length,
  1,
  "the composed tool execution renders one operational entry",
);
assert.equal(clock.callbacks.size, 1, "motion subscription transfers to the new component");

const final = decorated.renderResult(
  { content: [{ type: "text", text: "done" }], details: { count: 1 } },
  { expanded: false, isPartial: false },
  theme,
  context({ lastComponent: partial }),
);
assert.equal(final, partial);
assert.equal(clock.callbacks.size, 0, "terminal result unsubscribes motion");
assert.match(final.render(80).join("\n"), /done/);

const errored = decorated.renderResult(
  { content: [{ type: "text", text: "failed" }], details: {} },
  { expanded: false, isPartial: false },
  theme,
  context({ lastComponent: final, isError: true }),
);
assert.match(errored.render(80)[0], /●/);

const piComponent = new ToolExecutionComponent(
  "sample",
  "pi-call-1",
  { query: "needle" },
  {},
  decorated,
  { requestRender() {} },
  process.cwd(),
);
piComponent.markExecutionStarted();
piComponent.setArgsComplete();
assert.equal(
  (stripVTControlCharacters(piComponent.render(80).join("\n")).match(/Sample/g) ?? []).length,
  1,
  "Pi call composition starts with one operational entry",
);
piComponent.updateResult({ content: [{ type: "text", text: "done" }], details: { count: 1 } }, false);
const piFinal = stripVTControlCharacters(piComponent.render(80).join("\n"));
assert.equal(
  (piFinal.match(/Sample/g) ?? []).length,
  1,
  "Pi call/result composition must replace the pending entry instead of retaining it",
);
assert.match(piFinal, /done/);
runtime.dispose();

const asyncRuntime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false, test: true } });
let resolveHydration;
let hydrationCalls = 0;
let asyncInvalidations = 0;
const asyncDefinition = decorateToolDefinition(definition, asyncRuntime, {
  describeCall(args) {
    return { version: 1, tool: "sample", family: "workflow", lifecycle: "running", title: "Sample", target: args.query };
  },
  callDescriptionKey(args) { return args.query; },
  describeCallAsync(args) {
    hydrationCalls += 1;
    return new Promise((resolve) => {
      resolveHydration = () => resolve({
        version: 1,
        tool: "sample",
        family: "workflow",
        lifecycle: "running",
        title: "Sample",
        target: args.query,
        rows: [{ text: "hydrated preview" }],
      });
    });
  },
  describeResult(result) {
    return { version: 1, tool: "sample", family: "workflow", lifecycle: "completed", title: "Sample", rows: [{ text: result.content[0].text }] };
  },
});
const asyncState = {};
const asyncContext = (overrides = {}) => context({
  state: asyncState,
  executionStarted: false,
  invalidate() { asyncInvalidations += 1; },
  ...overrides,
});
const hydrating = asyncDefinition.renderCall({ query: "first" }, theme, asyncContext({ args: { query: "first" } }));
asyncDefinition.renderCall({ query: "first" }, theme, asyncContext({ args: { query: "first" }, lastComponent: hydrating }));
assert.equal(hydrationCalls, 1, "re-rendering a pending call must not duplicate async preview work");
resolveHydration();
await Promise.resolve();
await Promise.resolve();
assert.equal(asyncInvalidations, 1);
assert.match(hydrating.render(80).join("\n"), /hydrated preview/);

const staleCall = asyncDefinition.renderCall({ query: "second" }, theme, asyncContext({ args: { query: "second" }, lastComponent: hydrating }));
assert.equal(hydrationCalls, 2);
const settled = asyncDefinition.renderResult(
  { content: [{ type: "text", text: "settled result" }], details: {} },
  { expanded: true, isPartial: false },
  theme,
  asyncContext({ args: { query: "second" }, lastComponent: staleCall }),
);
resolveHydration();
await Promise.resolve();
await Promise.resolve();
assert.match(settled.render(80).join("\n"), /settled result/);
assert.doesNotMatch(settled.render(80).join("\n"), /hydrated preview/, "late call hydration must not overwrite a result");
asyncRuntime.dispose();

console.log("display tool renderer tests: OK");
