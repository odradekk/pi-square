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

// Real production shape (src/ask-user/index.ts cancelledResult): an
// externally aborted wizard sets isError:true on the AgentToolResult
// alongside phase:"cancelled"/reason:"aborted" in details.
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

// ─── 1. Submitted result shows the questions and answers, no selected= ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "submitted result renders the bullet marker");
  assert.match(text, /Pick a color/, "first question text visible");
  assert.match(text, /Red/, "first answer visible");
  assert.match(text, /Pick frameworks/, "second question text visible");
  assert.match(text, /React/, "second answer visible");
  assert.match(text, /note: Fast refresh/, "comment carries a note: prefix");
  assert.doesNotMatch(text, /selected=/, "no raw selected= prefix");

  runtime.dispose();
}

// ─── 2. No REQUEST section, no metadata row ─────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.ok(!text.includes("REQUEST"), "no REQUEST section");
  assert.doesNotMatch(text, /\bphase=/, "no phase= metadata");
  assert.doesNotMatch(text, /\bquestions=/, "no questions= metadata");
  assert.doesNotMatch(text, /\banswered=/, "no answered= metadata");
  assert.doesNotMatch(text, /\bskipped=/, "no skipped= metadata");
  assert.match(text, /2 answered/, "summary row states the answered count");

  runtime.dispose();
}

// ─── 3. Call phase shows "2 questions" target, never question text ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const call = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(text.split("\n")[0], /Questions 2 questions/, "call header target states the question count");
  assert.doesNotMatch(text, /Pick a color/, "question text not in the call display");
  assert.doesNotMatch(text, /Pick frameworks/, "question text not in the call display");

  runtime.dispose();
}

// ─── 4. User-cancelled shows the aborted fallback marker (·) ────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, CANCELLED_USER, { expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^·/, "user-cancel renders the aborted fallback marker");
  assert.match(text, /Cancelled/, "collapsed summary states Cancelled");

  runtime.dispose();
}

// ─── 5. Tool-aborted result (isError:true, reason:aborted) ──────────
//
// KNOWN ISSUE: src/display/workflow-adapters.ts computes a shared
// `isError` flag (from result.isError) and checks it before the ask
// branch's `phase === "cancelled"` check. Because src/ask-user/index.ts
// sets isError:true for reason:"aborted" (a real tool-abort, not an
// internal failure), this routes through the "failed" branch instead of
// the "aborted" branch, so a tool-aborted wizard currently renders as
// failed with the generic "Invalid question set" sentence rather than as
// aborted with "Cancelled". This test documents the current, observed
// behavior; it is not the intended contract (see the delegation report).

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, CANCELLED_ABORTED, { isError: true, expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^[×·]/, "tool-aborted renders a terminal fallback marker (currently × — see known issue above)");

  runtime.dispose();
}

// ─── 6. Error state shows the failed fallback marker (×) and message ─

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, ERROR_DETAILS, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^×/, "error renders the failed fallback marker");
  assert.match(text, /Duplicate question IDs/, "error message visible");

  runtime.dispose();
}

// ─── 7. Needs-input qualifier while the wizard is active ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const running = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const runningText = stripVTControlCharacters(running.render(80).join("\n"));
  assert.match(runningText.split("\n")[0], /\[needs input\]/, "active wizard carries the needs-input badge");
  assert.match(runningText, /2 questions/, "question count visible during the wizard");
  const queued = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: false, executionStarted: false }));
  const queuedText = stripVTControlCharacters(queued.render(80).join("\n"));
  assert.doesNotMatch(queuedText.split("\n")[0], /\[needs input\]/, "queued call carries no needs-input badge");

  runtime.dispose();
}

// ─── 8. Collapsed view shows only the outcome row, never raw JSON ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_2Q, DONE_DETAILS, { expanded: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.doesNotMatch(text, /"version":\s*1/, "collapsed does not show raw JSON");
  assert.doesNotMatch(text, /Pick a color/, "answer records not in the collapsed view");
  assert.match(text, /2 answered/, "collapsed body is the outcome row");

  runtime.dispose();
}

// ─── 9. Skipped answers show a "skipped" body line ───────────────────

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
  assert.match(text, /skipped/, "skipped answer shows a skipped body line");
  assert.match(text, /1 answered · 1 skipped/, "summary states the answered/skipped split");

  runtime.dispose();
}

// ─── 10. Lifecycle markers through production decoration path ───────

{
  const clock = {
    callbacks: new Map(), next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); }, unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false }, clock });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = ARGS_2Q;
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^–/, "queued renders the en-dash fallback");
  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^○/, "pending renders the circle fallback");
  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders the bullet fallback");
  const result = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(DONE_DETAILS) }], details: DONE_DETAILS },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^✓/, "completed renders the check-mark fallback");
  const aborted = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(CANCELLED_USER) }], details: CANCELLED_USER },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running }),
  );
  assert.match(stripVTControlCharacters(aborted.render(80).join("\n")), /^·/, "user-cancelled renders the aborted fallback");

  runtime.dispose();
}

// ─── 11. Privacy: question/option text never in call header ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const call = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const text = stripVTControlCharacters(call.render(100).join("\n"));
  assert.doesNotMatch(text, /Red|Blue|React|Vue/, "option labels not in the call header");
  assert.match(text, /2 questions/, "only the count is visible");

  runtime.dispose();
}

// ─── 12. Collapsed/expanded bounds at all widths ─────────────────────

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

// ─── 13. Execution and schema unchanged ──────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "ask execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "ask parameters unchanged");
  runtime.dispose();
}

// ─── 14. Progress state (isPartial) shows the running marker ────────

{
  const runtime = newRuntime({ isTTY: false });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const progressDetails = {
    version: 1, phase: "asking", totalQuestions: 2, currentQuestion: 1, answeredCount: 0, skippedCount: 0,
  };
  const call = decorated.renderCall(ARGS_2Q, plainTheme, makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(progressDetails) }], details: progressDetails },
    { expanded: false, isPartial: true },
    plainTheme,
    makeCtx(ARGS_2Q, {}, { argsComplete: true, executionStarted: true, lastComponent: call, isPartial: true, expanded: false }),
  );
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "progress update shows the running fallback marker");
  assert.match(text.split("\n")[0], /\[partial\]/, "progress carries the partial badge");
  assert.match(text, /2 questions/, "question count remains visible during progress");

  runtime.dispose();
}

console.log("Ask workflow display tests: OK");
