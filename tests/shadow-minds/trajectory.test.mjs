import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const { buildTrajectory, SHADOW_TRAJECTORY_MAX_CHARS, SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS } = await load(
  join(packageRoot, "src", "shadow-minds", "trajectory.ts"),
);

function message(role, content, extra = {}) {
  return { type: "message", message: { role, content, ...extra } };
}

// ── text retention and thinking removal ────────────────────────────

{
  const entries = [
    message("user", "Fix the login bug."),
    message("assistant", [{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "I will inspect auth." }]),
    message("toolResult", [{ type: "text", text: "file body" }], { toolName: "read", isError: false }),
  ];
  const trajectory = buildTrajectory(entries);
  assert.ok(trajectory.text.includes("[user] Fix the login bug."), "user text is retained");
  assert.ok(trajectory.text.includes("[assistant] I will inspect auth."), "assistant text is retained");
  assert.ok(!trajectory.text.includes("private chain of thought"), "thinking is removed");
  assert.ok(!trajectory.text.includes("file body"), "raw tool result bodies are never exposed");
  assert.ok(trajectory.text.includes("tool read ok"), "tool activity is a name+outcome one-liner");
  assert.equal(trajectory.totalMessages, 3, "every branch message counts toward the total");
  assert.equal(trajectory.includedMessages, 3);
  assert.equal(trajectory.truncated, false);
}

{
  // A tool error is observable without its body.
  const trajectory = buildTrajectory([
    message("toolResult", [{ type: "text", text: "npm ERR! secret-token" }], { toolName: "bash", isError: true }),
  ]);
  assert.ok(trajectory.text.includes("tool bash error"), "a failing tool is marked error");
  assert.ok(!trajectory.text.includes("secret-token"), "the failing body stays out");
}

{
  // Assistant-requested tools appear as a request line without arguments.
  // Real Pi shape: assistant tool calls are content parts of type "toolCall".
  const trajectory = buildTrajectory([
    message("assistant", [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "secret" } }]),
  ]);
  assert.ok(trajectory.text.includes("[assistant] requests grep"), "the tool request is summarized by name");
  assert.ok(!trajectory.text.includes("secret"), "raw tool arguments are never exposed");
}

// ── compaction summaries ───────────────────────────────────────────

{
  const trajectory = buildTrajectory([
    message("user", "old work"),
    { type: "compaction", summary: "Earlier session compacted: fixed parser bug." },
    message("user", "new work"),
  ]);
  assert.ok(trajectory.text.includes("[summary] Earlier session compacted: fixed parser bug."), "compaction summaries are retained");
}

// ── determinism ────────────────────────────────────────────────────

{
  const entries = [
    message("user", "same input"),
    message("toolResult", [{ type: "text", text: "x" }], { toolName: "read", isError: false }),
  ];
  assert.equal(buildTrajectory(entries).text, buildTrajectory(entries).text, "identical entries produce identical bytes");
}

// ── bounds and truncation ──────────────────────────────────────────

{
  const long = "a".repeat(SHADOW_TRAJECTORY_MESSAGE_MAX_CHARS + 50);
  const trajectory = buildTrajectory([message("user", long)]);
  assert.ok(trajectory.text.length <= SHADOW_TRAJECTORY_MAX_CHARS + 200, "a single over-long message is clipped");
  assert.ok(trajectory.text.includes("…"), "clipping is visible");
  assert.equal(trajectory.truncated, true);
}

{
  const many = Array.from({ length: 40 }, (_value, index) => message("user", `message ${index} ${"b".repeat(800)}`));
  const trajectory = buildTrajectory(many);
  assert.ok(trajectory.text.length <= SHADOW_TRAJECTORY_MAX_CHARS + 200, "the total trajectory stays bounded");
  assert.equal(trajectory.truncated, true);
  assert.equal(trajectory.totalMessages, 40);
  assert.ok(trajectory.includedMessages < 40, "older messages were dropped");
  assert.ok(trajectory.text.includes("message 39"), "the newest messages are retained");
  assert.ok(!trajectory.text.includes("message 0"), "the oldest messages were dropped first");
}

{
  const empty = buildTrajectory([]);
  assert.equal(empty.text, "");
  assert.equal(empty.totalMessages, 0);
  assert.equal(empty.truncated, false);
}

{
  // Non-message meta entries never enter the trajectory or the total.
  const trajectory = buildTrajectory([{ type: "some_meta" }, message("user", "hello")]);
  assert.equal(trajectory.totalMessages, 1);
  assert.ok(trajectory.text.includes("hello"));
}



{
  const trajectory = buildTrajectory([
    message("user", "Authorization: Bearer TOPSECRET api_key=ABC"),
    message("assistant", "password=hunter2"),
    { type: "compaction", summary: "refresh_token=REFRESH" },
  ]);
  assert.doesNotMatch(trajectory.text, /TOPSECRET|ABC|hunter2|REFRESH/);
  assert.match(trajectory.text, /\[REDACTED\]/, "trajectory text uses the shared credential sanitizer");
}

console.log("shadow-minds trajectory tests: OK");
