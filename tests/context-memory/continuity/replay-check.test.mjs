import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { MAX_NATIVE_SESSION_BYTES, NATIVE_REPLAY_SCHEMA, measureNativeSessionReplay, safeNativeReplay } from "./replay-check.mjs";

const jiti = createJiti(import.meta.url);
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG } = jiti("../../../src/context-memory/format.ts");
const root = mkdtempSync(join(tmpdir(), "pi-square-native-replay-"));
try {
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const current = SessionManager.create(root, sessions);
  const first = current.appendMessage({ role: "user", content: "private replay body", timestamp: 1 });
  current.appendMessage({ role: "assistant", content: [{ type: "text", text: "private answer", optionalProviderField: undefined }], api: "test", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  current.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, { format: MEMORY_STATE_FORMAT_TAG, blocks: [{ endEntryId: first, markdown: "derived private memory", retainedEntryIds: [] }] });
  const result = measureNativeSessionReplay({ sessionPath: current.getSessionFile(), currentSessionManager: current });
  assert.equal(result.schema, NATIVE_REPLAY_SCHEMA); assert.equal(result.branchEquivalent, true); assert.equal(result.memoryEquivalent, true);
  assert.equal(result.memory.kind, "valid"); assert.equal(result.memory.blocks, 1); assert.equal(result.diskUnchanged, true); assert.equal(result.directoryEntriesUnchanged, true);
  assert.ok(result.persistedBytes > 0); assert.ok(result.branchEntries >= 3); assert.match(result.branchSha256, /^[0-9a-f]{64}$/);
  const rendered = JSON.stringify(result); assert.doesNotMatch(rendered, /private replay body|private answer|derived private memory/); assert.ok(!rendered.includes(root));
  assert.doesNotMatch(JSON.stringify(safeNativeReplay({ ...result, injectedBody: "private replay body", memory: { ...result.memory, injectedBody: "derived private memory" } })), /private replay body|derived private memory/);
  assert.equal(safeNativeReplay({ ...result, diskSha256: "private replay body" }).diskSha256, null);
  const reopened = SessionManager.open(current.getSessionFile(), sessions);
  assert.deepEqual(reopened.getBranch().map(({ id, type }) => ({ id, type })), current.getBranch().map(({ id, type }) => ({ id, type })));

  // Native branching only moves the in-memory leaf. Reopening a journal whose
  // abandoned sibling was the final append therefore needs to restore the
  // current retained leaf before replay equivalence is measured.
  const retained = current.getLeafId();
  current.appendMessage({ role: "user", content: "abandoned private prompt", timestamp: 3 });
  current.appendMessage({ role: "assistant", content: [{ type: "text", text: "abandoned private error" }], api: "test", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", timestamp: 4 });
  current.branch(retained);
  const branched = measureNativeSessionReplay({ sessionPath: current.getSessionFile(), currentSessionManager: current });
  assert.equal(branched.branchEquivalent, true);
  assert.equal(branched.memoryEquivalent, true);
  assert.equal(branched.diskUnchanged, true);
  const journal = readFileSync(current.getSessionFile(), "utf8");
  const changedSource = journal.replace("private replay body", "changed replay body");
  assert.notEqual(changedSource, journal);
  writeFileSync(current.getSessionFile(), changedSource);
  assert.equal(measureNativeSessionReplay({ sessionPath: current.getSessionFile(), currentSessionManager: current }).branchEquivalent, false);
  const withoutState = journal.split("\n").filter((line) => !line.includes(MEMORY_STATE_CUSTOM_TYPE)).join("\n");
  writeFileSync(current.getSessionFile(), withoutState);
  const missingState = measureNativeSessionReplay({ sessionPath: current.getSessionFile(), currentSessionManager: current });
  assert.equal(missingState.branchEquivalent, false);
  assert.equal(missingState.memoryEquivalent, false);
  writeFileSync(current.getSessionFile(), journal);
  assert.equal(readFileSync(current.getSessionFile(), "utf8"), journal);
  const oversized = join(root, "oversized.jsonl"); writeFileSync(oversized, Buffer.alloc(MAX_NATIVE_SESSION_BYTES + 1));
  assert.throws(() => measureNativeSessionReplay({ sessionPath: oversized }), /exceeds 8388608 bytes/); assert.equal(readFileSync(oversized).byteLength, MAX_NATIVE_SESSION_BYTES + 1);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("context-memory native replay checks passed");
