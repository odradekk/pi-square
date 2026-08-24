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

function makeSessionRoot() {
  const root = mkdtempSync(join(tmpdir(), `shadow-inbox-${process.pid}-`));
  const sessionDir = join(root, "session-a");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "session.jsonl"), "{}\n", "utf8");
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

// ── AC9: orphan partition reconciliation ─────────────────────────────

{
  const root = mkdtempSync(join(tmpdir(), `shadow-reconcile-${process.pid}-`));
  const live = join(root, "live-session");
  const orphan = join(root, "orphan-session");
  const empty = join(root, "empty-session");
  mkdirSync(live, { recursive: true });
  mkdirSync(orphan, { recursive: true });
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(live, "session.jsonl"), "{}\n", "utf8");
  // The orphan lost its session file; the empty session never had one.
  mkdirSync(join(orphan, SHADOW_PARTITION_DIR, "gone", "results"), { recursive: true });
  writeFileSync(join(orphan, SHADOW_PARTITION_DIR, "gone", "index.json"), "{}", "utf8");
  mkdirSync(join(empty, SHADOW_PARTITION_DIR), { recursive: true });

  const outcome = reconcileShadowPartitions(live);
  assert.ok(outcome.removed.includes(join(orphan, SHADOW_PARTITION_DIR, "gone")), "orphan partitions are removed");
  assert.ok(!existsSync(join(orphan, SHADOW_PARTITION_DIR, "gone")), "the orphan partition is gone");
  assert.ok(!existsSync(join(empty, SHADOW_PARTITION_DIR)), "empty-session partitions are removed");
  assert.ok(existsSync(join(live, "session.jsonl")), "the live session is untouched");
}

{
  // A missing sessions root reconciles as a no-op.
  const outcome = reconcileShadowPartitions(join(tmpdir(), `missing-${Date.now()}`));
  assert.deepEqual(outcome.removed, []);
}

// ── AC8: debug histories ─────────────────────────────────────────────

{
  // A debug run stores sanitized native session JSONL plus bounded metadata.
  const { sessionDir } = makeSessionRoot();
  const partition = shadowPartitionPath(sessionDir, "sess-1");
  const runDir = shadowDebugRunDir(sessionDir, "sess-1", "run-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "session.jsonl"), [
    JSON.stringify({ type: "session", id: "child-1" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "investigate" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning with api_key=sk-live-abc123" },
      { type: "text", text: "I will use bearer ghp_secret123456 to check." },
    ] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "password=hunter2 leaked" }], isError: false } }),
  ].join("\n"), "utf8");

  finalizeShadowDebugRun(sessionDir, "sess-1", {
    runId: "run-1", shadowId: "architecture-lens", startedAt: 1_000, endedAt: 2_000, phase: "submitted",
  });

  const sanitized = readFileSync(join(runDir, "session.jsonl"), "utf8");
  assert.ok(!sanitized.includes("sk-live-abc123"), "credentials are scrubbed from debug logs");
  assert.ok(sanitized.includes("api_key=[REDACTED]"), "the shared redaction pattern is applied");
  assert.ok(!sanitized.includes("ghp_secret123456"), "bearer tokens are scrubbed");
  assert.ok(!sanitized.includes("hunter2"), "password assignments are scrubbed");
  assert.ok(sanitized.includes("architecture-lens") === false, "the session log carries no metadata duplicates");

  const runs = listShadowDebugRuns(sessionDir, "sess-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "run-1");
  assert.equal(runs[0].shadowId, "architecture-lens");
  assert.equal(runs[0].phase, "submitted");
  assert.ok(runs[0].bytes > 0);
  assert.ok(existsSync(join(partition, "debug", "index.json")));
}

{
  // Retention: at most 20 logs per Shadow and 128 MiB total, oldest first.
  const { sessionDir } = makeSessionRoot();
  assert.equal(SHADOW_DEBUG_MAX_LOGS_PER_SHADOW, 20);
  for (let index = 0; index < 23; index += 1) {
    const runDir = shadowDebugRunDir(sessionDir, "sess-1", `run-${String(index).padStart(2, "0")}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "session.jsonl"), JSON.stringify({ type: "message", n: index }), "utf8");
    finalizeShadowDebugRun(sessionDir, "sess-1", {
      runId: `run-${String(index).padStart(2, "0")}`, shadowId: "lens", startedAt: index, endedAt: index + 1, phase: "silent",
    });
  }
  // finalizeShadowDebugRun enforces retention itself; an explicit sweep is
  // then a no-op and the removal is observable on disk and in the index.
  const outcome = sweepShadowDebugRetention(sessionDir, "sess-1");
  const runs = listShadowDebugRuns(sessionDir, "sess-1");
  assert.equal(runs.length, 20, "the per-shadow cap holds");
  assert.ok(!runs.some((run) => run.runId === "run-00"), "the oldest logs are swept first");
  assert.ok(!existsSync(shadowDebugRunDir(sessionDir, "sess-1", "run-00")), "swept logs are removed from disk");
  assert.ok(runs.some((run) => run.runId === "run-22"), "the newest logs survive");
  assert.deepEqual(outcome.removed, [], "an already-retained partition sweeps nothing");
}

{
  // Byte-bound sweeping removes oldest logs until the total fits.
  const { sessionDir } = makeSessionRoot();
  for (let index = 0; index < 3; index += 1) {
    const runDir = shadowDebugRunDir(sessionDir, "sess-1", `run-${index}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "session.jsonl"),
      [JSON.stringify({ type: "message", pad: "x".repeat(2_000) }), JSON.stringify({ type: "message", pad: "y".repeat(2_000) })].join("\n") + "\n",
      "utf8",
    );
    finalizeShadowDebugRun(sessionDir, "sess-1", {
      runId: `run-${index}`, shadowId: `lens-${index}`, startedAt: index, endedAt: index + 1, phase: "silent",
    });
  }
  const outcome = sweepShadowDebugRetention(sessionDir, "sess-1", { maxTotalBytes: 8_192 });
  const runs = listShadowDebugRuns(sessionDir, "sess-1");
  assert.ok(runs.length < 3, "byte pressure removes logs");
  assert.ok(!existsSync(shadowDebugRunDir(sessionDir, "sess-1", "run-0")), "the oldest byte-heavy log is removed");
  assert.ok(outcome.removed.includes("run-0"));
}

{
  // A missing debug partition is a bounded no-op.
  assert.deepEqual(sweepShadowDebugRetention(join(tmpdir(), `missing-debug-${Date.now()}`), "none"), { removed: [] });
  assert.deepEqual(listShadowDebugRuns(join(tmpdir(), `missing-debug-${Date.now()}`), "none"), []);
}

console.log("shadow-minds inbox-store tests: OK");
