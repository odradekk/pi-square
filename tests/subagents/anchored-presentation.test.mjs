import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  formatToolCall,
  latestToolCallSummary,
  toolDisplayFromArgs,
  toolEventDisplay,
} = await load(join(packageRoot, "src", "subagents", "tool-display.ts"));
const { describeSubagentRun } = await load(join(packageRoot, "src", "subagents", "display-adapter.ts"));
const { renderSubagentNotification } = await load(join(packageRoot, "src", "subagents", "render.ts"));
const { __testables } = await load(join(packageRoot, "src", "subagents", "session.ts"));

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
    version: 3,
    id: "subagent_12345678-abcd-4abc-8abc-123456789abc",
    mode: "bg",
    artifactsDir: "/tmp/private-artifacts",
    sessionFile: "/tmp/private-artifacts/session.jsonl",
    sessionId: "native-private-id",
    originParentSessionId: "parent-private-id",
    lastParentSessionId: "parent-private-id",
    promptSnapshot: {
      version: 2,
      system: "private system",
      manifest: {
        contractVersion: 2,
        governanceVersion: 1,
        inheritParentSystem: true,
        effectiveSystemHash: "hash",
        governanceHash: "hash",
        contextCount: 0,
        fieldSources: {},
        sourceFiles: [],
      },
    },
    phase: "done",
    agent: { promptVersion: 2, name: "worker", effort: "high", inheritParentSystem: true },
    task: "Edit src/a.txt.",
    cwd: "/tmp/project",
    model: "provider/model",
    startedAt: Date.now() - 1500,
    endedAt: Date.now(),
    durationMs: 1500,
    finalText: "done",
    retries: 0,
    toolErrors: [],
    toolWarnings: [],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    timeline: [],
    ...overrides,
  };
}

// ─── 1. The shared allowlisted formatter names the anchored target ──

test("replace summaries name the target file", () => {
  assert.equal(
    formatToolCall("replace", { path: "src/a.txt", remove_from: "abc", remove_to: "def", replacement_text: "X", secret: "private" }),
    "replace src/a.txt",
  );
  assert.doesNotMatch(formatToolCall("replace", { path: "src/a.txt", secret: "private" }), /private/);
});

test("anchored summaries shorten long paths and never leak arguments", () => {
  const long = `nested/${"segment/".repeat(20)}tail.txt`;
  const summary = formatToolCall("replace", { path: long, replacement_text: "secret-text" });
  assert.match(summary, /^replace /);
  assert.ok(Array.from(summary).length <= 120, "the summary stays within the formatter bound");
  assert.doesNotMatch(summary, /secret-text/);
});

test("legacy JSON timeline entries use the same anchored formatter", () => {
  const replace = toolEventDisplay({
    kind: "tool",
    phase: "start",
    text: 'replace {"path":"src/a.txt","remove_from":"abc","replacement_text":"X"}',
  });
  assert.deepEqual(replace, { tool: "replace", summary: "src/a.txt" });
});

// ─── 2. Refusal detection at the tool boundary ─────────────────────

test("warning results from anchored tools are refusals, not successes or failures", () => {
  assert.equal(
    __testables.anchorRefusalCode({ content: [], details: { status: "warning", errorCode: "E_RANGE_STALE" } }, false),
    "E_RANGE_STALE",
  );
  // A warning without a refusal code is a benign notice, not a refusal.
  assert.equal(
    __testables.anchorRefusalCode({ content: [], details: { status: "warning" } }, false),
    undefined,
  );
  // A clean success carries no refusal.
  assert.equal(
    __testables.anchorRefusalCode({ content: [], details: { status: "ok" } }, false),
    undefined,
  );
});

test("a thrown anchored refusal (write lock) is a refusal; a genuine error is not", () => {
  assert.equal(
    __testables.anchorRefusalCode({ content: [{ type: "text", text: "[E_FILE_LOCKED] Another editor holds the write lock on src/a.txt; the write was not applied." }] }, true),
    "E_FILE_LOCKED",
  );
  // Genuine environment failures never carry a refusal code.
  assert.equal(
    __testables.anchorRefusalCode({ content: [{ type: "text", text: "[E_NOT_FOUND] No such file src/a.txt" }] }, true),
    undefined,
  );
  assert.equal(
    __testables.anchorRefusalCode({ content: [{ type: "text", text: "ECONNREFUSED" }] }, true),
    undefined,
  );
});

// ─── 3. classifyToolEnd routes refusals to warnings, errors to failures ─

test("an anchored refusal is recorded as a warning, never as a tool error", () => {
  const runDetails = details();
  const code = __testables.classifyToolEnd(
    runDetails,
    "replace",
    { content: [{ type: "text", text: "[E_RANGE_STALE] stale range" }], details: { status: "warning", errorCode: "E_RANGE_STALE" } },
    false,
  );
  assert.equal(code, "E_RANGE_STALE");
  assert.equal(runDetails.toolWarnings.length, 1, "the refusal lands in the warnings list");
  assert.equal(runDetails.toolWarnings[0].tool, "replace");
  assert.match(runDetails.toolWarnings[0].message, /\[E_RANGE_STALE\]/);
  assert.equal(runDetails.toolErrors.length, 0, "an anchored refusal is not a tool error");
  const end = runDetails.timeline.find((item) => item.phase === "end");
  assert.equal(end.isError, false, "the timeline end is not an error");
  assert.equal(end.isWarning, true, "the timeline end carries the warning flag");
});

test("a thrown write-lock refusal is reclassified to a warning, not a failure", () => {
  const runDetails = details();
  __testables.classifyToolEnd(
    runDetails,
    "write",
    { content: [{ type: "text", text: "[E_FILE_LOCKED] Another editor holds the write lock on src/a.txt; the write was not applied." }] },
    true,
  );
  assert.equal(runDetails.toolWarnings.length, 1);
  assert.equal(runDetails.toolErrors.length, 0, "the lock refusal is not a tool error");
  assert.equal(runDetails.timeline.at(-1).isError, false);
  assert.equal(runDetails.timeline.at(-1).isWarning, true);
});

test("a genuine environment error stays a tool error and a failure", () => {
  const runDetails = details();
  const code = __testables.classifyToolEnd(
    runDetails,
    "read",
    { content: [{ type: "text", text: "[E_NOT_FOUND] No such file" }] },
    true,
  );
  assert.equal(code, undefined);
  assert.equal(runDetails.toolWarnings.length, 0);
  assert.equal(runDetails.toolErrors.length, 1, "a genuine error remains a tool error");
  assert.equal(runDetails.timeline.at(-1).isError, true);
  assert.equal(runDetails.timeline.at(-1).isWarning, undefined);
});

test("a successful anchored call records nothing", () => {
  const runDetails = details();
  __testables.classifyToolEnd(runDetails, "replace", { content: [{ type: "text", text: "Applied" }], details: { status: "ok" } }, false);
  assert.equal(runDetails.toolWarnings.length, 0);
  assert.equal(runDetails.toolErrors.length, 0);
  assert.equal(runDetails.timeline.at(-1).isWarning, undefined);
});

// ─── 4. Presentation: warning qualifier, not a failed lifecycle ────

test("a run with anchored refusals completes with a warning qualifier, not a failure", () => {
  const refused = details({
    timeline: [
      { kind: "tool", phase: "start", text: 'replace {"path":"src/a.txt","remove_from":"abc"}' },
      { kind: "tool", phase: "end", text: "replace: [E_RANGE_STALE] stale range", isWarning: true },
    ],
    toolWarnings: [{ tool: "replace", message: "replace refused with [E_RANGE_STALE]" }],
  });
  const description = describeSubagentRun("delegate", refused, { expanded: false, isPartial: false, isError: false }, "background content");
  assert.equal(description.lifecycle, "completed", "an anchor refusal is not a failed lifecycle");
  assert.ok(description.qualifiers.includes("warning"), "the refusal surfaces as a warning qualifier");
  assert.match(description.summary ?? "", /1 anchored refusal/);
});

test("a genuine tool error remains distinct from an anchored refusal", () => {
  const failed = details({
    timeline: [
      { kind: "tool", phase: "start", text: "read src/a.txt" },
      { kind: "tool", phase: "end", text: "read: [E_NOT_FOUND]", isError: true },
    ],
    toolErrors: [{ tool: "read", message: "[E_NOT_FOUND] No such file" }],
  });
  const description = describeSubagentRun("delegate", failed, { expanded: false, isPartial: false, isError: false }, "background content");
  assert.equal(description.lifecycle, "completed");
  assert.ok(description.qualifiers.includes("warning"), "a tool error still warns");
  assert.match(description.summary ?? "", /1 tool error/);
  assert.doesNotMatch(description.summary ?? "", /anchored refusal/, "a tool error is never labelled an anchored refusal");
});

test("expanded notification shows the anchored activity and the refusal, without payloads", () => {
  initTheme();
  const refused = details({
    timeline: [
      { kind: "tool", phase: "start", text: 'read {"path":"src/a.txt"}' },
      { kind: "tool", phase: "end", text: "read: ok" },
      { kind: "tool", phase: "start", text: 'replace {"path":"src/a.txt","remove_from":"abc"}' },
      { kind: "tool", phase: "end", text: "replace: [E_RANGE_STALE] stale range", isWarning: true },
    ],
    toolWarnings: [{ tool: "replace", message: "replace refused with [E_RANGE_STALE]" }],
    finalText: "Done.",
  });
  const rendered = plainLines(renderSubagentNotification(
    { content: "done", details: { id: refused.id, status: "done", result: refused } },
    { expanded: true },
    plainTheme,
  ), 80).join("\n");
  assert.match(rendered, /replace\s+src\/a\.txt/, "the activity summary names the target file");
  assert.match(rendered, /!\s+replace/, "the refused activity item renders the warning marker, not a failure marker");
  assert.doesNotMatch(rendered, /×\s+replace/, "an anchor refusal never renders as a failed call");
  assert.match(rendered, /Refusals/, "expanded reveals the refusals section");
  assert.match(rendered, /E_RANGE_STALE/, "the refusal code is visible");
  assert.doesNotMatch(rendered, /SECRET|remove_from|private/, "no payload or arbitrary argument object renders");
});

test("collapsed notification keeps the warning marker and no payload", () => {
  const refused = details({
    timeline: [
      { kind: "tool", phase: "start", text: 'replace {"path":"src/a.txt","remove_from":"abc"}' },
      { kind: "tool", phase: "end", text: "replace: [E_RANGE_STALE] stale range", isWarning: true },
    ],
    toolWarnings: [{ tool: "replace", message: "replace refused with [E_RANGE_STALE]" }],
    finalText: "Done.",
  });
  const collapsed = plainLines(renderSubagentNotification(
    { content: "done", details: { id: refused.id, status: "done", result: refused } },
    { expanded: false },
    plainTheme,
  ), 80).join("\n");
  assert.match(collapsed, /Subagent\s+worker/, "the run still completes under the success shell");
  assert.match(collapsed, /anchored refusal/, "the collapsed summary mentions the refusal");
  assert.doesNotMatch(collapsed, /E_RANGE_STALE|remove_from|private/, "the collapsed entry stays bounded and payload-free");
});

await run();
