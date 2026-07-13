import assert from "node:assert/strict";
import { resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  assertPromptCanFit,
  buildDelegatedPrompt,
  collectParentContextMessages,
} = await load(resolve(packageRoot, "src", "subagents", "context.ts"));

function message(role, content) {
  return { type: "message", message: { role, content } };
}

const branch = [
  { type: "compaction", summary: "must not appear" },
  message("user", [{ type: "text", text: "old user" }, { type: "image", data: "ignored" }]),
  message("assistant", [
    { type: "thinking", thinking: "secret reasoning" },
    { type: "text", text: "old assistant" },
    { type: "toolCall", id: "tool-1", name: "read" },
  ]),
  message("toolResult", [{ type: "text", text: "tool output" }]),
  { type: "custom_message", content: "notification" },
  message("assistant", [{ type: "toolCall", id: "tool-2", name: "bash" }]),
  message("user", [{ type: "text", text: "current user" }]),
];

const sessionManager = { getBranch: () => branch };

test("context=0 does not read or inject parent history", () => {
  let reads = 0;
  assert.deepEqual(collectParentContextMessages({ getBranch() { reads += 1; return branch; } }, 0), []);
  assert.equal(reads, 0);
});

test("requesting context without a parent session fails explicitly", () => {
  assert.throws(() => collectParentContextMessages(undefined, 1), /history is unavailable/);
});

test("selection counts only visible user and assistant text and includes current user", () => {
  assert.deepEqual(collectParentContextMessages(sessionManager, 2), [
    { role: "assistant", text: "old assistant" },
    { role: "user", text: "current user" },
  ]);
});

test("requesting more messages returns every eligible message in chronological order", () => {
  assert.deepEqual(collectParentContextMessages(sessionManager, 50), [
    { role: "user", text: "old user" },
    { role: "assistant", text: "old assistant" },
    { role: "user", text: "current user" },
  ]);
});

test("delegated prompt labels parent history and keeps current task last", () => {
  const prompt = buildDelegatedPrompt({
    definitionPrompt: "Use repository evidence.",
    parentMessages: collectParentContextMessages(sessionManager, 2),
    task: "Inspect the parser.",
  });
  assert.match(prompt, /^\[Subagent profile instructions\]/);
  assert.match(prompt, /historical messages come from the parent session/);
  assert.match(prompt, /Parent assistant:\nold assistant/);
  assert.match(prompt, /User:\ncurrent user/);
  assert.ok(prompt.endsWith("[Current delegated task]\nInspect the parser."));
  assert.doesNotMatch(prompt, /secret reasoning|tool output|notification/);
});

test("oversized prompt fails without truncation", () => {
  const prompt = "x".repeat(1000);
  assert.throws(
    () => assertPromptCanFit({ prompt, model: { contextWindow: 100 }, operation: "fg", selectedMessages: 4 }),
    /CONTEXT_TOO_LARGE/,
  );
  assert.equal(prompt.length, 1000);
});

await run();
