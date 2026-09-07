import assert from "node:assert/strict";
import { DIGEST_NONCE, composeRequest } from "../cache-experiment/fixture.mjs";
import { createOpenAiCacheProviderAdapter, openAiCacheProviderAdapters } from "./cache-openai-provider.mjs";

assert.deepEqual(openAiCacheProviderAdapters.map((adapter) => adapter.describePins().model), ["glm-5.3", "gpt-5.6-luna"]);
assert.throws(() => createOpenAiCacheProviderAdapter({ model: "unknown" }), /unsupported/);

const request = composeRequest({ group: 1, arm: "single", role: "probe", runNonce: DIGEST_NONCE });
const model = {
  id: "gpt-5.6-luna",
  name: "GPT 5.6 Luna",
  api: "openai-completions",
  provider: "cpa",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 300_000,
  maxTokens: 128_000,
  compat: { supportsDeveloperRole: false },
};
let nativeCall;
const runtime = {
  getModel: () => model,
  streamSimple(selected, context, options) {
    nativeCall = { selected, context, options };
    const message = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 3,
        cacheRead: 2_560,
        cacheWrite: 0,
        totalTokens: 2_663,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; } };
  },
};
const adapter = createOpenAiCacheProviderAdapter({ model: model.id, runtimeFactory: async () => runtime });
const report = await adapter.send({ ...request, runNonce: DIGEST_NONCE });
assert.equal(nativeCall.selected, model);
assert.equal(nativeCall.context.messages[0].content.length, 1, "the single-block baseline enters Pi as one text block");
assert.equal(nativeCall.options.sessionId, `pi-square-cache-cpa-gpt-5.6-luna-${DIGEST_NONCE}`);
assert.deepEqual(report.usage, { inputTokens: 100, outputTokens: 3 });
assert.deepEqual(report.cache, {
  available: true,
  readAvailable: true,
  read: 2_560,
  writeAvailable: true,
  write: 0,
  source: "pi-normalized",
  rawFieldPresence: "unknown",
});
assert.equal(report.retentionWrite.reported, false);

console.log("OpenAI-compatible Pi-native cache lanes passed");
