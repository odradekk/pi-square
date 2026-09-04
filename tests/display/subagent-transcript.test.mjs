import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateSubagentTool } = await load("../../src/subagents/display-adapter.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

const plainTheme = {
  fg(_t, text) { return String(text); },
  bg(_t, text) { return String(text); },
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

// Lifecycle-marker-sensitive tests use a color-unavailable runtime so the
// fallback glyphs (–/○/●/✓/×/·/!) distinguish states through plain text.
function newRuntime(environment = { isTTY: false }) {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment });
}

function makeDef(name = "delegate_subagent") {
  return {
    name, label: name, description: "subagent tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

const ARGS_DELEGATE = { agent: "explorer", task: "Find all display adapters", context: 2 };
const ARGS_RESUME = { id: "subagent_abcdef12", task: "Continue exploring" };

const RUN_DETAILS = {
  version: 3,
  id: "subagent_abcdef12",
  agent: { name: "explorer", effort: "high" },
  mode: "bg",
  phase: "done",
  model: "cpa/deepseek-v4-flash",
  durationMs: 12_000,
  retries: 0,
  usage: { input: 1200, output: 800, cacheRead: 400, cacheWrite: 100, cost: 0.02, turns: 6 },
  timeline: [
    { kind: "tool", phase: "start", text: 'rg {"pattern":"adapter","path":"src/display"}' },
    { kind: "tool", phase: "end", text: "rg found 5 matches" },
    { kind: "tool", phase: "start", text: 'read {"path":"src/display/adapter.ts"}' },
    { kind: "tool", phase: "end", text: "read returned content" },
  ],
  finalText: "I found 3 display adapters in src/display/.",
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

// ─── 1. Completed shows ✓, inline summary states the outcome ────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const collapsed = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: false });
  const collapsedText = stripVTControlCharacters(collapsed.render(80).join("\n"));
  assert.match(collapsedText, /^✓/, "completed delegation renders the check-mark fallback");
  // C4 revision: the collapsed entry is one row; the result preview is
  // visible only when expanded.
  assert.equal(collapsed.render(80).length, 1, "collapsed delegation renders exactly one row");
  assert.doesNotMatch(collapsedText, /display adapters/, "collapsed hides the result preview");
  assert.match(collapsedText, /done · 6 turns/, "collapsed inline summary states the outcome head");
  assert.match(collapsedText, /2\.4k/, "collapsed inline summary states the token total");
  assert.match(collapsedText, /\$0\.020 · run abcdef12/, "collapsed inline summary keeps the cost and run id tail");

  const expanded = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const expandedText = stripVTControlCharacters(expanded.render(80).join("\n"));
  assert.match(expandedText, /explorer/, "agent name visible as the header target");
  assert.match(expandedText, /display adapters/, "expanded shows the result preview");

  runtime.dispose();
}

// ─── 2. A queued record shows the queued state with the run ID ─────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "running" };
  const result = renderResult(decorated, ARGS_DELEGATE, details);
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^–/, "queued delegation shows the en-dash fallback");
  assert.match(text, /explorer/, "agent name visible while queued");
  assert.match(text, /Queued in the parent session · run abcdef12/, "queued summary states the delivery state and the run id");

  runtime.dispose();
}

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef("resume_subagent"), () => runtime);
  const details = { ...RUN_DETAILS, mode: "resume", phase: "running" };
  const result = renderResult(decorated, ARGS_RESUME, details);
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^–/, "queued resume shows the en-dash fallback");
  assert.match(text, /Resume abcdef12/, "queued resume keeps the Resume title and short run id target");
  assert.match(text, /Queued in the parent session · run abcdef12/, "queued resume summary states the queued state");
  assert.doesNotMatch(text, /done/, "a queued resume never reads as completed");

  runtime.dispose();
}

// ─── 3. Aborted shows · (overrides the isError safety net) ────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  // Realistic production shape: src/subagents/errors.ts applyRunFailure
  // always sets details.error alongside phase:"aborted" and isError:true.
  const details = {
    ...RUN_DETAILS, phase: "aborted",
    error: "Subagent failed: ABORTED\nMessage: cancelled by user\nOperation: delegate\nRetryable: no\nRetries: 0",
  };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^·/, "aborted delegate renders · not ×");

  runtime.dispose();
}

// ─── 4. Failed shows × ─────────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "error", error: "Model returned an error" };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^×/, "failed delegate renders ×");
  assert.match(text, /Model returned an error/, "error message visible");

  runtime.dispose();
}

// ─── 5. Cancelling shows ● (running) without qualifier badges ────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "cancelling" };
  // A "cancelling" checkpoint is a full render, not a streaming partial.
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isPartial: false });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "cancelling delegate shows the running bullet");
  assert.doesNotMatch(text.split("\n")[0], /\[cancelling\]/, "no cancelling badge renders");

  runtime.dispose();
}

// ─── 6. Retries produce a warning (! fallback) on completion ──────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, retries: 2 };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^!/, "completed with retries renders the warning fallback marker");
  assert.match(text, /done · 6 turns/, "completion summary head still visible");
  assert.match(text, /\$0\.020 · run abcdef12/, "completion summary tail still visible");

  runtime.dispose();
}

// ─── 6b. A queued record with retries renders no retrying badge ───

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "running", retries: 1 };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^–/, "queued delegation with retries shows the en-dash fallback");
  assert.doesNotMatch(text.split("\n")[0], /\[retrying\]/, "no retrying badge renders");

  runtime.dispose();
}

// ─── 7. Agent name visible as the target ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text.split("\n")[0], new RegExp(`^✓ Subagent explorer`), "title is Subagent, target is the agent name after the natural title");

  runtime.dispose();
}

// ─── 8. Resume shows the Resume title and the short run ID ────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef("resume_subagent"), () => runtime);
  const result = renderResult(decorated, ARGS_RESUME, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text.split("\n")[0], new RegExp(`^✓ Resume abcdef12`), "resume title is Resume, target is the short id after the natural title");

  const call = decorated.renderCall(ARGS_RESUME, plainTheme, makeCtx(ARGS_RESUME, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(callText.split("\n")[0], new RegExp(`^● Resume abcdef12`), "resume call header states the short id after the natural title");
  assert.match(callText, /Continue exploring/, "resume call shows the task");

  runtime.dispose();
}

// ─── 9. Activity shows one row per tool call, no → arrow ──────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Activity/, "Activity section present");
  const activityLines = text.split("\n").filter((line) => /^[│└]\s*[✓●×]\s/.test(line.trimStart().length ? line : line));
  // Two paired tool calls (rg, read) produce exactly two activity rows.
  const glyphRows = text.split("\n").filter((line) => /[✓●×]\s+\S+\s+\S/.test(line) && !line.includes("explorer"));
  assert.equal(glyphRows.length, 2, "one activity row per completed tool call");
  assert.match(text, /rg/, "rg tool summary visible");
  assert.match(text, /read/, "read tool summary visible");
  assert.doesNotMatch(text, /→/, "no running arrow in the activity rows");

  runtime.dispose();
}

// ─── 10. Privacy: no prompt snapshot, artifacts, or secrets ───────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = {
    ...RUN_DETAILS,
    artifactsDir: "/tmp/secret-artifacts",
    sessionFile: "/tmp/secret-session.jsonl",
    promptSnapshot: { system: "SECRET SYSTEM PROMPT", instructions: "SECRET INSTRUCTIONS" },
  };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.doesNotMatch(text, /secret-artifacts|secret-session|SECRET SYSTEM|SECRET INSTRUCTIONS/, "no secret paths or prompt snapshots leaked");

  runtime.dispose();
}

// ─── 11. Background queued expanded states the queued row ─────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, mode: "bg", phase: "running" };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /Queued in the parent session/, "expanded queued result carries the queued row");

  runtime.dispose();
}

// ─── 12. Usage section is exactly one row when expanded ───────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Usage/, "Usage section visible when expanded");
  const usageRow = text.split("\n").find((line) => line.includes("turns") && line.includes("in") && line.includes("out") && line.includes("cached"));
  assert.ok(usageRow, "usage row present");
  assert.match(usageRow, /6 turns · 1\.2k in · 800 out · 400 cached · \$0\.020/, "usage is one composed row");
  const usageRows = text.split("\n").filter((line) => /\d+(\.\d+)?k? in/.test(line));
  assert.equal(usageRows.length, 1, "usage renders as exactly one row");

  runtime.dispose();
}

// ─── 13. Unknown tool shows only "called" ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = {
    ...RUN_DETAILS,
    timeline: [{ kind: "tool", phase: "start", text: 'unknown_tool {"args":"data"}' }],
  };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /unknown_tool\s+called/, "unknown tool shows only 'called'");
  assert.doesNotMatch(text, /"args":"data"/, "no raw argument objects rendered");

  runtime.dispose();
}

// ─── 14. Bounded at all supported widths ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  for (const expanded of [false, true]) {
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded });
      assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `subagent ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
    }
  }
  runtime.dispose();
}

// ─── 15. Call shows the task inline but never the cwd ────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const args = { agent: "explorer", task: "Find adapters", cwd: "/secret/path", context: 3 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(text.split("\n")[0], /explorer/, "agent name visible in the call header");
  // C4 revision: the collapsed call is one row; the task is the inline summary.
  assert.match(text, /Find adapters/, "task visible as the inline summary");
  assert.doesNotMatch(text, /\/secret\/path/, "cwd never appears in the call display");

  const expandedCall = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true, expanded: true }));
  const expandedText = stripVTControlCharacters(expandedCall.render(80).join("\n"));
  assert.match(expandedText, /3 context messages/, "expanded call states the context count");
  assert.doesNotMatch(expandedText, /\/secret\/path/, "cwd never appears even expanded");

  runtime.dispose();
}

// ─── 16. Execution and schema unchanged ────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateSubagentTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "parameters unchanged");
  runtime.dispose();
}

console.log("Subagent transcript display tests: OK");
