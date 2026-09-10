import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PRIMARY_ARM_VARIANTS, SCENARIOS, buildScript } from "./scenarios.mjs";
import { evaluateGates } from "./oracles.mjs";
import { MODEL_LANES, RUN_LIMITS, buildPrivateEvidence, deriveSeed, executeRun, pinEnvironment, planRuns, qualificationStatus, resolveRunModels, runLabel, safeUsage, selectRerunScope } from "./runner.mjs";

// These tests exercise the runner's public boundary with returned native-run
// shapes. They do not simulate an AgentSession or a provider.
{
  const runs = planRuns();
  assert.equal(runs.length, 16);
  assert.equal(runs.filter((run) => run.arm === "primary").length, 12);
  assert.equal(runs.filter((run) => run.arm === "secondary").length, 4);
  for (const scenario of SCENARIOS) {
    assert.deepEqual(runs.filter((run) => run.scenario === scenario.id && run.arm === "primary").map((run) => run.variant), PRIMARY_ARM_VARIANTS);
    assert.deepEqual(runs.filter((run) => run.scenario === scenario.id && run.arm === "secondary").map((run) => run.variant), ["canonical"]);
  }
  assert.deepEqual(runs.map((run) => run.seed), planRuns().map((run) => run.seed));
  assert.equal(new Set(runs.map((run) => run.seed)).size, 16);
  assert.deepEqual(runs[0].model, MODEL_LANES.primary);
  assert.deepEqual(runs.at(-1).model, MODEL_LANES.secondary);
  assert.equal(RUN_LIMITS.requests, 80);
}

{
  const run = planRuns()[0];
  const result = await executeRun({
    run,
    runtime: null,
    sessionRunner: async () => ({ integrity: { ok: false, failures: ["native JSONL was replaced"] }, coverage: { ok: false, failures: ["raw source appeared"], compactions: 0, appends: 0, rebuilds: 0 } }),
  });
  assert.equal(result.score.result, "inconclusive", "integrity or coverage failure reaches the oracle as inconclusive");
  assert.equal(result.error, null, "a valid terminal native result is not an execution exception");
  assert.ok(result.score.failures.some((failure) => failure.code === "integrity"));
}

{
  const run = planRuns()[0];
  const result = await executeRun({ run, runtime: null, sessionRunner: async () => { throw new Error("Pi request deadline exceeded"); } });
  assert.equal(result.score.result, "inconclusive");
  assert.match(result.error, /deadline/);
  assert.equal(result.integrity.ok, false);
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
  assert.equal(resolved.models.get("primary").api, "primary-native-api");
  assert.ok(resolved.exactSecrets.includes("ccr-claude-key"));
  assert.ok(resolved.exactSecrets.includes("cpa-header"));
  await assert.rejects(() => resolveRunModels({ ...runtime, getModel: () => undefined }), /does not define/);
}

{
  assert.deepEqual(safeUsage([{ phase: "final", request: 3, stopReason: "toolUse", input: 7, output: 8, cacheRead: 9, cacheWrite: 10, tools: ["read", "write"] }]), [{ phase: "final", request: 3, stopReason: "toolUse", input: 7, output: 8, cacheRead: 9, cacheWrite: 10, tools: ["read", "write"] }]);
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
  assert.ok(!result.error.includes("secret-value"), "public errors pass through the shared credential cleaner");
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
}

{
  assert.equal(selectRerunScope({ kind: "ui" }).runs.length, 0);
  assert.equal(selectRerunScope({ kind: "documentation" }).runs.length, 0);
  assert.equal(selectRerunScope({ kind: "provider", arms: ["primary"] }).runs.length, 12);
  assert.equal(selectRerunScope({ kind: "defect", scenarios: [SCENARIOS[0].id] }).runs.length, 4);
  assert.equal(selectRerunScope({ kind: "unknown" }).runs.length, 16);
  assert.equal(runLabel(planRuns()[0]), `${SCENARIOS[0].id}/early/primary`);
  assert.equal(deriveSeed(planRuns()[0]).length, 16);
}

// The report must respect aggregate recall tolerances, not require every
// noncanonical handoff field to pass. Evidence completeness is independent.
{
  const records = [];
  for (const run of planRuns()) {
    const script = buildScript(run.scenario, run.variant);
    const artifact = { ...script.oracle.expected };
    if (run.scenario === "exact-work" && run.variant === "early") artifact.owner = null;
    records.push(await executeRun({ run, sessionRunner: async () => ({
      artifactText: JSON.stringify(artifact), integrity: { ok: true, failures: [] }, coverage: { ok: true, failures: [] },
      sourceReads: [{ ok: true, complete: true, coversSource: true }],
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

console.log("continuity native runner: all checks passed");
