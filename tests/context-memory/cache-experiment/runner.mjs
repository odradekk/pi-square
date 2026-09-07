import { randomBytes } from "node:crypto";
import {
  ARMS,
  ARM_ROTATION,
  BREAKPOINT_PLACEMENT,
  GROUP_COUNT,
  MARKER,
  SETTINGS,
  SETTINGS_HASH,
  SYSTEM_PROMPT_HASH,
  TOOLS,
  TOOLS_HASH,
  composeRequest,
  fixtureDigest,
  groupOrder,
} from "./fixture.mjs";
import { payloadDigest, prefixEvidence } from "./evidence.mjs";
import {
  FORBIDDEN_CLAIM_PHRASES,
  FRAMING_DISCLAIMER,
  evaluateRun,
  baselineMedians,
  withinTtl,
} from "./verdict.mjs";

/**
 * The experiment runner (#225, standard re-pinned by #260, arms and order
 * re-modeled by #268, measured case re-pinned by #297): executes the five
 * interleaved paired groups over the three pinned arms through an injected
 * provider adapter, records the exact payload/prefix hashes, first
 * divergence boundaries, usage, cache and retention reports, cost, and
 * locally measured TTFT for every request, and produces the bounded verdict
 * report.
 *
 * The runner owns run integrity: only the pinned per-group request order is
 * valid (primes then probes, the arm order rotating per group so no arm is
 * confounded with a request position), per-arm divergence invariants must
 * hold (the measured case is the cross-compaction append: the multiblock and
 * single arms' probes must diverge from their primes exactly at the appended
 * block's seam — every carried byte stays shared — while the nonce control's
 * probe must diverge inside its per-request isolation namespace), and provider reports
 * are validated at the boundary. Every request declares the three
 * breakpoints Pi's anthropic-messages converter places, as canonical byte
 * positions; neither arm adds a breakpoint of its own. The verdict itself —
 * the improved/neutral/regressed/inconclusive standard over the multiblock
 * versus single comparison, the liveness control, and the repeated
 * multi-direction regression rule — lives in `verdict.mjs`. The report
 * carries hashes, offsets, and bounded numbers — never payloads,
 * transcripts, Memory or source bodies, or credentials — and a self-check
 * re-verifies that before anything is written.
 *
 * Exit contract (#297): the command exits zero exactly when the run's
 * integrity holds — the pinned order was honored, every divergence invariant
 * held, every provider report was valid, every probe was within TTL, and the
 * privacy self-check passed. The conclusion label (improved, neutral,
 * regressed, inconclusive) is a measurement result, not a
 * pass/fail signal: an honestly inconclusive run is a successful measurement
 * and must not be made to look like an execution failure by exiting non-zero
 * — nor coaxed toward a positive label to buy a zero exit code.
 */

const REPORT_SCHEMA = "pi-square.context-memory/provider-cache-experiment/3";
const RUN_NONCE_BYTES = 16;
const REPORT_STRING_MAX = 240;
const INTEGRITY_FAILURE_CAP = 16;
const DEFAULT_TTL_MS = 300_000;

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function cacheAvailability(cache) {
  const available = cache.available ?? cache.reported;
  return {
    available,
    readAvailable: cache.readAvailable ?? cache.readReported ?? available,
    writeAvailable: cache.writeAvailable ?? cache.writeReported ?? available,
  };
}

/** Boundary validation of one adapter report; a problem string is an integrity failure. */
function validateProviderReport(report) {
  if (report === null || typeof report !== "object") return "adapter returned no report object";
  if (!isCount(report.usage?.inputTokens) || !isCount(report.usage?.outputTokens)) {
    return "usage token counts are missing or not non-negative integers";
  }
  const cache = report.cache;
  if (cache === null || typeof cache !== "object") {
    return "cache usage is missing";
  }
  const availability = cacheAvailability(cache);
  if (typeof availability.available !== "boolean") {
    return "cache usage is missing its availability flag";
  }
  if (availability.available && (!isCount(cache.read) || !isCount(cache.write))) {
    return "available cache values are not non-negative integers";
  }
  if (typeof availability.readAvailable !== "boolean" || typeof availability.writeAvailable !== "boolean") {
    return "cache usage has malformed direction availability";
  }
  if (availability.available !== (availability.readAvailable || availability.writeAvailable)) {
    return "cache availability is inconsistent with its read/write availability";
  }
  if ((!availability.readAvailable && cache.read !== 0) || (!availability.writeAvailable && cache.write !== 0)) {
    return "an unavailable cache direction carried a non-zero token count";
  }
  if (cache.source !== undefined && cache.source !== "pi-normalized" && cache.source !== "adapter-reported") {
    return "cache usage has an unknown source";
  }
  if (cache.rawFieldPresence !== undefined && cache.rawFieldPresence !== "unknown" && cache.rawFieldPresence !== "observed") {
    return "cache usage has malformed raw-field presence";
  }
  if (typeof report.cost !== "number" || !Number.isFinite(report.cost) || report.cost < 0) {
    return "cost is not a finite non-negative number";
  }
  if (report.costReported !== undefined && typeof report.costReported !== "boolean") {
    return "cost report has a malformed costReported flag";
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
 * invariant (#297): the measured case is the cross-compaction append, so the
 * multiblock and single arms' probes must share every carried byte and
 * diverge exactly at the pinned append seam (`layout.expectedShared`), while
 * the nonce control's probe must diverge inside its isolation-namespace line
 * — within the first bytes of the payload, before any shared cacheable
 * content. A violation means the fixture or composer stopped producing the
 * property under test, so the run's evidence is meaningless.
 */
export function classifyDivergenceBoundary(arm, layout, sharedBytes) {
  if (arm === "multiblock" || arm === "single") {
    const ok = layout.expectedShared !== null && sharedBytes === layout.expectedShared;
    return { ok, boundary: ok ? "appended-block" : "inside-carried-prefix" };
  }
  const ok = layout.namespaceEnd !== undefined && sharedBytes >= 0 && sharedBytes < layout.namespaceEnd;
  return { ok, boundary: ok ? "isolation-namespace" : "outside-isolation-namespace" };
}

function buildPins(adapter, { ttlMs, minRequestGapMs, groupCount, implementationCommit, implementationTree, runNonce }) {
  const declared = adapter.describePins();
  const placement = declared.breakpointPlacement ?? BREAKPOINT_PLACEMENT;
  const pins = {
    provider: declared.provider,
    model: declared.model,
    adapterCacheReporting: declared.cacheReporting,
    adapterBreakpointPlacement: placement,
    toolNames: TOOLS.map((tool) => tool.name),
    toolsHash: TOOLS_HASH,
    systemPromptHash: SYSTEM_PROMPT_HASH,
    settingsHash: SETTINGS_HASH,
    settings: SETTINGS,
    routing: { concurrency: 1, retryPolicy: "none", sessionScope: "one stable Pi session ID per model lane" },
    fixtureDigest: fixtureDigest(groupCount),
    retention: {
      bucket: "default",
      ttlMs,
      breakpoint: placement,
      extendedBucket: "unexercised-in-this-slice",
    },
    groupOrder: Array.from({ length: groupCount }, (_, index) => groupOrder(index + 1)),
    armRotation: ARM_ROTATION,
    measuredCase: "cross-compaction append (#297): prime carries Memory blocks 1–2; probe carries them byte-identical plus appended block 3; multiblock renders the production uniform projection, single renders today's single-summary baseline",
    timing: {
      minRequestGapMs,
      ttlMs,
      rule: "every probe must follow its arm prime within ttlMs on the monotonic clock (clock.mono, never the wall clock); a later probe classifies its group ttl-stale, and a negative interval fails the run's integrity",
    },
    // #297 review findings 2 and 5: every report records the exact
    // implementation commit it measured, the run nonce its isolation
    // namespaces derive from, and the isolation rule.
    implementationCommit,
    implementationTree,
    runNonce,
    armIsolation: "run+group+arm isolation token at the front of the system segment and in every tool description, before any shared cacheable byte, so every prime/probe pair is an independent cold measurement; the control's token is per request",
    priceNote: declared.priceNote,
  };
  if (declared.invocation !== undefined) pins.invocation = declared.invocation;
  // An adapter that cannot apply a pinned setting records the omission in its
  // pins; Pi-native adapters apply exactly the ordinary session options and
  // therefore normally record none.
  if (Array.isArray(declared.settingsOmissions) && declared.settingsOmissions.length > 0) {
    pins.settingsOmissions = declared.settingsOmissions;
  }
  return pins;
}

function rowOf(record, evidence) {
  const report = record.report;
  const availability = cacheAvailability(report.cache);
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
    cacheAvailable: availability.available,
    cacheReadAvailable: availability.readAvailable,
    cacheWriteAvailable: availability.writeAvailable,
    cacheRead: availability.available ? report.cache.read : 0,
    cacheWrite: availability.available ? report.cache.write : 0,
    cacheSource: report.cache.source ?? "adapter-reported",
    rawCacheFieldPresence: report.cache.rawFieldPresence ?? "observed",
    inputTokens: report.usage.inputTokens,
    outputTokens: report.usage.outputTokens,
    retentionWriteReported: report.retentionWrite?.reported === true,
    retentionBucket: report.retentionWrite?.reported === true ? report.retentionWrite.bucket : "unreported",
    retentionWriteTokens: report.retentionWrite?.reported === true ? report.retentionWrite.tokens : 0,
    cost: roundCost(report.cost),
    costReported: report.costReported ?? true,
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

function stringValueIncludes(value, needle) {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => stringValueIncludes(item, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => stringValueIncludes(item, needle));
  }
  return false;
}

function redactSensitiveText(value, secretValues) {
  let redacted = String(value).split(MARKER).join("‹redacted›");
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 3) {
      redacted = redacted.split(secret).join("‹redacted›");
    }
  }
  return redacted;
}

function redactReportStrings(value, secretValues) {
  if (typeof value === "string") return redactSensitiveText(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactReportStrings(item, secretValues));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactReportStrings(item, secretValues)]));
  }
  return value;
}

/**
 * The report must never contain fixture bodies, unbounded strings, or a
 * caller-declared secret value (#297 review round 3): the CLI passes the
 * present adapter-credential values so an echoed provider error body that
 * slipped every upstream scrub still fails the run's integrity instead of
 * reaching the artifact.
 */
export function findReportLeaks(json, secretValues = []) {
  const leaks = [];
  if (json.includes(MARKER)) leaks.push("the fixture content marker");
  if (/(.)\1{63}/.test(json)) leaks.push("a 64+ character repeated run");
  for (const phrase of FORBIDDEN_CLAIM_PHRASES) {
    if (json.includes(phrase)) leaks.push(`the claim phrase "${phrase}"`);
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 3
      && (parsed === undefined ? json.includes(secret) : stringValueIncludes(parsed, secret))) {
      leaks.push("a credential value");
    }
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
  secretValues = [],
  ttlMs = DEFAULT_TTL_MS,
  minRequestGapMs = 0,
  groupCount = GROUP_COUNT,
  orderFor = groupOrder,
  generatedAt = () => new Date().toISOString(),
  implementationCommit = "unavailable",
  implementationTree = "unavailable",
  runNonce = randomBytes(RUN_NONCE_BYTES).toString("hex"),
  onEvent,
}) {
  const integrity = { ok: true, orderMatchesPin: true, divergenceInvariantsOk: true, ttlOk: true, providerErrors: 0, failures: [] };
  const fail = (message) => {
    integrity.ok = false;
    if (integrity.failures.length < INTEGRITY_FAILURE_CAP) integrity.failures.push(message);
  };

  const pins = buildPins(adapter, { ttlMs, minRequestGapMs, groupCount, implementationCommit, implementationTree, runNonce });
  for (let group = 1; group <= groupCount; group += 1) {
    if (JSON.stringify(orderFor(group)) !== JSON.stringify(groupOrder(group))) {
      integrity.orderMatchesPin = false;
      fail(`group ${group}: request order deviated from the pinned rotated per-group order`);
    }
  }

  const records = new Map(); // `${group}|${arm}.${role}` -> record
  let aborted = false;
  let requestIndex = 0;
  execute:
  for (let group = 1; group <= groupCount; group += 1) {
    for (const step of orderFor(group)) {
      const [arm, role] = step.split(".");
      requestIndex += 1;
      if (minRequestGapMs > 0) await clock.sleep(minRequestGapMs);
      const composed = composeRequest({ group, arm, role, runNonce });
      const digest = payloadDigest(composed.payload);
      const sentAtMs = clock.now();
      // #297 review round 3: intervals come from the monotonic counter, not
      // the wall clock — TTL and TTFT evidence must survive NTP steps.
      const sentAtMonoMs = clock.mono?.() ?? clock.now();
      let firstTokenAt;
      let report;
      try {
        report = await adapter.send(
          {
            group,
            arm,
            role,
            runNonce,
            payload: composed.payload,
            digest,
            tokenEstimate: digest.tokenEstimate,
            cacheControl: {
              bucket: pins.retention.bucket,
              ttlMs,
              breakpoint: pins.retention.breakpoint,
              // The three positions Pi's anthropic-messages converter places,
              // as canonical byte positions: system, tools, last message block.
              breakpoints: composed.layout.breakpoints,
            },
          },
          { onFirstToken: () => { firstTokenAt = clock.mono?.() ?? clock.now(); } },
        );
      } catch (error) {
        integrity.providerErrors += 1;
        const rawError = String(error?.message ?? error);
        if (secretValues.some((secret) => typeof secret === "string" && secret.length >= 3 && rawError.includes(secret))) {
          fail(`group ${group} ${arm}.${role}: the adapter error contained a credential value`);
        }
        const message = `the adapter threw (${redactSensitiveText(rawError, secretValues).slice(0, 120)})`;
        fail(`group ${group} ${arm}.${role}: ${message}`);
        onEvent?.({ type: "request", group, arm, role, index: requestIndex, total: groupCount * groupOrder(1).length, error: message });
        aborted = true;
        break execute;
      }
      const problem = validateProviderReport(report);
      if (problem) {
        integrity.providerErrors += 1;
        fail(`group ${group} ${arm}.${role}: ${problem}`);
        onEvent?.({ type: "request", group, arm, role, index: requestIndex, total: groupCount * groupOrder(1).length, error: problem });
        aborted = true;
        break execute;
      }
      onEvent?.({
        type: "request", group, arm, role, index: requestIndex, total: groupCount * groupOrder(1).length,
        cacheRead: report.cache?.read ?? 0, cacheWrite: report.cache?.write ?? 0,
        uncached: report.usage?.inputTokens ?? 0,
        ttftMs: firstTokenAt === undefined ? undefined : firstTokenAt - sentAtMonoMs,
      });
      const ttftMs = firstTokenAt === undefined ? undefined : firstTokenAt - sentAtMonoMs;
      if (ttftMs !== undefined && ttftMs < 0) {
        fail(`group ${group} ${arm}.${role}: first token preceded request dispatch on the monotonic clock (negative TTFT interval)`);
      }
      records.set(`${group}|${step}`, {
        group,
        arm,
        role,
        composed,
        digest,
        report,
        sentAtMs,
        sentAtMonoMs,
        ttftMs,
      });
    }
  }

  const verdictInputs = [];
  const reportGroups = [];
  if (!aborted) {
    for (let group = 1; group <= groupCount; group += 1) {
      const arms = {};
      const primeToProbeMs = {};
      let negativeInterval = false;
      for (const arm of ARMS) {
        const prime = records.get(`${group}|${arm}.prime`);
        const probe = records.get(`${group}|${arm}.probe`);
        if (!prime || !probe) continue; // unreachable with the pinned order; guards a partial run
        const evidence = prefixEvidence(prime.composed.payload, probe.composed.payload);
        const classification = classifyDivergenceBoundary(arm, probe.composed.layout, evidence.sharedBytes);
        if (!classification.ok) {
          integrity.divergenceInvariantsOk = false;
          fail(
            `group ${group} ${arm}: the probe's first divergence at byte ${evidence.sharedBytes} violates the ${arm} append invariant (${classification.boundary})`,
          );
        }
        evidence.boundary = classification.boundary;
        probe.primeToProbeMs = probe.sentAtMonoMs - prime.sentAtMonoMs;
        primeToProbeMs[arm] = probe.primeToProbeMs;
        if (probe.primeToProbeMs < 0) negativeInterval = true;
        arms[arm] = { prime: rowOf(prime, null), probe: rowOf(probe, evidence) };
      }
      if (Object.keys(arms).length !== 3) continue;
      const timing = { ttlMs, primeToProbeMs, withinTtl: withinTtl(primeToProbeMs, ttlMs) };
      if (negativeInterval) {
        // #297 review round 3: a negative interval means the clock moved
        // backwards between a prime and its probe — the timing evidence is
        // broken, not merely stale, and the run fails its integrity.
        integrity.ttlOk = false;
        integrity.ok = false;
        fail(`group ${group}: a probe was sent before its prime on the monotonic clock (negative interval)`);
      } else if (!timing.withinTtl) {
        // #297 review finding 4: an out-of-TTL probe is stale evidence, not a
        // soft group quality — the run's integrity fails and the exit code
        // reports it, whatever the token counts look like.
        integrity.ttlOk = false;
        integrity.ok = false;
        fail(`group ${group}: a probe followed its prime after more than the pinned ${ttlMs}ms TTL`);
      }
      const groupInput = { group, timing, ...arms };
      verdictInputs.push(groupInput);
      reportGroups.push({
        group,
        timing,
        multiblock: arms.multiblock,
        single: arms.single,
        nonce: arms.nonce,
      });
    }
  }

  const verdict = evaluateRun({ groups: verdictInputs, integrity });
  let report = {
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
      ttlOk: integrity.ttlOk,
      providerErrors: integrity.providerErrors,
      failures: integrity.failures,
    },
    groups: reportGroups.map((group) => {
      const classified = verdict.groups.find((candidate) => candidate.group === group.group);
      return {
        ...group,
        quality: classified?.quality ?? null,
        qualityReasons: classified?.qualityReasons ?? [],
        baselineComparison: classified?.baselineComparison ?? null,
      };
    }),
    cacheStandard: verdict.cacheStandard,
    baselineSummary: baselineMedians(verdict.groups),
    regression: verdict.regression,
    conclusion: {
      cache: verdict.cacheConclusion,
      final: verdict.conclusion,
      livenessSatisfied: verdict.cacheStandard.livenessSatisfied,
      reasons: verdict.reasons,
    },
    totals: {
      groups: reportGroups.length,
      requests: records.size,
      requestsWithCacheUsage: [...records.values()].filter((record) => cacheAvailability(record.report.cache).available).length,
      requestsWithRetentionReport: [...records.values()].filter((record) => record.report.retentionWrite?.reported === true).length,
    },
  };

  // Privacy self-check: the emitted artifact itself must stay payload-free and bounded.
  let json = JSON.stringify(report, null, 2);
  const leaks = [...findReportLeaks(json, secretValues)];
  if (longestStringValue(report) > REPORT_STRING_MAX) leaks.push(`a string field longer than ${REPORT_STRING_MAX} characters`);
  if (leaks.length > 0) {
    report.integrity.ok = false;
    report.integrity.failures.push(`the report contained ${leaks.join("; ")}`);
    report.conclusion.cache = "inconclusive";
    report.conclusion.final = "inconclusive";
    report.conclusion.reasons.push(`report privacy self-check failed: ${leaks.join("; ")}`);
    // The failure text is appended after the scan, and the offending values
    // can sit anywhere in the report (including the failure entries the
    // adapter errors produced). Redact the report object itself before both
    // serializations so JSON, human text, and the returned value agree and
    // none can retain a credential or fixture body.
    report = redactReportStrings(report, secretValues);
    json = JSON.stringify(report, null, 2);
  }

  const exitCode = report.integrity.ok ? 0 : 1;
  return { report, json, humanText: renderHuman(report), exitCode };
}

function renderHuman(report) {
  const short = (hash) => (typeof hash === "string" && hash.length >= 12 ? hash.slice(0, 12) : String(hash));
  const lines = [];
  lines.push(`Provider-cache experiment (#225, scale #260, arms #268, append case #297) — ${report.mode}`);
  lines.push(
    `result: ${report.conclusion.final.toUpperCase()} — ${report.totals.groups} groups, ${report.totals.requests} requests, integrity ${report.integrity.ok ? "ok" : "FAILED"}`,
  );
  lines.push(`adapter: ${report.adapter.model} (provider ${report.adapter.provider}, cache reporting ${report.adapter.cacheReporting})`);
  lines.push(
    `pins: model ${report.pins.model} · tools ${short(report.pins.toolsHash)} · system ${short(report.pins.systemPromptHash)}`
      + ` · settings ${short(report.pins.settingsHash)} · fixture ${short(report.pins.fixtureDigest)}`
      + ` · retention ${report.pins.retention.bucket}/${report.pins.retention.ttlMs}ms`,
  );
  lines.push(`breakpoints: ${report.pins.retention.breakpoint}`);
  lines.push(`measured case: ${report.pins.measuredCase}`);
  const orderText = report.pins.groupOrder
    .map((steps, index) => `${index + 1} ${steps.map((step) => step.replace(".prime", "").replace(".probe", "'")).join(",")}`)
    .join(" · ");
  lines.push(`timing: ttl ${report.pins.timing.ttlMs}ms · min gap ${report.pins.timing.minRequestGapMs}ms · order per group (primes then probes): ${orderText}`);
  lines.push("groups:");
  for (const group of report.groups) {
    const baseline = group.baselineComparison?.evaluated
      ? `${group.baselineComparison.worseDirections.length} worse directions`
      : "baseline comparison unevaluated";
    lines.push(`  ${String(group.group).padStart(2)}  ${String(group.quality).padEnd(14)} · baseline: ${baseline}`);
  }
  const { cacheStandard: standard } = report;
  const rateText = (arm) => (standard.rates[arm].rate === null ? "n/a" : `${(standard.rates[arm].rate * 100).toFixed(1)}%`);
  lines.push(`hit rate (${standard.aggregation}):`);
  lines.push(
    `  multiblock ${rateText("multiblock")} (under test) · single ${rateText("single")} (baseline)`
      + ` · nonce ${rateText("nonce")} (liveness control) — ${standard.groupsAggregated} groups aggregated`,
  );
  lines.push(`  definition: ${standard.hitRateDefinition}`);
  lines.push(
    `  band: multiblock must stay within ${standard.band.belowBaselinePercentagePoints}pp of single`
      + ` (minimum ${standard.minimumAcceptableRate === null ? "n/a" : `${(standard.minimumAcceptableRate * 100).toFixed(1)}%`})`
      + ` — ${standard.bandSatisfied === null ? "unevaluated" : standard.bandSatisfied ? "met" : "failed"}`,
  );
  lines.push(
    `  improvement: multiblock must exceed single by at least ${standard.improvement.aboveBaselinePercentagePoints}pp`
      + ` — ${standard.improvementObserved === null ? "unevaluated" : standard.improvementObserved ? "observed" : "not observed"}`,
  );
  lines.push(
    `  liveness: nonce must sit at least ${standard.liveness.belowMarginPercentagePoints}pp below multiblock`
      + ` — ${standard.livenessSatisfied === null ? "unevaluated" : standard.livenessSatisfied ? "alive" : "dead (measurement cannot distinguish content)"}`,
  );
  lines.push(`  note: ${standard.denominatorNote}`);
  const perDirection = Object.entries(report.baselineSummary.perDirection)
    .map(([direction, summary]) => {
      const spread = direction === "ttft" && summary.spreadMs !== null && summary.spreadMs !== undefined
        ? ` (spread ${summary.spreadMs}ms)`
        : "";
      const median = summary.medianDelta === null && summary.unreported > 0 ? "unreported" : summary.medianDelta ?? "—";
      const availability = summary.unreported > 0 ? `; ${summary.unreported} unreported` : "";
      return `${direction} median-delta ${median}${spread} (${summary.worse}w/${summary.better}b/${summary.equal}e${availability})`;
    })
    .join(" · ");
  const derivedCost = report.baselineSummary.derived?.cost;
  const derivedText = derivedCost
    ? ` · cost (derived) median-delta ${derivedCost.medianDelta === null && derivedCost.unreported > 0 ? "unreported" : derivedCost.medianDelta ?? "—"} (${derivedCost.worse}w/${derivedCost.better}b/${derivedCost.equal}e${derivedCost.unreported > 0 ? `; ${derivedCost.unreported} unreported` : ""})`
    : "";
  lines.push(`baseline comparison: ${report.baselineSummary.groupsEvaluated} groups evaluated · ${perDirection}${derivedText}`);
  lines.push(`  directions (counted, independent): ${report.regression.directions.counted.join(", ")}`);
  for (const [direction, note] of Object.entries(report.regression.directions.notes)) {
    lines.push(`    ${direction}: ${note}`);
  }
  lines.push(`  ${report.regression.directions.derivedNote}`);
  lines.push(`regression rule (${report.regression.rule}): ${report.regression.fired ? "FIRED" : "not fired"} — ${report.regression.groupsRegressed} regressed`);
  lines.push(`conclusion: cache ${report.conclusion.cache.toUpperCase()} · final ${report.conclusion.final.toUpperCase()}`);
  for (const reason of report.conclusion.reasons.slice(0, 8)) lines.push(`  · ${reason}`);
  lines.push(`exit: ${report.integrity.ok ? "0 (integrity ok; the conclusion label is the measurement, not a pass/fail signal)" : "1 (integrity failed)"}`);
  lines.push(`framing: ${report.framing.disclaimer}`);
  return lines.join("\n");
}
