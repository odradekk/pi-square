import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const packageRoot = resolve(import.meta.dirname, "..", "..");

const {
  SHADOW_PARTITION_DIR,
  createPersistentShadowInbox,
  shadowPartitionPath,
  reconcileShadowPartitions,
  SHADOW_DEBUG_MAX_LOGS_PER_SHADOW,
  shadowDebugRunDir,
  finalizeShadowDebugRun,
  sweepShadowDebugRetention,
  listShadowDebugRuns,
} = await load(join(packageRoot, "src", "shadow-minds", "inbox-store.ts"));

const roots = [];

/** Pi 0.84.2 layout: one shared per-cwd directory of flat session files. */
function makeSessionRoot(sessionId = "sess-1") {
  const root = mkdtempSync(join(tmpdir(), `shadow-inbox-${process.pid}-`));
  roots.push(root);
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), "{}\n", "utf8");
  return { root, sessionDir };
}

function addResult(inbox, index, overrides = {}) {
  return inbox.add({
    shadowId: "session-synthesizer",
    shadowName: "Session synthesizer",
    payload: { summary: `finding ${index}` },
    createdAt: 1_000 + index,
    ...overrides,
  });
}

// ── AC1/AC2: partition layout, atomic versioned entities, bounded index ──

{
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1", now: () => 5_000 });
  const entity = addResult(inbox, 1, { definitionHash: "abc123", schemaHash: "def456", configuredDelivery: "notify" });

  const partition = shadowPartitionPath(sessionDir, "sess-1");
  assert.ok(existsSync(partition), "the partition is created under the session directory");
  assert.ok(partition.includes(SHADOW_PARTITION_DIR), "the partition directory is hidden");
  const entityPath = join(partition, "results", `${entity.id}.json`);
  assert.ok(existsSync(entityPath), "each result is one JSON file");
  const onDisk = JSON.parse(readFileSync(entityPath, "utf8"));
  assert.equal(onDisk.version, 1, "entities are versioned");
  assert.equal(onDisk.id, entity.id);
  assert.equal(onDisk.delivery, "notified");
  assert.equal(onDisk.attention, "unread");
  assert.equal(onDisk.definitionHash, "abc123");
  assert.equal(onDisk.schemaHash, "def456");
  assert.equal(onDisk.configuredDelivery, "notify");
  assert.ok(!existsSync(join(partition, "results", `${entity.id}.json.tmp`)), "no temp files remain");

  const index = JSON.parse(readFileSync(join(partition, "index.json"), "utf8"));
  assert.equal(index.version, 1);
  assert.equal(index.results.length, 1);
  assert.equal(index.results[0].id, entity.id);
  assert.ok(index.results[0].summary.length <= 160, "the index carries only bounded summary metadata");
  assert.ok(!("payload" in index.results[0]), "the index never duplicates payloads");
}

{
  // Results survive reopening: a fresh store over the same partition loads entities.
  const { sessionDir } = makeSessionRoot();
  const first = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const entity = addResult(first, 1);
  first.markRead(entity.id);

  const second = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const reloaded = second.list();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, entity.id);
  assert.equal(reloaded[0].attention, "read", "attention transitions persist");
  assert.deepEqual(reloaded[0].payload, { summary: "finding 1" });
}

{
  // Sessions are keyed: a different session ID gets its own partition.
  const { sessionDir } = makeSessionRoot();
  const one = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  addResult(one, 1);
  const two = createPersistentShadowInbox({ sessionDir, sessionId: "sess-2" });
  assert.equal(two.list().length, 0, "partitions are keyed by session ID");
}

// ── AC4: distinct atomic transitions ─────────────────────────────────

{
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const a = addResult(inbox, 1);
  const b = addResult(inbox, 2);

  // send: notified -> pending; a second send is refused.
  assert.equal(inbox.send(a.id), true);
  assert.equal(inbox.send(a.id), false);
  assert.equal(inbox.list().find((entry) => entry.id === a.id).delivery, "pending");

  // markRead / dismiss / delete stay distinct and atomic.
  assert.equal(inbox.markRead(b.id), true);
  assert.equal(inbox.dismiss(b.id), true, "dismiss overrides read attention");
  assert.equal(inbox.list().find((entry) => entry.id === b.id).attention, "dismissed");
  assert.equal(inbox.delete(b.id), true);
  assert.equal(inbox.delete(b.id), false);
  assert.equal(inbox.list().find((entry) => entry.id === b.id), undefined);
  assert.ok(!existsSync(join(shadowPartitionPath(sessionDir, "sess-1"), "results", `${b.id}.json`)));

  // Unknown ids are refused everywhere.
  assert.equal(inbox.send("shr-missing"), false);
  assert.equal(inbox.markRead("shr-missing"), false);
}

// ── AC6: retention bounds and eviction order ────────────────────────

{
  // Count bound: oldest read/dismissed evicts before unread notified.
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1", maxResults: 3 });
  const unreadOld = addResult(inbox, 1);
  const readOld = addResult(inbox, 2);
  inbox.markRead(readOld.id);
  const dismissedMid = addResult(inbox, 3);
  inbox.dismiss(dismissedMid.id);
  const unreadNew = addResult(inbox, 4);
  assert.equal(inbox.list().length, 3, "the count bound holds");
  const ids = inbox.list().map((entry) => entry.id);
  assert.ok(!ids.includes(readOld.id), "the oldest read entry is evicted first");
  assert.ok(ids.includes(unreadOld.id) && ids.includes(unreadNew.id), "unread notified entries are retained");

  const events = inbox.events();
  assert.ok(events.some((event) => event.kind === "evicted" && event.id === readOld.id), "evictions are recorded visibly");
}

{
  // Byte bound: oversized totals evict resolved entries oldest first.
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1", maxBytes: 2_000 });
  for (let index = 0; index < 6; index += 1) {
    const entity = addResult(inbox, index, { payload: { summary: `x`.repeat(600) } });
    if (index < 4) inbox.markRead(entity.id);
  }
  const partition = shadowPartitionPath(sessionDir, "sess-1");
  const resultFiles = readdirSync(join(partition, "results"));
  let total = 0;
  for (const file of resultFiles) total += statSync(join(partition, "results", file)).size;
  assert.ok(total <= 2_000 + 1_600, `bytes stay near the bound (${total})`);
  const retained = inbox.list();
  assert.ok(retained.every((entry) => entry.attention === "unread" || entry.createdAt >= 1_004), "byte eviction prefers resolved oldest entries");
}

{
  // Package hard caps are never exceeded through configured bounds.
  const { sessionDir } = makeSessionRoot();
  const inflated = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1", maxResults: 10_000, maxBytes: Number.MAX_SAFE_INTEGER });
  addResult(inflated, 1);
  const index = JSON.parse(readFileSync(join(shadowPartitionPath(sessionDir, "sess-1"), "index.json"), "utf8"));
  assert.ok(index.maxResults <= 100, "the result cap is hard-capped at 100");
}

// ── AC7: quarantine and index rebuild ────────────────────────────────

{
  // A corrupt result file is quarantined and never surfaces.
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const good = addResult(inbox, 1);
  const bad = addResult(inbox, 2);
  inbox.delete(good.id);
  const badPath = join(shadowPartitionPath(sessionDir, "sess-1"), "results", `${bad.id}.json`);
  writeFileSync(badPath, "{ not json", "utf8");

  const reopened = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  assert.equal(reopened.list().length, 0, "corrupt entities never load");
  const quarantineDir = join(shadowPartitionPath(sessionDir, "sess-1"), "quarantine");
  assert.ok(existsSync(quarantineDir), "corrupt files are quarantined");
  assert.ok(readdirSync(quarantineDir).length >= 1);
  assert.ok(reopened.diagnostics().some((line) => line.includes(bad.id) || line.includes("quarantin")), "quarantine is diagnosed");
}

{
  // A tampered entity (wrong shape) is quarantined too, never returned.
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const entity = addResult(inbox, 1);
  const entityPath = join(shadowPartitionPath(sessionDir, "sess-1"), "results", `${entity.id}.json`);
  const tampered = JSON.parse(readFileSync(entityPath, "utf8"));
  tampered.payload = { injected: true };
  tampered.summary = "tampered " + "z".repeat(5_000);
  writeFileSync(entityPath, JSON.stringify(tampered), "utf8");

  const reopened = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  assert.equal(reopened.list().length, 0, "tampered summaries do not surface unvalidated");
}

{
  // A corrupt index is rebuilt from a bounded validated scan.
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const one = addResult(inbox, 1);
  const two = addResult(inbox, 2);
  writeFileSync(join(shadowPartitionPath(sessionDir, "sess-1"), "index.json"), "{ broken", "utf8");

  const reopened = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const ids = reopened.list().map((entry) => entry.id).sort();
  assert.deepEqual(ids, [one.id, two.id].sort(), "a corrupt index rebuilds from valid entities");
  assert.ok(reopened.diagnostics().some((line) => line.includes("index")), "the rebuild is diagnosed");
}

{
  // An oversized debug log is dropped rather than retained unsanitized.
  const root = mkdtempSync(join(tmpdir(), `shadow-debugdrop-${process.pid}-`));
  const runDir = shadowDebugRunDir(root, "sess-1", "run-big");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "session.jsonl"),
    [JSON.stringify({ type: "message", pad: "x".repeat(2 * 1024 * 1024) }), JSON.stringify({ type: "message", pad: "y".repeat(2 * 1024 * 1024) }), JSON.stringify({ type: "message", pad: "z".repeat(2 * 1024 * 1024) }), JSON.stringify({ type: "message", pad: "w".repeat(2 * 1024 * 1024) }), JSON.stringify({ type: "message", pad: "v".repeat(2 * 1024 * 1024) })].join("\n"),
    "utf8",
  );
  finalizeShadowDebugRun(root, "sess-1", { runId: "run-big", shadowId: "lens", startedAt: 1, endedAt: 2, phase: "silent" });
  assert.ok(!existsSync(runDir), "an unsanitizable log is dropped, never retained");
  assert.deepEqual(listShadowDebugRuns(root, "sess-1").filter((run) => run.runId === "run-big"), []);
}

{
  // A tampered oversized payload quarantines instead of surfacing.
  const { sessionDir } = makeSessionRoot();
  const inbox = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const entity = addResult(inbox, 1);
  const entityPath = join(shadowPartitionPath(sessionDir, "sess-1"), "results", `${entity.id}.json`);
  const tampered = JSON.parse(readFileSync(entityPath, "utf8"));
  tampered.payload = { blob: "p".repeat(30_000) };
  writeFileSync(entityPath, JSON.stringify(tampered), "utf8");

  const reopened = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  assert.equal(reopened.list().length, 0, "oversized payloads never pass load validation");
  assert.ok(existsSync(join(shadowPartitionPath(sessionDir, "sess-1"), "quarantine")));
}

// ── AC9: orphan partition reconciliation (real flat layout) ─────────

{
  // A partition whose flat session file is gone is an orphan; the live
  // session's partition (matching `<timestamp>_<id>.jsonl`) survives.
  const root = mkdtempSync(join(tmpdir(), `shadow-reconcile-${process.pid}-`));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "2026-08-24T00-00-00-000Z_live-id.jsonl"), "{}\n", "utf8");
  const livePartition = join(sessionsDir, SHADOW_PARTITION_DIR, "live-id");
  const orphanPartition = join(sessionsDir, SHADOW_PARTITION_DIR, "gone-id");
  mkdirSync(join(livePartition, "results"), { recursive: true });
  mkdirSync(join(orphanPartition, "results"), { recursive: true });

  const outcome = reconcileShadowPartitions(sessionsDir);
  assert.deepEqual(outcome.removed, [orphanPartition], "only orphan partitions are removed");
  assert.ok(existsSync(livePartition), "the live session's partition survives");
  assert.ok(!existsSync(orphanPartition), "the orphan partition is gone");
}

{
  // A bare `<sessionId>.jsonl` (explicitly named session file) also counts.
  const root = mkdtempSync(join(tmpdir(), `shadow-reconcile-2-${process.pid}-`));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "explicit-id.jsonl"), "{}\n", "utf8");
  const partition = join(sessionsDir, SHADOW_PARTITION_DIR, "explicit-id");
  mkdirSync(partition, { recursive: true });
  assert.deepEqual(reconcileShadowPartitions(sessionsDir).removed, []);
  assert.ok(existsSync(partition));
}

{
  // The keep guard is defensive: the named partition survives even without
  // a matching file (the live session is never its own orphan).
  const root = mkdtempSync(join(tmpdir(), `shadow-reconcile-3-${process.pid}-`));
  const sessionsDir = join(root, "sessions");
  const partition = join(sessionsDir, SHADOW_PARTITION_DIR, "current");
  mkdirSync(partition, { recursive: true });
  assert.deepEqual(reconcileShadowPartitions(sessionsDir, "current").removed, []);
  assert.ok(existsSync(partition));
}

{
  // A missing sessions root reconciles as a no-op.
  assert.deepEqual(reconcileShadowPartitions(join(tmpdir(), `missing-${Date.now()}`)), { removed: [] });
}

{
  // A persisted reference mark survives reopening: the restored entity
  // reports referenced and markReferenced refuses to repeat it.
  const { sessionDir } = makeSessionRoot();
  const first = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  const entity = addResult(first, 1);
  assert.equal(first.markReferenced(entity.id), true);
  assert.equal(first.markReferenced(entity.id), false, "the mark is idempotent");
  const reopened = createPersistentShadowInbox({ sessionDir, sessionId: "sess-1" });
  assert.equal(reopened.list()[0].referenced, true, "the mark survives reopening");
  assert.equal(reopened.markReferenced(entity.id), false);
}

{
  // Crash-residue debug directories outside the index are swept away.
  const { sessionDir } = makeSessionRoot();
  const residue = shadowDebugRunDir(sessionDir, "sess-1", "run-crashed");
  mkdirSync(residue, { recursive: true });
  writeFileSync(join(residue, "session.jsonl"), JSON.stringify({ type: "message", text: "token=sk-unchecked" }), "utf8");
  const outcome = sweepShadowDebugRetention(sessionDir, "sess-1");
  assert.ok(!existsSync(residue), "unsanitized crash residue is removed");
  assert.ok(outcome.removed.includes("run-crashed"));
}

for (const root of roots) rmSync(root, { recursive: true, force: true });

console.log("shadow-minds inbox-store tests: OK");
