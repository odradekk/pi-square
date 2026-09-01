import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  ADVISORY_TYPE,
  PENDING_ACK,
  beforeCompactEvent,
  boundedMessage,
  commitTakeover,
  createHarness,
  fakeTree,
  projectedMessages,
  userEntry,
} from "../qualification/harness.mjs";
import {
  MODEL_WINDOW,
  POST_COMPACTION_USAGE_TOKENS,
  QUALIFICATION_CONFIG,
  START_USAGE_TOKENS,
} from "../continuity/scenarios.mjs";
import { boundedErrorText, realTransport } from "./transport.mjs";

/**
 * The credentialed continuity-qualification adapter (#248, executed by #227).
 *
 * It implements the adapter contract of `runner.mjs` exactly the way the
 * scripted dry-run adapter (`fake-model.mjs`) does — the same harness, the
 * same Pi-shaped events, the same evidence records — and replaces only the
 * scripted model with real provider calls:
 *
 * - The primary arm is `ccr-claude/claude-sonnet-5` over the Anthropic
 *   Messages API; the secondary arm is `cpa/deepseek-v4-pro` over OpenAI
 *   Chat Completions. `requiredEnv` carries the two credential variable
 *   *names*; values are read only at request time and never printed.
 * - Only `turn.user` (and `branch.explore[].user`, as branch mechanics)
 * ever reaches a request body. Nothing from `turn.fake` is sent, and
 * `fake.sourceRead.target` never enters evidence: source-read verification
 * is structural — a block read through its last page returned the block's
 * complete original conversation, and the fixture tests pin that every
 * expected exact value lives inside its expected block.
 * - Message translation is Pi's own `convertToLlm` followed by a minimal
 * wire mapping (`custom` and `compactionSummary` become user text inside
 * `convertToLlm`; `toolResult` becomes Anthropic `tool_result` blocks or
 * OpenAI `role:"tool"` messages).
 * - `usage.tokens` stays driven by `turn.usageAfter` exactly like the
 * scripted adapter: the harness computes no real usage, real provider usage
 * would push every turn past the 5 000-token due point, and branch
 * estimation would never reach three compressions in a 12-turn script.
 * Real provider usage is recorded only as assistant-entry metadata.
 * - Every provider failure is bounded through `harness.boundedMessage`
 * before it enters `evidence.error`.
 *
 * This module is never executed by #248: real execution, credentials, and
 * the release verdict belong to #227 and the maintainer. The offline unit
 * tests drive it against stubbed transports only.
 */

const SUBMIT = "submit_memory";
const READ_SOURCE = "read_memory_source";
const ASSISTANT_TEXT_CAP = 8_000;
const MAX_OUTPUT_TOKENS = 4_096;
/** One turn is a bounded number of provider exchanges (tool rounds), not an open loop. */
const MAX_EXCHANGES = 12;
const TOOL_NAME_CAP = 80;

/**
 * The arm table. The primary gateway was probed directly (issue #248:
 * `https://ccr.bearfamily.us`, 2026-08-31) and is the default; the secondary
 * gateway's base URL is not a verified fact of this slice, so it must be
 * supplied through `CPA_BASE_URL` at #227 execution time — an explicit error
 * beats a silently wrong guess.
 */
const ARMS = {
  primary: {
    arm: "primary",
    provider: "ccr-claude",
    model: "claude-sonnet-5",
    api: "anthropic-messages",
    apiKeyEnv: "CCR_CLAUDE_API_KEY",
    baseUrlEnv: "CCR_CLAUDE_BASE_URL",
    baseUrlDefault: "https://ccr.bearfamily.us",
  },
  secondary: {
    arm: "secondary",
    provider: "cpa",
    model: "deepseek-v4-pro",
    api: "openai-completions",
    apiKeyEnv: "CPA_API_KEY",
    baseUrlEnv: "CPA_BASE_URL",
    baseUrlDefault: null,
  },
};

/**
 * `temperature` is deliberately absent from both arms: `claude-sonnet-5`
 * rejects it (issue #248's probed facts), so the pinned zero cannot be
 * applied on any cacheable model, and `deepseek-v4-pro` needs no pin to
 * behave deterministically enough for continuity evidence. The pins record
 * the mode; no sampling parameter is ever sent.
 */
export const CONTINUITY_PROVIDER_ADAPTER_DECLARATION = {
  id: "ccr-claude+cpa/real-continuity/1",
  requiredEnv: ["CCR_CLAUDE_API_KEY", "CPA_API_KEY"],
  arms: {
    primary: {
      provider: ARMS.primary.provider,
      model: ARMS.primary.model,
      thinking: "off",
      sampling: { mode: "provider-default", temperature: null, topP: null },
    },
    secondary: {
      provider: ARMS.secondary.provider,
      model: ARMS.secondary.model,
      thinking: "off",
      sampling: { mode: "provider-default", temperature: null, topP: null },
    },
  },
};

/**
 * The adapter-owned system prompt. It is deliberately minimal, uniform for
 * every turn and both arms, and free of anything scenario-specific: no
 * Memory internals (the due-run advisory carries those), no oracle content,
 * no coached answers — only the working-agent norms any Pi session applies.
 */
export const CONTINUITY_SYSTEM_PROMPT = [
  "You are the main agent of a terminal coding session, working through one long task with a user.",
  "",
  "- Work through each request step by step and answer concisely.",
  "- Ground every statement in the conversation and in tool results you have actually seen.",
  "- Use the available tools when examining files or running commands helps the task.",
  "- When an exact value or event is not established anywhere in the conversation, say so instead of inventing one.",
  "- A notice appended to the conversation may define an additional tool workflow for this session; follow it.",
].join("\n");

/** The adapter's own `read`-shaped tool: the affordance is real, the environment is not. */
const ADAPTER_READ_TOOL = {
  name: "read",
  description: "Read one file's contents. The qualification environment attaches no filesystem, so no file content exists to return.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path of the file to read" } },
    required: ["path"],
    additionalProperties: false,
  },
};

/** The adapter's own `bash`-shaped tool, named literally `bash`. */
const ADAPTER_BASH_TOOL = {
  name: "bash",
  description: "Run one shell command. The qualification environment attaches no shell, so commands are not executed.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", description: "The command to run" } },
    required: ["command"],
    additionalProperties: false,
  },
};

const READ_TOOL_RESULT =
  "The qualification environment attaches no filesystem: this file cannot be read. Continue from the conversation, or state that the file is unavailable.";
const BASH_TOOL_RESULT =
  "The qualification environment attaches no shell: the command was not executed.";

// ─── Wire translation (Pi `convertToLlm` output → provider bodies) ──

function userTextOf(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .filter((text) => typeof text === "string" && text.length > 0)
    .join("\n");
}

function resultTextOf(message) {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Anthropic Messages bodies. Mirrors Pi's own conversion: user text passes
 * through, assistant text becomes `text` blocks and tool calls become
 * `tool_use` blocks, and consecutive tool results are grouped into one user
 * message because Anthropic requires every `tool_use` to be answered by the
 * immediately following user message.
 */
export function toAnthropicMessages(llmMessages) {
  const out = [];
  let index = 0;
  while (index < llmMessages.length) {
    const message = llmMessages[index];
    if (message.role === "user") {
      const text = userTextOf(message);
      if (text.trim().length > 0) out.push({ role: "user", content: text });
      index += 1;
    } else if (message.role === "assistant") {
      const blocks = [];
      for (const part of message.content ?? []) {
        if (part?.type === "text" && part.text.trim().length > 0) {
          blocks.push({ type: "text", text: part.text });
        } else if (part?.type === "toolCall") {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments ?? {} });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      index += 1;
    } else if (message.role === "toolResult") {
      const results = [];
      while (index < llmMessages.length && llmMessages[index].role === "toolResult") {
        const result = llmMessages[index];
        results.push({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: resultTextOf(result),
          is_error: result.isError === true,
        });
        index += 1;
      }
      out.push({ role: "user", content: results });
    } else {
      index += 1; // defensive: convertToLlm emits only the three wire roles
    }
  }
  return out;
}

/**
 * OpenAI Chat Completions bodies: the system prompt leads, user text passes
 * through, assistant tool calls become `tool_calls`, and tool results become
 * `role:"tool"` messages carrying the provider's own tool-call ids.
 */
export function toOpenAiMessages(systemPrompt, llmMessages) {
  const out = [{ role: "system", content: systemPrompt }];
  for (const message of llmMessages) {
    if (message.role === "user") {
      const text = userTextOf(message);
      if (text.trim().length > 0) out.push({ role: "user", content: text });
    } else if (message.role === "assistant") {
      const text = (message.content ?? [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = (message.content ?? []).filter((part) => part?.type === "toolCall");
      const wire = { role: "assistant", content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) {
        wire.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      out.push(wire);
    } else if (message.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: resultTextOf(message) });
    }
  }
  return out;
}

function toAnthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? tool.parameters,
  }));
}

function toOpenAiTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? tool.parameters,
    },
  }));
}

// ─── Reply parsing ──────────────────────────────────────────────────

function safeJsonArguments(raw) {
  if (raw == null || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseAnthropicReply(body) {
  const content = Array.isArray(body?.content) ? body.content : [];
  const text = content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
  const toolCalls = content
    .filter((part) => part?.type === "tool_use")
    .map((part) => ({ id: String(part.id ?? ""), name: String(part.name ?? ""), arguments: part.input ?? {} }));
  const usage = body?.usage ?? {};
  return {
    text,
    toolCalls,
    stopReason: typeof body?.stop_reason === "string" ? body.stop_reason : "end_turn",
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
    parts: [
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
    ],
  };
}

function parseOpenAiReply(body) {
  const message = body?.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map((call) => ({
      id: String(call?.id ?? ""),
      name: String(call?.function?.name ?? ""),
      arguments: safeJsonArguments(call?.function?.arguments),
    }));
  const usage = body?.usage ?? {};
  return {
    text,
    toolCalls,
    stopReason: typeof body?.choices?.[0]?.finish_reason === "string" ? body.choices[0].finish_reason : "stop",
    usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 },
    parts: [
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
    ],
  };
}

// ─── Session entries (real ids and real provider metadata) ──────────

function assistantMessageEntry(id, parentId, reply, arm) {
  const usage = reply.usage;
  return {
    id,
    parentId,
    type: "message",
    timestamp: Date.now(),
    message: {
      role: "assistant",
      content: reply.parts,
      api: arm.api,
      provider: arm.provider,
      model: arm.model,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reply.stopReason,
      timestamp: 1,
    },
  };
}

function toolResultMessageEntry(id, parentId, toolCallId, toolName, text, isError) {
  return {
    id,
    parentId,
    type: "message",
    timestamp: Date.now(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError: isError === true,
      timestamp: 1,
    },
  };
}

// ─── The adapter ────────────────────────────────────────────────────

/**
 * Builds the real continuity adapter. `options.transport` is the stub seam
 * for the offline tests; production callers take the default `fetch`
 * transport. Construction performs no I/O and reads no environment.
 */
export function createContinuityProviderAdapter(options = {}) {
  const transport = options.transport ?? realTransport();
  return {
    declaration: CONTINUITY_PROVIDER_ADAPTER_DECLARATION,
    requiredEnv: CONTINUITY_PROVIDER_ADAPTER_DECLARATION.requiredEnv,
    createSession({ script, run }) {
      const arm = ARMS[run?.arm];
      if (!arm) throw new Error(`unknown continuity arm: ${String(run?.arm)}`);
      return createProviderSession({ script, arm, transport });
    },
  };
}

export default createContinuityProviderAdapter();

function createProviderSession({ script, arm, transport }) {
  // The usage object is shared with the fake host by reference and is moved
  // exclusively by `turn.usageAfter` and compaction boundaries, exactly like
  // the scripted adapter — never by real provider usage.
  const usage = { tokens: START_USAGE_TOKENS, contextWindow: MODEL_WINDOW };
  const harness = createHarness({ config: QUALIFICATION_CONFIG, usage });
  const session = fakeTree([]);
  const ctx = harness.baseContext(session);
  const compressions = [];
  const abandonedPatterns = (script.oracle.branch?.abandoned ?? []).flatMap((entry) => entry.patterns);
  let blocks = 0;
  let requestEntryId = null;
  let idCounter = 0;
  let started = false;
  let retainedLeafId = null;

  const nextId = (prefix) => `${prefix}-${String((idCounter += 1)).padStart(3, "0")}`;
  const emit = (name, event) => harness.emit(name, event, ctx);

  function resolveBaseUrl() {
    const overridden = process.env[arm.baseUrlEnv];
    if (overridden) return overridden;
    if (arm.baseUrlDefault) return arm.baseUrlDefault;
    throw new Error(
      `${arm.baseUrlEnv} is not set: the ${arm.arm} arm's gateway base URL must be provided at execution time (#227)`,
    );
  }

  function apiKey() {
    const value = process.env[arm.apiKeyEnv];
    if (!value) {
      throw new Error(`${arm.apiKeyEnv} is not set; the adapter never prints credential values`);
    }
    return value;
  }

  /** The per-request tool list: active tools only, CM schemas passed through verbatim. */
  function activeProviderTools() {
    const definitions = new Map([
      ["read", ADAPTER_READ_TOOL],
      ["bash", ADAPTER_BASH_TOOL],
      [SUBMIT, harness.tools.get(SUBMIT)],
      [READ_SOURCE, harness.tools.get(READ_SOURCE)],
    ]);
    return harness.pi.getActiveTools().map((name) => definitions.get(name)).filter(Boolean);
  }

  async function callModel(agentMessages) {
    // Pi's own transformer first: custom and compactionSummary messages become
    // user text here, exactly as every Pi provider request does.
    const llmMessages = convertToLlm(agentMessages);
    const key = apiKey();
    const baseUrl = resolveBaseUrl();
    const tools = activeProviderTools();
    let url;
    let headers;
    let body;
    if (arm.api === "anthropic-messages") {
      url = `${baseUrl}/v1/messages`;
      headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        // One credential header only: x-api-key is verified against the
        // gateway; the OpenAI path is the sole Bearer user.
        "x-api-key": key,
      };
      body = {
        model: arm.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: CONTINUITY_SYSTEM_PROMPT,
        messages: toAnthropicMessages(llmMessages),
        tools: toAnthropicTools(tools),
        stream: false,
      };
    } else {
      url = `${baseUrl}/v1/chat/completions`;
      headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
      body = {
        model: arm.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: toOpenAiMessages(CONTINUITY_SYSTEM_PROMPT, llmMessages),
        tools: toOpenAiTools(tools),
        stream: false,
      };
    }
    const response = await transport.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) {
      throw new Error(`provider HTTP ${response.status}: ${await boundedErrorText(response)}`);
    }
    const parsed = await response.json();
    return arm.api === "anthropic-messages" ? parseAnthropicReply(parsed) : parseOpenAiReply(parsed);
  }

  /** Project the live session, run the controller's context transform, then call the model. */
  async function providerRequest(record) {
    const request = projectedMessages(session);
    const transformed = await emit("context", { type: "context", messages: request });
    const messages = transformed?.messages ?? request;
    if (record) {
      record.requestChars += JSON.stringify(messages).length;
      if (!record.advisory && messages.some((message) => message?.customType === ADVISORY_TYPE)) {
        record.advisory = true;
      }
    }
    return callModel(messages);
  }

  function noteSourceRead(evidence, block, result) {
    let record = evidence.sourceReads.find((entry) => entry.block === block);
    if (!record) {
      record = { block, pages: 0, verified: false };
      evidence.sourceReads.push(record);
    }
    record.pages += 1;
    // Structural verification: a read through the block's last page returned
    // the block's complete original conversation, and the fixture tests pin
    // every expected exact value inside its expected block. The scripted
    // target itself is oracle data and never enters evidence.
    if (result?.details?.hasMore === false) record.verified = true;
  }

  async function executeToolCall(turn, call, evidence) {
    const toolCallId = call.id;
    if (call.name === SUBMIT) {
      const submit = harness.tools.get(SUBMIT);
      // The assistant message (and its message_end) carrying this exact id
      // has already been recorded, so the controller's sole-batch check sees
      // exactly [toolCallId] — the same ordering the scripted adapter keeps.
      try {
        const result = await submit.execute(
          toolCallId,
          { markdown: typeof call.arguments?.markdown === "string" ? call.arguments.markdown : "" },
          undefined,
          undefined,
          ctx,
        );
        session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, SUBMIT, PENDING_ACK, false));
        evidence.toolCalls.push(SUBMIT);
        if (result?.terminate) return "submitted";
      } catch (error) {
        session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, SUBMIT, boundedMessage(error), true));
        evidence.toolCalls.push(SUBMIT);
      }
      return "continue";
    }
    if (call.name === READ_SOURCE) {
      const read = harness.tools.get(READ_SOURCE);
      const block = Number(call.arguments?.block);
      const page = Number(call.arguments?.page);
      try {
        const result = await read.execute(toolCallId, { block, page }, undefined, undefined, ctx);
        const text = result.content.map((part) => part.text ?? "").join("\n");
        session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, READ_SOURCE, text, false));
        noteSourceRead(evidence, Number.isFinite(block) ? block : 0, result);
      } catch (error) {
        session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, READ_SOURCE, boundedMessage(error), true));
        if (Number.isFinite(block)) noteSourceRead(evidence, block, null);
      }
      evidence.toolCalls.push(READ_SOURCE);
      return "continue";
    }
    if (call.name === "read") {
      session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, "read", READ_TOOL_RESULT, true));
      evidence.toolCalls.push("read");
      return "continue";
    }
    if (call.name === "bash") {
      session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, "bash", BASH_TOOL_RESULT, true));
      evidence.toolCalls.push("bash");
      return "continue";
    }
    const unknown = String(call.name).slice(0, TOOL_NAME_CAP);
    session.append(toolResultMessageEntry(nextId(`${turn.id}-r`), session.getLeafId(), toolCallId, unknown, `unknown tool: ${unknown}`, true));
    evidence.toolCalls.push(unknown);
    return "continue";
  }

  async function start() {
    if (started) return;
    started = true;
    await emit("session_start", { type: "session_start", reason: "new" });
  }

  async function runTurn(turn) {
    await start();
    const evidence = {
      turn: turn.id,
      kind: turn.kind,
      advisory: false,
      assistantText: "",
      assistantChars: 0,
      requestChars: 0,
      toolCalls: [],
      sourceReads: [],
      compression: null,
      memoryPurity: null,
      error: null,
    };

    try {
      // Branch mechanics: explore on a dead sibling path through real provider
      // calls over the scripted explore user texts, then navigate back. The
      // scripted replies are never used — the model's real answers are.
      if (turn.fake?.branch?.explore?.length) {
        retainedLeafId = session.getLeafId();
        for (const exchange of turn.fake.branch.explore) {
          await emit("input", { type: "input", text: exchange.user, source: "interactive" });
          session.append(userEntry(nextId(`${turn.id}-xu`), session.getLeafId(), exchange.user));
          const reply = await providerRequest();
          session.append(assistantMessageEntry(nextId(`${turn.id}-xa`), session.getLeafId(), reply, arm));
          await emit("message_end", { type: "message_end", message: { role: "assistant", content: reply.parts } });
        }
      }
      if (turn.fake?.branch?.returnToRetained && retainedLeafId !== null) {
        const oldLeaf = session.getLeafId();
        session.branchTo(retainedLeafId);
        await emit("session_tree", { type: "session_tree", newLeafId: retainedLeafId, oldLeafId: oldLeaf });
      }

      // The real-user turn: input (which opens the due run while the previous
      // entry is still the leaf, exactly as Pi orders it), entry, then the
      // bounded provider exchange loop.
      await emit("input", { type: "input", text: turn.user, source: "interactive" });
      const userId = nextId(`${turn.id}-u`);
      session.append(userEntry(userId, session.getLeafId(), turn.user));
      requestEntryId = userId;

      for (let exchange = 1; exchange <= MAX_EXCHANGES; exchange += 1) {
        if (exchange === MAX_EXCHANGES) {
          evidence.error = boundedMessage(
            `turn exchange bound reached: the model kept calling tools without finishing (${MAX_EXCHANGES} exchanges)`,
          );
          break;
        }
        const reply = await providerRequest(evidence);
        session.append(assistantMessageEntry(nextId(`${turn.id}-a`), session.getLeafId(), reply, arm));
        await emit("message_end", { type: "message_end", message: { role: "assistant", content: reply.parts } });
        if (reply.text) evidence.assistantText += (evidence.assistantText ? "\n" : "") + reply.text;

        if (reply.toolCalls.length === 0) break;
        let submitted = false;
        for (const call of reply.toolCalls) {
          if (await executeToolCall(turn, call, evidence) === "submitted") submitted = true;
        }
        if (submitted) break; // submit_memory terminates its batch (#218)
      }
      if (evidence.assistantText.length > ASSISTANT_TEXT_CAP) {
        evidence.assistantText = evidence.assistantText.slice(0, ASSISTANT_TEXT_CAP);
      }
      evidence.assistantChars = evidence.assistantText.length;

      if (typeof turn.usageAfter === "number") usage.tokens = turn.usageAfter;
      const compactsBefore = harness.compactCalls.length;
      await emit("agent_settled", { type: "agent_settled" });

      if (harness.compactCalls.length > compactsBefore) {
        const takeover = await emit(
          "session_before_compact",
          beforeCompactEvent(session, { firstKeptEntryId: requestEntryId }),
        );
        if (takeover?.compaction) {
          const entry = await commitTakeover(harness, session, ctx, takeover);
          usage.tokens = POST_COMPACTION_USAGE_TOKENS;
          const blocksAfter = entry.details.blocks.length;
          compressions.push({
            turn: turn.id,
            turnIndex: null,
            operation: blocks === 0 || blocksAfter > blocks ? "append" : "rebuild",
            blocksBefore: blocks,
            blocksAfter,
          });
          blocks = blocksAfter;
          evidence.compression = compressions[compressions.length - 1];
          if (abandonedPatterns.length > 0) {
            evidence.memoryPurity = !abandonedPatterns.some((pattern) => entry.summary.includes(pattern));
          }
        } else {
          evidence.error = "the settle-triggered compaction fell back to Pi native; no Memory takeover matched";
          usage.tokens = POST_COMPACTION_USAGE_TOKENS;
        }
      }
    } catch (error) {
      evidence.error = boundedMessage(`turn provider failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    return evidence;
  }

  return {
    async runTurn(turn) {
      return runTurn(turn);
    },
    /** The live compression list; the runner stamps turn indexes after the fact. */
    stats() {
      return { compressions };
    },
    async close() {
      await emit("session_shutdown", { type: "session_shutdown" });
    },
  };
}
