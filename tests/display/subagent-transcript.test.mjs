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

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });
}

function makeDef(name = "subagent_delegate") {
  return {
    name, label: name, description: "subagent tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

const ARGS_DELEGATE = { agent: "explorer", mode: "fg", task: "Find all display adapters" };
const ARGS_RESUME = { id: "subagent_abcdef12", task: "Continue exploring" };

const RUN_DETAILS = {
  version: 3,
  id: "subagent_abcdef12",
  agent: { name: "explorer", effort: "high" },
  mode: "fg",
  phase: "done",
  model: "cpa/deepseek-v4-flash",
  durationMs: 12_000,
  retries: 0,
  usage: { input: 1200, output: 800, cacheRead: 400, cacheWrite: 100, cost: 0.02, turns: 3 },
  timeline: [
    { kind: "tool", phase: "start", text: 'rg {"pattern":"adapter","path":"src/display"}' },
    { kind: "tool", phase: "end", text: "rg found 5 matches" },
    { kind: "tool", phase: "start", text: 'read {"path":"src/display/adapter.ts"}' },
    { kind: "tool", phase: "end", text: "read returned content" },
  ],
  liveText: "I found 3 display adapters in src/display/.",
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

// ─── 1. Completed delegate shows ✓ marker ─────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "completed delegate renders ✓");
  assert.match(text, /explorer/, "agent name visible");
  assert.match(text, /display adapters/, "result text visible");
  runtime.dispose();
}

// ─── 2. Running partial shows braille animation ───────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "running" };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isPartial: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "running delegate shows braille");
  assert.match(text, /explorer/, "agent name visible during running");
  runtime.dispose();
}

// ─── 3. Aborted delegate shows · marker (overrides isError) ────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "aborted" };
  // isError:true for tool-aborted, but lifecycle overrides to aborted
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "aborted delegate renders · not ·");
  runtime.dispose();
}

// ─── 4. Failed delegate shows × marker ────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "error", error: "Model returned an error" };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "failed delegate renders ×");
  assert.match(text, /Model returned an error/, "error message visible");
  runtime.dispose();
}

// ─── 5. Cancelling delegate shows running with cancelling qualifier ─

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "cancelling" };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isPartial: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "cancelling delegate shows braille (running)");
  runtime.dispose();
}

// ─── 6. Retries produce warning qualifier on completed ────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, retries: 2 };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "completed with retries renders ! (warning qualifier)");
  assert.match(text, /retries=2/, "retry count visible in expanded metadata");
  runtime.dispose();
}

// ─── 6b. Active retry during partial shows retrying qualifier ──────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, phase: "running", retries: 1 };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { isPartial: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "active retry shows running braille");
  assert.match(text, /retries=1/, "retry count visible during active retry");
  runtime.dispose();
}

// ─── 7. Agent identity and target visible ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /Subagent/, "title visible");
  assert.match(text, /explorer/, "target (agent name) visible");
  runtime.dispose();
}

// ─── 8. Resume shows resume identity ───────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef("subagent_resume"), () => runtime);
  const result = renderResult(decorated, ARGS_RESUME, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /Resume subagent/, "resume title visible");
  assert.match(text, /abcdef12/, "resume short ID visible");
  runtime.dispose();
}

// ─── 9. ACTIVITY section shows allowlisted tool summaries ─────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Activity/, "ACTIVITY section title present");
  assert.match(text, /rg/, "rg tool summary visible");
  assert.match(text, /read/, "read tool summary visible");
  // No ACTIVITY label prefix in rows (old grammar removed)
  const lines = text.split("\n");
  const activityLines = lines.filter((l) => l.includes("rg") && !l.includes("Activity"));
  assert.ok(activityLines.some((l) => !l.startsWith("ACTIVITY")), "no ACTIVITY label prefix in rows");
  runtime.dispose();
}

// ─── 10. Privacy: no prompt snapshot, artifacts, or secrets ───────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = {
    ...RUN_DETAILS,
    agent: { name: "explorer", effort: "high" },
    // Simulate secret data that should NOT render
    artifactsDir: "/tmp/secret-artifacts",
    sessionFile: "/tmp/secret-session.jsonl",
    promptSnapshot: { system: "SECRET SYSTEM PROMPT", instructions: "SECRET INSTRUCTIONS" },
  };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.doesNotMatch(text, /secret-artifacts|secret-session|SECRET SYSTEM|SECRET INSTRUCTIONS/, "no secret paths or prompt snapshots leaked");
  runtime.dispose();
}

// ─── 11. Background running shows queued message ──────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = { ...RUN_DETAILS, mode: "bg", phase: "running" };
  const result = renderResult(decorated, ARGS_DELEGATE, details);
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /Queued in the parent session/, "background running shows queued message");
  runtime.dispose();
}

// ─── 12. Usage section visible when expanded ──────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const result = renderResult(decorated, ARGS_DELEGATE, RUN_DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /Usage/, "USAGE section visible when expanded");
  assert.match(text, /turns/, "turns in usage");
  assert.match(text, /input/, "input in usage");
  assert.match(text, /output/, "output in usage");
  runtime.dispose();
}

// ─── 13. Unknown tool shows only 'called' ─────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const details = {
    ...RUN_DETAILS,
    timeline: [{ kind: "tool", phase: "start", text: 'unknown_tool {"args":"data"}' }],
  };
  const result = renderResult(decorated, ARGS_DELEGATE, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /called/, "unknown tool shows 'called'");
  // No raw argument object rendered
  assert.doesNotMatch(text, /"args":"data"/, "no raw argument objects");
  runtime.dispose();
}

// ─── 14. Bounded at all supported widths ──────────────────────────

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

// ─── 15. Call shows task preview but not private args ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateSubagentTool(makeDef(), () => runtime);
  const args = { agent: "explorer", mode: "fg", task: "Find adapters", cwd: "/secret/path" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const text = stripVTControlCharacters(call.render(80).join("\n"));
  assert.match(text, /explorer/, "agent name visible in call");
  assert.match(text, /Find adapters/, "task visible in call");
  assert.doesNotMatch(text, /\/secret\/path/, "cwd not in call display");
  runtime.dispose();
}

// ─── 16. Execution and schema unchanged ───────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateSubagentTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "parameters unchanged");
  runtime.dispose();
}

console.log("Subagent transcript display tests: OK");
