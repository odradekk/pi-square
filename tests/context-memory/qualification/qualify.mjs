import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, SEVERE_CLASSES, boundedMessage, createRecorder, host } from "./harness.mjs";
import {
  areaFirstAppend,
  areaRepeatedAppend,
  areaSuffixRebuild,
  areaSourcePaging,
  areaBranchSession,
  areaSafeFallback,
  areaTransactionFailures,
  areaExactPrefix,
} from "./areas.mjs";
import { areaBoundaryFixtures } from "./boundaries.mjs";

/**
 * The Context Memory qualification command (#223).
 *
 * One reproducible, zero-tolerance sweep of the implemented protocol through
 * the production controller seam, emitting a bounded report tied to the
 * implementation and corpus content. It complements — never replaces — the
 * ordinary `npm test` suites: a maintainer runs this before authorizing a
 * release, and any failed check blocks. There is no retry-to-green and no
 * waiver path. The report carries only bounded mechanical metadata: states,
 * counts, digests, and sanitized excerpts — never Memory bodies, source
 * bodies, or credentials — which the built-in self-check re-verifies.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const REPORT_DIR = join(HERE, "report");
const FAILURE_LIST_CAP = 32;

const AREAS = [
  ["first-append", areaFirstAppend],
  ["repeated-append", areaRepeatedAppend],
  ["suffix-rebuild", areaSuffixRebuild],
  ["source-paging", areaSourcePaging],
  ["branch-session", areaBranchSession],
  ["safe-fallback", areaSafeFallback],
  ["transaction-failures", areaTransactionFailures],
  ["exact-prefix", areaExactPrefix],
  ["boundary-fixtures", areaBoundaryFixtures],
];

function digestOf(paths) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function provenance() {
  const implementationDir = join(REPO_ROOT, "src", "context-memory");
  const implementationFiles = readdirSync(implementationDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(implementationDir, name));
  const corpusFiles = readdirSync(HERE)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => join(HERE, name));
  return {
    head: gitOutput(["rev-parse", "HEAD"]),
    branchDirty: gitOutput(["status", "--porcelain", "--", "src/context-memory", "tests/context-memory/qualification"]) !== "",
    implementationDigest: digestOf(implementationFiles),
    corpusDigest: digestOf(corpusFiles),
  };
}

function areaSummaries(checks) {
  const order = AREAS.map(([name]) => name);
  const byArea = new Map(order.map((name) => [name, { area: name, checks: 0, failed: 0 }]));
  for (const check of checks) {
    const summary = byArea.get(check.area) ?? { area: check.area, checks: 0, failed: 0 };
    summary.checks += 1;
    if (!check.ok) summary.failed += 1;
    byArea.set(check.area, summary);
  }
  return order.map((name) => byArea.get(name));
}

/** The report must never contain Memory or source bodies, or credentials. */
function findReportLeaks(json) {
  const leaks = [];
  if (json.includes(MARKER)) leaks.push("the fixture content marker");
  const repeated = json.match(/(.)\1{63}/);
  if (repeated) leaks.push("a 64+ character repeated run (fixture padding)");
  return leaks;
}

function maskLeaks(json) {
  return json
    .split(MARKER)
    .join("‹redacted›")
    .replace(/(.{1})(\1{63,})/g, (match, char) => `${char}<×${match.length}>`);
}

async function main() {
  const recorder = createRecorder();
  const artifacts = { advisories: {} };

  for (const [name, run] of AREAS) {
    try {
      await run(recorder, artifacts);
    } catch (error) {
      // A trace-level defect outside any single check still fails the sweep.
      recorder.checks.push({
        area: name,
        id: "area-harness",
        class: "fabrication",
        ok: false,
        message: boundedMessage(error),
      });
    }
  }

  const failed = recorder.checks.filter((check) => !check.ok);
  const provenanceData = provenance();
  const failures = failed.slice(0, FAILURE_LIST_CAP).map((check) => ({
    area: check.area,
    id: check.id,
    class: check.class,
    message: check.message,
  }));

  const report = {
    schema: "pi-square.context-memory/qualification/1",
    generatedAt: new Date().toISOString(),
    result: failed.length === 0 ? "pass" : "fail",
    zeroTolerance: { failures: failed.length, waivers: 0, retries: 0 },
    git: provenanceData,
    runtime: {
      node: process.version,
      supportedPi: host.SUPPORTED_PI_VERSION,
      runningPi: host.resolveHostVersion(),
    },
    profiles: {
      window: 200_000,
      reserveTokens: 16_384,
      dueConfig: { compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 },
      rebuildBudgetPercent: 1,
      capConfig: { compressionThreshold: { percent: 80 }, memoryBudgetPercent: 25 },
      maxBlockConfig: { compressionThreshold: { tokens: 25_000 }, memoryBudgetPercent: 10 },
    },
    severeClasses: SEVERE_CLASSES,
    areas: areaSummaries(recorder.checks),
    failures,
    failuresTruncated: failed.length > FAILURE_LIST_CAP,
    totals: {
      areas: AREAS.length,
      checks: recorder.checks.length,
      failed: failed.length,
    },
  };

  // Privacy self-check: the emitted artifact itself must stay body-free.
  let json = JSON.stringify(report, null, 2);
  const leaks = findReportLeaks(json);
  if (leaks.length > 0) {
    json = maskLeaks(json);
    report.failures.push({
      area: "qualification-report",
      id: "report-privacy",
      class: "negative-constraint",
      message: `the report contained ${leaks.join("; ")}`,
    });
    report.result = "fail";
    report.zeroTolerance.failures += 1;
    report.totals.failed += 1;
    json = JSON.stringify(report, null, 2);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, "context-memory-qualification.json");
  writeFileSync(jsonPath, json.endsWith("\n") ? json : `${json}\n`);

  const short = (value) => (value === null ? "unknown" : value.slice(0, 12));
  const lines = [];
  lines.push("Context Memory qualification corpus (#223)");
  lines.push(`result: ${report.result.toUpperCase()} — ${report.totals.checks} checks, ${report.totals.failed} failed, 0 waivers, 0 retries`);
  lines.push(
    `implementation: src/context-memory @ ${short(provenanceData.head)} digest ${provenanceData.implementationDigest.slice(0, 12)}`
      + `${provenanceData.branchDirty ? " (working tree dirty)" : " (clean)"}`,
  );
  lines.push(`corpus: tests/context-memory/qualification digest ${provenanceData.corpusDigest.slice(0, 12)}`);
  lines.push(`runtime: node ${process.version} · pi ${report.runtime.runningPi} (supported ${report.runtime.supportedPi})`);
  lines.push("areas:");
  for (const summary of report.areas) {
    lines.push(`  ${summary.area.padEnd(22)} ${String(summary.checks).padStart(3)} checks  ${summary.failed} failed`);
  }
  lines.push(
    `severe-failure classes (#215 vocabulary): ${SEVERE_CLASSES.map((klass) => `${klass} ${failedCountFor(failed, klass)}`).join(" · ")}`,
  );
  if (failed.length === 0) {
    lines.push("failures: none");
  } else {
    lines.push("failures:");
    for (const failure of report.failures) {
      lines.push(`  [${failure.area}] ${failure.id} (${failure.class}): ${failure.message ?? "no detail"}`);
    }
    if (report.failuresTruncated) lines.push(`  … ${failed.length - FAILURE_LIST_CAP} more (see the JSON report fields, capped at ${FAILURE_LIST_CAP})`);
  }
  lines.push(`report: ${jsonPath}`);
  const human = lines.join("\n");
  writeFileSync(join(REPORT_DIR, "context-memory-qualification.txt"), `${human}\n`);
  console.log(human);

  if (process.argv.includes("--json")) console.log(json);
  process.exitCode = report.result === "pass" ? 0 : 1;
}

function failedCountFor(failed, klass) {
  return failed.filter((check) => check.class === klass).length;
}

await main();
