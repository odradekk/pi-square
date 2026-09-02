import {
  ARMS,
  GROUP_COUNT,
  MARKER,
  OLD_BLOCK_COUNT,
  REQUEST_ORDER,
  SETTINGS,
  SETTINGS_HASH,
  SYSTEM_PROMPT_HASH,
  TOOLS,
  TOOLS_HASH,
  composeRequest,
  fixtureDigest,
} from "./fixture.mjs";
import { payloadDigest, prefixEvidence } from "./evidence.mjs";
import {
  FORBIDDEN_CLAIM_PHRASES,
  FRAMING_DISCLAIMER,
  evaluateRun,
  nativeMedians,
  withinTtl,
} from "./verdict.mjs";

/**
 * The experiment runner (#225, standard re-pinned by #260): executes the five
 * interleaved paired groups over the three pinned arms through an injected
 * provider adapter, records the exact payload/prefix hashes, first divergence
 * boundaries, usage, cache and retention reports, cost, and locally measured
 * TTFT for every request, and produces the bounded verdict report.
 *
 * The runner owns run integrity: only the pinned request order is valid,
 * per-arm divergence invariants must hold (the stable arm's probe may not
 * diverge before the end of the previously carried blocks, the nonce arm's
 * probe must diverge inside the earliest block, the native arm's probe must
 * diverge inside the regenerated summary), and provider reports are validated
 * at the boundary. The verdict itself — the pinned hit-rate standard, the
 * non-regression band against the Pi-native baseline, and the nonce liveness
 * control — lives in `verdict.mjs`. The report carries hashes, offsets, and
 * bounded numbers — never payloads, transcripts, Memory or source bodies, or
 * credentials — and a self-check re-verifies that before anything is written.
 */

const REPORT_SCHEMA = "pi-square.context-memory/provider-cache-experiment/1";
const REPORT_STRING_MAX = 240;
const INTEGRITY_FAILURE_CAP = 16;
const DEFAULT_TTL_MS = 300_000;

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/** Boundary validation of one adapter report; a problem string is an integrity failure. */
function validateProviderReport(report) {
  if (report === null || typeof report !== "object") return "adapter returned no report object";
  if (!isCount(report.usage?.inputTokens) || !isCount(report.usage?.outputTokens)) {
    return "usage token counts are missing or not non-negative integers";
  }
  const cache = report.cache;
  if (cache === null || typeof cache !== "object" || typeof cache.reported !== "boolean") {
    return "cache report is missing its reported flag";
  }
  if (cache.reported && (!isCount(cache.read) || !isCount(cache.write))) {
    return "reported cache values are not non-negative integers";
  }
  if (typeof report.cost !== "number" || !Number.isFinite(report.cost) || report.cost < 0) {
    return "cost is not a finite non-negative number";
  }
  const retention = report.retentionWrite;
  if (retention !== undefined) {
    if (retention === null || typeof retention !== "object" || typeof retention.reported !== "boolean") {
      return "retention write report is malformed";
    }
    if (retention.reported
      && (typeof retention.bucket !== "string" || retention.bucket.length > 24 || !isCount(retention.tokens))) {
      return "reported retention write is missing a bounded bucket or token count";
    }
  }
  return null;
}

/**
 * Names the boundary the arm's probe diverges at and checks the arm's prefix
 * invariant. A violation means the fixture or composer stopped producing the
 * cache property under test, so the run's evidence is meaningless.
 */
export function classifyDivergenceBoundary(arm, layout, sharedBytes, oldBlockCount = OLD_BLOCK_COUNT) {
  if (arm === "stable") {
    const lastOldBlock = layout.blocks[oldBlockCount - 1];
    const ok = lastOldBlock !== undefined && sharedBytes >= lastOldBlock.end;
    return { ok, boundary: ok ? "after-stable-blocks" : "inside-stable-blocks" };
  }
  if (arm === "nonce") {
    const earliest = layout.blocks[0];
    const ok = earliest !== undefined && sharedBytes >= earliest.start && sharedBytes < earliest.end;
    return { ok, boundary: ok ? "memory-block-1" : "outside-earliest-block" };
  }
  const ok = sharedBytes >= layout.summary.start && sharedBytes < layout.summary.end;
  return { ok, boundary: ok ? "native-summary" : "outside-native-summary" };
}

function buildPins(adapter, { ttlMs, minRequestGapMs, groupCount }) {
  const declared = adapter.describePins();
  const pins = {
    provider: declared.provider,
    model: declared.model,
    adapterCacheReporting: declared.cacheReporting,
    toolNames: TOOLS.map((tool) => tool.name),
    toolsHash: TOOLS_HASH,
    systemPromptHash: SYSTEM_PROMPT_HASH,
    settingsHash: SETTINGS_HASH,
    settings: SETTINGS,
    routing: { concurrency: 1, retryPolicy: "none", sessionScope: "arm-per-group" },
    fixtureDigest: fixtureDigest(groupCount),
    retention: {
      bucket: "default",
      ttlMs,
      breakpoint: "end-of-carried-summary",
      extendedBucket: "unexercised-in-this-slice",
    },
    groupOrder: REQUEST_ORDER,
    timing: {
      minRequestGapMs,
      ttlMs,
      rule: "every probe must follow its arm prime within ttlMs; a later probe classifies its group ttl-stale",
    },
    priceNote: declared.priceNote,
  };
  // A real adapter that cannot apply the pinned settings in full (for example
  // #248's temperature omission on claude-sonnet-5) records the omission in
  // its pins; an adapter that applies them records nothing, so the dry-run
  // report shape is unchanged.
  if (Array.isArray(declared.settingsOmissions) && declared.settingsOmissions.length > 0) {
    pins.settingsOmissions = declared.settingsOmissions;
  }
  return pins;
}

function rowOf(record, evidence) {
  const report = record.report;
  return {
    arm: record.arm,
    role: record.role,
    payloadHash: record.digest.hash,
    payloadBytes: record.digest.byteLength,
    tokenEstimate: record.digest.tokenEstimate,
    prefixHash: evidence ? evidence.prefixHash : null,
    sharedBytes: evidence ? evidence.sharedBytes : null,
    prefixTokenEstimate: evidence ? evidence.prefixTokenEstimate : null,
    divergenceBoundary: evidence ? evidence.boundary : null,
    divergenceElement: evidence ? evidence.divergence.element : null,
    cacheReported: report.cache.reported,
    cacheRead: report.cache.reported ? report.cache.read : 0,
    cacheWrite: report.cache.reported ? report.cache.write : 0,
    inputTokens: report.usage.inputTokens,
    outputTokens: report.usage.outputTokens,
    retentionWriteReported: report.retentionWrite?.reported === true,
    retentionBucket: report.retentionWrite?.reported === true ? report.retentionWrite.bucket : "unreported",
    retentionWriteTokens: report.retentionWrite?.reported === true ? report.retentionWrite.tokens : 0,
    cost: roundCost(report.cost),
    ttftMs: record.ttftMs ?? null,
    sentAtMs: record.sentAtMs,
    primeToProbeMs: record.primeToProbeMs ?? null,
  };
}

/** Walks every string in the emitted JSON and bounds its length. */
function longestStringValue(value, current = 0) {
  if (typeof value === "string") return Math.max(current, value.length);
  if (Array.isArray(value)) return value.reduce((acc, item) => longestStringValue(item, acc), current);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce((acc, item) => longestStringValue(item, acc), current);
  }
  return current;
}

/** The report must never contain fixture bodies or unbounded strings. */
export function findReportLeaks(json) {
  const leaks = [];
  if (json.includes(MARKER)) leaks.push("the fixture content marker");
  if (/(.)\1{63}/.test(json)) leaks.push("a 64+ character repeated run");
  for (const phrase of FORBIDDEN_CLAIM_PHRASES) {
    if (json.includes(phrase)) leaks.push(`the claim phrase "${phrase}"`);
  }
  return leaks;
}

/**
 * Executes one experiment run. Pure with respect to the filesystem: the CLI
 * writes the report; callers receive `{ report, humanText, json, exitCode }`.
 */
export async function runExperiment({
  adapter,
  clock,
  ttlMs = DEFAULT_TTL_MS,
  minRequestGapMs = 0,
  groupCount = GROUP_COUNT,
  order = REQUEST_ORDER,
  generatedAt = () => new Date().toISOString(),
}) {
  const integrity = { ok: true, orderMatchesPin: true, divergenceInvariantsOk: true, providerErrors: 0, failures: [] };
  const fail = (message) => {
    integrity.ok = false;
    if (integrity.failures.length < INTEGRITY_FAILURE_CAP) integrity.failures.push(message);
  };

  const pins = buildPins(adapter, { ttlMs, minRequestGapMs, groupCount });
  if (order !== REQUEST_ORDER && JSON.stringify(order) !== JSON.stringify(REQUEST_ORDER)) {
    integrity.orderMatchesPin = false;
    fail("request order deviated from the pinned interleaved order");
  }

  const records = new Map(); // `${group}|${arm}.${role}` -> record
  let aborted = false;
  execute:
  for (let group = 1; group <= groupCount; group += 1) {
    for (const step of order) {
      const [arm, role] = step.split(".");
      if (minRequestGapMs > 0) await clock.sleep(minRequestGapMs);
      const composed = composeRequest({ group, arm, role });
      const digest = payloadDigest(composed.payload);
      const sentAtMs = clock.now();
      let firstTokenAt;
      let report;
      try {
        report = await adapter.send(
          {
            group,
            arm,
            role,
            payload: composed.payload,
            digest,
            tokenEstimate: digest.tokenEstimate,
            cacheControl: {
              bucket: pins.retention.bucket,
              ttlMs,
              breakpoint: pins.retention.breakpoint,
              coveredBytes: composed.layout.summary.end,
            },
          },
          { onFirstToken: () => { firstTokenAt = clock.now(); } },
        );
      } catch (error) {
        integrity.providerErrors += 1;
        fail(`group ${group} ${arm}.${role}: the adapter threw (${String(error?.message ?? error).slice(0, 120)})`);
        aborted = true;
        break execute;
      }
      const problem = validateProviderReport(report);
      if (problem) {
        integrity.providerErrors += 1;
        fail(`group ${group} ${arm}.${role}: ${problem}`);
        aborted = true;
        break execute;
      }
      records.set(`${group}|${step}`, {
        group,
        arm,
        role,
        composed,
        digest,
        report,
        sentAtMs,
        ttftMs: firstTokenAt === undefined ? undefined : firstTokenAt - sentAtMs,
      });
    }
  }

  const verdictInputs = [];
  const reportGroups = [];
  if (!aborted) {
    for (let group = 1; group <= groupCount; group += 1) {
      const arms = {};
      const primeToProbeMs = {};
      for (const arm of ARMS) {
        const prime = records.get(`${group}|${arm}.prime`);
        const probe = records.get(`${group}|${arm}.probe`);
        if (!prime || !probe) continue; // unreachable with the pinned order; guards a partial run
        const evidence = prefixEvidence(prime.composed.payload, probe.composed.payload);
        const classification = classifyDivergenceBoundary(arm, probe.composed.layout, evidence.sharedBytes);
        if (!classification.ok) {
          integrity.divergenceInvariantsOk = false;
          fail(
            `group ${group} ${arm}: the probe's first divergence at byte ${evidence.sharedBytes} violates the ${arm} prefix invariant (${classification.boundary})`,
          );
        }
        evidence.boundary = classification.boundary;
        probe.primeToProbeMs = probe.sentAtMs - prime.sentAtMs;
        primeToProbeMs[arm] = probe.primeToProbeMs;
        arms[arm] = { prime: rowOf(prime, null), probe: rowOf(probe, evidence) };
      }
      if (Object.keys(arms).length !== 3) continue;
      const timing = { ttlMs, primeToProbeMs, withinTtl: withinTtl(primeToProbeMs, ttlMs) };
      const groupInput = { group, timing, ...arms };
      verdictInputs.push(groupInput);
      reportGroups.push({
        group,
        timing,
        stable: arms.stable,
        nonce: arms.nonce,
        native: arms.native,
      });
    }
  }

  const verdict = evaluateRun({ groups: verdictInputs, integrity });
  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: generatedAt(),
    mode: adapter.id.startsWith("simulated") ? "dry-run" : "credentialed",
    framing: { disclaimer: FRAMING_DISCLAIMER, scope: "one provider/model under the pinned adapter" },
    adapter: {
      id: adapter.id,
      provider: pins.provider,
      model: pins.model,
      cacheReporting: pins.adapterCacheReporting,
      simulationNotes: adapter.id.startsWith("simulated")
        ? ["ttl-modeled byte-prefix simulation", "capacity generous; LRU not under test"]
        : [],
    },
    pins,
    integrity: {
      ok: integrity.ok,
      orderMatchesPin: integrity.orderMatchesPin,
      divergenceInvariantsOk: integrity.divergenceInvariantsOk,
      providerErrors: integrity.providerErrors,
      failures: integrity.failures,
    },
    groups: reportGroups.map((group) => {
      const classified = verdict.groups.find((candidate) => candidate.group === group.group);
      return {
        ...group,
        quality: classified?.quality ?? null,
        qualityReasons: classified?.qualityReasons ?? [],
        nativeComparison: classified?.nativeComparison ?? null,
      };
    }),
    cacheStandard: verdict.cacheStandard,
    nativeSummary: nativeMedians(verdict.groups),
    regression: verdict.regression,
    conclusion: { cache: verdict.cacheConclusion, final: verdict.conclusion, reasons: verdict.reasons },
    totals: {
      groups: reportGroups.length,
      requests: records.size,
      requestsWithCacheReport: [...records.values()].filter((record) => record.report.cache.reported).length,
      requestsWithRetentionReport: [...records.values()].filter((record) => record.report.retentionWrite?.reported === true).length,
    },
  };

  // Privacy self-check: the emitted artifact itself must stay payload-free and bounded.
  let json = JSON.stringify(report, null, 2);
  const leaks = [...findReportLeaks(json)];
  if (longestStringValue(report) > REPORT_STRING_MAX) leaks.push(`a string field longer than ${REPORT_STRING_MAX} characters`);
  if (leaks.length > 0) {
    json = json.split(MARKER).join("‹redacted›");
    report.integrity.ok = false;
    report.integrity.failures.push(`the report contained ${leaks.join("; ")}`);
    report.conclusion.cache = "inconclusive";
    report.conclusion.final = "inconclusive";
    report.conclusion.reasons.push(`report privacy self-check failed: ${leaks.join("; ")}`);
    json = JSON.stringify(report, null, 2);
  }

  const exitCode = report.integrity.ok && report.conclusion.final === "positive" ? 0 : 1;
  return { report, json, humanText: renderHuman(report), exitCode };
}

function renderHuman(report) {
  const short = (hash) => (typeof hash === "string" && hash.length >= 12 ? hash.slice(0, 12) : String(hash));
  const lines = [];
  lines.push(`Provider-cache experiment (#225, standard #260) — ${report.mode}`);
  lines.push(
    `result: ${report.conclusion.final.toUpperCase()} — ${report.totals.groups} groups, ${report.totals.requests} requests, integrity ${report.integrity.ok ? "ok" : "FAILED"}`,
  );
  lines.push(`adapter: ${report.adapter.model} (provider ${report.adapter.provider}, cache reporting ${report.adapter.cacheReporting})`);
  lines.push(
    `pins: model ${report.pins.model} · tools ${short(report.pins.toolsHash)} · system ${short(report.pins.systemPromptHash)}`
      + ` · settings ${short(report.pins.settingsHash)} · fixture ${short(report.pins.fixtureDigest)}`
      + ` · retention ${report.pins.retention.bucket}/${report.pins.retention.ttlMs}ms`,
  );
  lines.push(`timing: ttl ${report.pins.timing.ttlMs}ms · min gap ${report.pins.timing.minRequestGapMs}ms · order ${report.pins.groupOrder.join(", ")}`);
  lines.push("groups:");
  for (const group of report.groups) {
    const native = group.nativeComparison?.evaluated
      ? `${group.nativeComparison.worseDirections.length} worse directions`
      : "native comparison unevaluated";
    lines.push(`  ${String(group.group).padStart(2)}  ${String(group.quality).padEnd(14)} · native: ${native}`);
  }
  const { cacheStandard: standard } = report;
  const rateText = (arm) => (standard.rates[arm].rate === null ? "n/a" : `${(standard.rates[arm].rate * 100).toFixed(1)}%`);
  lines.push(`hit rate (${standard.aggregation}):`);
  lines.push(
    `  stable ${rateText("stable")} · nonce ${rateText("nonce")} (liveness control) · native ${rateText("native")} (baseline)`
      + ` — ${standard.groupsAggregated} groups aggregated`,
  );
  lines.push(`  definition: ${standard.hitRateDefinition}`);
  lines.push(
    `  band: stable must stay within ${standard.band.belowBaselinePercentagePoints}pp of native`
      + ` (minimum ${standard.minimumAcceptableStableRate === null ? "n/a" : `${(standard.minimumAcceptableStableRate * 100).toFixed(1)}%`})`
      + ` — ${standard.bandSatisfied === null ? "unevaluated" : standard.bandSatisfied ? "met" : "failed"}`,
  );
  lines.push(
    `  liveness: nonce must sit at least ${standard.liveness.belowMarginPercentagePoints}pp below stable`
      + ` — ${standard.livenessSatisfied === null ? "unevaluated" : standard.livenessSatisfied ? "alive" : "dead (measurement cannot distinguish content)"}`,
  );
  lines.push(`  note: ${standard.denominatorNote}`);
  const perDirection = Object.entries(report.nativeSummary.perDirection)
    .map(([direction, summary]) => `${direction} median-delta ${summary.medianDelta ?? "—"} (${summary.worse}w/${summary.better}b/${summary.equal}e)`)
    .join(" · ");
  lines.push(`native comparison: ${report.nativeSummary.groupsEvaluated} groups evaluated · ${perDirection}`);
  lines.push(`regression rule (${report.regression.rule}): ${report.regression.fired ? "FIRED" : "not fired"} — ${report.regression.groupsRegressed} regressed`);
  lines.push(`conclusion: cache ${report.conclusion.cache.toUpperCase()} · final ${report.conclusion.final.toUpperCase()}`);
  for (const reason of report.conclusion.reasons.slice(0, 8)) lines.push(`  · ${reason}`);
  lines.push(`framing: ${report.framing.disclaimer}`);
  return lines.join("\n");
}
