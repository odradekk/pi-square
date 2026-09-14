import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

export const NATIVE_REPLAY_SCHEMA = "pi-square.context-memory/native-replay/1";
export const MAX_NATIVE_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_BRANCH_ENTRIES = 4096;
const jiti = createJiti(import.meta.url);
const { deriveCurrentMemory } = jiti("../../../src/context-memory/derive.ts");

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
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
  if (expectedLeafId === null) { manager.resetLeaf(); return true; }
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
