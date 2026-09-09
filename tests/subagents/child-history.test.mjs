import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url);
const {
  CHILD_HISTORY_READ_ERROR,
  MAX_LOADED_ITEMS,
  createChildHistory,
  projectSessionEntries,
} = await load(join(packageRoot, "src", "subagents", "child-history.ts"));
const { ensureArtifactsDir, initializeSessionFile, writeRunState } = await load(join(packageRoot, "src", "subagents", "artifacts.ts"));
const { createPromptSnapshot } = await load(join(packageRoot, "tests", "subagents", "lib", "test-helpers.mjs"));

const ID = "subagent_00000000-0000-4000-8000-000000000001";
const SESSION_ID = "019f0000-0000-7000-8000-000000000001";
const OBSERVED_AT = Date.parse("2025-01-01T00:00:05.000Z");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function root() {
  return join(tmpdir(), `pi-square-child-history-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sessionHeader(id = SESSION_ID) {
  return { type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/tmp/project" };
}

function messageEntry(id, message, timestamp = "2025-01-01T00:00:00Z") {
  return { type: "message", id, parentId: null, timestamp, message };
}

/** Writes run.json plus a native session file of raw JSONL lines. */
function writeArtifacts(testRoot, lines, overrides = {}) {
  process.env.PI_AGENT_DIR = testRoot;
  const artifactsDir = ensureArtifactsDir(ID);
  const sessionFile = join(artifactsDir, "session.jsonl");
  initializeSessionFile({ id: ID, artifactsDir, sessionFile, header: sessionHeader() });
  writeFileSync(sessionFile, [sessionHeader(), ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeRunState(artifactsDir, {
    version: 4,
    id: ID,
    operation: "delegate",
    artifactsDir,
    sessionFile,
    sessionId: SESSION_ID,
    originParentSessionId: "parent-1",
    lastParentSessionId: "parent-1",
    promptSnapshot: createPromptSnapshot(),
    phase: "running",
    task: "task",
    cwd: "/tmp/project",
    startedAt: 1,
    finalText: "",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    ...overrides,
  });
  return { artifactsDir, sessionFile };
}

function recursiveListing(directory) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      out.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(directory);
  return out.sort();
}

/** Positioned sync read mirroring the production io seam. */
function realReadRange(file, start, end) {
  if (end <= start) return Buffer.alloc(0);
  const buffer = Buffer.alloc(end - start);
  const descriptor = openSync(file, "r");
  try {
    let read = 0;
    while (read < buffer.length) {
      const bytes = readSync(descriptor, buffer, read, buffer.length - read, start + read);
      if (bytes <= 0) break;
      read += bytes;
    }
    return read === buffer.length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function conversation(count, text = "message") {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(messageEntry(`u${index}`, { role: "user", content: `${text} ${index}`, timestamp: index }, `2025-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`));
    lines.push(messageEntry(`a${index}`, { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], timestamp: index }, `2025-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`));
  }
  return lines;
}

/** Loads every reachable page and returns the final snapshot. */
function loadAll(pager, direction = "older") {
  for (;;) {
    const loaded = direction === "older" ? pager.loadOlder() : pager.loadNewer();
    if (!loaded) return pager.snapshot();
  }
}

test("the initial open loads one bounded tail page, not the whole file", () => {
  const testRoot = root();
  try {
    writeArtifacts(testRoot, conversation(40));
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 800 });
    const snapshot = pager.snapshot();
    assert.equal(snapshot.initialError, undefined);
    assert.equal(snapshot.moreBefore, true, "older history is known to exist");
    const texts = snapshot.items.filter((item) => item.kind === "user").map((item) => item.text);
    assert.ok(texts.length < 40, "only a bounded tail page of entries is loaded");
    assert.match(texts.at(-1), /39/, "the newest entry is loaded first");
    assert.ok(!texts.some((text) => /message 0\b/.test(text)), "the earliest entries are not loaded yet");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("repeated older pages reach the earliest entry in native order", () => {
  const testRoot = root();
  try {
    writeArtifacts(testRoot, conversation(30));
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 600 });
    const snapshot = loadAll(pager);
    assert.equal(snapshot.moreBefore, false, "byte 0 was reached");
    assert.equal(snapshot.pageError, undefined);
    const users = snapshot.items.filter((item) => item.kind === "user").map((item) => item.text);
    assert.equal(users.length, 30);
    assert.match(users[0], /message 0\b/, "the original delegation entry is reachable");
    assert.match(users.at(-1), /message 29/, "the newest entry is retained");
    const order = snapshot.items.map((item) => item.entryId);
    assert.equal(new Set(order).size, order.length, "no entry is duplicated by paging");
    const expected = [];
    for (let index = 0; index < 30; index += 1) expected.push(`u${index}`, `a${index}`);
    assert.deepEqual(order, expected, "one public ID pages original and continuation entries in native order");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("delegate and same-ID resume history page through in native order with tool and branch entries", () => {
  const testRoot = root();
  try {
    // One native session file: the original delegation, a compaction, and a
    // same-ID resume continuation — resume appends to the same file.
    writeArtifacts(testRoot, [
      messageEntry("d1", { role: "user", content: "original delegation task", timestamp: 1 }),
      messageEntry("d2", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { offset: 1, limit: 4 } }],
        stopReason: "toolUse",
        timestamp: 2,
      }),
      messageEntry("d3", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 3 }),
      { type: "compaction", id: "k1", parentId: null, timestamp: "t", summary: "s" },
      messageEntry("r1", { role: "user", content: "resume continuation task", timestamp: 4 }),
      messageEntry("r2", { role: "assistant", content: [{ type: "text", text: "resumed answer" }], timestamp: 5 }),
    ], { operation: "resume" });
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 120 });
    const snapshot = loadAll(pager);
    assert.deepEqual(
      snapshot.items.map((item) => item.entryId),
      ["d1", "d2", "k1", "r1", "r2"],
      "the delegation, its tool pair, the compaction marker, and the resume continuation keep native order",
    );
    const kinds = snapshot.items.map((item) => item.kind);
    assert.deepEqual(kinds, ["user", "toolCall", "generic", "user", "assistant"]);
    const call = snapshot.items[1];
    assert.equal(call.result.isError, false, "a call split from its result by a page boundary still pairs across the seam");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a torn final append is incomplete input, never a corrupt entry, and completes on the next newer load", () => {
  const testRoot = root();
  try {
    const { sessionFile } = writeArtifacts(testRoot, [
      messageEntry("e1", { role: "user", content: "question", timestamp: 1 }),
    ]);
    const full = `${JSON.stringify(messageEntry("e2", { role: "assistant", content: [{ type: "text", text: "str" }] }))}\n`;
    writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${full.slice(0, Math.floor(full.length / 2))}`);
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 4096 });
    let snapshot = pager.snapshot();
    assert.equal(snapshot.initialError, undefined);
    assert.deepEqual(snapshot.items.map((item) => item.entryId), ["e1"], "the torn tail never parses as history");

    // The child finishes the append; a newer load picks the completed line up.
    writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${full.slice(Math.floor(full.length / 2))}`);
    assert.equal(pager.loadNewer(), true);
    snapshot = pager.snapshot();
    assert.deepEqual(snapshot.items.map((item) => item.entryId), ["e1", "e2"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("page boundaries preserve unicode code points across every byte offset", () => {
  const testRoot = root();
  try {
    const payload = "中文测试 🎉 emoji family 👨‍👩‍👧‍👦 done";
    writeArtifacts(testRoot, [
      messageEntry("e1", { role: "user", content: `${payload} one`, timestamp: 1 }),
      messageEntry("e2", { role: "user", content: `${payload} two`, timestamp: 2 }),
      messageEntry("e3", { role: "user", content: `${payload} three`, timestamp: 3 }),
      messageEntry("e4", { role: "user", content: `${payload} four`, timestamp: 4 }),
    ]);
    // A sweep of page sizes forces boundaries at nearly every byte offset,
    // including inside multibyte UTF-8 sequences of entries and the header.
    for (const pageBytes of [17, 23, 31, 41, 59, 97, 131]) {
      const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes });
      const snapshot = loadAll(pager);
      const texts = snapshot.items.map((item) => item.text).join("\n");
      assert.equal(snapshot.items.length, 4, `pageBytes=${pageBytes} yields every entry exactly once`);
      assert.ok(!texts.includes("\uFFFD"), `pageBytes=${pageBytes} never splits a code point`);
      for (const word of ["one", "two", "three", "four"]) {
        assert.match(texts, new RegExp(`${payload} ${word}`), `pageBytes=${pageBytes} decodes entry ${word} exactly`);
      }
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a malformed complete record fails its page boundedly and keeps validated pages visible and retryable", () => {
  const testRoot = root();
  try {
    const { sessionFile } = writeArtifacts(testRoot, conversation(20));
    // Corrupt one complete middle line with invalid JSON.
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    lines[10] = `{"type":"message","id":"bad","payload":,password: swordfish`;
    writeFileSync(sessionFile, `${lines.join("\n")}\n`);
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 700 });
    let snapshot = loadAll(pager);
    assert.equal(snapshot.pageError, CHILD_HISTORY_READ_ERROR, "the malformed page surfaces one bounded reason");
    assert.ok(snapshot.items.length > 0, "previously validated pages stay visible");
    assert.ok(!JSON.stringify(snapshot).includes("swordfish"), "the malformed fragment never leaks");
    assert.ok(snapshot.items.some((item) => item.entryId && Number(item.entryId.slice(1)) < 10), "pages older than the corruption may still load");

    // The retry re-attempts the same page and fails again boundedly, without
    // losing what is loaded.
    const before = snapshot.items.length;
    assert.equal(pager.loadOlder(), false);
    snapshot = pager.snapshot();
    assert.equal(snapshot.pageError, CHILD_HISTORY_READ_ERROR);
    assert.equal(snapshot.items.length, before, "a failed retry never drops validated pages");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an oversized entry is rejected through the per-entry cap", () => {
  const testRoot = root();
  try {
    const { sessionFile } = writeArtifacts(testRoot, [
      messageEntry("e1", { role: "user", content: "small", timestamp: 1 }),
      messageEntry("e2", { role: "user", content: "x".repeat(5_000), timestamp: 2 }),
      messageEntry("e3", { role: "user", content: "small tail", timestamp: 3 }),
    ]);
    void sessionFile;
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 512, maxEntryBytes: 2_048 });
    const snapshot = loadAll(pager);
    assert.equal(snapshot.pageError, CHILD_HISTORY_READ_ERROR);
    assert.ok(snapshot.items.some((item) => /small tail/.test(item.text ?? "")), "validated tail pages stay visible");
    assert.ok(!snapshot.items.some((item) => /xxxxx/.test(item.text ?? "")), "the oversized entry never enters the window");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("historical reads reject symlinked session files and mid-paging identity changes", () => {
  const testRoot = root();
  const otherRoot = root();
  try {
    mkdirSync(otherRoot, { recursive: true });
    const { artifactsDir, sessionFile } = writeArtifacts(testRoot, conversation(10));
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 500 });
    assert.equal(pager.snapshot().initialError, undefined);
    const firstItems = pager.snapshot().items.map((item) => item.entryId);

    // The session file is replaced by a symlink: the existing boundary rejects it on reopen.
    const outside = join(otherRoot, "outside.jsonl");
    writeFileSync(outside, readFileSync(sessionFile));
    rmSync(sessionFile);
    symlinkSync(outside, sessionFile);
    const reopened = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 500 });
    assert.equal(reopened.snapshot().initialError, CHILD_HISTORY_READ_ERROR, "a symlinked session file never opens");

    // Restore a real file through a rename, which deterministically installs
    // a different inode (an unlink-plus-write can reuse the just-freed inode
    // on some filesystems, as CI does): a same-path identity change mid-paging
    // fails boundedly while previously loaded pages stay visible.
    const replacement = join(otherRoot, "replacement.jsonl");
    writeFileSync(replacement, readFileSync(outside));
    rmSync(sessionFile);
    renameSync(replacement, sessionFile);
    const before = pager.snapshot().items.length;
    assert.equal(pager.loadOlder(), false);
    const failed = pager.snapshot();
    assert.equal(failed.pageError, CHILD_HISTORY_READ_ERROR, "an identity change fails the page read");
    assert.equal(failed.items.length, before, "validated pages survive the identity failure");
    assert.deepEqual(failed.items.map((item) => item.entryId).slice(0, firstItems.length), firstItems);
    void artifactsDir;

    // A shrink below the loaded window is also an identity failure.
    const shrinkPager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 500 });
    writeFileSync(sessionFile, `${JSON.stringify(sessionHeader())}\n`);
    assert.equal(shrinkPager.loadOlder(), false);
    assert.equal(shrinkPager.snapshot().pageError, CHILD_HISTORY_READ_ERROR);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("a concurrent append leaves older offsets stable and is discoverable on the next newer load", () => {
  const testRoot = root();
  try {
    const { sessionFile } = writeArtifacts(testRoot, conversation(12));
    const sizeBefore = statSync(sessionFile).size;
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 600 });
    const initial = pager.snapshot();
    const firstLoaded = initial.items.map((item) => item.entryId);

    // The child appends while the viewer holds its window.
    const appended = `${JSON.stringify(messageEntry("late", { role: "user", content: "appended while viewing", timestamp: 99 }))}\n`;
    writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${appended}`);
    assert.ok(statSync(sessionFile).size > sizeBefore);

    loadAll(pager);
    while (pager.loadNewer()) { /* discover the appended tail */ }
    const full = pager.snapshot();
    for (const id of firstLoaded) assert.ok(full.items.some((item) => item.entryId === id), `${id} keeps its stable identity across appends`);
    assert.ok(full.items.some((item) => item.entryId === "late"), "the appended entry is reachable after paging");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a transient read failure retries successfully and clears the bounded error", () => {
  const testRoot = root();
  try {
    writeArtifacts(testRoot, conversation(12));
    let failReads = 1;
    const io = {
      stat: (file) => {
        const stats = statSync(file);
        return { size: stats.size, dev: stats.dev, ino: stats.ino };
      },
      readRange: (file, start, end) => {
        if (failReads > 0 && end < statSync(file).size) {
          failReads -= 1;
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        }
        return realReadRange(file, start, end);
      },
    };
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 600, io });
    assert.equal(pager.snapshot().initialError, undefined);
    assert.equal(pager.loadOlder(), false, "the transient failure fails the page");
    assert.equal(pager.snapshot().pageError, CHILD_HISTORY_READ_ERROR);
    assert.equal(pager.loadOlder(), true, "the retry loads the page");
    const snapshot = pager.snapshot();
    assert.equal(snapshot.pageError, undefined, "a successful retry clears the bounded error");
    assert.ok(snapshot.items.length > 0);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});


test("the loaded window stays bounded and reloads evicted pages on demand", () => {
  const testRoot = root();
  try {
    writeArtifacts(testRoot, conversation(400));
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 900 });
    // Walk far past the item bound: prepending evicts the newest pages.
    for (let loads = 0; loads < 200; loads += 1) {
      if (!pager.loadOlder()) break;
    }
    let snapshot = pager.snapshot();
    assert.ok(snapshot.items.length <= MAX_LOADED_ITEMS, "the in-memory window keeps its explicit bound");
    assert.equal(snapshot.moreAfter, true, "evicted newer pages are known to exist");
    const ids = snapshot.items.map((item) => item.entryId);
    assert.equal(new Set(ids).size, ids.length, "no duplicated entries inside the window");
    assert.ok(ids.includes("u0"), "paging reached the earliest entry");
    assert.ok(!ids.includes("a399"), "the newest entries were evicted");

    // Newer loads walk the window back down without duplication.
    let loads = 0;
    while (pager.loadNewer() && loads < 500) loads += 1;
    snapshot = pager.snapshot();
    const down = snapshot.items.map((item) => item.entryId);
    assert.equal(new Set(down).size, down.length, "no duplicated entries after walking back down");
    assert.ok(down.includes("a399"), "the newest entry is reachable again");
    const textTotal = snapshot.items.reduce((total, item) => total + (item.text?.length ?? JSON.stringify(item.message ?? "").length), 0);
    assert.ok(textTotal <= MAX_LOADED_ITEMS * 2_200, "retained text stays inside the per-entry budgets");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("paging creates no second store beside the native artifacts", () => {
  const testRoot = root();
  try {
    const { artifactsDir } = writeArtifacts(testRoot, conversation(20));
    const before = recursiveListing(artifactsDir);
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 400 });
    loadAll(pager);
    const after = recursiveListing(artifactsDir);
    assert.deepEqual(after, before, "no cache, index, sidecar, journal, or lock file appears");
    const stateRootListing = recursiveListing(join(testRoot, "state"));
    assert.ok(stateRootListing.every((path) => before.includes(path) || !path.includes(ID) || path.startsWith(artifactsDir)), "nothing new appears outside the artifacts directory");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("identity failures at open surface the bounded initial error", () => {
  const testRoot = root();
  try {
    // Header session id does not match run.json.
    const { sessionFile } = writeArtifacts(testRoot, []);
    writeFileSync(sessionFile, `${JSON.stringify(sessionHeader("other-session"))}\n`);
    let pager = createChildHistory(ID, { observedAt: OBSERVED_AT });
    let snapshot = pager.snapshot();
    assert.equal(snapshot.initialError, CHILD_HISTORY_READ_ERROR);
    assert.equal(snapshot.items.length, 0);
    assert.equal(snapshot.moreBefore, false);

    // A missing run.json for another ID is the same bounded state.
    pager = createChildHistory("subagent_00000000-0000-4000-8000-0000000000ff", { observedAt: OBSERVED_AT });
    snapshot = pager.snapshot();
    assert.equal(snapshot.initialError, CHILD_HISTORY_READ_ERROR);
    assert.equal(snapshot.pageError, undefined);
    void testRoot;
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("retryInitial reloads after the artifacts recover", () => {
  const testRoot = root();
  try {
    const { sessionFile } = writeArtifacts(testRoot, conversation(4));
    const raw = readFileSync(sessionFile, "utf8");
    writeFileSync(sessionFile, `corrupt\n`);
    const pager = createChildHistory(ID, { observedAt: OBSERVED_AT, pageBytes: 4096 });
    assert.equal(pager.snapshot().initialError, CHILD_HISTORY_READ_ERROR);
    assert.equal(pager.loadOlder(), false, "loads never run against a failed initial read");

    writeFileSync(sessionFile, raw);
    assert.equal(pager.retryInitial(), true);
    const snapshot = pager.snapshot();
    assert.equal(snapshot.initialError, undefined);
    assert.ok(snapshot.items.length > 0, "the recovered tail page loads");
    assert.equal(pager.retryInitial(), false, "a healthy history has nothing to retry");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("projection still exposes its bounded window contract", () => {
  const entries = [sessionHeader()];
  for (let index = 0; index < 30; index += 1) {
    entries.push(messageEntry(`e${index}`, { role: "user", content: `m ${index}`, timestamp: index }));
  }
  const window = projectSessionEntries(entries, 24);
  assert.equal(window.items.length, 24);
  assert.equal(window.omitted, 6);
  assert.equal(window.items[0].entryId, "e6");
});

// ---------------------------------------------------------------------------
// Runner

let failed = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    console.log(`✓ ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${entry.name}`);
    console.error(error);
  }
}
console.log(`${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
