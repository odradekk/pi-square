import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARMS,
  ARM_ORDER,
  ARM_ROTATION,
  BREAKPOINT_PLACEMENT,
  COVERED_PREFIX_FLOOR_TOKENS,
  GROUP_COUNT,
  MARKER,
  MEASURED_CACHEABLE_PREFIX_TOKENS,
  SYSTEM_PROMPT,
  armOrderFor,
  baseBlocks,
  composeRequest,
  fixtureDigest,
  groupOrder,
} from "./fixture.mjs";
import { estimateTokens, sha256Hex } from "./evidence.mjs";
import { fakeClock, simulatedCacheAdapter } from "./fake-provider.mjs";
import { classifyDivergenceBoundary, findReportLeaks, runExperiment } from "./runner.mjs";
import { DENOMINATOR_NOTE, FORBIDDEN_CLAIM_PHRASES, FRAMING_DISCLAIMER, HIT_RATE_DEFINITION, LIVENESS_MARGIN_PP, NON_REGRESSION_BAND_PP } from "./verdict.mjs";

/**
 * End-to-end dry-run coverage for the provider-cache experiment (#225,
 * standard re-pinned by #260, arms and order re-modeled by #268): the full
 * harness runs against the simulated breakpoint-cache adapter with a fake
 * clock, proving the pinned experiment shape and fixture scale, the recorded
 * evidence, the between-compaction control that can move, run integrity, the
 * non-regression verdict, determinism, report privacy, and the command-line
 * surface — without credentials and without any real provider call.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

async function dryRun() {
  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  return runExperiment({ adapter, clock, generatedAt: () => "2026-01-01T00:00:00.000Z" });
}

// ─── the full dry run: conclusive positive, integrity clean ─────────

{
  const { report, exitCode } = await dryRun();
  assert.equal(report.mode, "dry-run");
  assert.equal(report.integrity.ok, true);
  assert.equal(report.conclusion.cache, "positive", "the honest simulation must land the positive branch");
  assert.equal(report.conclusion.final, "positive");
  assert.equal(exitCode, 0);
  assert.equal(report.totals.groups, GROUP_COUNT);
  assert.equal(report.totals.requests, GROUP_COUNT * groupOrder(1).length, "five interleaved paired groups over three arms");
  assert.equal(report.regression.fired, false);
}

// ─── the fixture is large enough for the measurement to exist ───────

{
  // #260/#251: the measured gateway caches nothing below a minimum
  // cacheable prefix near 1024 tokens, and the pre-enlargement fixture's
  // covered prefix sat near 487 tokens — too small to cache, so no rate could
  // be computed. Every composed request's covered prefix (bytes zero through
  // the tail breakpoint — system, tools, carried summary, and the whole tail)
  // must now clear the pinned floor, which is twice the measured floor:
  // margin above it, never to it.
  assert.equal(COVERED_PREFIX_FLOOR_TOKENS, 2 * MEASURED_CACHEABLE_PREFIX_TOKENS, "the floor target is twice the measured floor");
  let smallest = Infinity;
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const arm of ARMS) {
      for (const role of ["prime", "probe"]) {
        const { payload, layout } = composeRequest({ group, arm, role });
        const coveredTokens = estimateTokens(layout.breakpoints.at(-1));
        smallest = Math.min(smallest, coveredTokens);
        assert.ok(
          coveredTokens >= COVERED_PREFIX_FLOOR_TOKENS,
          `${arm}.${role} covers ${coveredTokens} tokens, below the ${COVERED_PREFIX_FLOOR_TOKENS}-token floor`,
        );
        assert.ok(coveredTokens <= payload.bytes.length);
        // The padding stays disciplined: no 64+ repeated character run ever
        // enters a payload, so a leaked body stays detectable.
        assert.ok(!/(.)\1{63}/.test(payload.bytes.toString("utf8")));
      }
    }
  }
  assert.ok(smallest > COVERED_PREFIX_FLOOR_TOKENS, "the smallest covered prefix clears the floor with headroom, not exactly at it");
  // Block bodies stay well inside the production 16-KiB Memory block bound.
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const body of baseBlocks(group)) {
      assert.ok(Buffer.byteLength(body, "utf8") < 16 * 1024);
      assert.ok(body.length > 1000, "each carried block is a substantive enlarged body");
    }
  }
}

// ─── the negative control can move (#268's central fixture proof) ───

{
  // The measured case is the between-compaction request: the carried summary
  // is unchanged between the pair's requests while the tail grows. Under the
  // pinned breakpoint placement — system, last tool, last user-message block,
  // exactly where Pi's anthropic-messages converter puts them, and nowhere at
  // the carried summary's end — compute each arm's probe cacheable prefix
  // against its prime the way a provider does: the longest boundary cached by
  // the prime (its own three breakpoints) whose bytes the probe still shares.
  // The three arms must differ by construction, or the liveness rule is dead.
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    const cacheableBytes = {};
    const coverageEnd = {};
    const prefixHashes = {};
    const summaries = {};
    const payloadLengths = {};
    for (const arm of ARMS) {
      const prime = composeRequest({ group, arm, role: "prime" });
      const probe = composeRequest({ group, arm, role: "probe" });
      payloadLengths[arm] = { prime: prime.payload.bytes.length, probe: probe.payload.bytes.length };
      coverageEnd[arm] = prime.layout.breakpoints.at(-1);
      summaries[arm] = prime.layout.summary.end - prime.layout.summary.start;
      let shared = 0;
      for (const boundary of prime.layout.breakpoints) {
        if (boundary <= probe.payload.bytes.length
          && sha256Hex(probe.payload.bytes.subarray(0, boundary)) === sha256Hex(prime.payload.bytes.subarray(0, boundary))) {
          shared = Math.max(shared, boundary);
        }
      }
      cacheableBytes[arm] = shared;
      prefixHashes[arm] = sha256Hex(probe.payload.bytes.subarray(0, shared));
    }

    // Size parity: the arms differ only in prefix stability, never in scale,
    // so the direction comparisons measure cache behavior, not fixture
    // authoring. The native summary's head is authored at exactly the
    // Context Memory wrapper's byte length.
    assert.deepEqual(
      Object.values(payloadLengths).map((lengths) => lengths.prime),
      Array(ARMS.length).fill(payloadLengths.stable.prime),
      `group ${group}: every arm's prime payload is byte-length identical`,
    );
    assert.deepEqual(
      Object.values(payloadLengths).map((lengths) => lengths.probe),
      Array(ARMS.length).fill(payloadLengths.stable.probe),
      `group ${group}: every arm's probe payload is byte-length identical`,
    );
    assert.deepEqual(
      Object.values(summaries),
      Array(ARMS.length).fill(summaries.stable),
      `group ${group}: every arm's carried summary is byte-length identical`,
    );

    const [systemEnd, toolsEnd] = composeRequest({ group, arm: "stable", role: "prime" }).layout.breakpoints;
    for (const arm of ["stable", "native"]) {
      // The unchanged-summary arms: the probe shares its prime's whole
      // payload, so its read extends through the summary AND the old tail —
      // the between-compaction case the tail breakpoint serves.
      assert.equal(
        cacheableBytes[arm],
        coverageEnd[arm],
        `group ${group} ${arm}: the probe's cacheable prefix covers the prime through its tail breakpoint`,
      );
      assert.ok(cacheableBytes[arm] > toolsEnd, "the read extends beyond the tools boundary");
    }
    // The control: the nonce diverges inside the earliest block — after the
    // tools boundary, before the tail — so its read falls back to exactly the
    // tools boundary. This is the arm that must be able to move.
    assert.equal(
      cacheableBytes.nonce,
      toolsEnd,
      `group ${group} nonce: the control's read falls back to the tools boundary`,
    );
    assert.ok(cacheableBytes.nonce < composeRequest({ group, arm: "nonce", role: "probe" }).layout.summary.start,
      "the control never reaches its own carried summary");

    // The three arms' cacheable prefixes genuinely differ: pairwise-distinct
    // prefix hashes, and the stable-versus-nonce constructional gap in tokens
    // over the probe's total exceeds the liveness margin many times over, so
    // the rule (nonce at least 5pp below stable) is capable of firing.
    assert.notEqual(prefixHashes.stable, prefixHashes.nonce);
    assert.notEqual(prefixHashes.nonce, prefixHashes.native);
    assert.notEqual(prefixHashes.stable, prefixHashes.native);
    const stableProbe = composeRequest({ group, arm: "stable", role: "probe" });
    const constructionalGapPp
      = (estimateTokens(cacheableBytes.stable) - estimateTokens(cacheableBytes.nonce)) / estimateTokens(stableProbe.payload.bytes.length);
    assert.ok(
      constructionalGapPp > LIVENESS_MARGIN_PP / 100,
      `group ${group}: the constructional read gap ${(constructionalGapPp * 100).toFixed(1)}pp exceeds the ${LIVENESS_MARGIN_PP}pp liveness margin`,
    );
    assert.ok(systemEnd < toolsEnd, "the pinned breakpoints are ordered system, tools, tail");
  }
}

// ─── per-arm divergence boundaries and prefix evidence ──────────────

{
  const { report } = await dryRun();
  for (const group of report.groups) {
    assert.equal(group.quality, "measurable");
    assert.equal(group.stable.probe.divergenceBoundary, "growing-tail",
      "the stable probe byte-extends its prime; the divergence lands in the grown tail");
    assert.equal(group.nonce.probe.divergenceBoundary, "memory-block-1",
      "the liveness control diverges inside the earliest block");
    assert.equal(group.native.probe.divergenceBoundary, "growing-tail",
      "the native baseline's unchanged summary also grows only at the tail");
    assert.ok(
      group.nonce.probe.sharedBytes < group.stable.probe.sharedBytes,
      "the control shares strictly fewer prefix bytes than the stable arm",
    );
    assert.equal(
      group.stable.probe.sharedBytes,
      group.stable.prime.payloadBytes,
      "the stable probe shares every byte of its prime",
    );
    assert.equal(
      group.native.probe.sharedBytes,
      group.native.prime.payloadBytes,
      "the native probe shares every byte of its prime",
    );
    for (const arm of ARMS) {
      const probe = group[arm].probe;
      const prime = group[arm].prime;
      assert.match(probe.payloadHash, /^[0-9a-f]{64}$/);
      assert.match(probe.prefixHash, /^[0-9a-f]{64}$/);
      assert.notEqual(probe.prefixHash, probe.payloadHash, "the shared prefix is never the whole probe payload");
      assert.equal(prime.prefixHash, null, "primes have no reference pair");
      assert.ok(probe.sharedBytes >= 0 && probe.sharedBytes < probe.payloadBytes);
      assert.ok(probe.ttftMs !== null && probe.ttftMs > 0, "TTFT is locally measured for every probe");
      assert.ok(prime.cost >= 0 && probe.cost >= 0);
      assert.equal(probe.primeToProbeMs !== null, true);
    }
    // The causal structure the arms exist for: stable reuse exceeds the control.
    assert.ok(group.stable.probe.cacheRead > group.nonce.probe.cacheRead);
    assert.ok(group.stable.probe.cacheRead > 0, "the stable arm's reuse is explicit non-zero evidence");
  }
}

// ─── the pinned per-group rotation unconfounds arm and position ─────

{
  assert.equal(ARM_ORDER.length, 3);
  assert.ok(ARM_ROTATION.includes("rotates left by (group - 1) mod 3"));
  // No arm always occupies the same position; across five groups every arm
  // reaches every position at least once (TTFT is position-sensitive, #268
  // defect 3).
  for (const arm of ARMS) {
    const positions = new Set();
    for (let group = 1; group <= GROUP_COUNT; group += 1) {
      positions.add(armOrderFor(group).indexOf(arm));
    }
    assert.deepEqual([...positions].sort(), [0, 1, 2], `${arm} occupies every arm position across the groups`);
  }
  // Primes before probes, same arm order within a group: every probe follows
  // its prime with the same number of intervening requests.
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    const steps = groupOrder(group);
    assert.ok(steps.slice(0, 3).every((step) => step.endsWith(".prime")));
    assert.ok(steps.slice(3).every((step) => step.endsWith(".probe")));
    assert.deepEqual(
      steps.slice(0, 3).map((step) => step.split(".")[0]),
      steps.slice(3).map((step) => step.split(".")[0]),
      "the probe half repeats the prime half's arm order",
    );
  }
}

// ─── pins: model, tools, system prompt, settings, routing, fixture,
// retention, group order, timing ─────────────────────────────────────

{
  const { report } = await dryRun();
  const { pins } = report;
  assert.equal(pins.model, "simulated/prefix-cache-v1");
  assert.deepEqual(pins.toolNames, ["read", "grep", "read_memory_source"]);
  assert.match(pins.toolsHash, /^[0-9a-f]{64}$/);
  assert.match(pins.systemPromptHash, /^[0-9a-f]{64}$/);
  assert.match(pins.settingsHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(pins.settings, { temperature: 0, maxOutputTokens: 512, stream: true, thinking: "off" });
  assert.deepEqual(pins.routing, { concurrency: 1, retryPolicy: "none", sessionScope: "arm-per-group" });
  assert.equal(pins.fixtureDigest, fixtureDigest(), "the fixture digest pins every composed payload of the enlarged fixture");
  assert.deepEqual(pins.groupOrder, Array.from({ length: GROUP_COUNT }, (_, index) => groupOrder(index + 1)));
  assert.equal(pins.armRotation, ARM_ROTATION);
  assert.ok(pins.measuredCase.startsWith("between-compaction"), "the pins name the measured case");
  assert.ok(pins.measuredCase.includes("is not measured"), "the pins state that the compaction boundary is not measured");
  assert.equal(pins.retention.bucket, "default");
  assert.equal(pins.retention.ttlMs, 300_000);
  assert.equal(pins.retention.breakpoint, BREAKPOINT_PLACEMENT, "the pins record the modelled breakpoint placement");
  assert.equal(pins.adapterBreakpointPlacement, BREAKPOINT_PLACEMENT);
  assert.ok(BREAKPOINT_PLACEMENT.startsWith("mirrors Pi's anthropic-messages placement"),
    "the placement phrase names what was modelled");
  for (const position of ["system", "tool", "user message"]) {
    assert.ok(BREAKPOINT_PLACEMENT.includes(position), `the placement names the ${position} position`);
  }
  assert.equal(pins.timing.ttlMs, 300_000);
  assert.ok(typeof pins.timing.rule === "string" && pins.timing.rule.includes("ttlMs"));
  // Every group's probes stay inside the TTL under the dry-run clock.
  for (const group of report.groups) {
    for (const elapsed of Object.values(group.timing.primeToProbeMs)) {
      assert.ok(elapsed <= pins.timing.ttlMs, `probe ${elapsed}ms inside the ${pins.timing.ttlMs}ms TTL`);
    }
    assert.equal(group.timing.withinTtl, true);
  }
  // Retention-specific writes are recorded where the adapter reports them.
  for (const group of report.groups) {
    assert.equal(group.stable.prime.retentionWriteReported, true);
    assert.equal(group.stable.prime.retentionBucket, "default");
    assert.ok(group.stable.prime.retentionWriteTokens > 0, "the prime's breakpoint write is retention evidence");
    assert.ok(group.stable.probe.retentionWriteTokens >= 0);
  }
  assert.equal(report.totals.requestsWithRetentionReport, report.totals.requests);
  // Payload hashes differ across groups (per-group trace) but are recorded exactly.
  const primeHashes = new Set(report.groups.map((group) => group.stable.prime.payloadHash));
  assert.equal(primeHashes.size, GROUP_COUNT, "each group runs its own salted trace instance");
}

// ─── the re-pinned fixture digest ───────────────────────────────────

{
  const first = fixtureDigest();
  assert.equal(first, fixtureDigest(), "the digest is deterministic for the enlarged fixture");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, fixtureDigest(GROUP_COUNT - 1), "the digest covers every group's payloads");
}

// ─── the non-regression standard in the report ──────────────────────

{
  const { report, humanText } = await dryRun();
  const { cacheStandard: standard } = report;
  assert.equal(standard.hitRateDefinition, HIT_RATE_DEFINITION);
  assert.equal(standard.band.baselineArm, "native", "Pi native is the baseline");
  assert.equal(standard.band.belowBaselinePercentagePoints, NON_REGRESSION_BAND_PP);
  assert.equal(standard.liveness.controlArm, "nonce");
  assert.equal(standard.liveness.measuredAgainst, "stable");
  assert.equal(standard.liveness.belowMarginPercentagePoints, LIVENESS_MARGIN_PP);
  assert.equal(standard.groupsAggregated, GROUP_COUNT);
  assert.equal(standard.cacheActivityObserved, true);
  for (const arm of ARMS) {
    const rate = standard.rates[arm];
    assert.ok(rate.denominator > 0);
    assert.ok(rate.rate > 0 && rate.rate <= 1, `${arm} records a measured rate`);
    assert.equal(rate.denominator, rate.cacheRead + rate.cacheCreation + rate.uncachedInput);
  }
  // The honest simulation: stable at the native baseline, nonce far below stable.
  assert.equal(standard.bandSatisfied, true);
  assert.equal(standard.livenessSatisfied, true);
  assert.ok(standard.rates.stable.rate >= standard.rates.native.rate, "the stable arm never sits below the native baseline here");
  assert.ok(standard.rates.nonce.rate <= standard.rates.stable.rate - LIVENESS_MARGIN_PP / 100);
  assert.equal(
    standard.minimumAcceptableStableRate,
    Math.round(Math.max(0, standard.rates.native.rate - NON_REGRESSION_BAND_PP / 100) * 1e4) / 1e4,
  );
  // The report states the pinned definition, the band, the baseline, each
  // arm's rate, the liveness outcome, and the denominator caveat (#260).
  assert.ok(humanText.includes("hit rate"));
  assert.ok(humanText.includes("baseline"));
  assert.ok(humanText.includes("liveness"));
  assert.ok(humanText.includes(DENOMINATOR_NOTE), "the report states the differing-denominator caveat verbatim");
  assert.ok(humanText.includes("must not be reused as a cost metric"));
  assert.ok(report.conclusion.reasons.some((reason) => reason.startsWith("non-regression band met")));
  assert.ok(report.conclusion.reasons.some((reason) => reason.startsWith("liveness control alive")));
}

// ─── native comparison is reported per group and by median ──────────

{
  const { report, humanText } = await dryRun();
  for (const group of report.groups) {
    assert.equal(group.nativeComparison.evaluated, true);
    for (const direction of ["inputTokens", "writeSpend", "ttft"]) {
      assert.ok(["worse", "better", "equal", "unreported"].includes(group.nativeComparison.directions[direction]));
    }
    assert.ok(["worse", "better", "equal"].includes(group.nativeComparison.derived.cost),
      "cost is reported as a derived figure per group");
  }
  const { nativeSummary } = report;
  assert.equal(nativeSummary.groupsEvaluated, GROUP_COUNT);
  for (const direction of ["inputTokens", "writeSpend", "ttft"]) {
    const summary = nativeSummary.perDirection[direction];
    assert.ok(Number.isFinite(summary.medianDelta) && summary.medianDelta !== null);
    assert.equal(summary.worse + summary.better + summary.equal + summary.unreported, GROUP_COUNT);
  }
  assert.ok(!("cost" in nativeSummary.perDirection), "cost is not a counted direction");
  assert.ok(Number.isFinite(nativeSummary.derived.cost.medianDelta));
  assert.ok(nativeSummary.derived.cost.note.includes("derived figure"));
  // TTFT dispersion alongside the median delta (#268 defect 3): a delta
  // smaller than the spread cannot read as a finding, and the report states
  // both so no reader has to infer it.
  assert.ok(nativeSummary.perDirection.ttft.spreadMs !== null && nativeSummary.perDirection.ttft.spreadMs >= 0);
  assert.ok(humanText.includes("spread"), "the human report states the TTFT dispersion");
  assert.ok(humanText.includes("cost (derived)"), "the human report marks cost as derived");
  // Each counted direction states what it measures and why it is independent.
  assert.deepEqual(report.regression.directions.counted, ["inputTokens", "writeSpend", "ttft"]);
  for (const note of Object.values(report.regression.directions.notes)) {
    assert.ok(note.includes("independent"), "every direction note states its independence");
    assert.ok(humanText.includes(note), "the human report restates each direction note");
  }
  assert.ok(report.regression.directions.derivedNote.includes("never counted as a regression direction"));
  assert.ok(nativeSummary.armMedians.probeTtftMs.stable !== null);
  assert.ok(nativeSummary.armMedians.cost.native !== null);
  // The dry run never claims the regression rule.
  assert.equal(report.regression.groupsRegressed < 4, true);
}

// ─── privacy and framing of the bounded report ──────────────────────

{
  const { report, json, humanText } = await dryRun();
  assert.deepEqual(findReportLeaks(json), [], "no fixture marker, padding runs, or claim phrases");
  assert.ok(!json.includes(MARKER));
  assert.ok(!json.includes(SYSTEM_PROMPT.slice(0, 40)), "the pinned system prompt text never appears");
  assert.ok(!json.includes("checks: 42 passed"), "trace tail text never appears");
  assert.ok(!json.includes("frozen row"), "enlarged fixture bodies never appear");
  assert.equal(report.framing.disclaimer, FRAMING_DISCLAIMER);
  assert.ok(humanText.includes(FRAMING_DISCLAIMER));
  for (const phrase of FORBIDDEN_CLAIM_PHRASES) {
    assert.ok(!humanText.includes(phrase), `the human report must not claim "${phrase}"`);
    assert.ok(!json.includes(phrase), `the JSON report must not claim "${phrase}"`);
  }
  let longest = 0;
  (function walk(value) {
    if (typeof value === "string") longest = Math.max(longest, value.length);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  })(report);
  assert.ok(longest <= 240, `every report string stays bounded (longest ${longest})`);
}

// ─── determinism ────────────────────────────────────────────────────

{
  const first = await dryRun();
  const second = await dryRun();
  assert.deepEqual(first.report, second.report, "two dry runs produce byte-identical evidence");
}

// ─── the dead-measurement world: constant reads, alive-looking groups ─

{
  // The #251 signature as an adapter: every probe reports the same constant
  // read regardless of content, exactly as the measured gateway did when the
  // fixture sat below the cacheable floor. Every group is measurable and the
  // band holds trivially, so only the liveness control can expose the run as
  // dead — and it must, because a dead measurement is never a pass.
  const constantReadAdapter = {
    id: "simulated-dead-measurement/1",
    describePins: () => ({ provider: "simulated", model: "simulated/constant-read-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    async send(request, observe = {}) {
      observe.onFirstToken?.();
      const probe = request.role === "probe";
      const read = probe ? 1089 : 0;
      const write = probe ? 96 : 1185;
      const input = probe ? 166 : 0;
      return {
        usage: { inputTokens: input, outputTokens: probe ? 64 : 48 },
        cache: { reported: true, read, write },
        retentionWrite: { reported: true, bucket: "default", tokens: write },
        cost: 0,
      };
    },
  };
  const clock = fakeClock();
  const { report, humanText, exitCode } = await runExperiment({
    adapter: constantReadAdapter,
    clock,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(report.integrity.ok, true);
  for (const group of report.groups) assert.equal(group.quality, "measurable");
  assert.equal(report.cacheStandard.cacheActivityObserved, true);
  assert.equal(report.cacheStandard.bandSatisfied, true, "equal rates satisfy the band trivially");
  assert.equal(report.cacheStandard.livenessSatisfied, false, "the constant read cannot distinguish content");
  assert.equal(report.conclusion.cache, "inconclusive");
  assert.equal(report.conclusion.final, "inconclusive");
  assert.equal(exitCode, 1);
  assert.ok(humanText.includes("liveness"), "the human report names the dead liveness control");
  assert.ok(report.conclusion.reasons.some((reason) => reason.includes("liveness control dead")));
}

// ─── unsupported cache reporting: absent, not zero ──────────────────

{
  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000, cacheReporting: "unsupported" });
  const { report, exitCode } = await runExperiment({ adapter, clock, generatedAt: () => "2026-01-01T00:00:00.000Z" });
  assert.equal(report.adapter.cacheReporting, "unsupported");
  for (const group of report.groups) {
    assert.equal(group.quality, "missing-report");
    for (const arm of ARMS) {
      for (const role of ["prime", "probe"]) {
        assert.equal(group[arm][role].cacheReported, false);
        assert.equal(group[arm][role].cacheRead, 0, "unreported values are recorded as zero data, but flagged unreported");
      }
    }
  }
  assert.equal(report.conclusion.cache, "inconclusive");
  assert.equal(report.conclusion.final, "inconclusive");
  assert.equal(exitCode, 1);
}

// ─── ordering integrity: only the pinned per-group order is valid ───

{
  // A fixed, never-rotated order — the pre-#268 shape — deviates from the
  // pinned rotation and must fail integrity, whatever its other merits.
  const fixedOrder = () => [
    "stable.prime",
    "nonce.prime",
    "native.prime",
    "stable.probe",
    "nonce.probe",
    "native.probe",
  ];
  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  const { report, exitCode } = await runExperiment({
    adapter,
    clock,
    orderFor: fixedOrder,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(report.integrity.orderMatchesPin, false);
  assert.equal(report.integrity.ok, false);
  assert.ok(report.integrity.failures.some((failure) => failure.includes("deviated from the pinned rotated per-group order")));
  assert.equal(report.conclusion.cache, "inconclusive");
  assert.equal(report.conclusion.final, "inconclusive");
  assert.equal(exitCode, 1);
}

// ─── adapter failures and malformed reports are integrity failures ──

{
  const clock = fakeClock();
  const adapter = {
    id: "simulated-malformed/1",
    describePins: () => ({ provider: "simulated", model: "simulated/malformed-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    async send() {
      return { usage: { inputTokens: 1, outputTokens: 1 }, cache: { reported: true, read: -3, write: 0 }, cost: 0 };
    },
  };
  const { report, exitCode } = await runExperiment({ adapter, clock, generatedAt: () => "2026-01-01T00:00:00.000Z" });
  assert.equal(report.integrity.ok, false);
  assert.equal(report.integrity.providerErrors, 1);
  assert.ok(report.integrity.failures[0].includes("stable.prime"));
  assert.equal(report.totals.groups, 0, "a failed run classifies no groups");
  assert.equal(report.conclusion.final, "inconclusive");
  assert.equal(exitCode, 1);
}

{
  const clock = fakeClock();
  let calls = 0;
  const adapter = {
    id: "simulated-throwing/1",
    describePins: () => ({ provider: "simulated", model: "simulated/throwing-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    async send() {
      calls += 1;
      if (calls === 2) throw new Error("provider transport failed");
      return { usage: { inputTokens: 1, outputTokens: 1 }, cache: { reported: true, read: 0, write: 1 }, cost: 0 };
    },
  };
  const { report } = await runExperiment({ adapter, clock, generatedAt: () => "2026-01-01T00:00:00.000Z" });
  assert.equal(report.integrity.providerErrors, 1);
  assert.ok(report.integrity.failures[0].includes("the adapter threw"));
  assert.equal(report.totals.requests, 1, "execution stops at the first adapter failure");
}

// ─── divergence invariant classification ────────────────────────────

{
  const summary = { start: 100, end: 900 };
  const blocks = [
    { start: 200, end: 300 },
  ];
  // The between-compaction arms: sharing every prime byte is the invariant.
  assert.deepEqual(classifyDivergenceBoundary("stable", { summary, blocks }, 1000, 1000), { ok: true, boundary: "growing-tail" });
  assert.deepEqual(classifyDivergenceBoundary("native", { summary, blocks: [] }, 1000, 1000), { ok: true, boundary: "growing-tail" });
  assert.deepEqual(classifyDivergenceBoundary("stable", { summary, blocks }, 999, 1000), { ok: false, boundary: "inside-carried-prefix" });
  assert.deepEqual(classifyDivergenceBoundary("native", { summary, blocks: [] }, 1001, 1000), { ok: false, boundary: "inside-carried-prefix" });
  assert.deepEqual(classifyDivergenceBoundary("stable", { summary, blocks }, 900, undefined), { ok: false, boundary: "inside-carried-prefix" },
    "a missing prime length cannot validate the invariant");
  // The control: divergence inside the earliest block.
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 250), { ok: true, boundary: "memory-block-1" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 200), { ok: true, boundary: "memory-block-1" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 199), { ok: false, boundary: "outside-earliest-block" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 300), { ok: false, boundary: "outside-earliest-block" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks: [] }, 250), { ok: false, boundary: "outside-earliest-block" });
}

// ─── report leak detection ──────────────────────────────────────────

{
  assert.deepEqual(findReportLeaks("clean report text"), []);
  assert.deepEqual(findReportLeaks(`body with ${MARKER} inside`), ["the fixture content marker"]);
  assert.deepEqual(findReportLeaks("padding aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ["a 64+ character repeated run"]);
  assert.deepEqual(findReportLeaks("this result is statistically significant"), ['the claim phrase "statistically significant"']);
}

// ─── the command itself ─────────────────────────────────────────────

{
  const result = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, `dry-run command exits clean:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("result: POSITIVE"));
  assert.ok(result.stdout.includes("hit rate"), "the human report reflects the non-regression standard");
  assert.ok(result.stdout.includes("liveness"));
  assert.ok(result.stdout.includes("breakpoints: mirrors Pi's anthropic-messages placement"),
    "the human report states the modelled breakpoint placement");
  assert.ok(result.stdout.includes("framing:"));
  const jsonPath = join(HERE, "report", "provider-cache-experiment.json");
  assert.ok(existsSync(jsonPath), "the report artifact is written beside the harness");
  const written = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(written.schema, "pi-square.context-memory/provider-cache-experiment/1");
  assert.equal(written.cacheStandard.band.baselineArm, "native");
}

{
  const result = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--real"], { encoding: "utf8" });
  assert.equal(result.status, 2, "credentialed execution is refused in this slice");
  assert.ok(result.stderr.includes("#227"));
}

{
  const result = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--nonsense"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown argument"));
}

console.log("experiment.test.mjs: all dry-run coverage passed");
