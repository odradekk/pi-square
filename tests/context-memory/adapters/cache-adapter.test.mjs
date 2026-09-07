import assert from "node:assert/strict";
import { DIGEST_NONCE, composeRequest } from "../cache-experiment/fixture.mjs";
import { adapters, createCacheProviderAdapter } from "./cache-provider.mjs";

function requestOf() {
  const composed = composeRequest({ group: 1, arm: "multiblock", role: "prime", runNonce: DIGEST_NONCE });
  return { group: 1, arm: "multiblock", role: "prime", runNonce: DIGEST_NONCE, payload: composed.payload };
}

function runtimeFor(model, calls) {
  return {
    getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    streamSimple(selected, context, options) {
      calls.push({ selected, context, options });
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 80,
          output: 2,
          cacheRead: 640,
          cacheWrite: 320,
          cacheWrite1h: 0,
          totalTokens: 1_042,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", contentIndex: 0, delta: "OK", partial: message };
          yield { type: "done", reason: "stop", message };
        },
      };
    },
  };
}

assert.deepEqual(adapters.map((adapter) => adapter.describePins().model), [
  "claude-sonnet-5",
  "glm-5.3",
  "gpt-5.6-luna",
]);
assert.ok(adapters.every((adapter) => adapter.requiredEnv.length === 0),
  "Pi resolves credentials through its native auth path instead of experiment-specific environment checks");
assert.ok(adapters.every((adapter) => adapter.describePins().invocation === "Pi 0.84.2 ModelRuntime.streamSimple"));

{
  const model = {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    provider: "ccr-claude",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 128_000,
  };
  const calls = [];
  const adapter = createCacheProviderAdapter({ runtimeFactory: async () => runtimeFor(model, calls) });
  let firstTokens = 0;
  const report = await adapter.send(requestOf(), { onFirstToken: () => { firstTokens += 1; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selected, model);
  assert.equal(calls[0].options.cacheRetention, "short");
  assert.ok(!("temperature" in calls[0].options));
  assert.equal(firstTokens, 1);
  assert.deepEqual(report.cache, {
    available: true,
    readAvailable: true,
    read: 640,
    writeAvailable: true,
    write: 320,
    source: "pi-normalized",
    rawFieldPresence: "unknown",
  });
  assert.deepEqual(report.retentionWrite, { reported: false, bucket: "unreported", tokens: 0 });
  assert.equal(report.costReported, false, "an all-zero Pi model price table stays explicitly unavailable");
}

console.log("cache adapter declarations and native Anthropic lane passed");
