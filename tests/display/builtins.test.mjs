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
const { decorateBuiltinDefinition, __testables } = await load("../../src/display/builtins.ts");
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
  assert.equal(
    __testables.safeDiagnostic("api_key=alpha token:beta password=gamma secret:delta\x1b]0;owned\x07"),
    "api_key=[REDACTED] token:[REDACTED] password=[REDACTED] secret:[REDACTED]",
  );
  assert.doesNotMatch(__testables.safeDiagnostic("token=value"), /\$1|value/);

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
  assert.match(editResult, /before/, "removed line content visible");
  assert.match(editResult, /after/, "added line content visible");
  assert.doesNotMatch(editResult, /\(\+1, -1\)/, "change-count header removed from diff");
  assert.match(editResult, /\+1 −1/, "change counts in summary row");
  assert.doesNotMatch(editResult, /@@/, "no @@ hunk header");
  assert.doesNotMatch(editResult, /PROJECTED/, "edit diff is authoritative, not projected");


  // ─── #217: the baseline restore preserves dynamically owned tool names ───

  {
    const registerDisplayBuiltinsDefault = (await load("../../src/display/builtins.ts")).default;
    const { DisplayController } = await load("../../src/display/index.ts");
    const events = new Map();
    let active = ["read", "edit", "write"];
    const writes = [];
    const pi = {
      registerTool() {},
      on(name, handler) {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
      },
      getActiveTools() { return [...active]; },
      setActiveTools(names) { active = [...names]; writes.push([...names]); },
      getAllTools() { return []; },
    };
    const controller = new DisplayController(DEFAULT_CONFIG);
    registerDisplayBuiltinsDefault(pi, controller, undefined, ["read_memory_source", "submit_memory"]);

    const ctx = {
      cwd: temp,
      sessionManager: { getSessionDir: () => temp, getSessionId: () => "s", getSessionFile: () => undefined },
      hasUI: false,
      isProjectTrusted() { return false; },
      ui: { setStatus() {} },
    };
    const emit = () => {
      const handlers = events.get("session_start") ?? [];
      for (const handler of handlers) return handler({ type: "session_start", reason: "startup" }, ctx);
    };

    // First start: the baseline is captured without the dynamic names.
    await emit();
    assert.ok(!active.includes("read_memory_source"), "the baseline never contains the dynamic names");
    assert.ok(!active.includes("submit_memory"));

    // A reload after Context Memory activated the read tool: the restore keeps it.
    active = [...active, "read_memory_source"];
    await emit();
    assert.ok(active.includes("read_memory_source"),
      "the baseline restore preserves a dynamically added owned name");
    assert.ok(!active.includes("submit_memory"),
      "an owned name another module removed stays removed");

    // A reload after Context Memory deactivated it again: nothing resurrects.
    active = active.filter((name) => name !== "read_memory_source");
    await emit();
    assert.ok(!active.includes("read_memory_source"), "a dynamically removed owned name stays removed");
  }

  runtime.dispose();
  console.log("display built-in definition and renderer tests: OK");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
