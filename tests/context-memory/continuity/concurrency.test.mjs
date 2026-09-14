import assert from "node:assert/strict";
import { thinkingConfiguration } from "../thinking.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HISTORICAL_REPORT_SCHEMA, MODEL_LANES, REPORT_SCHEMA, VERIFIED_OFF_THINKING_REPORT_SCHEMA, buildPairs, buildRecoveryPairs, parseQualificationReport, planCases, planRecoveryRuns, planRuns, qualificationStatus, runModelQueues } from "./runner.mjs";
import { buildScript } from "./scenarios.mjs";
import { runContinuitySession } from "./session.mjs";

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
      if (run.lane === "grok" && run.caseKey === cases[1].caseKey) throw new Error("isolated timeout");
      return { artifactText: "{}", integrity: { ok: false, failures: ["fixture"] }, coverage: { ok: false, failures: ["fixture"] } };
    },
  });
  assert.equal(records.length, 24);
  assert.equal(records.find((record) => record.run.lane === "grok" && record.run.caseKey === cases[1].caseKey)?.terminal, "timeout");
  assert.ok(seen.includes(`grok:${cases.at(-1).caseKey}`), "a failed cell does not stop later cells in its lane");
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

// Two real AgentSessions must overlap at the provider boundary, with distinct
// native configuration, workspace, session, capture, and tool-capability state.
{
  const runtimeRoot = mkdtempSync(join(tmpdir(), "continuity-native-overlap-"));
  writeFileSync(join(runtimeRoot, "auth.json"), "{}\n");
  try {
    const runtime = await ModelRuntime.create({ authPath: join(runtimeRoot, "auth.json"), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false });
    const firstBarrier = deferred();
    const release = deferred();
    const providerCaptures = new Map();
    const nativeCaptures = new Map();
    const configPaths = new Map();
    const controllers = new Map([["grok", new AbortController()], ["glm", new AbortController()]]);
    const canaries = { grok: "NATIVE-GROK-CANARY", glm: "NATIVE-GLM-CANARY" };
    const requestText = (messages) => JSON.stringify(messages);

    function providerFor(lane) {
      const provider = fauxProvider({ provider: `continuity-overlap-${lane}`, api: `continuity-overlap-${lane}`,
        models: [{ id: `native-${lane}`, contextWindow: 100_000, maxTokens: 4096 }] });
      Object.assign(provider.getModel(), { reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" } });
      provider.setResponses([async (context, options) => {
        providerCaptures.set(lane, { messages: structuredClone(context.messages),
          tools: context.tools.map((tool) => tool.name), sessionId: options?.sessionId ?? null });
        if (providerCaptures.size === 2) firstBarrier.resolve();
        await release.promise;
        return fauxAssistantMessage("interrupted after native overlap proof");
      }]);
      runtime.registerNativeProvider(provider.provider);
      return provider;
    }

    const providers = { grok: providerFor("grok"), glm: providerFor("glm") };
    const runs = {
      grok: { scenario: "source-recovery", placement: "early", lane: "grok", retrievalArm: "search-enabled" },
      glm: { scenario: "source-recovery", placement: "early", lane: "glm", retrievalArm: "read-only" },
    };
    const executions = Object.keys(runs).map((lane) => {
      const base = buildScript("source-recovery", "early");
      const script = { ...base, setupFiles: { ...base.setupFiles, "lane-canary.txt": `${canaries[lane]}\n` },
        introPrompt: `${base.introPrompt}\n${canaries[lane]}` };
      return runContinuitySession({ packageRoot: process.cwd(), modelRuntime: runtime, model: providers[lane].getModel(),
        script, run: runs[lane], signal: controllers.get(lane).signal,
        contextModifierFactory(pi, { sessionManager }) {
          const bucket = [];
          nativeCaptures.set(lane, { bucket, sessionManager });
          pi.on("context", (event) => {
            bucket.push({ cwd: sessionManager.getCwd(), sessionId: sessionManager.getSessionId(),
              activeTools: pi.getActiveTools(), messages: structuredClone(event.messages) });
          });
        },
      });
    });

    await Promise.race([
      firstBarrier.promise,
      Promise.allSettled(executions).then((settled) => { throw new Error(`native sessions settled before overlap: ${JSON.stringify(settled)}`); }),
    ]);
    assert.equal(providerCaptures.size, 2, "both real AgentSession requests reach the provider before either is released");
    const grokNative = nativeCaptures.get("grok");
    const glmNative = nativeCaptures.get("glm");
    assert.notEqual(grokNative.sessionManager, glmNative.sessionManager, "native session managers are distinct objects");
    assert.notEqual(grokNative.bucket, glmNative.bucket, "mutable context capture buckets are not shared");
    const grokView = grokNative.bucket[0];
    const glmView = glmNative.bucket[0];
    assert.notEqual(grokView.cwd, glmView.cwd);
    assert.notEqual(grokView.sessionId, glmView.sessionId);
    assert.equal(providerCaptures.get("grok").sessionId, grokView.sessionId);
    assert.equal(providerCaptures.get("glm").sessionId, glmView.sessionId);
    for (const lane of Object.keys(runs)) {
      const own = nativeCaptures.get(lane).bucket[0];
      const other = lane === "grok" ? "glm" : "grok";
      assert.equal(readFileSync(join(own.cwd, "lane-canary.txt"), "utf8"), `${canaries[lane]}\n`);
      assert.ok(requestText(providerCaptures.get(lane).messages).includes(canaries[lane]));
      assert.ok(!requestText(providerCaptures.get(lane).messages).includes(canaries[other]), "provider evidence never crosses cells");
      const configPath = join(dirname(own.cwd), "agent", "config", "pi-square.json");
      configPaths.set(lane, configPath);
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).contextMemory.enabled, true);
      const tools = providerCaptures.get(lane).tools;
      for (const name of ["bash", "write", "compact_to_memory_block", "read_memory_source"]) assert.ok(tools.includes(name), `${lane} has ${name}`);
      assert.equal(tools.includes("search_memory_source"), lane === "grok", "retrieval capability stays cell-local");
    }
    assert.notEqual(configPaths.get("grok"), configPaths.get("glm"), "native agent configuration files are distinct");
    for (const controller of controllers.values()) controller.abort();
    release.resolve();
    const results = await Promise.all(executions);
    assert.ok(results.every((result) => result.cancelled && result.requests.length <= 1));
    for (const identity of ["root", "agentConfig", "workspace", "session", "capture"]) {
      assert.notEqual(results[0].isolation[identity], results[1].isolation[identity], `native ${identity} identities remain isolated`);
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

{
  const runs = planRuns();
  const left = { run: runs.find((run) => run.lane === "grok"), terminal: "success",
    result: { requests: [{ input: 100, cacheRead: 3, cacheWrite: 2 }], phaseLatency: [{ ms: 20 }],
      retrievalQualification: { searches: 1, targetedReads: 0, pageReads: 1, returnedEvidenceBytes: 50 } },
    score: { fields: [] }, integrity: {}, coverage: { appends: 1, rebuilds: 2 } };
  const rightRun = runs.find((run) => run.lane === "glm" && run.caseKey === left.run.caseKey);
  const right = { ...left, run: rightRun, result: { requests: [{ input: 120, cacheRead: 8, cacheWrite: 4 }], phaseLatency: [{ ms: 30 }],
    retrievalQualification: { searches: 3, targetedReads: 1, pageReads: 2, returnedEvidenceBytes: 70 } },
  coverage: { appends: 2, rebuilds: 4 } };
  const pairs = buildPairs([left, right]);
  assert.equal(pairs.length, 12);
  assert.deepEqual(pairs[0].differences, {
    direction: "glm-minus-grok", inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2,
    searches: 2, targetedReads: 1, pageReads: 1, elapsedMs: 10, returnedEvidenceBytes: 20,
    appends: 1, rebuilds: 2,
  });
  assert.equal(pairs.filter((pair) => pair.grok === null || pair.glm === null).length, 11, "missing sides remain explicit");
  right.result.requests[0].cacheWrite = null;
  assert.equal(buildPairs([left, right])[0].differences.cacheWriteTokens, null, "missing usage never becomes zero");
}

{
  const [enabledRun, readOnlyRun] = (() => {
    const planned = planRecoveryRuns().filter((run) => run.lane === "grok" && run.placement === "early");
    return [planned.find((run) => run.retrievalArm === "search-enabled"), planned.find((run) => run.retrievalArm === "read-only")];
  })();
  const record = (run, values) => ({ run, terminal: "pass", result: { requests: [values.usage], phaseLatency: [{ ms: values.elapsed }],
    retrievalQualification: values.retrieval }, score: { fields: [] }, integrity: {}, coverage: values.coverage });
  const pairs = buildRecoveryPairs([
    record(enabledRun, { usage: { input: 90, cacheRead: 6, cacheWrite: 4 }, elapsed: 40,
      retrieval: { searches: 2, targetedReads: 1, pageReads: 1, returnedEvidenceBytes: 80 }, coverage: { appends: 2, rebuilds: 3 } }),
    record(readOnlyRun, { usage: { input: 100, cacheRead: 2, cacheWrite: null }, elapsed: 50,
      retrieval: { searches: 0, targetedReads: 0, pageReads: 2, returnedEvidenceBytes: 120 }, coverage: { appends: 1, rebuilds: 2 } }),
  ]);
  assert.deepEqual(pairs[0].differences, {
    direction: "search-enabled-minus-read-only", inputTokens: -10, cacheReadTokens: 4, cacheWriteTokens: null,
    searches: 2, targetedReads: 1, pageReads: -1, elapsedMs: -10, returnedEvidenceBytes: -40,
    appends: 1, rebuilds: 1,
  });
}

{
  const historical = parseQualificationReport({ schema: HISTORICAL_REPORT_SCHEMA, runs: Array.from({ length: 16 }, () => ({})) });
  assert.equal(historical.kind, "historical-16-cell-asymmetric");
  assert.equal(historical.currentQualification, false);
  const old24 = parseQualificationReport({ schema: "pi-square.context-memory/continuity-qualification/3", completeness: { expected: 24 } });
  assert.equal(old24.currentQualification, false, "old requested-only thinking pins never qualify as verified settings");
  const verifiedOff = parseQualificationReport({ schema: VERIFIED_OFF_THINKING_REPORT_SCHEMA, completeness: { expected: 24 } });
  assert.equal(verifiedOff.kind, "historical-24-cell-off-thinking");
  assert.equal(verifiedOff.currentQualification, false, "the prior off experiment is never relabeled as the current per-lane experiment");
  const historicalLow = parseQualificationReport({ schema: "pi-square.context-memory/continuity-qualification/5" });
  assert.equal(historicalLow.kind, "historical-24-cell-low-thinking");
  assert.equal(historicalLow.currentQualification, false);
  assert.throws(() => parseQualificationReport({ schema: REPORT_SCHEMA, completeness: { expected: 24 } }), /verified thinking pins/);
  const model = { reasoning: true, thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", high: "high", max: "max" } };
  assert.equal(thinkingConfiguration(model).requested, "low", "the separate cache experiment keeps its default level");
  const pins = { models: {
    grok: { provider: "cpa", id: "grok-4.6" }, glm: { provider: "cpa", id: "glm-5.3-flash" },
  }, modelThinking: {
    grok: thinkingConfiguration(model, "high"), glm: thinkingConfiguration(model, "max"),
  } };
  const report = { schema: REPORT_SCHEMA, completeness: { expected: 24 }, pins,
    runs: planRuns().map((run) => ({ run: `${run.scenario}/${run.placement}/${run.lane}/${run.retrievalArm}`, lane: run.lane,
      model: { provider: MODEL_LANES[run.lane].provider, id: MODEL_LANES[run.lane].id },
      thinking: { ...pins.modelThinking[run.lane], session: pins.modelThinking[run.lane].requested } })) };
  assert.equal(parseQualificationReport(report).currentQualification, true);
  for (const runs of [[], report.runs.slice(1), [...report.runs.slice(1), report.runs[1]]]) {
    assert.equal(parseQualificationReport({ ...report, runs }).currentQualification, false, "every expected cell needs observed settings");
  }
  for (const thinking of [null, { ...report.runs[0].thinking, session: undefined },
    { ...report.runs[0].thinking, session: "off" }, { ...report.runs[0].thinking, mappingSha256: "b".repeat(64) }]) {
    const runs = [{ ...report.runs[0], thinking }, ...report.runs.slice(1)];
    assert.equal(parseQualificationReport({ ...report, runs }).currentQualification, false, "actual session settings must match their model pin");
  }
  const wrongModel = { ...report, runs: [{ ...report.runs[0], model: { provider: "cpa", id: "wrong" } }, ...report.runs.slice(1)] };
  assert.equal(parseQualificationReport(wrongModel).currentQualification, false, "every run records its chosen lane model identity");
  assert.throws(() => parseQualificationReport({ ...report, pins: { ...pins, models: { ...pins.models, grok: { provider: "cpa", id: "wrong" } } } }),
    /verified thinking pins/, "the report-level model pin must match its chosen lane");
  assert.throws(() => parseQualificationReport({ schema: "unknown" }), /unsupported continuity report schema/);
}

console.log("continuity concurrency: OK");
