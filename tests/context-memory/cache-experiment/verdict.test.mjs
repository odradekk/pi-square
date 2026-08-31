import assert from "node:assert/strict";
import {
  NATIVE_DIRECTIONS,
  REGRESSION_DIRECTION_THRESHOLD,
  REGRESSION_GROUP_THRESHOLD,
  REQUIRED_POSITIVE_GROUPS,
  classifyGroup,
  compareNative,
  evaluateRun,
  median,
  withinTtl,
} from "./verdict.mjs";

/**
 * Verdict-rule coverage for the provider-cache experiment (#225). Every branch
 * is driven with constructed evidence — no provider, no credentials — because
 * the rules, not the plumbing, are the deliverable: ambiguous evidence is
 * inconclusive, never a miss and never a pass, and each threshold is exercised
 * at and around its boundary.
 */

const TTL_MS = 300_000;

function row({ arm, role, reported = true, read = 0, write = 0, input = 120, cost = 0.001, ttft = 200, sentAt = 0 }) {
  return { arm, role, cacheReported: reported, cacheRead: read, cacheWrite: write, inputTokens: input, outputTokens: 50, cost, ttftMs: ttft, sentAtMs: sentAt };
}

/**
 * A default positive-shaped group: the stable arm reuses a large cached
 * prefix, the nonce control reuses only the shared head, and the native arm
 * regresses in one direction only (write spend), which stays below the
 * multi-direction threshold.
 */
function makeGroup(group, overrides = {}) {
  const arms = {
    stable: {
      prime: row({ arm: "stable", role: "prime", write: 700, input: 900, cost: 0.004, ttft: 900, sentAt: group * 10_000 }),
      probe: row({ arm: "stable", role: "probe", read: 600, input: 120, cost: 0.0008, ttft: 160, sentAt: group * 10_000 + 60 }),
    },
    nonce: {
      prime: row({ arm: "nonce", role: "prime", write: 700, input: 900, cost: 0.004, ttft: 900, sentAt: group * 10_000 + 10 }),
      probe: row({ arm: "nonce", role: "probe", read: 90, input: 120, cost: 0.0011, ttft: 220, sentAt: group * 10_000 + 70 }),
    },
    native: {
      prime: row({ arm: "native", role: "prime", write: 690, input: 900, cost: 0.004, ttft: 890, sentAt: group * 10_000 + 20 }),
      probe: row({ arm: "native", role: "probe", read: 80, input: 120, cost: 0.0016, ttft: 300, sentAt: group * 10_000 + 80 }),
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

// ─── conclusive positive ────────────────────────────────────────────

{
  const verdict = run([1, 2, 3, 4, 5].map((n) => makeGroup(n)));
  assert.equal(verdict.cacheConclusion, "positive");
  assert.equal(verdict.conclusion, "positive");
  assert.equal(verdict.criteria.nonZeroEvidenceGroups, 5);
  assert.equal(verdict.criteria.reuseAboveControlGroups, 5);
  assert.equal(verdict.criteria.measurableGroups, 5);
  assert.equal(verdict.regression.fired, false, "one worse direction per group never fires the rule");
}

{
  // Exactly at the threshold: three groups meet both criteria, two are
  // measurable but show no reuse advantage.
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n));
  for (const n of [4, 5]) groups[n - 1].nonce.probe.cacheRead = 600;
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "positive", "3-of-5 on both criteria is exactly the gate");
  assert.equal(verdict.criteria.reuseAboveControlGroups, REQUIRED_POSITIVE_GROUPS);
}

{
  // One below the reuse threshold with every group observed: conclusive negative.
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n));
  for (const n of [4, 5]) groups[n - 1].nonce.probe.cacheRead = 600;
  groups[2].nonce.probe.cacheRead = 600;
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "negative");
  assert.equal(verdict.conclusion, "negative");
}

// ─── conclusive negative: measured, but no reuse above the control ──

{
  // The provider demonstrably caches (primes write), but the stable arm reads
  // no more than the nonce control in any group.
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n, {
    rows: { stable: { probe: { cacheRead: 90 } } },
  }));
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "negative");
  assert.equal(verdict.criteria.nonZeroEvidenceGroups, 5, "stable-arm writes still count as non-zero evidence");
  assert.equal(verdict.criteria.reuseAboveControlGroups, 0);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("all groups measurable but a threshold failed")));
}

// ─── ambiguous zero: reported zeros with no cache engagement ────────

{
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n, {
    rows: {
      stable: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      nonce: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      native: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
    },
  }));
  for (const group of groups) {
    const classified = classifyGroup(group);
    assert.equal(classified.quality, "ambiguous-zero");
    assert.equal(classified.evidenceNonZero, false);
    assert.equal(classified.reuseAboveControl, false);
  }
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive", "ambiguous zeros are never a miss");
  assert.equal(verdict.conclusion, "inconclusive", "ambiguous zeros are never a pass");
  assert.ok(verdict.reasons.some((reason) => reason.includes("ambiguous-zero")));
}

{
  // The same all-zero stable arm with one observed write elsewhere in the
  // group makes the zeros attributable: measurable, and conclusively negative.
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n, {
    rows: {
      stable: { prime: { cacheRead: 0, cacheWrite: 0 }, probe: { cacheRead: 0, cacheWrite: 0 } },
      native: { prime: { cacheWrite: 690 } },
    },
  }));
  const verdict = run(groups);
  assert.equal(verdict.criteria.measurableGroups, 5);
  assert.equal(verdict.cacheConclusion, "negative", "cache engagement observed, so the zeros are data");
}

// ─── missing report: absent data is not a reported zero ─────────────

{
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n));
  groups[2].nonce.probe.cacheReported = false;
  const classified = classifyGroup(groups[2]);
  assert.equal(classified.quality, "missing-report");
  assert.ok(classified.qualityReasons[0].includes("nonce.probe"), "the reason names the unreported request");
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "inconclusive", "an unobserved group blocks the whole run even when the other four pass");
  assert.equal(verdict.criteria.measurableGroups, 4);
  assert.equal(verdict.criteria.reuseAboveControlGroups, 4);
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
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n));
  groups[1].timing.withinTtl = false;
  const classified = classifyGroup(groups[1]);
  assert.equal(classified.quality, "ttl-stale");
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
  const verdict = run([1, 2, 3, 4, 5].map((n) => makeGroup(n)), integrity);
  assert.equal(verdict.cacheConclusion, "inconclusive");
  assert.equal(verdict.conclusion, "inconclusive");
  assert.ok(verdict.reasons.includes("run integrity failed; the evidence cannot be interpreted"));
}

// ─── native comparison and the regression rule ──────────────────────

{
  // Direction computation: stable loses input tokens, write spend, and cost,
  // wins TTFT; an unmeasured TTFT is unreported, never a direction.
  const group = makeGroup(1, {
    rows: {
      native: { probe: { inputTokens: 80, cost: 0.0005 } },
    },
  });
  const comparison = compareNative(group);
  assert.equal(comparison.evaluated, true);
  assert.deepEqual(comparison.worseDirections.sort(), ["cost", "inputTokens", "writeSpend"]);
  assert.equal(comparison.directions.ttft, "better", "160ms versus the default 300ms native probe");
  assert.equal(comparison.multiDirectionRegression, true);
}

{
  // TTFT absent on the native probe: the direction is unreported and cannot
  // count toward a regression.
  const group = makeGroup(1, { rows: { native: { probe: { inputTokens: 80, cost: 0.0005, ttftMs: null } } } });
  const comparison = compareNative(group);
  assert.equal(comparison.directions.ttft, "unreported");
  assert.deepEqual(comparison.worseDirections.sort(), ["cost", "inputTokens", "writeSpend"]);
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
  // Clear regression: four of five groups regress in three directions each.
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n, n <= 4 ? { rows: { native: { probe: { inputTokens: 80, cost: 0.0005, ttftMs: 120 } } } } : {}));
  const verdict = run(groups);
  assert.equal(verdict.cacheConclusion, "positive", "the cache criteria still pass on their own axes");
  assert.equal(verdict.conclusion, "regression", "the regression rule overrides the final label");
  assert.equal(verdict.regression.groupsRegressed, REGRESSION_GROUP_THRESHOLD);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("native regression rule fired")));
}

{
  // Three regressed groups do not fire the four-of-five rule.
  const groups = [1, 2, 3, 4, 5].map((n) => makeGroup(n, n <= 3 ? { rows: { native: { probe: { inputTokens: 80, cost: 0.0005, ttftMs: 120 } } } } : {}));
  const verdict = run(groups);
  assert.equal(verdict.regression.fired, false);
  assert.equal(verdict.conclusion, "positive");
}

{
  // Regression requires multiple directions: a single-direction loss in all
  // five groups (the default shape) never fires.
  const verdict = run([1, 2, 3, 4, 5].map((n) => makeGroup(n)));
  assert.equal(verdict.regression.groupsRegressed, 0);
  for (const group of verdict.groups) {
    assert.ok(
      group.nativeComparison.worseDirections.length < REGRESSION_DIRECTION_THRESHOLD
        || group.nativeComparison.multiDirectionRegression,
    );
  }
  assert.equal(NATIVE_DIRECTIONS.length, 4);
}

// ─── medians ────────────────────────────────────────────────────────

{
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
}

console.log("verdict.test.mjs: all verdict branches passed");
