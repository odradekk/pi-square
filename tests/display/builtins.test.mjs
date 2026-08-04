import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");
const root = join(import.meta.dirname, "..", "..");
const themeModulePath = new URL(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
  import.meta.url,
).href;
const { loadThemeFromPath } = await import(themeModulePath);
const theme = loadThemeFromPath(join(root, "themes", "pi-square-theme-dark.json"));
const temp = mkdtempSync(join(tmpdir(), "pi-square-builtins-"));

function context(overrides = {}) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: temp,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: true,
    isError: false,
    ...overrides,
  };
}

try {
  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const marker = Symbol("marker");
  const original = {
    ...createReadToolDefinition(temp),
    marker,
    renderShell: undefined,
  };
  const decorated = decorateBuiltinDefinition(original, temp, runtime);
  assert.notEqual(decorated, original);
  for (const key of Reflect.ownKeys(original)) {
    if (["renderShell", "renderCall", "renderResult"].includes(String(key))) continue;
    assert.equal(decorated[key], original[key], `${String(key)} changed identity`);
  }
  assert.equal(decorated.renderShell, "self");
  assert.equal(typeof decorated.renderCall, "function");
  assert.equal(typeof decorated.renderResult, "function");

  const factories = [
    createReadToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createBashToolDefinition,
  ];
  for (const factory of factories) {
    const definition = factory(temp);
    const rendered = decorateBuiltinDefinition(definition, temp, runtime);
    assert.equal(rendered.parameters, definition.parameters, `${definition.name} schema identity changed`);
    assert.equal(rendered.execute, definition.execute, `${definition.name} execution changed`);
    assert.equal(rendered.prepareArguments, definition.prepareArguments, `${definition.name} argument preparation changed`);
    assert.equal(rendered.executionMode, definition.executionMode, `${definition.name} execution mode changed`);
    assert.equal(rendered.promptGuidelines, definition.promptGuidelines, `${definition.name} prompt metadata changed`);
  }

  const writePath = join(temp, "projected.txt");
  writeFileSync(writePath, "before\n");
  const write = decorateBuiltinDefinition(createWriteToolDefinition(temp), temp, runtime);
  let invalidations = 0;
  const writeContext = context({
    args: { path: "projected.txt", content: "after\n" },
    executionStarted: false,
    invalidate() { invalidations += 1; },
  });
  const component = write.renderCall(writeContext.args, theme, writeContext);
  for (let attempt = 0; attempt < 50 && invalidations === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(invalidations > 0, "write preview did not invalidate after hydration");
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /projected/i);
  assert.match(rendered, /before/);
  assert.match(rendered, /after/);

  const edit = decorateBuiltinDefinition(createEditToolDefinition(temp), temp, runtime);
  const editArgs = { path: "projected.txt", edits: [{ oldText: "before", newText: "after" }] };
  const editCall = edit.renderCall(editArgs, theme, context({ args: editArgs })).render(40);
  assert.ok(editCall.every((line) => line.length <= 200));
  const editResult = edit.renderResult({
    content: [{ type: "text", text: "Applied edit" }],
    details: {
      diff: "-before\n+after",
      patch: "--- a/projected.txt\n+++ b/projected.txt\n@@ -1 +1 @@\n-before\n+after\n",
      firstChangedLine: 1,
    },
  }, { expanded: true, isPartial: false }, theme, context({ args: editArgs })).render(80).join("\n");
  assert.match(editResult, /-before|│ before/);
  assert.match(editResult, /\+after|│ after/);
  assert.doesNotMatch(editResult, /PROJECTED/);

  runtime.dispose();
  console.log("display built-in definition and renderer tests: OK");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
