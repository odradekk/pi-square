import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { createPromptSnapshot, run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const mockSdkPath = join(tmpdir(), `pi-square-subagents-empty-output-sdk-mock-${process.pid}.mjs`);
writeFileSync(mockSdkPath, `
export async function createAgentSession() { throw new Error("not used by empty-output tests"); }
export function createExtensionRuntime() { return {}; }
export function getAgentDir() { return ${JSON.stringify(resolve(packageRoot, "..", ".."))}; }
export class DefaultResourceLoader {}
export const SessionManager = { inMemory() { return {}; } };
export const SettingsManager = { inMemory(value) { return value; } };
`, "utf8");
const loadSession = jiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": mockSdkPath,
  },
});
const { __testables } = await loadSession(join(packageRoot, "src", "subagents", "session.ts"));
const { deriveTerminalPhase, collectLastMessages } = __testables;

function baseDetails(overrides = {}) {
  const id = "subagent_00000000-0000-4000-8000-000000000051";
  return {
    version: 3,
    id,
    mode: "bg",
    artifactsDir: `/tmp/subagents/${id}`,
    sessionFile: `/tmp/subagents/${id}/session.jsonl`,
    sessionId: "native-session",
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    task: "task",
    cwd: "/tmp/subagents",
    startedAt: Date.now(),
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    ...overrides,
  };
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("scenario 0: streaming completed with finalText is done", () => {
  const details = baseDetails({ streamingCompleted: true, finalText: "hello world" });
  deriveTerminalPhase(details, []);
  assert.equal(details.phase, "done");
  assert.equal(details.finalText, "hello world");
});

test("scenario 1: incomplete stream salvages assistant text from history", () => {
  const details = baseDetails({ streamingCompleted: false, finalText: "" });
  deriveTerminalPhase(details, [{ role: "user", content: [{ type: "text", text: "prompt" }] }, assistantMessage("from-history")]);
  assert.equal(details.phase, "error");
  assert.equal(details.finalText, "from-history");
  assert.equal(details.salvagedFinalText, "from-history");
  assert.match(details.error, /salvaged/);
});

test("scenario 1: completed stream with empty finalText still salvages as error", () => {
  const details = baseDetails({ streamingCompleted: true, finalText: "" });
  deriveTerminalPhase(details, [assistantMessage("from-history")]);
  assert.equal(details.phase, "error");
  assert.equal(details.finalText, "from-history");
  assert.equal(details.salvagedFinalText, "from-history");
});

test("scenario 2: no assistant text returns last 3 messages", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "tool_result", content: [{ type: "text", text: "two" }] },
    { role: "user", content: [{ type: "text", text: "three" }] },
    { role: "tool_result", content: [{ type: "text", text: "four" }] },
  ];
  const details = baseDetails({ streamingCompleted: true, finalText: "" });
  deriveTerminalPhase(details, messages);
  assert.equal(details.phase, "error");
  assert.match(details.rawSessionOutput, /two/);
  assert.match(details.rawSessionOutput, /three/);
  assert.match(details.rawSessionOutput, /four/);
  assert.doesNotMatch(details.rawSessionOutput, /one/);
});

test("scenario 2: fewer than 3 messages returns only available messages", () => {
  const details = baseDetails();
  deriveTerminalPhase(details, [{ role: "user", content: [{ type: "text", text: "only" }] }]);
  assert.equal(details.phase, "error");
  assert.match(details.rawSessionOutput, /only/);
});

test("scenario 3: empty messages returns explicit no messages error", () => {
  const details = baseDetails();
  deriveTerminalPhase(details, []);
  assert.equal(details.phase, "error");
  assert.equal(details.error, "subagent produced no messages at all");
  assert.equal(details.rawSessionOutput, undefined);
});

test("existing details.error is not overwritten", () => {
  const details = baseDetails({ error: "preexisting failure" });
  deriveTerminalPhase(details, [assistantMessage("ignored")]);
  assert.equal(details.phase, "error");
  assert.equal(details.error, "preexisting failure");
  assert.equal(details.finalText, "");
});

test("terminal error records keep the collected tool errors for delivery", () => {
  const details = baseDetails({ toolErrors: [{ tool: "grep", message: "failed" }] });
  deriveTerminalPhase(details, []);
  assert.equal(details.phase, "error");
  assert.deepEqual(details.toolErrors, [{ tool: "grep", message: "failed" }]);
});

test("collectLastMessages returns empty string for empty arrays", () => {
  assert.equal(collectLastMessages([], 3), "");
});

test("collectLastMessages includes all messages when count equals length", () => {
  const text = collectLastMessages([{ id: 1 }, { id: 2 }, { id: 3 }], 3);
  assert.match(text, /"id": 1/);
  assert.match(text, /"id": 2/);
  assert.match(text, /"id": 3/);
});

test("collectLastMessages includes only the last N messages", () => {
  const text = collectLastMessages([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], 3);
  assert.doesNotMatch(text, /"id": 1/);
  assert.doesNotMatch(text, /"id": 2/);
  assert.match(text, /"id": 3/);
  assert.match(text, /"id": 4/);
  assert.match(text, /"id": 5/);
});

test("collectLastMessages treats non-positive count as at least one", () => {
  const text = collectLastMessages([{ id: 1 }, { id: 2 }], 0);
  assert.doesNotMatch(text, /"id": 1/);
  assert.match(text, /"id": 2/);
});

test("collectLastMessages returns empty string on serialization failure", () => {
  const cyclic = { id: 1 };
  cyclic.self = cyclic;
  assert.equal(collectLastMessages([cyclic], 3), "");
});

await run();
