import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARMS,
  ARM_ORDER,
  ARM_ROTATION,
  BREAKPOINT_PLACEMENT,
  CARRIED_PREFIX_FLOOR_TOKENS,
  armNamespace,
  COVERED_PREFIX_FLOOR_TOKENS,
  GROUP_COUNT,
  MARKER,
  MEASURED_CACHEABLE_PREFIX_TOKENS,
  SYSTEM_PROMPT,
  armOrderFor,
  baseBlocks,
  carriedBodies,
  composeRequest,
  fixtureDigest,
  groupOrder,
  summaryPartTexts,
} from "./fixture.mjs";
import { estimateTokens, firstDivergence, sha256Hex } from "./evidence.mjs";
import { fakeClock, simulatedCacheAdapter } from "./fake-provider.mjs";
import { classifyDivergenceBoundary, findReportLeaks, runExperiment } from "./runner.mjs";
import {
  DEAD_CONTROL_NOTE,
  DENOMINATOR_NOTE,
  DIRECTION_NOISE_FLOORS,
  FORBIDDEN_CLAIM_PHRASES,
  FRAMING_DISCLAIMER,
  HIT_RATE_DEFINITION,
  LIVENESS_MARGIN_PP,
  NON_REGRESSION_BAND_PP,
} from "./verdict.mjs";

/**
 * End-to-end dry-run coverage for the provider-cache experiment (#225,
 * standard re-pinned by #260, arms and order re-modeled by #268, cross-
 * compaction append case re-pinned by #297): the full harness runs against
 * the simulated breakpoint-cache adapter with a fake clock, proving the
 * pinned experiment shape and fixture scale, the recorded evidence, the
 * append-case divergence invariants, run integrity, the honest neutral
 * verdict with the dead-control caveat, the exit contract (integrity, not
 * conclusion), determinism, report privacy, and the command-line surface —
 * without credentials and without any real provider call.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

async function dryRun() {
  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  return runExperiment({
    adapter,
    clock,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    implementationCommit: "0123456789abcdef0123456789abcdef01234567",
  });
}

/** The report directory's artifacts of one mode, oldest first by name. */
function reportArtifacts(prefix) {
  const dir = join(HERE, "report");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(prefix)).sort() : [];
}

// ─── the full dry run: honest neutral, integrity clean, exit zero ────

{
  const { report, exitCode } = await dryRun();
  assert.equal(report.mode, "dry-run");
  assert.equal(report.integrity.ok, true);
  assert.equal(report.conclusion.cache, "neutral",
    "the honest simulation lands the neutral branch: no arm reads past the tools boundary across an append under the pinned placement");
  assert.equal(report.conclusion.final, "neutral");
  assert.equal(exitCode, 0, "integrity, not the conclusion label, decides the exit code");
  assert.equal(report.totals.groups, GROUP_COUNT);
  assert.equal(report.totals.requests, GROUP_COUNT * groupOrder(1).length, "five interleaved paired groups over three arms");
  assert.equal(report.regression.fired, false);
  assert.ok(report.conclusion.reasons.includes(DEAD_CONTROL_NOTE),
    "the neutral verdict carries the dead-control caveat verbatim");
}

// ─── the fixture is large enough for the measurement to exist ───────

{
  // #260/#251: the measured gateway caches nothing below a minimum
  // cacheable prefix near 1024 tokens. Every composed request's covered
  // prefix (bytes zero through the tail breakpoint — system, tools, carried
  // summary, and the whole tail) must clear the pinned floor, which is twice
  // the measured floor: margin above it, never to it. And because the
  // property under test is reuse of the carried region, every probe's
  // carried prefix (system, tools, framing, and blocks 1–2 — exactly the
  // bytes the append shares) must additionally clear the measured floor
  // itself, so a zero read can never be blamed on scale (#297).
  assert.equal(COVERED_PREFIX_FLOOR_TOKENS, 2 * MEASURED_CACHEABLE_PREFIX_TOKENS, "the covered floor is twice the measured floor");
  assert.equal(CARRIED_PREFIX_FLOOR_TOKENS, MEASURED_CACHEABLE_PREFIX_TOKENS, "the carried floor is the measured floor");
  let smallestCovered = Infinity;
  let smallestCarried = Infinity;
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const arm of ARMS) {
      for (const role of ["prime", "probe"]) {
        const { payload, layout } = composeRequest({ group, arm, role });
        const coveredTokens = estimateTokens(layout.breakpoints.at(-1));
        smallestCovered = Math.min(smallestCovered, coveredTokens);
        assert.ok(
          coveredTokens >= COVERED_PREFIX_FLOOR_TOKENS,
          `${arm}.${role} covers ${coveredTokens} tokens, below the ${COVERED_PREFIX_FLOOR_TOKENS}-token floor`,
        );
        assert.ok(coveredTokens <= payload.bytes.length);
        // The padding stays disciplined: no 64+ repeated character run ever
        // enters a payload, so a leaked body stays detectable.
        assert.ok(!/(.)\1{63}/.test(payload.bytes.toString("utf8")));
        if (role === "probe") {
          // The carried prefix ends exactly at the pinned append seam; the
          // nonce arm's seam sits inside block 1 by construction, so its
          // carried measurement uses the end of block 2 instead.
          const carriedEnd = arm === "nonce"
            ? layout.blocks[1].end
            : layout.expectedShared;
          const carriedTokens = estimateTokens(carriedEnd);
          smallestCarried = Math.min(smallestCarried, carriedTokens);
          assert.ok(
            carriedTokens >= CARRIED_PREFIX_FLOOR_TOKENS,
            `${arm} probe carries ${carriedTokens} shared tokens, below the ${CARRIED_PREFIX_FLOOR_TOKENS}-token carried floor`,
          );
        }
      }
    }
  }
  assert.ok(smallestCovered > COVERED_PREFIX_FLOOR_TOKENS, "the smallest covered prefix clears the floor with headroom, not exactly at it");
  assert.ok(smallestCarried > CARRIED_PREFIX_FLOOR_TOKENS, "the smallest carried prefix clears the measured floor with headroom");
  // Block bodies stay well inside the production 16-KiB Memory block bound.
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const body of baseBlocks(group)) {
      assert.ok(Buffer.byteLength(body, "utf8") < 16 * 1024);
      assert.ok(body.length > 1000, "each carried block is a substantive enlarged body");
    }
  }
}

// ─── content parity and bounded structural overhead across arms ─────

{
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const role of ["prime", "probe"]) {
      const composed = {};
      const lengths = {};
      for (const arm of ARMS) {
        const request = composeRequest({ group, arm, role });
        composed[arm] = request.layout.summaryParts.map((part) => part.end - part.start);
        lengths[arm] = request.payload.bytes.length;
      }
      // The summary region's concatenated text is byte-identical across arms:
      // the arms hold semantic content, scale, and framing constant and
      // differ only in where the text block boundaries sit (and the nonce
      // digits inside the control's earliest block).
      assert.equal(
        composed.multiblock.reduce((a, b) => a + b, 0) - composed.single[0],
        composed.nonce.reduce((a, b) => a + b, 0) - composed.single[0],
        `group ${group} ${role}: the nonce substitution is fixed-width`,
      );
      // The structural framing overhead — the canonical per-segment framing
      // the multi-part arms carry and the single part does not — stays far
      // below the pinned per-direction noise floors, so it can never fire a
      // regression direction on its own.
      const overheadBytes = Math.max(
        lengths.multiblock - lengths.single,
        lengths.nonce - lengths.single,
      );
      assert.ok(
        overheadBytes >= 0 && overheadBytes <= 256,
        `group ${group} ${role}: the arms' payloads stay within ${256} bytes (${overheadBytes})`,
      );
      assert.ok(
        estimateTokens(overheadBytes) < DIRECTION_NOISE_FLOORS.inputTokens.absoluteTokens,
        `group ${group} ${role}: the structural overhead (${estimateTokens(overheadBytes)} tokens) sits below the token noise floor`,
      );
    }
  }
}

// ─── per-arm cold namespaces: no arm reads another arm's cache ───────

{
  // #297 review finding 1: without isolation the arms shared system, tools,
  // blocks, and tail bytes, so one arm's probe could read another arm's
  // prime's cache — the measured full reads flipped with probe position, and
  // the arm comparison measured cross-arm contamination. Every arm now
  // carries a fixed-width, semantically neutral namespace line in its system
  // segment: identical between the arm's prime and probe (the same-arm
  // carried prefix stays byte-stable), different for every arm (cross-arm
  // requests diverge inside the system segment, before any breakpoint, so no
  // cross-arm cache read is possible at any breakpoint the placement serves).
  const namespaces = new Set(ARMS.map((arm) => armNamespace(arm)));
  assert.equal(namespaces.size, ARMS.length, "every arm has its own cold namespace");
  for (const arm of ARMS) {
    const prime = composeRequest({ group: 1, arm, role: "prime" });
    const probe = composeRequest({ group: 1, arm, role: "probe" });
    const systemText = (request) => {
      const segment = request.payload.table.find((entry) => entry.element === "system");
      return request.payload.bytes.subarray(segment.contentStart, segment.contentEnd).toString("utf8");
    };
    assert.ok(systemText(prime).includes(armNamespace(arm)), `${arm}'s prime carries its namespace`);
    assert.ok(systemText(probe).includes(armNamespace(arm)), `${arm}'s probe carries the same namespace`);
    assert.equal(systemText(prime).length, systemText(probe).length, `${arm}'s namespace line is fixed-width`);
  }
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const probeArm of ARMS) {
      const probe = composeRequest({ group, arm: probeArm, role: "probe" });
      const [systemEnd] = probe.layout.breakpoints;
      for (const otherArm of ARMS) {
        if (otherArm === probeArm) continue;
        for (const otherRole of ["prime", "probe"]) {
          const other = composeRequest({ group, arm: otherArm, role: otherRole });
          const shared = firstDivergence(other.payload, probe.payload).sharedBytes;
          assert.ok(
            shared < systemEnd,
            `group ${group}: ${probeArm}'s probe diverges from ${otherArm}.${otherRole} inside the system segment (byte ${shared} < ${systemEnd})`,
            "cross-arm requests share nothing a breakpoint could serve");
        }
      }
      // Same-arm stability: the probe shares exactly its pinned append seam
      // with its own prime — asserted per arm in the section below.
    }
  }
}

// ─── the append case: what a breakpoint cache can and cannot serve ───

{
  // The measured case is the cross-compaction append: the prime carries
  // blocks 1–2, the probe carries them byte-identical plus block 3. Under
  // the pinned breakpoint placement — system, last tool, last user-message
  // block, exactly where Pi's anthropic-messages converter puts them, and
  // nowhere at the carried Memory's end — every arm's probe falls back to
  // exactly the tools boundary, because the appended block shifts every byte
  // after it. That is #269's finding, reproduced constructionally: the
  // multi-block structure alone changes nothing a breakpoint cache can see.
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    const cacheableBytes = {};
    const prefixHashes = {};
    const seams = {};
    for (const arm of ARMS) {
      const prime = composeRequest({ group, arm, role: "prime" });
      const probe = composeRequest({ group, arm, role: "probe" });
      // The first byte where the probe diverges from its prime: the pinned
      // append seam for the multiblock and single arms, inside block 1 for
      // the nonce control.
      seams[arm] = firstDivergence(prime.payload, probe.payload).sharedBytes;
      // The longest boundary cached by the prime (its own three breakpoints)
      // whose bytes the probe still shares — the way a provider serves it.
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
    const [, toolsEnd] = composeRequest({ group, arm: "multiblock", role: "prime" }).layout.breakpoints;
    for (const arm of ARMS) {
      assert.equal(
        cacheableBytes[arm],
        toolsEnd,
        `group ${group} ${arm}: under the pinned placement every arm's append read falls back to the tools boundary`,
      );
      assert.ok(seams[arm] > toolsEnd, `group ${group} ${arm}: the append seam sits beyond the tools boundary, inside the carried region`);
    }
    // The control's effectiveness is positional, not scale-limited: every
    // probe's shared prefix through its append seam clears the measured
    // cacheable floor (asserted above), so on any provider or placement that
    // can serve the carried region, the nonce arm's strictly smaller shared
    // prefix (it diverges inside block 1) makes the liveness rule capable of
    // firing. Its death here is the placement, not the fixture.
    assert.ok(seams.nonce < seams.multiblock, "the control shares strictly fewer prefix bytes than the arm under test");
    assert.ok(seams.nonce < seams.single, "the control also shares fewer prefix bytes than the baseline");
    // Even at the shared tools-boundary fallback, the per-arm cold
    // namespaces make every arm's served prefix hash pairwise distinct: no
    // arm can ever serve another arm's cache, at any breakpoint.
    assert.notEqual(prefixHashes.multiblock, prefixHashes.single);
    assert.notEqual(prefixHashes.multiblock, prefixHashes.nonce);
    assert.notEqual(prefixHashes.single, prefixHashes.nonce);
    assert.ok(seams.single < seams.multiblock,
      "the baseline's seam sits inside its one summary part; the multiblock arm's sits after its last carried part's framing");
    // The carried blocks really are byte-identical between the pair's two
    // requests — the append-property under test, checked directly on bodies.
    for (const arm of ["multiblock", "single"]) {
      const primeBodies = carriedBodies({ group, arm, role: "prime" });
      const probeBodies = carriedBodies({ group, arm, role: "probe" });
      assert.deepEqual(probeBodies.slice(0, 2), primeBodies, `group ${group} ${arm}: blocks 1–2 are byte-identical across the append`);
    }
  }
}

// ─── per-arm divergence boundaries and prefix evidence ──────────────

{
  const { report } = await dryRun();
  for (const group of report.groups) {
    assert.equal(group.quality, "measurable");
    assert.equal(group.multiblock.probe.divergenceBoundary, "appended-block",
      "the multiblock probe shares every carried byte and diverges exactly at the appended block's part");
    assert.equal(group.single.probe.divergenceBoundary, "appended-block",
      "the single probe shares every carried byte and diverges exactly at the append seam");
    assert.equal(group.nonce.probe.divergenceBoundary, "memory-block-1",
      "the liveness control diverges inside the earliest carried block");
    assert.ok(
      group.nonce.probe.sharedBytes < group.multiblock.probe.sharedBytes,
      "the control shares strictly fewer prefix bytes than the arm under test",
    );
    assert.ok(
      group.multiblock.probe.sharedBytes < group.multiblock.prime.payloadBytes,
      "the append probe shares its prime's carried prefix but never its whole payload",
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
  }
}

// ─── the production projection arms are what they claim ─────────────

{
  // The multiblock arm's parts come from the extension's own projection and
  // the single arm's part from Pi's own rendering, so the fixture cannot
  // drift from production behavior: the parts concatenate to identical text.
  const jiti = (await import("jiti")).default;
  const load = jiti(import.meta.url, { moduleCache: false });
  const { composeMemorySummary } = await load("../../../src/context-memory/format.ts");
  const { projectMemoryBlocksMessage } = await load("../../../src/context-memory/controller.ts");
  for (const role of ["prime", "probe"]) {
    const bodies = carriedBodies({ group: 1, arm: "multiblock", role });
    const summary = composeMemorySummary(bodies);
    const projected = projectMemoryBlocksMessage(
      [{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }],
      [{ summary, bodies }],
    );
    assert.notEqual(projected, undefined, "the production projection accepts the fixture bodies");
    assert.deepEqual(projected[0].content.map((part) => part.text), summaryPartTexts("multiblock", bodies),
      `the multiblock arm's parts are exactly the production projection's parts (${role})`);
    assert.equal(
      summaryPartTexts("multiblock", bodies).join(""),
      summaryPartTexts("single", bodies).join(""),
      `the arms' summary regions concatenate to identical model-visible text (${role})`,
    );
    assert.equal(summaryPartTexts("multiblock", bodies).length, bodies.length + 2,
      "one part per block plus the two framing parts");
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
  assert.equal(pins.fixtureDigest, fixtureDigest(), "the fixture digest pins every composed payload of the re-pinned fixture");
  // #297 review finding 5: the report records the exact implementation commit
  // it measured, so stale evidence can never authorize later code.
  assert.equal(pins.implementationCommit, "0123456789abcdef0123456789abcdef01234567");
  assert.ok(typeof pins.armIsolation === "string" && pins.armIsolation.includes("cold namespace"),
    "the pins state the per-arm cold-namespace isolation rule");
  assert.deepEqual(pins.groupOrder, Array.from({ length: GROUP_COUNT }, (_, index) => groupOrder(index + 1)));
  assert.equal(pins.armRotation, ARM_ROTATION);
  assert.ok(pins.measuredCase.startsWith("cross-compaction append"), "the pins name the measured case");
  assert.ok(pins.measuredCase.includes("multiblock"), "the pins name the arm under test");
  assert.ok(pins.measuredCase.includes("single"), "the pins name the baseline");
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
    assert.equal(group.multiblock.prime.retentionWriteReported, true);
    assert.equal(group.multiblock.prime.retentionBucket, "default");
    assert.ok(group.multiblock.prime.retentionWriteTokens > 0, "the prime's breakpoint write is retention evidence");
    assert.ok(group.multiblock.probe.retentionWriteTokens >= 0);
  }
  assert.equal(report.totals.requestsWithRetentionReport, report.totals.requests);
  // Payload hashes differ across groups (per-group trace) but are recorded exactly.
  const primeHashes = new Set(report.groups.map((group) => group.multiblock.prime.payloadHash));
  assert.equal(primeHashes.size, GROUP_COUNT, "each group runs its own salted trace instance");
}

// ─── the re-pinned fixture digest ───────────────────────────────────

{
  const first = fixtureDigest();
  assert.equal(first, fixtureDigest(), "the digest is deterministic for the re-pinned fixture");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, fixtureDigest(GROUP_COUNT - 1), "the digest covers every group's payloads");
}

// ─── the non-regression standard in the report ──────────────────────

{
  const { report, humanText } = await dryRun();
  const { cacheStandard: standard } = report;
  assert.equal(standard.hitRateDefinition, HIT_RATE_DEFINITION);
  assert.equal(standard.band.baselineArm, "single", "the single-summary rendering is the baseline");
  assert.equal(standard.band.armUnderTest, "multiblock");
  assert.equal(standard.band.belowBaselinePercentagePoints, NON_REGRESSION_BAND_PP);
  assert.equal(standard.liveness.controlArm, "nonce");
  assert.equal(standard.liveness.measuredAgainst, "multiblock");
  assert.equal(standard.liveness.belowMarginPercentagePoints, LIVENESS_MARGIN_PP);
  assert.equal(standard.groupsAggregated, GROUP_COUNT);
  assert.equal(standard.cacheActivityObserved, true);
  for (const arm of ARMS) {
    const rate = standard.rates[arm];
    assert.ok(rate.denominator > 0);
    assert.ok(rate.rate > 0 && rate.rate <= 1, `${arm} records a measured rate`);
    assert.equal(rate.denominator, rate.cacheRead + rate.cacheCreation + rate.uncachedInput);
  }
  // The honest simulation: multiblock at the single baseline, the control
  // indistinguishable — both facts the #297 case makes structural.
  assert.equal(standard.bandSatisfied, true);
  assert.equal(standard.improvementObserved, false);
  assert.equal(standard.livenessSatisfied, false, "no breakpoint sits at the carried Memory's end, so the control is dead");
  assert.equal(
    standard.minimumAcceptableRate,
    Math.round(Math.max(0, standard.rates.single.rate - NON_REGRESSION_BAND_PP / 100) * 1e4) / 1e4,
  );
  assert.ok(humanText.includes("hit rate"));
  assert.ok(humanText.includes("baseline"));
  assert.ok(humanText.includes("liveness"));
  assert.ok(humanText.includes(DENOMINATOR_NOTE), "the report states the differing-denominator caveat verbatim");
  assert.ok(humanText.includes("must not be reused as a cost metric"));
  assert.ok(humanText.includes("measured case: cross-compaction append"), "the human report names the measured case");
  assert.ok(report.conclusion.reasons.some((reason) => reason.startsWith("non-regression band met")));
  assert.ok(report.conclusion.reasons.includes(DEAD_CONTROL_NOTE));
  assert.ok(humanText.includes("exit: 0"), "the human report states the exit contract");
}

// ─── baseline comparison is reported per group and by median ────────

{
  const { report, humanText } = await dryRun();
  for (const group of report.groups) {
    assert.equal(group.baselineComparison.evaluated, true);
    for (const direction of ["inputTokens", "writeSpend", "ttft"]) {
      assert.ok(["worse", "better", "equal", "unreported"].includes(group.baselineComparison.directions[direction]));
    }
    assert.ok(["worse", "better", "equal"].includes(group.baselineComparison.derived.cost),
      "cost is reported as a derived figure per group");
  }
  const { baselineSummary } = report;
  assert.equal(baselineSummary.groupsEvaluated, GROUP_COUNT);
  for (const direction of ["inputTokens", "writeSpend", "ttft"]) {
    const summary = baselineSummary.perDirection[direction];
    assert.ok(Number.isFinite(summary.medianDelta) && summary.medianDelta !== null);
    assert.equal(summary.worse + summary.better + summary.equal + summary.unreported, GROUP_COUNT);
  }
  assert.ok(!("cost" in baselineSummary.perDirection), "cost is not a counted direction");
  assert.ok(Number.isFinite(baselineSummary.derived.cost.medianDelta));
  assert.ok(baselineSummary.derived.cost.note.includes("derived figure"));
  // TTFT dispersion alongside the median delta (#268 defect 3): a delta
  // smaller than the spread cannot read as a finding, and the report states
  // both so no reader has to infer it.
  assert.ok(baselineSummary.perDirection.ttft.spreadMs !== null && baselineSummary.perDirection.ttft.spreadMs >= 0);
  assert.ok(humanText.includes("spread"), "the human report states the TTFT dispersion");
  assert.ok(humanText.includes("cost (derived)"), "the human report marks cost as derived");
  // Each counted direction states what it measures and why it is independent.
  assert.deepEqual(report.regression.directions.counted, ["inputTokens", "writeSpend", "ttft"]);
  for (const note of Object.values(report.regression.directions.notes)) {
    assert.ok(note.includes("independent"), "every direction note states its independence");
    assert.ok(humanText.includes(note), "the human report restates each direction note");
  }
  assert.ok(report.regression.directions.derivedNote.includes("never counted as a regression direction"));
  assert.ok(baselineSummary.armMedians.probeTtftMs.multiblock !== null);
  assert.ok(baselineSummary.armMedians.cost.single !== null);
  // The dry run never claims the regression rule: the structural framing
  // overhead sits below the per-direction noise floors.
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
  // band holds trivially, so only the liveness control can name the
  // limitation — and under #297's labels the honest verdict is neutral with
  // the dead-control caveat, while the run itself stays a valid measurement
  // (integrity ok, exit zero).
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
  assert.equal(report.conclusion.cache, "neutral", "a dead control with a met band is an honest neutral");
  assert.equal(report.conclusion.final, "neutral");
  assert.equal(exitCode, 0, "the exit contract separates integrity from conclusion");
  assert.ok(humanText.includes("liveness"), "the human report names the dead liveness control");
  assert.ok(report.conclusion.reasons.includes(DEAD_CONTROL_NOTE));
}

// ─── an apparent improvement on a dead control stays inconclusive ────

{
  // A fabricated adapter that reports the multiblock arm reading far more
  // than the single baseline on every probe while the nonce control reads
  // the same as multiblock: the gain cannot be attributed to content, so the
  // verdict must refuse the improvement — and the run remains valid.
  const biasedAdapter = {
    id: "simulated-biased/1",
    describePins: () => ({ provider: "simulated", model: "simulated/biased-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    async send(request, observe = {}) {
      observe.onFirstToken?.();
      const probe = request.role === "probe";
      const arm = request.arm;
      const read = probe && arm !== "single" ? 900 : 0;
      const write = probe ? (arm === "single" ? 1000 : 100) : 1185;
      return {
        usage: { inputTokens: probe ? 0 : 0, outputTokens: probe ? 64 : 48 },
        cache: { reported: true, read, write },
        retentionWrite: { reported: true, bucket: "default", tokens: write },
        cost: 0,
      };
    },
  };
  const clock = fakeClock();
  const { report, exitCode } = await runExperiment({
    adapter: biasedAdapter,
    clock,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(report.integrity.ok, true);
  assert.equal(report.cacheStandard.improvementObserved, true);
  assert.equal(report.cacheStandard.livenessSatisfied, false);
  assert.equal(report.conclusion.cache, "inconclusive", "an improvement claim requires the control alive");
  assert.equal(exitCode, 0, "an inconclusive measurement is still a valid run");
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
  assert.equal(exitCode, 0, "missing reports are absent evidence, not an execution failure");
}

// ─── ordering integrity: only the pinned per-group order is valid ───

{
  // A fixed, never-rotated order — the pre-#268 shape — deviates from the
  // pinned rotation and must fail integrity, whatever its other merits.
  const fixedOrder = () => [
    "multiblock.prime",
    "single.prime",
    "nonce.prime",
    "multiblock.probe",
    "single.probe",
    "nonce.probe",
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
  assert.equal(exitCode, 1, "an integrity failure is the one thing the exit code reports");
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
  assert.ok(report.integrity.failures[0].includes("multiblock.prime"));
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
  const blocks = [
    { start: 200, end: 300 },
    { start: 400, end: 500 },
  ];
  // The append arms: the shared prefix must end exactly at the pinned seam.
  assert.deepEqual(classifyDivergenceBoundary("multiblock", { blocks, expectedShared: 560 }, 560), { ok: true, boundary: "appended-block" });
  assert.deepEqual(classifyDivergenceBoundary("single", { blocks, expectedShared: 560 }, 560), { ok: true, boundary: "appended-block" });
  assert.deepEqual(classifyDivergenceBoundary("multiblock", { blocks, expectedShared: 560 }, 559), { ok: false, boundary: "inside-carried-prefix" });
  assert.deepEqual(classifyDivergenceBoundary("single", { blocks, expectedShared: 560 }, 561), { ok: false, boundary: "inside-carried-prefix" });
  assert.deepEqual(classifyDivergenceBoundary("multiblock", { blocks, expectedShared: null }, 560), { ok: false, boundary: "inside-carried-prefix" },
    "a missing seam cannot validate the invariant");
  // The control: divergence inside the earliest block.
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, expectedShared: null }, 250), { ok: true, boundary: "memory-block-1" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, expectedShared: null }, 200), { ok: true, boundary: "memory-block-1" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, expectedShared: null }, 199), { ok: false, boundary: "outside-earliest-block" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, expectedShared: null }, 300), { ok: false, boundary: "outside-earliest-block" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks: [], expectedShared: null }, 250), { ok: false, boundary: "outside-earliest-block" });
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
  const before = reportArtifacts("provider-cache-experiment-dry-run-").length;
  const result = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, `dry-run command exits clean:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("result: NEUTRAL"), "the honest dry run concludes neutral");
  assert.ok(result.stdout.includes("hit rate"), "the human report reflects the non-regression standard");
  assert.ok(result.stdout.includes("liveness"));
  assert.ok(result.stdout.includes("measured case: cross-compaction append"), "the human report names the measured case");
  assert.ok(result.stdout.includes("breakpoints: mirrors Pi's anthropic-messages placement"),
    "the human report states the modelled breakpoint placement");
  assert.ok(result.stdout.includes("framing:"));
  // #297 review finding 5: every run writes its own uniquely named artifact
  // pair — named by mode, so a dry run can never touch a credentialed
  // report — records the exact implementation commit, and never overwrites
  // an earlier artifact.
  const after = reportArtifacts("provider-cache-experiment-dry-run-");
  assert.equal(after.length, before + 2, "the run appends exactly one new json+txt artifact pair");
  const [jsonName, txtName] = after.slice(-2);
  assert.match(jsonName, /^provider-cache-experiment-dry-run-\S+\.json$/);
  assert.match(txtName, /^provider-cache-experiment-dry-run-\S+\.txt$/);
  assert.equal(
    jsonName.replace(/^provider-cache-experiment-dry-run-/, "").replace(/\.json$/, ""),
    txtName.replace(/^provider-cache-experiment-dry-run-/, "").replace(/\.txt$/, ""),
    "the json and text artifacts share one run id",
  );
  const written = JSON.parse(readFileSync(join(HERE, "report", jsonName), "utf8"));
  assert.equal(written.schema, "pi-square.context-memory/provider-cache-experiment/2");
  assert.equal(written.cacheStandard.band.baselineArm, "single");
  assert.match(written.pins.implementationCommit, /^[0-9a-f]{7,40}$/,
    "the CLI resolves and records the exact implementation commit from git");
  assert.ok(result.stdout.includes(`implementation commit: ${written.pins.implementationCommit}`),
    "the human output names the recorded commit");
  assert.ok(!existsSync(join(HERE, "report", "provider-cache-experiment.json")),
    "no fixed-name report exists for any run to overwrite");
  const credentialedBefore = reportArtifacts("provider-cache-experiment-credentialed-").length;
  const again = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--dry-run"], { encoding: "utf8" });
  assert.equal(again.status, 0);
  assert.equal(reportArtifacts("provider-cache-experiment-dry-run-").length, after.length + 2,
    "a second run appends its own artifacts and overwrites nothing");
  assert.equal(reportArtifacts("provider-cache-experiment-credentialed-").length, credentialedBefore,
    "a dry run never writes or touches credentialed-named artifacts");
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
