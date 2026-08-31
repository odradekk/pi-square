import assert from "node:assert/strict";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createHarness } from "../qualification/harness.mjs";
import { QUALIFICATION_CONFIG } from "../continuity/scenarios.mjs";
import {
  CONTINUITY_PROVIDER_ADAPTER_DECLARATION,
  CONTINUITY_SYSTEM_PROMPT,
  createContinuityProviderAdapter,
  toAnthropicMessages,
  toOpenAiMessages,
} from "./continuity-provider.mjs";

/**
 * Offline unit coverage for the credentialed continuity adapter (#248).
 *
 * Every test drives the adapter against a stubbed transport: no network call
 * is made, no real credential is read (only synthetic placeholder values are
 * set and asserted), and no real qualification verdict is produced. The
 * assertions pin the adapter contract the runner and #227 rely on: the
 * declaration shape, Pi-faithful wire translation, sole-batch submit
 * ordering, active-tool synchronization, `turn.fake` never reaching a request
 * body, bounded provider errors, and usage staying script-driven.
 */

const PRIMARY_KEY = "test-primary-key-placeholder";
const SECONDARY_KEY = "test-secondary-key-placeholder";
const SAVED_ENV = {};

function setEnv(name, value) {
  if (!(name in SAVED_ENV)) SAVED_ENV[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ─── stub transports ────────────────────────────────────────────────

function anthropicText(text) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 120, output_tokens: 12 } };
}

function anthropicTools(text, calls) {
  return {
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args })),
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 120, output_tokens: 12 },
  };
}

function openaiReply(text, calls = []) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: text,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      finish_reason: calls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 120, completion_tokens: 12 },
  };
}

/** Captures every request and replays the scripted replies in order (last repeats). */
function stubTransport(replies) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply instanceof Error) throw reply;
      return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
    },
  };
}

function allRequestBodies(transport) {
  return transport.requests.map((request) => JSON.stringify(request.body));
}

// ─── environment for the stubbed runs ───────────────────────────────

setEnv("CCR_CLAUDE_API_KEY", PRIMARY_KEY);
setEnv("CPA_API_KEY", SECONDARY_KEY);
setEnv("CPA_BASE_URL", "https://cpa.example.test");

process.on("exit", () => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ─── declaration and pins ───────────────────────────────────────────

{
  const adapter = createContinuityProviderAdapter({ transport: stubTransport([]) });
  assert.equal(typeof adapter.declaration.id, "string");
  assert.deepEqual(adapter.requiredEnv, ["CCR_CLAUDE_API_KEY", "CPA_API_KEY"],
    "requiredEnv carries the two credential variable names only");
  const { arms } = adapter.declaration;
  assert.equal(arms.primary.provider, "ccr-claude");
  assert.equal(arms.primary.model, "claude-sonnet-5");
  assert.equal(arms.secondary.provider, "cpa");
  assert.equal(arms.secondary.model, "deepseek-v4-pro");
  for (const arm of ["primary", "secondary"]) {
    assert.ok(arms[arm].thinking, `${arm} declares thinking`);
    assert.ok(arms[arm].sampling, `${arm} declares sampling`);
    assert.equal(arms[arm].sampling.temperature, null, `${arm} pins no temperature (claude-sonnet-5 rejects it)`);
  }
  assert.equal(adapter.declaration.id, CONTINUITY_PROVIDER_ADAPTER_DECLARATION.id);
  assert.throws(() => adapter.createSession({ script: { turns: [] }, run: { arm: "tertiary" } }),
    /unknown continuity arm/);
}

// ─── wire translation follows Pi's convertToLlm ─────────────────────

{
  const llm = convertToLlm([
    { role: "compactionSummary", summary: "SUM", tokensBefore: 5, timestamp: 1 },
    { role: "user", content: "u1", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "a1" },
        { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "x" } },
      ],
      timestamp: 1,
    },
    { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "r1" }], isError: false, timestamp: 1 },
    { role: "toolResult", toolCallId: "toolu_2", toolName: "bash", content: [{ type: "text", text: "r2" }], isError: true, timestamp: 1 },
    { role: "custom", customType: "pi-square.context-memory/advisory", content: "advisory text", display: false, timestamp: 1 },
    { role: "user", content: "u2", timestamp: 1 },
  ]);

  const anthropic = toAnthropicMessages(llm);
  assert.equal(anthropic[0].role, "user");
  assert.match(anthropic[0].content, /^The conversation history before this point was compacted into the following summary:/,
    "compactionSummary becomes user text with Pi's prefix");
  assert.match(anthropic[0].content, /<summary>\nSUM\n<\/summary>$/, "…and Pi's suffix framing");
  assert.deepEqual(anthropic[1], { role: "user", content: "u1" });
  assert.deepEqual(anthropic[2], {
    role: "assistant",
    content: [
      { type: "text", text: "a1" },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "x" } },
    ],
  });
  // Consecutive tool results are grouped into one user message with one
  // tool_result per tool_use, keyed by the provider's own ids.
  assert.equal(anthropic[3].role, "user");
  assert.deepEqual(anthropic[3].content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "r1", is_error: false },
    { type: "tool_result", tool_use_id: "toolu_2", content: "r2", is_error: true },
  ]);
  assert.deepEqual(anthropic[4], { role: "user", content: "advisory text" }, "custom becomes user text");
  assert.deepEqual(anthropic[5], { role: "user", content: "u2" });

  const openai = toOpenAiMessages("SYSTEM", llm);
  assert.deepEqual(openai[0], { role: "system", content: "SYSTEM" });
  assert.equal(openai[1].role, "user");
  assert.match(openai[1].content, /^The conversation history before this point was compacted/);
  assert.deepEqual(openai[2], { role: "user", content: "u1" });
  assert.deepEqual(openai[3], {
    role: "assistant",
    content: "a1",
    tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"path\":\"x\"}" } }],
  });
  assert.deepEqual(openai[4], { role: "tool", tool_call_id: "toolu_1", content: "r1" });
  assert.deepEqual(openai[5], { role: "tool", tool_call_id: "toolu_2", content: "r2" });
  assert.deepEqual(openai[6], { role: "user", content: "advisory text" });
  assert.deepEqual(openai[7], { role: "user", content: "u2" });
}

// ─── a full primary-arm session through the real controller seam ────

async function runScriptedSession({ arm, replies, turns }) {
  const transport = stubTransport(replies);
  const adapter = createContinuityProviderAdapter({ transport });
  const script = { turns, oracle: { branch: { abandoned: [] } } };
  const session = adapter.createSession({ script, run: { scenario: "stub", variant: "middle", arm, seed: "0000" } });
  const evidence = [];
  for (const turn of turns) evidence.push(await session.runTurn(turn));
  await session.close();
  return { transport, evidence, stats: session.stats() };
}

{
  const turns = [
    { id: "t1", kind: "work", user: "Establish the working context for the run.", usageAfter: 6200 },
    { id: "t2", kind: "work", user: "Complete the first stretch and submit the Memory block." },
    { id: "t3", kind: "probe", user: "Recap what you established, and read the Memory source for block 1." },
  ];
  const { transport, evidence, stats } = await runScriptedSession({
    arm: "primary",
    turns,
    replies: [
      anthropicText("Context established."),
      anthropicTools("Reading first.", [{ id: "toolu_read1", name: "read", args: { path: "src/writer.ts" } }]),
      anthropicTools("Done — submitting the Memory block.", [{
        id: "toolu_sub1",
        name: "submit_memory",
        args: { markdown: "# Memory one\n\n- established the working context for the run" },
      }]),
      anthropicTools("", [{ id: "toolu_src1", name: "read_memory_source", args: { block: 1, page: 1 } }]),
      anthropicText("We established the working context for the run."),
    ],
  });

  // Turn evidence mirrors the scripted adapter's records.
  assert.equal(evidence[0].error, null);
  assert.equal(evidence[0].assistantText, "Context established.");
  assert.equal(evidence[0].advisory, false);
  assert.deepEqual(evidence[1].toolCalls, ["read", "submit_memory"]);
  // The submit was accepted (message_end before execute, sole batch, same id):
  // only an accepted candidate produces the takeover the compression records.
  assert.deepEqual(evidence[1].compression, { turn: "t2", turnIndex: null, operation: "append", blocksBefore: 0, blocksAfter: 1 });
  assert.equal(stats.compressions.length, 1);
  assert.equal(evidence[1].advisory, true, "the bump turn's usageAfter opened the due run");
  assert.equal(evidence[2].error, null);
  // The source read completed the block in one page (structural verification,
  // never the scripted target).
  assert.deepEqual(evidence[2].sourceReads, [{ block: 1, pages: 1, verified: true }]);
  assert.deepEqual(evidence[2].toolCalls, ["read_memory_source"]);

  // Request shape: system prompt, no temperature anywhere, real tool-call ids.
  const bodies = transport.requests.map((request) => request.body);
  assert.equal(bodies[0].system, CONTINUITY_SYSTEM_PROMPT);
  for (const body of bodies) assert.ok(!("temperature" in body), "no temperature is ever sent");
  assert.equal(transport.requests[0].url, "https://ccr.bearfamily.us/v1/messages");
  assert.equal(transport.requests[0].init.headers["x-api-key"], PRIMARY_KEY);
  assert.match(transport.requests[0].init.headers.authorization, /^Bearer /);

  // Active-tool synchronization: baseline only before Memory exists, the
  // submit tool during the due run, the reading tool after compaction.
  const toolNames = (body) => body.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames(bodies[0]), ["read", "bash"]);
  assert.ok(toolNames(bodies[1]).includes("submit_memory"), "the due run activates submit_memory");
  assert.ok(toolNames(bodies[3]).includes("read_memory_source"), "valid Memory activates read_memory_source");
  assert.ok(!toolNames(bodies[3]).includes("submit_memory"), "no due run after compaction");

  // The Context Memory schemas pass through verbatim, and the adapter's own
  // read/bash tools are offered with one named literally `bash`.
  const reference = createHarness({ config: QUALIFICATION_CONFIG });
  const submitTool = bodies[1].tools.find((tool) => tool.name === "submit_memory");
  assert.deepEqual(submitTool.input_schema, reference.tools.get("submit_memory").parameters);
  const readSourceTool = bodies[3].tools.find((tool) => tool.name === "read_memory_source");
  assert.deepEqual(readSourceTool.input_schema, reference.tools.get("read_memory_source").parameters);
  const bashTool = bodies[0].tools.find((tool) => tool.name === "bash");
  assert.equal(bashTool.name, "bash");
  assert.equal(bashTool.input_schema.additionalProperties, false);
  assert.equal(bodies[0].tools.find((tool) => tool.name === "read").input_schema.additionalProperties, false);

  // The provider's own ids round-trip: the follow-up request answers the read
  // tool_use with a tool_result for the same id.
  const followUp = bodies[2].messages.flat().flatMap((message) =>
    Array.isArray(message.content) ? message.content : []);
  const readResult = followUp.find((part) => part?.type === "tool_result" && part.tool_use_id === "toolu_read1");
  assert.ok(readResult, "the read tool result carries the provider's real tool-call id");
  assert.equal(readResult.is_error, true, "the filesystem-less read tool reports an honest error");

  // The committed Memory rides the next request as Pi's compaction summary.
  const probeUserTexts = bodies[3].messages
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content);
  assert.ok(probeUserTexts.some((text) => text.includes("<summary>") && text.includes("Memory one")),
    "the compaction summary is carried as user text with Pi's framing");
}

// ─── nothing from turn.fake reaches a request body ──────────────────

{
  const CANARY_FINAL = "CANARY-final-text-must-never-be-sent";
  const CANARY_SUBMIT = "# CANARY-submit-body";
  const CANARY_TARGET = "CANARY-source-target";
  const CANARY_TOOL_RESULT = "CANARY-tool-result";
  const USER_TEXT = "The real user text for the canary turn.";
  const turns = [{
    id: "tc",
    kind: "work",
    user: USER_TEXT,
    fake: {
      finalText: CANARY_FINAL,
      submit: CANARY_SUBMIT,
      sourceRead: { block: 1, target: CANARY_TARGET },
      toolCalls: [{ name: "read", args: { path: "p" }, result: CANARY_TOOL_RESULT }],
    },
  }];
  const { transport, evidence } = await runScriptedSession({
    arm: "primary",
    turns,
    replies: [anthropicText("A genuine model answer.")],
  });
  const bodies = allRequestBodies(transport);
  for (const canary of [CANARY_FINAL, CANARY_SUBMIT, CANARY_TARGET, CANARY_TOOL_RESULT]) {
    assert.ok(!bodies.some((body) => body.includes(canary)), `no request body carries ${canary}`);
  }
  assert.ok(bodies.some((body) => body.includes(USER_TEXT)), "turn.user does reach the provider");
  assert.equal(evidence[0].assistantText, "A genuine model answer.", "the scripted final text is never used");
  assert.deepEqual(evidence[0].toolCalls, [], "scripted tool calls are never executed");
  assert.deepEqual(evidence[0].sourceReads, []);
  assert.equal(evidence[0].error, null);
}

// ─── branch mechanics: explore texts are sent, scripted replies are not ──

{
  const EXPLORE_USER = "Explore the alternative design on a dead branch.";
  const SCRIPTED_EXPLORE_REPLY = "CANARY-scripted-explore-reply";
  const turns = [
    { id: "t0", kind: "work", user: "The retained line of work is established first." },
    {
      id: "tb",
      kind: "work",
      user: "Back on the retained branch: continue the main line of work.",
      fake: { branch: { explore: [{ user: EXPLORE_USER, assistant: SCRIPTED_EXPLORE_REPLY }], returnToRetained: true } },
    },
  ];
  const { transport, evidence } = await runScriptedSession({
    arm: "primary",
    turns,
    replies: [
      anthropicText("The retained baseline reply."),
      anthropicText("A real explore reply from the model."),
      anthropicText("The retained-branch answer."),
    ],
  });
  const bodies = allRequestBodies(transport);
  assert.equal(evidence[0].error, null);
  assert.ok(bodies[1].includes(EXPLORE_USER), "the scripted explore user text is sent (permitted branch mechanics)");
  assert.ok(!bodies.some((body) => body.includes(SCRIPTED_EXPLORE_REPLY)), "the scripted explore reply is never used");
  assert.ok(!bodies[2].includes(EXPLORE_USER), "after tree navigation the dead branch left the request");
  assert.ok(!bodies[2].includes("A real explore reply from the model."), "the dead branch's model reply left the request too");
  assert.ok(bodies[2].includes("Back on the retained branch"), "the retained turn is the live one");
  assert.equal(evidence[1].error, null);
  assert.equal(evidence[1].assistantText, "The retained-branch answer.",
    "dead-branch replies never count as the turn's assistant evidence");
}

// ─── provider failures are bounded before entering evidence ─────────

{
  const padding = "x".repeat(400);
  const { evidence } = await runScriptedSession({
    arm: "primary",
    turns: [{ id: "te", kind: "work", user: "Trigger a transport failure." }],
    replies: [new Error(`ECONNRESET ${padding}`)],
  });
  assert.ok(evidence[0].error, "a transport failure becomes evidence");
  assert.ok(evidence[0].error.length <= 200, "the error is bounded to the report limit");
  assert.ok(!/(.)\1{63}/.test(evidence[0].error), "padding runs are collapsed by boundedMessage");
}

{
  const transport = {
    async fetch() {
      return { ok: false, status: 503, text: async () => `gateway unavailable ${"y".repeat(400)}` };
    },
  };
  const adapter = createContinuityProviderAdapter({ transport });
  const session = adapter.createSession({
    script: { turns: [], oracle: { branch: { abandoned: [] } } },
    run: { arm: "primary", scenario: "stub", variant: "middle", seed: "0" },
  });
  const evidence = await session.runTurn({ id: "th", kind: "work", user: "Trigger an HTTP failure." });
  await session.close();
  assert.match(evidence.error, /provider HTTP 503/);
  assert.ok(evidence.error.length <= 200);
}

{
  // A missing credential names the variable, never a value.
  setEnv("CCR_CLAUDE_API_KEY", undefined);
  const { evidence } = await runScriptedSession({
    arm: "primary",
    turns: [{ id: "tm", kind: "work", user: "No credential set." }],
    replies: [anthropicText("unreachable")],
  });
  setEnv("CCR_CLAUDE_API_KEY", PRIMARY_KEY);
  assert.match(evidence[0].error, /CCR_CLAUDE_API_KEY is not set/);
  assert.ok(!evidence[0].error.includes(PRIMARY_KEY));
}

// ─── the exchange bound keeps a tool-looping model from running forever ──

{
  const { evidence } = await runScriptedSession({
    arm: "primary",
    turns: [{ id: "tl", kind: "work", user: "Keep calling tools forever." }],
    replies: [anthropicTools("", [{ id: "toolu_loop", name: "read", args: { path: "loop" } }])],
  });
  assert.match(evidence[0].error, /exchange bound reached/);
}

// ─── the secondary arm speaks OpenAI Chat Completions ───────────────

{
  const turns = [
    { id: "s1", kind: "work", user: "Secondary arm context turn.", usageAfter: 6200 },
    { id: "s2", kind: "work", user: "Submit from the secondary arm." },
    { id: "s3", kind: "probe", user: "Recap." },
  ];
  const { transport, evidence, stats } = await runScriptedSession({
    arm: "secondary",
    turns,
    replies: [
      openaiReply("Secondary context established."),
      openaiReply("Running the command.", [{ id: "call_bash1", name: "bash", args: { command: "ls" } }]),
      openaiReply("Done — submitting.", [{ id: "call_sub1", name: "submit_memory", args: { markdown: "# Secondary memory\n\n- the secondary arm submitted" } }]),
      openaiReply("The secondary arm recap."),
    ],
  });

  assert.equal(evidence[0].error, null);
  assert.deepEqual(evidence[1].toolCalls, ["bash", "submit_memory"]);
  assert.equal(stats.compressions.length, 1, "the secondary arm drives the same takeover");
  assert.equal(evidence[2].error, null);

  const bodies = transport.requests.map((request) => request.body);
  for (const body of bodies) assert.ok(!("temperature" in body));
  assert.equal(transport.requests[0].url, "https://cpa.example.test/v1/chat/completions");
  assert.equal(transport.requests[0].init.headers.authorization, `Bearer ${SECONDARY_KEY}`);
  assert.ok(!("x-api-key" in transport.requests[0].init.headers));
  assert.equal(bodies[0].messages[0].role, "system");
  assert.equal(bodies[0].messages[0].content, CONTINUITY_SYSTEM_PROMPT);
  assert.deepEqual(bodies[0].tools.map((tool) => tool.function.name), ["read", "bash"]);
  assert.equal(bodies[1].tools[0].type, "function");
  const toolMessage = bodies[2].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "call_bash1");
  assert.match(toolMessage.content, /attaches no shell/);
}

// ─── a missing secondary base URL fails explicitly, not with a guess ──

{
  setEnv("CPA_BASE_URL", undefined);
  const { evidence } = await runScriptedSession({
    arm: "secondary",
    turns: [{ id: "sn", kind: "work", user: "No base URL configured." }],
    replies: [openaiReply("unreachable")],
  });
  setEnv("CPA_BASE_URL", "https://cpa.example.test");
  assert.match(evidence[0].error, /CPA_BASE_URL is not set/);
}

console.log("continuity-adapter.test.mjs: all offline adapter coverage passed");
