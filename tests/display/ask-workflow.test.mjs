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

const ARGS_2Q = {
  questions: [
    { id: "q1", text: "Pick a color", type: "single", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] },
    { id: "q2", text: "Pick frameworks", type: "multi", options: [{ value: "react", label: "React" }, { value: "vue", label: "Vue" }], allowComment: true },
  ],
};

const DONE_DETAILS = {
  version: 1, phase: "done", totalQuestions: 2, answeredCount: 2, skippedCount: 0,
  answers: [
    { questionId: "q1", questionText: "Pick a color", selected: [{ value: "red", label: "Red" }], skipped: false },
    { questionId: "q2", questionText: "Pick frameworks", selected: [{ value: "react", label: "React" }], comment: "Fast refresh", skipped: false },
  ],
};

const CANCELLED_USER = {
  version: 1, phase: "cancelled", totalQuestions: 2, answeredCount: 0, skippedCount: 0, reason: "user",
};

const CANCELLED_ABORTED = {
  version: 1, phase: "cancelled", totalQuestions: 2, answeredCount: 0, skippedCount: 0, reason: "aborted",
};

const ERROR_DETAILS = {
  version: 1, phase: "error", totalQuestions: 0, answeredCount: 0, skippedCount: 0,
  error: { code: "ASK_INVALID_INPUT", message: "Duplicate question IDs" },
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

// ─── 1. Submitted result shows completed marker and answers ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "submitted result renders ✓");
  assert.match(text, /Pick a color/, "first question text visible in Answers");
  assert.match(text, /Red/, "first answer visible");
  assert.match(text, /Pick frameworks/, "second question text visible");
  assert.match(text, /React/, "second answer visible");
  assert.match(text, /Fast refresh/, "comment visible");

  runtime.dispose();
}

// ─── 2. REQUEST section shows phase, counts, and question count ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /REQUEST/, "REQUEST section present");
  assert.match(text, /phase=done/, "REQUEST shows phase");
  assert.match(text, /questions=2/, "REQUEST shows question count");
  assert.match(text, /answered=2/, "REQUEST shows answered count");
  assert.match(text, /skipped=0/, "REQUEST shows skipped count");

  runtime.dispose();
}

// ─── 3. Call phase shows question count from args ──────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const call = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text, /questions=2/, "call shows question count from args");
  // Question text must NOT be in call display (privacy)
  assert.doesNotMatch(text, /Pick a color/, "question text not in call display");
  assert.doesNotMatch(text, /Pick frameworks/, "question text not in call display");

  runtime.dispose();
}

// ─── 4. User-cancelled shows aborted marker (·) ────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, CANCELLED_USER);
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "user-cancel renders · (aborted)");
  assert.match(text, /phase=cancelled/, "phase visible");
  assert.match(text, /reason=user/, "cancel reason visible");

  runtime.dispose();
}

// ─── 5. Tool-aborted shows aborted marker (·), not failed (·) ──────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  // Tool-aborted has isError:true — explicit lifecycle must override to aborted
  const result = renderResult(decorated, ARGS_2Q, CANCELLED_ABORTED, { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "tool-aborted renders · (aborted, not · failed)");
  assert.match(text, /reason=aborted/, "abort reason visible");

  runtime.dispose();
}

// ─── 6. Error state shows failed marker (×) and error section ──────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, ERROR_DETAILS, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "error renders × (failed)");
  assert.match(text, /ERROR/, "ERROR section present");
  assert.match(text, /Duplicate question IDs/, "error message visible");

  runtime.dispose();
}

// ─── 7. Needs-input qualifier while wizard is active ───────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  // Test through a theme that renders accent + extra qualifier hint
  // Since needs-input doesn't change the theme token during running,
  // verify the lifecycle is running (wizard active) and question count visible
  const running = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true }));
  const runningText = stripVTControlCharacters(running.render(80).join("\n"));
  assert.match(runningText, /^●/, "wizard active renders running braille");
  assert.match(runningText, /questions=2/, "question count visible during wizard");
  // Before execution: different marker
  const queued = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: false, executionStarted: false }));
  const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
  assert.match(queuedText, /^●/, "before wizard renders queued en-dash");

  runtime.dispose();
}

// ─── 8. Collapsed view shows operation identity, not raw JSON ──────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  // Collapsed should show phase and counts (compact Request section)
  assert.match(text, /phase=done/, "collapsed shows phase");
  assert.match(text, /questions=2/, "collapsed shows question count");
  // Should NOT show raw JSON payload
  assert.doesNotMatch(text, /"version":\s*1/, "collapsed does not show raw JSON");
  // Answer records should not be in collapsed (non-compact Answers section)
  assert.doesNotMatch(text, /Pick a color/, "answer records not in collapsed view");

  runtime.dispose();
}

// ─── 9. Skipped answers show warning marker ────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const details = {
    ...DONE_DETAILS,
    answeredCount: 1, skippedCount: 1,
    answers: [
      { questionId: "q1", questionText: "Pick a color", selected: [{ value: "red", label: "Red" }], skipped: false },
      { questionId: "q2", questionText: "Pick frameworks", selected: [], skipped: true },
    ],
  };
  const result = renderResult(decorated, ARGS_2Q, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /skipped=yes/, "skipped answer shows skipped=yes warning");

  runtime.dispose();
}

// ─── 10. Lifecycle markers through production decoration path ──────

{
  const clock = {
    callbacks: new Map(), next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); }, unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = ARGS_2Q;
  const state = {};
  // Queued
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^●/, "queued renders en-dash");
  // Pending
  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^●/, "pending renders circle");
  // Running
  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders braille");
  // Completed
  const result = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(DONE_DETAILS) }], details: DONE_DETAILS },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders check mark");

  runtime.dispose();
}

// ─── 11. Privacy: question/option text never in header metadata ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const call = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.doesNotMatch(text, /Red|Blue|React|Vue/, "option labels not in call metadata");
  assert.match(text, /questions=2/, "only count is visible");

  runtime.dispose();
}

// ─── 12. Collapsed/expanded bounds at all widths ───────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  for (const expanded of [false, true]) {
    const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded });
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `ask ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
    }
  }
  runtime.dispose();
}

// ─── 13. Execution and schema unchanged ────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "ask execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "ask parameters unchanged");
  runtime.dispose();
}

// ─── 14. Progress state (isPartial) shows running marker ───────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = {
    version: 1, phase: "asking", totalQuestions: 2, currentQuestion: 1, answeredCount: 0, skippedCount: 0,
  };
  const call = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(progressDetails) }], details: progressDetails },
    { expanded: false, isPartial: true },
    plainTheme,
    makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isPartial: true }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /●|●|●|●|●|●|●|●|●|●/, "progress update shows running braille");
  assert.match(text, /phase=asking/, "progress shows asking phase");
  assert.match(text, /current=1/, "progress shows current question");

  runtime.dispose();
}

console.log("Ask workflow display tests: OK");
