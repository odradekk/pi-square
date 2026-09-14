import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

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

export const NATIVE_REPLAY_SCHEMA = "pi-square.context-memory/native-replay/1";
export const MAX_NATIVE_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_BRANCH_ENTRIES = 4096;
const jiti = createJiti(import.meta.url);
const { deriveCurrentMemory } = jiti("../../../src/context-memory/derive.ts");

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
// Pi persists JSONL: optional undefined properties on live provider messages
// have no journal representation. Compare the complete JSON values, retaining
// all text and Markdown, rather than JavaScript-only property presence or hashes.
function persistedValue(value) { return JSON.parse(JSON.stringify(value)); }

function branchIdentity(branch) {
  if (branch.length > MAX_NATIVE_BRANCH_ENTRIES) throw new Error(`native replay branch exceeds ${MAX_NATIVE_BRANCH_ENTRIES} entries`);
  return { entries: branch.length, sha256: sha256(JSON.stringify(branch)) };
}
function memoryIdentity(memory) {
  if (memory.kind !== "valid") return { kind: memory.kind, carrier: null, blocks: 0, sha256: null };
  return { kind: "valid", carrier: memory.carrier, blocks: memory.blocks.length, sha256: sha256(JSON.stringify({
    stateEntryId: memory.stateEntryId, compactionId: memory.compactionId ?? null,
    blocks: memory.blocks.map((block) => ({ endEntryId: block.endEntryId, markdown: sha256(block.markdown), retainedEntryIds: block.retainedEntryIds, sourceEntryIds: block.sourceEntries.map((entry) => entry.id) })),
  })) };
}
function restoreExpectedLeaf(manager, expectedLeafId) {
  if (expectedLeafId === null) {
    manager.resetLeaf();
    return true;
  }
  if (!manager.getEntry(expectedLeafId)) return false;
  manager.branch(expectedLeafId);
  return manager.getLeafId() === expectedLeafId;
}

/** Measure Pi's real native replay after rejecting unbounded input before Pi parses it. */
export function measureNativeSessionReplay({ sessionPath, currentSessionManager } = {}) {
  if (typeof sessionPath !== "string" || sessionPath.length === 0) throw new Error("native replay requires a session path");
  const before = lstatSync(sessionPath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("native replay requires a regular session file");
  if (before.size > MAX_NATIVE_SESSION_BYTES) throw new Error(`native replay session exceeds ${MAX_NATIVE_SESSION_BYTES} bytes`);
  const diskSha256 = sha256(readFileSync(sessionPath));
  const directoryEntriesBefore = readdirSync(dirname(sessionPath)).sort();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const expectedLeafId = currentSessionManager ? currentSessionManager.getLeafId() : null;
  const replayed = SessionManager.open(sessionPath, dirname(sessionPath));
  const restoredExpectedLeaf = currentSessionManager ? restoreExpectedLeaf(replayed, expectedLeafId) : true;
  const replayBranchValue = replayed.getBranch();
  const replayBranch = branchIdentity(replayBranchValue);
  const replayMemoryValue = deriveCurrentMemory(replayed);
  const replayMemory = memoryIdentity(replayMemoryValue);
  const replayElapsedMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  const currentBranch = currentSessionManager ? currentSessionManager.getBranch() : null;
  if (currentBranch) branchIdentity(currentBranch);
  const currentMemory = currentSessionManager ? deriveCurrentMemory(currentSessionManager) : null;
  const after = statSync(sessionPath);
  return {
    schema: NATIVE_REPLAY_SCHEMA, persistedBytes: before.size, replayElapsedMs, heapDeltaBytes,
    branchEntries: replayBranch.entries, branchSha256: replayBranch.sha256, memory: replayMemory,
    branchEquivalent: currentBranch === null ? null : restoredExpectedLeaf && isDeepStrictEqual(persistedValue(currentBranch), persistedValue(replayBranchValue)),
    memoryEquivalent: currentMemory === null ? null : restoredExpectedLeaf && isDeepStrictEqual(persistedValue(currentMemory), persistedValue(replayMemoryValue)),
    diskSha256, diskUnchanged: after.size === before.size && sha256(readFileSync(sessionPath)) === diskSha256,
    directoryEntriesUnchanged: isDeepStrictEqual(readdirSync(dirname(sessionPath)).sort(), directoryEntriesBefore),
  };
}

/** Closed report projection shared by the runner and standalone summary CLI. */
export function safeNativeReplay(value) {
  const number = (item) => Number.isFinite(item) ? item : null;
  const hash = (item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item) ? item : null;
  return value?.schema === NATIVE_REPLAY_SCHEMA ? {
    schema: NATIVE_REPLAY_SCHEMA, persistedBytes: number(value.persistedBytes), replayElapsedMs: number(value.replayElapsedMs), heapDeltaBytes: number(value.heapDeltaBytes),
    branchEntries: number(value.branchEntries), branchSha256: hash(value.branchSha256),
    memory: { kind: ["none", "opaque", "valid"].includes(value.memory?.kind) ? value.memory.kind : null, carrier: ["state", "compaction"].includes(value.memory?.carrier) ? value.memory.carrier : null, blocks: number(value.memory?.blocks), sha256: hash(value.memory?.sha256) },
    branchEquivalent: value.branchEquivalent === true, memoryEquivalent: value.memoryEquivalent === true,
    diskSha256: hash(value.diskSha256), diskUnchanged: value.diskUnchanged === true, directoryEntriesUnchanged: value.directoryEntriesUnchanged === true,
  } : null;
}

function heapUsedMb() {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

async function main() {
  const { parseQualificationReport } = await import("./runner.mjs");
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
    interpretation: "replay times and heap deltas describe one parse of the retained bounded artifacts; nativeReplay separately measures bounded Pi session reopening and branch/Memory equivalence when available; historical reports with no nativeReplay cannot establish that evidence; provider-reported request fields describe the model context while local artifact bytes describe storage only — bytes are never billed tokens, and historical v2 evidence never satisfies current v3 completeness",
  };
  const outPath = join(REPORT_DIR, `continuity-replay-check-${attemptId.slice(0, 19)}.json`);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.error(`report: ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
