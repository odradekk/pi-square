import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR } = await load("../../src/context-memory/format.ts");
const { isEligibleSourceEntry } = await load("../../src/context-memory/derive.ts");

/**
 * #323 mechanical acceptance: the complete Memory body and the tool protocol
 * survive Pi's NATIVE provider conversion, observed at the real transport
 * boundary — the HTTP payload a provider endpoint would receive.
 *
 * A real Pi `AgentSession` runs against a provider whose API implementation is
 * the production `anthropic-messages` / `openai-completions` module from
 * `@earendil-works/pi-ai`, pointed at a loopback capture server that returns
 * deterministic synthetic SSE. The provider implementation is the unmodified
 * production code — not a stub, wrapper, or controller intermediate — so every
 * assertion below is about the converted wire payload as sent.
 *
 * One scripted conversation per API dialect exercises the combination surface:
 *
 * - a long ordinary history (multi-tool batches inside one assistant message,
 *   a failing read, far more entries than the old fixed-neighborhood scan)
 *   crosses the maintenance threshold;
 * - two appends and one suffix rebuild record state-carried Memory from
 *   synthetic summaries over 200 characters whose key facts sit at the very
 *   end of each body;
 * - a mixed compression+ordinary batch is refused while the ordinary
 *   sibling's real result survives;
 * - a mid-stream cancellation aborts one assistant response; the follow-up
 *   prompt continues over the aborted branch entry.
 *
 * At every captured payload the test asserts the provider-native pairing
 * contract (call ids ↔ results, both directions), the replay of thinking
 * signatures, the user image attachment, exactly-once complete Memory bodies
 * with byte-stable unselected prefixes, eviction of covered originals, the
 * retained working set, and that no provider cache marker sits outside the
 * placements Pi's own conversion documents — pi-square adds and moves none.
 *
 * These runs cover exactly the combinations exercised here. Later context or
 * payload modifiers and other provider flavors remain the accepted
 * compatibility boundary of ADR-0017, not a delivery guarantee.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 10_500;
const MEMORY_BUDGET_PERCENT = 1;

const ADVISORY_NEEDLE = "compression is due";
const REBUILD_ADVISORY_NEEDLE = "rebuilds the newest Memory suffix";
const PLANNING_MARKER = "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet-kilo";
const ABORT_NEEDLE = "ABORTED-THINKING-MARKER";
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKsMIQAAAABJRU5ErkJggg==";

/** Key facts sit at the very end of each block body: a complete carrier matters. */
const FACT_ONE = "The first wire archive code is CASSIOPEIA-402.";
const FACT_TWO = "The second wire archive code is ANDROMEDA-118.";
const FACT_THREE = "The rebuilt wire archive code is PERSEUS-733.";

/**
 * Sized against renderedMemoryTokens (wrapper + one separator per block, over
 * 4): one block stays at or below half the 1% budget (200 tokens) so the
 * second operation appends, and both bodies together cross half so the third
 * operation rebuilds the suffix, leaving block one as the byte-stable
 * unselected prefix.
 */
const blockBody = (title, fact, pad) => `# ${title}\n\n${"w".repeat(pad)}\n\n${fact}`;
const MEMORY_MARKDOWN_ONE = blockBody("Wire digest one", FACT_ONE, 190);
const MEMORY_MARKDOWN_TWO = blockBody("Wire digest two", FACT_TWO, 200);
const REBUILT_MARKDOWN = blockBody("Rebuilt wire digest", FACT_THREE, 170);
assert.ok(MEMORY_MARKDOWN_ONE.length > 200 && MEMORY_MARKDOWN_TWO.length > 200 && REBUILT_MARKDOWN.length > 200,
  "every synthetic summary exceeds 200 characters");
assert.ok(MEMORY_SUMMARY_WRAPPER.length + MEMORY_BLOCK_SEPARATOR.length + MEMORY_MARKDOWN_ONE.length <= 4 * 200,
  "block one stays within half the Memory budget so the second operation appends");
assert.ok(MEMORY_SUMMARY_WRAPPER.length + 2 * MEMORY_BLOCK_SEPARATOR.length + MEMORY_MARKDOWN_ONE.length + MEMORY_MARKDOWN_TWO.length > 4 * 200,
  "two blocks cross half the Memory budget so the third operation rebuilds");

const FILLER = "Wire operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(3);

const FILE_NAMES = [..."abcdefghijklmnopqrstuvwxyz", ...Array.from({ length: 24 }, (_, i) => `a${i}`)];
const FILES = {};
for (const [index, name] of FILE_NAMES.entries()) {
  const label = name.length === 1 ? name.toUpperCase() : `_${name.toUpperCase()}`;
  FILES[name] = `FILE-${label}-NEEDLE: wire workspace fact ${index} — the ${name} round evidence body.\n${FILLER}\n`;
}
const MISSING_FILE = "missing-wire-file";

/** The read schedule: several batches demonstrate multi-tool assistant messages. */
const READ_BATCHES = [["a"], ["b", "c"], ["d"], [MISSING_FILE], ["e", "f", "g"],
  ...["h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "a14", "a15",
    "a16", "a17", "a18", "a19", "a20", "a21", "a22", "a23"]
    .map((file) => [file])];

// ═══════════════════ The scripted conversation ═══════════════════

/**
 * Decide the next normalized response from one captured wire payload. The
 * phase machine advances on the script's own emission history; only advisory
 * visibility is read from request content, and never the call/result order
 * inside a batch.
 */
function planResponse(view, state) {
  const appendAdvisory = view.text.includes(ADVISORY_NEEDLE) && !view.text.includes(REBUILD_ADVISORY_NEEDLE);
  const rebuildAdvisory = view.text.includes(REBUILD_ADVISORY_NEEDLE);

  const toolCall = (name, args) => ({ name, args, id: `wt${state.idSequence++}` });
  const readBatch = (batch) => batch.map((file) => toolCall("read", { path: `${file}.txt` }));
  const nextReads = () => {
    const batch = READ_BATCHES[state.readCursor] ?? [];
    if (batch.length === 0) return { thinking: "out of scheduled files", text: `Wire task complete. ${FACT_ONE} ${FACT_TWO} ${FACT_THREE}` };
    state.readCursor += 1;
    return { thinking: `ordinary round ${state.readCursor}`, toolCalls: readBatch(batch) };
  };
  const soleCompact = (markdown, thinking) => ({ thinking, toolCalls: [toolCall("compact_to_memory_block", { markdown })] });

  // Runs two and three (verify prompts). The first verify response aborts
  // mid-stream; the continuation run finishes over the aborted branch entry.
  if (view.text.includes("WIRE-VERIFY-PROMPT")) {
    if (!state.abortedOnce) {
      state.abortedOnce = true;
      return { abort: true };
    }
    if (!state.verifyReadDone) {
      state.verifyReadDone = true;
      const batch = READ_BATCHES[state.readCursor] ?? [];
      if (batch.length > 0) {
        state.readCursor += 1;
        return { thinking: "recovering one round after the cancellation", toolCalls: readBatch(batch) };
      }
    }
    return { thinking: "closing the verification", text: `Verify complete. ${FACT_ONE} ${FACT_TWO} ${FACT_THREE}` };
  }

  // ── Run one's phase machine. Phases advance on the script's own emission
  // history — never on transient wire visibility, which legitimately drops
  // accepted compression pairs once the carrier duplicates their bodies. An
  // "awaiting" phase always sees the acknowledgement result first, because
  // every compression call is answered by the next request by construction.
  switch (state.phase) {
    case "pre-first": {
      if (appendAdvisory && state.deferredOne >= 4) {
        state.phase = "await-first";
        return soleCompact(MEMORY_MARKDOWN_ONE, "summarizing the covered rounds");
      }
      if (appendAdvisory) state.deferredOne += 1;
      return nextReads();
    }
    case "await-first": {
      state.phase = "post-first";
      return nextReads();
    }
    case "post-first": {
      if (state.postOneReads < 2) {
        state.postOneReads += 1;
        return nextReads();
      }
      state.phase = "await-mixed";
      const file = READ_BATCHES[state.readCursor]?.[0] ?? "z";
      state.readCursor += 1;
      return {
        thinking: "attempting an unsafe mixed batch",
        toolCalls: [toolCall("read", { path: `${file}.txt` }), toolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN_TWO })],
      };
    }
    case "await-mixed": {
      state.phase = "post-mixed";
      return nextReads();
    }
    case "post-mixed": {
      if (appendAdvisory && state.deferredTwo >= 3) {
        state.phase = "await-second";
        return soleCompact(MEMORY_MARKDOWN_TWO, "appending the second digest");
      }
      if (appendAdvisory) state.deferredTwo += 1;
      return nextReads();
    }
    case "await-second": {
      state.phase = "post-second";
      return nextReads();
    }
    case "post-second": {
      if (rebuildAdvisory && state.deferredThree >= 2) {
        state.phase = "await-rebuild";
        return soleCompact(REBUILT_MARKDOWN, "rebuilding the suffix from its originals");
      }
      if (rebuildAdvisory) state.deferredThree += 1;
      return nextReads();
    }
    case "await-rebuild":
    default: {
      state.phase = "post-rebuild";
      if (!state.finalReadDone) {
        state.finalReadDone = true;
        return nextReads();
      }
      return { thinking: "final wire answer", text: `Wire task complete. ${FACT_ONE} ${FACT_TWO} ${FACT_THREE}` };
    }
  }
}

// ═══════════════════ Wire SSE renderers ═══════════════════

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Render one normalized step as Anthropic Messages SSE. */
function renderAnthropicStep(step, index) {
  if (step.abort) {
    return {
      pieces: [
        { data: sse("message_start", { type: "message_start", message: { id: "msg_abort", usage: { input_tokens: 300, output_tokens: 1 } } }) },
        { data: sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) },
        { data: sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: ABORT_NEEDLE } }) },
        { data: sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "aborted-sig" } }) },
        { data: sse("content_block_stop", { type: "content_block_stop", index: 0 }) },
        // The delay holds the stream open so the coordinated abort lands
        // mid-response; the partial thinking stays on the branch.
        { data: sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }), delayMs: 700 },
        { data: sse("message_stop", { type: "message_stop" }) },
      ],
      endDelayMs: 1_400,
    };
  }
  const blocks = [];
  if (step.thinking) {
    blocks.push(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    blocks.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: step.thinking } }));
    blocks.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `wire-sig-${index}` } }));
    blocks.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  }
  for (const [offset, call] of (step.toolCalls ?? []).entries()) {
    const at = (step.thinking ? 1 : 0) + offset;
    blocks.push(sse("content_block_start", { type: "content_block_start", index: at, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }));
    blocks.push(sse("content_block_delta", { type: "content_block_delta", index: at, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }));
    blocks.push(sse("content_block_stop", { type: "content_block_stop", index: at }));
  }
  if (step.text) {
    const at = (step.thinking ? 1 : 0) + (step.toolCalls ?? []).length;
    blocks.push(sse("content_block_start", { type: "content_block_start", index: at, content_block: { type: "text", text: "" } }));
    blocks.push(sse("content_block_delta", { type: "content_block_delta", index: at, delta: { type: "text_delta", text: step.text } }));
    blocks.push(sse("content_block_stop", { type: "content_block_stop", index: at }));
  }
  return {
    pieces: [
      sse("message_start", { type: "message_start", message: { id: `msg_${index}`, usage: { input_tokens: 300, output_tokens: 1 } } }),
      ...blocks,
      sse("message_delta", { type: "message_delta", delta: { stop_reason: (step.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn" }, usage: { output_tokens: 4 } }),
      sse("message_stop", { type: "message_stop" }),
    ].map((data) => ({ data })),
    endDelayMs: 0,
  };
}

/** Render one normalized step as OpenAI-compatible chat completion SSE. */
function renderOpenAIStep(step, index) {
  if (step.abort) {
    return {
      pieces: [
        { data: sseData({ id: "c_abort", object: "chat.completion.chunk", model: step.model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: ABORT_NEEDLE } }] }) },
        // The delay holds the stream open so the coordinated abort lands
        // mid-response; the partial thinking stays on the branch.
        { data: "", delayMs: 700 },
        { data: sseData({ id: "c_abort", object: "chat.completion.chunk", model: step.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 2 } }) },
        { data: "data: [DONE]\n\n" },
      ],
      endDelayMs: 1_400,
    };
  }
  const deltas = [];
  if (step.thinking) deltas.push({ role: "assistant", reasoning_content: step.thinking });
  for (const call of step.toolCalls ?? []) {
    deltas.push({ role: "assistant", tool_calls: [{ index: deltas.length, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
  }
  if (step.text) deltas.push({ role: "assistant", content: step.text });
  const pieces = deltas.map((delta) => sseData({ id: `c_${index}`, object: "chat.completion.chunk", model: step.model, choices: [{ index: 0, delta }] }));
  pieces.push(sseData({ id: `c_${index}`, object: "chat.completion.chunk", model: step.model, choices: [{ index: 0, delta: {}, finish_reason: (step.toolCalls ?? []).length > 0 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 300, completion_tokens: 3 } }));
  pieces.push("data: [DONE]\n\n");
  return { pieces: pieces.map((data) => ({ data })), endDelayMs: 0 };
}

// ═══════════════════ Provider-neutral wire request views ═══════════════════

/** Collect every text contribution of one wire payload, provider-neutrally. */
function wireText(body, kind) {
  const parts = [];
  const userBlocks = (message) => {
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return message.content ?? [];
  };
  if (kind === "anthropic") {
    for (const message of body.messages ?? []) {
      if (message.role === "user") {
        for (const block of userBlocks(message)) {
          if (block.type === "text") parts.push(block.text);
          else if (block.type === "image") parts.push(`[image:${block.source?.media_type}]`);
          else if (block.type === "tool_result") {
            const inner = typeof block.content === "string"
              ? block.content
              : (block.content ?? []).map((c) => c.text ?? "").join("");
            parts.push(`RESULT:${block.tool_use_id}:${inner}`);
          }
        }
      } else if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "text") parts.push(block.text);
          else if (block.type === "thinking") parts.push(`[thinking:${block.signature ? "signed" : "unsigned"}]`);
          else if (block.type === "tool_use") parts.push(`CALL:${block.id}:${block.name}:${JSON.stringify(block.input)}`);
        }
      }
    }
  } else {
    for (const message of body.messages ?? []) {
      if (message.role === "user") {
        for (const block of userBlocks(message)) {
          if (block.type === "text") parts.push(block.text);
          else if (block.type === "image_url") parts.push("[image-url]");
        }
      } else if (message.role === "assistant") {
        if (typeof message.content === "string" && message.content.length > 0) parts.push(message.content);
        if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) parts.push(`[thinking:${message.reasoning_content.length}]`);
        for (const call of message.tool_calls ?? []) {
          parts.push(`CALL:${call.id}:${call.function?.name ?? call.name}:${call.function?.arguments ?? ""}`);
        }
      } else if (message.role === "tool") {
        parts.push(`RESULT:${message.tool_call_id}:${message.content ?? ""}`);
      }
    }
  }
  return parts.join("\n");
}

/** The tool names one wire payload exposes, provider-neutrally. */
function wireToolNames(body, kind) {
  if (kind === "anthropic") return (body.tools ?? []).map((tool) => tool.name);
  return (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
}

/** Every completed tool exchange of one wire payload, oldest result first. */
function wireToolExchanges(body, kind) {
  const byId = new Map();
  const results = [];
  if (kind === "anthropic") {
    for (const message of body.messages ?? []) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_use") byId.set(block.id, { name: block.name, argsText: JSON.stringify(block.input) });
        }
      }
    }
    for (const message of body.messages ?? []) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const call = byId.get(block.tool_use_id);
        const inner = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((c) => c.text ?? "").join("");
        results.push({ id: block.tool_use_id, name: call?.name, argsText: call?.argsText ?? "", isError: block.is_error === true, resultText: inner });
      }
    }
    return results;
  }
  for (const message of body.messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      byId.set(call.id, { name: call.function?.name ?? call.name, argsText: call.function?.arguments ?? "" });
    }
  }
  for (const message of body.messages ?? []) {
    if (message.role !== "tool") continue;
    const call = byId.get(message.tool_call_id);
    results.push({ id: message.tool_call_id, name: call?.name, argsText: call?.argsText ?? "", isError: false, resultText: message.content ?? "" });
  }
  return results;
}

/** Assert the provider-native pairing contract on one wire payload. */
function assertWirePairing(body, kind, label) {
  const callIds = [];
  const resultIds = [];
  if (kind === "anthropic") {
    for (const message of body.messages ?? []) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_use") callIds.push(block.id);
        }
      }
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result") resultIds.push(block.tool_use_id);
        }
      }
    }
  } else {
    for (const message of body.messages ?? []) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) callIds.push(call.id);
      }
      if (message.role === "tool") resultIds.push(message.tool_call_id);
    }
  }
  for (const id of resultIds) {
    assert.ok(callIds.includes(id), `${label}: every tool result has its call (${id})`);
  }
  for (const id of callIds) {
    assert.ok(resultIds.includes(id), `${label}: every call has its tool result (${id})`);
  }
}

/** The Memory carrier messages of one wire payload, as their text-part lists. */
function carrierParts(body) {
  const carriers = [];
  for (const message of body.messages ?? []) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    if (message.content.some((block) => block.type === "text" && block.text === MEMORY_SUMMARY_WRAPPER)) {
      carriers.push(message.content.filter((block) => block.type === "text").map((block) => block.text));
    }
  }
  return carriers;
}

/**
 * Pi's own conversion adds cache markers at its documented placements: the
 * Anthropic system prompt block, the last user message's last block, and the
 * last tool definition (the OpenAI-completions path adds none for a generic
 * provider). Every marker outside those placements — or any marker at all on
 * the OpenAI path — would be pi-square injecting or moving a provider cache
 * field, which the projection must never do.
 */
function assertCacheMarkers(body, kind, label) {
  const parents = [];
  const walk = (node, parent, key) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, node, undefined);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [entryKey, value] of Object.entries(node)) {
      if (entryKey === "cache_control") parents.push({ parent: node, key: entryKey });
      else walk(value, node, entryKey);
    }
  };
  walk(body, undefined, undefined);
  if (kind !== "anthropic") {
    assert.equal(parents.length, 0, `${label}: the OpenAI-compatible wire carries no provider cache field`);
    return;
  }
  const lastUserMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  const allowed = [];
  if (Array.isArray(body.system) && body.system.length > 0) {
    allowed.push({ parent: body.system.at(-1), key: "cache_control" });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    allowed.push({ parent: body.tools.at(-1), key: "cache_control" });
  }
  if (lastUserMessage && Array.isArray(lastUserMessage.content) && lastUserMessage.content.length > 0) {
    allowed.push({ parent: lastUserMessage.content.at(-1), key: "cache_control" });
  }
  for (const found of parents) {
    assert.ok(allowed.some((candidate) => candidate.parent === found.parent && candidate.key === found.key),
      `${label}: a cache marker sits outside Pi's own placements`);
  }
}

// ═══════════════════ Environment plumbing ═══════════════════

function prepareEnvironment(name) {
  const root = mkdtempSync(join(tmpdir(), `pi-square-wire-${name}-`));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: {
      enabled: true,
      compressionThreshold: { tokens: COMPRESSION_THRESHOLD_TOKENS },
      memoryBudgetPercent: MEMORY_BUDGET_PERCENT,
    },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [{ source: packageRoot }],
    quietStartup: true,
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  for (const [fileName, content] of Object.entries(FILES)) {
    writeFileSync(join(cwd, `${fileName}.txt`), content);
  }
  return { root, agentDir, cwd };
}

/**
 * Drive one full wire session for one API dialect: a loopback capture server
 * answers every provider-bound POST with scripted SSE through the production
 * API implementation, and a real AgentSession runs the tool loop against it.
 */
async function runWireSession(kind) {
  const environment = prepareEnvironment(kind);
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  const runtimeDir = mkdtempSync(join(tmpdir(), `pi-square-wire-runtime-${kind}-`));
  writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

  const state = {
    idSequence: 1,
    readCursor: 0,
    phase: "pre-first",
    deferredOne: 0,
    deferredTwo: 0,
    deferredThree: 0,
    postOneReads: 0,
    abortedOnce: false,
    verifyReadDone: false,
    finalReadDone: false,
  };
  const render = kind === "anthropic" ? renderAnthropicStep : renderOpenAIStep;
  const requests = [];
  let sequence = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const view = { text: wireText(body, kind), exchanges: wireToolExchanges(body, kind) };
      const step = { ...planResponse(view, state), model: body.model };
      const rendered = render(step, sequence);
      if (process.env.PI_SQUARE_WIRE_DEBUG) {
        const debugExchanges = wireToolExchanges(body, kind);
        const debugText = wireText(body, kind);
        console.error(`[wire ${kind} #${sequence}] estBase=${Math.ceil(((body.system ?? []).reduce((n, s) => n + (s.text?.length ?? 0), 0) + JSON.stringify(body.tools ?? []).length + (body.messages ?? []).reduce((n, m) => n + JSON.stringify(m).length, 0)) / 4)}`
          + ` accepted=${debugExchanges.filter((e) => e.name === "compact_to_memory_block" && e.resultText.includes("Memory block recorded")).length}`
          + ` refused=${debugExchanges.some((e) => e.name === "compact_to_memory_block" && e.resultText.includes("COMPACT_NOT_SOAL_TOOL"))}`
          + ` advisory=${debugText.includes(ADVISORY_NEEDLE)} rebuildAdv=${debugText.includes(REBUILD_ADVISORY_NEEDLE)}`
          + ` verify=${debugText.includes("WIRE-VERIFY-PROMPT")} carriers=${carrierParts(body).length}`
          + ` -> ${JSON.stringify({ abort: step.abort, calls: (step.toolCalls ?? []).map((c) => c.name), text: step.text?.slice(0, 40) })}`);
      }
      sequence += 1;
      requests.push({ path: req.url, body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const piece of rendered.pieces) {
        if (piece.delayMs) setTimeout(() => res.write(piece.data), piece.delayMs).unref?.();
        else res.write(piece.data);
      }
      setTimeout(() => res.end(), rendered.endDelayMs ?? 0).unref?.();
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const apiId = kind === "anthropic" ? "anthropic-messages" : "openai-completions";
  const modelId = kind === "anthropic" ? "wire-claude" : "wire-oai";
  const provider = createProvider({
    id: `wire-${kind}-test`,
    auth: { apiKey: { name: "WireTest", resolve: async () => ({ auth: { apiKey: "synthetic-wire-key", baseUrl } }) } },
    models: [{
      id: modelId,
      name: modelId,
      api: apiId,
      provider: `wire-${kind}-test`,
      baseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW,
      maxTokens: 2_048,
    }],
    api: { [apiId]: kind === "anthropic" ? anthropicMessagesApi() : openAICompletionsApi() },
  });

  let session;
  let unsubscribe;
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider);
  const compactionEvents = [];
  const abortedAssistants = [];
  let abortArmed = false;
  let abortFired = false;
  try {
    const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: environment.cwd,
      agentDir: environment.agentDir,
      settingsManager,
      noSkills: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.create(environment.cwd, join(environment.root, "sessions"));
    ({ session } = await createAgentSession({
      cwd: environment.cwd,
      agentDir: environment.agentDir,
      settingsManager,
      resourceLoader,
      sessionManager,
      modelRuntime: runtime,
      model: provider.getModels()[0],
      thinkingLevel: "medium",
      initialActiveToolNames: ["read", "bash"],
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
    const loadedErrors = resourceLoader.getExtensions().errors;
    assert.equal(loadedErrors.length, 0, "pi-square must load without extension errors");
    unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") {
        abortedAssistants.push(event.message);
      }
      if (event.type === "message_start" && event.message.role === "assistant" && abortArmed && !abortFired) {
        abortFired = true;
        void session.abort();
      }
    });

    const taskPrompt = [
      "Research this workspace end to end in one run. Read the files in the",
      "order they appear, batching several reads per response where natural.",
      "When the Context Memory advisory appears, finish the next few ordinary",
      "reads it follows, then compress as the sole call of its batch, and keep",
      "working. If a compression is ever refused, continue the ordinary reads",
      "and retry the compression as a sole call later. Answer only after the",
      "suffix rebuild of this run.",
      `Required planning context that must stay present throughout: ${PLANNING_MARKER}.`,
    ].join("\n");
    await session.prompt(taskPrompt, {
      source: "interactive",
      expandPromptTemplates: false,
      images: [{ type: "image", mimeType: "image/png", data: IMAGE_BASE64 }],
    });

    // Run two: the first response aborts mid-stream, leaving partial thinking
    // on the branch; the run ends cancelled.
    abortArmed = true;
    await session.prompt("WIRE-VERIFY-PROMPT: verify the wire archive codes still hold.", {
      source: "interactive",
      expandPromptTemplates: false,
    });

    // Run three: continue over the aborted branch entry and finish.
    await session.prompt("WIRE-VERIFY-PROMPT: continue the same verification and answer with every wire archive code.", {
      source: "interactive",
      expandPromptTemplates: false,
    });

    return { requests, sessionManager, compactionEvents, abortedAssistants, baseUrl };
  } finally {
    unsubscribe?.();
    await session?.dispose();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(environment.root, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

// ═══════════════════ Shared wire assertions ═══════════════════

async function assertWireContract(kind, run) {
  const { requests, sessionManager, compactionEvents } = run;
  const label = kind;

  // ── Session-level integrity ──
  assert.equal(compactionEvents.length, 0, `${label}: no native compaction occurs`);
  const branch = sessionManager.getBranch();
  const userEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(userEntries.length, 3, `${label}: three real user inputs drive the task, abort probe, and continuation`);
  const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
  assert.equal(stateEntries.length, 3, `${label}: append, append, and rebuild each record one state entry`);
  const [appendOne, appendTwo, rebuildOne] = stateEntries.map((entry) => entry.data);
  assert.equal(appendOne.blocks.length, 1);
  assert.equal(appendOne.blocks[0].markdown, MEMORY_MARKDOWN_ONE);
  assert.equal(appendTwo.blocks.length, 2);
  assert.equal(appendTwo.blocks[0].markdown, MEMORY_MARKDOWN_ONE);
  assert.equal(appendTwo.blocks[1].markdown, MEMORY_MARKDOWN_TWO);
  assert.equal(rebuildOne.blocks.length, 2, `${label}: the rebuild replaces only the suffix block`);
  assert.equal(rebuildOne.blocks[0].markdown, MEMORY_MARKDOWN_ONE, `${label}: the unselected prefix body is byte-stable`);
  assert.equal(rebuildOne.blocks[0].endEntryId, appendTwo.blocks[0].endEntryId, `${label}: the unselected prefix keeps its end`);

  // The first covered range far exceeds the old fixed-neighborhood scale.
  const blockOneEnd = branch.findIndex((entry) => entry.id === appendOne.blocks[0].endEntryId);
  assert.ok(blockOneEnd > 0, `${label}: the first block's range end resolves on the branch`);
  const eligibleInRange = branch.slice(0, blockOneEnd + 1).filter(isEligibleSourceEntry).length;
  assert.ok(eligibleInRange > 20, `${label}: the first covered range exceeds the old fixed-neighborhood scale (${eligibleInRange} eligible entries)`);

  // ── Every captured wire payload: pairing, tools, no cache fields ──
  assert.ok(requests.length >= 25, `${label}: a substantial wire request sequence (${requests.length})`);
  const baselineTools = wireToolNames(requests[0].body, kind)
    .filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort();
  for (const [index, request] of requests.entries()) {
    const body = request.body;
    const text = wireText(body, kind);
    assertWirePairing(body, kind, `${label} request ${index}`);
    const tools = wireToolNames(body, kind);
    assert.ok(tools.includes("compact_to_memory_block"), `${label}: the resident compression tool stays exposed (${index})`);
    assert.ok(!tools.includes("submit_memory"), `${label}: the retired name never appears (${index})`);
    assert.deepEqual(tools.filter((name) => name !== "compact_to_memory_block" && name !== "read_memory_source").sort(),
      baselineTools, `${label}: no other tool changes around maintenance (${index})`);
    assertCacheMarkers(body, kind, `${label} request ${index}`);
    assert.ok(!text.includes(ABORT_NEEDLE), `${label}: the aborted partial thinking is never replayed (${index})`);
    const advisoryMessages = (body.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content
        : (message.content ?? []).map((block) => block.text ?? "").join("")))
      .filter((joined) => joined.includes(ADVISORY_NEEDLE));
    assert.ok(advisoryMessages.length <= 1, `${label}: at most one advisory per request (${index})`);
    assert.ok(carrierParts(body).length <= 1, `${label}: at most one Memory carrier per request (${index})`);
    assert.ok(JSON.stringify(body).includes(IMAGE_BASE64), `${label}: the user image survives conversion (${index})`);
  }

  // ── Phase boundaries by wire evidence ──
  // Requests whose payload carries a compression tool CALL, in order:
  // the first append, the refused mixed batch, the second append, the rebuild.
  const callRequests = requests
    .map((request, index) => ({ index, hasCall: wireText(request.body, kind).match(/CALL:[^:]+:compact_to_memory_block:/) !== null }))
    .filter((entry) => entry.hasCall)
    .map((entry) => entry.index);
  assert.equal(callRequests.length, 4, `${label}: exactly four compression calls reach the wire (${callRequests.length})`);
  const [appendOneCallAt, mixedCallAt, appendTwoCallAt, rebuildCallAt] = callRequests;

  // (a) Before any acceptance: raw history, no carrier, deferral visible.
  for (const request of requests.slice(0, appendOneCallAt)) {
    assert.ok(!wireText(request.body, kind).includes(MEMORY_SUMMARY_WRAPPER), `${label}: no carrier before the first acceptance`);
  }
  const preAcceptAdvisory = requests.slice(0, appendOneCallAt)
    .filter((request) => wireText(request.body, kind).includes(ADVISORY_NEEDLE));
  assert.ok(preAcceptAdvisory.length >= 3, `${label}: the advisory defers across ordinary requests (${preAcceptAdvisory.length})`);

  // (b) The request after the first accepted acknowledgement applies it.
  const appliedOne = requests[appendOneCallAt];
  assert.ok(appliedOne, `${label}: a request follows the first acceptance`);
  const appliedOneText = wireText(appliedOne.body, kind);
  const coveredByBlockOne = branch.slice(0, blockOneEnd + 1)
    .filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read")
    .map((entry) => (entry.message.content ?? []).map((part) => part.text ?? "").join(""));
  assert.ok(coveredByBlockOne.length > 8, `${label}: the first block covered many reads (${coveredByBlockOne.length})`);
  for (const covered of coveredByBlockOne) {
    const needle = covered.split(":")[0];
    assert.ok(!appliedOneText.includes(needle), `${label}: the covered original left at once (${needle})`);
  }
  assert.ok(appliedOneText.includes(PLANNING_MARKER), `${label}: the protected task instruction stays raw`);
  assert.ok(appliedOneText.includes(FACT_ONE), `${label}: the complete first block body reaches the wire`);
  assert.equal(appliedOneText.split(FACT_ONE).length - 1, 1, `${label}: the first block body appears exactly once`);
  const appliedOneCarriers = carrierParts(appliedOne.body);
  assert.equal(appliedOneCarriers.length, 1, `${label}: exactly one carrier after the first acceptance`);
  assert.deepEqual(appliedOneCarriers[0], [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`],
    `${label}: the applied carrier is wrapper plus one byte-exact block part`);

  // The trailing accepted call's arguments collapse to the bounded placeholder.
  const appliedOneExchanges = wireToolExchanges(appliedOne.body, kind);
  const appliedOneCompact = appliedOneExchanges.find((exchange) => exchange.name === "compact_to_memory_block");
  assert.ok(appliedOneCompact, `${label}: the trailing accepted pair stays whole`);
  assert.ok(appliedOneCompact.argsText.includes("(this Memory block is carried in full above)"),
    `${label}: the trailing accepted call carries the bounded placeholder`);
  assert.ok(!appliedOneCompact.argsText.includes(FACT_ONE), `${label}: the body is not duplicated in the arguments`);

  // Thinking with a signature replays in the retained working set.
  const signedThinking = kind === "anthropic"
    ? (appliedOne.body.messages ?? []).some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0))
    : (appliedOne.body.messages ?? []).some((message) => message.role === "assistant"
      && typeof message.reasoning_content === "string" && message.reasoning_content.length > 0);
  assert.ok(signedThinking, `${label}: retained assistant thinking replays with its signature`);

  // (c) The refused mixed batch: the sibling read result stays real.
  const mixedContinuation = requests[mixedCallAt];
  assert.ok(mixedContinuation, `${label}: a continuation follows the mixed batch`);
  const mixedExchanges = wireToolExchanges(mixedContinuation.body, kind);
  const refusedExchange = mixedExchanges.find((exchange) => exchange.name === "compact_to_memory_block"
    && exchange.resultText.includes("COMPACT_NOT_SOAL_TOOL"));
  assert.ok(refusedExchange, `${label}: the mixed-batch refusal reaches the model`);
  if (kind === "anthropic") assert.equal(refusedExchange.isError, true, `${label}: the refusal is an error tool result at the wire`);
  const sibling = mixedExchanges.filter((exchange) => exchange.name === "read").at(-1);
  assert.ok(sibling && sibling.resultText.includes("NEEDLE"), `${label}: the ordinary sibling's real result survives the refusal`);
  // The refused call keeps its full argument body: no carrier duplicates it yet.
  assert.ok(refusedExchange.argsText.includes("# Wire digest two"),
    `${label}: the refused call keeps the only request-side copy of its body`);
  // The mixed assistant carried both calls in one message.
  const mixedAssistantCalls = kind === "anthropic"
    ? (mixedContinuation.body.messages ?? []).filter((message) => message.role === "assistant")
      .flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_use") : []))
    : (mixedContinuation.body.messages ?? []).filter((message) => message.role === "assistant")
      .flatMap((message) => message.tool_calls ?? []);
  assert.ok(mixedAssistantCalls.some((call) => (call.name ?? call.function?.name) === "compact_to_memory_block")
    && mixedAssistantCalls.some((call) => (call.name ?? call.function?.name) === "read"),
    `${label}: the same-assistant mixed batch stayed in one message`);

  // After the batch's continuation the refused pair drops whole.
  const afterRefusal = requests[mixedCallAt + 1];
  assert.ok(afterRefusal, `${label}: a request follows the refused batch's continuation`);
  const afterRefusalExchanges = wireToolExchanges(afterRefusal.body, kind);
  assert.ok(!afterRefusalExchanges.some((exchange) => exchange.name === "compact_to_memory_block"
    && exchange.resultText.includes("COMPACT_NOT_SOAL_TOOL")),
    `${label}: the refused pair drops after the batch's continuation`);

  // (d) The second append applies the same carrier discipline.
  const appliedTwo = requests[appendTwoCallAt];
  assert.ok(appliedTwo, `${label}: a request follows the second acceptance`);
  const appliedTwoText = wireText(appliedTwo.body, kind);
  assert.ok(appliedTwoText.includes(FACT_ONE) && appliedTwoText.includes(FACT_TWO), `${label}: both block bodies reach the wire`);
  assert.equal(appliedTwoText.split(FACT_TWO).length - 1, 1, `${label}: the second block body appears exactly once`);
  const appliedTwoCarriers = carrierParts(appliedTwo.body);
  assert.equal(appliedTwoCarriers.length, 1);
  assert.deepEqual(appliedTwoCarriers[0],
    [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_TWO}`],
    `${label}: the appended carrier keeps the old block byte-exact and appends the new one`);
  assert.equal(appliedTwoCarriers[0][1], appliedOneCarriers[0][1], `${label}: the append keeps the first block part byte-identical`);

  // (e) The rebuild: pending serving keeps the suffix originals raw with a
  // prefix-only carrier, then acceptance swaps them for one rebuilt block.
  const pendingRebuild = requests.slice(appendTwoCallAt + 1, rebuildCallAt)
    .filter((request) => wireText(request.body, kind).includes(REBUILD_ADVISORY_NEEDLE));
  assert.ok(pendingRebuild.length >= 2, `${label}: the rebuild advisory defers across ordinary requests (${pendingRebuild.length})`);
  for (const [offset, request] of pendingRebuild.entries()) {
    const text = wireText(request.body, kind);
    assert.ok(!text.includes(MEMORY_MARKDOWN_TWO.slice(0, 24)),
      `${label}: the replaced suffix summary never appears beside its own sources (pending ${offset})`);
    const carriers = carrierParts(request.body);
    assert.equal(carriers.length, 1, `${label}: one carrier while the rebuild is pending (${offset})`);
    assert.deepEqual(carriers[0], [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`],
      `${label}: the pending rebuild carries only the unselected prefix (${offset})`);
  }

  const appliedRebuild = requests[rebuildCallAt];
  assert.ok(appliedRebuild, `${label}: a request follows the rebuild acceptance`);
  const appliedRebuildText = wireText(appliedRebuild.body, kind);
  assert.ok(!appliedRebuildText.includes(MEMORY_MARKDOWN_TWO.slice(0, 24)), `${label}: the replaced block body is gone`);
  assert.ok(appliedRebuildText.includes(FACT_THREE), `${label}: the rebuilt body reaches the wire`);
  assert.equal(appliedRebuildText.split(FACT_THREE).length - 1, 1, `${label}: the rebuilt body appears exactly once`);
  const appliedRebuildCarriers = carrierParts(appliedRebuild.body);
  assert.equal(appliedRebuildCarriers.length, 1);
  assert.deepEqual(appliedRebuildCarriers[0],
    [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`, `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN}`],
    `${label}: the rebuilt carrier keeps the prefix byte-identical and appends the new block`);
  assert.equal(appliedRebuildCarriers[0][1], appliedOneCarriers[0][1],
    `${label}: the unselected prefix part is byte-identical from append to rebuild`);

  // (f) The last request still carries every complete body, once per carrier,
  // and never inside compression tool-call arguments. The model's own answer
  // text may quote the facts — that is ordinary conversation, not duplication.
  const lastText = wireText(requests.at(-1).body, kind);
  for (const fact of [FACT_ONE, FACT_TWO, FACT_THREE]) {
    assert.ok(lastText.includes(fact), `${label}: the last request carries the complete body (${fact.slice(-4)})`);
  }
  const lastCarriers = carrierParts(requests.at(-1).body);
  assert.equal(lastCarriers.length, 1, `${label}: one carrier in the last request`);
  assert.deepEqual(lastCarriers[0],
    [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}${MEMORY_MARKDOWN_ONE}`, `${MEMORY_BLOCK_SEPARATOR}${REBUILT_MARKDOWN}`],
    `${label}: the last carrier keeps the full rebuilt Memory byte-exact`);
  for (const [name, request] of [["second", appliedTwo], ["rebuild", appliedRebuild]]) {
    const trailing = wireToolExchanges(request.body, kind)
      .find((exchange) => exchange.name === "compact_to_memory_block");
    assert.ok(trailing, `${label}: the trailing accepted pair stays whole (${name})`);
    assert.ok(trailing.argsText.includes("(this Memory block is carried in full above)"),
      `${label}: the trailing accepted call carries the bounded placeholder (${name})`);
    for (const markdown of [MEMORY_MARKDOWN_ONE, MEMORY_MARKDOWN_TWO, REBUILT_MARKDOWN]) {
      assert.ok(!trailing.argsText.includes(markdown.split("\n")[0]),
        `${label}: the trailing accepted call never duplicates a block body (${name})`);
    }
  }

  // ── The abort probe: cancelled mid-stream, never replayed ──
  assert.equal(run.abortedAssistants.length, 1, `${label}: exactly one assistant response aborted mid-stream`);
  assert.ok(JSON.stringify(run.abortedAssistants[0] ?? {}).includes(ABORT_NEEDLE),
    `${label}: the aborted partial thinking stayed on the branch, making the wire assertion meaningful`);
  const postAbortRequests = requests.filter((request) => wireText(request.body, kind).includes("WIRE-VERIFY-PROMPT"));
  assert.ok(postAbortRequests.length >= 2, `${label}: the verification prompts reached the wire`);
  for (const [index, request] of postAbortRequests.entries()) {
    assertWirePairing(request.body, kind, `${label} post-abort ${index}`);
  }
}

// ═══════════════════ Execution ═══════════════════

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
  const anthropicRun = await runWireSession("anthropic");
  await assertWireContract("anthropic", anthropicRun);

  const openaiRun = await runWireSession("openai");
  await assertWireContract("openai", openaiRun);

  console.log("context-memory provider wire native sessions: OK");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
