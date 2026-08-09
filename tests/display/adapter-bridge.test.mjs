import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime, installGlobalDisplayRuntime } = await load("../../src/display/runtime.ts");
const {
  TOOL_DISPLAY_ADAPTER_QUEUE_MAX,
  decorateToolForDisplay,
  __testables,
} = await load("../../src/display/public.ts");

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

function clean() {
  const active = globalThis[__testables.RUNTIME_SYMBOL];
  active?.runtime?.dispose?.();
  delete globalThis[__testables.RUNTIME_SYMBOL];
  delete globalThis[__testables.QUEUE_SYMBOL];
  __testables.ownership.clear();
  __testables.registrations.clear();
  __testables.cleanupRuntimeIds.clear();
}

function makeTool(name = "custom_tool") {
  return {
    name,
    label: name,
    description: "custom tool",
    parameters: Type.Object({ input: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute() {
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  };
}

function ctx(args = {}, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "adapter-bridge-1",
    invalidate() {},
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

clean();

try {
  // ─── 1. Lifecycle projection through compatibility bridge ──────────

  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime);

  const lifecycleTool = makeTool("lifecycle_test");
  decorateToolForDisplay(lifecycleTool, {
    version: 1,
    title: "Lifecycle Tool",
    family: "workflow",
    fields: [],
  });

  // Running: execution started, no result yet
  const running = lifecycleTool.renderCall({}, plainTheme, ctx({}, {}, { executionStarted: true }));
  const runningText = stripVTControlCharacters(running.render(80).join("\n"));
  assert.match(runningText, /^●/, "call phase renders running braille (bridged from pending)");

  // Completed: successful result
  const completed = lifecycleTool.renderResult(
    { content: [{ type: "text", text: "ok" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({}, {}, { isError: false }),
  );
  const completedText = stripVTControlCharacters(completed.render(80).join("\n"));
  assert.match(completedText, /^✓/, "successful result renders completed check mark");

  // Failed: error result
  const failed = lifecycleTool.renderResult(
    { content: [{ type: "text", text: "broke" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({}, {}, { isError: true }),
  );
  const failedText = stripVTControlCharacters(failed.render(80).join("\n"));
  assert.match(failedText, /^×/, "error result renders failed ballot X");
  assert.match(failedText, /broke/, "error text visible in result body");

  // Partial: streaming result keeps running marker
  const partial = lifecycleTool.renderResult(
    { content: [{ type: "text", text: "streaming" }], details: {} },
    { expanded: false, isPartial: true },
    plainTheme,
    ctx({}, {}, { isPartial: true }),
  );
  const partialText = stripVTControlCharacters(partial.render(80).join("\n"));
  assert.match(partialText, /^●/, "partial result renders running braille (not completed)");

  runtime.dispose();

  // ─── 2. Preview field projection through production path ───────────

  clean();
  const runtime2 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime2);

  const previewTool = makeTool("preview_test");
  decorateToolForDisplay(previewTool, {
    version: 1,
    title: "Preview Tool",
    family: "filesystem",
    fields: [
      { kind: "preview", source: "result", path: ["text"], phase: "result" },
    ],
  });

  const previewResult = previewTool.renderResult(
    { content: [{ type: "text", text: "line one\nline two\nline three" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({ input: "test" }),
  );
  const previewText = stripVTControlCharacters(previewResult.render(80).join("\n"));
  assert.match(previewText, /line one/, "preview content visible in collapsed result");
  assert.match(previewText, /line three/, "preview preserves tail content");

  runtime2.dispose();

  // ─── 3. Diff field projection through production path ──────────────

  clean();
  const runtime3 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime3);

  const diffTool = makeTool("diff_test");
  decorateToolForDisplay(diffTool, {
    version: 1,
    title: "Diff Tool",
    family: "filesystem",
    fields: [
      { kind: "diff", source: "details", path: ["diff"], phase: "result" },
    ],
  });

  // Authoritative diff (no projected: true)
  const authDiff = diffTool.renderResult(
    { content: [], details: { diff: { before: "old text\n", after: "new text\n", path: "file.ts" } } },
    { expanded: true, isPartial: false },
    plainTheme,
    ctx(),
  );
  const authDiffText = stripVTControlCharacters(authDiff.render(80).join("\n"));
  assert.match(authDiffText, /old text/, "authoritative diff shows removed content");
  assert.match(authDiffText, /new text/, "authoritative diff shows added content");
  assert.match(authDiffText, /\(\+1, -1\)/, "authoritative diff shows change-count header");
  assert.doesNotMatch(authDiffText, /PROJECTED/, "authoritative diff not labelled projected");

  // Projected diff (projected: true)
  const projDiff = diffTool.renderResult(
    { content: [], details: { diff: { before: "old\n", after: "new\n", path: "file.ts", projected: true } } },
    { expanded: true, isPartial: false },
    plainTheme,
    ctx(),
  );
  const projDiffText = stripVTControlCharacters(projDiff.render(80).join("\n"));
  assert.match(projDiffText, /PROJECTED/, "projected diff labelled as preview");

  runtime3.dispose();

  // ─── 4. Progress field projection through production path ──────────

  clean();
  const runtime4 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime4);

  const progressTool = makeTool("progress_test");
  decorateToolForDisplay(progressTool, {
    version: 1,
    title: "Progress Tool",
    family: "remote",
    fields: [
      { kind: "progress", source: "details", path: ["progress"], phase: "both" },
    ],
  });

  const progressCall = progressTool.renderCall(
    {},
    plainTheme,
    ctx({}, {}, { executionStarted: true }),
  );
  // Without progress details in args, the call still renders
  const progressCallText = stripVTControlCharacters(progressCall.render(80).join("\n"));
  assert.match(progressCallText, /Progress Tool/, "progress tool renders identity");

  const progressResult = progressTool.renderResult(
    { content: [], details: { progress: { current: 3, total: 10, label: "processing" } } },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx(),
  );
  const progressResultText = stripVTControlCharacters(progressResult.render(80).join("\n"));
  assert.match(progressResultText, /3\/10/, "progress current/total visible in header");
  assert.match(progressResultText, /processing/, "progress label visible");

  runtime4.dispose();

  // ─── 5. Error projection through production path ───────────────────

  clean();
  const runtime5 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime5);

  const errorTool = makeTool("error_test");
  decorateToolForDisplay(errorTool, {
    version: 1,
    title: "Error Tool",
    family: "execution",
    fields: [],
  });

  const errorResult = errorTool.renderResult(
    { content: [{ type: "text", text: "Critical failure: timeout exceeded" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({}, {}, { isError: true }),
  );
  const errorText = stripVTControlCharacters(errorResult.render(80).join("\n"));
  assert.match(errorText, /^×/, "error renders failed marker");
  assert.match(errorText, /Critical failure/, "error text remains visible under hidden-equivalent policy");
  assert.match(errorText, /timeout exceeded/, "full error message visible");

  // Error visible even under hidden result mode
  const hiddenConfig = structuredClone(DEFAULT_CONFIG);
  hiddenConfig.display = {
    motion: "off",
    defaults: { resultMode: "hidden" },
  };
  const hiddenRuntime = new DisplayRuntime(hiddenConfig, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(hiddenRuntime);
  // Re-register after runtime replacement
  decorateToolForDisplay(errorTool, {
    version: 1,
    title: "Error Tool",
    family: "execution",
    fields: [],
  });
  const hiddenError = errorTool.renderResult(
    { content: [{ type: "text", text: "Still visible" }], isError: true, details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    ctx({}, {}, { isError: true }),
  );
  const hiddenErrorText = stripVTControlCharacters(hiddenError.render(80).join("\n"));
  assert.match(hiddenErrorText, /Still visible/, "errors visible even when result would be hidden");
  hiddenRuntime.dispose();

  // ─── 6. Unknown adapted tool receives bounded generic output ───────

  clean();
  const runtime6 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime6);

  const unknownTool = makeTool("unknown_xyz");
  decorateToolForDisplay(unknownTool, {
    version: 1,
    title: "Unknown Tool",
    family: "workflow",
    fields: [
      { kind: "text", source: "args", path: ["input"], label: "value", phase: "both" },
    ],
  });

  const unknownCall = unknownTool.renderCall(
    { input: "test input" },
    plainTheme,
    ctx({ input: "test input" }, {}, { executionStarted: true }),
  );
  const unknownText = stripVTControlCharacters(unknownCall.render(80).join("\n"));
  assert.match(unknownText, /●/, "unknown tool renders lifecycle marker");
  assert.match(unknownText, /Unknown Tool/, "unknown tool renders title");
  assert.match(unknownText, /test input/, "unknown tool body content visible");

  // Bounded at all widths
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = unknownCall.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `unknown tool bounded at ${width}`);
  }

  // Pending fallback: args complete but execution not started renders ○
  const pendingTool = makeTool("pending_test");
  decorateToolForDisplay(pendingTool, {
    version: 1,
    title: "Pending Tool",
    family: "workflow",
    fields: [],
  });
  const pendingCall = pendingTool.renderCall(
    {},
    plainTheme,
    ctx({}, {}, { executionStarted: false, argsComplete: true }),
  );
  const pendingText = stripVTControlCharacters(pendingCall.render(80).join("\n"));
  assert.match(pendingText, /^○/, "unknown adapted tool renders ○ pending marker when args complete but not started");

  runtime6.dispose();

  // ─── 7. Tools that did not opt in remain untouched ─────────────────

  clean();
  const runtime7 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime7);

  const untouchedTool = makeTool("untouched");
  const originalRenderShell = untouchedTool.renderShell;
  const originalRenderCall = untouchedTool.renderCall;
  const originalRenderResult = untouchedTool.renderResult;

  // Don't call decorateToolForDisplay — tool stays native
  assert.equal(untouchedTool.renderShell, originalRenderShell, "non-opted-in tool keeps renderShell");
  assert.equal(untouchedTool.renderCall, originalRenderCall, "non-opted-in tool keeps renderCall");
  assert.equal(untouchedTool.renderResult, originalRenderResult, "non-opted-in tool keeps renderResult");
  assert.notEqual(untouchedTool.renderShell, "self", "non-opted-in tool not claimed by display runtime");

  runtime7.dispose();

  // ─── 8. Queue cap and requeue on replacement runtime ───────────────

  clean();
  const queuedTool = makeTool("queued_test");
  decorateToolForDisplay(queuedTool, {
    version: 1,
    title: "Queued",
    family: "workflow",
    fields: [],
  });
  assert.equal(globalThis[__testables.QUEUE_SYMBOL].entries.length, 1, "queued before runtime activation");
  assert.notEqual(queuedTool.renderShell, "self", "not activated until runtime exists");

  const runtime8 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime8);
  assert.equal(globalThis[__testables.QUEUE_SYMBOL].entries.length, 0, "queue drained on activation");
  assert.equal(queuedTool.renderShell, "self", "activated after runtime install");

  // Disposal requeues and restores
  runtime8.dispose();
  assert.notEqual(queuedTool.renderShell, "self", "renderer restored after disposal");

  // Replacement runtime reactivates
  const runtime9 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime9);
  assert.equal(queuedTool.renderShell, "self", "reactivated on replacement runtime");
  runtime9.dispose();

  // Queue overflow: 129th tool rejected at 128 cap
  clean();
  for (let index = 0; index < TOOL_DISPLAY_ADAPTER_QUEUE_MAX; index += 1) {
    decorateToolForDisplay(makeTool(`overflow_${index}`), {
      version: 1,
      title: `Tool ${index}`,
      family: "workflow",
      fields: [],
    });
  }
  assert.equal(globalThis[__testables.QUEUE_SYMBOL].entries.length, TOOL_DISPLAY_ADAPTER_QUEUE_MAX);
  assert.throws(
    () => decorateToolForDisplay(makeTool("overflow_one_too_many"), {
      version: 1,
      title: "Over",
      family: "workflow",
      fields: [],
    }),
    /full.*128/i,
    "129th registration must be rejected at queue cap",
  );

  // ─── 9. Model-facing execute unchanged ─────────────────────────────

  clean();
  const runtime10 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime10);

  const execTool = makeTool("exec_test");
  decorateToolForDisplay(execTool, {
    version: 1,
    title: "Exec",
    family: "workflow",
    fields: [],
  });
  const execResult = await execTool.execute("call-1", { input: "test" }, undefined, undefined);
  assert.ok(Array.isArray(execResult.content), "execute returns content array");
  assert.equal(execResult.content[0].type, "text", "execute content type unchanged");
  assert.equal(execResult.content[0].text, "done", "execute content value unchanged");
  runtime10.dispose();

  // ─── 10. Internal sections not exposed ─────────────────────────────

  clean();
  const runtime11 = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  installGlobalDisplayRuntime(runtime11);

  const sectionTool = makeTool("section_test");
  decorateToolForDisplay(sectionTool, {
    version: 1,
    title: "Section Tool",
    family: "filesystem",
    fields: [
      { kind: "count", source: "details", path: ["total"], phase: "result" },
      { kind: "preview", source: "result", path: ["text"], phase: "result" },
    ],
  });
  const sectionResult = sectionTool.renderResult(
    { content: [{ type: "text", text: "output" }], details: { total: 42 } },
    { expanded: true, isPartial: false },
    plainTheme,
    ctx(),
  );
  const sectionText = stripVTControlCharacters(sectionResult.render(80).join("\n"));
  assert.match(sectionText, /total=42/, "count metadata visible");
  assert.match(sectionText, /output/, "preview text visible");
  // No internal DisplaySection titles leaked (they would show as section headings)
  assert.doesNotMatch(sectionText, /SUMMARY|REQUEST|RESULTS|CODE|OUTPUT/, "internal section titles not exposed through v1 adapter");

  runtime11.dispose();

  console.log("adapter v1 bridge tests: OK");
} finally {
  clean();
}
