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
    name: "todo", label: "Todo", description: "todo tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

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

const ITEMS = [
  { id: "todo-1", text: "Explore codebase", status: "completed" },
  { id: "todo-2", text: "Write tests", status: "in_progress" },
  { id: "todo-3", text: "Review PR", status: "pending" },
];

const DETAILS = {
  version: 1, status: "ok", action: "set", changed: true, stateVersion: 2,
  title: "Sprint 42", counts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
  currentId: "todo-2", widget: "shown", items: ITEMS,
};

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Three-state markers (✓/◆/○) in task records ───────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, { action: "list" }, DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Completed → ✓
  assert.match(text, /✓ 1\.\s*Explore codebase/, "completed task shows ✓ marker");
  // In-progress → ◆ (current)
  assert.match(text, /◆ 2\.\s*Write tests/, "in-progress task shows ◆ marker");
  // Pending → ○
  assert.match(text, /○ 3\.\s*Review PR/, "pending task shows ○ marker");
  // Current marker
  assert.match(text, /current=yes/, "in-progress task shows current=yes");

  runtime.dispose();
}

// ─── 2. Metadata and summary carry action and counts (C8 prunes restating sections) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, { action: "set", todos: [{ text: "A" }] }, DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.ok(!text.includes("ACTION"), "ACTION restating section is pruned (C8)");
  assert.ok(!text.includes("SUMMARY"), "SUMMARY restating section is pruned (C8)");
  // Action fields live in the expanded metadata row
  assert.match(text, /action=set/, "metadata shows action");
  assert.match(text, /changed=true/, "metadata shows changed state");
  // Counts live in the summary row
  assert.match(text, /3 tasks/, "summary row shows total");
  assert.match(text, /1 completed/, "summary row shows completed");
  assert.match(text, /1 in progress/, "summary row shows in progress");
  assert.match(text, /1 pending/, "summary row shows pending");

  runtime.dispose();
}

// ─── 3. Task records and summary visible (PERSISTENCE pruned by C8) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, { action: "list" }, DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.ok(!text.includes("PERSISTENCE"), "PERSISTENCE restating section is pruned (C8)");
  assert.match(text, /✓ 1\.\s*Explore codebase/, "task records still render");
  assert.match(text, /3 tasks/, "summary row shows counts");

  runtime.dispose();
}

// ─── 4. Target IDs and advance policy in metadata (ACTION pruned by C8) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "check", id: "todo-2", ids: ["todo-2"], advance: true };
  const result = renderResult(decorated, args, { ...DETAILS, action: "check" }, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /action=check/, "metadata shows action");
  assert.match(text, /id=todo-2/, "metadata shows target id");
  assert.match(text, /advance=true/, "metadata shows advance policy");

  runtime.dispose();
}

// ─── 5. Task ordering preserved ────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const items = [
    { id: "c", text: "Charlie", status: "pending" },
    { id: "a", text: "Alpha", status: "pending" },
    { id: "b", text: "Bravo", status: "pending" },
  ];
  const details = { ...DETAILS, items, counts: { total: 3, pending: 3, inProgress: 0, completed: 0 }, currentId: undefined };
  const result = renderResult(decorated, { action: "set", todos: items }, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Order should be preserved: Charlie 1, Alpha 2, Bravo 3
  assert.ok(text.indexOf("Charlie") < text.indexOf("Alpha"), "item order preserved");
  assert.ok(text.indexOf("Alpha") < text.indexOf("Bravo"), "item order preserved");
  assert.match(text, /1\.\s*Charlie/, "first item numbered 1");
  assert.match(text, /3\.\s*Bravo/, "last item numbered 3");

  runtime.dispose();
}

// ─── 6. Error state renders failed marker and error section ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "start", id: "nonexistent" };
  const details = { ...DETAILS, status: "error", action: "start", changed: false, error: { code: "TODO_UNKNOWN_ID", message: "Unknown todo item ID: nonexistent" } };
  const result = renderResult(decorated, args, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "error state renders × marker");
  assert.match(text, /Error/, "ERROR section present");
  assert.match(text, /Unknown todo item ID/, "error message visible");
  // changed=false should be visible
  assert.match(text, /changed=false/, "idempotent/no-change state visible");

  runtime.dispose();
}

// ─── 7. Empty list after clear shows no tasks ──────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "clear" };
  const details = { version: 1, status: "ok", action: "clear", changed: true, stateVersion: 2, title: "", counts: { total: 0, pending: 0, inProgress: 0, completed: 0 }, widget: "cleared", items: [] };
  const result = renderResult(decorated, args, details, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "clear success renders ✓");
  assert.match(text, /0 tasks/, "empty list shows 0 tasks in summary");
  // No Tasks section when empty (recordsSection returns undefined for empty)
  assert.doesNotMatch(text, /TASKS/, "no Tasks section when empty");

  runtime.dispose();
}

// ─── 8. Lifecycle markers through production decoration path ───────

{
  const clock = {
    callbacks: new Map(), next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); }, unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true }, clock });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "set", todos: [{ text: "A" }] };
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
    { content: [{ type: "text", text: JSON.stringify(DETAILS) }], details: DETAILS },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^●/, "completed renders check mark");

  runtime.dispose();
}

// ─── 9. Metadata deduplication (no duplicate action/ids) ───────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "check", id: "todo-2", advance: true };
  const result = renderResult(decorated, args, { ...DETAILS, action: "check" }, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Count action= occurrences in metadata line (first non-rail line)
  const lines = text.split("\n");
  const metaLine = lines.find((l) => l.includes("action=") && !l.includes("ACTION")) ?? "";
  const actionCount = (metaLine.match(/action=/g) ?? []).length;
  assert.equal(actionCount, 1, "action appears exactly once in header metadata");

  runtime.dispose();
}

// ─── 10. No private task text in header ────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "set", todos: [{ text: "private task data" }] };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.doesNotMatch(callText, /private task data/, "private task text never in call display");

  runtime.dispose();
}

// ─── 11. All operations produce valid display ──────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const operations = [
    ["set", { action: "set", todos: [{ text: "A" }] }],
    ["add", { action: "add", todos: [{ text: "B" }] }],
    ["update", { action: "update", id: "todo-1", text: "Updated" }],
    ["start", { action: "start", id: "todo-2" }],
    ["pause", { action: "pause" }],
    ["check", { action: "check", id: "todo-1", advance: true }],
    ["uncheck", { action: "uncheck", id: "todo-1" }],
    ["clear", { action: "clear" }],
    ["list", { action: "list" }],
  ];
  for (const [opName, args] of operations) {
    const details = { ...DETAILS, action: args.action };
    const result = renderResult(decorated, args, details, { expanded: true });
    const text = stripVTControlCharacters(result.render(80).join("\n"));
    assert.match(text, /^●/, `${opName} renders ✓ marker`);
    assert.match(text, new RegExp(`action=${args.action}`), `${opName} shows action in ACTION section`);
  }
  runtime.dispose();
}

// ─── 12. Collapsed/expanded bounds at all widths ───────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  for (const expanded of [false, true]) {
    const result = renderResult(decorated, { action: "list" }, DETAILS, { expanded });
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `todo ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
    }
  }
  runtime.dispose();
}

// ─── 13. Execution unchanged ───────────────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "todo execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "todo parameters unchanged");
  runtime.dispose();
}

console.log("Todo transcript and widget display tests: OK");
