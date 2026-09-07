/**
 * Verdict rules for the provider-cache experiment (#225, standard re-pinned by
 * #260, directions and liveness re-modeled by #268, append case and labels
 * re-pinned by #297; authority #215; measured evidence #251).
 *
 * The experiment measures non-regression, not superiority: no release verdict
 * may make any provider-cache claim (#227), and the standard's job is only to
 * bound what the run supports.
 *
 * The measured case (#297) is the cross-compaction append: the prime carries
 * Memory blocks 1–2, the probe carries those blocks byte-identical plus one
 * appended block 3. The `multiblock` arm renders the carried blocks through
 * the uniform projection — one ordered text content block per block — and the
 * `single` arm renders today's single-summary-block baseline; the `nonce`
 * control diverges inside the earliest carried block so that any reuse the
 * placement could serve in the carried region is removed by construction.
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
 * The standard (#297):
 *
 * - `hitRate(arm)` is pinned as the share of total input served from cache,
 *   aggregated per arm across the groups' probe requests:
 *   `Σ cache_read / Σ (cache_read + cache_creation + uncached_input)`.
 *   Sum first, then divide — never a mean of per-group ratios.
 * - Non-regression band: `hitRate(multiblock)` must be at least
 *   `hitRate(single) − 5 percentage points`. The single-summary-block
 *   rendering is the baseline, and the band claims no benefit — it only rules
 *   out a loss.
 * - Improvement: `hitRate(multiblock)` at least `hitRate(single) + 5pp` is
 *   an improvement only when the liveness control is alive; with a dead
 *   control an apparent gain cannot be attributed to content, so it stays
 *   inconclusive.
 * - Liveness: the `nonce` control must sit measurably below the
 *   `multiblock` arm. Under Pi's pinned breakpoint placement no breakpoint
 *   sits at the carried Memory's end (#269), so a dead control is the
 *   structurally expected outcome on a breakpoint-cache provider: neither arm
 *   can be served the carried region at all. A dead control therefore does
 *   not invalidate the arm-vs-baseline comparison — the band compares the two
 *   arms directly and a neutral band with a dead control is an honest
 *   `neutral` (the projection changed nothing measurable) — but it does cap
 *   the claim, and the reasons state both facts verbatim.
 * - A run in which no arm records any cache activity at all is inconclusive:
 *   a rate computed from nothing is not a rate.
 *
 * The regression rule (#268 defect 2): only directions that can move
 * independently are counted — `inputTokens` (provider-reported uncached
 * input), `writeSpend` (provider-reported cache-creation tokens), and `ttft`
 * (locally measured time to first token). `cost` is computed from those token
 * counts through the adapter's declared price table, so it moves in lockstep
 * with them and is reported as a derived figure, never counted as a
 * direction. `DIRECTION_NOTES` states, for each counted direction, what it
 * measures and why it is independent of the others; the report restates them
 * verbatim. The rule is evaluated against the single-summary baseline and
 * evaluated independently; firing it overrides the final label while the
 * cache conclusion stays visible beside it. No statistical significance and
 * no provider-neutral superiority is claimed anywhere.
 */

export const REGRESSION_GROUP_THRESHOLD = 4;
export const REGRESSION_DIRECTION_THRESHOLD = 2;
/** The counted regression directions: only directions that can move independently. */
export const BASELINE_DIRECTIONS = ["inputTokens", "writeSpend", "ttft"];
/** Figures computed from the token counts through the price table; never counted as directions. */
export const DERIVED_FIGURES = ["cost"];

/** What each counted direction measures and why it is independent; restated verbatim in the report. */
export const DIRECTION_NOTES = Object.freeze({
  inputTokens: "uncached input tokens as reported by the provider (anthropic usage input_tokens); a wire measurement, independent of the cache buckets and of local timing",
  writeSpend: "cache-creation tokens as reported by the provider (anthropic cache_creation_input_tokens); a separate usage bucket, independent of the uncached count and of local timing",
  ttft: "milliseconds to the first streamed token, measured locally by the runner; timing evidence, independent of every token-count direction",
});

/** Why cost is derived rather than counted; restated verbatim in the report. */
export const COST_DERIVATION_NOTE =
  "cost is computed from the token counts through the adapter's declared price table, so it cannot move independently of them: it is reported as a derived figure and never counted as a regression direction";

/** The three arms the standard is defined over; pinned by the fixture. */
const STANDARD_ARMS = ["multiblock", "single", "nonce"];

/** Non-regression band: multiblock may sit at most this far below single. */
export const NON_REGRESSION_BAND_PP = 5;

/** Improvement margin: multiblock must exceed single by at least this much. */
export const IMPROVEMENT_MARGIN_PP = 5;


/**
 * The pinned per-direction noise floors (#297): a direction counts as `worse`
 * or `better` only when the excess clears its floor, and as `equal` otherwise.
 * The multiblock projection structurally carries more framing than the single
 * block — per-part framing on the wire, per-segment framing in the canonical
 * accounting — a delta the fixture tests measure and bound below the token
 * floor, and provider token counts carry their own granularity; timing noise
 * dwarfs small token deltas. Any real regression moves a counted direction by
 * orders of magnitude more than these floors (a lost cache read rewrites
 * thousands of tokens), so the floors absorb structural overhead and noise
 * without absorbing regressions. Restated verbatim in the report.
 */
export const DIRECTION_NOISE_FLOORS = Object.freeze({
  inputTokens: { absoluteTokens: 128, relativePercent: 1 },
  writeSpend: { absoluteTokens: 128, relativePercent: 1 },
  ttft: { absoluteMs: 100, relativePercent: 10 },
});
/** Liveness margin: the nonce control must sit at least this far below multiblock. */
export const LIVENESS_MARGIN_PP = 5;

/** The dead-control caveat, appended verbatim whenever the liveness control is dead. */
export const DEAD_CONTROL_NOTE =
  "liveness control dead: no breakpoint sits at the carried Memory's end under the pinned placement (#269), so carried-region reuse is not observable; the label describes the arm-vs-baseline comparison only";

/** The pinned hit-rate definition, restated in the report verbatim. */
export const HIT_RATE_DEFINITION =
  "share of total input served from cache: Σ cache_read / Σ (cache_read + cache_creation + uncached_input), per arm over the groups' probe requests, summed first then divided";

/** How the rate is aggregated; restated in the report verbatim. */
export const HIT_RATE_AGGREGATION =
  "per arm over the measurable groups' probe requests (all five in a conclusive run); sums first, then one division — never a mean of per-group ratios";

/** Why the ratio must not be reused as a cost metric; restated verbatim in the report. */
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
  // Every request of every arm is causal evidence (#297 review finding 2):
  // the band reads multiblock and single, the liveness control reads
  // multiblock and nonce, so an absent report anywhere — including the
  // baseline's prime or probe — must make the group missing-report, never a
  // measurable group whose comparison could conclude from partial data.
  const allRequests = [
    group.multiblock.prime, group.multiblock.probe,
    group.single.prime, group.single.probe,
    group.nonce.prime, group.nonce.probe,
  ];
  const absent = allRequests.filter((row) => !row.cacheReported).map((row) => `${row.arm}.${row.role}`);
  if (absent.length > 0) {
    return {
      quality: "missing-report",
      qualityReasons: [`provider reported no cache value for ${absent.join(", ")}`],
    };
  }
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

/** The floor a direction's excess must clear to count; `equal` inside it (#297). */
function noiseFloor(direction, baselineValue) {
  const floor = DIRECTION_NOISE_FLOORS[direction];
  if (!floor) return 0;
  const absolute = floor.absoluteTokens ?? floor.absoluteMs ?? 0;
  const relative = baselineValue > 0 ? (baselineValue * floor.relativePercent) / 100 : 0;
  return Math.max(absolute, relative);
}

function directionOf(testValue, baselineValue, direction) {
  const excess = testValue - baselineValue;
  const floor = noiseFloor(direction, baselineValue);
  if (excess > floor) return "worse";
  if (excess < -floor) return "better";
  return "equal";
}

/**
 * The baseline comparison for one group: which of the counted independent
 * directions the multiblock arm lost against the single-summary baseline,
 * plus the derived cost figure reported beside them. Evaluated only when both
 * arms' requests reported cache values; an unmeasured TTFT stays `unreported`
 * rather than counting as any direction.
 */
export function compareBaseline(group) {
  const rows = [group.multiblock.prime, group.multiblock.probe, group.single.prime, group.single.probe];
  if (rows.some((row) => !row.cacheReported)) {
    return {
      evaluated: false,
      missing: ["cache report absent on the multiblock or single arm"],
      directions: {},
      derived: {},
      worseDirections: [],
      multiDirectionRegression: false,
    };
  }
  const directions = {
    inputTokens: directionOf(group.multiblock.probe.inputTokens, group.single.probe.inputTokens, "inputTokens"),
    writeSpend: directionOf(armWriteTokens(group.multiblock), armWriteTokens(group.single), "writeSpend"),
  };
  if (group.multiblock.probe.ttftMs == null || group.single.probe.ttftMs == null) {
    directions.ttft = "unreported";
  } else {
    directions.ttft = directionOf(group.multiblock.probe.ttftMs, group.single.probe.ttftMs, "ttft");
  }
  const worseDirections = BASELINE_DIRECTIONS.filter((direction) => directions[direction] === "worse");
  return {
    evaluated: true,
    missing: [],
    directions,
    derived: { cost: directionOf(armCost(group.multiblock), armCost(group.single)) },
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
 * Baseline comparison summary across the run: per-direction median deltas
 * (multiblock minus single) over the counted directions, the derived cost
 * figure, and per-arm medians over the evaluated groups. TTFT additionally
 * carries its dispersion — the span of the per-group deltas (#268 defect 3): a
 * median delta smaller than the spread cannot read as a finding, and the
 * report states both so no reader has to infer it.
 */
export function baselineMedians(classifiedGroups) {
  const evaluated = classifiedGroups.filter((group) => group.baselineComparison.evaluated);
  const deltasOf = (direction) => evaluated
    .map((group) => {
      if (direction === "inputTokens") return group.multiblock.probe.inputTokens - group.single.probe.inputTokens;
      if (direction === "writeSpend") return armWriteTokens(group.multiblock) - armWriteTokens(group.single);
      if (group.multiblock.probe.ttftMs == null || group.single.probe.ttftMs == null) return null;
      return group.multiblock.probe.ttftMs - group.single.probe.ttftMs;
    })
    .filter((delta) => delta !== null);
  const summaryOf = (deltas, directionAt) => ({
    medianDelta: deltas.length > 0 ? Math.round(median(deltas) * 1e6) / 1e6 : null,
    worse: evaluated.filter((group) => directionAt(group) === "worse").length,
    better: evaluated.filter((group) => directionAt(group) === "better").length,
    equal: evaluated.filter((group) => directionAt(group) === "equal").length,
    unreported: classifiedGroups.length - deltas.length,
  });
  const perDirection = {};
  for (const direction of BASELINE_DIRECTIONS) {
    const deltas = deltasOf(direction);
    perDirection[direction] = summaryOf(deltas, (group) => group.baselineComparison.directions[direction]);
    if (direction === "ttft") {
      // Dispersion alongside the median (#268): the span the observed deltas cover.
      perDirection[direction].spreadMs = deltas.length >= 2
        ? Math.round(Math.max(...deltas) - Math.min(...deltas))
        : null;
    }
  }
  const costDeltas = evaluated
    .map((group) => armCost(group.multiblock) - armCost(group.single))
    .filter((delta) => delta !== null);
  return {
    groupsEvaluated: evaluated.length,
    perDirection,
    derived: {
      cost: {
        ...summaryOf(costDeltas, (group) => group.baselineComparison.derived?.cost ?? "unreported"),
        note: COST_DERIVATION_NOTE,
      },
    },
    armMedians: {
      probeInputTokens: {
        multiblock: median(evaluated.map((group) => group.multiblock.probe.inputTokens)),
        single: median(evaluated.map((group) => group.single.probe.inputTokens)),
      },
      writeTokens: {
        multiblock: median(evaluated.map((group) => armWriteTokens(group.multiblock))),
        single: median(evaluated.map((group) => armWriteTokens(group.single))),
      },
      cost: {
        multiblock: median(evaluated.map((group) => armCost(group.multiblock))),
        single: median(evaluated.map((group) => armCost(group.single))),
      },
      probeTtftMs: {
        multiblock: median(evaluated.map((group) => group.multiblock.probe.ttftMs).filter((value) => value !== null)),
        single: median(evaluated.map((group) => group.single.probe.ttftMs).filter((value) => value !== null)),
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
 * cross-multiplied so the band, improvement, and liveness edges never depend
 * on floating point. `percentagePoints` may be negative.
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
 * cache activity anywhere, or a zero denominator makes the conclusion
 * inconclusive. With a live liveness control, a met band concludes `neutral`,
 * an exceeded improvement margin concludes `improved`, and a failed band
 * concludes `regressed`. With a dead control — the structurally expected
 * outcome under Pi's pinned breakpoint placement (#269) — a met band still
 * concludes `neutral` (the projection changed nothing measurable; the caveat
 * is stated verbatim), a failed band still concludes `regressed` (a loss is
 * directional evidence about the arms themselves), but an apparent
 * improvement stays `inconclusive` because the gain cannot be attributed to
 * content. The regression rule is evaluated independently over the groups
 * whose baseline comparison was complete, and firing it overrides the final
 * label — with `regressed`, the same four-value vocabulary the issue pins
 * (#297 review finding 3: no fifth label exists) — while the cache conclusion
 * stays visible beside it.
 */
export function evaluateRun({ groups, integrity }) {
  const classified = groups.map((group) => ({
    ...group,
    ...classifyGroup(group),
    baselineComparison: compareBaseline(group),
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
  const bandSatisfied = rateExists ? rateDifferenceAtLeast(rates.multiblock, rates.single, -NON_REGRESSION_BAND_PP) : null;
  const improvementObserved = rateExists ? rateDifferenceAtLeast(rates.multiblock, rates.single, IMPROVEMENT_MARGIN_PP) : null;
  const livenessSatisfied = rateExists ? rateDifferenceAtLeast(rates.multiblock, rates.nonce, LIVENESS_MARGIN_PP) : null;
  const minimumAcceptableRate = rateExists
    ? Math.round(Math.max(0, rates.single.rate - NON_REGRESSION_BAND_PP / 100) * 1e4) / 1e4
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
    if (improvementObserved) {
      cacheConclusion = "inconclusive";
      reasons.push(
        `liveness control dead: nonce ${pct(rates.nonce.rate)} does not sit below multiblock ${pct(rates.multiblock.rate)}, so the apparent gain over single ${pct(rates.single.rate)} cannot be attributed to content`,
        DEAD_CONTROL_NOTE,
      );
    } else if (bandSatisfied) {
      cacheConclusion = "neutral";
      reasons.push(
        `non-regression band met: multiblock ${pct(rates.multiblock.rate)} is at least the single baseline ${pct(rates.single.rate)} minus ${NON_REGRESSION_BAND_PP}pp (minimum ${pct(minimumAcceptableRate)})`,
        DEAD_CONTROL_NOTE,
      );
    } else {
      cacheConclusion = "regressed";
      reasons.push(
        `non-regression band failed: multiblock ${pct(rates.multiblock.rate)} sits more than ${NON_REGRESSION_BAND_PP}pp below the single baseline ${pct(rates.single.rate)}`,
        DEAD_CONTROL_NOTE,
      );
    }
  } else if (improvementObserved) {
    cacheConclusion = "improved";
    reasons.push(
      `improvement observed: multiblock ${pct(rates.multiblock.rate)} exceeds the single baseline ${pct(rates.single.rate)} by at least ${IMPROVEMENT_MARGIN_PP}pp`,
      `liveness control alive: nonce ${pct(rates.nonce.rate)} sits at least ${LIVENESS_MARGIN_PP}pp below multiblock ${pct(rates.multiblock.rate)}`,
    );
  } else if (bandSatisfied) {
    cacheConclusion = "neutral";
    reasons.push(
      `non-regression band met: multiblock ${pct(rates.multiblock.rate)} is at least the single baseline ${pct(rates.single.rate)} minus ${NON_REGRESSION_BAND_PP}pp (minimum ${pct(minimumAcceptableRate)})`,
      `liveness control alive: nonce ${pct(rates.nonce.rate)} sits at least ${LIVENESS_MARGIN_PP}pp below multiblock ${pct(rates.multiblock.rate)}`,
    );
  } else {
    cacheConclusion = "regressed";
    reasons.push(
      `non-regression band failed: multiblock ${pct(rates.multiblock.rate)} sits more than ${NON_REGRESSION_BAND_PP}pp below the single baseline ${pct(rates.single.rate)}`,
    );
  }

  const evaluatedBaseline = classified.filter((group) => group.baselineComparison.evaluated);
  const groupsRegressed = evaluatedBaseline.filter((group) => group.baselineComparison.multiDirectionRegression).length;
  const fired = groupsRegressed >= REGRESSION_GROUP_THRESHOLD;
  if (fired) {
    reasons.push(
      `baseline regression rule fired: ${groupsRegressed} of ${classified.length} groups regressed in at least ${REGRESSION_DIRECTION_THRESHOLD} independent directions versus the single-summary baseline`,
    );
  }

  return {
    groups: classified,
    cacheStandard: {
      hitRateDefinition: HIT_RATE_DEFINITION,
      aggregation: HIT_RATE_AGGREGATION,
      denominatorNote: DENOMINATOR_NOTE,
      band: { baselineArm: "single", armUnderTest: "multiblock", belowBaselinePercentagePoints: NON_REGRESSION_BAND_PP },
      improvement: { aboveBaselinePercentagePoints: IMPROVEMENT_MARGIN_PP },
      liveness: { controlArm: "nonce", measuredAgainst: "multiblock", belowMarginPercentagePoints: LIVENESS_MARGIN_PP },
      groupsAggregated: measurable.length,
      cacheActivityObserved,
      rates,
      minimumAcceptableRate,
      bandSatisfied,
      improvementObserved,
      livenessSatisfied,
    },
    regression: {
      rule: `>=${REGRESSION_GROUP_THRESHOLD} of ${classified.length || 5} groups with >=${REGRESSION_DIRECTION_THRESHOLD} worse independent directions versus the single-summary baseline`,
      directions: {
        counted: BASELINE_DIRECTIONS,
        notes: DIRECTION_NOTES,
        derivedFigures: DERIVED_FIGURES,
        derivedNote: COST_DERIVATION_NOTE,
      },
      groupsEvaluated: evaluatedBaseline.length,
      groupsRegressed,
      fired,
    },
    cacheConclusion,
    conclusion: fired ? "regressed" : cacheConclusion,
    reasons: reasons.slice(0, 16),
  };
}
