import assert from "node:assert/strict";
import {
  COST_DERIVATION_NOTE,
  DENOMINATOR_NOTE,
  DIRECTION_NOTES,
  DERIVED_FIGURES,
  FORBIDDEN_CLAIM_PHRASES,
  HIT_RATE_AGGREGATION,
  HIT_RATE_DEFINITION,
  LIVENESS_MARGIN_PP,
  NATIVE_DIRECTIONS,
  NON_REGRESSION_BAND_PP,
  REGRESSION_DIRECTION_THRESHOLD,
  REGRESSION_GROUP_THRESHOLD,
  armHitRate,
  classifyGroup,
  compareNative,
  evaluateRun,
  median,
  nativeMedians,
  rateDifferenceAtLeast,
  withinTtl,
} from "./verdict.mjs";

/**
 * Verdict-rule coverage for the provider-cache experiment (#225, standard
 * re-pinned by #260, directions re-modeled by #268). Every branch is driven
 * with constructed evidence — no provider, no credentials — because the
 * rules, not the plumbing, are the deliverable: ambiguous or dead evidence is
 * inconclusive, never a miss and never a pass, the non-regression band is
 * exercised exactly at its edge, the liveness control is exercised at its
 * margin, the counted directions are proven independent (a derived cost move
 * can never fire the regression rule alone), and the pinned hit-rate
 * aggregation is proven to sum first and divide once.
 */

const TTL_MS = 300_000;

function row({ arm, role, reported = true, read = 0, write = 0, input = 120, cost = 0.001, ttft = 200, sentAt = 0 }) {
  return { arm, role, cacheReported: reported, cacheRead: read, cacheWrite: write, inputTokens: input, outputTokens: 50, cost, ttftMs: ttft, sentAtMs: sentAt };
}

/**
 * A default positive-shaped group: the stable arm's probe reuses most of its
 * input (75%), the nonce control's probe reuses almost none (6.25%), and the
 * native baseline sits between them (12.5%) with no worse native direction,
 * so the regression rule stays out of the picture while the standard is under
 * test.
 */
function makeGroup(group, overrides = {}) {
  const arms = {
    stable: {
      prime: row({ arm: "stable", role: "prime", write: 700, input: 900, cost: 0.004, ttft: 900, sentAt: group * 10_000 }),
      probe: row({ arm: "stable", role: "probe", read: 600, write: 100, input: 100, cost: 0.0008, ttft: 160, sentAt: group * 10_000 + 60 }),
    },
    nonce: {
      prime: row({ arm: "nonce", role: "prime", write: 700, input: 900, cost: 0.004, ttft: 900, sentAt: group * 10_000 + 10 }),
      probe: row({ arm: "nonce", role: "probe", read: 50, write: 650, input: 100, cost: 0.0011, ttft: 220, sentAt: group * 10_000 + 70 }),
    },
    native: {
      prime: row({ arm: "native", role: "prime", write: 690, input: 900, cost: 0.004, ttft: 890, sentAt: group * 10_000 + 20 }),
      probe: row({ arm: "native", role: "probe", read: 100, write: 600, input: 100, cost: 0.0016, ttft: 300, sentAt: group * 10_000 + 80 }),
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
      primeToProbeMs: { stable: 60, nonce: 60, native: 60 },
    },
    ...arms,
  };
}

const OK_INTEGRITY = { ok: true, orderMatchesPin: true, divergenceInvariantsOk: true, providerErrors: 0, failures: [] };

function run(groups, integrity = OK_INTEGRITY) {
  return evaluateRun({ groups, integrity });
}

const fiveGroups = (overrides) => [1, 2, 3, 4, 5].map((n) => makeGroup(n, typeof overrides === "function" ? overrides(n) : overrides));

// ─── conclusive positive under the non-regression standard ──────────

{
  const verdict = run(fiveGroups());
  assert.equal(verdict.cacheConclusion, "positive");
  assert.equal(verdict.conclusion, "positive");
  const { cacheStandard: standard } = verdict;
  assert.equal(standard.band.baselineArm, "native", "Pi native is the baseline");
  assert.equal(standard.band.armUnderTest, "stable");
  assert.equal(standard.band.belowBaselinePercentagePoints, NON_REGRESSION_BAND_PP);
  assert.equal(standard.liveness.controlArm, "nonce");
  assert.equal(standard.liveness.measuredAgainst, "stable", "the liveness control is measured against the arm under test");
  assert.equal(standard.liveness.belowMarginPercentagePoints, LIVENESS_MARGIN_PP);
  assert.equal(standard.groupsAggregated, 5);
  assert.equal(standard.cacheActivityObserved, true);
  assert.equal(standard.bandSatisfied, true);
  assert.equal(standard.livenessSatisfied, true);
  // The default shape: stable 75%, nonce 6.25%, native 12.5%, minimum 7.5%.
  assert.equal(standard.rates.stable.rate, 0.75);
  assert.equal(standard.rates.nonce.rate, 0.0625);
  assert.equal(standard.rates.native.rate, 0.125);
  assert.equal(standard.minimumAcceptableStableRate, 0.075);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("non-regression band met")));
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("liveness control alive")));
  assert.equal(verdict.regression.fired, false, "no worse native direction in the default shape");
}

// ─── the pinned hit-rate definition and its report strings ──────────

{
  assert.equal(NON_REGRESSION_BAND_PP, 5);
  assert.equal(LIVENESS_MARGIN_PP, 5);
  for (const text of [HIT_RATE_DEFINITION, HIT_RATE_AGGREGATION, DENOMINATOR_NOTE]) {
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0 && text.length <= 240, `pinned standard strings stay bounded (${text.length} chars)`);
    for (const phrase of FORBIDDEN_CLAIM_PHRASES) assert.ok(!text.includes(phrase));
  }
  assert.ok(HIT_RATE_DEFINITION.includes("Σ cache_read"));
  assert.ok(DENOMINATOR_NOTE.includes("must not be reused as a cost metric"));
}

// ─── hit rate: sums first, then one division ────────────────────────

{
  // Two groups whose per-group stable rates are 90% and 0.1%: the pinned
  // aggregation must produce the ratio of sums (1900/12500 ≈ 15.2%), never
  // the mean of per-group ratios (≈63%).
  const groups = fiveGroups();
  groups[0].stable.probe = { ...groups[0].stable.probe, cacheRead: 90, cacheWrite: 10, inputTokens: 0 };
  groups[1].stable.probe = { ...groups[1].stable.probe, cacheRead: 10, cacheWrite: 90, inputTokens: 9900 };
  const stable = armHitRate(groups, "stable");
  assert.equal(stable.cacheRead, 90 + 10 + 600 * 3, "cache_read sums across every group's probe");
  assert.equal(stable.denominator, 100 + 10_000 + 800 * 3);
  assert.equal(stable.rate, Math.round((stable.cacheRead / stable.denominator) * 1e4) / 1e4);
  const meanOfRatios = (0.9 + 0.001 + 0.75 + 0.75 + 0.75) / 5;
  assert.ok(Math.abs(stable.rate - meanOfRatios) > 0.4, "the aggregate is not the mean of per-group ratios");
  // Primes never enter the aggregate, however large their reads.
  groups[2].stable.prime = { ...groups[2].stable.prime, cacheRead: 999_999 };
  assert.equal(armHitRate(groups, "stable").cacheRead, stable.cacheRead, "prime reads never enter the probe aggregate");
}

{
  // A zero denominator is a rate that does not exist, never a zero.
  const noInput = { cacheRead: 0, cacheWrite: 0, inputTokens: 0 };
  const groups = fiveGroups();
  for (const group of groups) {
    for (const arm of ["stable", "nonce", "native"]) group[arm].probe = { ...group[arm].probe, ...noInput };
  }
  for (const arm of ["stable", "nonce", "native"]) {
    assert.equal(armHitRate(groups, arm).rate, null);
  }
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive");
  assert.equal(verdict.cacheStandard.bandSatisfied, null);
  assert.equal(verdict.cacheStandard.livenessSatisfied, null);
  assert.ok(verdict.reasons.some((reason) => reason.includes("denominator is zero")));
}

// ─── the band: at least native − 5pp, inclusive at the edge ─────────

{
  // Exactly 5pp below the baseline passes: native 60%, stable 55%.
  const groups = fiveGroups({
    rows: {
      native: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      stable: { probe: { cacheRead: 550, cacheWrite: 350, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.rates.native.rate, 0.6);
  assert.equal(verdict.cacheStandard.rates.stable.rate, 0.55);
  assert.equal(verdict.cacheStandard.minimumAcceptableStableRate, 0.55);
  assert.equal(verdict.cacheStandard.bandSatisfied, true, "exactly 5pp below the baseline is within the band");
  assert.equal(verdict.cacheConclusion, "positive");
}

{
  // One token further below fails the band: a conclusive negative, because
  // the measurement is alive (nonce far below stable) and only the band broke.
  const groups = fiveGroups({
    rows: {
      native: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      stable: { probe: { cacheRead: 549, cacheWrite: 351, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.bandSatisfied, false);
  assert.equal(verdict.cacheConclusion, "negative");
  assert.equal(verdict.conclusion, "negative");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("non-regression band failed")));
}

// ─── liveness: the nonce control must sit measurably below stable ───

{
  // Exactly 5pp below the arm under test is measurably below: alive.
  const groups = fiveGroups({
    rows: { nonce: { probe: { cacheRead: 560, cacheWrite: 140, inputTokens: 100 } } },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.rates.nonce.rate, 0.7);
  assert.equal(verdict.cacheStandard.rates.stable.rate, 0.75);
  assert.equal(verdict.cacheStandard.livenessSatisfied, true, "exactly the margin satisfies the liveness control");
  assert.equal(verdict.cacheConclusion, "positive");
}

{
  // A hair above the margin: the measurement cannot distinguish content.
  const groups = fiveGroups({
    rows: { nonce: { probe: { cacheRead: 561, cacheWrite: 139, inputTokens: 100 } } },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "inconclusive", "a dead measurement is never a pass, however well the band holds");
  assert.equal(verdict.conclusion, "inconclusive");
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("liveness control dead")));
}

{
  // The #251 signature: every arm reports the same constant read. The band
  // is trivially met and every group is measurable, so only the liveness
  // control can expose the run as dead.
  const groups = fiveGroups({
    rows: {
      stable: { probe: { cacheRead: 1089, cacheWrite: 96, inputTokens: 166 } },
      nonce: { probe: { cacheRead: 1089, cacheWrite: 96, inputTokens: 166 } },
      native: { probe: { cacheRead: 1089, cacheWrite: 96, inputTokens: 166 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.bandSatisfied, true);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "inconclusive");
  assert.ok(verdict.reasons.some((reason) => reason.includes("liveness control dead")));
}

{
  // A dead liveness control outranks a failed band: the run stays
  // inconclusive rather than recording a miss from numbers it cannot trust.
  const groups = fiveGroups({
    rows: {
      native: { probe: { cacheRead: 600, cacheWrite: 300, inputTokens: 100 } },
      stable: { probe: { cacheRead: 300, cacheWrite: 600, inputTokens: 100 } },
      nonce: { probe: { cacheRead: 300, cacheWrite: 600, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.bandSatisfied, false);
  assert.equal(verdict.cacheStandard.livenessSatisfied, false);
  assert.equal(verdict.cacheConclusion, "inconclusive");
}

// ─── no cache activity: a rate computed from nothing is not a rate ───

{
  // Reported zeros everywhere with no observed write: the groups classify
  // ambiguous-zero, and the run is inconclusive — never a pass.
  const groups = fiveGroups({
    rows: {
      stable: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      nonce: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      native: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
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
  // The same all-zero stable arm with one observed write elsewhere in the
  // group makes the zeros attributable: measurable, and the probe-side rates
  // decide. With nonce equal to stable the liveness control still blocks.
  const groups = fiveGroups({
    rows: {
      stable: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0, inputTokens: 100 } },
      nonce: { probe: { cacheRead: 0, cacheWrite: 0, inputTokens: 100 } },
      native: { prime: { cacheWrite: 690 }, probe: { cacheRead: 0, cacheWrite: 0, inputTokens: 100 } },
    },
  });
  const verdict = run(groups);
  assert.equal(verdict.cacheStandard.groupsAggregated, 5);
  assert.equal(verdict.cacheStandard.cacheActivityObserved, true);
  assert.equal(verdict.cacheConclusion, "inconclusive", "all-zero probe rates are dead evidence, not a band pass");
  assert.ok(verdict.reasons.some((reason) => reason.includes("liveness control dead")));
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
  const zeroed = makeGroup(1, { rows: { stable: { probe: { cacheRead: 0 } }, nonce: { probe: { cacheRead: 0 } } } });
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
  assert.equal(withinTtl({ stable: TTL_MS, nonce: 0, native: 0 }, TTL_MS), true);
  assert.equal(withinTtl({ stable: TTL_MS + 1, nonce: 0, native: 0 }, TTL_MS), false);
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
  // The band and liveness edges are exact integer comparisons, never floats.
  const a = { cacheRead: 6000, denominator: 10_000 };
  const b = { cacheRead: 5500, denominator: 10_000 };
  assert.equal(rateDifferenceAtLeast(a, b, 5), true, "exactly 5pp above passes an at-least-5pp rule");
  assert.equal(rateDifferenceAtLeast(a, b, 6), false);
  assert.equal(rateDifferenceAtLeast(b, a, -5), true, "exactly 5pp below satisfies the band's lower edge");
  assert.equal(rateDifferenceAtLeast(b, a, -4), false);
  assert.equal(rateDifferenceAtLeast(a, a, 0), true);
}

// ─── native comparison and the regression rule (#225, directions #268) ──

{
  // Direction computation: stable loses input tokens and write spend, wins
  // TTFT; cost moves with the token counts and is reported as derived, never
  // counted. Two of three counted directions are worse: a regression.
  const group = makeGroup(1, {
    rows: {
      native: { probe: { inputTokens: 80, cost: 0.0005, cacheWrite: 50 } },
    },
  });
  const comparison = compareNative(group);
  assert.equal(comparison.evaluated, true);
  assert.deepEqual(comparison.worseDirections.sort(), ["inputTokens", "writeSpend"]);
  assert.equal(comparison.derived.cost, "worse", "cost is reported as a derived figure");
  assert.equal(comparison.directions.ttft, "better", "160ms versus the default 300ms native probe");
  assert.equal(comparison.multiDirectionRegression, true);
}

{
  // #268 defect 2: writeSpend worse with cost moving in lockstep (it derives
  // from the token counts) and every other counted direction equal. Under the
  // old four-direction rule this fired the two-direction threshold from one
  // real movement; it must not fire now.
  const group = makeGroup(1, {
    rows: {
      native: { prime: { cacheWrite: 600 }, probe: { cacheWrite: 0, inputTokens: 100, ttftMs: 160, cost: 0.0005 } },
      stable: { probe: { inputTokens: 100, ttftMs: 160 } },
    },
  });
  const comparison = compareNative(group);
  assert.equal(comparison.directions.inputTokens, "equal");
  assert.equal(comparison.directions.writeSpend, "worse", "700+100 written versus 600+0");
  assert.equal(comparison.directions.ttft, "equal");
  assert.equal(comparison.derived.cost, "worse", "the derived figure moves in lockstep with the token counts");
  assert.deepEqual(comparison.worseDirections, ["writeSpend"], "the lockstep cost figure is not counted beside it");
  assert.equal(comparison.multiDirectionRegression, false, "one independent worse direction is not a multi-direction regression");
}

{
  // TTFT absent on the native probe: the direction is unreported and cannot
  // count toward a regression.
  const group = makeGroup(1, { rows: { native: { probe: { inputTokens: 80, cost: 0.0005, cacheWrite: 50, ttftMs: null } } } });
  const comparison = compareNative(group);
  assert.equal(comparison.directions.ttft, "unreported");
  assert.deepEqual(comparison.worseDirections.sort(), ["inputTokens", "writeSpend"]);
  assert.equal(comparison.multiDirectionRegression, true, "two-plus measured worse directions still suffice");
}


{
  // An absent native cache report makes the comparison unevaluated.
  const group = makeGroup(1, { rows: { native: { probe: { cacheReported: false } } } });
  const comparison = compareNative(group);
  assert.equal(comparison.evaluated, false);
  assert.deepEqual(comparison.worseDirections, []);
}

{
  // Clear regression: four of five groups regress in two counted directions
  // each (uncached input and TTFT), with the derived cost moving along.
  const verdict = run(fiveGroups((n) => (n <= 4 ? { rows: { native: { probe: { inputTokens: 80, cost: 0.0005, ttftMs: 120 } } } } : {})));
  assert.equal(verdict.cacheConclusion, "positive", "the cache standard still passes on its own axis");
  assert.equal(verdict.conclusion, "regression", "the regression rule overrides the final label");
  assert.equal(verdict.regression.groupsRegressed, REGRESSION_GROUP_THRESHOLD);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("native regression rule fired")));
}

{
  // Three regressed groups do not fire the four-of-five rule.
  const verdict = run(fiveGroups((n) => (n <= 3 ? { rows: { native: { probe: { inputTokens: 80, cost: 0.0005, ttftMs: 120 } } } } : {})));
  assert.equal(verdict.regression.fired, false);
  assert.equal(verdict.conclusion, "positive");
}

{
  // Regression requires multiple directions: the default shape has none.
  const verdict = run(fiveGroups());
  assert.equal(verdict.regression.groupsRegressed, 0);
  for (const group of verdict.groups) {
    assert.ok(
      group.nativeComparison.worseDirections.length < REGRESSION_DIRECTION_THRESHOLD
      || group.nativeComparison.multiDirectionRegression,
    );
  }
  assert.deepEqual(NATIVE_DIRECTIONS, ["inputTokens", "writeSpend", "ttft"], "only independent directions are counted");
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
  const groups = fiveGroups((n) => ({ rows: { native: { probe: { ttftMs: 160 - [-100, 0, 300, 50, 150][n - 1] } } } }));
  const summary = nativeMedians(run(groups).groups);
  assert.equal(summary.perDirection.ttft.spreadMs, 400, "max delta minus min delta over the evaluated groups");
  assert.equal(summary.perDirection.ttft.medianDelta, 50);
  assert.ok(!("spreadMs" in summary.perDirection.inputTokens), "dispersion is stated for the timing direction");
  // With fewer than two observed deltas there is no spread to state.
  const single = [makeGroup(1)];
  assert.equal(nativeMedians(run(single).groups).perDirection.ttft.spreadMs, null);
}
console.log("verdict.test.mjs: all verdict branches passed");
