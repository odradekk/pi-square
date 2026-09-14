import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PLACEMENTS, SCENARIOS, buildScript } from "./scenarios.mjs";
import { evaluateGates } from "./oracles.mjs";
import { MODEL_LANES, RUN_LIMITS, SCHEDULE_POLICY, buildPrivateEvidence, deriveSeed, executeRun, pinEnvironment, planRuns, qualificationStatus, resolveRunModels, runLabel, safeRetrieval, safeUsage, selectRerunScope } from "./runner.mjs";
import { netInputChangeOf, responseUsage } from "./session.mjs";

// These tests exercise the runner's public boundary with returned native-run
// shapes. They do not simulate an AgentSession or a provider.
{
  const runs = planRuns();
  assert.equal(runs.length, 24);
  assert.equal(runs.filter((run) => run.lane === "sonnet").length, 12);
  assert.equal(runs.filter((run) => run.lane === "glm").length, 12);
  for (const scenario of SCENARIOS) {
    assert.deepEqual(runs.filter((run) => run.scenario === scenario.id && run.lane === "sonnet").map((run) => run.placement), PLACEMENTS);
    assert.deepEqual(runs.filter((run) => run.scenario === scenario.id && run.lane === "glm").map((run) => run.placement), PLACEMENTS);
  }
  assert.deepEqual(runs.map((run) => run.seed), planRuns().map((run) => run.seed));
  assert.equal(new Set(runs.map((run) => run.seed)).size, 12);
  assert.deepEqual(runs[0].model, MODEL_LANES.sonnet);
  assert.deepEqual(runs.at(-1).model, MODEL_LANES.glm);
  assert.equal(RUN_LIMITS.requests, 80);
}

{
  const run = planRuns()[0];
  const result = await executeRun({
    run,
    runtime: null,
    sessionRunner: async () => ({ integrity: { ok: false, failures: ["native JSONL was replaced"] }, coverage: { ok: false, failures: ["raw source appeared"], memoryStates: 0, appends: 0, rebuilds: 0 } }),
  });
  assert.equal(result.score.result, "inconclusive", "integrity or coverage failure reaches the oracle as inconclusive");
  assert.equal(result.error, null, "a valid terminal native result is not an execution exception");
  assert.ok(result.score.failures.some((failure) => failure.code === "integrity"));
}

{
  const run = planRuns()[0];
  const result = await executeRun({ run, runtime: null, sessionRunner: async () => { throw new Error("Pi request deadline exceeded"); } });
  assert.equal(result.score.result, "inconclusive");
  assert.equal(result.error, "native-session-timeout");
  assert.equal(result.diagnostic.kind, "error");
  assert.equal(result.terminal, "timeout");
  assert.equal(result.integrity.ok, false);
}

{
  const hashes = ["a", "b"];
  const compressions = [{ id: "state-new", phase: "work", request: 2, carrierHashes: hashes }];
  const requests = [{ input: 100 }, { input: 80 }, { input: 70 }, { input: 50 }];
  const observations = [
    { memoryId: "state-old", request: 1, carriers: 1, parts: hashes },
    { memoryId: "state-new", request: 2, carriers: 1, parts: hashes },
    { memoryId: "state-new", request: 3, carriers: 2, parts: hashes },
    { memoryId: "state-new", request: 3, carriers: 1, parts: ["wrong", "hashes"] },
    { memoryId: "state-new", request: 4, carriers: 1, parts: hashes },
  ];
  assert.equal(netInputChangeOf(compressions, observations, requests), -20,
    "input change uses the first later unique carrier with the recorded state identity");
}

{
  const run = planRuns()[0];
  const result = await executeRun({ run, runtime: null, sessionRunner: async () => ({
    timedOut: true, integrity: { ok: false, failures: ["prompt-timeout"] }, coverage: { ok: false, failures: ["incomplete"] },
  }) });
  assert.equal(result.terminal, "timeout", "native prompt deadline remains a distinct terminal category");
}

{
  const run = planRuns()[0];
  const result = await executeRun({ run, runtime: null, sessionRunner: async () => ({
    providerError: true, integrity: { ok: false, failures: ["provider-response-error"] }, coverage: { ok: false, failures: ["incomplete"] },
  }) });
  assert.equal(result.terminal, "error", "native provider error responses remain a distinct terminal category");
}

{
  const actual = new Map(Object.entries(MODEL_LANES).map(([arm, pin]) => [arm, { ...pin, api: `${arm}-native-api` }]));
  const runtime = {
    getModel(provider, id) { return [...actual.values()].find((model) => model.provider === provider && model.id === id); },
    hasConfiguredAuth() { return false; },
    async getAuth(model) { return { auth: { apiKey: `${model.provider}-key`, headers: { Authorization: `${model.provider}-header` } } }; },
  };
  const resolved = await resolveRunModels(runtime);
  assert.equal(resolved.modelRuntime, runtime);
  assert.equal(resolved.models.get("sonnet").api, "sonnet-native-api");
  assert.ok(resolved.exactSecrets.includes("ccr-claude-key"));
  assert.ok(resolved.exactSecrets.includes("cpa-header"));
  await assert.rejects(() => resolveRunModels({ ...runtime, getModel: () => undefined }), /does not define/);
}

{
  assert.deepEqual(safeUsage([{ phase: "final", request: 3, stopReason: "toolUse", input: 7, output: 8, cacheRead: 9, cacheWrite: 10, tools: ["read", "write"], activeTools: ["read_memory_source"] }]), [{ phase: "final", request: 3, stopReason: "toolUse", input: 7, output: 8, cacheRead: 9, cacheWrite: 10, tools: ["read", "write"], activeTools: ["read_memory_source"], errorPresent: false }]);
  assert.equal(safeUsage(Array.from({ length: 81 }, (_, request) => ({ request }))).length, RUN_LIMITS.requests);
  const retrieval = safeRetrieval({ qualified: true, code: "qualified-search-snippet", rawView: "sv1-secret", sourceId: "native-source-id", proof: [{
    kind: "search", resultSha256: "a".repeat(64), viewSha256: "b".repeat(64), observedAtRequest: 81,
    returnedBytes: 123, coveredFields: ["recovery-token"], rawSnippet: "SOURCE-EMBER-47", callId: "native-call-id",
  }] });
  const publicJson = JSON.stringify({ requests: safeUsage(Array.from({ length: 81 }, (_, request) => ({ request }))), retrieval });
  assert.equal(retrieval.proof.length, 1, "positive proof remains outside the clipped request list");
  assert.ok(!publicJson.includes("SOURCE-EMBER-47") && !publicJson.includes("native-call-id")
    && !publicJson.includes("native-source-id") && !publicJson.includes("sv1-secret"), "normal report metadata omits source bodies and native identities");
}

{
  const anthropic = await import("@earendil-works/pi-ai/api/anthropic-messages");
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  async function adaptedUsage(rawUsage) {
    const body = [
      sse("message_start", { type: "message_start", message: { id: "native-cache-test", usage: { input_tokens: 12, output_tokens: 1, ...rawUsage } } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
    const client = { messages: { create: () => ({ asResponse: async () => new Response(body, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }) }) } };
    const model = { id: "cache-test", provider: "anthropic", api: "anthropic-messages", maxTokens: 100,
      contextWindow: 10_000, input: ["text"], baseUrl: "http://unused.invalid",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {}, headers: {} };
    let message;
    for await (const event of anthropic.stream(model, {
      systemPrompt: "system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
    }, { client, maxTokens: 10 })) if (event.type === "done") message = event.message;
    return message;
  }
  const omitted = await adaptedUsage({});
  assert.deepEqual({ cacheRead: omitted.usage.cacheRead, cacheWrite: omitted.usage.cacheWrite }, { cacheRead: 0, cacheWrite: 0 },
    "the pinned native adapter normalizes omitted raw cache fields to zero");
  assert.deepEqual(responseUsage(omitted, "final", 1, []).cacheRead, null,
    "an adapter-normalized zero remains unknown in continuity reports");
  assert.equal(responseUsage(omitted, "final", 1, []).cacheWrite, null);
  const positive = await adaptedUsage({ cache_read_input_tokens: 7, cache_creation_input_tokens: 3 });
  assert.deepEqual({ cacheRead: responseUsage(positive, "final", 1, []).cacheRead,
    cacheWrite: responseUsage(positive, "final", 1, []).cacheWrite }, { cacheRead: 7, cacheWrite: 3 },
  "positive native cache measurements remain distinct from unknown normalized zeroes");
  const failed = responseUsage({ ...omitted, api: "openai-completions", stopReason: "error", errorMessage: "429 private provider body" }, "final", 2, []);
  assert.deepEqual([failed.diagnostic.kind, failed.diagnostic.status, failed.diagnostic.reason], ["provider-http", 429, "rate-limited"]);
  assert.equal(JSON.stringify(safeUsage([failed])).includes("private provider body"), false);

  const openai = await import("@earendil-works/pi-ai/api/openai-completions");
  const chunks = [
    { id: "native-cache-test", object: "chat.completion.chunk", created: 1, model: "cache-test",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { id: "native-cache-test", object: "chat.completion.chunk", created: 1, model: "cache-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
  ];
  const fetch = async () => new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
  const openaiModel = { id: "cache-test", provider: "openai", api: "openai-completions", maxTokens: 100,
    contextWindow: 10_000, input: ["text"], baseUrl: "http://unused.invalid",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {}, headers: {} };
  let openaiMessage;
  for await (const event of openai.stream(openaiModel, {
    systemPrompt: "system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
  }, { apiKey: "synthetic-key", fetch, maxTokens: 10 })) if (event.type === "done") openaiMessage = event.message;
  assert.deepEqual({ cacheRead: openaiMessage.usage.cacheRead, cacheWrite: openaiMessage.usage.cacheWrite }, { cacheRead: 0, cacheWrite: 0 },
    "the pinned OpenAI-compatible adapter also normalizes omitted raw cache fields to zero");
  assert.deepEqual({ cacheRead: responseUsage(openaiMessage, "final", 1, []).cacheRead,
    cacheWrite: responseUsage(openaiMessage, "final", 1, []).cacheWrite }, { cacheRead: null, cacheWrite: null },
  "independent provider conventions remain unknown when their raw cache fields are absent");
}

{
  const run = planRuns()[0];
  const evidence = buildPrivateEvidence([
    { run, result: { evidence: { entries: [{ type: "message", text: "safe" }] }, integrity: { failures: [] } }, integrity: { failures: [] } },
    { run: planRuns()[1], result: null, integrity: { failures: ["driver stopped"] }, error: "driver stopped" },
  ], { attemptId: "attempt-1", pins: "pins-1" });
  assert.equal(evidence.complete, false);
  assert.equal(evidence.evidence.runs.length, 2);
  assert.equal(evidence.evidence.runs[1].missing, "driver stopped");
  assert.equal(evidence.sha256.length, 64);
}

{
  const secret = "raw-provider-key";
  const evidence = buildPrivateEvidence([{ run: planRuns()[0], result: { evidence: { [secret]: secret } }, integrity: { failures: [] } }], { attemptId: "attempt-2", pins: "pins-2", exactSecrets: [secret] });
  assert.ok(!evidence.text.includes(secret), "exact credentials are redacted from evidence keys and values");
  assert.equal(evidence.sha256, createHash("sha256").update(evidence.text).digest("hex"), "evidence hash covers exactly the persisted newline-terminated bytes");
}

{
  const result = await executeRun({ run: planRuns()[0], runtime: null, sessionRunner: async () => { throw new Error("Authorization: Bearer secret-value"); } });
  assert.equal(result.score.result, "inconclusive");
  assert.equal(result.error, "native-session-error");
  assert.ok(!JSON.stringify(result.diagnostic).includes("secret-value"), "public diagnostics never retain exception bodies");
}

{
  const pins = pinEnvironment();
  assert.equal(typeof pins.commit, "string");
  assert.equal(typeof pins.tree, "string");
  assert.equal(typeof pins.digest, "string");
  assert.equal(pins.sessionConfig.contextWindow, 100_000);
  assert.equal(pins.sessionConfig.maxTokens, 4_096);
  assert.equal(pins.sessionConfig.keepRecentTokens, 200);
  assert.equal(pins.sessionConfig.maxRequests, 80);
  assert.deepEqual(pins.executionConfig.finalDisabledTools, ["bash"]);
}

{
  assert.equal(selectRerunScope({ kind: "ui" }).runs.length, 0);
  assert.equal(selectRerunScope({ kind: "documentation" }).runs.length, 0);
  assert.equal(selectRerunScope({ kind: "provider", lanes: ["sonnet"] }).runs.length, 12);
  assert.equal(selectRerunScope({ kind: "defect", scenarios: [SCENARIOS[0].id] }).runs.length, 6);
  assert.equal(selectRerunScope({ kind: "unknown" }).runs.length, 24);
  assert.equal(runLabel(planRuns()[0]), `${SCENARIOS[0].id}/early/sonnet/search-enabled`);
  assert.equal(deriveSeed(planRuns()[0]).length, 16);
}

// The report must respect aggregate recall tolerances, not require every
// noncanonical handoff field to pass. Evidence completeness is independent.
{
  const records = [];
  for (const run of planRuns()) {
    const script = buildScript(run.scenario, run.placement);
    const artifact = { ...script.oracle.expected };
    if (run.scenario === "exact-work" && run.placement === "early" && run.lane === "sonnet") artifact.owner = null;
    records.push(await executeRun({ run, sessionRunner: async () => ({
      artifactText: JSON.stringify(artifact), integrity: { ok: true, failures: [] },
      coverage: { ok: true, failures: [], appends: 1, rebuilds: 2 },
      retrievalQualification: { qualified: true, code: "qualified-search-snippet" },
    }) }));
  }
  const gates = evaluateGates(records.map((record) => record.score));
  assert.equal(records[0].score.result, "fail");
  assert.equal(gates.result, "pass");
  assert.equal(qualificationStatus(records, gates, { complete: true }).machineStatus, "pass-needs-human-review");
  assert.equal(qualificationStatus(records, gates, null).machineStatus, "inconclusive-needs-human-review");
  records[0].coverage.ok = false;
  assert.equal(qualificationStatus(records, gates, { complete: true }).machineStatus, "inconclusive-needs-human-review");
}

// The seeded schedule is a gate, not a courtesy: a matrix whose runs never
// reached two suffix rebuilds cannot pass, even with perfect artifacts (#325).
{
  assert.equal(SCHEDULE_POLICY.seededRenderedTokens, SCHEDULE_POLICY.halfBudgetTokens, "the seed renders at exactly half the budget");
  assert.equal(SCHEDULE_POLICY.requiredAppends, 1);
  assert.equal(SCHEDULE_POLICY.requiredRebuilds, 2);
  const records = [];
  for (const run of planRuns()) {
    const script = buildScript(run.scenario, run.placement);
    records.push(await executeRun({ run, sessionRunner: async () => ({
      artifactText: JSON.stringify(script.oracle.expected), integrity: { ok: true, failures: [] },
      coverage: { ok: true, failures: [], appends: 1, rebuilds: 1 },
      retrievalQualification: { qualified: true, code: "qualified-search-snippet" },
    }) }));
  }
  const gates = evaluateGates(records.map((record) => record.score));
  assert.equal(gates.gates.scheduleOk, false);
  assert.equal(gates.result, "fail");
  assert.notEqual(gates.result, "pass", "an incomplete compression schedule blocks the machine pass");
}

console.log("continuity native runner: all checks passed");
