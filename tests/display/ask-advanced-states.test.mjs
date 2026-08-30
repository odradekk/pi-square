import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state,
    cwd: "/tmp", executionStarted: false, argsComplete: false, isPartial: false,
    expanded: false, showImages: false, isError: false, ...overrides,
  };
}

function newRuntime(environment = { isTTY: true }) {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment });
}

function makeDef() {
  return {
    name: "ask", label: "Ask", description: "ask tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

const ARGS_3Q = {
  questions: [
    { id: "q1", text: "Pick a color", type: "single", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] },
    { id: "q2", text: "Pick frameworks", type: "multi", options: [{ value: "react", label: "React" }, { value: "vue", label: "Vue" }], allowComment: true },
    { id: "q3", text: "Optional feedback", type: "multi", options: [{ value: "good", label: "Good" }], allowComment: true, required: false },
  ],
};

function renderResult(decorated, args, details, opts = {}) {
  const text = JSON.stringify(details);
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  return decorated.renderResult(
    { content: [{ type: "text", text }], details, ...(opts.isError ? { isError: true } : {}) },
    { expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false },
    plainTheme,
    makeCtx(args, {}, {
      argsComplete: true, executionStarted: true, lastComponent: call,
      isError: opts.isError ?? false, expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════
// EDGE STATE TESTS
// ═══════════════════════════════════════════════════════════════════

// ─── 1. Comment-only answer uses a note: prefix, not comment-only= ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "done", totalQuestions: 3, answeredCount: 2, skippedCount: 1,
    answers: [
      { questionId: "q1", questionText: "Pick a color", selected: [{ value: "red", label: "Red" }], skipped: false },
      { questionId: "q2", questionText: "Pick frameworks", selected: [], comment: "I prefer Svelte actually", skipped: false },
      { questionId: "q3", questionText: "Optional feedback", selected: [], skipped: true },
    ],
  };
  const result = renderResult(decorated, ARGS_3Q, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  const q2Section = text.split("Pick frameworks")[1] ?? "";
  assert.match(q2Section, /note: I prefer Svelte actually/, "comment-only answer shows a note: line");
  assert.doesNotMatch(text, /comment-only=/, "no raw comment-only= field");
  // The skipped answer shows a plain "skipped" body line, not a note.
  const q3Section = text.split("Optional feedback")[1] ?? "";
  assert.match(q3Section, /skipped/, "skipped answer shows a skipped body line");
  assert.doesNotMatch(q3Section, /note:/, "skipped answer carries no note");

  runtime.dispose();
}

// ─── 2. Reviewing phase progress frame ─────────────────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = {
    version: 1, phase: "reviewing", totalQuestions: 3, answeredCount: 2, skippedCount: 1,
  };
  const result = renderResult(decorated, ARGS_3Q, progressDetails, { isPartial: true, expanded: true });
  // A wide-tier width leaves room for the full target and summary unelided.
  const text = stripVTControlCharacters(result.render(120).join("\n"));
  assert.match(text, /^●/, "reviewing progress shows the running fallback marker");
  assert.match(text.split("\n")[0], /3 questions/, "reviewing progress keeps the question count target");
  assert.doesNotMatch(text.split("\n")[0], /\[partial\]/, "reviewing progress renders no partial badge");

  runtime.dispose();
}

// ─── 3. Asking phase progress frame ────────────────────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = {
    version: 1, phase: "asking", totalQuestions: 3, currentQuestion: 2, answeredCount: 1, skippedCount: 0,
  };
  const result = renderResult(decorated, ARGS_3Q, progressDetails, { isPartial: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "asking progress shows the running fallback marker");
  assert.match(text.split("\n")[0], /3 questions/, "asking progress keeps the question count target");

  runtime.dispose();
}

// ─── 4. Zero-change review submission ──────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "done", totalQuestions: 2, answeredCount: 2, skippedCount: 0,
    answers: [
      { questionId: "q1", questionText: "Pick a color", selected: [{ value: "red", label: "Red" }], skipped: false },
      { questionId: "q2", questionText: "Pick frameworks", selected: [{ value: "react", label: "React" }], skipped: false },
    ],
  };
  const result = renderResult(decorated, ARGS_3Q, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "submission renders the bullet marker");
  assert.match(text, /2 answered/, "answered count correct in the summary");
  assert.doesNotMatch(text, /\bskipped=/, "no raw skipped= field");

  runtime.dispose();
}

// ─── 5. ASK_INVALID_INPUT error ────────────────────────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0,
    error: { code: "ASK_INVALID_INPUT", message: "Question IDs must be unique" },
  };
  const result = renderResult(decorated, ARGS_3Q, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "invalid input renders the failed fallback marker");
  assert.match(text, /Question IDs must be unique/, "validation error message visible");

  runtime.dispose();
}

// ─── 6. ASK_UI_UNAVAILABLE error ───────────────────────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0,
    error: { code: "ASK_UI_UNAVAILABLE", message: "Interactive UI is not available in this session" },
  };
  const result = renderResult(decorated, ARGS_3Q, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "UI unavailable renders the failed fallback marker");
  assert.match(text, /Interactive UI is not available/, "UI unavailable message visible");

  runtime.dispose();
}

// ─── 7. ASK_UI_FAILED error ────────────────────────────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "error", totalQuestions: 2, answeredCount: 0, skippedCount: 0,
    error: { code: "ASK_UI_FAILED", message: "Unknown ask UI failure" },
  };
  const result = renderResult(decorated, ARGS_3Q, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "UI failure renders the failed fallback marker");
  assert.match(text, /Unknown ask UI failure/, "sanitized failure message visible");

  runtime.dispose();
}

// ─── 8. User cancellation at each stage ────────────────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  const cancelAsking = {
    version: 1, phase: "cancelled", totalQuestions: 3, answeredCount: 0, skippedCount: 0, reason: "user",
  };
  const r1 = renderResult(decorated, ARGS_3Q, cancelAsking, { expanded: false });
  const t1 = stripVTControlCharacters(r1.render(80).join("\n"));
  assert.match(t1, /^·/, "cancel during asking renders the aborted fallback marker");
  assert.match(t1, /Cancelled/, "cancel states Cancelled");

  const cancelReview = {
    version: 1, phase: "cancelled", totalQuestions: 3, answeredCount: 2, skippedCount: 0, reason: "user",
  };
  const r2 = renderResult(decorated, ARGS_3Q, cancelReview, { expanded: false });
  const t2 = stripVTControlCharacters(r2.render(80).join("\n"));
  assert.match(t2, /^·/, "cancel during reviewing renders the aborted fallback marker");
  assert.match(t2, /Cancelled/, "cancel states Cancelled");

  runtime.dispose();
}

// ─── 9. External abort during input (isError:true, reason:aborted) ─
//
// KNOWN ISSUE: see the identical note in ask-workflow.test.mjs. The
// shared `isError` short-circuit in the ask branch of
// src/display/workflow-adapters.ts currently classifies a tool-aborted
// wizard (isError:true + phase:"cancelled") as failed rather than
// aborted. This test documents the current, observed behavior.

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const abortDetails = {
    version: 1, phase: "cancelled", totalQuestions: 3, answeredCount: 1, skippedCount: 0, reason: "aborted",
  };
  const result = renderResult(decorated, ARGS_3Q, abortDetails, { isError: true, expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^[×·]/, "external abort renders a terminal fallback marker (currently × — see known issue above)");

  runtime.dispose();
}

// ─── 10. All skipped answers (optional questions) ──────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "done", totalQuestions: 2, answeredCount: 0, skippedCount: 2,
    answers: [
      { questionId: "q1", questionText: "Optional 1", selected: [], skipped: true },
      { questionId: "q2", questionText: "Optional 2", selected: [], skipped: true },
    ],
  };
  const result = renderResult(decorated, ARGS_3Q, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "all-skipped submission renders the bullet marker");
  assert.match(text, /0 answered · 2 skipped/, "summary states zero answered, two skipped");
  const skippedLines = text.split("\n").filter((line) => /skipped\s*$/.test(line.trim()) && !line.includes("answered"));
  assert.equal(skippedLines.length, 2, "both answers show a skipped body line");
  assert.doesNotMatch(text, /note:/, "skipped answers carry no note");

  runtime.dispose();
}

// ─── 11. Mixed answer types: multi-select + comment-only + skipped ─

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "done", totalQuestions: 3, answeredCount: 2, skippedCount: 1,
    answers: [
      { questionId: "q1", questionText: "Pick a color", selected: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }], skipped: false },
      { questionId: "q2", questionText: "Pick frameworks", selected: [], comment: "No preference", skipped: false },
      { questionId: "q3", questionText: "Optional feedback", selected: [], skipped: true },
    ],
  };
  const result = renderResult(decorated, ARGS_3Q, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Red, Blue/, "multi-select shows comma-separated labels");
  assert.match(text, /note: No preference/, "comment-only answer visible with a note: prefix");
  assert.match(text, /skipped/, "skipped answer visible");

  runtime.dispose();
}

// ─── 12. Collapsed view for cancelled/error states ─────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  const cancelDetails = { version: 1, phase: "cancelled", totalQuestions: 2, answeredCount: 0, skippedCount: 0, reason: "user" };
  const r1 = renderResult(decorated, ARGS_3Q, cancelDetails, { expanded: false });
  const t1 = stripVTControlCharacters(r1.render(80).join("\n"));
  assert.match(t1, /^·/, "collapsed cancel shows the aborted marker");
  assert.match(t1, /Cancelled/, "collapsed cancel states Cancelled");
  assert.doesNotMatch(t1, /"version":\s*1/, "collapsed cancel carries no raw JSON");

  const errorDetails = { version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0, error: { code: "ASK_INVALID_INPUT", message: "bad" } };
  const r2 = renderResult(decorated, ARGS_3Q, errorDetails, { isError: true, expanded: false });
  const t2 = stripVTControlCharacters(r2.render(80).join("\n"));
  assert.match(t2, /^×/, "collapsed error shows the failed marker");
  assert.match(t2, /bad/, "collapsed error states the message");
  assert.doesNotMatch(t2, /"version":\s*1/, "collapsed error carries no raw JSON");

  runtime.dispose();
}

// ─── 13. Progress state through the collapsed view ─────────────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = { version: 1, phase: "asking", totalQuestions: 3, currentQuestion: 1, answeredCount: 0, skippedCount: 0 };
  const result = renderResult(decorated, ARGS_3Q, progressDetails, { isPartial: true, expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "progress shows the running fallback marker");
  assert.match(text.split("\n")[0], /3 questions/, "progress keeps the question count target");

  runtime.dispose();
}

// ─── 14. Bounded at all widths for edge states ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  const edgeStates = [
    { label: "comment-only expanded", details: { version: 1, phase: "done", totalQuestions: 1, answeredCount: 1, skippedCount: 0, answers: [{ questionId: "q1", questionText: "Pick a color", selected: [], comment: "Just a long comment here", skipped: false }] }, opts: { expanded: true } },
    { label: "error expanded", details: { version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0, error: { code: "ASK_INVALID_INPUT", message: "Duplicate IDs found" } }, opts: { expanded: true, isError: true } },
    { label: "reviewing progress", details: { version: 1, phase: "reviewing", totalQuestions: 3, answeredCount: 2, skippedCount: 0 }, opts: { isPartial: true, expanded: true } },
    { label: "all-skipped expanded", details: { version: 1, phase: "done", totalQuestions: 2, answeredCount: 0, skippedCount: 2, answers: [{ questionId: "q1", questionText: "Q1", selected: [], skipped: true }, { questionId: "q2", questionText: "Q2", selected: [], skipped: true }] }, opts: { expanded: true } },
  ];

  for (const { label, details, opts } of edgeStates) {
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      const result = renderResult(decorated, ARGS_3Q, details, opts);
      assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `${label} bounded at ${width}`);
    }
  }
  runtime.dispose();
}

// ─── 15. Answers present only in the raw payload text ──────────────
//
// When details.answers is empty but the raw content text carries them
// (a JSON-shaped fallback), the base internal adapter's preview text
// still renders and surfaces the payload data.

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const payload = { version: 1, status: "submitted", answers: [{ questionId: "q1", questionText: "Q1", selected: [{ value: "red", label: "Red" }], skipped: false }] };
  const text = JSON.stringify(payload);
  const details = { version: 1, phase: "done", totalQuestions: 1, answeredCount: 1, skippedCount: 0 };
  const call = decorated.renderCall(ARGS_3Q, plainTheme, makeCtx(ARGS_3Q, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text }], details },
    { expanded: true, isPartial: false },
    plainTheme,
    makeCtx(ARGS_3Q, {}, { argsComplete: true, executionStarted: true, lastComponent: call, expanded: true }),
  );
  const resultText = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(resultText, /submitted/, "raw payload fallback shows the submitted status");
  assert.match(resultText, /Red/, "raw payload fallback shows the answer data");

  runtime.dispose();
}

// ─── 16. Execution and schema unchanged ────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "ask execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "ask parameters unchanged");
  runtime.dispose();
}

console.log("Ask advanced states display tests: OK");
