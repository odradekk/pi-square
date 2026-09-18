import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

// The child execution seam's live-view publication contract (#306, #371):
// promptSession derives ordered bounded view events after its own run-state
// bookkeeping and publishes them through the guarded seam the background
// lifecycle hands in — observational only, so a broken or absent subscriber
// can never change, delay, or fail the run. The transcript module's own
// behavior is covered at its interface (transcript and live-view suites).
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const { boundedAssistantTextParts } = await load(join(packageRoot, "src", "subagents", "child-history.ts"));
const { __testables } = await load(join(packageRoot, "src", "subagents", "session.ts"));
const { createPromptSnapshot } = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const ID = "subagent_00000000-0000-4000-8000-000000000301";
const SESSION_ID = "019f0000-0000-7000-8000-000000000301";

function seamDetails(artifactsDir) {
  return {
    version: 4,
    id: ID,
    operation: "delegate",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: SESSION_ID,
    originParentSessionId: "parent-1",
    lastParentSessionId: "parent-1",
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    agent: { promptVersion: 2, name: "worker", effort: "high", inheritParentSystem: true },
    task: "Stream a bounded answer.",
    cwd: "/tmp/project",
    model: "provider/model",
    startedAt: Date.now(),
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
  };
}

/** A scriptable stand-in for the one-time child session Pi owns. */
function seamSession(script) {
  let subscriber;
  const session = {
    state: { messages: [] },
    agent: { abort() {} },
    subscribe(fn) {
      subscriber = fn;
      return () => { subscriber = undefined; };
    },
    async prompt() {
      await script((event) => subscriber?.(event), session);
    },
    dispose() {},
  };
  return session;
}

test("promptSession publishes ordered view events without changing the run outcome", async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-live-seam-"));
  try {
    const buildFinal = () => ({
      role: "assistant",
      timestamp: 1_000,
      content: [{ type: "text", text: "# Final\n\nComplete answer." }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.0001 } },
      model: { provider: "provider", id: "model" },
      stopReason: "stop",
    });
    const script = async (emit, session) => {
      emit({ type: "agent_start" });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial" }] } });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }] } });
      emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: { pattern: "x" } });
      emit({ type: "tool_execution_update", toolCallId: "c1", toolName: "grep" });
      emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "grep", isError: false, result: { content: [] } });
      const message = buildFinal();
      session.state.messages = [message];
      emit({ type: "message_end", message });
      emit({ type: "agent_end" });
    };

    const baseline = await __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
    });

    const events = [];
    const withFeed = await __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      onViewEvent(event) { events.push(event); },
    });

    assert.deepEqual(events.map((event) => event.kind), [
      "run_started",
      "message_delta",
      "message_delta",
      "tool_started",
      "tool_updated",
      "tool_finished",
      "message_completed",
      "run_finished",
    ]);
    assert.deepEqual(events[6], {
      kind: "message_completed",
      content: boundedAssistantTextParts([{ type: "text", text: "# Final\n\nComplete answer." }]),
      timestamp: 1_000,
    });

    assert.equal(withFeed.details.phase, "completed");
    assert.equal(withFeed.details.finalText, baseline.details.finalText);
    assert.equal(withFeed.details.usage.output, baseline.details.usage.output);
    assert.equal(withFeed.details.timeline.length, baseline.details.timeline.length);
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test("a throwing view subscriber cannot fail, delay, or alter the child run", async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-live-isolation-"));
  try {
    const script = async (emit, session) => {
      emit({ type: "agent_start" });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        model: { provider: "p", id: "m" },
        stopReason: "stop",
      };
      session.state.messages = [message];
      emit({ type: "message_end", message });
      emit({ type: "agent_end" });
    };
    const runOnce = async (onViewEvent) => __testables.promptSession({
      session: seamSession(script),
      prompt: "p",
      details: seamDetails(artifactsDir),
      ...(onViewEvent ? { onViewEvent } : {}),
    });

    const healthy = await runOnce(undefined);
    const broken = await runOnce(() => {
      throw new Error("viewer exploded");
    });

    assert.equal(broken.details.phase, healthy.details.phase);
    assert.equal(broken.details.finalText, healthy.details.finalText);
    assert.equal(broken.details.usage.turns, healthy.details.usage.turns);
    assert.deepEqual(broken.details.timeline, healthy.details.timeline);
    const persisted = JSON.parse(readFileSync(join(artifactsDir, "run.json"), "utf8"));
    assert.equal(persisted.phase, "completed");
    assert.equal(persisted.finalText, "Done");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error?.stack ?? error}`);
  }
}
if (failed > 0) {
  console.error(`${tests.length} tests, ${failed} failed`);
  process.exit(1);
}
console.log(`session view-event tests: ${tests.length} tests, 0 failed`);
