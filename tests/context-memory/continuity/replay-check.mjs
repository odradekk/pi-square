import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeNativeReplay } from "./native-replay.mjs";

/**
 * One bounded local-resource check over the actual continuity qualification
 * artifacts (#325): replay time and heap cost of re-reading the retained
 * evidence, and the persisted-write footprint of one attempt's report set.
 * This distinguishes the model-context reduction the feature measures from
 * the local log growth the qualification itself produces. It is a bounded
 * evidence artifact, not a general benchmark system.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT_DIR = join(HERE, "report");
export { MAX_NATIVE_SESSION_BYTES, NATIVE_REPLAY_SCHEMA, measureNativeSessionReplay, safeNativeReplay } from "./native-replay.mjs";

function heapUsedMb() {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

function reportDirectory(args) {
  if (args.length === 0) return DEFAULT_REPORT_DIR;
  if (args.length === 2 && args[0] === "--report-dir" && args[1].length > 0) return args[1];
  throw new Error("usage: replay-check.mjs [--report-dir <directory>]");
}

async function main(args = process.argv.slice(2)) {
  const reportDir = reportDirectory(args);
  const { parseQualificationReport } = await import("./runner.mjs");
  const names = readdirSync(reportDir);
  const latest = names.filter((name) => name.startsWith("continuity-qualification-") && name.endsWith(".json"))
    .sort().at(-1);
  if (latest === undefined) throw new Error("no continuity qualification report found; run the matrix first");
  const attemptId = latest.slice("continuity-qualification-".length, -".json".length);
  const evidenceName = `continuity-evidence-${attemptId}.json`;
  const files = {
    report: join(reportDir, latest),
    evidence: readdirSync(reportDir).includes(evidenceName) ? join(reportDir, evidenceName) : null,
    attempts: join(reportDir, "attempts.jsonl"),
  };

  const sizes = {};
  for (const [name, path] of Object.entries(files)) {
    sizes[name] = path === null ? null : statSync(path).size;
  }

  // Replay: parse each artifact from disk, timed, with the heap delta around
  // the largest one (the retained evidence carries the bounded trajectory).
  const replay = {};
  for (const [name, path] of Object.entries(files)) {
    if (path === null) continue;
    const before = heapUsedMb();
    const startedAt = performance.now();
    const text = readFileSync(path, "utf8");
    // The attempts log is JSONL; reports and evidence are single documents.
    const parsed = name === "attempts"
      ? text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line)).at(-1)
      : JSON.parse(text);
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const entries = Array.isArray(parsed?.runs) ? parsed.runs.length : null;
    replay[name] = { elapsedMs, heapDeltaMb: Math.round((heapUsedMb() - before) * 10) / 10, entries };
  }

  const report = JSON.parse(readFileSync(files.report, "utf8"));
  const classification = parseQualificationReport(report);
  // Model-context effect versus local-log growth, both bounded: the report's
  // request rows carry per-request prompt tokens; the artifact bytes are the
  // local cost of retaining the evidence for human review.
  const runs = (report.runs ?? []).map((run) => ({
    run: run.run,
    requests: (run.requests ?? []).length,
    peakPromptTokens: run.measurements?.peakPromptTokens ?? null,
    netInputChange: run.measurements?.netInputChange ?? null,
    appends: run.coverage?.appends ?? null,
    rebuilds: run.coverage?.rebuilds ?? null,
    nativeReplay: safeNativeReplay(run.measurements?.nativeReplay),
  }));
  const summary = {
    schema: "pi-square.context-memory/continuity-replay-check/1",
    attemptId: report.attemptId ?? attemptId,
    generatedAt: new Date().toISOString(),
    commit: report.pins?.commit ?? null,
    sourceReport: { schema: report.schema, classification: classification.kind, currentQualification: classification.currentQualification },
    artifacts: {
      reportBytes: sizes.report,
      evidenceBytes: sizes.evidence,
      attemptsBytes: sizes.attempts,
      totalBytes: Object.values(sizes).reduce((total, size) => total + (size ?? 0), 0),
    },
    nativeReplay: {
      expectedRuns: 24,
      measuredRuns: runs.filter((run) => run.nativeReplay !== null).length,
      equivalentRuns: runs.filter((run) => run.nativeReplay?.branchEquivalent && run.nativeReplay?.memoryEquivalent
        && run.nativeReplay?.diskUnchanged && run.nativeReplay?.directoryEntriesUnchanged).length,
    },
    replay,
    heapAfterReplayMb: heapUsedMb(),
    runs,
    interpretation: "replay times and heap deltas describe one parse of the retained bounded artifacts; nativeReplay separately measures bounded Pi session reopening and branch/Memory equivalence when available; historical reports with no nativeReplay cannot establish that evidence; provider-reported request fields describe the model context while local artifact bytes describe storage only — bytes are never billed tokens; current qualification requires all expected cells with observed session thinking matching their model pins, which historical reports cannot establish",
  };
  const outPath = join(reportDir, `continuity-replay-check-${attemptId.slice(0, 19)}.json`);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.error(`report: ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
