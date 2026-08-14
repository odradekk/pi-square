import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { __testables } = await load(join(packageRoot, "src", "subagents", "session.ts"));
const {
  appendLiveTextTail,
  promptSession,
  LIVE_UPDATE_THROTTLE_MS,
  MAX_LIVE_TEXT,
} = __testables;

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function makeDetails(artifactsDir, overrides = {}) {
  const id = `subagent_${randomUUID()}`;
  return {
    version: 3,
    id,
    mode: "fg",
    artifactsDir,
    sessionFile: join(artifactsDir, "session.jsonl"),
    sessionId: randomUUID(),
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: {
      version: 2,
      system: "test system",
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
  assert.equal(appendLiveTextTail("Hello ", "world"), "Hello world");
  assert.equal(appendLiveTextTail("line\n", "  indented "), "line\n  indented ");
  const unicode = appendLiveTextTail("😀".repeat(MAX_LIVE_TEXT), "终");
  assert.equal(Array.from(unicode).length, MAX_LIVE_TEXT);
  assert.ok(unicode.endsWith("终"));
  assert.equal(unicode.includes("�"), false);
}

{
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-subagent-stream-"));
  const details = makeDetails(artifactsDir);
  const updates = [];
  const burstMarker = "TAIL-终-😀";
  const session = createSession(async (emit, current) => {
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed " } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
    await wait(LIVE_UPDATE_THROTTLE_MS + 30);

    emit({ type: "tool_execution_start", toolName: "rg", args: { pattern: "needle", path: "." } });
    emit({
      type: "tool_execution_end",
      toolName: "rg",
      isError: false,
      result: { content: [{ type: "text", text: "1 match" }] },
    });
    emit({ type: "tool_execution_start", toolName: "github_read", args: { repo: "owner/name", path: "README.md", ref: "main", token: "private" } });
    emit({ type: "tool_execution_end", toolName: "github_read", isError: false, result: { content: [{ type: "text", text: "SECRET GITHUB RESULT" }] } });

    const burstStart = updates.length;
    for (let index = 0; index < 20; index += 1) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "😀".repeat(120) } });
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: burstMarker } });
    await wait(LIVE_UPDATE_THROTTLE_MS + 30);
    assert.ok(updates.length - burstStart <= 2, `expected throttled burst, received ${updates.length - burstStart} updates`);

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
    onUpdate(partial) {
      updates.push({ at: Date.now(), partial });
    },
  });

  const streamed = updates.find(({ partial }) => partial.details.liveText === "Hello streamed world");
  assert.ok(streamed, "whitespace-preserving live update should be published");
  const tailed = updates.find(({ partial }) => partial.details.liveText.endsWith(burstMarker));
  assert.ok(tailed, "latest Unicode tail should remain visible");
  assert.ok(Array.from(tailed.partial.details.liveText).length <= MAX_LIVE_TEXT);
  assert.equal(tailed.partial.details.liveText.includes("�"), false);

  const toolStart = updates.find(({ partial }) => partial.details.timeline.some((item) => item.kind === "tool" && item.phase === "start"));
  const toolEnd = updates.find(({ partial }) => partial.details.timeline.some((item) => item.kind === "tool" && item.phase === "end"));
  assert.ok(toolStart, "tool start should publish immediately");
  assert.ok(toolEnd, "tool end should publish immediately");

  assert.equal(returned.details.phase, "done");
  const toolStarts = returned.details.timeline.filter((item) => item.kind === "tool" && item.phase === "start").map((item) => item.text);
  assert.deepEqual(toolStarts, [
    "rg /needle/ in .",
    "github_read owner/name:README.md @main",
  ]);
  assert.doesNotMatch(toolStarts.join("\n"), /password|token|private|SECRET/);
  assert.equal(returned.details.liveText, "");
  assert.equal(returned.details.finalText, "# Final\n\nComplete answer.");
  assert.equal(returned.content, `ID: ${details.id}\n\n# Final\n\nComplete answer.`);

  const persisted = JSON.parse(readFileSync(join(artifactsDir, "run.json"), "utf8"));
  assert.equal(persisted.phase, "done");
  assert.equal(persisted.liveText, "");
  assert.equal(persisted.finalText, "# Final\n\nComplete answer.");

  const finalUpdateCount = updates.length;
  await wait(LIVE_UPDATE_THROTTLE_MS + 30);
  assert.equal(updates.length, finalUpdateCount, "no delayed partial update may follow the terminal result");
  rmSync(artifactsDir, { recursive: true, force: true });
}

{
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-square-subagent-stream-error-"));
  const details = makeDetails(artifactsDir);
  const updates = [];
  const session = createSession(async (emit) => {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late partial" } });
    throw new Error("controlled session failure");
  });

  const returned = await promptSession({
    session,
    prompt: "test failure",
    details,
    onUpdate(partial) { updates.push(partial); },
  });
  assert.equal(returned.details.phase, "error");
  assert.equal(returned.details.liveText, "");
  const count = updates.length;
  await wait(LIVE_UPDATE_THROTTLE_MS + 30);
  assert.equal(updates.length, count, "error cleanup must cancel delayed updates");
  rmSync(artifactsDir, { recursive: true, force: true });
}

console.log("subagent live streaming: bounded, throttled, and terminal-safe");
