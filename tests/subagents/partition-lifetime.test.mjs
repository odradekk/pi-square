import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createChildAnchoredReadTool } = await load("../../src/anchored-edit/child-read.ts");
const { createChildAnchoredReplaceTool } = await load("../../src/anchored-edit/child-edit.ts");
const { loadAnchoredHashStore, PARENT_OWNER } = await load("../../src/anchored-edit/workspace-support.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
const { getServed, recordServed } = await load("../../src/anchored-edit/served.ts");
const {
  listOwnerPartitions,
  shutdownHashStore,
} = await load("../../src/anchored-edit/hash-store.ts");
const {
  MAX_RETAINED_CHILD_PARTITIONS,
  dropChildPartition,
  pruneMissingForAllOwners,
  reconcileChildPartitions,
} = await load("../../src/anchored-edit/partitions.ts");

const CHILD_ONE = "subagent_00000000-0000-4000-8000-000000000001";
const CHILD_TWO = "subagent_00000000-0000-4000-8000-000000000002";

function textOf(content) {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function readRows(content) {
  return textOf(content).split("\n").flatMap((line) => {
    const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
    return match ? [{ hash: match[1], text: match[2] }] : [];
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function childOwners() {
  const store = await openStore(PARENT_OWNER);
  try {
    return listOwnerPartitions(store)
      .filter((p) => p.owner !== PARENT_OWNER)
      .map((p) => p.owner);
  } finally {
    store.release();
  }
}

async function ownerHasServed(owner, path) {
  const store = await openStore(owner);
  try {
    return Boolean(getServed(store, path));
  } finally {
    store.release();
  }
}

const root = mkdtempSync(join(tmpdir(), "pi-square-partition-lifetime-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const sessionDir = join(workspace, ".test-session");
const storeDir = anchoredStoreDir(sessionDir, workspace);
const ctx = { cwd: workspace };
const openStore = (owner) => loadAnchoredHashStore(storeDir, owner);
const source = join(workspace, "source.txt");

try {
  writeFileSync(source, "alpha\nbeta\ngamma\ndelta\n");

  // A resumed child keeps its served records under its own owner, so it can
  // edit a range it was shown before it became inactive without reading again:
  // reconciliation with the child retained never evicts it.
  const childRead = createChildAnchoredReadTool(workspace, CHILD_ONE, sessionDir);
  const firstRead = await childRead.execute("read", { path: "source.txt" }, undefined, undefined, ctx);
  const anchors = readRows(firstRead.content).map((row) => row.hash);
  const replace = createChildAnchoredReplaceTool(workspace, CHILD_ONE, sessionDir);
  const replaceResult = await replace.execute(
    "replace",
    { path: "source.txt", remove_from: anchors[1], remove_to: anchors[2], replacement_text: "BETA2" },
    undefined, undefined, ctx,
  );
  assert.equal(replaceResult.details?.status, undefined, "the child replace succeeds on the range it was shown");
  assert.equal(readFileSync(source, "utf8"), "alpha\nBETA2\ndelta\n", "the edit changed the file");

  // Mark the child inactive and reconcile with its artifacts retained: the
  // partition must survive so resume finds its records.
  const retained = await reconcileChildPartitions(workspace, new Set([CHILD_ONE]), sessionDir);
  assert.deepEqual(retained.evicted, [], "a retained child partition is never evicted");
  assert.ok(await ownerHasServed(CHILD_ONE, source), "the served record survives reconciliation");

  // Dropping one child's records leaves the parent's and other children's
  // records intact.
  const secondRead = createChildAnchoredReadTool(workspace, CHILD_TWO, sessionDir);
  await secondRead.execute("read-two", { path: "source.txt" }, undefined, undefined, ctx);
  const parentRead = createChildAnchoredReadTool(workspace, PARENT_OWNER, sessionDir);
  await parentRead.execute("read-parent", { path: "source.txt" }, undefined, undefined, ctx);
  await dropChildPartition(workspace, CHILD_ONE, sessionDir);
  assert.ok(!(await ownerHasServed(CHILD_ONE, source)), "the dropped child's served record is gone");
  assert.ok(await ownerHasServed(CHILD_TWO, source), "another child's records are intact");
  assert.ok(await ownerHasServed(PARENT_OWNER, source), "the parent's records are intact");

  // Reconcile against a retained set that excludes an existing partition drops
  // it: records go with their artifacts even when the drop did not run at
  // deletion time.
  const reconciledEmpty = await reconcileChildPartitions(workspace, new Set([CHILD_ONE]), sessionDir);
  assert.ok(reconciledEmpty.evicted.includes(CHILD_TWO), "an orphan partition (artifacts gone) is evicted on reconcile");
  assert.ok(!(await ownerHasServed(CHILD_TWO, source)), "the orphan's records are dropped with its artifacts");

  // A documented bound limits retained child partitions, with
  // least-recently-active eviction order (#187 removed the revert-record
  // retention exception: every partition is equally evictable).
  const file = join(workspace, "bound.txt");
  writeFileSync(file, "one\n");
  const seeds = [];
  for (let i = 0; i < MAX_RETAINED_CHILD_PARTITIONS + 4; i++) {
    const owner = `subagent_00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const store = await openStore(owner);
    try {
      store.upsertSnapshot(file, "checksum", 1, [`AAA`]);
      recordServed(store, file, ["AAA"]);
    } finally {
      store.release();
    }
    seeds.push(owner);
    await sleep(3);
  }
  const reconciledBound = await reconcileChildPartitions(workspace, new Set(seeds), sessionDir);
  const remaining = await childOwners();
  assert.equal(remaining.length, MAX_RETAINED_CHILD_PARTITIONS, "the bound limits retained child partitions");
  assert.deepEqual(
    reconciledBound.evicted.slice().sort(),
    seeds.slice(0, 4).sort(),
    "the least-recently-active partitions are evicted first",
  );

  // Records for files that no longer exist are pruned for every owner, not
  // only the parent.
  const alive = join(workspace, "alive.txt");
  writeFileSync(alive, "alive\n");
  for (const owner of [PARENT_OWNER, CHILD_ONE]) {
    const store = await openStore(owner);
    try {
      store.upsertSnapshot(alive, "checksum-alive", 1, ["BBB"]);
      recordServed(store, alive, ["BBB"]);
      store.upsertSnapshot(join(workspace, "gone.txt"), "checksum-gone", 1, ["CCC"]);
      recordServed(store, join(workspace, "gone.txt"), ["CCC"]);
    } finally {
      store.release();
    }
  }
  await pruneMissingForAllOwners(workspace, sessionDir);
  for (const owner of [PARENT_OWNER, CHILD_ONE]) {
    const store = await openStore(owner);
    try {
      const served = getServed(store, alive);
      const goneServed = getServed(store, join(workspace, "gone.txt"));
      assert.ok(served && served.has("BBB"), `existing-file records survive pruning for ${owner}`);
      assert.equal(goneServed, undefined, `missing-file records are pruned for ${owner}`);
    } finally {
      store.release();
    }
  }

  // Deleting a child's history drops its anchor-store partition with its
  // artifacts (best-effort drop at deletion time; the session-start
  // reconciliation in subagents guarantees it if the drop cannot complete).
  const deleteAgentDir = join(root, "delete-agent");
  mkdirSync(deleteAgentDir, { recursive: true });
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = deleteAgentDir;
  try {
    const { createSubagentId, ensureArtifactsDir, initializeSessionFile, writeRunState, recordParentSessionRun, deleteParentSessionRun, artifactsDirFor } =
      await load("../../src/subagents/artifacts.ts");
    const delId = createSubagentId();
    const seedStore = await openStore(delId);
    try {
      recordServed(seedStore, source, ["DDD"]);
    } finally {
      seedStore.release();
    }
    assert.ok(await ownerHasServed(delId, source), "the child partition exists before deletion");

    const dir = ensureArtifactsDir(delId);
    const sessionFile = join(dir, "session.jsonl");
    const delSessionId = "019f0000-0000-7000-8000-0000000000aa";
    const runDetails = {
      version: 3,
      id: delId,
      mode: "fg",
      artifactsDir: dir,
      sessionFile,
      sessionId: delSessionId,
      originParentSessionId: "parent-session",
      lastParentSessionId: "parent-session",
      promptSnapshot: {
        version: 2,
        system: "s",
        instructions: "i",
        output: "o",
        manifest: {
          contractVersion: 2,
          governanceVersion: 1,
          inheritParentSystem: true,
          effectiveSystemHash: "h",
          governanceHash: "g",
          contextCount: 0,
          fieldSources: {},
          sourceFiles: [],
        },
      },
      phase: "done",
      task: "task",
      cwd: workspace,
      startedAt: Date.now(),
      finalText: "t",
      retries: 0,
      toolErrors: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      timeline: [],
    };
    initializeSessionFile({
      id: delId,
      artifactsDir: dir,
      sessionFile,
      header: { type: "session", version: 3, id: delSessionId, timestamp: new Date(0).toISOString(), cwd: workspace },
    });
    writeRunState(dir, runDetails);
    recordParentSessionRun("parent-session", delId);

    deleteParentSessionRun("parent-session", delId, sessionDir);
    assert.equal(existsSync(dir), false, "the child's artifacts are dropped");
    let partitionDropped = false;
    for (let i = 0; i < 100 && !partitionDropped; i++) {
      await sleep(10);
      partitionDropped = !(await ownerHasServed(delId, source));
    }
    assert.ok(partitionDropped, "deleting child history drops its anchor-store partition with it");
    assert.equal(existsSync(artifactsDirFor(delId)), false, "the deleted child's artifacts remain gone");
  } finally {
    process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  }

  console.log("child partition lifetime tests: OK");
} finally {
  shutdownHashStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
