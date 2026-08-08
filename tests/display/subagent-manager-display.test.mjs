import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const managerModule = await load("../../src/subagents/manager.ts");
const { SubagentManager, managerPanelWidth, managerRowBudget } = managerModule.__testables;

function plainTheme() {
  return { fg(_c, t) { return t; }, bg(_c, t) { return t; }, bold(t) { return t; } };
}

function tui() {
  return { requestRender() {} };
}

function keybindings() {
  return { get() { return undefined; } };
}

function theme() {
  return plainTheme();
}

function makeData(overrides = {}) {
  return {
    running: [],
    session: [],
    definitions: [],
    errors: [],
    cwd: "/tmp",
    parentSessionId: "parent-1234",
    ...overrides,
  };
}

function makeDefinition(overrides = {}) {
  return {
    name: "explorer",
    description: "Local codebase explorer",
    model: undefined,
    effort: undefined,
    inheritParentSystem: true,
    tools: undefined,
    extensionTools: ["rg", "fd"],
    skills: undefined,
    layers: [{ source: "package", filePath: "/pkg/subagents/explorer.yaml" }],
    fieldSources: { policy: { source: "package" }, instructions: undefined, output: undefined },
    policy: "read-only",
    instructions: undefined,
    output: undefined,
    ...overrides,
  };
}

function render(manager, width) {
  const lines = manager.render(width);
  return lines.map((line) => stripVTControlCharacters(line)).join("\n");
}

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Header uses label-led "Subagents" not all-caps ────────────

{
  const manager = new SubagentManager(makeData(), tui(), theme(), keybindings(), () => {});
  const text = render(manager, 80);
  assert.match(text, /^◆ Subagents/m, "header uses ◆ Subagents");
  assert.doesNotMatch(text, /SUBAGENTS/, "no all-caps SUBAGENTS");
  manager.dispose();
}

// ─── 2. Detail rows use label-led "Label: value" grammar ──────────

{
  const data = makeData({
    running: [{
      id: "subagent_aabbccdd-1122-4333-8444-556677889900",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      details: {
        version: 3,
        id: "subagent_aabbccdd-1122-4333-8444-556677889900",
        agent: { name: "explorer", effort: "high" },
        mode: "bg",
        phase: "running",
        model: "test/model",
        durationMs: 5000,
        retries: 0,
        task: "Find all adapters",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
        timeline: [{ kind: "tool", phase: "start", text: 'rg {"pattern":"adapter","path":"src"}' }],
        liveText: "Searching...",
        finalText: "",
        startedAt: Date.now() - 3000,
      },
    }],
  });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  const text = render(manager, 100);
  // Label-led grammar
  assert.match(text, /ID:/, "detail uses ID: label");
  assert.match(text, /Task:/, "detail uses Task: label");
  assert.match(text, /Activity:/, "detail uses Activity: label");
  assert.match(text, /Usage:/, "detail uses Usage: label");
  // No old grammar
  assert.doesNotMatch(text, /ACTIVITY  /, "no old ACTIVITY label prefix");
  assert.doesNotMatch(text, /USAGE  /, "no old USAGE label prefix");
  // Activity shows tool summary
  assert.match(text, /rg/, "activity shows rg tool");
  // Task visible
  assert.match(text, /Find all adapters/, "task visible in detail");
  manager.dispose();
}

// ─── 3. Definitions tab shows label-led detail rows ───────────────

{
  const data = makeData({
    definitions: [makeDefinition()],
  });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  manager["switchTab"](1); // session
  manager["switchTab"](1); // definitions
  const text = render(manager, 100);
  assert.match(text, /Description:/, "definitions shows Description: label");
  assert.match(text, /Model:/, "definitions shows Model: label");
  assert.match(text, /Effort:/, "definitions shows Effort: label");
  assert.match(text, /Tools:/, "definitions shows Tools: label");
  assert.match(text, /Extensions:/, "definitions shows Extensions: label");
  assert.match(text, /Skills:/, "definitions shows Skills: label");
  assert.match(text, /Layers:/, "definitions shows Layers: label");
  assert.match(text, /Policy:/, "definitions shows Policy: label");
  manager.dispose();
}

// ─── 4. Privacy: no prompt snapshots, artifacts, secrets ──────────

{
  const data = makeData({
    running: [{
      id: "subagent_aabbccdd",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      details: {
        version: 3,
        id: "subagent_aabbccdd",
        agent: { name: "explorer", effort: "high" },
        mode: "bg",
        phase: "running",
        model: "test/model",
        durationMs: 5000,
        retries: 0,
        task: "password=secret-task",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        timeline: [],
        liveText: "",
        finalText: "",
        startedAt: Date.now(),
        artifactsDir: "/tmp/secret-artifacts",
        promptSnapshot: { version: 2, manifest: { definitionHash: "abc", effectiveSystemHash: "def" }, system: "SECRET" },
      },
    }],
  });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  const text = render(manager, 100);
  assert.doesNotMatch(text, /secret-artifacts/, "no artifact path leaked");
  assert.doesNotMatch(text, /SECRET/, "no prompt snapshot leaked");
  assert.doesNotMatch(text, /secret-task/, "secret in task sanitized");
  manager.dispose();
}

// ─── 5. Empty states show helpful messages ────────────────────────

{
  const manager = new SubagentManager(makeData(), tui(), theme(), keybindings(), () => {});
  const text = render(manager, 80);
  assert.match(text, /No active background subagents/, "running empty state");
  manager["switchTab"](1); // session
  const sessionText = render(manager, 80);
  assert.match(sessionText, /No V3 subagents/, "session empty state");
  manager["switchTab"](1); // definitions
  const defText = render(manager, 80);
  assert.match(defText, /No valid V2 definitions/, "definitions empty state");
  manager.dispose();
}

// ─── 6. Narrow terminal uses stacked layout with Detail section ───

{
  const data = makeData({
    running: [{
      id: "subagent_aabbccdd",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      details: {
        version: 3,
        id: "subagent_aabbccdd",
        agent: { name: "explorer", effort: "high" },
        mode: "bg",
        phase: "running",
        model: "test/model",
        durationMs: 5000,
        retries: 0,
        task: "Quick task",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        timeline: [],
        liveText: "",
        finalText: "",
        startedAt: Date.now(),
      },
    }],
  });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  const narrow = render(manager, 40);
  // Narrow should show Detail section header (label-led)
  assert.match(narrow, /Detail/, "narrow shows Detail section");
  manager.dispose();
}

// ─── 7. managerPanelWidth and managerRowBudget bounds ─────────────

{
  assert.equal(managerPanelWidth(40), 40, "panel width 40");
  assert.equal(managerPanelWidth(120), 100, "panel width 120");
  assert.ok(managerRowBudget(18) >= 5, "row budget 18 >= 5");
  assert.ok(managerRowBudget(30) <= 30, "row budget 30 <= 30");
}

// ─── 8. Unknown tool shows only 'called' ──────────────────────────

{
  const data = makeData({
    running: [{
      id: "subagent_aabbccdd",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      details: {
        version: 3,
        id: "subagent_aabbccdd",
        agent: { name: "explorer", effort: "high" },
        mode: "bg",
        phase: "running",
        model: "test/model",
        durationMs: 5000,
        retries: 0,
        task: "Task",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        timeline: [{ kind: "tool", phase: "start", text: 'unknown_tool {"secret":"data"}' }],
        liveText: "",
        finalText: "",
        startedAt: Date.now(),
      },
    }],
  });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  const text = render(manager, 100);
  assert.match(text, /Activity:.*called/, "unknown tool shows 'called'");
  assert.doesNotMatch(text, /"secret":"data"/, "no raw arg objects");
  manager.dispose();
}

// ─── 9. Running tab list rows show operational lifecycle markers ─

{
  const baseDetails = {
    version: 3,
    id: "subagent_aabbccdd",
    agent: { name: "worker", effort: "high" },
    mode: "bg",
    phase: "running",
    model: "test/model",
    durationMs: 5000,
    retries: 0,
    task: "Task",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    liveText: "",
    finalText: "",
    startedAt: Date.now(),
  };
  const queued = { id: "subagent_qqqqqqqq", status: "queued", createdAt: 1, updatedAt: 2, details: { ...baseDetails, id: "subagent_qqqqqqqq" } };
  const running = { id: "subagent_rrrrrrrr", status: "running", createdAt: 1, updatedAt: 2, details: { ...baseDetails, id: "subagent_rrrrrrrr" } };
  const cancelling = { id: "subagent_cccccccc", status: "cancelling", createdAt: 1, updatedAt: 2, details: { ...baseDetails, id: "subagent_cccccccc" } };
  const data = makeData({ running: [queued, running, cancelling] });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  const text = render(manager, 120);
  assert.match(text, /\u2013 queued/, "queued job shows – marker");
  assert.match(text, /\u2192 running/, "running job shows → marker");
  assert.match(text, /\u00d7 cancelling/, "cancelling job shows × marker");
  manager.dispose();
}

// ─── 10. Session tab list rows show operational lifecycle markers ─

{
  const baseDetails = {
    version: 3,
    agent: { name: "worker", effort: "high" },
    mode: "bg",
    model: "test/model",
    durationMs: 5000,
    retries: 0,
    task: "Task",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    liveText: "",
    finalText: "",
    startedAt: Date.now(),
    promptSnapshot: { version: 2, manifest: { definitionHash: "abc", effectiveSystemHash: "def" } },
  };
  const done = { ...baseDetails, id: "subagent_done00000", phase: "done", finalText: "ok" };
  const errored = { ...baseDetails, id: "subagent_error000", phase: "error", error: "failed" };
  const aborted = { ...baseDetails, id: "subagent_abort000", phase: "aborted" };
  const data = makeData({ running: [], session: [done, errored, aborted], activeSessionIds: [] });
  const manager = new SubagentManager(data, tui(), theme(), keybindings(), () => {});
  manager["switchTab"](1); // session
  const text = render(manager, 120);
  assert.match(text, /\u2713 done/, "done phase shows ✓ marker");
  assert.match(text, /\u2717 error/, "error phase shows ✗ marker");
  assert.match(text, /\u00d7 aborted/, "aborted phase shows × marker");
  manager.dispose();
}

console.log("Subagent manager display tests: OK");
