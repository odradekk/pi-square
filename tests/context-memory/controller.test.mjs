import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const { OWNED_TOOL_NAMES } = await load("../../src/context-memory/controller.ts");
const { MEMORY_FORMAT_TAG, MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG, MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR, composeMemorySummary } = await load("../../src/context-memory/format.ts");
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
/** Small due point so a padded stub branch crosses it by projection alone. */
const DUE_CONFIG = { enabled: true, compressionThreshold: { tokens: 2500 }, memoryBudgetPercent: 1 };

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
    // Deterministic fixture version; activation must not depend on it (#255).
    hostVersion = () => "0.84.2",
    messageProjectionInterface = () => true,
    activeTools = ["read", "bash", "compact_to_memory_block", "read_memory_source"],
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
    registerMessageRenderer() {},
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => displayRuntime,
    hostVersion,
    messageProjectionInterface,
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
/** A #319 state entry recorded through Pi's public custom-entry seam. */
function stateEntry(id, parentId, blocks, baseCompactionId) {
  return {
    id, parentId, type: "custom", timestamp: TS,
    customType: MEMORY_STATE_CUSTOM_TYPE,
    data: { format: MEMORY_STATE_FORMAT_TAG, blocks, ...(baseCompactionId !== undefined ? { baseCompactionId } : {}) },
  };
}
function stateBlock(endEntryId, markdown, retainedEntryIds = []) {
  return { endEntryId, markdown, retainedEntryIds };
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

/**
 * A valid #319 state-carried branch: block 1 covers s1..s6 with the protected
 * s5 instruction retained raw, historical submit artifacts inside the range,
 * and the current request kept as tail.
 */
function stateMemoryBranch() {
  const entries = [
    userEntry("s1", null, "walk me through the repo structure"),
    assistantEntry("s2", "s1", [
      { type: "text", text: "one entry point registers each feature module" },
      { type: "toolCall", id: "call-state-submit", name: "submit_memory", arguments: { markdown: "# confidential" } },
    ]),
    toolResultEntry("s3", "s2", "submit_memory", "SUBMIT_NOT_DUE: no Context Memory compression is due in this run", true),
    assistantEntry("s4", "s3", [{ type: "text", text: "the parser walks three bounded phases" }]),
    userEntry("s5", "s4", "keep the alpha-bravo planning instruction verbatim"),
    assistantEntry("s6", "s5", [{ type: "text", text: "the planning instruction is preserved" }]),
    userEntry("s7", "s6", "ship it"),
    stateEntry("sc", "s7", [stateBlock("s6", "# State digest\n\n- the repo tour and parser phases", ["s5"])]),
  ];
  return sessionOf(entries);
}

/** The provider-bound message projection of a stub session, Pi's own helpers. */
function projectedMessages(session) {
  const branch = session.getBranch(session.getLeafId());
  const built = buildContextEntries(branch, session.getLeafId());
  return built.flatMap((entry) => sessionEntryToContextMessages(entry));
}

try {

  // ── Registration: two decorated parent-only tools, registered once ──

  const harness = createHarness();
  assert.deepEqual([...harness.tools.keys()].sort(), ["compact_to_memory_block", "read_memory_source"]);
  for (const name of OWNED_TOOL_NAMES) {
    const tool = harness.tools.get(name);
    assert.equal(tool.name, name);
    assert.equal(tool.renderShell, "self", `${name} must own the shared display shell`);
    assert.equal(typeof tool.renderCall, "function", `${name} must render calls through the display adapter`);
    assert.equal(typeof tool.renderResult, "function", `${name} must render results through the display adapter`);
    assert.ok(!childToolNames.includes(name), `${name} must stay out of the child catalog`);
  }

  // Strict provider-compatible schemas.
  const compact = harness.tools.get("compact_to_memory_block");
  assert.equal(compact.parameters.type, "object");
  assert.equal(compact.parameters.anyOf, undefined);
  assert.equal(compact.parameters.oneOf, undefined);
  assert.equal(compact.parameters.additionalProperties, false);
  assert.deepEqual(compact.parameters.required, ["markdown"]);
  assert.equal(Object.keys(compact.parameters.properties).length, 1);
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
  assert.ok(!harness.activeToolWrites[0].includes("compact_to_memory_block"));

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

  // ── Compatibility gate: interface presence alone decides activation (#255) ──

  const enabledSupported = createHarness({ config: ENABLED_CONFIG });
  await enabledSupported.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(enabledSupported.registration.snapshot(), { state: "no-memory" });
  assert.ok(!enabledSupported.activeToolsRef().includes("read_memory_source"),
    "no valid Memory means read_memory_source stays inactive");
  assert.ok(enabledSupported.activeToolsRef().includes("compact_to_memory_block"),
    "the compression tool is resident while enabled on a supported host (#319)");

  // The host version never gates activation: every version string activates
  // while the required interfaces are present (#255).
  for (const version of ["0.84.1", "0.85.0", "1.0.0-beta.3"]) {
    const otherVersion = createHarness({ config: ENABLED_CONFIG, hostVersion: () => version });
    await otherVersion.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(otherVersion.registration.snapshot(), { state: "no-memory" },
      `a host reporting ${version} with every interface present activates`);
  }

  // Valid Memory on a different host version still activates the reading tool.
  const otherVersionMemory = createHarness({ config: ENABLED_CONFIG, hostVersion: () => "0.85.0" });
  await otherVersionMemory.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...fullSessionContext(), sessionManager: validMemoryBranch() },
  );
  assert.ok(otherVersionMemory.activeToolsRef().includes("read_memory_source"),
    "valid Memory on a different host version activates the reading tool");

  const missingInterfaces = createHarness({ config: ENABLED_CONFIG });
  await missingInterfaces.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...fullSessionContext(), compact: undefined, getContextUsage: undefined },
  );
  assert.deepEqual(
    missingInterfaces.registration.snapshot(),
    { state: "unsupported", reason: "host-interfaces", hostVersion: "0.84.2" },
  );
  assert.deepEqual(missingInterfaces.activeToolsRef(), ["read", "bash"],
    "an unsupported host keeps both tools inactive while preserving Pi's active tools");

  const missingProjection = createHarness({ config: ENABLED_CONFIG, messageProjectionInterface: () => false });
  await missingProjection.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...fullSessionContext(), sessionManager: validMemoryBranch() },
  );
  assert.deepEqual(
    missingProjection.registration.snapshot(),
    { state: "unsupported", reason: "host-interfaces", hostVersion: "0.84.2" },
    "a host without Pi's message projection helper fails closed before Context Memory activates",
  );
  assert.deepEqual(missingProjection.activeToolsRef(), ["read", "bash"]);

  // A disabled configuration stays disabled regardless of host support.
  const disabledUnsupported = createHarness({ config: SUPPORTED_CONFIG });
  await disabledUnsupported.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...fullSessionContext(), compact: undefined, getContextUsage: undefined },
  );
  assert.deepEqual(disabledUnsupported.registration.snapshot(), { state: "disabled" });

  // ── #222: an unsupported host exposes no partial advisory, activation, or filtering ──

  {
    // Unsupported now means missing interfaces (#255): session_start observes
    // a context without compact/getContextUsage, while every later event uses
    // the full context — the captured gate must hold for the session either way.
    const gated = createHarness({ config: ENABLED_CONFIG });
    const gatedSession = validMemoryBranch();
    const gatedCtx = {
      ...fullSessionContext(),
      sessionManager: gatedSession,
      getContextUsage: () => ({ tokens: 30000, contextWindow: 200000, percent: 15 }),
    };
    const compactCalls = [];
    gatedCtx.compact = () => compactCalls.push(true);
    const notified = [];
    gatedCtx.ui = { notify: (text, level) => notified.push({ text, level }) };

    await gated.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      { ...gatedCtx, compact: undefined, getContextUsage: undefined },
    );
    assert.ok(!gated.activeToolsRef().includes("compact_to_memory_block"),
      "the resident compression tool never activates on an unsupported host");
    assert.ok(!gated.activeToolsRef().includes("read_memory_source"),
      "valid Memory on an unsupported host never activates the reading tool");

    const request = [
      { role: "user", content: "old task", timestamp: 1 },
      { role: "assistant", content: [
        { type: "text", text: "kept text" },
        { type: "toolCall", id: "call-gated", name: "compact_to_memory_block", arguments: { markdown: "# gated" } },
      ], timestamp: 2 },
      { role: "toolResult", toolCallId: "call-gated", toolName: "compact_to_memory_block", content: [{ type: "text", text: "Memory block recorded." }], timestamp: 3 },
      { role: "user", content: "ship it", timestamp: 4 },
    ];
    const contextHandler = gated.events.get("context")[0];
    const transformed = await contextHandler({ type: "context", messages: request }, gatedCtx);
    assert.equal(transformed, undefined,
      "an unsupported host leaves the provider request untouched — no advisory and no artifact filtering");

    const nativeEntry = {
      id: "c-native", parentId: "e6", type: "compaction", timestamp: TS,
      summary: "a plain native summary", firstKeptEntryId: "e6", tokensBefore: 4321, fromExtension: false,
    };
    await gated.emit("session_compact", {
      type: "session_compact", compactionEntry: nativeEntry, fromExtension: false, reason: "manual", willRetry: false,
    }, gatedCtx);
    await gated.emit("agent_settled", { type: "agent_settled" }, gatedCtx);
    assert.equal(compactCalls.length, 0, "an unsupported host never requests a compaction");
    assert.deepEqual(notified, [], "an unsupported host emits no diagnostic");
    assert.deepEqual(gated.activeToolsRef(), ["read", "bash"],
      "an unsupported host strips only the owned names and keeps every other active tool");
    assert.deepEqual(gated.registration.snapshot(), { state: "unsupported", reason: "host-interfaces", hostVersion: "0.84.2" },
      "the snapshot keeps reporting the unsupported host with its version");
  }

  // ── Tool execution outside any active session fails safely ──

  await assert.rejects(
    () => compact.execute("cm:compact", { markdown: "# Secret plan\n\nexact text" }, undefined, undefined, fullSessionContext()),
    (error) => {
      assert.match(error.message, /^COMPACT_NOT_AVAILABLE: /);
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

  // A call outside any recorded assistant batch refuses the sole-call contract.
  {
    const soleHarness = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
    await soleHarness.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(stateMemoryBranch()));
    await assert.rejects(
      () => soleHarness.tools.get("compact_to_memory_block").execute(
        "cm:sole", { markdown: "# Secret plan\n\nexact text" }, undefined, undefined, toolContext(stateMemoryBranch()),
      ),
      (error) => {
        assert.match(error.message, /^COMPACT_NOT_SOAL_TOOL: /);
        assert.ok(!error.message.includes("Secret plan"), "the failure never echoes Memory Markdown");
        return true;
      },
    );
  }

  // ── #217: valid compaction-carried Memory activates the read-only source tool ──

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
    memoryHarness.activeToolsRef().filter((name) => name !== "read_memory_source" && name !== "compact_to_memory_block"),
    ["read", "bash"],
    "unrelated active tools keep their order and identity",
  );
  assert.ok(memoryHarness.activeToolsRef().includes("compact_to_memory_block"),
    "the compression tool is resident while the feature is enabled (#319)");

  const activeSnapshot = memoryHarness.registration.snapshot({
    tokens: 74223,
    contextWindow: 200_000,
  });
  assert.equal(activeSnapshot.state, "active");
  assert.equal(activeSnapshot.carrier, "compaction", "the v1 baseline reports its carrier");
  assert.equal(activeSnapshot.applied, false, "a compaction carrier is never marked applied by the state projection");
  assert.equal(activeSnapshot.blocks, 1);
  assert.equal(activeSnapshot.rows.length, 1);
  assert.equal(activeSnapshot.rows[0].sources, 4, "the row counts only eligible source entries");
  assert.match(activeSnapshot.rows[0].preview, /^# Repo tour/);
  assert.equal(activeSnapshot.budgetTokens, 20_000, "the budget is the configured percent of the window");
  assert.equal(activeSnapshot.currentTokens, 74223);
  assert.equal(activeSnapshot.contextWindow, 200_000);

  // Without usage the same Memory still renders active with unknown budget.
  const noUsage = memoryHarness.registration.snapshot();
  assert.equal(noUsage.state, "active");
  assert.equal(noUsage.budgetTokens, null);

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

  // ── #319: state-carried Memory activates the same reading surface ──

  const stateHarness = createHarness({ config: ENABLED_CONFIG, activeTools: ["read", "bash"] });
  const stateSession = stateMemoryBranch();
  await stateHarness.emit("session_start", { type: "session_start", reason: "startup" }, toolContext(stateSession));
  assert.ok(stateHarness.activeToolsRef().includes("read_memory_source"),
    "valid state-carried Memory activates read_memory_source");
  assert.ok(stateHarness.activeToolsRef().includes("compact_to_memory_block"),
    "the compression tool stays resident beside the reading surface");
  const stateSnapshot = stateHarness.registration.snapshot({ tokens: 74223, contextWindow: 200_000 });
  assert.equal(stateSnapshot.state, "active");
  assert.equal(stateSnapshot.carrier, "state", "the state carrier reports itself");
  assert.equal(stateSnapshot.applied, false, "recorded Memory is not yet applied to any request");
  assert.equal(stateSnapshot.blocks, 1);
  assert.equal(stateSnapshot.rows[0].sources, 5,
    "the row counts the eligible source entries including the retained instruction");
  const stateRead = stateHarness.tools.get("read_memory_source");
  const statePage = await stateRead.execute("cm:state", { block: 1, page: 1 }, undefined, undefined, toolContext(stateSession));
  assert.ok(statePage.content[1].text.includes("walk me through the repo structure"));
  assert.ok(statePage.content[1].text.includes("keep the alpha-bravo planning instruction verbatim"),
    "the retained instruction is ordinary source evidence");
  for (const forbidden of ["submit_memory", "confidential", "SUBMIT_NOT_DUE"]) {
    assert.ok(!statePage.content[1].text.includes(forbidden),
      `the state-carried transcript never exposes ${JSON.stringify(forbidden)}`);
  }
  await assert.rejects(
    () => stateRead.execute("cm:state", { block: 2, page: 1 }, undefined, undefined, toolContext(stateSession)),
    (error) => {
      assert.match(error.message, /^BLOCK_OUT_OF_RANGE: /);
      return true;
    },
  );
  const stateInspected = stateHarness.registration.inspect({ block: 1, page: 1 }, stateSession);
  assert.equal(stateInspected.ok, true);
  assert.ok(stateInspected.text.includes("# State digest"), "inspection shows the recorded block Markdown");

  // ── #319: due detection and the request advisory are projection-aware ──

  {
    // Padded history crosses the 2500-token due point by projection alone.
    const PADDING = "detailed module boundary notes that make the covered history large. ".repeat(90);
    const entries = [
      userEntry("d1", null, `explore the parser internals ${PADDING}`),
      assistantEntry("d2", "d1", [{ type: "text", text: `the parser walks three bounded phases ${PADDING}` }]),
      userEntry("d3", "d2", "ship it"),
    ];
    const dueSession = sessionOf(entries);
    const dueHarness = createHarness({ config: DUE_CONFIG, activeTools: ["read", "bash"] });
    const dueCtx = {
      ...fullSessionContext(),
      sessionManager: dueSession,
      getContextUsage: () => ({ tokens: 30000, contextWindow: 200000, percent: 15 }),
    };
    await dueHarness.emit("session_start", { type: "session_start", reason: "startup" }, dueCtx);
    assert.deepEqual(dueHarness.registration.snapshot(), { state: "due" },
      "the projected request sits at or above the due point");

    const contextHandler = dueHarness.events.get("context")[0];
    const dueRequest = await contextHandler(
      { type: "context", messages: projectedMessages(dueSession) }, dueCtx,
    );
    const advisories = dueRequest.messages.filter((message) => message?.customType === "pi-square.context-memory/advisory");
    assert.equal(advisories.length, 1, "exactly one advisory rides the due request");
    assert.ok(advisories[0].content.includes("compression is due"));
    assert.equal(dueRequest.messages.at(-2).role, "user");
    assert.equal(dueRequest.messages.at(-2).content, "ship it",
      "the advisory sits directly after the current user message");
    assert.ok(dueRequest.messages.length === projectedMessages(dueSession).length + 1,
      "the advisory is the only insertion");

    // Recording the covered history relieves the estimate immediately.
    entries.push(stateEntry("ds", "d3", [stateBlock("d2", "# Relief digest\n\n- the covered parser phases")]));
    await dueHarness.emit("agent_settled", { type: "agent_settled" }, dueCtx);
    const relieved = dueHarness.registration.snapshot({ tokens: 500, contextWindow: 200000 });
    assert.equal(relieved.state, "active", "a recorded state entry opens the reading surface");
    assert.equal(relieved.carrier, "state");

    const relievedRequest = await contextHandler(
      { type: "context", messages: projectedMessages(dueSession) }, dueCtx,
    );
    const serialized = JSON.stringify(relievedRequest.messages);
    assert.ok(!serialized.includes("pi-square.context-memory/advisory"),
      "the advisory clears once the recorded Memory relieves the pressure");
    assert.ok(!serialized.includes("explore the parser internals"),
      "the covered originals leave the request");
    assert.ok(serialized.includes("ship it"), "the current request stays uncompressed");
    const carrier = relievedRequest.messages.find((message) => message?.customType === "pi-square.context-memory/blocks");
    assert.ok(carrier, "the complete Memory carrier enters the request");
    assert.deepEqual(
      carrier.content.map((part) => part.text),
      [MEMORY_SUMMARY_WRAPPER, `${MEMORY_BLOCK_SEPARATOR}# Relief digest\n\n- the covered parser phases`],
      "the carrier is one ordered text part per block",
    );
    assert.ok(!serialized.includes(PADDING.trim().slice(0, 40)),
      "the padded covered history is evicted, not carried");
    assert.equal(dueHarness.registration.snapshot({ tokens: 500, contextWindow: 200000 }).applied, true,
      "the applied flag reports that a request carried the carrier");
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
  assert.ok(!resync.activeToolsRef().includes("read_memory_source"), "a native compaction removes the read tool");
  assert.ok(resync.activeToolsRef().includes("compact_to_memory_block"),
    "the compression tool stays resident through every boundary (#319)");
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
  const compactDecorated = harness.tools.get("compact_to_memory_block");
  const callComponent = compactDecorated.renderCall(
    { markdown: "# confidential Memory body" },
    theme,
    { state: {}, args: { markdown: "# confidential Memory body" }, cwd: "/project", toolCallId: "cm:call", invalidate() {}, executionStarted: false, argsComplete: true, expanded: false },
  );
  const callLines = callComponent.render(80).map(stripVTControlCharacters);
  const callRow = callLines.join("\n");
  assert.ok(/Memory compact/.test(callRow), "the collapsed call row states the tool identity");
  assert.ok(!callRow.includes("confidential"), "the call row never shows the Memory body");
  const resultComponent = compactDecorated.renderResult(
    { content: [{ type: "text", text: "Memory block recorded. The next model request will carry it in place of the covered older conversation." }], details: { recorded: true } },
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
