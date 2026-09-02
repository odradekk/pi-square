/**
 * Verdict rules for the provider-cache experiment (#225, standard re-pinned by
 * #260, authority #215; measured evidence #251).
 *
 * The experiment measures non-regression, not superiority: the release verdict
 * is forbidden from making any provider-cache claim (#227), so the standard's
 * job is only to rule out a loss.
 *
 * Evidence quality, unchanged from #225:
 *
 * - A provider-reported zero is data; an absent cache report is not. A group
 *   whose probe never reported cache values is `missing-report`, and a group
 *   where every request reported zero without a single observed write is
 *   `ambiguous-zero` — the zeros cannot be attributed, because nothing shows
 *   the provider was caching at all. Both are inconclusive, never a miss and
 *   never a pass (#215: "Treat absent or ambiguous zero cache reporting as
 *   inconclusive and release-blocking").
 * - A run is conclusive only when all five groups are measurable.
 *
 * The standard (#260, from the maintainer decision recorded on #251):
 *
 * - `hitRate(arm)` is pinned as the share of total input served from cache,
 *   aggregated per arm across the groups' probe requests:
 *   `Σ cache_read / Σ (cache_read + cache_creation + uncached_input)`.
 *   Sum first, then divide — never a mean of per-group ratios. The arms'
 *   denominators differ because Context Memory compresses; the ratio answers
 *   "what share of what was sent came from cache" and must not be reused as a
 *   cost metric.
 * - Non-regression band: `hitRate(stable)` must be at least
 *   `hitRate(native) − 5 percentage points`. Pi native is the baseline, and
 *   the band claims no benefit — it only rules out a loss.
 * - Liveness: the `nonce` control must sit measurably below the arm under
 *   test. Its prefix diverges at the earliest block, so it can legitimately
 *   reuse no more than the append-only stable arm; a run where it does not is
 *   a run whose cache reads do not track content — the #251 signature, where
 *   every probe read the same constant regardless of arm. Such a run is
 *   inconclusive: the measurement is dead, which is neither a pass (nothing
 *   regressed) nor a miss. The control is measured against `stable`, not
 *   against the native baseline: the native arm's regenerated summary
 *   diverges at its head, so by construction the nonce arm can never sit
 *   below the native rate, and a nonce-versus-native rule could not hold in
 *   any honest measurement.
 * - A run in which no arm records any cache activity at all is inconclusive:
 *   a rate computed from nothing is not a rate.
 *
 * The Pi-native comparison and the four-of-five multi-direction regression
 * rule are unchanged from #225 and evaluated independently; firing the
 * regression rule still overrides the final label while the cache conclusion
 * stays visible beside it. No statistical significance and no
 * provider-neutral superiority is claimed anywhere.
 */

export const REGRESSION_GROUP_THRESHOLD = 4;
export const REGRESSION_DIRECTION_THRESHOLD = 2;
export const NATIVE_DIRECTIONS = ["inputTokens", "writeSpend", "cost", "ttft"];

/** The three arms the standard is defined over; pinned by the fixture. */
const STANDARD_ARMS = ["stable", "nonce", "native"];

/** Non-regression band: stable may sit at most this far below native. */
export const NON_REGRESSION_BAND_PP = 5;

/** Liveness margin: the nonce control must sit at least this far below stable. */
export const LIVENESS_MARGIN_PP = 5;

/** The pinned hit-rate definition, restated in the report verbatim. */
export const HIT_RATE_DEFINITION =
  "share of total input served from cache: Σ cache_read / Σ (cache_read + cache_creation + uncached_input), per arm over the groups' probe requests, summed first then divided";

/** How the rate is aggregated; restated in the report verbatim. */
export const HIT_RATE_AGGREGATION =
  "per arm over the measurable groups' probe requests (all five in a conclusive run); sums first, then one division — never a mean of per-group ratios";

/** Why the ratio must not be reused as a cost metric; restated verbatim. */
export const DENOMINATOR_NOTE =
  "the arms' denominators differ because Context Memory compresses; the ratio answers what share of what was sent came from cache and must not be reused as a cost metric";

export const FRAMING_DISCLAIMER =
  "Measured, best-effort observation on one provider and model through the pinned adapter. "
  + "No statistical significance or provider-neutral superiority is claimed; nothing here generalizes beyond this run.";

/** Claim phrases a report must never contain. */
export const FORBIDDEN_CLAIM_PHRASES = [
  "statistically significant",
  "guaranteed",
  "proves that",
  "outperforms",
];

/**
 * TTL rule: every arm's probe must follow its prime within the pinned TTL.
 * Equality counts as within — the entry is still live at send time.
 */
export function withinTtl(primeToProbeMs, ttlMs) {
  return Object.values(primeToProbeMs).every((elapsed) => elapsed <= ttlMs);
}

/**
 * Classifies one group's evidence. Check order is fixed and meaningful:
 * execution validity first (an out-of-TTL observation cannot interpret cache
 * values either way), then report presence, then attribution.
 */
export function classifyGroup(group) {
  if (!group.timing.withinTtl) {
    return {
      quality: "ttl-stale",
      qualityReasons: [`a probe followed its prime after more than the pinned ${group.timing.ttlMs}ms TTL`],
    };
  }
  const causal = [group.stable.prime, group.stable.probe, group.nonce.prime, group.nonce.probe];
  const absent = causal.filter((row) => !row.cacheReported).map((row) => `${row.arm}.${row.role}`);
  if (absent.length > 0) {
    return {
      quality: "missing-report",
      qualityReasons: [`provider reported no cache value for ${absent.join(", ")}`],
    };
  }
  const allRequests = [...causal, group.native.prime, group.native.probe];
  const cacheEngaged = allRequests.some((row) => row.cacheRead > 0 || row.cacheWrite > 0);
  if (!cacheEngaged) {
    return {
      quality: "ambiguous-zero",
      qualityReasons: ["every request reported zero and no cache write was observed anywhere in the group, so the zeros cannot be attributed"],
    };
  }
  return { quality: "measurable", qualityReasons: [] };
}

function armCost(arm) {
  return arm.prime.cost + arm.probe.cost;
}

function armWriteTokens(arm) {
  return arm.prime.cacheWrite + arm.probe.cacheWrite;
}

function directionOf(stableValue, nativeValue) {
  if (stableValue > nativeValue) return "worse";
  if (stableValue < nativeValue) return "better";
  return "equal";
}

/**
 * The Pi-native comparison for one group: which of the four measured
 * directions the stable arm lost. Evaluated only when both arms' requests
 * reported cache values; an unmeasured TTFT stays `unreported` rather than
 * counting as any direction.
 */
export function compareNative(group) {
  const rows = [group.stable.prime, group.stable.probe, group.native.prime, group.native.probe];
  if (rows.some((row) => !row.cacheReported)) {
    return {
      evaluated: false,
      missing: ["cache report absent on the stable or native arm"],
      directions: {},
      worseDirections: [],
      multiDirectionRegression: false,
    };
  }
  const directions = {
    inputTokens: directionOf(group.stable.probe.inputTokens, group.native.probe.inputTokens),
    writeSpend: directionOf(armWriteTokens(group.stable), armWriteTokens(group.native)),
    cost: directionOf(armCost(group.stable), armCost(group.native)),
  };
  if (group.stable.probe.ttftMs == null || group.native.probe.ttftMs == null) {
    directions.ttft = "unreported";
  } else {
    directions.ttft = directionOf(group.stable.probe.ttftMs, group.native.probe.ttftMs);
  }
  const worseDirections = NATIVE_DIRECTIONS.filter((direction) => directions[direction] === "worse");
  return {
    evaluated: true,
    missing: [],
    directions,
    worseDirections,
    multiDirectionRegression: worseDirections.length >= REGRESSION_DIRECTION_THRESHOLD,
  };
}

/** Median of a numeric list; null when the list is empty. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Native comparison summary across the run: per-direction median deltas
 * (stable minus native) and per-arm medians over the evaluated groups.
 */
export function nativeMedians(classifiedGroups) {
  const evaluated = classifiedGroups.filter((group) => group.nativeComparison.evaluated);
  const perDirection = {};
  for (const direction of NATIVE_DIRECTIONS) {
    const deltas = evaluated
      .map((group) => {
        if (direction === "inputTokens") return group.stable.probe.inputTokens - group.native.probe.inputTokens;
        if (direction === "writeSpend") return armWriteTokens(group.stable) - armWriteTokens(group.native);
        if (direction === "cost") return armCost(group.stable) - armCost(group.native);
        if (group.stable.probe.ttftMs == null || group.native.probe.ttftMs == null) return null;
        return group.stable.probe.ttftMs - group.native.probe.ttftMs;
      })
      .filter((delta) => delta !== null);
    perDirection[direction] = {
      medianDelta: deltas.length > 0 ? Math.round(median(deltas) * 1e6) / 1e6 : null,
      worse: evaluated.filter((group) => group.nativeComparison.directions[direction] === "worse").length,
      better: evaluated.filter((group) => group.nativeComparison.directions[direction] === "better").length,
      equal: evaluated.filter((group) => group.nativeComparison.directions[direction] === "equal").length,
      unreported: classifiedGroups.length - deltas.length,
    };
  }
  return {
    groupsEvaluated: evaluated.length,
    perDirection,
    armMedians: {
      probeInputTokens: {
        stable: median(evaluated.map((group) => group.stable.probe.inputTokens)),
        native: median(evaluated.map((group) => group.native.probe.inputTokens)),
      },
      writeTokens: {
        stable: median(evaluated.map((group) => armWriteTokens(group.stable))),
        native: median(evaluated.map((group) => armWriteTokens(group.native))),
      },
      cost: {
        stable: median(evaluated.map((group) => armCost(group.stable))),
        native: median(evaluated.map((group) => armCost(group.native))),
      },
      probeTtftMs: {
        stable: median(evaluated.map((group) => group.stable.probe.ttftMs).filter((value) => value !== null)),
        native: median(evaluated.map((group) => group.native.probe.ttftMs).filter((value) => value !== null)),
      },
    },
  };
}

/**
 * One arm's pinned hit rate over the given (measurable) groups' probe
 * requests: sums first, then divides once. `rate` is null when the
 * denominator is zero — a rate that does not exist is never a zero.
 */
export function armHitRate(groups, arm) {
  let cacheRead = 0;
  let cacheCreation = 0;
  let uncachedInput = 0;
  for (const group of groups) {
    const probe = group[arm].probe;
    cacheRead += probe.cacheRead;
    cacheCreation += probe.cacheWrite;
    uncachedInput += probe.inputTokens;
  }
  const denominator = cacheRead + cacheCreation + uncachedInput;
  return {
    cacheRead,
    cacheCreation,
    uncachedInput,
    denominator,
    rate: denominator > 0 ? Math.round((cacheRead / denominator) * 1e4) / 1e4 : null,
  };
}

/**
 * Exact `rate(a) − rate(b) ≥ percentagePoints / 100` over the integer sums:
 * cross-multiplied so the band and liveness edges never depend on floating
 * point. `percentagePoints` may be negative.
 */
export function rateDifferenceAtLeast(a, b, percentagePoints) {
  const left = 100 * (a.cacheRead * b.denominator - b.cacheRead * a.denominator);
  const right = percentagePoints * a.denominator * b.denominator;
  return left >= right;
}

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * The run verdict. Integrity failure, any non-measurable group, a run with no
 * cache activity anywhere, or a dead liveness control makes the conclusion
 * inconclusive; only a fully observed, alive run can conclude positive
 * (non-regression band met) or negative (stable sits more than the band below
 * the native baseline). The regression rule is evaluated independently over
 * the groups whose native comparison was complete, and firing it overrides
 * the final label while the cache conclusion stays visible beside it.
 */
export function evaluateRun({ groups, integrity }) {
  const classified = groups.map((group) => ({
    ...group,
    ...classifyGroup(group),
    nativeComparison: compareNative(group),
  }));
  const measurable = classified.filter((group) => group.quality === "measurable");

  const reasons = [];
  if (!integrity.ok) {
    reasons.push(...integrity.failures.slice(0, 8));
    reasons.push("run integrity failed; the evidence cannot be interpreted");
  }
  for (const group of classified) {
    if (group.quality !== "measurable") {
      reasons.push(`group ${group.group}: ${group.quality} (${group.qualityReasons[0]})`);
    }
  }

  const rates = {};
  for (const arm of STANDARD_ARMS) rates[arm] = armHitRate(measurable, arm);
  const rateExists = STANDARD_ARMS.every((arm) => rates[arm].denominator > 0);
  const cacheActivityObserved = classified.some((group) =>
    STANDARD_ARMS.some((arm) =>
      group[arm].prime.cacheRead > 0 || group[arm].prime.cacheWrite > 0
      || group[arm].probe.cacheRead > 0 || group[arm].probe.cacheWrite > 0));
  const bandSatisfied = rateExists ? rateDifferenceAtLeast(rates.stable, rates.native, -NON_REGRESSION_BAND_PP) : null;
  const livenessSatisfied = rateExists ? rateDifferenceAtLeast(rates.stable, rates.nonce, LIVENESS_MARGIN_PP) : null;
  const minimumAcceptableStableRate = rateExists
    ? Math.round(Math.max(0, rates.native.rate - NON_REGRESSION_BAND_PP / 100) * 1e4) / 1e4
    : null;

  let cacheConclusion;
  if (!integrity.ok || measurable.length < classified.length) {
    cacheConclusion = "inconclusive";
  } else if (!cacheActivityObserved) {
    cacheConclusion = "inconclusive";
    reasons.push("no arm recorded any cache activity; a rate computed from nothing is not a rate");
  } else if (!rateExists) {
    cacheConclusion = "inconclusive";
    reasons.push("an arm's hit-rate denominator is zero, so its rate does not exist");
  } else if (!livenessSatisfied) {
    cacheConclusion = "inconclusive";
    reasons.push(
      `liveness control dead: nonce ${pct(rates.nonce.rate)} does not sit at least ${LIVENESS_MARGIN_PP}pp below stable ${pct(rates.stable.rate)}; the measurement cannot distinguish content`,
    );
  } else if (!bandSatisfied) {
    cacheConclusion = "negative";
    reasons.push(
      `non-regression band failed: stable ${pct(rates.stable.rate)} sits more than ${NON_REGRESSION_BAND_PP}pp below the native baseline ${pct(rates.native.rate)}`,
    );
  } else {
    cacheConclusion = "positive";
    reasons.push(
      `non-regression band met: stable ${pct(rates.stable.rate)} is at least the native baseline ${pct(rates.native.rate)} minus ${NON_REGRESSION_BAND_PP}pp (minimum ${pct(minimumAcceptableStableRate)})`,
      `liveness control alive: nonce ${pct(rates.nonce.rate)} sits at least ${LIVENESS_MARGIN_PP}pp below stable ${pct(rates.stable.rate)}`,
    );
  }

  const evaluatedNative = classified.filter((group) => group.nativeComparison.evaluated);
  const groupsRegressed = evaluatedNative.filter((group) => group.nativeComparison.multiDirectionRegression).length;
  const fired = groupsRegressed >= REGRESSION_GROUP_THRESHOLD;
  if (fired) {
    reasons.push(
      `native regression rule fired: ${groupsRegressed} of ${classified.length} groups regressed in at least ${REGRESSION_DIRECTION_THRESHOLD} directions versus Pi native`,
    );
  }

  return {
    groups: classified,
    cacheStandard: {
      hitRateDefinition: HIT_RATE_DEFINITION,
      aggregation: HIT_RATE_AGGREGATION,
      denominatorNote: DENOMINATOR_NOTE,
      band: { baselineArm: "native", armUnderTest: "stable", belowBaselinePercentagePoints: NON_REGRESSION_BAND_PP },
      liveness: { controlArm: "nonce", measuredAgainst: "stable", belowMarginPercentagePoints: LIVENESS_MARGIN_PP },
      groupsAggregated: measurable.length,
      cacheActivityObserved,
      rates,
      minimumAcceptableStableRate,
      bandSatisfied,
      livenessSatisfied,
    },
    regression: {
      rule: `>=${REGRESSION_GROUP_THRESHOLD} of ${classified.length || 5} groups with >=${REGRESSION_DIRECTION_THRESHOLD} worse directions versus Pi native`,
      groupsEvaluated: evaluatedNative.length,
      groupsRegressed,
      fired,
    },
    cacheConclusion,
    conclusion: fired ? "regression" : cacheConclusion,
    reasons: reasons.slice(0, 16),
  };
}
