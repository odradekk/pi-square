import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";

initTheme();
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { renderSubagentNotification } = await load(join(packageRoot, "src", "subagents", "render.ts"));
const { describeSubagentRun } = await load(join(packageRoot, "src", "subagents", "display-adapter.ts"));
const themeModulePath = pathToFileURL(join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);

const plainTheme = {
  fg(_color, text) { return String(text); },
  bg(_color, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

function plainLines(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function details(overrides = {}) {
  return {
    version: 4,
    id: "subagent_12345678-abcd-4abc-8abc-123456789abc",
    operation: "delegate",
    artifactsDir: "/tmp/private-artifacts",
    sessionFile: "/tmp/private-artifacts/session.jsonl",
    sessionId: "native-private-id",
    originParentSessionId: "parent-private-id",
    lastParentSessionId: "parent-private-id",
    promptSnapshot: {
      version: 3,
      system: "private system",
      manifest: {
        contractVersion: 3,
        governanceVersion: 1,
        inheritParentSystem: true,
        effectiveSystemHash: "hash",
        governanceHash: "hash",
        contextCount: 0,
        fieldSources: {},
        sourceFiles: [],
      },
    },
    phase: "completed",
    agent: { promptVersion: 2, name: "explorer", effort: "high", inheritParentSystem: true },
    task: "Inspect the parser and report concrete evidence.",
    cwd: "/tmp/project",
    model: "provider/model",
    startedAt: Date.now() - 1500,
    endedAt: Date.now(),
    durationMs: 1500,
    finalText: "# Finding\n\nThe parser preserves quoted input.\n\nUnique expanded tail.",
    retries: 0,
    toolErrors: [],
    usage: { input: 1200, output: 340, cacheRead: 20, cacheWrite: 0, cost: 0.0012, turns: 2 },
    timeline: [
      { kind: "tool", phase: "start", text: "grep {\"pattern\":\"needle\",\"path\":\"src\"}" },
      { kind: "tool", phase: "end", text: "grep: SECRET TOOL OUTPUT", isError: false },
    ],
    ...overrides,
  };
}

const run = details();
const message = {
  content: "background content",
  details: {
    version: 5,
    deliveryId: "delivery-1",
    resent: false,
    results: [{ id: run.id, status: "completed", result: run }],
  },
};

// ─── 1. Completion content uses the canonical transcript description ──

{
  const shared = describeSubagentRun("delegate_subagent", run, { expanded: false, isError: false }, "background content");
  assert.equal(shared.tool, "delegate_subagent", "notification reuses the transcript tool identity");
  assert.equal(shared.family, "agent", "notification reuses the agent family");
  assert.equal(shared.lifecycle, "completed", "done phase resolves to the completed lifecycle");
  assert.equal(shared.title, "Subagent");
  assert.equal(shared.target, "explorer");
}

// ─── 2. Native shell remains the documented exception ────────────────

const collapsedBackgrounds = [];
const collapsed = plainLines(renderSubagentNotification(message, { expanded: false }, {
  ...plainTheme,
  bg(color, text) { collapsedBackgrounds.push(color); return String(text); },
}), 80).join("\n");
assert.ok(collapsedBackgrounds.includes("toolSuccessBg"), "done result keeps Pi's native success shell");

// ─── 3. Collapsed entry uses the operational grammar ─────────────────

assert.match(collapsed, /✓ Subagent\s+explorer/, "marker, stable title column, and target");
// C4 revision: the collapsed notification is one row; the result preview is
// visible only when expanded. The inline summary states the outcome.
assert.doesNotMatch(collapsed, /Finding/, "collapsed hides the result preview");
assert.match(collapsed, /run 12345678/, "collapsed shows the run ID in the inline summary");
assert.doesNotMatch(collapsed, /id=12345678|operation=delegate|phase=completed/, "key=value metadata stays out of the collapsed row");

// ─── 4. Privacy: no prompts, artifacts, raw sessions, or payloads ────

const expanded = plainLines(renderSubagentNotification(message, { expanded: true }, plainTheme), 80).join("\n");
for (const text of [collapsed, expanded]) {
  assert.doesNotMatch(text, /SECRET TOOL OUTPUT/, "tool result payloads never render");
  assert.doesNotMatch(text, /private-artifacts/, "artifact paths never render");
  assert.doesNotMatch(text, /native-private-id|parent-private-id/, "raw session identity never renders");
  assert.doesNotMatch(text, /private system/, "prompt snapshots never render");
}
assert.doesNotMatch(collapsed, /subagent_12345678-abcd/, "the full run ID stays out of the collapsed entry");

// ─── 5. Expanded entry reveals task, result, and activity ────────────

assert.match(expanded, /Unique expanded tail/, "expanded reveals the bounded full result");
assert.match(expanded, /Inspect the parser/, "expanded reveals the delegated task");
assert.match(expanded, /run 12345678/, "expanded shows the bounded short run identity in the summary");
assert.match(expanded, /delegate/, "expanded shows the run operation in the identity row");
assert.match(expanded, /completed/, "expanded shows the terminal phase in the summary");
assert.match(expanded, /Task/, "expanded uses the shared label-led section rule");
assert.match(expanded, /Result/, "result section uses the shared section rule");
assert.match(expanded, /Activity/, "activity section uses the shared section rule");
assert.match(expanded, /needle/, "allowlisted tool-call summary remains visible");

// ─── 6. Error and aborted deliveries ─────────────────────────────────

const failed = details({ phase: "failed", finalText: "", error: "failed" });
const errorBackgrounds = [];
const errorText = plainLines(renderSubagentNotification({
  content: "failed",
  details: {
    version: 5,
    deliveryId: "delivery-2",
    resent: false,
    results: [{ id: failed.id, status: "failed", result: failed }],
  },
}, { expanded: false }, {
  ...plainTheme,
  bg(color, text) { errorBackgrounds.push(color); return String(text); },
}), 80).join("\n");
assert.ok(errorBackgrounds.includes("toolErrorBg"), "error result keeps Pi's native error shell");
assert.match(errorText, /× Subagent/, "error renders the failed marker");

const abortedDetails = details({ phase: "aborted", finalText: "", error: "cancelled" });
const abortedBackgrounds = [];
const abortedText = plainLines(renderSubagentNotification(
  {
    content: "aborted",
    details: {
      version: 5,
      deliveryId: "delivery-3",
      resent: false,
      results: [{ id: abortedDetails.id, status: "failed", result: abortedDetails }],
    },
  },
  { expanded: false },
  { ...plainTheme, bg(color, text) { abortedBackgrounds.push(color); return String(text); } },
), 80).join("\n");
assert.match(abortedText, /· Subagent/, "aborted renders the aborted marker, not the failed marker");
assert.doesNotMatch(abortedText, /× Subagent/, "aborted does not render the failed marker");
assert.ok(abortedBackgrounds.includes("toolErrorBg"), "aborted notification uses the error shell");

// ─── 6b. A resumed run's completion keeps its Resume identity ─────────

{
  const resumed = details({ operation: "resume" });
  const resumedMessage = {
    content: "resumed content",
    details: {
      version: 5,
      deliveryId: "delivery-4",
      resent: false,
      results: [{ id: resumed.id, status: "completed", result: resumed }],
    },
  };
  const resumedText = plainLines(renderSubagentNotification(
    resumedMessage,
    { expanded: false },
    plainTheme,
  ), 80).join("\n");
  assert.match(resumedText, /✓ Resume\s+12345678/, "a resumed completion renders the Resume title and short run id");
  assert.doesNotMatch(resumedText, /Subagent\s+explorer/, "a resumed completion does not render as a fresh delegation");
  const resumedExpanded = plainLines(renderSubagentNotification(
    resumedMessage,
    { expanded: true },
    plainTheme,
  ), 80).join("\n");
  assert.match(resumedExpanded, /resume/, "the identity row states the resumed run kind");
}

// ─── 7. Unknown payloads fall back without breaking the shell ────────

{
  const fallback = renderSubagentNotification(
    { content: "Background subagent finished", details: undefined },
    { expanded: false },
    plainTheme,
  );
  assert.match(plainLines(fallback, 80).join("\n"), /Background subagent finished/);
}

// ─── 7b. A malformed V5 entry renders nothing ────────────────────────

{
  const valid = details({ id: "subagent_99999999-9999-4999-8999-999999999999" });
  const malformed = renderSubagentNotification(
    {
      content: "one structured run and one malformed entry",
      details: {
        version: 5,
        deliveryId: "delivery-6",
        resent: false,
        results: [
          { id: "run-missing-status", result: details({ id: "subagent_88888888-8888-4888-8888-888888888888" }) },
          { id: "run-non-v4-result", status: "completed", result: { ...valid, version: 3 } },
          { id: "run-mismatched-id", status: "failed", result: valid },
          { id: valid.id, status: "completed", result: valid },
        ],
      },
    },
    { expanded: false },
    plainTheme,
  );
  const text = plainLines(malformed, 80).join("\n");
  const renderedRuns = text.split("\n").filter((line) => /Subagent\s+explorer/.test(line));
  assert.equal(renderedRuns.length, 1, "only the complete entry renders a run");
  assert.match(renderedRuns[0], /✓ Subagent\s+explorer/, "the complete entry renders its own run");
  assert.doesNotMatch(text, /88888888/, "a malformed entry renders no run of its own");
  // With every entry malformed, the delivery falls back to the bounded content.
  const allMalformed = renderSubagentNotification(
    {
      content: "only malformed entries",
      details: {
        version: 5,
        deliveryId: "delivery-7",
        resent: false,
        results: [{ id: "run-no-result", status: "completed" }],
      },
    },
    { expanded: false },
    plainTheme,
  );
  assert.match(plainLines(allMalformed, 80).join("\n"), /only malformed entries/);
}

// ─── 8. Bounded in bundled themes at every boundary width ────────────

for (const themeName of ["pi-square-theme-dark", "pi-square-theme-light"]) {
  const theme = loadThemeFromPath(join(packageRoot, "themes", `${themeName}.json`));
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    for (const expandedMode of [false, true]) {
      const component = renderSubagentNotification(message, { expanded: expandedMode }, theme);
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${themeName}: ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
}

assert.doesNotMatch(`${collapsed}\n${expanded}`, /[⌛⏳◐◌\uFE0F]/u, "no emoji presentation characters");

// ─── 9. One V5 delivery stacks every run it carries ──────────────────

{
  const first = details({ id: "subagent_11111111-aaaa-4aaa-8aaa-111111111111", agent: { promptVersion: 2, name: "explorer", inheritParentSystem: true } });
  const second = details({
    id: "subagent_22222222-bbbb-4bbb-8bbb-222222222222",
    phase: "failed",
    finalText: "",
    error: "second run failed",
    agent: { promptVersion: 2, name: "oracle", inheritParentSystem: true },
  });
  const batch = {
    content: "[Background subagents: 2 results]",
    details: {
      version: 5,
      deliveryId: "delivery-5",
      resent: false,
      results: [
        { id: first.id, status: "completed", result: first },
        { id: second.id, status: "failed", result: second },
      ],
    },
  };

  const batchBackgrounds = [];
  const batchCollapsed = plainLines(renderSubagentNotification(batch, { expanded: false }, {
    ...plainTheme,
    bg(color, text) { batchBackgrounds.push(color); return String(text); },
  }), 80).join("\n");

  assert.match(batchCollapsed, /✓ Subagent\s+explorer/, "the first run keeps its own canonical description");
  assert.match(batchCollapsed, /× Subagent\s+oracle/, "the second run keeps its own state marker");
  assert.ok(batchBackgrounds.includes("toolErrorBg"), "a batch with a failed run uses the error shell");

  for (const width of [40, 80, 120]) {
    for (const expandedMode of [false, true]) {
      const component = renderSubagentNotification(batch, { expanded: expandedMode }, plainTheme);
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `batch delivery exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
}

console.log("subagent notification rendering: shared description, privacy, shells, and width contracts passed");

// ─── wait_subagent calm operational display (#277) ───────────────────

const { __testables: subagentAdapterTestables } = await load(join(packageRoot, "src", "subagents", "display-adapter.ts"));
const waitAdapter = subagentAdapterTestables.createWaitAdapter();

const waitId = (prefix) => `subagent_${prefix}abcd-4abc-8abc-123456789abc`;

// wait call description: selected count and ordered short ids
{
  const single = waitAdapter.describeCall(
    { ids: [waitId("11111111")] },
    { executionStarted: false },
  );
  assert.equal(single.title, "Wait");
  assert.equal(single.family, "agent");
  assert.equal(single.lifecycle, "queued");
  assert.equal(single.target, "11111111");
  assert.equal(single.qualifiers, undefined);

  const multi = waitAdapter.describeCall(
    { ids: [waitId("22222222"), waitId("11111111"), waitId("22222222")] },
    { executionStarted: true },
  );
  assert.equal(multi.lifecycle, "running");
  assert.equal(multi.target, "2 runs");
  assert.equal(multi.rows.length, 1);
  assert.equal(multi.rows[0].tone, "muted");
}

// wait result description: ordered terminal evidence and aggregate summary
{
  const summary = (run, status, overrides = {}) => ({
    id: run.id,
    operation: "delegate",
    status,
    task: run.task,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    result: status === "completed" ? run.finalText : "",
    error: status === "completed" ? undefined : (run.error ?? `run ${status}`),
    usage: run.usage,
    toolErrors: 0,
    toolWarnings: 0,
    ...overrides,
  });
  const one = details({ id: waitId("11111111"), task: "first task" });
  const two = details({ id: waitId("22222222"), task: "second task", phase: "failed", finalText: "", error: "RAW-FAILURE-TEXT" });
  const three = details({ id: waitId("33333333"), task: "third task", phase: "aborted", finalText: "", error: "RAW-ABORT-TEXT" });
  const result = {
    content: [{ type: "text", text: "waited" }],
    details: {
      version: 1,
      ids: [waitId("22222222"), waitId("11111111"), waitId("33333333")],
      results: [
        { id: waitId("22222222"), status: "failed", run: summary(two, "failed") },
        { id: waitId("11111111"), status: "completed", run: summary(one, "completed") },
        { id: waitId("33333333"), status: "aborted", run: summary(three, "aborted") },
      ],
      consumed: true,
      waitedMs: 2500,
    },
  };
  const args = { ids: [waitId("22222222"), waitId("11111111"), waitId("33333333")] };

  const collapsed = waitAdapter.describeResult(result, { expanded: false }, { isError: true, args });
  assert.equal(collapsed.lifecycle, "failed");
  assert.equal(collapsed.title, "Wait");
  assert.equal(collapsed.target, "3 runs");
  assert.equal(collapsed.summary, "completed · failed · aborted");
  assert.deepEqual(collapsed.sections, [], "a collapsed wait entry is exactly one row and shows no payload");
  assert.ok(collapsed.error.includes("2 of 3"));

  const expanded = waitAdapter.describeResult(result, { expanded: true }, { isError: true, args });
  // Ordered rows plus one bounded evidence section per run with payload.
  assert.deepEqual(expanded.sections.map((section) => section.title), [
    "Results",
    "Error 22222222",
    "Result 11111111",
    "Error 33333333",
  ]);
  const rows = expanded.sections[0].blocks;
  assert.deepEqual(rows.map((row) => row.tone), ["error", "default", "muted"]);
  assert.ok(rows[0].text.startsWith("22222222 · failed · second task"), rows[0].text);
  assert.ok(rows[1].text.startsWith("11111111 · completed · first task"), rows[1].text);
  assert.equal(expanded.sections[1].blocks[0].text, "RAW-FAILURE-TEXT", "the failure raw text appears in its own Error section");
  assert.equal(expanded.sections[1].blocks[0].tone, "error");
  assert.equal(expanded.sections[2].blocks[0].text.includes("Unique expanded tail"), true, "the completed evidence carries the result text");
  assert.equal(expanded.sections[3].blocks[0].text, "RAW-ABORT-TEXT");
  assert.equal(expanded.durationMs, 2500);

  const allGood = waitAdapter.describeResult(
    {
      content: [{ type: "text", text: "waited" }],
      details: {
        version: 1,
        ids: [waitId("11111111")],
        results: [{ id: waitId("11111111"), status: "completed", run: summary(one, "completed") }],
        consumed: true,
        waitedMs: 10,
      },
    },
    { expanded: false },
    { isError: false, args: { ids: [waitId("11111111")] } },
  );
  assert.equal(allGood.lifecycle, "completed");
  assert.equal(allGood.summary, "completed");
  assert.equal(allGood.error, undefined);
}

// a rejected wait renders as one failed row without terminal evidence
{
  const description = waitAdapter.describeResult(
    {
      content: [{ type: "text", text: "Subagent failed: RESULT_CLAIMED" }],
      details: { status: "error", error: { code: "RESULT_CLAIMED" } },
    },
    { expanded: true },
    { isError: true, args: { ids: [waitId("11111111"), waitId("22222222")] } },
  );
  assert.equal(description.title, "Wait");
  assert.equal(description.lifecycle, "failed");
  assert.equal(description.target, "2 runs");
  assert.deepEqual(description.sections, []);
  assert.match(description.error, /RESULT_CLAIMED/);
}
