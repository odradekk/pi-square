import assert from "node:assert/strict";
import jiti from "jiti";
import { Type } from "typebox";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime, installGlobalDisplayRuntime } = await load("../../src/display/runtime.ts");
const {
  TOOL_DISPLAY_ADAPTER_QUEUE_MAX,
  decorateToolForDisplay,
  validateToolDisplayAdapterV1,
  __testables,
} = await load("../../src/display/public.ts");

const theme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const parameters = Type.Object({ path: Type.String(), api_key: Type.Optional(Type.String()) }, { additionalProperties: false });
const adapter = {
  version: 1,
  title: "Third-party read",
  family: "filesystem",
  fields: [
    { kind: "path", source: "args", path: ["path"], phase: "both" },
    { kind: "preview", source: "args", path: ["api_key"], label: "input", phase: "call" },
    { kind: "preview", source: "result", path: ["text"], phase: "result" },
    { kind: "url", source: "args", path: ["url"], label: "source", phase: "call" },
    { kind: "count", source: "details", path: ["count"], label: "items", phase: "result" },
  ],
};

function tool(name = "third_party") {
  return {
    name,
    label: name,
    description: "third party",
    parameters,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { count: 1 } }),
  };
}

function context(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-public",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function clean() {
  const active = globalThis[__testables.RUNTIME_SYMBOL];
  active?.runtime?.dispose?.();
  delete globalThis[__testables.RUNTIME_SYMBOL];
  delete globalThis[__testables.QUEUE_SYMBOL];
  __testables.ownership.clear();
  __testables.registrations.clear();
  __testables.cleanupRuntimeIds.clear();
}

clean();
try {
  const queued = tool("queued");
  const before = new Map(["renderShell", "renderCall", "renderResult"].map((key) => [key, Object.getOwnPropertyDescriptor(queued, key)]));
  assert.equal(decorateToolForDisplay(queued, adapter), queued);
  for (const [key, descriptor] of before) assert.deepEqual(Object.getOwnPropertyDescriptor(queued, key), descriptor);
  assert.equal(globalThis[__testables.QUEUE_SYMBOL].entries.length, 1);

  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime);
  assert.equal(globalThis[__testables.QUEUE_SYMBOL].entries.length, 0);
  assert.equal(queued.renderShell, "self");
  assert.equal(typeof queued.renderCall, "function");
  assert.equal(typeof queued.renderResult, "function");
  const args = { path: "src/file.ts", api_key: "api_key=super-secret", url: "https://user:password@example.com/private" };
  const state = {};
  const renderedCall = queued.renderCall(args, theme, context(args, state)).render(80).join("\n");
  assert.match(renderedCall, /src\/file\.ts/);
  assert.match(renderedCall, /\[REDACTED\]/);
  assert.doesNotMatch(renderedCall, /super-secret|user:password|example\.com/);
  const renderedResult = queued.renderResult(
    { content: [{ type: "text", text: "line one\nline two" }], details: { count: 2 } },
    { expanded: true, isPartial: false },
    theme,
    context(args, state),
  ).render(80).join("\n");
  assert.match(renderedResult, /line one/);
  assert.match(renderedResult, /items=2/);
  let resultGetterRan = false;
  const accessorResult = { details: { count: 0 } };
  Object.defineProperty(accessorResult, "content", { enumerable: true, get() { resultGetterRan = true; return []; } });
  queued.renderResult(accessorResult, { expanded: true, isPartial: false }, theme, context(args, state)).render(80);
  assert.equal(resultGetterRan, false, "adapter rendering must not invoke result accessors");

  const replacement = () => ({ render: () => ["external"], invalidate() {} });
  queued.renderResult = replacement;
  runtime.dispose();
  assert.equal(Object.hasOwn(queued, "renderShell"), false);
  assert.equal(Object.hasOwn(queued, "renderCall"), false);
  assert.equal(queued.renderResult, replacement, "dispose must not overwrite a renderer installed by another owner");

  const runtime2 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime2);
  assert.equal(queued.renderShell, "self", "runtime replacement must reactivate declared adapters on the same tool object");
  runtime2.dispose();
  assert.equal(queued.renderResult, replacement);

  clean();
  const originalCall = () => ({ render: () => ["native call"], invalidate() {} });
  const originalResult = () => ({ render: () => ["native result"], invalidate() {} });
  const described = tool("descriptors");
  Object.defineProperties(described, {
    renderShell: { value: "default", writable: true, enumerable: false, configurable: true },
    renderCall: { value: originalCall, writable: true, enumerable: false, configurable: true },
    renderResult: { value: originalResult, writable: true, enumerable: false, configurable: true },
  });
  const originals = new Map(["renderShell", "renderCall", "renderResult"].map((key) => [key, Object.getOwnPropertyDescriptor(described, key)]));
  decorateToolForDisplay(described, adapter);
  const runtime3 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime3);
  runtime3.dispose();
  for (const [key, descriptor] of originals) assert.deepEqual(Object.getOwnPropertyDescriptor(described, key), descriptor, `${key} descriptor was not restored exactly`);

  clean();
  for (let index = 0; index < TOOL_DISPLAY_ADAPTER_QUEUE_MAX; index += 1) {
    decorateToolForDisplay(tool(`queued_${index}`), adapter);
  }
  assert.equal(globalThis[__testables.QUEUE_SYMBOL].entries.length, TOOL_DISPLAY_ADAPTER_QUEUE_MAX);
  assert.throws(() => decorateToolForDisplay(tool("queued_overflow"), adapter), /full.*128/i);

  const getterAdapter = { ...adapter };
  let getterRan = false;
  Object.defineProperty(getterAdapter, "title", { enumerable: true, get() { getterRan = true; return "bad"; } });
  assert.throws(() => validateToolDisplayAdapterV1(getterAdapter), /data property/);
  assert.equal(getterRan, false);
  const accessorPath = [];
  Object.defineProperty(accessorPath, "0", { enumerable: true, get() { getterRan = true; return "path"; } });
  accessorPath.length = 1;
  assert.throws(() => validateToolDisplayAdapterV1({
    ...adapter,
    fields: [{ ...adapter.fields[0], path: accessorPath }],
  }), /data property/);
  assert.equal(getterRan, false);
  assert.throws(() => validateToolDisplayAdapterV1({ ...adapter, title: "x".repeat(81) }), /at most 80/);
  assert.throws(() => validateToolDisplayAdapterV1({ ...adapter, fields: Array.from({ length: 17 }, () => adapter.fields[0]) }), /at most 16/);
  assert.throws(() => validateToolDisplayAdapterV1({
    ...adapter,
    fields: [{ ...adapter.fields[0], path: Array.from({ length: 9 }, () => "x") }],
  }), /1-8 segments/);
  assert.throws(() => validateToolDisplayAdapterV1({
    ...adapter,
    fields: [{ ...adapter.fields[0], path: ["x".repeat(65)] }],
  }), /at most 64/);
  assert.throws(() => validateToolDisplayAdapterV1({
    ...adapter,
    fields: [{ ...adapter.fields[0], label: "x".repeat(33) }],
  }), /at most 32/);
  assert.throws(() => validateToolDisplayAdapterV1({ ...adapter, renderer: () => {} }), /unknown field/);

  clean();
  let queueGetterRan = false;
  Object.defineProperty(globalThis, __testables.QUEUE_SYMBOL, {
    configurable: true,
    get() { queueGetterRan = true; return { version: 1, entries: [] }; },
  });
  assert.throws(() => decorateToolForDisplay(tool("hostile_queue"), adapter), /incompatible/);
  assert.equal(queueGetterRan, false, "adapter queue access must not invoke a global accessor");
  assert.equal(__testables.registrations.size, 0, "failed queue registration must be atomic");
  delete globalThis[__testables.QUEUE_SYMBOL];

  console.log("public display adapter tests: OK");
} finally {
  clean();
}
