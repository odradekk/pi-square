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

// ─── 1. Three-state glyphs (✓/●/○) in task records, no raw fields ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, { action: "list" }, DETAILS, { expanded: true });
  // Wide-tier column so the full summary fits beside the natural title.
  const text = stripVTControlCharacters(result.render(160).join("\n"));
  // Completed → ✓, in-progress/current → ●, pending → ○
  assert.match(text, /✓\s+1\s+Explore codebase/, "completed task shows ✓ glyph");
  assert.match(text, /●\s+2\s+Write tests/, "in-progress/current task shows ● glyph");
  assert.match(text, /○\s+3\s+Review PR/, "pending task shows ○ glyph");
  // The rewrite drops the raw id=/status=/current= fields entirely.
  assert.doesNotMatch(text, /\bid=/, "no raw id= field");
  assert.doesNotMatch(text, /\bstatus=/, "no raw status= field");
  assert.doesNotMatch(text, /\bcurrent=/, "no raw current= field");

  runtime.dispose();
}

// ─── 2. No ACTION/SUMMARY sections; one summary row states the counts ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, { action: "set", todos: [{ text: "A" }] }, DETAILS, { expanded: true });
  // Wide-tier column so the full summary fits beside the natural title.
  const text = stripVTControlCharacters(result.render(160).join("\n"));
  assert.ok(!text.includes("ACTION"), "no ACTION section");
  assert.ok(!text.includes("SUMMARY"), "no SUMMARY section");
  assert.doesNotMatch(text, /\baction=/, "no action= metadata row");
  assert.doesNotMatch(text, /\bchanged=/, "no changed= metadata row");
  assert.match(text, /1 of 3 done/, "summary row states progress counts");
  assert.match(text, /Sprint 42/, "summary row states the list title");

  runtime.dispose();
}

// ─── 3. Task records and summary visible; no PERSISTENCE section ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const result = renderResult(decorated, { action: "list" }, DETAILS, { expanded: true });
  const text = stripVTControlCharacters(result.render(160).join("\n"));
  assert.ok(!text.includes("PERSISTENCE"), "no PERSISTENCE section");
  assert.match(text, /✓\s+1\s+Explore codebase/, "task records still render");
  assert.match(text, /1 of 3 done/, "summary row shows counts");

  runtime.dispose();
}

// ─── 4. No metadata row at all, even with id/ids/advance args ──────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "check", id: "todo-2", ids: ["todo-2"], advance: true };
  const result = renderResult(decorated, args, { ...DETAILS, action: "check" }, { expanded: true });
  const text = stripVTControlCharacters(result.render(160).join("\n"));
  assert.doesNotMatch(text, /\baction=/, "no action= metadata");
  assert.doesNotMatch(text, /\bid=/, "no id= metadata");
  assert.doesNotMatch(text, /\badvance=/, "no advance= metadata");
  // The action word is still visible as the header target after the natural  // title instead.
  assert.match(text.split("\n")[0], new RegExp(`● Tasks check`), "header target states the action");

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
  assert.ok(text.indexOf("Charlie") < text.indexOf("Alpha"), "item order preserved");
  assert.ok(text.indexOf("Alpha") < text.indexOf("Bravo"), "item order preserved");
  assert.match(text, /○\s+1\s+Charlie/, "first item numbered 1");
  assert.match(text, /○\s+3\s+Bravo/, "last item numbered 3");
  // Non-default ids show as a muted body line under the record.
  assert.match(text, /\bc\b/, "custom id visible in the record body");

  runtime.dispose();
}

// ─── 6. Error renders a human sentence, no raw JSON in collapsed ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "start", id: "nonexistent" };
  const details = {
    ...DETAILS, status: "error", action: "start", changed: false,
    error: { code: "TODO_UNKNOWN_ID", message: "Unknown todo item ID: nonexistent" },
  };
  const collapsed = renderResult(decorated, args, details, { isError: true, expanded: false });
  const collapsedText = stripVTControlCharacters(collapsed.render(100).join("\n"));
  assert.match(collapsedText, /Unknown task id nonexistent/, "collapsed error states the human sentence");
  assert.doesNotMatch(collapsedText, /"code":"TODO_UNKNOWN_ID"/, "collapsed error carries no raw JSON");

  const expanded = renderResult(decorated, args, details, { isError: true, expanded: true });
  const expandedText = stripVTControlCharacters(expanded.render(100).join("\n"));
  assert.match(expandedText, /Unknown task id nonexistent/, "expanded error states the human sentence");

  // Fallback marker for a failed result is ×.
  const failRuntime = newRuntime({ isTTY: false });
  const failDecorated = decorateInternalTool(makeDef(), () => failRuntime);
  const failResult = renderResult(failDecorated, args, details, { isError: true, expanded: false });
  assert.match(stripVTControlCharacters(failResult.render(80).join("\n")), /^×/, "failed todo renders × fallback marker");

  runtime.dispose();
  failRuntime.dispose();
}

// ─── 7. Empty list states "No tasks" / "List cleared" ──────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  const clearArgs = { action: "clear" };
  const clearDetails = {
    version: 1, status: "ok", action: "clear", changed: true, stateVersion: 2,
    title: "", counts: { total: 0, pending: 0, inProgress: 0, completed: 0 }, widget: "cleared", items: [],
  };
  const clearResult = renderResult(decorated, clearArgs, clearDetails, { expanded: true });
  const clearText = stripVTControlCharacters(clearResult.render(100).join("\n"));
  assert.match(clearText, /List cleared/, "clear action states the list was cleared");
  assert.doesNotMatch(clearText, /[✓●○]\s+1\s+/, "no task record glyphs when the list is empty");

  const listArgs = { action: "list" };
  const listDetails = {
    version: 1, status: "ok", action: "list", changed: false, stateVersion: 1,
    title: "", counts: { total: 0, pending: 0, inProgress: 0, completed: 0 }, widget: "shown", items: [],
  };
  const listResult = renderResult(decorated, listArgs, listDetails, { expanded: true });
  const listText = stripVTControlCharacters(listResult.render(100).join("\n"));
  assert.match(listText, /No tasks/, "listing an empty list states no tasks");

  runtime.dispose();
}

// ─── 8. Lifecycle markers through production decoration path ───────

{
  const clock = {
    callbacks: new Map(), next: 1,
    setInterval(cb) { const id = this.next++; this.callbacks.set(id, cb); return id; },
    clearInterval(id) { this.callbacks.delete(id); }, unref() {},
  };
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: false }, clock });
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "set", todos: [{ text: "A" }] };
  const state = {};
  const queued = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: false, executionStarted: false }));
  assert.match(stripVTControlCharacters(queued.render(80).join("\n")), /^–/, "queued renders the en-dash fallback");
  const pending = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: false, lastComponent: queued }));
  assert.match(stripVTControlCharacters(pending.render(80).join("\n")), /^○/, "pending renders the circle fallback");
  const running = decorated.renderCall(args, plainTheme, makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: pending }));
  assert.match(stripVTControlCharacters(running.render(80).join("\n")), /^●/, "running renders the bullet fallback");
  const result = decorated.renderResult(
    { content: [{ type: "text", text: JSON.stringify(DETAILS) }], details: DETAILS },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, state, { argsComplete: true, executionStarted: true, lastComponent: running }),
  );
  assert.match(stripVTControlCharacters(result.render(80).join("\n")), /^✓/, "completed renders the check-mark fallback");

  runtime.dispose();
}

// ─── 9. No metadata row anywhere (zero action= occurrences) ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "check", id: "todo-2", advance: true };
  const result = renderResult(decorated, args, { ...DETAILS, action: "check" }, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  const actionCount = (text.match(/\baction=/g) ?? []).length;
  assert.equal(actionCount, 0, "no action= metadata anywhere in the transcript");

  runtime.dispose();
}

// ─── 10. No private task text in the call header ───────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { action: "set", todos: [{ text: "private task data" }] };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.doesNotMatch(callText, /private task data/, "private task text never appears in the call display");

  runtime.dispose();
}

// ─── 11. All operations produce a valid display ─────────────────────

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
    assert.match(text, /^●/, `${opName} renders the bullet marker`);
    assert.match(text.split("\n")[0], new RegExp(`● Tasks ${args.action}`), `${opName} shows the action as the header target after the natural title`);
  }
  runtime.dispose();
}

// ─── 12. Collapsed/expanded bounds at all widths ────────────────────

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

// ─── 13. Execution unchanged ────────────────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "todo execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "todo parameters unchanged");
  runtime.dispose();
}

console.log("Todo transcript and widget display tests: OK");
