import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, GROUP_COUNT, MARKER, REQUEST_ORDER, SYSTEM_PROMPT, fixtureDigest } from "./fixture.mjs";
import { fakeClock, simulatedCacheAdapter } from "./fake-provider.mjs";
import { classifyDivergenceBoundary, findReportLeaks, runExperiment } from "./runner.mjs";
import { FORBIDDEN_CLAIM_PHRASES, FRAMING_DISCLAIMER } from "./verdict.mjs";

/**
 * End-to-end dry-run coverage for the provider-cache experiment (#225): the
 * full harness runs against the simulated prefix-cache adapter with a fake
 * clock, proving the pinned experiment shape, the recorded evidence, run
 * integrity, determinism, report privacy, and the command-line surface —
 * without credentials and without any real provider call.
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
  assert.equal(report.totals.requests, GROUP_COUNT * REQUEST_ORDER.length, "five interleaved paired groups over three arms");
  assert.equal(report.criteria.measurableGroups, GROUP_COUNT);
  assert.ok(report.criteria.nonZeroEvidenceGroups >= 3);
  assert.ok(report.criteria.reuseAboveControlGroups >= 3);
  assert.equal(report.regression.fired, false);
}

// ─── per-arm divergence boundaries and prefix evidence ──────────────

{
  const { report } = await dryRun();
  for (const group of report.groups) {
    assert.equal(group.quality, "measurable");
    assert.equal(group.stable.probe.divergenceBoundary, "after-stable-blocks",
      "the stable probe diverges only after the previously carried blocks");
    assert.equal(group.nonce.probe.divergenceBoundary, "memory-block-1",
      "the negative control diverges inside the earliest block");
    assert.equal(group.native.probe.divergenceBoundary, "native-summary",
      "the native baseline diverges inside the regenerated summary");
    assert.ok(
      group.nonce.probe.sharedBytes < group.stable.probe.sharedBytes,
      "the control shares strictly fewer prefix bytes than the stable arm",
    );
    assert.ok(
      group.native.probe.sharedBytes < group.stable.probe.sharedBytes,
      "the native baseline shares strictly fewer prefix bytes than the stable arm",
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
    assert.equal(group.evidenceNonZero, true);
    assert.equal(group.reuseAboveControl, true);
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
  assert.equal(pins.fixtureDigest, fixtureDigest(), "the fixture digest pins every composed payload");
  assert.deepEqual(pins.groupOrder, REQUEST_ORDER);
  assert.equal(pins.retention.bucket, "default");
  assert.equal(pins.retention.ttlMs, 300_000);
  assert.equal(pins.retention.breakpoint, "end-of-carried-summary");
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

// ─── native comparison is reported per group and by median ──────────

{
  const { report } = await dryRun();
  for (const group of report.groups) {
    assert.equal(group.nativeComparison.evaluated, true);
    for (const direction of ["inputTokens", "writeSpend", "cost", "ttft"]) {
      assert.ok(["worse", "better", "equal", "unreported"].includes(group.nativeComparison.directions[direction]));
    }
  }
  const { nativeSummary } = report;
  assert.equal(nativeSummary.groupsEvaluated, GROUP_COUNT);
  for (const direction of ["inputTokens", "writeSpend", "cost", "ttft"]) {
    const summary = nativeSummary.perDirection[direction];
    assert.ok(Number.isFinite(summary.medianDelta) && summary.medianDelta !== null);
    assert.equal(summary.worse + summary.better + summary.equal + summary.unreported, GROUP_COUNT);
  }
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

// ─── ordering integrity: only the pinned order is valid ─────────────

{
  const misordered = [
    "stable.prime",
    "native.prime",
    "nonce.prime",
    "stable.probe",
    "nonce.probe",
    "native.probe",
  ];
  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  const { report, exitCode } = await runExperiment({
    adapter,
    clock,
    order: misordered,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(report.integrity.orderMatchesPin, false);
  assert.equal(report.integrity.ok, false);
  assert.ok(report.integrity.failures.includes("request order deviated from the pinned interleaved order"));
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
    { start: 300, end: 450 },
    { start: 450, end: 600 },
    { start: 600, end: 700 },
  ];
  assert.deepEqual(classifyDivergenceBoundary("stable", { summary, blocks }, 650), { ok: true, boundary: "after-stable-blocks" });
  assert.deepEqual(classifyDivergenceBoundary("stable", { summary, blocks }, 600), { ok: true, boundary: "after-stable-blocks" },
    "divergence exactly at the last old block's end keeps the prefix intact");
  assert.deepEqual(classifyDivergenceBoundary("stable", { summary, blocks }, 599), { ok: false, boundary: "inside-stable-blocks" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 250), { ok: true, boundary: "memory-block-1" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 199), { ok: false, boundary: "outside-earliest-block" });
  assert.deepEqual(classifyDivergenceBoundary("nonce", { summary, blocks }, 300), { ok: false, boundary: "outside-earliest-block" });
  assert.deepEqual(classifyDivergenceBoundary("native", { summary, blocks: [] }, 150), { ok: true, boundary: "native-summary" });
  assert.deepEqual(classifyDivergenceBoundary("native", { summary, blocks: [] }, 99), { ok: false, boundary: "outside-native-summary" });
  assert.deepEqual(classifyDivergenceBoundary("native", { summary, blocks: [] }, 900), { ok: false, boundary: "outside-native-summary" });
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
  assert.ok(result.stdout.includes("framing:"));
  const jsonPath = join(HERE, "report", "provider-cache-experiment.json");
  assert.ok(existsSync(jsonPath), "the report artifact is written beside the harness");
  const written = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(written.schema, "pi-square.context-memory/provider-cache-experiment/1");
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
