import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { SUPPORTED_PI_VERSION } = await load("../../src/context-memory/host.ts");
const { OWNED_TOOL_NAMES } = await load("../../src/context-memory/controller.ts");
const { MEMORY_FORMAT_TAG, composeMemorySummary } = await load("../../src/context-memory/format.ts");
const { MEMORY_TRANSCRIPT_HEADER } = await load("../../src/context-memory/transcript.ts");
const { childToolNames } = await load("../../src/tool-catalog.ts");

const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const defaultDisplayRuntime = new DisplayRuntime(DEFAULT_CONFIG, {
  environment: { isTty: false, isCi: true, colorDepth: 0, term: "dumb", isDumbTerminal: true },
  clock: () => 0,
});

const SUPPORTED_CONFIG = { enabled: false, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

function fullSessionContext() {
  return {
    cwd: "/project",
    hasUI: false,
    mode: "rpc",
    sessionManager: { getBranch: () => [] },
    compact() {},
    getContextUsage: () => null,
    getSystemPrompt: () => "",
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
  };
}
function createHarness(options = {}) {
  const {
    config = SUPPORTED_CONFIG,
    hostVersion = () => SUPPORTED_PI_VERSION,
    activeTools = ["read", "bash", "submit_memory", "read_memory_source"],
    displayRuntime = defaultDisplayRuntime,
  } = options;
  const tools = new Map();
  const events = new Map();
  let active = [...activeTools];
  const activeToolWrites = [];
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) {
      active = [...names];
      activeToolWrites.push([...names]);
    },
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => displayRuntime,
    hostVersion,
    reserveTokens: () => 16384,
  });
  async function emit(name, event = {}, ctx = fullSessionContext()) {
    for (const handler of events.get(name) ?? []) {
      await handler(event, ctx);
    }
  }
  return { pi, tools, events, registration, emit, activeToolWrites, activeToolsRef: () => [...active] };
}

// ─── #217 session fixtures: a branch path with a carrying compaction ──

const TS = "2026-01-01T00:00:00.000Z";
const IMAGE_BASE64 = "iVBORw0KGgo="; // 11 base64 data chars -> 8 decoded bytes

function messageEntry(id, parentId, message) {
  return { id, parentId, type: "message", timestamp: TS, message };
}
function userEntry(id, parentId, content) {
  return messageEntry(id, parentId, { role: "user", content, timestamp: 1 });
}
function assistantEntry(id, parentId, parts) {
  return messageEntry(id, parentId, {
    role: "assistant",
    content: parts,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  });
}
function toolResultEntry(id, parentId, toolName, text, isError = false) {
  return messageEntry(id, parentId, {
    role: "toolResult", toolCallId: `call-${id}`, toolName,
    content: [{ type: "text", text }], isError, timestamp: 1,
  });
}
function compactionEntry(id, parentId, { firstKeptEntryId, ends, bodies, summary, details }) {
  const composed = summary ?? composeMemorySummary(bodies);
  const carried = details ?? {
    format: MEMORY_FORMAT_TAG,
    blocks: bodies.map((body, index) => ({
      endEntryId: ends[index],
      markdownBytes: Buffer.byteLength(body, "utf8"),
    })),
  };
  return {
    id, parentId, type: "compaction", timestamp: TS,
    summary: composed, firstKeptEntryId, tokensBefore: 1234,
    details: carried, fromHook: true,
  };
}
function sessionOf(entries) {
  return {
    getLeafId: () => entries.at(-1)?.id ?? null,
    getBranch: () => [...entries],
  };
}
function toolContext(session) {
  return { ...fullSessionContext(), sessionManager: session };
}

/** A valid single-block branch: block 1 covers e1..e4 with e5 kept as tail. */
function validMemoryBranch({ compactionId = "c1" } = {}) {
  const entries = [
    userEntry("e1", null, [
      { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
      { type: "text", text: "walk me through the repo structure" },
    ]),
    // Protocol artifact parts are excluded while ordinary text survives.
    assistantEntry("e2", "e1", [
      { type: "text", text: "one entry point registers each feature module" },
      { type: "toolCall", id: "call-submit", name: "submit_memory", arguments: { markdown: "# confidential" } },
    ]),
    toolResultEntry("e3", "e2", "submit_memory", "Memory candidate accepted; compaction pending."),
    assistantEntry("e4", "e3", [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/index.ts" } }]),
    toolResultEntry("e5", "e4", "read", "export default register()\n", true),
    userEntry("e6", "e5", "ship it"),
    compactionEntry(compactionId, "e6", {
      firstKeptEntryId: "e6",
      ends: ["e5"],
      bodies: ["# Repo tour\n\n- index.ts registers each feature module"],
    }),
  ];
  return sessionOf(entries);
}

function nativeCompactionBranch() {
  const entries = [
    userEntry("e1", null, "walk me through the repo structure"),
    assistantEntry("e2", "e1", [{ type: "text", text: "one entry point registers each feature module" }]),
    userEntry("e3", "e2", "ship it"),
    {
      id: "c-native", parentId: "e3", type: "compaction", timestamp: TS,
      summary: "The user asked about the repo; the assistant explained the entry point.",
      firstKeptEntryId: "e3", tokensBefore: 900,
    },
  ];
  return sessionOf(entries);
}

try {

  // ── Registration: two decorated parent-only tools, registered once ──

  const harness = createHarness();
  assert.deepEqual([...harness.tools.keys()].sort(), ["read_memory_source", "submit_memory"]);
  for (const name of OWNED_TOOL_NAMES) {
    const tool = harness.tools.get(name);
    assert.equal(tool.name, name);
    assert.equal(tool.renderShell, "self", `${name} must own the shared display shell`);
    assert.equal(typeof tool.renderCall, "function", `${name} must render calls through the display adapter`);
    assert.equal(typeof tool.renderResult, "function", `${name} must render results through the display adapter`);
    assert.ok(!childToolNames.includes(name), `${name} must stay out of the child catalog`);
  }

  // Strict provider-compatible schemas.
  const submit = harness.tools.get("submit_memory");
  assert.equal(submit.parameters.type, "object");
  assert.equal(submit.parameters.anyOf, undefined);
  assert.equal(submit.parameters.oneOf, undefined);
  assert.equal(submit.parameters.additionalProperties, false);
  assert.deepEqual(submit.parameters.required, ["markdown"]);
  assert.equal(Object.keys(submit.parameters.properties).length, 1);
  const read = harness.tools.get("read_memory_source");
  assert.equal(read.parameters.type, "object");
  assert.equal(read.parameters.anyOf, undefined);
  assert.equal(read.parameters.oneOf, undefined);
  assert.equal(read.parameters.additionalProperties, false);
  assert.deepEqual(read.parameters.required, ["block", "page"]);
  assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["block", "page"]);

  // ── Lifecycle: default-off controller keeps both tools inactive ──

  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(harness.registration.snapshot(), { state: "disabled" });
  assert.deepEqual(harness.activeToolsRef(), ["read", "bash"], "only the owned tool names are removed");
  assert.equal(harness.activeToolWrites.length, 1, "synchronization writes the active list exactly once");
  assert.ok(!harness.activeToolWrites[0].includes("submit_memory"));

  // Unrelated active tools are preserved; a clean active list triggers no write.
  const clean = createHarness({ activeTools: ["read", "bash"] });
  await clean.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(clean.activeToolWrites.length, 0, "no owned names present means no setActiveTools call");
  assert.deepEqual(clean.activeToolsRef(), ["read", "bash"]);

  // Re-sync on reload after a host-style rebuild re-activates every extension tool.
  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  assert.deepEqual(harness.activeToolsRef(), ["read", "bash"]);

  // Shutdown drops the session-scoped controller; the snapshot returns to disabled.
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "shutdown" });
  assert.deepEqual(harness.registration.snapshot(), { state: "disabled" });

  // ── Compatibility gate: exact supported host and required interfaces ──

  assert.equal(SUPPORTED_PI_VERSION, "0.84.2");

  const enabledSupported = createHarness({ config: ENABLED_CONFIG });
  await enabledSupported.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(enabledSupported.registration.snapshot(), { state: "no-memory" });
  assert.ok(!enabledSupported.activeToolsRef().includes("read_memory_source"),
    "no valid Memory means read_memory_source stays inactive");

  const unsupportedVersion = createHarness({ config: ENABLED_CONFIG, hostVersion: () => "0.85.0" });
  await unsupportedVersion.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(
    unsupportedVersion.registration.snapshot(),
    { state: "unsupported", reason: "host-version" },
  );
  assert.deepEqual(unsupportedVersion.activeToolsRef(), ["read", "bash"],
    "an unsupported host keeps both tools inactive while preserving Pi's active tools");

  const missingInterfaces = createHarness({ config: ENABLED_CONFIG });
  await missingInterfaces.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...fullSessionContext(), compact: undefined, getContextUsage: undefined },
  );
  assert.deepEqual(
    missingInterfaces.registration.snapshot(),
    { state: "unsupported", reason: "host-interfaces" },
  );

  // A disabled configuration stays disabled even on a supported host, and
  // host-version wins over interface order in the reported reason.
  const disabledUnsupported = createHarness({ hostVersion: () => "0.83.0" });
  await disabledUnsupported.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(disabledUnsupported.registration.snapshot(), { state: "disabled" });

  // ── Tool execution outside any active window fails safely ──

  await assert.rejects(
    () => submit.execute("cm:submit", { markdown: "# Secret plan\n\nexact text" }, undefined, undefined, fullSessionContext()),
    (error) => {
      assert.match(error.message, /^SUBMIT_NOT_DUE: /);
      assert.ok(!error.message.includes("Secret plan"), "the failure never echoes Memory Markdown");
      return true;
    },
  );
  await assert.rejects(
    () => read.execute("cm:read", { block: 1, page: 1 }, undefined, undefined, toolContext(validMemoryBranch())),
    (error) => {
      assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /);
      return true;
    },
  );

  // ── #217: valid Memory activates the read-only source tool ──

  const memoryHarness = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
  const validSession = validMemoryBranch();
  await memoryHarness.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    toolContext(validSession),
  );
  assert.ok(memoryHarness.activeToolsRef().includes("read_memory_source"),
    "valid non-empty Memory activates read_memory_source");
  assert.deepEqual(
    memoryHarness.activeToolsRef().filter((name) => name !== "read_memory_source"),
    ["read", "bash"],
    "unrelated active tools keep their order and identity",
  );
  assert.ok(!memoryHarness.activeToolsRef().includes("submit_memory"),
    "submit_memory stays inactive without a due run (#218)");

  const activeSnapshot = memoryHarness.registration.snapshot({
    tokens: 74223,
    contextWindow: 200_000,
  });
  assert.equal(activeSnapshot.state, "active");
  assert.equal(activeSnapshot.blocks, 1);
  assert.equal(activeSnapshot.rows.length, 1);
  assert.equal(activeSnapshot.rows[0].sources, 4, "the row counts only eligible source entries");
  assert.match(activeSnapshot.rows[0].preview, /^# Repo tour/);
  assert.equal(activeSnapshot.budgetTokens, 20_000, "the budget is the configured percent of the window");
  assert.equal(activeSnapshot.nextOperation, "append", "Memory far below half budget appends next");
  assert.equal(activeSnapshot.stablePrefix, 1);
  assert.equal(activeSnapshot.currentTokens, 74223);
  assert.equal(activeSnapshot.contextWindow, 200_000);

  // Without usage the same Memory still renders active with unknown budget.
  const noUsage = memoryHarness.registration.snapshot();
  assert.equal(noUsage.state, "active");
  assert.equal(noUsage.budgetTokens, null);
  assert.equal(noUsage.nextOperation, null);
  assert.equal(noUsage.stablePrefix, null);

  // ── #217: read_memory_source returns one bounded transcript page ──

  const readTool = memoryHarness.tools.get("read_memory_source");
  const pageResult = await readTool.execute("cm:read", { block: 1, page: 1 }, undefined, undefined, toolContext(validSession));
  const header = pageResult.content[0].text;
  assert.match(header, /^Memory source · block 1 of 1 · page 1 of \d+$/);
  const transcript = pageResult.content[1].text;
  assert.ok(transcript.startsWith(MEMORY_TRANSCRIPT_HEADER), "the page carries the versioned transcript");
  assert.ok(Buffer.byteLength(transcript, "utf8") <= 16 * 1024, "the page respects the 16 KiB contract");
  assert.deepEqual(pageResult.details, {
    block: 1,
    totalBlocks: 1,
    page: 1,
    totalPages: pageResult.details.totalPages,
    hasMore: 1 < pageResult.details.totalPages,
  });
  assert.deepEqual(
    Object.keys(pageResult.details).sort(),
    ["block", "hasMore", "page", "totalBlocks", "totalPages"],
    "details carry only the five bounded paging fields",
  );
  if (pageResult.details.hasMore) {
    assert.match(
      pageResult.content.at(-1).text,
      /^Next page: read_memory_source\({ "block": 1, "page": 2 }\)$/,
    );
  } else {
    assert.equal(pageResult.content.length, 2, "no next-page hint on the final page");
  }

  // ── #217: source privacy and protocol filtering ──

  const allPages = [];
  for (let page = 1; page <= pageResult.details.totalPages; page++) {
    const result = await readTool.execute("cm:r", { block: 1, page }, undefined, undefined, toolContext(validSession));
    allPages.push(result.content[1].text);
  }
  const whole = allPages.join("");
  for (const needle of [
    "[user]",
    "walk me through the repo structure",
    "[assistant]",
    "one entry point registers each feature module",
    "[assistant · tool call] read",
    "[tool result] read · error",
    "export default register()",
    "[user · image] [image · image/png · 8 B]",
  ]) {
    assert.ok(whole.includes(needle), `the transcript preserves ${JSON.stringify(needle)}`);
  }
  for (const forbidden of [
    "submit_memory",
    "read_memory_source",
    "confidential",
    "call-submit",
    "call-read",
    IMAGE_BASE64,
    TS,
    "parentId",
    "claude-sonnet",
    "totalTokens",
  ]) {
    assert.ok(!whole.includes(forbidden), `the transcript never exposes ${JSON.stringify(forbidden)}`);
  }
  for (const id of ["e1", "e2", "e3", "e4", "e5", "e6", "c1"]) {
    assert.ok(!whole.includes(id), `the transcript never exposes entry id ${id}`);
  }

  // ── #217: custom messages and branch summaries participate as sources ──

  {
    const entries = [
      {
        id: "k1", parentId: null, type: "custom_message", timestamp: TS,
        customType: "pi-square/notice", content: "a custom injected notice", display: false,
      },
      {
        id: "k2", parentId: "k1", type: "message", timestamp: TS,
        message: { role: "user", content: "continue after the branch switch", timestamp: 1 },
      },
      {
        id: "k3", parentId: "k2", type: "branch_summary", timestamp: TS,
        fromId: "k0", summary: "the abandoned path explored three layouts",
      },
      userEntry("k4", "k3", "ship it"),
      compactionEntry("kc", "k4", {
        firstKeptEntryId: "k4",
        ends: ["k3"],
        bodies: ["# Continuity\n\n- covers the notice, request, and branch summary"],
      }),
    ];
    const session = sessionOf(entries);
    const customHarness = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
    await customHarness.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(session));
    assert.ok(customHarness.activeToolsRef().includes("read_memory_source"),
      "custom messages and branch summaries are eligible source entries");
    const customRead = customHarness.tools.get("read_memory_source");
    const result = await customRead.execute("cm:labels", { block: 1, page: 1 }, undefined, undefined, toolContext(session));
    const body = result.content[1].text;
    assert.ok(body.includes("[custom message]"), "custom messages carry their label");
    assert.ok(body.includes("a custom injected notice"));
    assert.ok(!body.includes("pi-square/notice"), "the customType never leaks");
    assert.ok(body.includes("[branch summary]"), "branch summaries carry their label");
    assert.ok(body.includes("the abandoned path explored three layouts"));
    assert.ok(body.includes("continue after the branch switch"));
    assert.equal(customHarness.registration.snapshot().rows[0].sources, 3);
  }

  // ── #217: safe short error codes ──

  await assert.rejects(
    () => readTool.execute("cm:read", { block: 2, page: 1 }, undefined, undefined, toolContext(validSession)),
    (error) => {
      assert.match(error.message, /^BLOCK_OUT_OF_RANGE: /);
      return true;
    },
  );
  await assert.rejects(
    () => readTool.execute("cm:read", { block: 1, page: pageResult.details.totalPages + 1 }, undefined, undefined, toolContext(validSession)),
    (error) => {
      assert.match(error.message, /^PAGE_OUT_OF_RANGE: /);
      return true;
    },
  );
  await assert.rejects(
    () => readTool.execute("cm:read", { block: 1, page: 1 }, undefined, undefined, toolContext(nativeCompactionBranch())),
    (error) => {
      assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /);
      return true;
    },
  );

  // Memory changed since activation: the transient selector guard fires.
  const swappedSession = validMemoryBranch({ compactionId: "c-other" });
  await assert.rejects(
    () => readTool.execute("cm:read", { block: 1, page: 1 }, undefined, undefined, toolContext(swappedSession)),
    (error) => {
      assert.match(error.message, /^MEMORY_CHANGED: /);
      return true;
    },
  );

  // A disabled configuration never activates the tool even with valid Memory.
  const disabledValid = createHarness({ activeTools: ["read", "bash"] });
  await disabledValid.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(validSession));
  assert.ok(!disabledValid.activeToolsRef().includes("read_memory_source"));
  await assert.rejects(
    () => disabledValid.tools.get("read_memory_source").execute("cm:read", { block: 1, page: 1 }, undefined, undefined, toolContext(validSession)),
    (error) => {
      assert.match(error.message, /^MEMORY_NOT_AVAILABLE: /);
      return true;
    },
  );

  // ── #217: native, malformed, and over-bound compactions stay opaque ──

  const nativeHarness = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
  const nativeSession = nativeCompactionBranch();
  await nativeHarness.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(nativeSession));
  assert.deepEqual(nativeHarness.registration.snapshot(), { state: "opaque" });
  assert.ok(!nativeHarness.activeToolsRef().includes("read_memory_source"),
    "a native compaction keeps the structured tools off");

  const malformed = [
    ["unknown details", { firstKeptEntryId: "e6", ends: ["e5"], bodies: ["# x"], details: { format: "other/1", blocks: [] } }],
    ["missing kept boundary", { firstKeptEntryId: "missing", ends: ["e5"], bodies: ["# x"] }],
    ["end past the kept boundary", { firstKeptEntryId: "e5", ends: ["e5"], bodies: ["# x"] }],
    ["non-increasing ends", { firstKeptEntryId: "e6", ends: ["e4", "e2"], bodies: ["# x", "# y"] }],
    ["byte count drift", {
      firstKeptEntryId: "e6",
      ends: ["e5"],
      bodies: ["# x"],
      details: { format: MEMORY_FORMAT_TAG, blocks: [{ endEntryId: "e5", markdownBytes: 2 }] },
    }],
    ["summary without the wrapper", {
      firstKeptEntryId: "e6",
      ends: ["e5"],
      bodies: ["# x"],
      summary: "an ordinary native summary",
    }],
  ];
  for (const [label, patch] of malformed) {
    const branch = validMemoryBranch();
    const entries = branch.getBranch();
    entries[entries.length - 1] = compactionEntry("c-bad", "e6", patch);
    const malformedHarness = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
    await malformedHarness.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(sessionOf(entries)));
    assert.deepEqual(
      malformedHarness.registration.snapshot(),
      { state: "opaque" },
      `${label} renders opaque without repair`,
    );
    assert.ok(!malformedHarness.activeToolsRef().includes("read_memory_source"), label);
  }

  // ── #217: tree and compaction events re-synchronize active tools ──

  const resync = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
  await resync.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(validSession));
  assert.ok(resync.activeToolsRef().includes("read_memory_source"));
  const writesAfterStart = resync.activeToolWrites.length;

  // A no-op re-derivation writes nothing.
  await resync.emit("session_tree", { type: "session_tree", newLeafId: "c1", oldLeafId: "c1" }, toolContext(validSession));
  assert.equal(resync.activeToolWrites.length, writesAfterStart, "unchanged Memory triggers no active-tool write");

  // A later native compaction on the leaf makes Memory opaque and deactivates.
  const afterNative = nativeCompactionBranch();
  await resync.emit("session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "threshold", willRetry: false }, toolContext(afterNative));
  assert.deepEqual(resync.activeToolsRef(), ["read", "bash"], "a native compaction removes the read tool");
  assert.deepEqual(resync.registration.snapshot(), { state: "opaque" });

  // Tree navigation back onto the Memory-carrying leaf re-activates.
  await resync.emit("session_tree", { type: "session_tree", newLeafId: "c1", oldLeafId: "c-native" }, toolContext(validSession));
  assert.ok(resync.activeToolsRef().includes("read_memory_source"), "tree navigation re-derives from the new leaf");

  // ── #217: /context memory inspection through the registration ──

  const inspected = memoryHarness.registration.inspect({ block: 1, page: 1 }, validSession);
  assert.equal(inspected.ok, true);
  assert.ok(inspected.text.includes("# Repo tour"), "inspection shows the full block Markdown");
  assert.ok(inspected.text.includes(MEMORY_TRANSCRIPT_HEADER), "inspection shows the source page");
  assert.ok(inspected.text.includes("read-only · current session only · visible in terminal scrollback"));
  if (pageResult.details.totalPages > 1) {
    assert.ok(inspected.text.includes("next page: /context memory 1 2"), "inspection names the exact next command");
  }

  const inspectedBadBlock = memoryHarness.registration.inspect({ block: 5, page: 1 }, validSession);
  assert.equal(inspectedBadBlock.ok, false);
  assert.match(inspectedBadBlock.sentence, /Block 5 is outside/);
  const inspectedBadPage = memoryHarness.registration.inspect({ block: 1, page: 99 }, validSession);
  assert.equal(inspectedBadPage.ok, false);
  assert.match(inspectedBadPage.sentence, /Page 99 is outside/);
  const inspectedNoMemory = memoryHarness.registration.inspect({ block: 1, page: 1 }, nativeSession);
  assert.equal(inspectedNoMemory.ok, false);
  assert.match(inspectedNoMemory.sentence, /No valid Context Memory/);

  // A fresh registration without a session refuses safely.
  const cold = createHarness({ config: ENABLED_CONFIG });
  const coldInspected = cold.registration.inspect({ block: 1, page: 1 }, validSession);
  assert.equal(coldInspected.ok, false, "inspection before a session start refuses");

  // ── Decorated display rows never expose Memory bodies or raw arguments ──

  // The harness decorated through a real deterministic motion-off runtime.
  const theme = {
    fg(_token, text) { return String(text); },
    bg(_token, text) { return String(text); },
    bold(text) { return String(text); },
    inverse(text) { return String(text); },
  };
  const submitDecorated = harness.tools.get("submit_memory");
  const callComponent = submitDecorated.renderCall(
    { markdown: "# confidential Memory body" },
    theme,
    { state: {}, args: { markdown: "# confidential Memory body" }, cwd: "/project", toolCallId: "cm:call", invalidate() {}, executionStarted: false, argsComplete: true, expanded: false },
  );
  const callLines = callComponent.render(80).map(stripVTControlCharacters);
  const callRow = callLines.join("\n");
  assert.ok(/Memory submit/.test(callRow), "the collapsed call row states the tool identity");
  assert.ok(!callRow.includes("confidential"), "the call row never shows the Memory body");
  const resultComponent = submitDecorated.renderResult(
    { content: [{ type: "text", text: "Memory candidate accepted; compaction pending." }], details: {} },
    { isPartial: false, expanded: false },
    theme,
    { state: {}, args: { markdown: "# confidential Memory body" }, cwd: "/project", toolCallId: "cm:call", invalidate() {}, executionStarted: true, argsComplete: true, expanded: false },
  );
  const resultRow = resultComponent.render(80).map(stripVTControlCharacters).join("\n");
  assert.ok(!resultRow.includes("confidential"), "the result row never shows the Memory body");

  // ── #217: read_memory_source display keeps the transcript expanded-only ──

  const readDecorated = memoryHarness.tools.get("read_memory_source");
  const readCall = readDecorated.renderCall(
    { block: 2, page: 1 },
    theme,
    { state: {}, args: { block: 2, page: 1 }, cwd: "/project", toolCallId: "cm:read", invalidate() {}, executionStarted: false, argsComplete: true, expanded: false },
  );
  const readCallRow = readCall.render(80).map(stripVTControlCharacters).join("\n");
  assert.ok(/Memory source/.test(readCallRow), "the collapsed call row states the tool identity");
  assert.ok(/block 2 · page 1/.test(readCallRow), "the collapsed call row carries the composed target");

  const transcriptNeedle = "NEEDLE-transcript-page-body";
  const pageContent = [
    { type: "text", text: "Memory source · block 2 of 3 · page 1 of 2" },
    { type: "text", text: `${MEMORY_TRANSCRIPT_HEADER}\n\n[user]\n${transcriptNeedle}\n` },
    { type: "text", text: 'Next page: read_memory_source({ "block": 2, "page": 2 })' },
  ];
  const pageDetails = { block: 2, totalBlocks: 3, page: 1, totalPages: 2, hasMore: true };
  const collapsedResult = readDecorated.renderResult(
    { content: pageContent, details: pageDetails },
    { isPartial: false, expanded: false },
    theme,
    { state: {}, args: { block: 2, page: 1 }, cwd: "/project", toolCallId: "cm:read", invalidate() {}, executionStarted: true, argsComplete: true, expanded: false },
  ).render(80).map(stripVTControlCharacters).join("\n");
  assert.ok(/page 1 of 2/.test(collapsedResult), "the collapsed row summarizes the page");
  assert.ok(/more pages/.test(collapsedResult), "the collapsed row marks more pages");
  assert.ok(!collapsedResult.includes(transcriptNeedle), "the collapsed row never shows the transcript");
  assert.ok(collapsedResult.split("\n").length <= 2, "the collapsed entry is one row");

  const expandedResult = readDecorated.renderResult(
    { content: pageContent, details: pageDetails },
    { isPartial: false, expanded: true },
    theme,
    { state: {}, args: { block: 2, page: 1 }, cwd: "/project", toolCallId: "cm:read", invalidate() {}, executionStarted: true, argsComplete: true, expanded: true },
  ).render(80).map(stripVTControlCharacters).join("\n");
  assert.ok(expandedResult.includes(transcriptNeedle), "the expanded entry shows the transcript page");
  assert.ok(!expandedResult.includes("Memory source · block 2 of 3"), "the body never repeats the header outcome");

  const errorResult = readDecorated.renderResult(
    { content: [{ type: "text", text: "MEMORY_NOT_AVAILABLE: no valid Context Memory is available on the current branch" }], details: {}, isError: true },
    { isPartial: false, expanded: false },
    theme,
    { state: {}, args: { block: 1, page: 1 }, cwd: "/project", toolCallId: "cm:read", invalidate() {}, executionStarted: true, argsComplete: true, expanded: false },
  ).render(200).map(stripVTControlCharacters).join("\n");
  assert.ok(
    errorResult.includes("no valid Context Memory is available on the current branch"),
    "the failure row states one human sentence",
  );
  assert.ok(!errorResult.includes("MEMORY_NOT_AVAILABLE"), "the collapsed failure row hides the raw code");

  defaultDisplayRuntime.dispose();

  console.log("context-memory controller tests: OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
