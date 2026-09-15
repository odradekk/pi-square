import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttempt, freezePilot, requireFreeze, runFormal, runPair, taskDigest } from "./runner.mjs";
import { createProgressiveReport, reportMarkdown } from "./qualify.mjs";
import { readEvidence } from "./evidence.mjs";
import { cacheUsageObservation } from "./session.mjs";

const root = mkdtempSync(join(tmpdir(), "progressive-runner-"));
assert.deepEqual(cacheUsageObservation({ cacheRead: 0, cacheWrite: 0 }), { readReported: false, writeReported: false, cacheRead: null, cacheWrite: null });
assert.deepEqual(cacheUsageObservation({ cacheRead: 0, cacheWrite: 0, cacheReported: true }), { readReported: true, writeReported: true, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(cacheUsageObservation({ cacheRead: 7, cacheWrite: 0 }), { readReported: true, writeReported: false, cacheRead: 7, cacheWrite: null });
assert.deepEqual(cacheUsageObservation({ cacheRead: 0, cacheWrite: 3 }), { readReported: false, writeReported: true, cacheRead: null, cacheWrite: 3 });
assert.deepEqual(cacheUsageObservation({ cacheRead: 7, cacheWrite: 3, cacheReported: false }), { readReported: false, writeReported: false, cacheRead: null, cacheWrite: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = arm => ({ arm, status: "passed", stages: Array.from({ length: 8 }, (_, index) => ({ stage: index + 1, passed: true, startedAtMs: index * 100, passedAtMs: index * 100 + 50, ...(arm === "memory" ? { appliedAtMs: index * 100 + 75 } : {}) })),
  recall: { correct: 8, complete: true }, coverage: { stageGates: 8, appends: 1, rebuilds: 2 },
  metrics: { providerErrors: 3, retryScheduled: 3, retryContinuations: 3, retryRecovered: 2, requests: 9, tools: 16, input: 100, output: 20, usageReportedRequests: 9, cacheRead: 5, cacheWrite: 2, cacheReadReportedRequests: 9, cacheWriteReportedRequests: 9, toolBytes: 400,
    toolCategories: { compaction: { count: 3, bytes: 120, elapsedMs: 30 }, retrieval: { count: 2, bytes: 80, elapsedMs: 20 } } },
  elapsedMs: 1234, evidence: { sha256: `${arm}-sha`, bytes: 200, records: 10, file: `/private/${arm}` } });
try {
  const entered = new Set(), bothEntered = deferred(), release = deferred();
  let pairSettled = false;
  const runner = ({ arm }) => {
    entered.add(arm); if (entered.size === 2) bothEntered.resolve();
    if (arm === "native") throw new Error("native synchronous failure");
    return release.promise.then(() => completed(arm));
  };
  const attempt = createAttempt();
  const pairPromise = runPair({ directory: join(root, "pair"), attempt, modelRuntime: {}, model: {}, sessionRunner: runner }).then(value => { pairSettled = true; return value; });
  await bothEntered.promise;
  assert.deepEqual([...entered].sort(), ["memory", "native"]);
  assert.equal(pairSettled, false, "the pair waits for its blocked peer");
  release.resolve();
  const pair = await pairPromise;
  assert.equal(pair.arms.memory.status, "passed"); assert.equal(pair.arms.native.status, "infrastructure-error");
  assert.equal(lstatSync(join(root, "pair", "seed.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "pair", "seed.json"), "utf8")).flags, attempt.flags);
  assert.deepEqual([...readEvidence(pair.journal.file)].filter(record => record.kind === "arm-start").map(record => record.data.arm), ["memory", "native"]);

  let activePairs = 0, maxActivePairs = 0; const pairNumbers = [];
  const formalRunner = async ({ directory, arm }) => {
    const number = Number(directory.match(/pair-(\d+)/)?.[1]);
    if (arm === "memory") { activePairs++; maxActivePairs = Math.max(maxActivePairs, activePairs); pairNumbers.push(number); }
    await Promise.resolve(); if (arm === "native") activePairs--; return completed(arm);
  };
  const formal = await runFormal({ directory: join(root, "formal"), modelRuntime: {}, model: {}, sessionRunner: formalRunner });
  assert.equal(formal.length, 3); assert.deepEqual(pairNumbers, [1, 2, 3]); assert.equal(maxActivePairs, 1);
  assert.equal(new Set(formal.map(value => value.seedDigest)).size, 3);
  await assert.rejects(runFormal({ directory: join(root, "formal") }), /EEXIST/);
  const countOverride = await runFormal({ directory: join(root, "formal-count-override"), count: 1, modelRuntime: {}, model: {}, sessionRunner: async ({ arm }) => completed(arm) });
  assert.equal(countOverride.length, 3, "callers cannot reduce the fixed formal pair count");

  const pins = { commit: "a".repeat(40), tree: "b".repeat(40), progressiveDigest: taskDigest(), node: process.version,
    packageVersion: "12.1.0", piVersion: "0.84.2", model: { provider: "cpa", id: "deepseek-v4.1-flash", api: "test" },
    modelConfigurationSha256: "c".repeat(64), thinking: { requested: "max", generationValue: "high", mapping: { max: "high" } },
    config: { contextWindow: 500000, thinkingLevel: "max", memoryBudgetPercent: 2, timeoutMs: 3600000 } };
  const pilotReport = createProgressiveReport({ kind: "pilot", pairs: [pair], pins });
  const manifestPath = join(root, "freeze.json");
  const manifest = freezePilot({ pilotReport, pins, path: manifestPath });
  assert.deepEqual(requireFreeze(manifestPath, pins), manifest);
  assert.throws(() => freezePilot({ pilotReport: { ...pilotReport, kind: "formal" }, pins, path: join(root, "bad-kind") }), /one-pair/);
  assert.throws(() => freezePilot({ pilotReport: { ...pilotReport, pairs: [pair, pair] }, pins, path: join(root, "bad-count") }), /one-pair/);
  assert.throws(() => freezePilot({ pilotReport, pins: { ...pins, commit: "changed" }, path: join(root, "drift") }), /pins/);
  assert.throws(() => requireFreeze(manifestPath, { ...pins, modelConfigurationSha256: "changed" }), /does not match/);

  assert.throws(() => requireFreeze(manifestPath, { ...pins, config: { ...pins.config, recovery: { initialDelayMs: 1000, maxDelayMs: 30000 } } }), /does not match/);

  const report = createProgressiveReport({ kind: "formal", pairs: formal, manifest, pins });
  assert.equal(report.totals.result, "pass"); assert.equal(report.totals.memoryQualified, 3); assert.equal(report.totals.requests, 54);
  assert.equal(report.totals.cacheReadTokens, 30); assert.deepEqual(report.totals.cacheCoverage, { readReportedRequests: 54, writeReportedRequests: 54, requests: 54 });
  assert.deepEqual(report.pairs[0].arms.memory.evidence, { sha256: "memory-sha", bytes: 200, records: 10 });
  assert.equal("file" in report.pairs[0].arms.memory.evidence, false); assert.equal(report.pairs[0].arms.memory.stagesPassed, 8);
  assert.deepEqual(report.pairs[0].arms.memory.stages[0], { stage: 1, passed: true, startedAtMs: 0, passedAtMs: 50, appliedAtMs: 75 });
  assert.deepEqual(report.pairs[0].arms.memory.metrics.toolCategories.retrieval, { count: 2, bytes: 80, elapsedMs: 20 });
  assert.doesNotMatch(JSON.stringify(report), /\/private\/|flags|independent-test-project-fact/);
  assert.match(reportMarkdown(report), /native failures: 0/);
  for (const key of ["providerErrors", "retryScheduled", "retryContinuations", "retryRecovered"]) {
    assert.equal(report.pairs[0].arms.memory.metrics[key], completed("memory").metrics[key], "successful runs retain upstream failure and recovery counters");
  }
  assert.match(reportMarkdown(report), /Provider errors/);
  const historical = completed("memory"); delete historical.metrics.providerErrors;
  assert.equal(createProgressiveReport({ kind: "pilot", pairs: [{ ...pair, arms: { memory: historical } }], pins }).pairs[0].arms.memory.metrics.providerErrors, null, "missing historical counters remain unknown");
  const failedStage = completed("memory"); failedStage.stages[7] = { stage: 8, passed: false };
  const bad = createProgressiveReport({ kind: "formal", pairs: formal.map((value, index) => index ? value : { ...value, arms: { ...value.arms, memory: failedStage } }), manifest, pins });
  assert.equal(bad.totals.result, "incomplete");
  const missingCache = completed("memory"); missingCache.metrics.cacheWriteReportedRequests = 8;
  const incompleteUsage = createProgressiveReport({ kind: "pilot", pairs: [{ ...pair, arms: { memory: missingCache, native: completed("native") } }], pins });
  assert.equal(incompleteUsage.totals.cacheReadTokens, 10, "complete read coverage retains its total");
  assert.equal(incompleteUsage.totals.cacheWriteTokens, null, "partial write coverage never becomes a zero or partial total");
  assert.equal(incompleteUsage.pairs[0].arms.memory.metrics.cacheWrite, null, "the affected arm also exposes a nullable total");
  assert.deepEqual(incompleteUsage.totals.cacheCoverage, { readReportedRequests: 18, writeReportedRequests: 17, requests: 18 });
  console.log("context-memory progressive runner: all assertions passed");
} finally { rmSync(root, { recursive: true, force: true }); }
