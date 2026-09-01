import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER, SEVERE_CLASSES } from "../qualification/harness.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { createFakeAdapter, FAKE_ADAPTER_DECLARATION } from "./fake-model.mjs";
import {
  planRuns,
  deriveSeed,
  selectRerunScope,
  pinEnvironment,
  executeRun,
  runQualification,
  runLabel,
  REPORT_SCHEMA,
} from "./runner.mjs";
import { evaluateGates } from "./oracles.mjs";

/**
 * Fake/dry-run coverage for the continuity qualification system (#224):
 * orchestration of the fixed 16-run matrix through the adapter seam against
 * the production controller, deterministic scoring of every severe failure
 * class and every gate-blocking condition, the bounded report shape with its
 * privacy self-check, failure propagation into the verdict, and the
 * impact-based rerun selection. No provider credential is read anywhere.
 */

const RUN = (scenario, variant, arm = "primary") => ({ scenario, variant, arm, seed: deriveSeed({ scenario, variant, arm }) });

async function runWithDefects(scenario, variant, defects) {
  const { score, evidence } = await executeRun({
    adapter: createFakeAdapter({ defects }),
    run: RUN(scenario, variant),
  });
  return { score, evidence };
}

// ─── Orchestration: the fixed run matrix ───────────────────────────

{
  const runs = planRuns();
  assert.equal(runs.length, 16, "the matrix is the fixed 16-run gate of #215");
  const primary = runs.filter((run) => run.arm === "primary");
  const secondary = runs.filter((run) => run.arm === "secondary");
  assert.equal(primary.length, 12, "the primary arm covers early/middle/late for all four scenarios");
  assert.equal(secondary.length, 4, "the secondary arm covers one canonical run per scenario");
  for (const scenario of SCENARIOS) {
    assert.deepEqual(
      primary.filter((run) => run.scenario === scenario.id).map((run) => run.variant).sort(),
      ["early", "late", "middle"],
      `${scenario.id} primary variants`,
    );
    assert.deepEqual(
      secondary.filter((run) => run.scenario === scenario.id).map((run) => run.variant),
      ["canonical"],
      `${scenario.id} secondary runs the canonical variant`,
    );
  }
  assert.deepEqual(planRuns(), runs, "the matrix is deterministic");
  assert.deepEqual(planRuns({ salt: "other-salt" }).map((run) => run.seed), runs.map((run) => deriveSeed(run, "other-salt")));
  assert.notDeepEqual(planRuns({ salt: "other-salt" }).map((run) => run.seed), runs.map((run) => run.seed), "seeds follow the salt");
  assert.equal(new Set(runs.map((run) => run.seed)).size, 16, "every run carries a distinct seed");
}

// ─── Rerun selection (#215 impact-based rules) ─────────────────────

{
  const full = selectRerunScope({ kind: "model-visible" });
  assert.equal(full.scope, "full");
  assert.equal(full.runs.length, 16);
  assert.equal(selectRerunScope({ kind: "algorithm" }).scope, "full");

  const none = selectRerunScope({ kind: "ui" });
  assert.equal(none.scope, "none");
  assert.equal(none.runs.length, 0);
  assert.equal(selectRerunScope({ kind: "documentation" }).runs.length, 0);

  const provider = selectRerunScope({ kind: "provider", arms: ["primary"] });
  assert.equal(provider.scope, "affected");
  assert.deepEqual(provider.runs.map((run) => run.arm), Array(12).fill("primary"));
  assert.equal(selectRerunScope({ kind: "pi-compat", arms: [] }).scope, "full", "unspecified arms fail safe to everything");

  const defect = selectRerunScope({ kind: "defect", scenarios: ["branch-isolation", "source-recovery"] });
  assert.equal(defect.scope, "affected");
  assert.deepEqual([...new Set(defect.runs.map((run) => run.scenario))], ["branch-isolation", "source-recovery"]);
  assert.equal(defect.runs.length, 8, "a defect rerun covers every variant and arm of the affected scenarios");
  assert.equal(selectRerunScope({ kind: "defect" }).scope, "full", "unspecified scenarios fail safe to everything");
  assert.equal(selectRerunScope({ kind: "made-up" }).scope, "full", "unknown kinds fail safe to everything");
}

// ─── Pinning ───────────────────────────────────────────────────────

{
  const pins = pinEnvironment({ adapterDeclaration: FAKE_ADAPTER_DECLARATION });
  assert.match(pins.implementation.commit, /^[0-9a-f]{40}$/, "the implementation commit is pinned");
  assert.match(pins.implementation.digest, /^[0-9a-f]{64}$/, "the implementation digest is pinned");
  assert.equal(typeof pins.implementation.dirty, "boolean");
  assert.equal(pins.package.name, "@odradekk/pi-square");
  assert.match(pins.package.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pins.pi.package, "0.84.2", "the pinned package version records what the corpus was qualified against");
  assert.equal(pins.config.contextMemory.enabled, true);
  assert.equal(pins.config.modelWindow, 200_000);
  for (const arm of ["primary", "secondary"]) {
    const declared = pins.arms[arm];
    assert.ok(declared.provider && declared.model, `${arm} pins provider/model`);
    assert.equal(typeof declared.thinking, "string", `${arm} pins thinking settings`);
    assert.ok(declared.sampling && typeof declared.sampling === "object", `${arm} pins sampling settings`);
  }
  assert.match(pins.fixtures.digest, /^[0-9a-f]{64}$/, "the fixture commit digest is pinned");
  assert.match(pins.fixtures.rubricDigest, /^[0-9a-f]{64}$/, "the rubric digest is pinned");
  assert.equal(pins.seeds.length, 16, "the supported seed list is recorded");
  assert.equal(typeof pins.seedRule, "string");
  assert.match(pins.pinsDigest, /^[0-9a-f]{64}$/);
}

// ─── Full dry-run: pass, report shape, privacy, attempts log ───────

{
  const reportDir = mkdtempSync(join(tmpdir(), "continuity-report-"));
  const { report, json, markdown } = await runQualification({
    adapter: createFakeAdapter(),
    reportDir,
  });

  assert.equal(report.result, "pass", "the clean dry-run passes every gate");
  assert.equal(report.mode, "dry-run");
  assert.equal(report.releaseRelevant, false, "a dry-run never authorizes a release");
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.adapter, "scripted-fake");
  assert.equal(report.runs.length, 16);
  assert.equal(report.gates.severeFailures.total, 0);
  assert.equal(report.gates.criticalRecall, 1);
  assert.equal(report.gates.continuityRecallOverall, 1);
  assert.equal(report.gates.canonicalFinalTasks.passed, 4);
  assert.equal(report.gates.canonicalFinalTasks.total, 4);
  assert.equal(report.gates.scheduleComplete.valid, 16);
  assert.equal(report.gates.hardChecks.failed, 0);
  assert.equal(report.zeroTolerance.waivers, 0);
  assert.equal(report.zeroTolerance.retries, 0);
  assert.ok(report.humanReview.noLlmJudge && report.humanReview.secondHumanForAmbiguousSevere);
  assert.equal(report.economics.simulated, true);
  assert.ok(report.economics.note.includes("never enter the verdict"), "economics are declared non-gating");
  for (const run of report.runs) {
    assert.equal(run.schedule.appends, 2, `${run.run} observed two appends`);
    assert.equal(run.schedule.rebuilds, 1, `${run.run} observed one suffix rebuild`);
    assert.ok(run.ok, `${run.run} is clean`);
  }

  // Files: bounded JSON + Markdown report plus the append-only attempts log.
  const files = readdirSync(reportDir).sort();
  assert.deepEqual(files, ["attempts.jsonl", "continuity-qualification.json", "continuity-qualification.md"]);
  assert.equal(JSON.parse(readFileSync(join(reportDir, "continuity-qualification.json"), "utf8")).result, "pass");
  assert.ok(markdown.includes("# Context Memory continuity qualification"));

  // Privacy: no fixture marker, no padding runs, in either artifact.
  for (const text of [json, markdown]) {
    assert.ok(!text.includes(MARKER), "the report never contains fixture content markers");
    assert.equal(text.match(/(.)\1{63}/), null, "the report never contains fixture padding runs");
  }

  // A second execution appends a second attempts line with a stable pins digest.
  const firstLine = JSON.parse(readFileSync(join(reportDir, "attempts.jsonl"), "utf8").split("\n")[0]);
  const second = await runQualification({ adapter: createFakeAdapter(), reportDir });
  const lines = readFileSync(join(reportDir, "attempts.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "attempts are append-only");
  const secondLine = JSON.parse(lines[1]);
  assert.equal(secondLine.pinsDigest, firstLine.pinsDigest, "identical environments keep one pins digest");
  assert.equal(secondLine.result, second.report.result);
  assert.equal(second.report.result, "pass");
}

// ─── Every severe failure class is caught, separately ──────────────

{
  const cases = [
    {
      name: "fabrication",
      scenario: "exact-work",
      defects: [{ kind: "claim", turn: "t11-final", text: "For the record, the retry limit is 5 attempts." }],
      klass: "fabrication",
    },
    {
      name: "uncertainty promotion",
      scenario: "exact-work",
      defects: [{ kind: "claim", turn: "t10-trap", text: "The audit retention period is 90 days." }],
      klass: "uncertainty-promotion",
    },
    {
      name: "exact-detail corruption before any rebuild",
      scenario: "exact-work",
      defects: [{ kind: "corrupt", turn: "t6-probe", find: "384", replaceWith: "512" }],
      klass: "exact-detail-corruption",
    },
    {
      name: "recursive drift across the rebuild",
      scenario: "exact-work",
      defects: [{ kind: "corrupt", turn: "t9-probe", find: "384", replaceWith: "512" }],
      klass: "recursive-drift",
    },
    {
      name: "negative constraint reversed in words",
      scenario: "constraint-reversal",
      defects: [{ kind: "claim", turn: "t11-final", text: "Admittedly, toFixed(2) is exact for cents here." }],
      klass: "negative-constraint",
    },
    {
      name: "negative constraint violated by action",
      scenario: "constraint-reversal",
      defects: [{ kind: "action", turn: "t11-final", tool: "bash" }],
      klass: "negative-constraint",
    },
    {
      name: "branch contamination",
      scenario: "branch-isolation",
      defects: [{ kind: "claim", turn: "t12-final", text: "The abandoned skip-list index was keyed differently." }],
      klass: "branch-contamination",
    },
  ];

  for (const testCase of cases) {
    const { score } = await runWithDefects(testCase.scenario, "middle", testCase.defects);
    assert.equal(score.ok, false, `${testCase.name} fails the run`);
    assert.ok(score.severe[testCase.klass] >= 1, `${testCase.name} reports at least one ${testCase.klass}`);
    assert.equal(
      SEVERE_CLASSES.filter((klass) => klass !== testCase.klass).reduce((sum, klass) => sum + score.severe[klass], 0),
      0,
      `${testCase.name} contaminates no other severe class`,
    );
    const { result } = evaluateGates([score]);
    assert.equal(result, "fail", `${testCase.name} blocks the gate`);
  }

  // Corruption and drift are distinguishable: the same wrong value before the
  // rebuild boundary classifies as corruption, after it as drift.
  const corruption = await runWithDefects("exact-work", "middle", [{ kind: "corrupt", turn: "t6-probe", find: "384", replaceWith: "512" }]);
  const drift = await runWithDefects("exact-work", "middle", [{ kind: "corrupt", turn: "t9-probe", find: "384", replaceWith: "512" }]);
  assert.equal(corruption.score.severe["exact-detail-corruption"], 1);
  assert.equal(corruption.score.severe["recursive-drift"], 0);
  assert.equal(drift.score.severe["recursive-drift"], 1);
  assert.equal(drift.score.severe["exact-detail-corruption"], 0, "the drift precedence claims the failing probe");
}

// ─── Gate-blocking conditions without severe failures ──────────────

{
  // A plain critical miss: no severe class, but critical recall drops below 100%.
  const { score } = await runWithDefects("exact-work", "middle", [{ kind: "miss", turn: "t6-probe", find: "QCORPUS-7C31" }]);
  assert.equal(SEVERE_CLASSES.reduce((sum, klass) => sum + score.severe[klass], 0), 0, "a miss is not severe");
  assert.equal(score.critical.matched, score.critical.total - 1);
  assert.equal(score.ok, false);
  const missed = score.failures.find((failure) => failure.family === "recall");
  assert.ok(missed && missed.class === "recall", "the miss is reported as a recall failure");

  // A skipped append breaks the compression schedule requirement.
  const skipped = await runWithDefects("exact-work", "middle", [{ kind: "skip-submit", turn: "t2-append-1" }]);
  assert.equal(skipped.score.schedule.valid, false);
  assert.ok(skipped.score.hardCheckFailures.some((failure) => failure.family === "compression-schedule"));

  // A skipped source read on the recovery scenario trips the expected-use check
  // without inventing anything: the answer stays correct, the evidence path is gone.
  const noRead = await runWithDefects("source-recovery", "middle", [{ kind: "skip-source-read", turn: "t11-final" }]);
  assert.equal(SEVERE_CLASSES.reduce((sum, klass) => sum + noRead.score.severe[klass], 0), 0);
  assert.ok(noRead.score.hardCheckFailures.some((failure) => failure.family === "source-read-missing"));

  // An incomplete final task fails its own check.
  const incomplete = await runWithDefects("exact-work", "middle", [{ kind: "miss", turn: "t11-final", find: "750 ms" }]);
  assert.equal(incomplete.score.finalTask, false);
  assert.ok(incomplete.score.hardCheckFailures.some((failure) => failure.family === "final-task-incomplete"));
}

// ─── Failure propagation through the whole matrix and verdict ──────

{
  const reportDir = mkdtempSync(join(tmpdir(), "continuity-fail-"));
  const { report, json } = await runQualification({
    adapter: createFakeAdapter({
      defects: [{ kind: "corrupt", turn: "t9-probe", find: "384", replaceWith: "512" }],
    }),
    reportDir,
  });
  assert.equal(report.result, "fail");
  assert.equal(report.gates.severeFailures.total, 3,
    "the drift defect hits exactly the exact-work variants whose post-rebuild probe carries the value (early, middle, canonical; the late variant never states it there)");
  assert.ok(report.gates.severeFailures.byClass["recursive-drift"] >= 1);
  assert.equal(report.zeroTolerance.severeFailures, report.gates.severeFailures.total);
  assert.ok(report.failures.length > 0);
  for (const failure of report.failures) {
    assert.ok(!failure.message.includes(MARKER), "failure messages never echo fixture content");
  }
  assert.ok(json.includes('"result": "fail"'));
  const attempts = readFileSync(join(reportDir, "attempts.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(attempts[0]).result, "fail", "the failed attempt is recorded, not discarded");
}

// ─── Gate arithmetic at the release thresholds ─────────────────────

{
  const synthetic = (overrides) => ({
    run: RUN("exact-work", "middle"),
    severe: Object.fromEntries(SEVERE_CLASSES.map((klass) => [klass, 0])),
    severeTotal: 0,
    critical: { total: 3, matched: 3 },
    continuity: { total: 3, matched: 3 },
    traps: { answered: 1, promoted: 0, unanswered: 0 },
    finalTask: true,
    schedule: { appends: 2, rebuilds: 1, valid: true },
    hardCheckFailures: [],
    failures: [],
    turns: 11,
    ok: true,
    ...overrides,
  });

  const canonical = synthetic({ run: RUN("source-recovery", "canonical", "secondary") });
  const clean = [synthetic(), canonical];
  assert.equal(evaluateGates(clean).result, "pass");

  // Recall thresholds are exact: 85% overall and 75% per scenario.
  const below = evaluateGates([synthetic({ continuity: { total: 20, matched: 16 } }), canonical]);
  assert.equal(below.result, "fail", "80% overall continuity fails");
  const at = evaluateGates([synthetic({ continuity: { total: 20, matched: 17 } }), canonical]);
  assert.equal(at.result, "pass", "85% overall continuity passes");

  const twoScenarios = [
    canonical,
    synthetic({ run: RUN("exact-work", "middle") }),
    synthetic({ run: RUN("branch-isolation", "middle"), continuity: { total: 4, matched: 2 } }),
  ];
  const overall = (2 * 3 + 2) / (2 * 4);
  assert.ok(overall >= 0.85, "the fixture keeps overall recall high while one scenario sits at 50%");
  assert.equal(evaluateGates(twoScenarios).result, "fail", "a scenario below 75% fails even with high overall recall");

  // A failed canonical final task blocks the gate.
  const canonicalFailed = evaluateGates([
    synthetic(),
    synthetic({ run: RUN("source-recovery", "canonical", "secondary"), finalTask: false }),
  ]);
  assert.equal(canonicalFailed.result, "fail");

  // Economics never enter the verdict: the gate structure has no cost or
  // token fields to read.
  const gateKeys = JSON.stringify(evaluateGates(clean).gates);
  assert.ok(!/"(cost|tokens|requestChars|assistantChars)"/.test(gateKeys), "gates carry no compression or cost numbers");
}

// ─── Scorer arms unreachable through model defects ─────────────────

{
  // An unanswered trap (neither promoted nor refused) and an impure carrying
  // compaction cannot be produced by the scripted model without changing the
  // controller, so the scorer is exercised directly with synthetic evidence.
  const { scoreRun } = await import("./oracles.mjs");
  const { buildScript } = await import("./scenarios.mjs");
  const branchScript = buildScript(SCENARIOS.find((s) => s.id === "branch-isolation"), "middle");
  const exactScript = buildScript(SCENARIOS.find((s) => s.id === "exact-work"), "middle");

  const turn = (id, text) => ({
    turn: id, kind: "probe", advisory: false, assistantText: text, assistantChars: text.length,
    requestChars: 10, toolCalls: [], sourceReads: [], compression: null, memoryPurity: null, error: null,
  });
  const answerFor = (script, id) => script.turns.find((entry) => entry.id === id)?.fake?.finalText ?? "";

  const trapEvidence = exactScript.turns.map((entry) =>
    turn(entry.id, entry.id === "t10-trap" ? "The answer depends on the retention configuration." : answerFor(exactScript, entry.id)));
  const trapScore = scoreRun({ run: RUN("exact-work", "middle"), evidence: trapEvidence, oracle: exactScript.oracle, stats: { compressions: [] } });
  assert.equal(trapScore.traps.unanswered, 1, "a trap answered without a stance and without promotion is counted unanswered");
  assert.ok(trapScore.hardCheckFailures.some((failure) => failure.family === "trap-unanswered"));
  assert.equal(trapScore.severe["uncertainty-promotion"], 0, "an unanswered trap is not a promotion");

  const branchEvidence = branchScript.turns.map((entry) => turn(entry.id, answerFor(branchScript, entry.id)));
  const branchScore = scoreRun({
    run: RUN("branch-isolation", "middle"),
    evidence: branchEvidence,
    oracle: branchScript.oracle,
    stats: { compressions: [], memoryPurity: false },
  });
  assert.equal(branchScore.severe["branch-contamination"], 1, "an impure carrying compaction is mechanical branch contamination");
}

// ─── Bounded evidence and adapter contract ─────────────────────────
{
  const { evidence } = await runWithDefects("exact-work", "middle", [
    { kind: "claim", turn: "t11-final", text: `PAD${"Z".repeat(20_000)}` },
  ]);
  const final = evidence.find((record) => record.turn === "t11-final");
  assert.ok(final.assistantText.length <= 8_000, "recorded assistant text is capped");
  assert.equal(final.assistantChars, final.assistantText.length);
  assert.ok(evidence.every((record) => !record.sourceReads.some((read) => Object.keys(read).some((key) => key === "target"))),
    "source-read evidence records no fixture token");

  // An adapter that crashes mid-run becomes a scored run-error, not a crash
  // and not a silent skip: the schedule gate fails on the partial run.
  {
    const base = createFakeAdapter();
    const crashing = {
      declaration: base.declaration,
      requiredEnv: base.requiredEnv,
      createSession(options) {
        const inner = base.createSession(options);
        return {
          ...inner,
          async runTurn(turn) {
            if (turn.id === "t8-rebuild") throw new Error("simulated provider transport failure");
            return inner.runTurn(turn);
          },
        };
      },
    };
    const { score } = await executeRun({ adapter: crashing, run: RUN("exact-work", "middle") });
    assert.equal(score.ok, false);
    assert.ok(score.hardCheckFailures.some((failure) => failure.family === "run-error" && failure.id === "adapter"));
    assert.equal(score.schedule.valid, false, "the crashed run never reaches its rebuild");

    const reportDir = mkdtempSync(join(tmpdir(), "continuity-crash-"));
    const { report } = await runQualification({ adapter: crashing, reportDir });
    assert.equal(report.result, "fail");
    assert.ok(report.failures.some((failure) => failure.id === "adapter" && failure.message.includes("simulated provider transport failure")));
    for (const failure of report.failures) {
      assert.ok(!failure.message.includes(MARKER), "failure messages never echo fixture content");
    }
  }
  // The report's privacy self-check: a leaking failure message trips it, the
  // result flips to fail, and the written artifact is masked before it lands.
  {
    const base = createFakeAdapter();
    const leaking = {
      declaration: base.declaration,
      requiredEnv: base.requiredEnv,
      createSession(options) {
        const inner = base.createSession(options);
        return {
          ...inner,
          async runTurn(turn) {
            if (turn.id === "t6-probe") throw new Error(`boom with leaked body ${MARKER}-7C31 and ${"q".repeat(80)}`);
            return inner.runTurn(turn);
          },
        };
      },
    };
    const reportDir = mkdtempSync(join(tmpdir(), "continuity-leak-"));
    const { report, json } = await runQualification({ adapter: leaking, reportDir });
    assert.equal(report.result, "fail");
    assert.ok(report.failures.some((failure) => failure.id === "report-privacy"), "the self-check flags the leak");
    assert.ok(!json.includes(MARKER), "the masked artifact carries no marker");
    assert.equal(json.match(/q{64}/), null, "the masked artifact carries no padding run");
    const writtenJson = readFileSync(join(reportDir, "continuity-qualification.json"), "utf8");
    assert.ok(!writtenJson.includes(MARKER), "the written JSON artifact is masked too");
    const writtenMarkdown = readFileSync(join(reportDir, "continuity-qualification.md"), "utf8");
    assert.ok(!writtenMarkdown.includes(MARKER), "the written Markdown artifact is masked too");
    assert.equal(writtenMarkdown.match(/q{64}/), null, "the written Markdown artifact carries no padding run");
    const attempts = JSON.parse(readFileSync(join(reportDir, "attempts.jsonl"), "utf8").trim());
    assert.equal(attempts.result, "fail");
  }

  // The adapter contract is enforced: declarations and session factories.
  await assert.rejects(
    () => runQualification({ adapter: { createSession() { throw new Error("unreachable"); } }, reportDir: null }),
    /must declare/,
  );
  await assert.rejects(
    () => runQualification({
      adapter: {
        declaration: { id: "x", arms: { primary: { provider: "p", model: "m" } } },
        createSession() { throw new Error("unreachable"); },
      },
      reportDir: null,
    }),
    /thinking, and sampling/,
  );
  assert.deepEqual(FAKE_ADAPTER_DECLARATION.requiredEnv, [], "the dry-run adapter needs no credentials");
  assert.equal(typeof runLabel(RUN("exact-work", "middle")), "string");
}

console.log("continuity runner: all checks passed");
