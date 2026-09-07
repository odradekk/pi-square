import assert from "node:assert/strict";
import {
  BASELINE_DIRECTIONS,
  COST_DERIVATION_NOTE,
  DEAD_CONTROL_NOTE,
  DENOMINATOR_NOTE,
  DERIVED_FIGURES,
  DIRECTION_NOISE_FLOORS,
  DIRECTION_NOTES,
  FORBIDDEN_CLAIM_PHRASES,
  HIT_RATE_AGGREGATION,
  HIT_RATE_DEFINITION,
  IMPROVEMENT_MARGIN_PP,
  LIVENESS_MARGIN_PP,
  NON_REGRESSION_BAND_PP,
  REGRESSION_DIRECTION_THRESHOLD,
  REGRESSION_GROUP_THRESHOLD,
  armHitRate,
  baselineMedians,
  classifyGroup,
  compareBaseline,
  evaluateRun,
  median,
  rateDifferenceAtLeast,
  withinTtl,
} from "./verdict.mjs";

/**
 * Verdict-rule coverage for the provider-cache experiment (#225, standard
 * re-pinned by #260, directions re-modeled by #268, append case and labels
 * re-pinned by #297). Every branch is driven with constructed evidence — no
 * provider, no credentials — because the rules, not the plumbing, are the
 * deliverable: ambiguous or dead evidence is inconclusive, never a miss and
 * never a pass; the improved/neutral/regressed labels are exercised at their
 * exact edges for both a live and a dead liveness control; the per-direction
 * noise floors absorb the projection's structural framing overhead while any
 * real regression still fires; the counted directions stay independent (a
 * derived cost move can never fire the regression rule alone); and the pinned
 * hit-rate aggregation is proven to sum first and divide once.
 */

const TTL_MS = 300_000;

function row({ arm, role, reported = true, read = 0, write = 0, input = 120, cost = 0.001, ttft = 200, sentAt = 0 }) {
  return { arm, role, cacheReported: reported, cacheRead: read, cacheWrite: write, inputTokens: input, outputTokens: 50, cost, ttftMs: ttft, sentAtMs: sentAt };
}

/**
 * A default neutral-shaped group with a live control: the multiblock arm's
 * probe reuses most of its input (75%), the single baseline nearly matches
 * it (73.75%, inside the band and below the improvement margin), and the
 * nonce control's probe reuses almost none (6.25%), so the standard's
 * neutral branch is under test with no regression direction in play.
 */
function makeGroup(group, overrides = {}) {
  const arms = {
    multiblock: {
      prime: row({ arm: "multiblock", role: "prime", write: 700, input: 900, cost: 0.004, ttft: 900, sentAt: group * 10_000 }),
      probe: row({ arm: "multiblock", role: "probe", read: 600, write: 100, input: 100, cost: 0.0008, ttft: 160, sentAt: group * 10_000 + 60 }),
    },
    nonce: {
      prime: row({ arm: "nonce", role: "prime", write: 700, input: 900, cost: 0.004, ttft: 900, sentAt: group * 10_000 + 10 }),
      probe: row({ arm: "nonce", role: "probe", read: 50, write: 650, input: 100, cost: 0.0011, ttft: 220, sentAt: group * 10_000 + 70 }),
    },
    single: {
      prime: row({ arm: "single", role: "prime", write: 690, input: 900, cost: 0.004, ttft: 890, sentAt: group * 10_000 + 20 }),
      probe: row({ arm: "single", role: "probe", read: 590, write: 110, input: 100, cost: 0.0008, ttft: 165, sentAt: group * 10_000 + 80 }),
    },
  };
  for (const [arm, roles] of Object.entries(overrides.rows ?? {})) {
    for (const [role, patch] of Object.entries(roles)) arms[arm][role] = { ...arms[arm][role], ...patch };
  }
  return {
    group,
    timing: {
      ttlMs: TTL_MS,
      withinTtl: overrides.withinTtl ?? true,
      primeToProbeMs: { multiblock: 60, nonce: 60, single: 60 },
    },
    ...arms,
  };
}

const OK_INTEGRITY = { ok: true, orderMatchesPin: true, divergenceInvariantsOk: true, providerErrors: 0, failures: [] };

function run(groups, integrity = OK_INTEGRITY) {
  return evaluateRun({ groups, integrity });
}

const fiveGroups = (overrides) => [1, 2, 3, 4, 5].map((n) => makeGroup(n, typeof overrides === "function" ? overrides(n) : overrides));

// ─── conclusive neutral under the non-regression standard ───────────

{
  const verdict = run(fiveGroups());
  assert.equal(verdict.cacheConclusion, "neutral");
  assert.equal(verdict.conclusion, "neutral");
  const { cacheStandard: standard } = verdict;
  assert.equal(standard.band.baselineArm, "single", "the single-summary rendering is the baseline");
  assert.equal(standard.band.armUnderTest, "multiblock");
  assert.equal(standard.band.belowBaselinePercentagePoints, NON_REGRESSION_BAND_PP);
  assert.equal(standard.improvement.aboveBaselinePercentagePoints, IMPROVEMENT_MARGIN_PP);
  assert.equal(standard.liveness.controlArm, "nonce");
  assert.equal(standard.liveness.measuredAgainst, "multiblock", "the liveness control is measured against the arm under test");
  assert.equal(standard.liveness.belowMarginPercentagePoints, LIVENESS_MARGIN_PP);
  assert.equal(standard.groupsAggregated, 5);
  assert.equal(standard.cacheActivityObserved, true);
  assert.equal(standard.bandSatisfied, true);
  assert.equal(standard.improvementObserved, false);
  assert.equal(standard.livenessSatisfied, true);
  // The default shape: multiblock 75%, single 73.75%, nonce 6.25%,
  // minimum 68.75%.
  assert.equal(standard.rates.multiblock.rate, 0.75);
  assert.equal(standard.rates.nonce.rate, 0.0625);
  assert.equal(standard.rates.single.rate, 0.7375);
  assert.equal(standard.minimumAcceptableRate, 0.6875);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("non-regression band met")));
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("liveness control alive")));
  assert.equal(verdict.regression.fired, false, "no worse baseline direction in the default shape");
}

// ─── the pinned standard strings and their report bounds ────────────

{
  assert.equal(NON_REGRESSION_BAND_PP, 5);
  assert.equal(IMPROVEMENT_MARGIN_PP, 5);
  assert.equal(LIVENESS_MARGIN_PP, 5);
  for (const text of [HIT_RATE_DEFINITION, HIT_RATE_AGGREGATION, DENOMINATOR_NOTE, DEAD_CONTROL_NOTE]) {
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0 && text.length <= 240, `pinned standard strings stay bounded (${text.length} chars)`);
    for (const phrase of FORBIDDEN_CLAIM_PHRASES) assert.ok(!text.includes(phrase));
  }
  assert.ok(HIT_RATE_DEFINITION.includes("Σ cache_read"));
  assert.ok(DENOMINATOR_NOTE.includes("must not be reused as a cost metric"));
  assert.ok(DEAD_CONTROL_NOTE.includes("#269"), "the dead-control caveat names the open optimization");
}

// ─── hit rate: sums first, then one division ────────────────────────

{
  // Two groups whose per-group multiblock rates are 90% and 0.1%: the pinned
  // aggregation must produce the ratio of sums (1900/12500 ≈ 15.2%), never
  // the mean of per-group ratios (≈63%).
  const groups = fiveGroups();
  groups[0].multiblock.probe = { ...groups[0].multiblock.probe, cacheRead: 90, cacheWrite: 10, inputTokens: 0 };
  groups[1].multiblock.probe = { ...groups[1].multiblock.probe, cacheRead: 10, cacheWrite: 90, inputTokens: 9900 };
  const multiblock = armHitRate(groups, "multiblock");
  assert.equal(multiblock.cacheRead, 90 + 10 + 600 * 3, "cache_read sums across every group's probe");
  assert.equal(multiblock.denominator, 100 + 10_000 + 800 * 3);
  assert.equal(multiblock.rate, Math.round((multiblock.cacheRead / multiblock.denominator) * 1e4) / 1e4);
  const meanOfRatios = (0.9 + 0.001 + 0.75 + 0.75 + 0.75) / 5;
  assert.ok(Math.abs(multiblock.rate - meanOfRatios) > 0.4, "the aggregate is not the mean of per-group ratios");
  // Primes never enter the aggregate, however large their reads.
  groups[2].multiblock.prime = { ...groups[2].multiblock.prime, cacheRead: 999_999 };
  assert.equal(armHitRate(groups, "multiblock").cacheRead, multiblock.cacheRead, "prime reads never enter the probe aggregate");
}

{
  // A zero denominator is a rate that does not exist, never a zero.
  const noInput = { cacheRead: 0, cacheWrite: 0, inputTokens: 0 };
  const groups = fiveGroups();
  for (const group of groups) {
    for (const arm of ["multiblock", "single", "nonce"]) group[arm].probe = { ...group[arm].probe, ...noInput };
  }
  for (const arm of ["multiblock", "single", "nonce"]) {
    assert.equal(armHitRate(groups, arm).rate, null);
  }
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive");
  assert.equal(verdict.cacheStandard.bandSatisfied, null);
  assert.equal(verdict.cacheStandard.livenessSatisfied, null);
  assert.ok(verdict.reasons.some((reason) => reason.includes("denominator is zero")));
}

// ─── the band: at least single − 5pp, inclusive at the edge ─────────

{
  // Exactly 5pp below the baseline passes: single 60%, multiblock 55%.
  const groups = fiveGroups({
    rows: {
      single: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      multiblock: { probe: { cacheRead: 550, cacheWrite: 350, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.rates.single.rate, 0.6);
  assert.equal(verdict.cacheStandard.rates.multiblock.rate, 0.55);
  assert.equal(verdict.cacheStandard.minimumAcceptableRate, 0.55);
  assert.equal(verdict.cacheStandard.bandSatisfied, true, "exactly 5pp below the baseline is within the band");
  assert.equal(verdict.cacheConclusion, "neutral");
}

{
  // One token further below fails the band: a conclusive regressed, because
  // the measurement is alive (nonce far below multiblock) and only the band broke.
  const groups = fiveGroups({
    rows: {
      single: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      multiblock: { probe: { cacheRead: 549, cacheWrite: 351, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.bandSatisfied, false);
  assert.equal(verdict.cacheConclusion, "regressed");
  assert.equal(verdict.conclusion, "regressed");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("non-regression band failed")));
}

// ─── improvement: multiblock must exceed single by the margin ────────

{
  // Exactly 5pp above the baseline is an improvement: single 60%, multiblock 65%.
  const groups = fiveGroups({
    rows: {
      single: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      multiblock: { probe: { cacheRead: 650, cacheWrite: 250, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.improvementObserved, true);
  assert.equal(verdict.cacheConclusion, "improved");
  assert.equal(verdict.conclusion, "improved");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("improvement observed")));
}

{
  // A hair below the improvement margin with a live control stays neutral.
  const groups = fiveGroups({
    rows: {
      single: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      multiblock: { probe: { cacheRead: 649, cacheWrite: 251, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.improvementObserved, false);
  assert.equal(verdict.cacheConclusion, "neutral");
}

// ─── liveness: the nonce control must sit measurably below multiblock ──

{
  // Exactly 5pp below the arm under test is measurably below: alive.
  const groups = fiveGroups({
    rows: { nonce: { probe: { cacheRead: 560, cacheWrite: 140, inputTokens: 100 } } },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.rates.nonce.rate, 0.7);
  assert.equal(verdict.cacheStandard.rates.multiblock.rate, 0.75);
  assert.equal(verdict.cacheStandard.livenessSatisfied, true, "exactly the margin satisfies the liveness control");
  assert.equal(verdict.cacheConclusion, "neutral");
}

{
  // A hair above the margin with a met band: the structurally expected dead
  // control under Pi's placement (#269). The band is met, no improvement is
  // apparent, so the honest label is neutral with the caveat stated verbatim.
  const groups = fiveGroups({
    rows: { nonce: { probe: { cacheRead: 561, cacheWrite: 139, inputTokens: 100 } } },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "neutral", "a dead control with a met band is an honest neutral, not a failure");
  assert.equal(verdict.conclusion, "neutral");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("non-regression band met")));
  assert.ok(verdict.reasons.includes(DEAD_CONTROL_NOTE), "the dead-control caveat is stated verbatim");
}

{
  // A dead control with a failed band still records the loss: the band
  // compares the two arms directly, and a loss is directional evidence.
  const groups = fiveGroups({
    rows: {
      single: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      multiblock: { probe: { cacheRead: 300, cacheWrite: 600, inputTokens: 100 } },
      nonce: { probe: { cacheRead: 300, cacheWrite: 600, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.bandSatisfied, false);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "regressed");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("non-regression band failed")));
  assert.ok(verdict.reasons.includes(DEAD_CONTROL_NOTE));
}

{
  // A dead control with an apparent improvement: the gain cannot be
  // attributed to content, so it stays inconclusive — never a fabricated win.
  const groups = fiveGroups({
    rows: {
      single: { probe: { cacheRead: 300, cacheWrite: 600, inputTokens: 100 } },
      multiblock: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      nonce: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.improvementObserved, true);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "inconclusive", "an improvement claim requires the control alive");
  assert.ok(verdict.reasons.some((reason) => reason.includes("cannot be attributed to content")));
  assert.ok(verdict.reasons.includes(DEAD_CONTROL_NOTE));
}

{
  // The #251 signature: every arm reports the same constant read. The band
  // is trivially met and every group is measurable, so only the liveness
  // control can expose the run as dead — and with no apparent improvement
  // the label is neutral-with-caveat, not a pass.
  const groups = fiveGroups({
    rows: {
      multiblock: { probe: { cacheRead: 1089, cacheWrite: 96, inputTokens: 166 } },
      nonce: { probe: { cacheRead: 1089, cacheWrite: 96, inputTokens: 166 } },
      single: { probe: { cacheRead: 1089, cacheWrite: 96, inputTokens: 166 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.bandSatisfied, true);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "neutral");
  assert.ok(verdict.reasons.includes(DEAD_CONTROL_NOTE));
}

// ─── no cache activity: a rate computed from nothing is not a rate ───

{
  // Reported zeros everywhere with no observed write: the groups classify
  // ambiguous-zero, and the run is inconclusive — never a pass.
  const groups = fiveGroups({
    rows: {
      multiblock: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      nonce: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      single: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
    },
  });
  for (const group of groups) {
    assert.equal(classifyGroup(group).quality, "ambiguous-zero");
  }
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive", "a rate computed from nothing is not a rate");
  assert.equal(verdict.conclusion, "inconclusive");
  assert.ok(verdict.reasons.some((reason) => reason.includes("ambiguous-zero")));
  assert.equal(verdict.cacheStandard.cacheActivityObserved, false);
}

{
  // The same all-zero multiblock arm with one observed write elsewhere in
  // the group makes the zeros attributable: measurable, and the probe-side
  // rates decide. With nonce equal to multiblock the caveat is stated.
  const groups = fiveGroups({
    rows: {
      multiblock: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0, inputTokens: 100 } },
      nonce: { probe: { cacheRead: 0, cacheWrite: 0, inputTokens: 100 } },
      single: { prime: { cacheWrite: 690 }, probe: { cacheRead: 0, cacheWrite: 0, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.groupsAggregated, 5);
  assert.equal(verdict.cacheStandard.cacheActivityObserved, true);
  assert.equal(verdict.cacheConclusion, "neutral");
  assert.ok(verdict.reasons.includes(DEAD_CONTROL_NOTE));
}

{
  // No groups at all (an aborted or empty run): no activity, no rates.
  const verdict = run([], OK_INTEGRITY);
  assert.equal(verdict.cacheConclusion, "inconclusive");
  assert.equal(verdict.cacheStandard.cacheActivityObserved, false);
  assert.equal(verdict.cacheStandard.groupsAggregated, 0);
  assert.ok(verdict.reasons.some((reason) => reason.includes("no arm recorded any cache activity")));
}

// ─── missing report: absent data is not a reported zero ──────────────

{
  const groups = fiveGroups();
  groups[2].nonce.probe.cacheReported = false;
  const classified = classifyGroup(groups[2]);
  assert.equal(classified.quality, "missing-report");
  assert.ok(classified.qualityReasons[0].includes("nonce.probe"), "the reason names the unreported request");
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive", "an unobserved group blocks the whole run even when the other four pass");
  assert.equal(verdict.cacheStandard.groupsAggregated, 4, "rates aggregate only over measurable groups");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("group 3: missing-report")));
}

{
  // The distinguishing rule itself: identical numbers, absent versus reported.
  const absent = makeGroup(1, { rows: { nonce: { probe: { cacheReported: false } } } });
  const zeroed = makeGroup(1, { rows: { multiblock: { probe: { cacheRead: 0 } }, nonce: { probe: { cacheRead: 0 } } } });
  assert.equal(classifyGroup(absent).quality, "missing-report");
  assert.equal(classifyGroup(zeroed).quality, "measurable", "a reported zero with observed writes is measurable data");
}

// ─── TTL and ordering ───────────────────────────────────────────────

{
  const groups = fiveGroups();
  groups[1].timing.withinTtl = false;
  assert.equal(classifyGroup(groups[1]).quality, "ttl-stale");
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive", "an out-of-TTL observation is inconclusive even with non-zero reads");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("group 2: ttl-stale")));
}

{
  // Boundary: a probe sent exactly at the TTL is still within it.
  assert.equal(withinTtl({ multiblock: TTL_MS, nonce: 0, single: 0 }, TTL_MS), true);
  assert.equal(withinTtl({ multiblock: TTL_MS + 1, nonce: 0, single: 0 }, TTL_MS), false);
  // TTL outranks reporting quality: a stale group with absent reports is ttl-stale.
  const staleAndAbsent = makeGroup(1, { withinTtl: false, rows: { nonce: { probe: { cacheReported: false } } } });
  assert.equal(classifyGroup(staleAndAbsent).quality, "ttl-stale");
}

// ─── integrity failure ──────────────────────────────────────────────

{
  const integrity = { ok: false, orderMatchesPin: false, divergenceInvariantsOk: true, providerErrors: 1, failures: ["request order deviated from the pinned interleaved order"] };
  const verdict = run(fiveGroups(), integrity);
  assert.equal(verdict.cacheConclusion, "inconclusive");
  assert.equal(verdict.conclusion, "inconclusive");
  assert.ok(verdict.reasons.includes("run integrity failed; the evidence cannot be interpreted"));
}

// ─── exact edge arithmetic ──────────────────────────────────────────

{
  // The band, improvement, and liveness edges are exact integer comparisons, never floats.
  const a = { cacheRead: 6000, denominator: 10_000 };
  const b = { cacheRead: 5500, denominator: 10_000 };
  assert.equal(rateDifferenceAtLeast(a, b, 5), true, "exactly 5pp above passes an at-least-5pp rule");
  assert.equal(rateDifferenceAtLeast(a, b, 6), false);
  assert.equal(rateDifferenceAtLeast(b, a, -5), true, "exactly 5pp below satisfies the band's lower edge");
  assert.equal(rateDifferenceAtLeast(b, a, -4), false);
  assert.equal(rateDifferenceAtLeast(a, a, 0), true);
}

// ─── per-direction noise floors (#297) ──────────────────────────────

{
  // The projection's structural framing overhead — tens of tokens on a
  // ten-thousand-token request — sits inside the floors and counts equal.
  const group = makeGroup(1, {
    rows: {
      single: { probe: { inputTokens: 100, ttftMs: 160 }, prime: { cacheWrite: 690 } },
      multiblock: { probe: { inputTokens: 137, ttftMs: 181 }, prime: { cacheWrite: 727 } },
    },
  });
  const comparison = compareBaseline(group);
  assert.equal(comparison.directions.inputTokens, "equal", "+37 tokens sits inside the 128-token absolute floor");
  assert.equal(comparison.directions.writeSpend, "equal", "+37 write tokens sit inside the floor");
  assert.equal(comparison.directions.ttft, "equal", "+21ms sits inside the 100ms absolute floor");
  assert.deepEqual(comparison.worseDirections, []);
  assert.equal(comparison.multiDirectionRegression, false);
}

{
  // Any real regression clears the floors by orders of magnitude: a lost
  // cache read rewrites thousands of tokens and the rule still fires.
  const group = makeGroup(1, {
    rows: {
      single: { probe: { cacheRead: 3000, cacheWrite: 300, inputTokens: 100, ttftMs: 160 }, prime: { cacheWrite: 300 } },
      multiblock: { probe: { cacheRead: 0, cacheWrite: 3600, inputTokens: 100, ttftMs: 500 }, prime: { cacheWrite: 300 } },
    },
  });
  const comparison = compareBaseline(group);
  assert.equal(comparison.directions.inputTokens, "equal");
  assert.equal(comparison.directions.writeSpend, "worse", "+3300 write tokens clear the floor");
  assert.equal(comparison.directions.ttft, "worse", "+340ms clears the floor");
  assert.equal(comparison.multiDirectionRegression, true);
}

{
  // The relative component: on a very large baseline the 1% floor exceeds
  // the absolute one, and only excesses beyond it count.
  const group = makeGroup(1, {
    rows: {
      single: { probe: { cacheRead: 0, cacheWrite: 100, inputTokens: 900_000, ttftMs: 160 } },
      multiblock: { probe: { cacheRead: 0, cacheWrite: 100, inputTokens: 905_000, ttftMs: 170 } },
    },
  });
  const comparison = compareBaseline(group);
  assert.equal(comparison.directions.inputTokens, "equal", "+5000 tokens on a 900k baseline sits inside the 1% floor");
  assert.equal(comparison.directions.ttft, "equal");
  for (const [direction, floor] of Object.entries(DIRECTION_NOISE_FLOORS)) {
    assert.ok(floor.absoluteTokens !== undefined || floor.absoluteMs !== undefined, `${direction} pins an absolute floor`);
    assert.ok(floor.relativePercent >= 1, `${direction} pins a relative floor`);
  }
}

// ─── baseline comparison and the regression rule ────────────────────

{
  // Direction computation: multiblock loses input tokens and write spend
  // beyond the noise floors, wins TTFT beyond its floor; cost moves with the
  // token counts and is reported as derived, never counted. Two of three
  // counted directions are worse: a regression.
  const group = makeGroup(1, {
    rows: {
      single: { prime: { cacheWrite: 400 }, probe: { inputTokens: 80, cost: 0.0005, cacheWrite: 50, ttftMs: 400 } },
      multiblock: { probe: { inputTokens: 300 } },
    },
  });
  const comparison = compareBaseline(group);
  assert.equal(comparison.evaluated, true);
  assert.equal(comparison.directions.inputTokens, "worse", "+220 tokens clears the floor");
  assert.equal(comparison.directions.writeSpend, "worse", "800 written versus 450 clears the floor");
  assert.equal(comparison.directions.ttft, "better", "160ms versus 400ms clears the floor");
  assert.deepEqual(comparison.worseDirections.sort(), ["inputTokens", "writeSpend"]);
  assert.equal(comparison.derived.cost, "worse", "cost is reported as a derived figure");
  assert.equal(comparison.multiDirectionRegression, true);
}

{
  // #268 defect 2: writeSpend worse with cost moving in lockstep (it derives
  // from the token counts) and every other counted direction equal. Under the
  // old four-direction rule this fired the two-direction threshold from one
  // real movement; it must not fire now.
  const group = makeGroup(1, {
    rows: {
      single: { prime: { cacheWrite: 600 }, probe: { cacheWrite: 0, inputTokens: 100, ttftMs: 160, cost: 0.0005 } },
      multiblock: { probe: { inputTokens: 100, ttftMs: 160 } },
    },
  });
  const comparison = compareBaseline(group);
  assert.equal(comparison.directions.inputTokens, "equal");
  assert.equal(comparison.directions.writeSpend, "worse", "700+100 written versus 600+0 clears the floor");
  assert.equal(comparison.directions.ttft, "equal");
  assert.equal(comparison.derived.cost, "worse", "the derived figure moves in lockstep with the token counts");
  assert.deepEqual(comparison.worseDirections, ["writeSpend"], "the lockstep cost figure is not counted beside it");
  assert.equal(comparison.multiDirectionRegression, false, "one independent worse direction is not a multi-direction regression");
}

{
  // TTFT absent on the single probe: the direction is unreported and cannot
  // count toward a regression.
  const group = makeGroup(1, {
    rows: {
      single: { prime: { cacheWrite: 400 }, probe: { inputTokens: 80, cost: 0.0005, cacheWrite: 50, ttftMs: null } },
      multiblock: { probe: { inputTokens: 300 } },
    },
  });
  const comparison = compareBaseline(group);
  assert.equal(comparison.directions.ttft, "unreported");
  assert.deepEqual(comparison.worseDirections.sort(), ["inputTokens", "writeSpend"]);
  assert.equal(comparison.multiDirectionRegression, true, "two-plus measured worse directions still suffice");
}

{
  // An absent single cache report makes the comparison unevaluated.
  const group = makeGroup(1, { rows: { single: { probe: { cacheReported: false } } } });
  const comparison = compareBaseline(group);
  assert.equal(comparison.evaluated, false);
  assert.deepEqual(comparison.worseDirections, []);
}

{
  // Clear regression: four of five groups regress in two counted directions
  // each (write spend and TTFT beyond their floors), with the derived cost
  // moving along. Only prime-side writes and probe timing move, so the
  // probe-side hit rates — and with them the cache standard's own verdict —
  // stay on the neutral branch while the rule overrides the final label.
  const verdict = run(fiveGroups((n) => (n <= 4 ? { rows: { single: { prime: { cacheWrite: 100 }, probe: { ttftMs: 40 } } } } : {})));
  assert.equal(verdict.cacheConclusion, "neutral", "the cache standard still concludes on its own axis");
  assert.equal(verdict.conclusion, "regression", "the regression rule overrides the final label");
  assert.equal(verdict.regression.groupsRegressed, REGRESSION_GROUP_THRESHOLD);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("baseline regression rule fired")));
}

{
  // Three regressed groups do not fire the four-of-five rule.
  const verdict = run(fiveGroups((n) => (n <= 3 ? { rows: { single: { prime: { cacheWrite: 100 }, probe: { ttftMs: 40 } } } } : {})));
  assert.equal(verdict.regression.fired, false);
  assert.equal(verdict.conclusion, "neutral");
}

{
  // Regression requires multiple directions: the default shape has none.
  const verdict = run(fiveGroups());
  assert.equal(verdict.regression.groupsRegressed, 0);
  for (const group of verdict.groups) {
    assert.ok(
      group.baselineComparison.worseDirections.length < REGRESSION_DIRECTION_THRESHOLD
      || group.baselineComparison.multiDirectionRegression,
    );
  }
  assert.deepEqual(BASELINE_DIRECTIONS, ["inputTokens", "writeSpend", "ttft"], "only independent directions are counted");
  assert.deepEqual(DERIVED_FIGURES, ["cost"]);
  assert.ok(!("cost" in DIRECTION_NOTES), "the derived figure carries no direction note");
  for (const note of Object.values(DIRECTION_NOTES)) {
    assert.ok(note.includes("independent"), "each note states why its direction is independent");
    assert.ok(note.length <= 240 && note.length > 0, `direction notes stay bounded (${note.length} chars)`);
    for (const phrase of FORBIDDEN_CLAIM_PHRASES) assert.ok(!note.includes(phrase));
  }
  assert.ok(COST_DERIVATION_NOTE.includes("never counted as a regression direction"));
}

// ─── medians ────────────────────────────────────────────────────────

{
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
}

{
  // TTFT dispersion alongside the median delta (#268 defect 3): the summary
  // states the span the per-group deltas cover, so a median delta smaller
  // than the spread cannot read as a finding. Deltas of −100, 0, +300, +50,
  // +150 across five groups: median +50, spread 400.
  const groups = fiveGroups((n) => ({ rows: { single: { probe: { ttftMs: 160 - [-100, 0, 300, 50, 150][n - 1] } } } }));
  const summary = baselineMedians(run(groups).groups);
  assert.equal(summary.perDirection.ttft.spreadMs, 400, "max delta minus min delta over the evaluated groups");
  assert.equal(summary.perDirection.ttft.medianDelta, 50);
  assert.ok(!("spreadMs" in summary.perDirection.inputTokens), "dispersion is stated for the timing direction");
  // With fewer than two observed deltas there is no spread to state.
  const single = [makeGroup(1)];
  assert.equal(baselineMedians(run(single).groups).perDirection.ttft.spreadMs, null);
}

console.log("verdict.test.mjs: all verdict branches passed");
