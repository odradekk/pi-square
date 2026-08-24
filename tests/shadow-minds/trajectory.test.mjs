import assert from "node:assert/strict";
import { resolve } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const pi = resolve(import.meta.dirname, "..", "..");

const { buildTrajectory, SHADOW_TRAJECTORY_MAX_CHARS, SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS } = await load(
  resolve(pi, "src/shadow-minds/trajectory.ts"),
);

function message(role, content, extra = {}) {
  return { type: "message", message: { role, content, ...extra } };
}

function toolCall(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(callId, name, content, isError = false) {
  return message("toolResult", content, { toolCallId: callId, toolName: name, isError });
}

function assistantCall(parts) {
  return message("assistant", parts);
}

// ── Known-tool summaries from the closed field registry ─────────────

{
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c1", "read", { path: "src/foo.ts", offset: 10 })]),
    toolResult("c1", "read", [{ type: "text", text: "line one\nline two\nline three" }]),
  ]);
  assert.match(trajectory.text, /tool read ok · path=src\/foo\.ts · 3 lines/);
  // The paired call no longer renders a separate request line.
  assert.doesNotMatch(trajectory.text, /requests read/);
}

{
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c1", "grep", { pattern: "TODO", path: "src", limit: 5 })]),
    toolResult("c1", "grep", [{ type: "text", text: "a match" }]),
  ]);
  assert.match(trajectory.text, /tool grep ok · pattern=TODO · path=src · 7 chars/);
}

{
  // bash commands render the command field; the result body never appears.
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c9", "bash", { command: "npm test", timeout: 60 })]),
    toolResult("c9", "bash", [{ type: "text", text: "secret-token\nsecond line" }], true),
  ]);
  assert.match(trajectory.text, /tool bash error · command=npm test · 2 lines/);
  assert.ok(!trajectory.text.includes("secret-token"), "result bodies never reach the trajectory");
}

{
  // Arrays render joined and bounded; long values are clipped.
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c2", "search", { queries: ["alpha", "beta"] })]),
    toolResult("c2", "search", [{ type: "text", text: "ok" }]),
  ]);
  assert.match(trajectory.text, /tool search ok · queries=alpha, beta · 2 chars/);
}

// ── Mandatory bounded credential cleaning on known fields ───────────

{
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c3", "bash", { command: "curl -H 'authorization: Bearer ghp_abcdef123' https://x" })]),
    toolResult("c3", "bash", [{ type: "text", text: "done" }]),
  ]);
  assert.ok(!trajectory.text.includes("ghp_abcdef123"), "credential-like values are redacted from known fields");
  assert.match(trajectory.text, /authorization: \[REDACTED\]/);
}

{
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c4", "fetch", { urls: ["https://x/api?api_key=sk-abc123"] })]),
    toolResult("c4", "fetch", [{ type: "text", text: "page" }]),
  ]);
  assert.ok(!trajectory.text.includes("sk-abc123"), "query secrets are redacted");
  assert.match(trajectory.text, /api_key=\[REDACTED\]/);
}

// ── Unknown tools: name, outcome, and scale only ────────────────────

{
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c5", "mcp_custom_tool", { raw: "payload", secret: "hunter2" })]),
    toolResult("c5", "mcp_custom_tool", [{ type: "text", text: "result body with secrets" }]),
  ]);
  assert.match(trajectory.text, /tool mcp_custom_tool ok · 24 chars/);
  assert.ok(!trajectory.text.includes("payload"), "no raw arguments for unknown tools");
  assert.ok(!trajectory.text.includes("result body"), "no raw bodies for unknown tools");
}

{
  // Image-only results render an image scale.
  const trajectory = buildTrajectory([
    assistantCall([toolCall("c6", "mcp_shot", {})]),
    toolResult("c6", "mcp_shot", [{ type: "image", data: "iVBOR", mimeType: "image/png" }]),
  ]);
  assert.match(trajectory.text, /tool mcp_shot ok · 1 image/);
}

// ── Reasoning removal, text retention, compaction, requests ────────

{
  const trajectory = buildTrajectory([
    message("user", "please investigate"),
    { type: "compaction", summary: "earlier work summarized" },
    assistantCall([{ type: "thinking", thinking: "hidden chain of thought" }, { type: "text", text: "I will inspect." }]),
  ]);
  assert.ok(!trajectory.text.includes("hidden chain"), "thinking never reaches the trajectory");
  assert.match(trajectory.text, /\[user\] please investigate/);
  assert.match(trajectory.text, /\[summary\] earlier work summarized/);
  assert.match(trajectory.text, /\[assistant\] I will inspect\./);
}

{
  // Unpaired calls still surface as requests.
  const trajectory = buildTrajectory([
    assistantCall([toolCall("pending", "grep", { pattern: "x" })]),
  ]);
  assert.match(trajectory.text, /\[assistant\] requests grep/);
}

// ── Delivered Shadow evidence only ──────────────────────────────────

{
  const trajectory = buildTrajectory([message("user", "task")], {
    evidence: [
      { shadowId: "a", shadowName: "Alpha", summary: "first finding", deliveredAt: 10, delivery: "notified" },
      { shadowId: "b", shadowName: "Beta", summary: "delivered finding", deliveredAt: 20, delivery: "delivered" },
      { shadowId: "c", shadowName: "Gamma", summary: "pending finding", deliveredAt: 30, delivery: "pending" },
    ],
  });
  assert.match(trajectory.text, /\[shadow\] Beta: delivered finding/);
  assert.ok(!trajectory.text.includes("first finding"), "notified results stay out of the trajectory");
  assert.ok(!trajectory.text.includes("pending finding"), "pending results stay out of the trajectory");
}

{
  // Evidence renders in delivery order, oldest first.
  const trajectory = buildTrajectory([message("user", "task")], {
    evidence: [
      { shadowId: "later", shadowName: "Later", summary: "second", deliveredAt: 20, delivery: "delivered" },
      { shadowId: "earlier", shadowName: "Earlier", summary: "first", deliveredAt: 10, delivery: "delivered" },
    ],
  });
  const positions = [trajectory.text.indexOf("[shadow] Earlier"), trajectory.text.indexOf("[shadow] Later")];
  assert.ok(positions[0] >= 0 && positions[1] > positions[0], "delivery order is chronological");
}

// ── Deterministic bounded truncation with visible mode ──────────────

{
  // Under the bound: nothing is dropped.
  const small = buildTrajectory([message("user", "hi")]);
  assert.equal(small.truncated, false);
  assert.equal(small.truncation, "none");
  assert.equal(small.includedMessages, 1);
  assert.equal(small.totalMessages, 1);
}

{
  // Over the bound: oldest messages drop first, summaries are pinned.
  const entries = [];
  for (let index = 0; index < 400; index += 1) {
    entries.push(message("user", `message number ${index} ${"x".repeat(80)}`));
  }
  entries.push({ type: "compaction", summary: "pinned compaction summary of the old work" });
  entries.push(message("user", "the current task"));
  const trajectory = buildTrajectory(entries);
  assert.equal(trajectory.truncated, true);
  assert.equal(trajectory.truncation, "dropped");
  assert.ok(trajectory.text.length <= SHADOW_TRAJECTORY_MAX_CHARS, "total stays bounded");
  assert.ok(trajectory.text.includes("the current task"), "the current task is retained");
  assert.ok(trajectory.text.includes("pinned compaction summary"), "compaction summaries are retained");
  assert.ok(!trajectory.text.includes("message number 0"), "the oldest messages drop first");
  assert.ok(trajectory.text.includes("message number 399"), "the newest messages are retained");
  assert.ok(trajectory.includedMessages < trajectory.totalMessages);
}

{
  // Pathological summary volume drops oldest summaries but keeps messages.
  const entries = [];
  for (let index = 0; index < 200; index += 1) {
    entries.push({ type: "compaction", summary: `summary ${index} ${"y".repeat(160)}` });
  }
  entries.push(message("user", "current task"));
  const trajectory = buildTrajectory(entries);
  assert.ok(trajectory.text.includes("current task"), "the current task survives summary pressure");
  assert.ok(trajectory.text.includes("summary 199"), "newest summaries survive");
  assert.equal(trajectory.truncation, "dropped");
}

{
  // Per-message clipping marks truncation visible too.
  const trajectory = buildTrajectory([message("user", "z".repeat(SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS + 100))]);
  assert.equal(trajectory.truncated, true);
  assert.equal(trajectory.truncation, "dropped");
  assert.ok(trajectory.text.length < SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS + 100);
}

{
  // Identical entries produce identical bytes and metadata.
  const entries = [
    message("user", "same input"),
    assistantCall([toolCall("c1", "read", { path: "a.ts" })]),
    toolResult("c1", "read", [{ type: "text", text: "body" }]),
  ];
  const one = buildTrajectory(entries);
  const two = buildTrajectory(structuredClone(entries));
  assert.deepEqual(one, two);
}

console.log("shadow-minds trajectory tests: OK");
