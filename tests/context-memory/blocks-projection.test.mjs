import assert from "node:assert/strict";
import jiti from "jiti";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { projectMemoryBlocksMessage } = await load("../../src/context-memory/controller.ts");
const {
  MEMORY_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
  MEMORY_BLOCK_SEPARATOR,
  composeMemorySummary,
} = await load("../../src/context-memory/format.ts");
const { CONTEXT_MEMORY_BLOCKS_TYPE } = await load("../../src/context-memory/view.ts");

/**
 * #297 contract coverage for the uniform provider-bound Memory projection:
 * every valid current Memory block is exactly one ordered text content block
 * in every provider-bound request, through one projection with no model or
 * provider branch and no cache field or breakpoint of any kind; the
 * concatenated model-visible text stays equivalent to Pi's own rendering of
 * the ordinary compaction summary; any mismatch or invalid Memory fails
 * safely to the unmodified ordinary message; and Pi's supported provider
 * adapters receive the ordered multi-block text without rejection,
 * reordering, normalization, empty blocks, or accidental merging.
 */

const TS = "2026-01-01T00:00:00.000Z";
const CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

const BODIES = [
  "# Repo tour\n\n- index.ts registers each feature module",
  "# Login fix\n\n- session cookie set before the redirect · ✓ 登录修复",
];
const THIRD_BODY = "# Lexer verification\n\n- the lexer details were recovered from the sources";

function userEntry(id, parentId, content) {
  return { id, parentId, type: "message", timestamp: TS, message: { role: "user", content, timestamp: 1 } };
}

function assistantEntry(id, parentId, text) {
  return {
    id, parentId, type: "message", timestamp: TS,
    message: {
      role: "assistant", content: [{ type: "text", text }], timestamp: 2,
      stopReason: "stop", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    },
  };
}

function compactionEntry(id, parentId, firstKeptEntryId, bodies, ends, summaryOverride) {
  return {
    id, parentId, type: "compaction", timestamp: TS,
    summary: summaryOverride ?? composeMemorySummary(bodies),
    firstKeptEntryId, tokensBefore: 4321,
    details: {
      format: MEMORY_FORMAT_TAG,
      blocks: bodies.map((body, index) => ({ endEntryId: ends[index], markdownBytes: Buffer.byteLength(body, "utf8") })),
    },
    fromExtension: true,
  };
}

/**
 * The branch shape every trace reuses: two eligible exchanges, the first
 * carrying compaction (blocks 1–2 over them, kept boundary at the run's user
 * request), one later run, and optionally the append compaction (block 3 over
 * that run, kept boundary at the newest request).
 */
function carryingBranch({ appended = false } = {}) {
  const entries = [
    userEntry("e1", null, "walk me through the repo"),
    assistantEntry("e2", "e1", "one entry point registers the modules"),
    userEntry("e3", "e2", "now fix the login flow"),
    assistantEntry("e4", "e3", "the session cookie was set after the redirect"),
    userEntry("e5", "e4", "ship it"),
    compactionEntry("c1", "e5", "e5", BODIES, ["e2", "e4"]),
    userEntry("e6", "c1", "verify the lexer against the sources"),
    assistantEntry("e7", "e6", "the lexer details are confirmed"),
  ];
  if (!appended) {
    return { entries, leafId: "e7", summary: composeMemorySummary(BODIES), bodies: BODIES };
  }
  entries.push(userEntry("e8", "e7", "ship the third block"));
  entries.push(compactionEntry("c2", "e8", "e8", [...BODIES, THIRD_BODY], ["e2", "e4", "e7"]));
  return {
    entries,
    leafId: "c2",
    summary: composeMemorySummary([...BODIES, THIRD_BODY]),
    bodies: [...BODIES, THIRD_BODY],
  };
}

function harness(branch, config = CONFIG) {
  const session = {
    getLeafId: () => branch.leafId,
    getBranch: () => [...branch.entries],
    isPersisted: () => true,
  };
  const events = new Map();
  const pi = {
    registerTool() {},
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    registerMessageRenderer() {},
    on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler]); },
  };
  registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => { throw new Error("the projection harness never renders"); },
  });
  const ctx = {
    cwd: "/project", hasUI: true, mode: "tui", sessionManager: session, compact() {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 200000 }), getSystemPrompt: () => "",
    isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
    ui: { notify() {} },
  };
  const emit = async (name, event) => {
    let last;
    for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
    return last;
  };
  return { emit, ctx, session };
}

/** Pi's own rendered text of one compactionSummary request message. */
function ownRendering(summary) {
  const message = { role: "compactionSummary", summary, tokensBefore: 4321, timestamp: 42 };
  const converted = convertToLlm([message]);
  return { message, text: converted[0].content[0].text };
}

function requestOf(summary) {
  const { message } = ownRendering(summary);
  return [
    { ...message, timestamp: 42 },
    { role: "user", content: "the current request", timestamp: 43 },
  ];
}

function partTexts(projected) {
  assert.equal(projected.role, "custom");
  assert.equal(projected.customType, CONTEXT_MEMORY_BLOCKS_TYPE);
  assert.equal(projected.display, false, "the blocks message is non-display");
  assert.ok(Array.isArray(projected.content));
  return projected.content.map((part) => part.text);
}

try {

  // ── The uniform projection: one ordered text block per Memory block ──

  const branch = carryingBranch();
  const { emit } = harness(branch);
  await emit("session_start", { type: "session_start", reason: "startup" });

  const request = requestOf(branch.summary);
  const transformed = await emit("context", { type: "context", messages: request });
  assert.ok(transformed?.messages, "the request is transformed");
  assert.equal(transformed.messages.length, request.length, "the projection replaces the summary message in place");
  const projected = transformed.messages[0];
  const texts = partTexts(projected);
  assert.equal(texts.length, branch.bodies.length + 2,
    "one leading frame part, exactly one part per Memory block, one trailing frame part");

  const own = ownRendering(branch.summary).text;
  assert.equal(texts.join(""), own,
    "the concatenated model-visible text is byte-identical to Pi's own rendering of the ordinary summary");
  assert.ok(texts[0].startsWith(own.slice(0, own.indexOf(MEMORY_SUMMARY_WRAPPER))),
    "the leading part carries Pi's own compaction framing before the wrapper");
  assert.ok(texts[0].endsWith(MEMORY_SUMMARY_WRAPPER), "the leading part ends with the fixed wrapper");
  for (const [index, body] of branch.bodies.entries()) {
    assert.equal(texts[index + 1], MEMORY_BLOCK_SEPARATOR + body,
      `block ${index + 1} is exactly one distinct text block carrying its separator and body`);
    assert.ok(texts[index + 1].length > 0, "no empty block parts");
  }
  assert.equal(texts.at(-1), own.slice(own.indexOf(branch.summary) + branch.summary.length),
    "the trailing part is exactly Pi's own trailing framing");
  assert.equal(projected.timestamp, 42, "the replacement mirrors the original message's timestamp");
  assert.equal(transformed.messages[1].content, "the current request", "other messages are untouched");

  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes("cache_control"),
    "the projection adds no provider-specific cache field or breakpoint");
  assert.ok(!serialized.includes("cacheControl"), "no camelCase cache field either");
  for (const part of projected.content) {
    assert.deepEqual(Object.keys(part).sort(), ["text", "type"], "each part is a plain text content part");
    assert.equal(part.type, "text");
  }

  // Determinism: the same request projects to the identical message.
  const again = await emit("context", { type: "context", messages: requestOf(branch.summary) });
  assert.equal(JSON.stringify(again.messages[0]), JSON.stringify(projected),
    "the projection is deterministic across requests");

  // The pure seam fails closed on candidates whose rendering cannot be
  // reconstructed: an unknown summary never matches, and no candidate leaves
  // the message list untouched.
  assert.equal(projectMemoryBlocksMessage(requestOf("a foreign native summary"), [
    { summary: branch.summary, bodies: branch.bodies },
  ]), undefined, "a request without the candidate summary is left untouched");

  // ── Append stability: the carried parts are byte-identical across the append ──

  const primeBranch = carryingBranch();
  const probeBranch = carryingBranch({ appended: true });
  const primeRun = harness(primeBranch);
  const probeRun = harness(probeBranch);
  await primeRun.emit("session_start", { type: "session_start", reason: "startup" });
  await probeRun.emit("session_start", { type: "session_start", reason: "startup" });
  const primeParts = partTexts(
    (await primeRun.emit("context", { type: "context", messages: requestOf(primeBranch.summary) })).messages[0],
  );
  const probeParts = partTexts(
    (await probeRun.emit("context", { type: "context", messages: requestOf(probeBranch.summary) })).messages[0],
  );
  assert.equal(primeParts.length, 4, "the prime carries blocks 1–2 as two block parts plus the frames");
  assert.equal(probeParts.length, 5, "the probe carries blocks 1–2 plus the appended block 3");
  assert.deepEqual(
    probeParts.slice(0, primeParts.length - 1),
    primeParts.slice(0, primeParts.length - 1),
    "the appended block inserts one new part and leaves every carried part byte-identical",
  );
  assert.equal(probeParts.at(-1), primeParts.at(-1), "the trailing frame part is unchanged by the append");
  assert.equal(probeParts[3], MEMORY_BLOCK_SEPARATOR + THIRD_BODY,
    "the new part is exactly the appended block's separator and body");

  // ── Fail-safe: native, opaque, missing, and mismatched summaries stay untouched ──

  const nativeRun = harness({ entries: [
    userEntry("n1", null, "a plain conversation"),
    assistantEntry("n2", "n1", "with no Context Memory at all"),
    compactionEntry("nc", "n2", "n1", ["irrelevant"], ["n2"], "a foreign native summary"),
    userEntry("n3", "nc", "the current request"),
  ], leafId: "n3" });
  await nativeRun.emit("session_start", { type: "session_start", reason: "startup" });
  const nativeRequest = [
    { role: "compactionSummary", summary: "a foreign native summary", tokensBefore: 9, timestamp: 42 },
    { role: "user", content: "the current request", timestamp: 43 },
  ];
  const nativeTransformed = await nativeRun.emit("context", { type: "context", messages: nativeRequest });
  assert.ok(nativeTransformed?.messages, "the transform still runs without structured Memory");
  assert.deepEqual(nativeTransformed.messages[0], nativeRequest[0],
    "an ordinary native compaction summary is untouched by the projection");

  // An opaque carrying compaction (malformed directory) leaves its ordinary
  // summary message untouched even though the request carries it.
  const opaqueBranch = carryingBranch();
  opaqueBranch.entries[5] = {
    ...opaqueBranch.entries[5],
    details: { format: MEMORY_FORMAT_TAG, blocks: [{ endEntryId: "e2", markdownBytes: 1 }] },
  };
  const opaqueRun = harness(opaqueBranch);
  await opaqueRun.emit("session_start", { type: "session_start", reason: "startup" });
  const opaqueTransformed = await opaqueRun.emit("context", { type: "context", messages: requestOf(branch.summary) });
  assert.equal(opaqueTransformed.messages[0].role, "compactionSummary",
    "invalid current Memory keeps the ordinary summary message");

  // A mismatched rendering (the request's summary is not the live composed
  // summary) fails safely to the unmodified ordinary message while the other
  // transform rules keep applying in the same request.
  const mismatchRun = harness(branch);
  await mismatchRun.emit("session_start", { type: "session_start", reason: "startup" });
  const mismatchRequest = [
    { role: "compactionSummary", summary: composeMemorySummary([BODIES[0], "# A different second block"]), tokensBefore: 4321, timestamp: 42 },
    {
      role: "assistant", content: [
        { type: "text", text: "an ordinary past answer" },
        { type: "toolCall", id: "old-call", name: "submit_memory", arguments: { markdown: "old" } },
      ], timestamp: 44,
    },
    { role: "toolResult", toolCallId: "old-call", toolName: "submit_memory", content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], timestamp: 45 },
    { role: "user", content: "the current request", timestamp: 43 },
  ];
  const mismatchTransformed = await mismatchRun.emit("context", { type: "context", messages: mismatchRequest });
  assert.equal(mismatchTransformed.messages[0].summary, mismatchRequest[0].summary,
    "a projection mismatch keeps the request's ordinary summary message unmodified");
  assert.ok(!JSON.stringify(mismatchTransformed.messages).includes("old-call"),
    "the unrelated submit-artifact filtering still applies on the same request");

  // ── Pi provider adapters receive the ordered multi-block text one-to-one ──

  const llm = convertToLlm(transformed.messages);
  assert.equal(llm[0].role, "user", "Pi's own conversion maps the blocks message to a user message");
  const blockTexts = llm[0].content.map((part) => part.text);
  assert.deepEqual(blockTexts, texts, "Pi's conversion preserves the ordered parts without merging");
  const providerContext = { systemPrompt: "You are the Pi main agent.", tools: [], messages: llm };

  // anthropic-messages: driven through the adapter's stream with a stub
  // client, because its converter is not exported; the payload is captured
  // before any network call.
  const anthropic = await import("@earendil-works/pi-ai/api/anthropic-messages");
  const anthropicModel = {
    id: "claude-sonnet-5", provider: "anthropic", api: "anthropic-messages",
    maxTokens: 8192, contextWindow: 200000, input: ["text"],
    baseUrl: "https://api.anthropic.com",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    compat: {}, headers: {},
  };
  let anthropicParams = null;
  const anthropicClient = {
    messages: {
      create(params) {
        anthropicParams = params;
        return { asResponse() { throw new Error("payload captured"); } };
      },
    },
  };
  const anthropicStream = anthropic.stream(anthropicModel, providerContext, { client: anthropicClient, maxTokens: 256 });
  for await (const event of anthropicStream) {
    if (event?.type === "error") break;
  }
  assert.ok(anthropicParams, "the anthropic-messages adapter built its payload from the projected request");
  const anthropicBlocks = anthropicParams.messages[0].content;
  assert.equal(anthropicBlocks.length, texts.length,
    "anthropic-messages carries every part as its own text block with no merging");
  assert.deepEqual(anthropicBlocks.map((block) => block.text), texts,
    "anthropic-messages receives the ordered multi-block text byte-exact, without reordering or normalization");
  assert.ok(anthropicBlocks.every((block) => block.type === "text" && block.text.length > 0),
    "no empty text blocks reach anthropic-messages");
  assert.ok(anthropicBlocks.every((block) => block.cache_control === undefined),
    "the blocks message carries no anthropic cache_control marker; the projection adds no breakpoint");
  const anthropicLast = anthropicParams.messages.at(-1);
  assert.ok(Array.isArray(anthropicLast.content) && anthropicLast.content.at(-1).cache_control,
    "Pi's own tail breakpoint placement is unchanged by the projection");
  assert.ok(anthropicParams.system?.[0]?.cache_control, "Pi's own system breakpoint placement is unchanged");

  // openai-completions
  const completions = await import("@earendil-works/pi-ai/api/openai-completions");
  const completionsModel = {
    id: "gpt-5.2", provider: "openai", api: "openai-completions",
    maxTokens: 8192, contextWindow: 400000, input: ["text"],
  };
  const completionsMessages = completions.convertMessages(completionsModel, providerContext, {});
  assert.equal(completionsMessages[1].role, "user");
  assert.deepEqual(
    completionsMessages[1].content.filter((part) => part.type === "text").map((part) => part.text),
    texts,
    "openai-completions receives the ordered multi-block text one-to-one",
  );

  // openai-responses (shared with azure/codex responses APIs)
  const responses = await import("@earendil-works/pi-ai/api/openai-responses-shared");
  const responsesModel = {
    id: "gpt-5.2", provider: "openai", api: "openai-responses",
    maxTokens: 8192, contextWindow: 400000, input: ["text"],
  };
  const responsesInput = responses.convertResponsesMessages(responsesModel, providerContext, new Set());
  const responsesBlocks = responsesInput[1].content;
  assert.deepEqual(
    responsesBlocks.map((part) => part.text),
    texts,
    "openai-responses receives the ordered multi-block text one-to-one as input_text blocks",
  );

  // google-generative-ai (shared with google-vertex)
  const google = await import("@earendil-works/pi-ai/api/google-shared");
  const googleModel = {
    id: "gemini-3-pro", provider: "google", api: "google-generative-ai",
    maxTokens: 8192, contextWindow: 1000000, input: ["text"],
  };
  const googleContents = google.convertMessages(googleModel, providerContext);
  assert.deepEqual(
    googleContents[0].parts.map((part) => part.text),
    texts,
    "google-generative-ai receives the ordered multi-block text one-to-one",
  );

  console.log("blocks-projection.test.mjs: all assertions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
