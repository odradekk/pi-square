import assert from "node:assert/strict";
import { DIGEST_NONCE, SYSTEM_PROMPT, armNamespace, composeRequest } from "../cache-experiment/fixture.mjs";
import { fakeClock } from "../cache-experiment/fake-provider.mjs";
import { runExperiment } from "../cache-experiment/runner.mjs";
import {
  buildOpenAiCacheRequest,
  createOpenAiCacheProviderAdapter,
  openAiCacheProviderAdapters,
} from "./cache-openai-provider.mjs";

const KEY = "test-cpa-key-placeholder";
const saved = { key: process.env.CPA_API_KEY, base: process.env.CPA_BASE_URL };
process.env.CPA_API_KEY = KEY;
delete process.env.CPA_BASE_URL;
process.on("exit", () => {
  if (saved.key === undefined) delete process.env.CPA_API_KEY;
  else process.env.CPA_API_KEY = saved.key;
  if (saved.base === undefined) delete process.env.CPA_BASE_URL;
  else process.env.CPA_BASE_URL = saved.base;
});

function requestOf(group = 1, arm = "multiblock", role = "prime") {
  const composed = composeRequest({ group, arm, role, runNonce: DIGEST_NONCE });
  return { group, arm, role, payload: composed.payload };
}

function responseOf(usage, chunks = [{ choices: [{ delta: { content: "OK" } }] }]) {
  const text = [...chunks, { choices: [], usage }, "[DONE]"]
    .map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`)
    .join("");
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < text.length; offset += 11) {
          controller.enqueue(new Uint8Array(Buffer.from(text.slice(offset, offset + 11))));
        }
        controller.close();
      },
    }),
  };
}

function transportOf(response) {
  return {
    requests: [],
    async fetch(url, init) {
      this.requests.push({ url, init });
      return typeof response === "function" ? response(url, init) : response;
    },
  };
}

{
  assert.deepEqual(openAiCacheProviderAdapters.map((adapter) => adapter.describePins().model), ["glm-5.3", "gpt-5.6-luna"]);
  assert.ok(openAiCacheProviderAdapters.every((adapter) => adapter.requiredEnv.join() === "CPA_API_KEY"));
  assert.equal(new Set(openAiCacheProviderAdapters.map((adapter) => adapter.id)).size, 2);
}

{
  const body = buildOpenAiCacheRequest(requestOf(), "glm-5.3");
  assert.equal(body.model, "glm-5.3");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_completion_tokens, 512);
  assert.ok(!("prompt_cache_key" in body), "Pi's custom OpenAI-compatible path sends no OpenAI-domain cache key");
  assert.equal(body.temperature, 0, "the pinned setting matches Pi's payload and is accepted by both comparison models");
  assert.equal(body.store, false, "the transparent standard endpoint matches Pi's default store=false payload");
  assert.equal(body.messages[0].role, "system");
  assert.ok(body.messages[0].content.includes(SYSTEM_PROMPT));
  assert.ok(body.messages[0].content.startsWith(`Experiment isolation namespace ${armNamespace(DIGEST_NONCE, 1, "multiblock")}`));
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content.length, 4, "each Memory part remains a separate ordered text block");
  assert.ok(body.messages[1].content.every((part) => part.type === "text"));
  assert.ok(body.messages[1].content.every((part) => !("cache_control" in part)), "automatic-cache models receive no explicit breakpoint");
  assert.ok(body.tools.length > 0);
  assert.ok(body.tools.every((tool) => tool.type === "function" && tool.function.parameters && tool.function.strict === false));
  assert.ok(body.messages.filter((message) => message.role === "assistant").every((message) => typeof message.content === "string"),
    "assistant text uses Pi's standard Chat Completions string shape");
}

{
  const adapter = createOpenAiCacheProviderAdapter({
    model: "glm-5.3",
    transport: transportOf(responseOf({
      prompt_tokens: 1_000,
      completion_tokens: 2,
      prompt_cache_hit_tokens: 800,
      prompt_tokens_details: { cache_write_tokens: 100 },
    })),
  });
  const report = await adapter.send(requestOf());
  assert.deepEqual(report.usage, { inputTokens: 100, outputTokens: 2 });
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 800, write: 100, writeReported: true },
    "the adapter also accepts the compatibility fields parsed by Pi 0.84.2");
}

{
  const transport = transportOf(responseOf({
    prompt_tokens: 17_087,
    completion_tokens: 42,
    prompt_tokens_details: { cached_tokens: 17_024 },
  }, [{ choices: [{ delta: { reasoning_content: "thinking" } }] }]));
  const adapter = createOpenAiCacheProviderAdapter({ model: "glm-5.3", transport });
  let firstTokens = 0;
  const report = await adapter.send(requestOf(), { onFirstToken: () => { firstTokens += 1; } });
  assert.equal(firstTokens, 1, "reasoning output is a streamed first token too");
  assert.deepEqual(report.usage, { inputTokens: 63, outputTokens: 42 });
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 17_024, write: 0, writeReported: false });
  assert.equal(report.cost, 0);
  assert.equal(report.costReported, false);
  assert.equal(report.retentionWrite.reported, false);
  assert.equal(transport.requests[0].url, "https://cpa.bearfamily.us/v1/chat/completions");
  assert.equal(transport.requests[0].init.headers.authorization, `Bearer ${KEY}`);
}

{
  const adapter = createOpenAiCacheProviderAdapter({
    model: "gpt-5.6-luna",
    transport: transportOf(responseOf({
      prompt_tokens: 15_629,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 15_104, cached_creation_tokens: 128 },
    })),
  });
  const report = await adapter.send(requestOf());
  assert.deepEqual(report.usage, { inputTokens: 397, outputTokens: 5 });
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 15_104, write: 128, writeReported: true });
  assert.equal(report.costReported, false);
}

{
  const adapter = createOpenAiCacheProviderAdapter({
    model: "glm-5.3",
    transport: transportOf(responseOf({ prompt_tokens: 100, completion_tokens: 2 })),
  });
  const report = await adapter.send(requestOf());
  assert.deepEqual(report.cache, { reported: false, readReported: false, read: 0, write: 0, writeReported: false },
    "an absent cached_tokens field is not a reported zero");
}

{
  const adapter = createOpenAiCacheProviderAdapter({
    model: "glm-5.3",
    transport: transportOf(responseOf({
      prompt_tokens: 100,
      completion_tokens: 2,
      prompt_tokens_details: { cache_write_tokens: 40 },
    })),
  });
  const report = await adapter.send(requestOf());
  assert.deepEqual(report.cache, { reported: true, readReported: false, read: 0, write: 40, writeReported: true },
    "a write-only cache payload preserves the write without inventing a read report");
}

{
  const adapter = createOpenAiCacheProviderAdapter({
    model: "gpt-5.6-luna",
    transport: transportOf(responseOf({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 9, cached_creation_tokens: 2 },
    })),
  });
  await assert.rejects(adapter.send(requestOf()), /exceed prompt_tokens/);
}

{
  const clock = fakeClock();
  const adapter = createOpenAiCacheProviderAdapter({
    model: "glm-5.3",
    transport: transportOf(() => responseOf({
      prompt_tokens: 1_000,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 500 },
    })),
  });
  const { report, humanText } = await runExperiment({ adapter, clock, groupCount: 1, runNonce: "openai-flags" });
  const rows = Object.values(report.groups[0]).flatMap((value) => value?.prime ? [value.prime, value.probe] : []);
  assert.ok(rows.every((row) => row.cacheWriteReported === false));
  assert.ok(rows.every((row) => row.costReported === false));
  assert.equal(report.baselineSummary.perDirection.writeSpend.unreported, 1);
  assert.equal(report.baselineSummary.derived.cost.unreported, 1);
  assert.equal(report.baselineSummary.armMedians.writeTokens.multiblock, null);
  assert.equal(report.baselineSummary.armMedians.cost.multiblock, null);
  assert.match(humanText, /writeSpend median-delta unreported \(0w\/0b\/0e; 1 unreported\)/);
  assert.match(humanText, /cost \(derived\) median-delta unreported \(0w\/0b\/0e; 1 unreported\)/);
}

console.log("context-memory OpenAI-compatible cache adapter tests passed");
