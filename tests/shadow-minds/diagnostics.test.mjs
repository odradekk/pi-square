import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const { createShadowRuntime, isCacheUsageReported } = await load(join(packageRoot, "src", "shadow-minds", "runtime.ts"));
const { SHADOW_COHORT_GROUPS_MAX, summarizeShadowUsage, shadowCohortGroupKey } = await load(
  join(packageRoot, "src", "shadow-minds", "diagnostics.ts"),
);
const { DEFAULT_SHADOW_MINDS } = await load(join(packageRoot, "src", "core", "config.ts"));
const { createShadowScheduler } = await load(join(packageRoot, "src", "shadow-minds", "scheduler.ts"));

// ── Deterministic fake-model harness (#161) ────────────────────────

function definition(overrides = {}) {
  return {
    id: "session-synthesizer",
    name: "Session synthesizer",
    enabled: false,
    hidden: false,
    priority: 0,
    triggers: [],
    triggerInstructions: {},
    delivery: "notify",
    completionGate: false,
    requiredTools: [],
    debug: false,
    outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
    body: "Summarize the trajectory.",
    fieldSources: {},
    layers: [],
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    ...overrides,
    enabled: overrides.enabled ?? true,
    defaults: { ...DEFAULT_SHADOW_MINDS, ...(overrides.defaults ?? {}) },
  };
}

/**
 * Fake provider driver: a scripted list of requests, each a list of events.
 * `usage` on an assistant message_end mirrors one provider report; a report
 * that omits cacheRead/cacheWrite models an adapter without cache support.
 */
function fakeModel(scriptedRequests, { submit } = {}) {
  const created = [];
  const ran = [];
  let clock = 1_000;
  const deps = {
    now: () => clock,
    async createSession(input) {
      created.push(input);
      return { session: { __fake: true, customTools: input.customTools } };
    },
    async runSession(input) {
      ran.push(input);
      for (const request of scriptedRequests) {
        for (const event of request) {
          if (event.__advance) clock += event.__advance;
          input.onEvent?.(event);
        }
      }
      if (submit !== undefined) {
        const tool = input.session.customTools.at(-1);
        await tool.execute("call-1", { payload: submit }, undefined, undefined, { cwd: "/repo" });
      }
      return {
        status: "completed",
        prompted: true,
        timedOut: false,
        finalText: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: scriptedRequests.length },
        streamingCompleted: true,
        messages: [],
      };
    },
  };
  return { deps, created, ran, advance(ms) { clock += ms; } };
}

const turnStart = () => ({ type: "turn_start" });
const assistantStart = { type: "message_start", message: { role: "assistant" } };
const assistantEnd = (usage, api) => ({ type: "message_end", message: { role: "assistant", usage, ...(api ? { api } : {}) } });
const toolStart = { type: "tool_execution_start" };

function baseRequest(overrides = {}) {
  return {
    definition: definition(),
    system: "SHADOW SYSTEM",
    trajectory: { text: "[user] hello", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" },
    cwd: "/repo",
    ...overrides,
  };
}


{
  const normalizedZero = { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 };
  assert.equal(isCacheUsageReported(normalizedZero), false, "normalized zero fields without an explicit marker stay unreported");
  assert.equal(isCacheUsageReported({ ...normalizedZero, cacheRead: 12 }), true, "a non-zero cache value is direct report evidence");
  assert.equal(isCacheUsageReported({ ...normalizedZero, cacheReported: false }), false, "an explicit negative adapter marker wins");
  assert.equal(isCacheUsageReported({ ...normalizedZero, cacheReported: true }), true, "an explicit adapter marker can distinguish a provider-reported zero");
}

{
  // Two requests: the first reports cache values (including a zero write),
  // the second omits cache fields entirely — unreported must stay
  // distinguishable from a provider-reported zero.
  const fake = fakeModel([
    [
      turnStart(),
      { __advance: 120 },
      assistantStart,
      assistantEnd({ input: 100, output: 40, cacheRead: 500, cacheWrite: 0, cost: 0.02 }),
      toolStart,
      toolStart,
    ],
    [
      turnStart(),
      { __advance: 80 },
      assistantStart,
      assistantEnd({ input: 60, output: 10, cost: 0.01 }),
    ],
  ]);
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const view = await runtime.startManualRun(baseRequest()).done;

  assert.equal(view.requests.length, 2, "one metric per model request");
  const [first, second] = view.requests;
  assert.equal(first.turn, 1);
  assert.equal(first.input, 100);
  assert.equal(first.output, 40);
  assert.equal(first.cacheRead, 500);
  assert.equal(first.cacheWrite, 0, "a reported zero stays a real zero");
  assert.equal(first.cost, 0.02);
  assert.equal(first.ttftMs, 120, "TTFT spans request start to first assistant start");
  assert.equal(first.toolCalls, 2, "tool calls executed for the issuing request are attributed to it");
  assert.equal(first.cacheReported, true, "present cache fields mark the report as cache-capable");

  assert.equal(second.turn, 2);
  assert.equal(second.cacheReported, undefined, "missing cache fields stay unreported, not zero");
  assert.equal(second.cacheRead, 0);
  assert.equal(second.ttftMs, 80);
  assert.equal(second.toolCalls, 0);
}

{
  const fake = fakeModel([[turnStart(), { __advance: 50 }]]);
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const view = await runtime.startManualRun(baseRequest()).done;
  assert.equal(view.requests.length, 1, "a request that ended before assistant message_end remains observable");
  assert.deepEqual(
    view.requests[0],
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turn: 1, toolCalls: 0 },
    "an incomplete request has bounded zero usage, no TTFT, and cache unreported",
  );
}

{
  const fake = fakeModel([[
    turnStart(),
    { __advance: Number.POSITIVE_INFINITY },
    assistantStart,
    assistantEnd({ input: Infinity, output: -3, cacheRead: Infinity, cacheWrite: -1, cost: Number.NaN }),
    ...Array.from({ length: 140 }, () => toolStart),
  ]]);
  const runtime = createShadowRuntime({ config: () => config({ defaults: { maxToolCallsPerRun: 128 } }), deps: fake.deps });
  const view = await runtime.startManualRun(baseRequest()).done;
  const metric = view.requests[0];
  assert.equal(metric.input, 0);
  assert.equal(metric.output, 0);
  assert.equal(metric.cacheRead, 0);
  assert.equal(metric.cacheWrite, 0);
  assert.equal(metric.cost, 0);
  assert.equal(metric.ttftMs, undefined);
  assert.equal(metric.toolCalls, 128, "request diagnostics clamp tool calls to the package hard cap");
}
{
  // A provider report of cache zeros is reported — the distinguishing case.
  const fake = fakeModel([[turnStart(), assistantStart, assistantEnd({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cacheReported: true })]]);
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const view = await runtime.startManualRun(baseRequest()).done;
  assert.equal(view.requests[0].cacheReported, true);
  assert.equal(view.requests[0].cacheRead, 0);
}

// ── Cohort metadata: hashes, never prompt text ─────────────────────

{
  const fake = fakeModel([[turnStart(), assistantStart, assistantEnd({ input: 1, output: 1 })]]);
  const mk = () => createShadowRuntime({ config: () => config(), deps: fake.deps });
  const model = { provider: "cpa", id: "shadow-model", api: "anthropic-messages", apiKey: "SECRET" };

  const authority = { parentCoreHash: "a".repeat(16), projectRulesHash: "b".repeat(16) };
  const a = await mk().startManualRun(baseRequest({
    modelResolution: { model, label: "cpa/shadow-model" },
    thinkingLevel: "high",
    authorityCohort: authority,
  })).done;
  const again = await mk().startManualRun(baseRequest({
    modelResolution: { model, label: "cpa/shadow-model" },
    thinkingLevel: "high",
    authorityCohort: authority,
  })).done;

  assert.ok(a.cohorts, "every run carries cohort metadata");
  assert.equal(again.cohorts.system, a.cohorts.system, "identical SYSTEM bytes hash identically");
  assert.equal(again.cohorts.toolSchema, a.cohorts.toolSchema);
  assert.equal(again.cohorts.model, a.cohorts.model);
  assert.equal(again.cohorts.thinking, a.cohorts.thinking);
  assert.equal(again.cohorts.cwd, a.cohorts.cwd);
  assert.equal(again.cohorts.trajectory, a.cohorts.trajectory);
  assert.equal(again.cohorts.trajectoryCheckpoint, a.cohorts.trajectoryCheckpoint);
  assert.equal(again.cohorts.truncation, a.cohorts.truncation);
  assert.equal(again.cohorts.parentCore, "a".repeat(16));
  assert.equal(again.cohorts.projectRules, "b".repeat(16));
  for (const value of [
    a.cohorts.system, a.cohorts.toolSchema, a.cohorts.model, a.cohorts.thinking,
    a.cohorts.cwd, a.cohorts.trajectory, a.cohorts.trajectoryCheckpoint, a.cohorts.truncation,
  ]) {
    assert.match(value, /^[0-9a-f]{16}$/, "cohort entries are hash prefixes");
  }
  assert.doesNotMatch(JSON.stringify(a), /SECRET/, "no credential leaks into the run record");
  assert.doesNotMatch(JSON.stringify(a), /SHADOW SYSTEM/, "no prompt text leaks into the run record");

  // Axis sensitivity: changing one axis changes exactly that hash.
  const changedThinking = await mk().startManualRun(baseRequest({
    modelResolution: { model, label: "cpa/shadow-model" },
    thinkingLevel: "low",
    authorityCohort: authority,
  })).done;
  assert.notEqual(changedThinking.cohorts.thinking, a.cohorts.thinking);
  assert.equal(changedThinking.cohorts.system, a.cohorts.system);

  const changedModel = await mk().startManualRun(baseRequest({
    modelResolution: { model: { ...model, id: "other-model" }, label: "cpa/other-model" },
    thinkingLevel: "high",
    authorityCohort: authority,
  })).done;
  assert.notEqual(changedModel.cohorts.model, a.cohorts.model);

  const changedSystem = await mk().startManualRun(baseRequest({
    modelResolution: { model, label: "cpa/shadow-model" },
    thinkingLevel: "high",
    authorityCohort: authority,
    system: "DIFFERENT SYSTEM",
  })).done;
  assert.notEqual(changedSystem.cohorts.system, a.cohorts.system);
  assert.equal(changedSystem.cohorts.toolSchema, a.cohorts.toolSchema);

  const changedTrajectory = await mk().startManualRun(baseRequest({
    modelResolution: { model, label: "cpa/shadow-model" },
    thinkingLevel: "high",
    authorityCohort: authority,
    trajectory: { text: "[user] different", includedMessages: 1, totalMessages: 2, truncated: true, truncation: "dropped" },
  })).done;
  assert.notEqual(changedTrajectory.cohorts.trajectory, a.cohorts.trajectory);
  assert.notEqual(changedTrajectory.cohorts.trajectoryCheckpoint, a.cohorts.trajectoryCheckpoint);
  assert.notEqual(changedTrajectory.cohorts.truncation, a.cohorts.truncation);
  assert.equal(changedTrajectory.trajectoryTruncated, true);

  const unsafePrehash = await mk().startManualRun(baseRequest({
    envelope: { toolNames: [], customTools: [], schemaHash: "api_key=TOOLSECRET", warnings: [] },
    authorityCohort: { parentCoreHash: "Authorization: Bearer CORESECRET", projectRulesHash: "password=RULESECRET" },
  })).done;
  for (const value of [unsafePrehash.cohorts.toolSchema, unsafePrehash.cohorts.parentCore, unsafePrehash.cohorts.projectRules]) {
    assert.match(value, /^[0-9a-f]{16}$/, "externally supplied cohort values are normalized to hashes");
  }
  assert.doesNotMatch(JSON.stringify(unsafePrehash), /TOOLSECRET|CORESECRET|RULESECRET/, "non-hash cohort input never enters the run record verbatim");

  // Omitted authority input leaves those cohort entries absent, not fake.
  const noAuthority = await mk().startManualRun(baseRequest()).done;
  assert.equal(noAuthority.cohorts.parentCore, undefined);
  assert.equal(noAuthority.cohorts.projectRules, undefined);
}

// ── Aggregate summary: bounded, measured, best-effort ───────────────

{
  const run = (over) => ({
    id: over.id, phase: over.phase ?? "submitted", startedAt: 1,
    requests: over.requests ?? [],
    usage: over.usage,
    cohorts: over.cohorts,
  });
  const cohorts = { system: "s1", toolSchema: "t1", model: "m1" };
  const summary = summarizeShadowUsage([
    run({
      id: "r1",
      usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 },
      requests: [
        { turn: 1, input: 100, output: 40, cacheRead: 500, cacheWrite: 0, cost: 0.02, toolCalls: 2, ttftMs: 120, cacheReported: true },
        { turn: 2, input: 60, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01, toolCalls: 0, ttftMs: 80 },
      ],
      cohorts,
    }),
    run({
      id: "r2",
      phase: "error",
      usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 1 },
      requests: [
        { turn: 1, input: 30, output: 5, cacheRead: 300, cacheWrite: 20, cost: 0.005, toolCalls: 1, ttftMs: 200, cacheReported: true },
      ],
      cohorts,
    }),
    run({ id: "r3", phase: "running" }),
    run({ id: "r4", phase: "submitted", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 } }),
  ]);

  assert.equal(summary.runs, 4);
  assert.equal(summary.running, 1);
  assert.equal(summary.settled, 3);
  assert.equal(summary.requests, 3);
  assert.equal(summary.turns, 4, "turn totals come from run usage");
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.input, 140);
  assert.equal(summary.output, 47);
  assert.ok(Math.abs(summary.cost - 0.026) < 1e-9);
  assert.deepEqual(summary.ttft, { count: 3, minMs: 80, avgMs: 133, maxMs: 200 }, "TTFT aggregates observed values only");
  assert.deepEqual(
    summary.cache,
    { requests: 3, reportedRequests: 2, cacheRead: 800, cacheWrite: 20 },
    "cache totals count only provider-reported requests; an unreported zero never counts",
  );

  assert.equal(summary.cohorts.length, 1, "runs without cohorts form no group");
  const group = summary.cohorts[0];
  assert.equal(group.size, 2);
  assert.equal(group.cache.cacheRead, 800);
  assert.equal(group.cache.cacheWrite, 20);
  assert.equal(group.cache.reportedRequests, 2);
  assert.ok(group.label.includes("m1"), "the group label carries its hash axes");
}

{
  const summary = summarizeShadowUsage([{
    id: "damaged",
    phase: "submitted",
    startedAt: 1,
    usage: { input: Infinity, output: -5, cacheRead: 0, cacheWrite: 0, cost: Number.NaN, turns: Number.MAX_VALUE },
    requests: [
      { input: 0, output: 0, cacheRead: Infinity, cacheWrite: -1, cost: 0, turn: 1, toolCalls: Infinity, ttftMs: Infinity, cacheReported: true },
      { input: 0, output: 0, cacheRead: Number.MAX_VALUE, cacheWrite: Number.MAX_VALUE, cost: 0, turn: 2, toolCalls: Number.MAX_VALUE, ttftMs: 10, cacheReported: true },
    ],
  }]);
  assert.equal(summary.input, 0);
  assert.equal(summary.output, 0);
  assert.equal(summary.cost, 0);
  assert.equal(summary.turns, Number.MAX_SAFE_INTEGER, "aggregate counts saturate at a finite hard bound");
  assert.equal(summary.toolCalls, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.cache.cacheRead, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.cache.cacheWrite, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(summary.ttft, { count: 1, minMs: 10, avgMs: 10, maxMs: 10 }, "non-finite TTFT values are excluded");
}
{
  // Cohort groups sort by size then key and stay bounded.
  const mk = (id, cohorts) => ({ id, phase: "submitted", startedAt: 1, cohorts });
  const many = [
    ...Array.from({ length: 10 }, (_, i) => mk(`a${i}`, { system: "s1", toolSchema: "t1", model: "m1" })),
    ...Array.from({ length: 4 }, (_, i) => mk(`b${i}`, { system: "s2", toolSchema: "t1", model: "m1" })),
    ...Array.from({ length: 2 }, (_, i) => mk(`c${i}`, undefined)),
  ];
  const summary = summarizeShadowUsage(many);
  assert.equal(summary.cohorts.length, 2);
  assert.deepEqual(summary.cohorts.map((group) => group.size), [10, 4]);
  assert.equal(summary.runsWithCohorts, 14);
  assert.equal(summary.runsWithoutCohorts, 2);

  const bounded = summarizeShadowUsage(
    Array.from({ length: 40 }, (_, i) => mk(`x${i}`, { system: `s${i}`, toolSchema: "t", model: "m" })),
  );
  assert.ok(bounded.cohorts.length <= SHADOW_COHORT_GROUPS_MAX, "the cohort list is bounded");
  assert.ok(
    bounded.cohorts.reduce((sum, group) => sum + group.size, 0) <= 40,
    "dropped groups lose their runs from the bounded list only",
  );
  assert.equal(bounded.runsWithCohorts, 40, "the coverage counts still cover every run");
  assert.equal(shadowCohortGroupKey({ system: "s", toolSchema: "t", model: "m" }), "m|s|t", "the key is stable and ordered");
}

// ── The experiment: scheduler order, accounting, aggregation ────────

{
  // One deterministic fake-model experiment wires the scheduler to the
  // runtime: trigger order decides dispatch, run accounting comes from the
  // scripted provider reports, and the aggregate matches — no real provider.
  const fake = fakeModel([[turnStart(), assistantStart, assistantEnd({ input: 10, output: 2, cacheRead: 100, cacheWrite: 5, cost: 0.01 })]]);
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const started = [];
  const settlements = [];
  const scheduler = createShadowScheduler({
    now: () => 1,
    currentRun: () => 1,
    config: () => config(),
    definitions: () => [
      definition({ id: "quality", enabled: true, triggers: ["failure"] }),
      definition({ id: "after-answer", enabled: true, triggers: ["completion"] }),
    ],
    start(activation) {
      started.push(activation.definition.id);
      const outcome = runtime.startAutomaticRun({
        ...baseRequest({
          definition: activation.definition,
          trigger: activation.reasons[0]?.trigger,
          taskEpoch: activation.taskEpoch,
          triggerReasons: activation.reasons,
          authorityCohort: { parentCoreHash: "c".repeat(16), projectRulesHash: "d".repeat(16) },
        }),
      });
      if (outcome.started) settlements.push(outcome.done);
      return outcome.started ? { outcome: "started" } : { outcome: "failed", reason: outcome.reason };
    },
    preemptOldestAutomatic: () => ({ ok: false, reason: "test" }),
    activeRun: () => undefined,
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });

  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolEnd("bash", true, { command: "npm test" });
  scheduler.handleTurnEnd({ text: "[user] task", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" });
  scheduler.handleAgentEnd({ interrupted: false, checkpoint: { text: "[user] task", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" } });

  // The failure activation dispatches at turn end while completion waits for
  // the settled run, so quality starts first — event sequencing, not
  // priority arbitration (co-pending priority is covered below).
  assert.deepEqual(started, ["quality", "after-answer"], "the deterministic event order decides dispatch");
  await Promise.all(settlements);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runs.length, 2);
  const qualityRun = snapshot.runs.find((run) => run.shadowId === "quality");
  const completionRun = snapshot.runs.find((run) => run.shadowId === "after-answer");
  assert.equal(qualityRun.source, "automatic");
  assert.equal(completionRun.trigger, "completion");
  for (const run of [qualityRun, completionRun]) {
    assert.equal(run.requests.length, 1);
    assert.equal(run.requests[0].cacheReported, true);
    assert.equal(run.requests[0].cacheRead, 100);
    assert.equal(run.cohorts.parentCore, "c".repeat(16));
    assert.equal(run.cohorts.projectRules, "d".repeat(16));
  }

  const summary = summarizeShadowUsage(snapshot.runs);
  assert.equal(summary.runs, 2);
  assert.equal(summary.requests, 2);
  assert.equal(summary.turns, 2);
  assert.deepEqual(summary.cache, { requests: 2, reportedRequests: 2, cacheRead: 200, cacheWrite: 10 });
  assert.equal(summary.cohorts.length, 1, "same-prompt runs share one cache cohort");
  assert.equal(summary.cohorts[0].size, 2);
}

// ── Co-pending trigger-priority arbitration (#161) ──────────────────

{
  // One busy slot leaves the failure activation pending at turn end; the
  // settled run then enqueues completion. Both are co-pending, and dispatch
  // arbitrates by TRIGGER_PRIORITY: completion (3) outranks failure (2)
  // regardless of the earlier event that observed the failure.
  const fake = fakeModel([[turnStart(), assistantStart, assistantEnd({ input: 10, output: 2, cacheRead: 100, cacheWrite: 5, cost: 0.01 })]]);
  const runtime = createShadowRuntime({ config: () => config(), deps: fake.deps });
  const attempts = [];
  const settlements = [];
  let busyFirst = true;
  const scheduler = createShadowScheduler({
    now: () => 1,
    currentRun: () => 1,
    config: () => config(),
    definitions: () => [
      definition({ id: "quality", enabled: true, triggers: ["failure"] }),
      definition({ id: "after-answer", enabled: true, triggers: ["completion"] }),
    ],
    start(activation) {
      attempts.push(activation.definition.id);
      if (busyFirst) {
        busyFirst = false;
        return { outcome: "busy", reason: "slot busy" };
      }
      const outcome = runtime.startAutomaticRun({
        ...baseRequest({
          definition: activation.definition,
          trigger: activation.reasons[0]?.trigger,
          taskEpoch: activation.taskEpoch,
          triggerReasons: activation.reasons,
        }),
      });
      if (outcome.started) settlements.push(outcome.done);
      return outcome.started ? { outcome: "started" } : { outcome: "failed", reason: outcome.reason };
    },
    preemptOldestAutomatic: () => ({ ok: false, reason: "test" }),
    activeRun: () => undefined,
    cancelTaskRuns: () => 0,
    cancelAutomaticRuns: () => 0,
    forceNotifyOldResults: () => 0,
  });

  scheduler.handleInput("interactive");
  scheduler.handleRunStart(true);
  scheduler.observeToolEnd("bash", true, { command: "npm test" });
  // Turn end: the failure activation dispatches into a busy slot and stays
  // pending — completion is not observed yet.
  scheduler.handleTurnEnd({ text: "[user] task", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" });
  assert.deepEqual(attempts, ["quality"]);

  // The settled run enqueues completion; both activations are co-pending
  // and the next dispatch arbitrates by trigger priority.
  scheduler.handleAgentEnd({ interrupted: false, checkpoint: { text: "[user] task", includedMessages: 1, totalMessages: 1, truncated: false, truncation: "none" } });
  assert.deepEqual(
    attempts,
    ["quality", "after-answer", "quality"],
    "co-pending completion outranks failure despite the earlier failure observation",
  );
  await Promise.all(settlements);
  assert.equal(runtime.snapshot().runs.length, 2);
}

console.log("shadow-minds diagnostics tests: OK");
