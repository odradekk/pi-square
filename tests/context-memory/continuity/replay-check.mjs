import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseQualificationReport } from "./runner.mjs";

/**
 * One bounded local-resource check over the actual continuity qualification
 * artifacts (#325): replay time and heap cost of re-reading the retained
 * evidence, and the persisted-write footprint of one attempt's report set.
 * This distinguishes the model-context reduction the feature measures from
 * the local log growth the qualification itself produces. It is a bounded
 * evidence artifact, not a general benchmark system.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, "report");

function heapUsedMb() {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

async function main() {
  const names = readdirSync(REPORT_DIR);
  const latest = names.filter((name) => name.startsWith("continuity-qualification-") && name.endsWith(".json"))
    .sort().at(-1);
  if (latest === undefined) throw new Error("no continuity qualification report found; run the matrix first");
  const attemptId = latest.slice("continuity-qualification-".length, -".json".length);
  const evidenceName = `continuity-evidence-${attemptId}.json`;
  const files = {
    report: join(REPORT_DIR, latest),
    evidence: readdirSync(REPORT_DIR).includes(evidenceName) ? join(REPORT_DIR, evidenceName) : null,
    attempts: join(REPORT_DIR, "attempts.jsonl"),
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
    replay,
    heapAfterReplayMb: heapUsedMb(),
    runs,
    interpretation: "replay times and heap deltas describe one parse of the retained bounded artifacts; provider-reported request fields describe the model context while local artifact bytes describe storage only — bytes are never billed tokens, and historical v2 evidence never satisfies current v3 completeness",
  };
  const outPath = join(REPORT_DIR, `continuity-replay-check-${attemptId.slice(0, 19)}.json`);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.error(`report: ${outPath}`);
}

await main();
