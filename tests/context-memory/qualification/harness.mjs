import jiti from "jiti";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
export const registerContextMemory = (await load("../../../src/context-memory/index.ts")).default;
export const format = await load("../../../src/context-memory/format.ts");
export const transcript = await load("../../../src/context-memory/transcript.ts");
export const host = await load("../../../src/context-memory/host.ts");

/**
 * The deterministic Context Memory qualification corpus harness (#223).
 *
 * The corpus drives the production registrar/controller seam — the same
 * events and tool surfaces Pi drives — with fixed fake sessions, and records
 * every assertion as one zero-tolerance check classified by the severe-failure
 * vocabulary of #215's testing decisions. It is a different artifact from the
 * ordinary `npm test` suites: one reproducible command that answers whether
 * the implemented protocol is mechanically sound at this exact commit, and a
 * bounded report a maintainer reads before authorizing a release.
 */

/** Sentinel embedded in every fixture-authored body or source text. */
export const MARKER = "QCORPUS";

export const WINDOW = 200_000;
export const RESERVE_TOKENS = 16_384;
export const DEFAULT_USAGE = { tokens: 12_000, contextWindow: WINDOW };

/** window 200000 · reserve 16384 · due point 5000 · budget 1% = 2000 < 5000. */
export const DUE_CONFIG = { enabled: true, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 };
export const DISABLED_CONFIG = { enabled: false, compressionThreshold: { tokens: 5000 }, memoryBudgetPercent: 1 };

/** The severe semantic failure vocabulary the report uses (#214, #215). */
export const SEVERE_CLASSES = [
  "fabrication",
  "uncertainty-promotion",
  "exact-detail-corruption",
  "negative-constraint",
  "branch-contamination",
  "recursive-drift",
];

export const ADVISORY_TYPE = "pi-square.context-memory/advisory";
export const PENDING_ACK = "Memory candidate accepted; compaction pending.";

export const TS = "2026-01-01T00:00:00.000Z";
export const IMAGE_B64 = "iVBORw0KGgo="; // 11 base64 characters → 8 decoded bytes

// ─── Zero-tolerance check recorder ─────────────────────────────────

const MESSAGE_LIMIT = 200;

/**
 * One bounded, sanitized failure excerpt. Fixture bodies carry {@link MARKER}
 * and padding runs, so both are collapsed before any text may enter a report;
 * control characters are escaped. The report self-check re-verifies this.
 */
export function boundedMessage(error) {
  let text = error && typeof error.message === "string" ? error.message : String(error ?? "unknown error");
  text = text.slice(0, MESSAGE_LIMIT);
  text = text.split(MARKER).join("‹body›");
  text = text.replace(/(.)\1{15,}/g, (match, char) => `${char}<×${match.length}>`);
  return text.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function createRecorder() {
  const checks = [];
  return {
    checks,
    /** Run one check to completion; a thrown assertion fails it. Never aborts the sweep. */
    async check(area, id, klass, run) {
      let ok = true;
      let message;
      try {
        await run();
      } catch (error) {
        ok = false;
        message = boundedMessage(error);
      }
      checks.push(ok ? { area, id, class: klass, ok } : { area, id, class: klass, ok, message });
      return ok;
    },
  };
}

// ─── Fake session trees ────────────────────────────────────────────

/**
 * A mutable fake Pi session tree with real parent-chain branch walking. The
 * controller's derivation resolves every range through `getBranch`, so the
 * corpus never needs a second memory store to prove branch behavior.
 */
export function fakeTree(entries, options = {}) {
  let list = [...entries];
  let leaf = options.leaf ?? (list.at(-1)?.id ?? null);
  const parentOf = () => list.at(-1)?.id ?? null;
  return {
    getLeafId: () => leaf,
    getBranch(fromId = leaf) {
      const byId = new Map(list.map((entry) => [entry.id, entry]));
      const path = [];
      const seen = new Set();
      let current = byId.get(fromId);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        path.push(current);
        current = current.parentId == null ? undefined : byId.get(current.parentId);
      }
      return path.reverse();
    },
    isPersisted: () => options.persisted !== false,
    branchTo(id) { leaf = id; },
    append(entry) { list.push(entry); leaf = entry.id; },
    appendAll(...next) { for (const entry of next) this.append(entry); },
    removeById(id) { list = list.filter((entry) => entry.id !== id); },
    replaceById(id, entry) { list = list.map((current) => (current.id === id ? entry : current)); },
    parentId: parentOf,
    get raw() { return list; },
  };
}

function messageEntry(id, parentId, message) {
  return { id, parentId, type: "message", timestamp: TS, message };
}

export function userEntry(id, parentId, content) {
  return messageEntry(id, parentId, { role: "user", content, timestamp: 1 });
}

/** Assistant entries carry provider metadata that must never surface in sources. */
export function assistantEntry(id, parentId, parts) {
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

export function toolResultEntry(id, parentId, toolName, text, isError = false) {
  return messageEntry(id, parentId, {
    role: "toolResult", toolCallId: `call-${id}`, toolName,
    content: [{ type: "text", text }], isError, timestamp: 1,
  });
}

export function customEntry(id, parentId, content) {
  return { id, parentId, type: "custom_message", timestamp: TS, customType: "pi-square/notice", content, display: false };
}

export function branchSummaryEntry(id, parentId, fromId, summary) {
  return { id, parentId, type: "branch_summary", timestamp: TS, fromId, summary };
}

/** A committed Context Memory compaction entry the way Pi's SessionManager saves one. */
export function memoryCompaction(id, parentId, { firstKeptEntryId, ends, bodies, summary, details, fromExtension = true }) {
  return {
    id, parentId, type: "compaction", timestamp: TS,
    summary: summary ?? format.composeMemorySummary(bodies),
    firstKeptEntryId,
    tokensBefore: 4321,
    details: details ?? {
      format: format.MEMORY_FORMAT_TAG,
      blocks: bodies.map((body, index) => ({
        endEntryId: ends[index],
        markdownBytes: Buffer.byteLength(body, "utf8"),
      })),
    },
    fromExtension,
  };
}

export function nativeCompaction(id, parentId, firstKeptEntryId, summary) {
  return {
    id, parentId, type: "compaction", timestamp: TS,
    summary, firstKeptEntryId, tokensBefore: 900, fromExtension: false,
  };
}

// ─── Fake Pi extension host ────────────────────────────────────────

export function createHarness(options = {}) {
  const {
    config = DUE_CONFIG,
    usage,
    activeTools = ["read", "bash"],
    isIdle = true,
    hostVersion,
    reserveTokens = RESERVE_TOKENS,
  } = options;
  // A fresh default per harness: traces mutate the usage object they pass (or
  // the default) to move a session across its threshold.
  const effectiveUsage = usage ?? { ...DEFAULT_USAGE };
  const tools = new Map();
  const events = new Map();
  let active = [...activeTools];
  const compactCalls = [];
  const notified = [];
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
      throw new Error("the qualification corpus never renders");
    },
    hostVersion: hostVersion ?? (() => host.SUPPORTED_PI_VERSION),
    reserveTokens: () => reserveTokens,
  });
  function baseContext(session, overrides = {}) {
    return {
      cwd: `/${MARKER.toLowerCase()}-project`,
      hasUI: false,
      mode: "rpc",
      sessionManager: session ?? { getBranch: () => [] },
      compact: () => { compactCalls.push(true); },
      getContextUsage: () => effectiveUsage,
      getSystemPrompt: () => "",
      isIdle: () => isIdle,
      hasPendingMessages: () => false,
      isProjectTrusted: () => true,
      ui: { notify: (text, level) => notified.push({ text, level }) },
      ...overrides,
    };
  }
  async function emit(name, event = {}, ctx = baseContext()) {
    let last;
    for (const handler of events.get(name) ?? []) {
      last = await handler(event, ctx);
    }
    return last;
  }
  return {
    pi, tools, events, registration, emit, compactCalls, notified, baseContext,
    activeTools: () => [...active],
  };
}

// ─── Trace helpers ─────────────────────────────────────────────────

/** Pi's own projection over a fake tree — the corpus never re-implements it. */
export function projectedMessages(session) {
  return buildSessionContext(session.getBranch(), session.getLeafId()).messages;
}

/** A sole `submit_memory` batch, the way the model's final message carries it. */
export function soleSubmitBatch(callId, body) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `${MARKER} done — submitting the Memory block` },
        { type: "toolCall", id: callId, name: "submit_memory", arguments: { markdown: body } },
      ],
    },
  };
}

/** Append one due run's persisted entries to the tree, like Pi does. */
export function pushDueRun(session, { request, assistant, result, callId, body, requestText }) {
  session.append(userEntry(request, session.parentId(), requestText));
  session.append(assistantEntry(assistant, session.parentId(), [
    { type: "text", text: `${MARKER} done — submitting the Memory block` },
    { type: "toolCall", id: callId, name: "submit_memory", arguments: { markdown: body } },
  ]));
  session.append(toolResultEntry(result, session.parentId(), "submit_memory", PENDING_ACK));
}

export function beforeCompactEvent(session, { firstKeptEntryId, tokensBefore = 4321, reason = "manual" } = {}) {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore, settings: {} },
    branchEntries: session.getBranch(),
    reason,
    willRetry: false,
    signal: undefined,
  };
}

/** Save the takeover's compaction the way Pi's SessionManager does, and confirm it. */
export async function commitTakeover(harness, session, ctx, takeover, { reason = "manual" } = {}) {
  const entry = {
    id: `c-${takeover.compaction.firstKeptEntryId}`, parentId: session.parentId(), type: "compaction", timestamp: TS,
    summary: takeover.compaction.summary, firstKeptEntryId: takeover.compaction.firstKeptEntryId,
    tokensBefore: takeover.compaction.tokensBefore, details: takeover.compaction.details, fromExtension: true,
  };
  session.append(entry);
  await harness.emit("session_compact", {
    type: "session_compact", compactionEntry: entry, fromExtension: true, reason, willRetry: false,
  }, ctx);
  return entry;
}

/** Read one block's complete source transcript through the model tool, page by page. */
export async function readWholeBlock(harness, ctx, block) {
  const read = harness.tools.get("read_memory_source");
  const pages = [];
  let page = 1;
  for (;;) {
    const result = await read.execute(`q:${block}:${page}`, { block, page }, undefined, undefined, ctx);
    pages.push(result.content[1].text);
    if (!result.details.hasMore) break;
    page += 1;
  }
  return pages.join("");
}
