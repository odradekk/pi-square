import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { __testables } = await load(join(packageRoot, "src", "subagents", "session.ts"));
const { promptSession } = __testables;

function makeDetails(artifactsDir, overrides = {}) {
  const id = `subagent_${randomUUID()}`;
  return {
    version: 4,
    id,
    operation: "delegate",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: randomUUID(),
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: {
      version: 3,
      system: "test system",
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
    ...overrides,
  };
}

function createSession(script) {
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

{
  // The background lifecycle consumes per-event detail snapshots: tool calls
  // publish immediately with the sanitized timeline entry, and the terminal
  // result carries the completed assistant text.
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-subagent-stream-"));
  const details = makeDetails(artifactsDir);
  const updates = [];
  const session = createSession(async (emit, current) => {
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed but not observed" } });
    emit({ type: "tool_execution_start", toolName: "grep", args: { pattern: "needle", path: "." } });
    emit({
      type: "tool_execution_end",
      toolName: "grep",
      isError: false,
      result: { content: [{ type: "text", text: "1 match" }] },
    });
    emit({ type: "tool_execution_start", toolName: "pdf_search", args: { query: "installation guide", path: "manual.pdf", secret: "private" } });
    emit({ type: "tool_execution_end", toolName: "pdf_search", isError: false, result: { content: [{ type: "text", text: "SECRET SEARCH RESULT" }] } });

    const message = {
      role: "assistant",
      content: [{ type: "text", text: "# Final\n\nComplete answer." }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.0001 } },
      model: { provider: "provider", id: "model" },
      stopReason: "stop",
    };
    current.state.messages = [message];
    emit({ type: "message_end", message });
    emit({ type: "agent_end" });
  });

  const returned = await promptSession({
    session,
    prompt: "test prompt",
    details,
    definitionName: "worker",
    onUpdate(published) {
      updates.push({ at: Date.now(), details: published });
    },
  });

  const toolStart = updates.find(({ details: published }) => published.timeline.some((item) => item.kind === "tool" && item.phase === "start"));
  const toolEnd = updates.find(({ details: published }) => published.timeline.some((item) => item.kind === "tool" && item.phase === "end"));
  assert.ok(toolStart, "tool start should publish immediately");
  assert.ok(toolEnd, "tool end should publish immediately");

  assert.equal(returned.details.phase, "completed");
  const toolStarts = returned.details.timeline.filter((item) => item.kind === "tool" && item.phase === "start").map((item) => item.text);
  assert.deepEqual(toolStarts, [
    "grep /needle/ in .",
    "pdf_search installation guide in manual.pdf",
  ]);
  assert.doesNotMatch(toolStarts.join("\n"), /password|token|private|SECRET/);
  assert.equal(returned.details.finalText, "# Final\n\nComplete answer.");
  // Each published snapshot is a detached clone, so the job mirror never
  // mutates together with the still-running record.
  assert.notEqual(toolStart.details.timeline, returned.details.timeline);

  const persisted = JSON.parse(readFileSync(join(artifactsDir, "run.json"), "utf8"));
  assert.equal(persisted.phase, "completed");
  assert.equal(persisted.finalText, "# Final\n\nComplete answer.");
  rmSync(artifactsDir, { recursive: true, force: true });
}

{
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-subagent-stream-error-"));
  const details = makeDetails(artifactsDir);
  const updates = [];
  const session = createSession(async (emit) => {
    emit({ type: "agent_start" });
    throw new Error("controlled session failure");
  });

  const returned = await promptSession({
    session,
    prompt: "test failure",
    details,
    onUpdate(published) { updates.push(published); },
  });
  assert.equal(returned.details.phase, "failed");
  assert.match(returned.details.error, /controlled session failure/);
  assert.ok(updates.length >= 1, "progress before the failure was published");
  rmSync(artifactsDir, { recursive: true, force: true });
}

{
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-subagent-stream-initial-update-error-"));
  const details = makeDetails(artifactsDir);
  let disposeCount = 0;
  let promptCount = 0;
  const session = createSession(async () => { promptCount += 1; });
  session.dispose = () => { disposeCount += 1; };

  await assert.rejects(
    () => promptSession({
      session,
      prompt: "must not start",
      details,
      onUpdate() { throw new Error("initial update failed"); },
    }),
    /initial update failed/,
  );

  assert.equal(promptCount, 0, "a failed initial update must stop before prompting");
  assert.equal(disposeCount, 1, "a failed initial update must still dispose the child session exactly once");
  rmSync(artifactsDir, { recursive: true, force: true });
}

console.log("subagent background detail mirroring: event-bounded and terminal-safe");
