import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DIGEST_NONCE, SYSTEM_PROMPT, composeRequest } from "../cache-experiment/fixture.mjs";
import { buildPiCacheContext, createPiNativeCacheProviderAdapter } from "./pi-native-cache-provider.mjs";

function requestOf(arm = "multiblock", role = "prime") {
  const composed = composeRequest({ group: 1, arm, role, runNonce: DIGEST_NONCE });
  return { group: 1, arm, role, runNonce: DIGEST_NONCE, payload: composed.payload };
}

const model = {
  id: "glm-5.3",
  name: "GLM 5.3",
  api: "openai-completions",
  provider: "cpa",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500_000,
  maxTokens: 128_000,
  compat: { supportsDeveloperRole: false },
};

{
  const context = buildPiCacheContext(requestOf(), model);
  assert.ok(context.systemPrompt.includes(SYSTEM_PROMPT));
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content.length, 4, "the production multi-block shape reaches Pi unchanged");
  assert.ok(context.tools.every((tool) => "parameters" in tool && !("input_schema" in tool)));
}

{
  const calls = [];
  const final = {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 128,
      output: 4,
      cacheRead: 2_048,
      cacheWrite: 0,
      totalTokens: 2_180,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
  const runtime = {
    getModel(provider, id) {
      assert.deepEqual([provider, id], ["cpa", "glm-5.3"]);
      return model;
    },
    streamSimple(selected, context, options) {
      calls.push({ selected, context, options });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", contentIndex: 0, delta: "OK", partial: final };
          yield { type: "done", reason: "stop", message: final };
        },
      };
    },
  };
  const adapter = createPiNativeCacheProviderAdapter({
    provider: "cpa",
    model: "glm-5.3",
    runtimeFactory: async () => runtime,
  });
  let firstTokens = 0;
  const report = await adapter.send(requestOf(), { onFirstToken: () => { firstTokens += 1; } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.sessionId, `pi-square-cache-cpa-glm-5.3-${DIGEST_NONCE}`);
  assert.equal(calls[0].options.cacheRetention, "short");
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(calls[0].options.maxTokens, 512);
  assert.ok(!("temperature" in calls[0].options), "Pi's normal session path does not invent a temperature option");
  assert.equal(firstTokens, 1);
  assert.deepEqual(report.usage, { inputTokens: 128, outputTokens: 4 });
  assert.deepEqual(report.cache, {
    available: true,
    readAvailable: true,
    read: 2_048,
    writeAvailable: true,
    write: 0,
    source: "pi-normalized",
    rawFieldPresence: "unknown",
  });
}

{
  // This exercises Pi's real provider composer, OpenAI converter, SDK stream,
  // and usage parser. Only fetch is replaced so the test stays offline.
  const dir = await mkdtemp(join(tmpdir(), "pi-square-native-cache-"));
  const modelsPath = join(dir, "models.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      cpa: {
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-only-key",
        api: "openai-completions",
        models: [{
          id: "glm-5.3",
          name: "GLM 5.3",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 500_000,
          maxTokens: 128_000,
          compat: { supportsDeveloperRole: false },
        }],
      },
      "ccr-claude": {
        baseUrl: "https://claude.example.invalid",
        apiKey: "test-only-key",
        api: "anthropic-messages",
        models: [{
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 500_000,
          maxTokens: 128_000,
          compat: { forceAdaptiveThinking: true },
        }],
      },
    },
  }));
  const runtime = await ModelRuntime.create({
    modelsPath,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const nativePayloads = {};
  const fetch = async (input, init) => {
    const outgoing = input instanceof Request ? input : new Request(input, init);
    const nativePayload = JSON.parse(await outgoing.clone().text());
    if (outgoing.url.endsWith("/messages")) {
      nativePayloads.anthropic = nativePayload;
      const events = [
        ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 128, cache_read_input_tokens: 2_048, cache_creation_input_tokens: 320, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    nativePayloads.openai = nativePayload;
    const frames = [
      { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "glm-5.3", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
      { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "glm-5.3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2_176, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 2_048 } } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const adapter = createPiNativeCacheProviderAdapter({
      provider: "cpa",
      model: "glm-5.3",
      runtimeFactory: async () => runtime,
      fetch,
    });
    const report = await adapter.send(requestOf());
    assert.equal(nativePayloads.openai.model, "glm-5.3");
    assert.equal(nativePayloads.openai.max_completion_tokens, 512);
    assert.deepEqual(nativePayloads.openai.stream_options, { include_usage: true });
    assert.ok(!("prompt_cache_key" in nativePayloads.openai),
      "Pi itself omits prompt_cache_key for a custom OpenAI-compatible URL at short retention");
    assert.ok(!("temperature" in nativePayloads.openai), "the experiment sends the same unspecified temperature as a normal Pi session");
    assert.equal(nativePayloads.openai.messages[1].content.length, 4,
      "Pi's native converter preserves the four Memory text blocks");
    assert.deepEqual(report.usage, { inputTokens: 128, outputTokens: 2 });
    assert.equal(report.cache.read, 2_048, "cache usage comes back through Pi's native usage parser");

    const anthropicAdapter = createPiNativeCacheProviderAdapter({
      provider: "ccr-claude",
      model: "claude-sonnet-5",
      runtimeFactory: async () => runtime,
      fetch,
    });
    const anthropicReport = await anthropicAdapter.send(requestOf());
    assert.equal(nativePayloads.anthropic.model, "claude-sonnet-5");
    assert.equal(nativePayloads.anthropic.messages[0].content.length, 4);
    assert.ok(!("temperature" in nativePayloads.anthropic));
    assert.equal((JSON.stringify(nativePayloads.anthropic).match(/"cache_control"/g) ?? []).length, 3,
      "Pi itself places the system, last-tool, and last-user cache breakpoints");
    assert.deepEqual(anthropicReport.usage, { inputTokens: 128, outputTokens: 2 });
    assert.deepEqual(anthropicReport.cache, {
      available: true,
      readAvailable: true,
      read: 2_048,
      writeAvailable: true,
      write: 320,
      source: "pi-normalized",
      rawFieldPresence: "unknown",
    });
    assert.equal(anthropicReport.retentionWrite.reported, false,
      "short retention was requested but Pi exposed no affirmative raw 5m bucket evidence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("Pi-native cache provider tests passed");
