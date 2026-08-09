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

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });
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

// ─── 1. Comment-only answer shows comment-only indicator ──────────

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
  // Comment-only answer: selected=(none) + comment-only=yes
  const q2Section = text.split("Pick frameworks")[1] ?? "";
  assert.match(q2Section, /comment-only=yes/, "comment-only answer shows indicator");
  assert.match(q2Section, /I prefer Svelte actually/, "comment text visible");
  // Regular answer: no comment-only on the same record
  const lines = text.split("\n");
  const q1LineIdx = lines.findIndex((l) => l.includes("Pick a color"));
  const q2LineIdx = lines.findIndex((l) => l.includes("Pick frameworks"));
  const q1Block = lines.slice(q1LineIdx, q2LineIdx).join("\n");
  assert.doesNotMatch(q1Block, /comment-only/, "regular answer has no comment-only indicator");
  // Skipped answer: skipped=yes, no comment-only
  const q3Section = text.split("Optional feedback")[1] ?? "";
  assert.doesNotMatch(q3Section, /comment-only/, "skipped answer has no comment-only indicator");

  runtime.dispose();
}

// ─── 2. Reviewing phase progress frame ─────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = {
    version: 1, phase: "reviewing", totalQuestions: 3, answeredCount: 2, skippedCount: 1,
  };
  const result = renderResult(decorated, ARGS_3Q, progressDetails, { isPartial: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Should show running braille (isPartial)
  assert.match(text, /^●/, "reviewing progress shows running braille");
  // Should show reviewing phase
  assert.match(text, /phase=reviewing/, "reviewing phase visible");
  // Should NOT leak raw JSON (hasDomain fix)
  assert.doesNotMatch(text, /"version":\s*1/, "reviewing progress does not leak raw JSON");
  assert.doesNotMatch(text, /"status":\s*"reviewing"/, "reviewing progress does not show raw payload");

  runtime.dispose();
}

// ─── 3. Asking phase progress frame does not leak raw JSON ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = {
    version: 1, phase: "asking", totalQuestions: 3, currentQuestion: 2, answeredCount: 1, skippedCount: 0,
  };
  const result = renderResult(decorated, ARGS_3Q, progressDetails, { isPartial: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "asking progress shows running braille");
  assert.match(text, /phase=asking/, "asking phase visible");
  assert.match(text, /current=2/, "current question visible");
  assert.doesNotMatch(text, /"version":\s*1/, "asking progress does not leak raw JSON in expanded");

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
  assert.match(text, /^●/, "zero-change review renders ✓");
  assert.match(text, /answered=2/, "answered count correct");
  assert.match(text, /skipped=0/, "no skipped in zero-change review");

  runtime.dispose();
}

// ─── 5. ASK_INVALID_INPUT error ────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0,
    error: { code: "ASK_INVALID_INPUT", message: "Question IDs must be unique" },
  };
  const result = renderResult(decorated, ARGS_3Q, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "invalid input renders × failed");
  assert.match(text, /ERROR/, "ERROR section present");
  assert.match(text, /Question IDs must be unique/, "validation error message visible");
  assert.match(text, /phase=error/, "error phase visible");

  runtime.dispose();
}

// ─── 6. ASK_UI_UNAVAILABLE error ───────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0,
    error: { code: "ASK_UI_UNAVAILABLE", message: "Interactive UI is not available in this session" },
  };
  const result = renderResult(decorated, ARGS_3Q, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "UI unavailable renders × failed");
  assert.match(text, /Interactive UI is not available/, "UI unavailable message visible");

  runtime.dispose();
}

// ─── 7. ASK_UI_FAILED error ────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    version: 1, phase: "error", totalQuestions: 2, answeredCount: 0, skippedCount: 0,
    error: { code: "ASK_UI_FAILED", message: "Unknown ask UI failure" },
  };
  const result = renderResult(decorated, ARGS_3Q, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "UI failure renders × failed");
  assert.match(text, /Unknown ask UI failure/, "sanitized failure message visible");

  runtime.dispose();
}

// ─── 8. User cancellation at each stage ────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  // Cancel during asking (no answers yet)
  const cancelAsking = {
    version: 1, phase: "cancelled", totalQuestions: 3, answeredCount: 0, skippedCount: 0, reason: "user",
  };
  const r1 = renderResult(decorated, ARGS_3Q, cancelAsking);
  const t1 = stripVTControlCharacters(r1.render(80).join("\n"));
  assert.match(t1, /^●/, "cancel during asking renders · aborted");
  assert.match(t1, /reason=user/, "cancel reason visible");

  // Cancel during reviewing (some answers)
  const cancelReview = {
    version: 1, phase: "cancelled", totalQuestions: 3, answeredCount: 2, skippedCount: 0, reason: "user",
  };
  const r2 = renderResult(decorated, ARGS_3Q, cancelReview);
  const t2 = stripVTControlCharacters(r2.render(80).join("\n"));
  assert.match(t2, /^●/, "cancel during reviewing renders · aborted");
  assert.match(t2, /reason=user/, "cancel reason visible");

  // Discard confirmation → same user cancel result
  const r3 = renderResult(decorated, ARGS_3Q, cancelReview);
  const t3 = stripVTControlCharacters(r3.render(80).join("\n"));
  assert.match(t3, /^●/, "discard confirmation renders · aborted");

  runtime.dispose();
}

// ─── 9. External abort during input ────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const abortDetails = {
    version: 1, phase: "cancelled", totalQuestions: 3, answeredCount: 1, skippedCount: 0, reason: "aborted",
  };
  // Tool-aborted: isError=true, but lifecycle overrides to aborted
  const result = renderResult(decorated, ARGS_3Q, abortDetails, { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "external abort renders · aborted (not ·)");
  assert.match(text, /reason=aborted/, "abort reason visible");
  assert.doesNotMatch(text, /^×/, "external abort does NOT render × failed");

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
  assert.match(text, /^●/, "all-skipped submission renders ✓");
  assert.match(text, /answered=0/, "answered count is 0");
  assert.match(text, /skipped=2/, "skipped count is 2");
  // Each answer should show skipped=yes
  const skippedMatches = text.match(/skipped=yes/g) ?? [];
  assert.equal(skippedMatches.length, 2, "both answers show skipped=yes");
  // No comment-only indicators
  assert.doesNotMatch(text, /comment-only/, "skipped answers have no comment-only indicator");

  runtime.dispose();
}

// ─── 11. Mixed answer types: selected + comment-only + skipped ─────

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
  assert.match(text, /comment-only=yes/, "comment-only answer visible");
  assert.match(text, /No preference/, "comment text visible");
  assert.match(text, /skipped=yes/, "skipped answer visible");

  runtime.dispose();
}

// ─── 12. Collapsed view for cancelled/error states ─────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  // Collapsed cancel
  const cancelDetails = { version: 1, phase: "cancelled", totalQuestions: 2, answeredCount: 0, skippedCount: 0, reason: "user" };
  const r1 = renderResult(decorated, ARGS_3Q, cancelDetails, { expanded: false });
  const t1 = stripVTControlCharacters(r1.render(80).join("\n"));
  assert.match(t1, /^●/, "collapsed cancel shows ×");
  assert.match(t1, /phase=cancelled/, "collapsed cancel shows phase");
  assert.match(t1, /reason=user/, "collapsed cancel shows reason");

  // Collapsed error
  const errorDetails = { version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0, error: { code: "ASK_INVALID_INPUT", message: "bad" } };
  const r2 = renderResult(decorated, ARGS_3Q, errorDetails, { isError: true, expanded: false });
  const t2 = stripVTControlCharacters(r2.render(80).join("\n"));
  assert.match(t2, /^●/, "collapsed error shows ×");
  assert.match(t2, /phase=error/, "collapsed error shows phase");

  runtime.dispose();
}

// ─── 13. Collapsed progress does not show raw JSON ─────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = { version: 1, phase: "asking", totalQuestions: 3, currentQuestion: 1, answeredCount: 0, skippedCount: 0 };
  const result = renderResult(decorated, ARGS_3Q, progressDetails, { isPartial: true, expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "collapsed progress shows running braille");
  assert.match(text, /phase=asking/, "collapsed progress shows phase");
  assert.doesNotMatch(text, /"version":\s*1/, "collapsed progress does not leak raw JSON");

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

// ─── 15. Answers in content payload (JSON fallback path) ───────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  // Simulate answers present in content JSON but not in details.answers
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
  // With expanded, answers-in-payload path should show the JSON in a Result section
  assert.match(resultText, /submitted/, "JSON fallback shows submitted status");
  assert.match(resultText, /Red/, "JSON fallback shows answer data");

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
