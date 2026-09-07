import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_COMPLETE_SENTINEL, claimArtifactPair, resolveImplementation } from "./experiment.mjs";
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
  toolsFor,
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

async function dryRun({ runNonce = "d1c0d5e0d3d3d3d3" } = {}) {
  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  return runExperiment({
    adapter,
    clock,
    runNonce,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    implementationCommit: "0123456789abcdef0123456789abcdef01234567",
  });
}

/** The report directory's artifacts of one mode, oldest first by name. */
function reportArtifacts(prefix, dir = join(HERE, "report")) {
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
  assert.equal(report.conclusion.livenessSatisfied, true,
    "the per-request control namespace makes the liveness control observable: the nonce probe reads nothing, the arms under test read the tools boundary");
  assert.ok(!report.conclusion.reasons.includes(DEAD_CONTROL_NOTE),
    "a live control needs no caveat — the neutral verdict is conclusive");
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
          // control arm diverges in its namespace long before the carried
          // region, so its carried measurement uses the end of block 2.
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

// ─── cold isolation namespaces: run+arm derived, before any shared byte ─

{
  // #297 review findings 2 and 3: the namespace is derived from the run
  // nonce AND the arm and placed at the very front of the system segment, so
  // requests from different arms — or from different executions of the
  // experiment — diverge inside the first bytes of the payload. A prefix
  // cache cannot serve any shared content across arms or across runs, at any
  // prefix length, because there is no shared cacheable prefix at all. The
  // nonce control arm derives its token per request, which is what makes the
  // liveness control observable: its probe cannot read even its own prime.
  const runA = "e75444904e0c1e53";
  const runB = "0f9d3a51b6c27e88";
  // #297 review round 3: the namespace derives from run+group+arm — every
  // prime/probe pair is an independent cold measurement, while the pair's
  // two requests share their token so the carried prefix stays byte-stable.
  const namespaces = new Set();
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const arm of ARMS) namespaces.add(armNamespace(runA, group, arm));
  }
  assert.equal(namespaces.size, GROUP_COUNT * ARMS.length, "every group+arm pair has its own namespace within a run");
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const arm of ["multiblock", "single"]) {
      assert.notEqual(armNamespace(runA, group, arm), armNamespace(runB, group, arm), `${arm} group ${group} differs across runs`);
      for (let other = 1; other <= GROUP_COUNT; other += 1) {
        if (other !== group) {
          assert.notEqual(armNamespace(runA, group, arm), armNamespace(runA, other, arm),
            `${arm} group ${group} differs from group ${other} within the run`);
        }
      }
    }
  }
  const probe = composeRequest({ group: 1, arm: "multiblock", role: "probe", runNonce: runA });
  const namespaceLine = (() => {
    const segment = probe.payload.table.find((entry) => entry.element === "system");
    return probe.payload.bytes.subarray(segment.contentStart, segment.contentEnd).toString("utf8").indexOf("\n");
  })();
  const isolationBound = namespaceLine + 1; // strictly inside the namespace line
  const isolationPairs = [];
  for (let group = 1; group <= GROUP_COUNT; group += 1) {
    for (const armA of ARMS) {
      for (const armB of ARMS) {
        if (armA !== armB) isolationPairs.push([armA, armB]);
      }
    }
  }
  for (const [armA, armB] of isolationPairs) {
    const shared = firstDivergence(
      composeRequest({ group: 1, arm: armA, role: "prime", runNonce: runA }).payload,
      composeRequest({ group: 1, arm: armB, role: "probe", runNonce: runA }).payload,
    ).sharedBytes;
    assert.ok(
      shared < isolationBound,
      `cross-arm: ${armA}.prime and ${armB}.probe diverge within the first ${isolationBound} bytes (byte ${shared}), before any shared cacheable content`,
    );
  }
  for (const arm of ARMS) {
    const shared = firstDivergence(
      composeRequest({ group: 1, arm, role: "prime", runNonce: runA }).payload,
      composeRequest({ group: 1, arm, role: "probe", runNonce: runB }).payload,
    ).sharedBytes;
    assert.ok(
      shared < isolationBound,
      `cross-run: ${arm} requests diverge within the first ${isolationBound} bytes (byte ${shared}), so a rerun can never read the previous run's cache`,
    );
    // Cross-group within one run: a later group's prime must share nothing a
    // breakpoint could serve with an earlier group's same-arm requests, or
    // the five groups would not be independent cold pairs.
    for (const [roleA, roleB] of [["prime", "prime"], ["probe", "prime"], ["prime", "probe"]]) {
      const cross = firstDivergence(
        composeRequest({ group: 1, arm, role: roleA, runNonce: runA }).payload,
        composeRequest({ group: 2, arm, role: roleB, runNonce: runA }).payload,
      ).sharedBytes;
      assert.ok(
        cross < isolationBound,
        `cross-group: ${arm} group 1.${roleA} and group 2.${roleB} diverge within the first ${isolationBound} bytes (byte ${cross})`,
      );
    }
  }
  for (const arm of ["multiblock", "single"]) {
    const prime = composeRequest({ group: 1, arm, role: "prime", runNonce: runA });
    const probe = composeRequest({ group: 1, arm, role: "probe", runNonce: runA });
    assert.equal(
      firstDivergence(prime.payload, probe.payload).sharedBytes,
      probe.layout.expectedShared,
      `${arm}'s same-arm prime/probe prefix is stable to the append seam`,
    );
  }
  {
    // The observable control: the nonce arm's own namespace token differs
    // between prime and probe, per request, at the same fixed width.
    const prime = composeRequest({ group: 1, arm: "nonce", role: "prime", runNonce: runA });
    const probe = composeRequest({ group: 1, arm: "nonce", role: "probe", runNonce: runA });
    const shared = firstDivergence(prime.payload, probe.payload).sharedBytes;
    assert.ok(shared < isolationBound, `the control's probe diverges from its own prime inside the namespace line (byte ${shared})`);
  }
  {
    // The same isolation covers the tool catalog: measured gateways reuse
    // cache by content hash across positions too, so byte-identical tool
    // descriptions were reusable across arms and roles. Every description
    // now carries the request's isolation token — fixed for an arm under
    // test, per request for the control.
    const catalog = (arm, role, runNonce = runA, group = 1) => JSON.stringify(toolsFor(runNonce, { group, arm, role }));
    assert.notEqual(catalog("multiblock"), catalog("single"), "tool catalogs differ across arms");
    assert.notEqual(catalog("multiblock"), catalog("multiblock", "prime", runB), "tool catalogs differ across runs");
    assert.notEqual(catalog("multiblock"), catalog("multiblock", "prime", runA, 2), "tool catalogs differ across groups");
    assert.equal(catalog("multiblock"), catalog("multiblock", "probe"), "the arm under test keeps its catalog stable between prime and probe");
    assert.notEqual(catalog("nonce"), catalog("nonce", "probe"), "the control's catalog differs per request");
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
      // append seam for the multiblock and single arms; the nonce control
      // diverges inside its per-request isolation namespace.
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
    for (const arm of ["multiblock", "single"]) {
      assert.equal(
        cacheableBytes[arm],
        toolsEnd,
        `group ${group} ${arm}: under the pinned placement the arms under test fall back to the tools boundary across an append`,
      );
      assert.ok(seams[arm] > toolsEnd, `group ${group} ${arm}: the append seam sits beyond the tools boundary, inside the carried region`);
    }
    // The observable control (#297 review finding 3): the nonce arm's probe
    // diverges inside its own per-request namespace line — before the tools
    // boundary — so it cannot be served even the shared prefix. A provider
    // whose cache reports track content at all must show the control reading
    // less than the arms under test; the liveness rule is observable.
    assert.equal(cacheableBytes.nonce, 0, "the control cannot be served anything at any breakpoint");
    assert.ok(seams.nonce < toolsEnd, "the control diverges before the tools boundary, inside its namespace line");
    assert.ok(seams.nonce < seams.multiblock, "the control shares strictly fewer prefix bytes than the arm under test");
    assert.ok(seams.nonce < seams.single, "the control also shares fewer prefix bytes than the baseline");
    // Even at the shared tools-boundary fallback, the run+arm cold
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
    assert.equal(group.nonce.probe.divergenceBoundary, "isolation-namespace",
      "the liveness control diverges inside its own per-request namespace line");
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
  assert.equal(pins.implementationTree, "unavailable", "an unresolvable tree digest is recorded as unavailable, never omitted");
  assert.equal(pins.runNonce, "d1c0d5e0d3d3d3d3", "the pins record the run nonce the isolation namespaces derive from");
  assert.ok(typeof pins.armIsolation === "string" && pins.armIsolation.includes("before any shared cacheable byte"),
    "the pins state the front-of-payload run+arm isolation rule");
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
  for (const arm of ["multiblock", "single"]) {
    const rate = standard.rates[arm];
    assert.ok(rate.denominator > 0);
    assert.ok(rate.rate > 0 && rate.rate <= 1, `${arm} records a measured rate`);
    assert.equal(rate.denominator, rate.cacheRead + rate.cacheCreation + rate.uncachedInput);
  }
  // The control arm reads nothing by construction — its per-request
  // namespace makes every breakpoint miss — which is exactly the observable
  // divergence a live control requires.
  assert.equal(standard.rates.nonce.rate, 0);
  // The honest simulation: multiblock at the single baseline, and the control
  // demonstrably below it — the liveness rule is observable and alive.
  assert.equal(standard.bandSatisfied, true);
  assert.equal(standard.improvementObserved, false);
  assert.equal(standard.livenessSatisfied, true, "the control reads nothing while the arms under test read the tools boundary");
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
  assert.ok(report.conclusion.reasons.some((reason) => reason.startsWith("liveness control alive")),
    "a conclusive verdict states the live control");
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
  // Same run nonce: byte-identical evidence. Different run nonces: the
  // payloads (and their isolation namespaces) differ by design — a rerun can
  // never read the previous run's cache.
  const first = await dryRun();
  const second = await dryRun();
  assert.deepEqual(first.report, second.report, "two runs with the same nonce produce byte-identical evidence");
  const third = await dryRun({ runNonce: "0e1e2e3e4e5e6e7e" });
  assert.notEqual(third.report.pins.runNonce, first.report.pins.runNonce);
  assert.notEqual(third.report.groups[0].multiblock.prime.payloadHash, first.report.groups[0].multiblock.prime.payloadHash,
    "a different run nonce changes every payload, so runs are content-isolated");
  assert.equal(third.exitCode, first.exitCode);
}

// ─── the dead-measurement world: constant reads, alive-looking groups ─

{
  // The #251 signature as an adapter: every probe reports the same constant
  // read regardless of content, exactly as the measured gateway did when the
  // fixture sat below the cacheable floor. Every group is measurable and the
  // band holds trivially, so only the liveness control can name the
  // limitation — a dead control means the measurement cannot distinguish
  // content, so the verdict is inconclusive (#297 review finding 3), while
  // the run itself stays a valid measurement (integrity ok, exit zero).
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
  assert.equal(report.conclusion.cache, "inconclusive", "a dead control voids the conclusion even with a met band");
  assert.equal(report.conclusion.final, "inconclusive");
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

// ─── an out-of-TTL probe is an integrity failure, not a soft quality ──

{
  // #297 review finding 4: a probe that followed its prime after more than
  // the pinned TTL is stale evidence. The run's integrity fails, the exit
  // code reports it, and the final label is inconclusive — even if every
  // token count looks like a met band.
  let nowMs = 1_000_000;
  let monoMs = 0;
  const slowClock = {
    now: () => nowMs,
    mono: () => monoMs,
    sleep: async () => {},
  };
  let sent = 0;
  const slowAdapter = {
    id: "simulated-slow/1",
    describePins: () => ({ provider: "simulated", model: "simulated/slow-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    async send(request, observe = {}) {
      observe.onFirstToken?.();
      sent += 1;
      // Every other request stalls past the TTL: each probe follows its
      // prime by more than 300 000 ms on the monotonic counter.
      if (sent % 2 === 0) monoMs += 400_000;
      nowMs += 1000;
      const probe = request.role === "probe";
      return {
        usage: { inputTokens: probe ? 166 : 0, outputTokens: 48 },
        cache: { reported: true, read: probe ? 1089 : 0, write: probe ? 96 : 1185 },
        retentionWrite: { reported: true, bucket: "default", tokens: probe ? 96 : 1185 },
        cost: 0,
      };
    },
  };
  const { report, exitCode } = await runExperiment({
    adapter: slowAdapter,
    clock: slowClock,
    ttlMs: 300_000,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(report.integrity.ttlOk, false);
  assert.equal(report.integrity.ok, false);
  assert.ok(report.integrity.failures.some((failure) => failure.includes("more than the pinned 300000ms TTL")));
  assert.ok(report.groups.every((group) => group.quality === "ttl-stale"));
  assert.equal(report.conclusion.cache, "inconclusive");
  assert.equal(report.conclusion.final, "inconclusive");
  assert.equal(exitCode, 1, "an out-of-TTL run exits nonzero");
}

// ─── a negative monotonic interval is broken timing, not stale evidence ─

{
  // #297 review round 3: a wall-clock step backwards must not forge fresh
  // TTL evidence. Intervals come from the monotonic counter; a negative
  // interval — the counter itself moved backwards — fails the run's
  // integrity outright.
  let monoMs = 0;
  const backwardsClock = {
    now: () => 1_000_000,
    mono: () => monoMs,
    sleep: async () => {},
  };
  const backwardsAdapter = {
    id: "simulated-clockstep/1",
    describePins: () => ({ provider: "simulated", model: "simulated/clockstep-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    async send(request, observe = {}) {
      observe.onFirstToken?.();
      if (request.role === "probe") monoMs -= 60_000;
      const probe = request.role === "probe";
      return {
        usage: { inputTokens: probe ? 166 : 0, outputTokens: 48 },
        cache: { reported: true, read: probe ? 1089 : 0, write: probe ? 96 : 1185 },
        retentionWrite: { reported: true, bucket: "default", tokens: probe ? 96 : 1185 },
        cost: 0,
      };
    },
  };
  const { report, exitCode } = await runExperiment({
    adapter: backwardsAdapter,
    clock: backwardsClock,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(report.integrity.ok, false);
  assert.ok(report.integrity.failures.some((failure) => failure.includes("negative interval")),
    "a backwards monotonic clock fails integrity");
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
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, namespaceEnd: 101, expectedShared: null }, 100), { ok: true, boundary: "isolation-namespace" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, namespaceEnd: 101, expectedShared: null }, 0), { ok: true, boundary: "isolation-namespace" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, namespaceEnd: 101, expectedShared: null }, 101), { ok: false, boundary: "outside-isolation-namespace" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks, namespaceEnd: 101, expectedShared: null }, 300), { ok: false, boundary: "outside-isolation-namespace" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { blocks: [], expectedShared: null }, 250), { ok: false, boundary: "outside-isolation-namespace" });
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

// #297 review finding 6: the tests run the CLI against a temporary report
// directory, never the shared persistent one — two concurrent test runs can
// never fight over artifacts.
const CLI_REPORT_DIR = mkdtempSync(join(tmpdir(), "provider-cache-experiment-test-"));

{
  const before = reportArtifacts("provider-cache-experiment-dry-run-", CLI_REPORT_DIR).length;
  const result = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--dry-run", "--report-dir", CLI_REPORT_DIR], { encoding: "utf8" });
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
  const after = reportArtifacts("provider-cache-experiment-dry-run-", CLI_REPORT_DIR);
  assert.equal(after.length, before + 2, "the run appends exactly one new json+txt artifact pair");
  const [jsonName, txtName] = after.slice(-2);
  assert.match(jsonName, /^provider-cache-experiment-dry-run-\S+\.json$/);
  assert.match(txtName, /^provider-cache-experiment-dry-run-\S+\.txt$/);
  assert.equal(
    jsonName.replace(/^provider-cache-experiment-dry-run-/, "").replace(/\.json$/, ""),
    txtName.replace(/^provider-cache-experiment-dry-run-/, "").replace(/\.txt$/, ""),
    "the json and text artifacts share one run id",
  );
  const written = JSON.parse(readFileSync(join(CLI_REPORT_DIR, jsonName), "utf8"));
  assert.match(written.pins.implementationTree, /^[0-9a-f]{40}$/, "the CLI records the commit's tree digest");
  assert.equal(written.schema, "pi-square.context-memory/provider-cache-experiment/2");
  assert.equal(written.cacheStandard.band.baselineArm, "single");
  assert.match(written.pins.implementationCommit, /^[0-9a-f]{7,40}$/,
    "the CLI resolves and records the exact implementation commit from git");
  assert.ok(result.stdout.includes(`implementation commit: ${written.pins.implementationCommit}`),
    "the human output names the recorded commit");
  assert.ok(!existsSync(join(CLI_REPORT_DIR, "provider-cache-experiment.json")),
    "no fixed-name report exists for any run to overwrite");
  const credentialedBefore = reportArtifacts("provider-cache-experiment-credentialed-", CLI_REPORT_DIR).length;
  const again = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--dry-run", "--report-dir", CLI_REPORT_DIR], { encoding: "utf8" });
  assert.equal(again.status, 0);
  assert.equal(reportArtifacts("provider-cache-experiment-dry-run-", CLI_REPORT_DIR).length, after.length + 2,
    "a second run appends its own artifacts and overwrites nothing");
  assert.equal(reportArtifacts("provider-cache-experiment-credentialed-", CLI_REPORT_DIR).length, credentialedBefore,
    "a dry run never writes or touches credentialed-named artifacts");
}

{
  // #297 review finding 6: a crashed run may leave a partial artifact pair
  // (a json without its txt). A later run that wants the same basename
  // claims a fresh suffix instead of writing beside the orphan, and two
  // concurrent claimants never share one basename.
  const dir = mkdtempSync(join(tmpdir(), "provider-cache-experiment-partial-"));
  closeSync(openSync(join(dir, "provider-cache-experiment-dry-run-X.json"), "wx")); // the orphan
  const first = claimArtifactPair(dir, "dry-run", "X");
  assert.ok(first.jsonPath.endsWith("-2.json") && first.txtPath.endsWith("-2.txt"),
    "an orphaned json forces the next suffix for BOTH files of the pair");
  const second = claimArtifactPair(dir, "dry-run", "X");
  assert.ok(second.jsonPath.endsWith("-3.json") && second.txtPath.endsWith("-3.txt"),
    "an occupied pair forces the next suffix again");
  assert.notEqual(first.jsonPath, second.jsonPath);
  assert.ok(existsSync(first.jsonPath) && existsSync(first.txtPath));
  assert.ok(existsSync(second.jsonPath) && existsSync(second.txtPath));
  // Only EEXIST retries: a directory that cannot be written propagates
  // instead of spinning forever, and a partial claim is released.
  assert.throws(() => claimArtifactPair(join(dir, "missing-dir"), "dry-run", "X"), /ENOENT/);
  mkdirSync(join(dir, "blocked"), { recursive: true });
  chmodSync(join(dir, "blocked"), 0o500);
  try {
    assert.throws(() => claimArtifactPair(join(dir, "blocked"), "dry-run", "X"), /EACCES/);
    assert.deepEqual(readdirSync(join(dir, "blocked")), [], "a failed claim leaves no partial pair behind");
  } finally {
    chmodSync(join(dir, "blocked"), 0o700);
  }
}

{
  // The crash-complete boundary: a published text artifact ends with the
  // sentinel line, so a killed run's half-written pair is recognizable.
  const dir = mkdtempSync(join(tmpdir(), "provider-cache-experiment-sentinel-"));
  const result = spawnSync(process.execPath, [join(HERE, "experiment.mjs"), "--dry-run", "--report-dir", dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const txt = readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith(".txt"))), "utf8");
  assert.ok(txt.endsWith(`${REPORT_COMPLETE_SENTINEL}\n`), "the published txt ends with the completion sentinel");
  assert.equal(txt.split(REPORT_COMPLETE_SENTINEL).length, 2, "the sentinel appears exactly once, as the final line");
}

{
  // #297 review finding 5, round 3: provenance resolution is a unit seam —
  // a stubbed git executor — because the CLI-level env redirect the old
  // tests used is now stripped by the implementation itself.
  const STUB_REPO = HERE;
  const stubExec =
    (outputs, seen = []) =>
    (command, options) => {
      seen.push({ command, env: options.env });
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    };
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const tree = "fedcba9876543210fedcba9876543210fedcba98";
  {
    // GIT_DIR/GIT_WORK_TREE in the environment never reach the git
    // subprocesses, so a stray redirect cannot repoint provenance.
    const seen = [];
    const exec = stubExec([commit, tree, STUB_REPO, ""], seen);
    const resolved = resolveImplementation({ env: { ...process.env, GIT_DIR: "/tmp/elsewhere", GIT_WORK_TREE: "/tmp/elsewhere" }, exec });
    assert.equal(resolved.commit, commit);
    assert.equal(resolved.tree, tree);
    assert.equal(resolved.dirty, false);
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
      assert.ok(seen.every((call) => !(name in call.env)), `${name} is stripped from every git call`);
    }
  }
  {
    // An unresolvable commit (git fails) leaves provenance unavailable.
    const resolved = resolveImplementation({ exec: stubExec([new Error("fatal: not a git repository")]) });
    assert.equal(resolved.commit, null);
    assert.equal(resolved.dirty, true);
  }
  {
    // A repository root that does not contain this checkout is refused —
    // provenance must describe the code being measured.
    const resolved = resolveImplementation({ exec: stubExec([commit, tree, "/tmp/somewhere-else", ""]) });
    assert.equal(resolved.commit, null, "a foreign repository root is not trusted");
  }
  {
    // A dirty status marks the run dirty: the tree digest cannot authorize
    // the working-tree bytes actually executed.
    const resolved = resolveImplementation({ exec: stubExec([commit, tree, STUB_REPO, " M src/x.ts"]) });
    assert.equal(resolved.commit, commit);
    assert.equal(resolved.dirty, true);
  }
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
