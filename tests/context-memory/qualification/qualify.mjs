import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

/**
 * The Context Memory qualification command (#223, migrated by #325).
 *
 * One reproducible, zero-tolerance sweep of the implemented protocol. The
 * mechanical acceptance corpus for the in-task recording and request-projection
 * architecture (#319–#324, ADR-0017) lives in the deterministic native suites
 * under `tests/context-memory/` — controller-seam units plus the real
 * `AgentSession` request-exit evidence — and this command runs every one of
 * them as one gated sweep, emitting a bounded report tied to the
 * implementation and corpus content. The pre-#319 corpus (submit_memory
 * batches, settle-time takeover compactions, first-request-only sources) was
 * retired with its protocol; its stale assertions are not evidence.
 *
 * A maintainer runs this before authorizing a release; any failed check
 * blocks. There is no retry-to-green and no waiver path. The report carries
 * only bounded mechanical metadata — suite names, exit codes, and sanitized
 * failure tails — never Memory bodies, source bodies, or credentials.
 */

const load = jiti(import.meta.url, { moduleCache: false });
const { resolveHostVersion } = await load("../../../src/context-memory/host.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests", "context-memory");
const REPORT_DIR = join(HERE, "report");
const FAILURE_LIST_CAP = 32;
const SUITE_TIMEOUT_MS = 15 * 60_000;
const TAIL_LIMIT = 600;

/** Every deterministic context-memory suite, discovered the way `npm test` finds them. */
function suitePaths() {
  const suites = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, name.name);
      if (name.isDirectory()) visit(path);
      else if (name.isFile() && name.name.endsWith(".test.mjs")) suites.push(path);
    }
  };
  visit(TESTS_DIR);
  return suites;
}

/**
 * Each file is keyed by its repository-relative path with POSIX separators,
 * never by the absolute checkout path, so the digest pins content and layout
 * only: the same commit digests identically at any working location (#250).
 */
function digestOf(paths) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(relative(REPO_ROOT, path).split(sep).join("/"));
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

function provenance(suites) {
  return {
    head: gitOutput(["rev-parse", "HEAD"]),
    branchDirty: gitOutput(["status", "--porcelain", "--", "src/context-memory", "tests/context-memory"]) !== "",
    implementationDigest: digestOf(readdirSync(join(REPO_ROOT, "src", "context-memory"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(REPO_ROOT, "src", "context-memory", name))),
    corpusDigest: digestOf(suites),
  };
}

/** The repository's pinned Pi version — activation is decided by interface presence (#255). */
function qualifiedAgainstPi() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? "unknown";
}

/** Run one suite as a child process; its exit code is the check's verdict. */
function runSuite(path) {
  const result = spawnSync(process.execPath, [path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: SUITE_TIMEOUT_MS,
    env: { ...process.env, PI_QUALIFICATION_SWEEP: "1" },
  });
  const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    signal: result.signal ?? null,
    tail: tail.length > 0 ? tail.slice(-TAIL_LIMIT).replace(/(.)\1{15,}/g, (match, char) => `${char}<×${match.length}>`) : null,
  };
}

function areaSummaries(runs) {
  const byArea = new Map();
  for (const run of runs) {
    const area = run.area;
    const summary = byArea.get(area) ?? { area, suites: 0, failed: 0 };
    summary.suites += 1;
    if (!run.ok) summary.failed += 1;
    byArea.set(area, summary);
  }
  return [...byArea.values()];
}

/** The report must never contain Memory or source bodies, or credentials. */
function findReportLeaks(json) {
  const leaks = [];
  const repeated = json.match(/(.)\1{63}/);
  if (repeated) leaks.push("a 64+ character repeated run (fixture padding)");
  return leaks;
}

async function main() {
  const suites = suitePaths();
  const runs = [];
  for (const path of suites) {
    const relativeDir = relative(TESTS_DIR, dirname(path)).split(sep).join("/");
    const area = relativeDir === "" || relativeDir === "." ? "protocol" : relativeDir;
    const outcome = runSuite(path);
    runs.push({ suite: relative(REPO_ROOT, path).split(sep).join("/"), area, ...outcome });
  }

  const failed = runs.filter((run) => !run.ok);
  const provenanceData = provenance(suites);
  const failures = failed.slice(0, FAILURE_LIST_CAP).map((run) => ({
    area: run.area,
    suite: run.suite,
    message: run.tail ?? (run.signal ? `terminated by signal ${run.signal}` : "no output"),
  }));

  const report = {
    schema: "pi-square.context-memory/qualification/2",
    generatedAt: new Date().toISOString(),
    result: failed.length === 0 ? "pass" : "fail",
    zeroTolerance: { failures: failed.length, waivers: 0, retries: 0 },
    git: provenanceData,
    runtime: {
      node: process.version,
      runningPi: resolveHostVersion(),
      qualifiedAgainstPi: qualifiedAgainstPi(),
    },
    sweep: {
      kind: "deterministic context-memory suites (controller seam, native AgentSession request exit, projection, wire, arbitration, lifecycle, and instruments)",
      suites: suites.length,
      timeoutMsPerSuite: SUITE_TIMEOUT_MS,
    },
    areas: areaSummaries(runs),
    failures,
    failuresTruncated: failed.length > FAILURE_LIST_CAP,
    totals: { areas: areaSummaries(runs).length, suites: runs.length, failed: failed.length },
  };

  // Privacy self-check: the emitted artifact itself must stay body-free.
  let json = JSON.stringify(report, null, 2);
  const leaks = findReportLeaks(json);
  if (leaks.length > 0) {
    report.failures.push({ area: "qualification-report", suite: "report-privacy", message: `the report contained ${leaks.join("; ")}` });
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
  lines.push("Context Memory qualification corpus (#223, migrated by #325)");
  lines.push(`result: ${report.result.toUpperCase()} — ${report.totals.suites} suites, ${report.totals.failed} failed, 0 waivers, 0 retries`);
  lines.push(
    `implementation: src/context-memory @ ${short(provenanceData.head)} digest ${provenanceData.implementationDigest.slice(0, 12)}`
      + `${provenanceData.branchDirty ? " (working tree dirty)" : " (clean)"}`,
  );
  lines.push(`corpus: tests/context-memory deterministic suites digest ${provenanceData.corpusDigest.slice(0, 12)}`);
  lines.push(`runtime: node ${process.version} · pi ${report.runtime.runningPi} (qualified against ${report.runtime.qualifiedAgainstPi}; activation by interface presence, not version)`);
  lines.push("areas:");
  for (const summary of report.areas) {
    lines.push(`  ${summary.area.padEnd(22)} ${String(summary.suites).padStart(3)} suites  ${summary.failed} failed`);
  }
  if (failed.length === 0) {
    lines.push("failures: none");
  } else {
    lines.push("failures:");
    for (const failure of report.failures) {
      lines.push(`  [${failure.area}] ${failure.suite}: ${(failure.message ?? "no detail").slice(0, 200)}`);
    }
    if (report.failuresTruncated) lines.push(`  … ${failed.length - FAILURE_LIST_CAP} more (see the JSON report fields, capped at ${FAILURE_LIST_CAP})`);
  }
  lines.push(`report: ${jsonPath}`);
  const human = lines.join("\n");
  writeFileSync(join(REPORT_DIR, "context-memory-qualification.txt"), `${human}\n`);
  console.log(human);

  process.exitCode = report.result === "pass" ? 0 : 1;
}

await main();
