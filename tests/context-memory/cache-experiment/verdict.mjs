/**
 * Verdict rules for the provider-cache experiment (#225, authority #215).
 *
 * These thresholds are the release gate's rules, encoded as code:
 *
 * - A provider-reported zero is data; an absent cache report is not. A group
 *   whose probe never reported cache values is `missing-report`, and a group
 *   where every request reported zero without a single observed write is
 *   `ambiguous-zero` — the zeros cannot be attributed, because nothing shows
 *   the provider was caching at all. Both are inconclusive, never a miss and
 *   never a pass (#215: "Treat absent or ambiguous zero cache reporting as
 *   inconclusive and release-blocking").
 * - A run is conclusive only when all five groups are measurable: the release
 *   gate tolerates no unobserved group.
 * - A conclusive positive needs explicit non-zero stable-arm cache evidence in
 *   at least three groups AND stable reuse above the paired negative control
 *   in at least three groups.
 * - The Pi-native comparison is reported per group and by median, and the
 *   run blocks when at least four of five groups each regress in at least two
 *   directions. No statistical significance and no provider-neutral
 *   superiority is claimed anywhere.
 */

export const REQUIRED_POSITIVE_GROUPS = 3;
export const REGRESSION_GROUP_THRESHOLD = 4;
export const REGRESSION_DIRECTION_THRESHOLD = 2;
export const NATIVE_DIRECTIONS = ["inputTokens", "writeSpend", "cost", "ttft"];

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
      evidenceNonZero: null,
      reuseAboveControl: null,
    };
  }
  const causal = [group.stable.prime, group.stable.probe, group.nonce.prime, group.nonce.probe];
  const absent = causal.filter((row) => !row.cacheReported).map((row) => `${row.arm}.${row.role}`);
  if (absent.length > 0) {
    return {
      quality: "missing-report",
      qualityReasons: [`provider reported no cache value for ${absent.join(", ")}`],
      evidenceNonZero: null,
      reuseAboveControl: null,
    };
  }
  const allRequests = [...causal, group.native.prime, group.native.probe];
  const cacheEngaged = allRequests.some((row) => row.cacheRead > 0 || row.cacheWrite > 0);
  if (!cacheEngaged) {
    return {
      quality: "ambiguous-zero",
      qualityReasons: ["every request reported zero and no cache write was observed anywhere in the group, so the zeros cannot be attributed"],
      evidenceNonZero: false,
      reuseAboveControl: false,
    };
  }
  const evidenceNonZero = group.stable.prime.cacheRead > 0
    || group.stable.prime.cacheWrite > 0
    || group.stable.probe.cacheRead > 0
    || group.stable.probe.cacheWrite > 0;
  const reuseAboveControl = group.stable.probe.cacheRead > group.nonce.probe.cacheRead;
  return { quality: "measurable", qualityReasons: [], evidenceNonZero, reuseAboveControl };
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
 * The run verdict. Integrity failure or any non-measurable group makes the
 * cache conclusion inconclusive; only a fully observed run can conclude
 * positive or negative. The regression rule is evaluated independently over
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
  const nonZeroEvidenceGroups = measurable.filter((group) => group.evidenceNonZero).length;
  const reuseAboveControlGroups = measurable.filter((group) => group.reuseAboveControl).length;

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

  let cacheConclusion;
  if (!integrity.ok || classified.some((group) => group.quality !== "measurable")) {
    cacheConclusion = "inconclusive";
  } else if (
    nonZeroEvidenceGroups >= REQUIRED_POSITIVE_GROUPS
    && reuseAboveControlGroups >= REQUIRED_POSITIVE_GROUPS
  ) {
    cacheConclusion = "positive";
    reasons.push(
      `cache criteria met: non-zero stable-arm evidence in ${nonZeroEvidenceGroups} groups and reuse above the paired control in ${reuseAboveControlGroups} (threshold ${REQUIRED_POSITIVE_GROUPS})`,
    );
  } else {
    cacheConclusion = "negative";
    reasons.push(
      `all groups measurable but a threshold failed: non-zero stable-arm evidence ${nonZeroEvidenceGroups}, reuse above control ${reuseAboveControlGroups} (threshold ${REQUIRED_POSITIVE_GROUPS})`,
    );
  }

  const evaluatedNative = classified.filter((group) => group.nativeComparison.evaluated);
  const groupsRegressed = evaluatedNative.filter((group) => group.nativeComparison.multiDirectionRegression).length;
  const fired = groupsRegressed >= REGRESSION_GROUP_THRESHOLD;
  if (fired) {
    reasons.push(
      `native regression rule fired: ${groupsRegressed} of ${classified.length} groups regressed in at least ${REGRESSION_DIRECTION_THRESHOLD} directions versus the Pi-native arm`,
    );
  }

  return {
    groups: classified,
    criteria: {
      requiredGroups: REQUIRED_POSITIVE_GROUPS,
      groupsTotal: classified.length,
      measurableGroups: measurable.length,
      nonZeroEvidenceGroups,
      reuseAboveControlGroups,
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
