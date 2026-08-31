import assert from "node:assert/strict";
import jiti from "jiti";
import { SessionManager, buildContextEntries } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { MEMORY_FORMAT_TAG, composeMemorySummary } = await load("../../src/context-memory/format.ts");
const { MEMORY_TRANSCRIPT_HEADER } = await load("../../src/context-memory/transcript.ts");

const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

/**
 * #217 Pi in-memory session integration: derivation, source recovery, and
 * active-tool synchronization against Pi's real SessionManager tree — real
 * uuids, real append semantics, no filesystem writes.
 */

function harness(config = ENABLED_CONFIG) {
  const tools = new Map();
  const events = new Map();
  let active = ["read", "bash"];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => {
      throw new Error("display runtime is not needed for in-memory session derivation");
    },
  });
  return {
    tools, registration, activeTools: () => [...active],
    async emit(name, event, ctx) {
      for (const handler of events.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function commandContext(sessionManager) {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager,
    compact() {},
    getContextUsage: () => ({ tokens: 40000, contextWindow: 200000, percent: 20 }),
    getSystemPrompt: () => "",
  };
}

try {
  // A real tree: two Memory blocks behind one carrying compaction, then a
  // kept tail with the current request.
  const sm = SessionManager.inMemory("/project");
  assert.equal(sm.isPersisted(), false, "the fixture session is ephemeral");
  assert.equal(sm.getSessionFile(), undefined, "no session file exists");

  const firstUser = sm.appendMessage({ role: "user", content: "walk me through the repo structure", timestamp: 1 });
  const firstAssistant = sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "one entry point registers each feature module" },
      { type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "src/index.ts" } },
    ],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 2,
  });
  const firstResult = sm.appendMessage({
    role: "toolResult", toolCallId: "call-read-1", toolName: "read",
    content: [{ type: "text", text: "export default register()" }], isError: false, timestamp: 3,
  });
  const secondUser = sm.appendMessage({ role: "user", content: "now fix the login flow", timestamp: 4 });
  const secondAssistant = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "the session cookie was set after the redirect" }],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 5,
  });
  const keptUser = sm.appendMessage({ role: "user", content: "ship it", timestamp: 6 });

  const blockBodies = [
    "# Repo tour\n\n- index.ts registers each feature module",
    "# Login fix\n\n- session cookie set before the redirect",
  ];
  const branchBefore = sm.getBranch();
  const byOriginal = new Map(branchBefore.map((entry) => [entry.id, entry]));
  const compactionId = sm.appendCompaction(
    composeMemorySummary(blockBodies),
    byOriginal.get(keptUser).id,
    9000,
    {
      format: MEMORY_FORMAT_TAG,
      blocks: [
        { endEntryId: byOriginal.get(firstResult).id, markdownBytes: Buffer.byteLength(blockBodies[0], "utf8") },
        { endEntryId: byOriginal.get(secondAssistant).id, markdownBytes: Buffer.byteLength(blockBodies[1], "utf8") },
      ],
    },
    true,
  );
  assert.ok(compactionId, "the compaction entry received a real id");

  // Pi projects the compaction plus the kept tail — the fixture is realistic.
  const projected = buildContextEntries(sm.getEntries(), sm.getLeafId());
  assert.equal(projected[0].type, "compaction");
  assert.equal(projected[0].id, compactionId);
  assert.equal(projected[1].id, keptUser);

  // ── Derivation and tool activation through the real tree ──

  const session = harness();
  const ctx = commandContext(sm);
  await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.ok(session.activeTools().includes("read_memory_source"),
    "valid Memory on the resumed leaf activates the read tool");

  const snapshot = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
  assert.equal(snapshot.state, "active");
  assert.equal(snapshot.blocks, 2);
  assert.equal(snapshot.rows[0].sources, 3, "block 1 covers the first user/assistant/result trio");
  assert.equal(snapshot.rows[1].sources, 2, "block 2 covers the second user/assistant pair");

  // ── Source recovery through the real tree ──

  const read = session.tools.get("read_memory_source");
  const pages = [];
  let page = 1;
  for (;;) {
    const result = await read.execute(`s:${page}`, { block: 2, page }, undefined, undefined, ctx);
    pages.push(result.content[1].text);
    if (!result.details.hasMore) break;
    assert.match(result.content.at(-1).text, new RegExp(`"block": 2, "page": ${page + 1}`));
    page += 1;
  }
  const transcript = pages.join("");
  assert.ok(transcript.startsWith(MEMORY_TRANSCRIPT_HEADER));
  assert.ok(transcript.includes("now fix the login flow"), "block 2 starts after block 1's end");
  assert.ok(transcript.includes("the session cookie was set after the redirect"));
  assert.ok(!transcript.includes("walk me through the repo structure"), "block 1 sources stay out of block 2");
  assert.ok(!transcript.includes(firstUser), "entry ids never appear");
  assert.ok(!transcript.includes(compactionId));

  const inspected = session.registration.inspect({ block: 1, page: 1 }, sm);
  assert.equal(inspected.ok, true);
  assert.ok(inspected.text.includes("# Repo tour"));
  assert.ok(inspected.text.includes("export default register()"), "block 1 recovers its tool result");

  // ── Tree navigation re-derives from the leaf Pi opens ──

  sm.branch(byOriginal.get(secondUser).id);
  await session.emit("session_tree", { type: "session_tree", newLeafId: secondUser, oldLeafId: sm.getLeafId() }, ctx);
  assert.ok(!session.activeTools().includes("read_memory_source"),
    "navigating before the compaction leaves no current Memory");
  assert.deepEqual(session.registration.snapshot(), { state: "no-memory" });
  await assert.rejects(
    () => read.execute("s:gone", { block: 1, page: 1 }, undefined, undefined, ctx),
    (error) => {
      assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /);
      return true;
    },
  );

  // Navigating back onto the carrying leaf restores Memory.
  sm.branch(compactionId);
  await session.emit("session_tree", { type: "session_tree", newLeafId: compactionId, oldLeafId: secondUser }, ctx);
  assert.ok(session.activeTools().includes("read_memory_source"));
  assert.equal(session.registration.snapshot({ tokens: 1, contextWindow: 1000 }).state, "active");

  // ── A native compaction appended by Pi degrades Memory to opaque ──

  sm.appendMessage({ role: "user", content: "one more thing", timestamp: 7 });
  sm.appendCompaction("A plain native summary.", keptUser, 4000, undefined, false);
  await session.emit("session_compact", {
    type: "session_compact",
    compactionEntry: sm.getBranch().at(-1),
    fromExtension: false,
    reason: "manual",
    willRetry: false,
  }, ctx);
  assert.deepEqual(session.registration.snapshot(), { state: "opaque" });
  assert.ok(!session.activeTools().includes("read_memory_source"));

  // The ephemeral session wrote nothing to disk.
  assert.equal(sm.isPersisted(), false);
  assert.equal(sm.getSessionFile(), undefined);

  console.log("context-memory session tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
