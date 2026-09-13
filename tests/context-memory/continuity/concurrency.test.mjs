import assert from "node:assert/strict";
import { HISTORICAL_REPORT_SCHEMA, MODEL_LANES, REPORT_SCHEMA, buildPairs, buildRecoveryPairs, parseQualificationReport, planCases, planRecoveryRuns, planRuns, qualificationStatus, runModelQueues } from "./runner.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

{
  const recovery = planRecoveryRuns();
  assert.equal(recovery.length, 12);
  assert.equal(recovery.filter((run) => run.retrievalArm === "search-enabled").length, 6);
  assert.equal(recovery.filter((run) => run.retrievalArm === "read-only").length, 6);
  for (const lane of Object.keys(MODEL_LANES)) {
    for (const placement of ["early", "middle", "late"]) {
      const arms = recovery.filter((run) => run.lane === lane && run.placement === placement);
      assert.equal(arms.length, 2);
      assert.equal(arms[0].seed, arms[1].seed);
      assert.equal(arms[0].scriptDigest, arms[1].scriptDigest);
      assert.equal(arms[0].evaluationDigest, arms[1].evaluationDigest);
    }
  }
  assert.equal(buildRecoveryPairs([]).length, 6);
}

const cases = planCases();
assert.equal(cases.length, 12);
assert.equal(planRuns().length, 24);
assert.equal(new Set(cases.map((entry) => entry.seed)).size, 12);
for (const entry of cases) {
  const counterparts = planRuns().filter((run) => run.caseKey === entry.caseKey);
  assert.equal(counterparts.length, 2);
  assert.equal(counterparts[0].seed, counterparts[1].seed);
  assert.equal(counterparts[0].scriptDigest, counterparts[1].scriptDigest);
  assert.equal(counterparts[0].evaluationDigest, counterparts[1].evaluationDigest);
}

{
  const arrived = new Set();
  const firstBarrier = deferred();
  const release = deferred();
  const active = new Map();
  const maxActive = new Map();
  const order = new Map();
  const result = runModelQueues({
    plannedRuns: planRuns(),
    models: new Map(Object.entries(MODEL_LANES)),
    runtime: null,
    sessionRunner: async ({ run }) => {
      const count = (active.get(run.lane) ?? 0) + 1;
      active.set(run.lane, count);
      maxActive.set(run.lane, Math.max(maxActive.get(run.lane) ?? 0, count));
      order.set(run.lane, [...(order.get(run.lane) ?? []), run.caseKey]);
      if ((order.get(run.lane)?.length ?? 0) === 1) {
        arrived.add(run.lane);
        if (arrived.size === 2) firstBarrier.resolve();
        await release.promise;
      }
      active.set(run.lane, count - 1);
      return { artifactText: "{}", integrity: { ok: false, failures: ["fixture"] }, coverage: { ok: false, failures: ["fixture"] },
        isolation: Object.fromEntries(["root", "agentConfig", "workspace", "session", "capture"]
          .map((identity) => [identity, `${identity}:${run.lane}:${run.caseKey}`])) };
    },
  });
  await firstBarrier.promise;
  assert.deepEqual([...arrived].sort(), Object.keys(MODEL_LANES).sort(), "both model queues overlap before either is released");
  release.resolve();
  const records = await result;
  assert.equal(records.length, 24);
  for (const lane of Object.keys(MODEL_LANES)) {
    assert.equal(maxActive.get(lane), 1, `${lane} stays sequential`);
    assert.deepEqual(order.get(lane), cases.map((entry) => entry.caseKey));
  }
  for (const identity of ["root", "agentConfig", "workspace", "session", "capture"]) {
    assert.equal(new Set(records.map((record) => record.result.isolation[identity])).size, 24,
      `all 24 cells preserve a distinct ${identity} identity`);
  }
}

{
  const seen = [];
  const records = await runModelQueues({
    plannedRuns: planRuns(),
    models: new Map(Object.entries(MODEL_LANES)),
    runtime: null,
    sessionRunner: async ({ run }) => {
      seen.push(`${run.lane}:${run.caseKey}`);
      if (run.lane === "sonnet" && run.caseKey === cases[1].caseKey) throw new Error("isolated timeout");
      return { artifactText: "{}", integrity: { ok: false, failures: ["fixture"] }, coverage: { ok: false, failures: ["fixture"] } };
    },
  });
  assert.equal(records.length, 24);
  assert.equal(records.find((record) => record.run.lane === "sonnet" && record.run.caseKey === cases[1].caseKey)?.terminal, "timeout");
  assert.ok(seen.includes(`sonnet:${cases.at(-1).caseKey}`), "a failed cell does not stop later cells in its lane");
  assert.ok(seen.includes(`glm:${cases.at(-1).caseKey}`), "a failed cell does not stop the other lane");
}

{
  const controller = new AbortController();
  let starts = 0;
  const bothStarted = deferred();
  const records = await runModelQueues({
    plannedRuns: planRuns(),
    models: new Map(Object.entries(MODEL_LANES)),
    runtime: null,
    signal: controller.signal,
    sessionRunner: async ({ signal }) => {
      starts += 1;
      if (starts === 2) bothStarted.resolve();
      await bothStarted.promise;
      controller.abort();
      assert.equal(signal.aborted, true);
      return { artifactText: "{}", integrity: { ok: false, failures: ["cancelled"] }, coverage: { ok: false, failures: ["cancelled"] } };
    },
  });
  assert.equal(starts, 2, "only the two active first cells start before cancellation");
  assert.equal(records.filter((record) => record.terminal === "cancelled").length, 2);
  assert.equal(records.filter((record) => record.terminal === "not-attempted").length, 22);
  assert.deepEqual(qualificationStatus(records, { result: "inconclusive" }, { complete: true }), {
    complete: false,
    machineStatus: "inconclusive-needs-human-review",
  }, "a cancelled 24-row report remains complete in shape but cannot become a machine pass");
}

{
  const runs = planRuns();
  const left = { run: runs.find((run) => run.lane === "sonnet"), terminal: "success", result: { requests: [{ input: 100 }], phaseLatency: [{ ms: 20 }], retrievalQualification: { returnedEvidenceBytes: 50 } }, score: { fields: [] }, integrity: {}, coverage: {} };
  const rightRun = runs.find((run) => run.lane === "glm" && run.caseKey === left.run.caseKey);
  const pairs = buildPairs([left, { ...left, run: rightRun, result: { requests: [{ input: null }], phaseLatency: [{ ms: 30 }], retrievalQualification: { returnedEvidenceBytes: 70 } } }]);
  assert.equal(pairs.length, 12);
  assert.equal(pairs[0].differences.inputTokens, null, "missing usage never becomes zero");
  assert.equal(pairs[0].differences.elapsedMs, 10);
  assert.equal(pairs[0].differences.returnedEvidenceBytes, 20);
  assert.equal(pairs.filter((pair) => pair.sonnet === null || pair.glm === null).length, 11, "missing sides remain explicit");
}

{
  const historical = parseQualificationReport({ schema: HISTORICAL_REPORT_SCHEMA, runs: Array.from({ length: 16 }, () => ({})) });
  assert.equal(historical.kind, "historical-16-cell-asymmetric");
  assert.equal(historical.currentQualification, false);
  assert.equal(parseQualificationReport({ schema: REPORT_SCHEMA, completeness: { expected: 24 } }).currentQualification, true);
  assert.throws(() => parseQualificationReport({ schema: "unknown" }), /unsupported continuity report schema/);
}

console.log("continuity concurrency: OK");
