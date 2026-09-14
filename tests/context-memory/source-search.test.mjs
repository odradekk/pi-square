import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const load = jiti(import.meta.url, { moduleCache: false });
const registerContextMemory = (await load("../../src/context-memory/index.ts")).default;
const {
  MEMORY_STATE_CUSTOM_TYPE,
  MEMORY_STATE_FORMAT_TAG,
} = await load("../../src/context-memory/format.ts");
const { CONTEXT_MEMORY_BLOCKS_TYPE } = await load("../../src/context-memory/view.ts");
const {
  MEMORY_SOURCE_PAGE_MAX_BYTES,
  paginateTranscript,
  renderSourceTranscript,
} = await load("../../src/context-memory/transcript.ts");
const {
  MEMORY_SEARCH_MAX_PAGE_ROWS,
  MEMORY_SEARCH_MATCH_CAP,
  MEMORY_SEARCH_RESPONSE_MAX_BYTES,
} = await load("../../src/context-memory/search.ts");
const { MEMORY_SEARCH_MAX_TERMS } = await load("../../src/context-memory/tools.ts");
const childToolNames = (await load("../../src/tool-catalog.ts")).childToolNames;

const ENABLED_CONFIG = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };

/**
 * #339 deterministic acceptance: the bounded `search_memory_source` surface
 * at the public behavior seam — the real registrar, the real in-memory
 * SessionManager tree, and the same renderer and paging contract the reading
 * tool serves. Covers term semantics (OR, case-insensitive, literal only),
 * scope selection, page grouping and ordering, excerpt provenance, the
 * response bounds with truthful truncation and incomplete outcomes, Chinese
 * and mixed-language text, case-offset mapping, cross-page and multi-byte
 * boundaries, protocol-artifact exclusion, the source-view binding with
 * stale rejection (append, rebuild-shaped change, sibling branch, session
 * change, native compaction supersession, and persisted reopen), and the
 * observational no-mutation contract.
 */

function harness(config = ENABLED_CONFIG, dependencies = {}) {
  const tools = new Map();
  const events = new Map();
  let active = ["read", "bash"];
  let recordingSession = null;
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
    registerMessageRenderer() {},
    appendEntry(customType, data) { recordingSession.appendCustomEntry(customType, data); },
  };
  const registration = registerContextMemory(pi, {
    configProvider: () => ({ contextMemory: config }),
    displayRuntimeProvider: () => {
      throw new Error("display runtime is not needed for in-memory session derivation");
    },
    reserveTokens: () => 16384,
    ...dependencies,
  });
  return {
    tools, events, registration, activeTools: () => [...active],
    recordInto(sm) { recordingSession = sm; },
    async emit(name, event, ctx) {
      if (ctx?.sessionManager?.appendCustomEntry) recordingSession = ctx.sessionManager;
      let last;
      for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
      return last;
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
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    isProjectTrusted: () => true,
  };
}

function seedMemoryState(sm, blocks) {
  sm.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, { format: MEMORY_STATE_FORMAT_TAG, blocks });
}

/** The standard two-block fixture: distinct facts per block, one page each. */
function seedTwoBlockSession(sm = SessionManager.inMemory("/project")) {
  sm.appendMessage({ role: "user", content: "walk me through the repo structure", timestamp: 1 });
  const firstEnd = sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "one entry point registers each feature module; the API key is sk-Alpha-77" },
      { type: "toolCall", id: "call-seed-read", name: "read", arguments: { path: "src/index.ts" } },
    ],
    stopReason: "toolUse", timestamp: 2,
  });
  const firstResult = sm.appendMessage({
    role: "toolResult", toolCallId: "call-seed-read", toolName: "read",
    content: [{ type: "text", text: "export default register()" }], isError: false, timestamp: 3,
  });
  sm.appendMessage({ role: "user", content: "现在修复登录流程 now fix the login flow", timestamp: 4 });
  const secondEnd = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "the session cookie was set after the redirect; 归档代码是 MARS-ROVER-77" }],
    stopReason: "stop", timestamp: 5,
  });
  sm.appendMessage({ role: "user", content: "ship it", timestamp: 6 });
  seedMemoryState(sm, [
    { endEntryId: firstResult, markdown: "# Repo tour\n\n- summary-only-needle-alpha", retainedEntryIds: [] },
    { endEntryId: secondEnd, markdown: "# Login fix\n\n- summary-only-needle-beta", retainedEntryIds: [] },
  ]);
  return { sm, firstResult, secondEnd };
}

function resultText(result) {
  return result.content.map((part) => part.text).join("\n");
}

try {
  // ── Registration: three parent-only tools, strict provider-compatible schemas ──

  {
    const session = harness();
    assert.deepEqual([...session.tools.keys()].sort(),
      ["compact_to_memory_block", "read_memory_source", "search_memory_source"]);
    const search = session.tools.get("search_memory_source");
    assert.equal(search.renderShell, "self", "search owns the shared display shell");
    assert.equal(typeof search.renderCall, "function");
    assert.equal(typeof search.renderResult, "function");
    assert.ok(!childToolNames.includes("search_memory_source"), "search stays out of the child catalog");

    assert.equal(search.parameters.type, "object");
    assert.equal(search.parameters.anyOf, undefined);
    assert.equal(search.parameters.oneOf, undefined);
    assert.equal(search.parameters.additionalProperties, false);
    assert.deepEqual(search.parameters.required, ["terms"]);
    assert.deepEqual(Object.keys(search.parameters.properties).sort(), ["block", "terms"]);
    assert.equal(search.parameters.properties.terms.type, "array");
    assert.equal(search.parameters.properties.terms.minItems, 1);
    assert.equal(search.parameters.properties.terms.maxItems, MEMORY_SEARCH_MAX_TERMS);

    const read = session.tools.get("read_memory_source");
    assert.deepEqual(read.parameters.required, ["block", "page"]);
    assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["block", "page", "view"],
      "the optional view parameter extends the read schema compatibly (#339)");
  }

  // #340's qualification-only capability arm keeps the definition registered
  // but never exposes search to the model, across every synchronization.
  {
    const { sm } = seedTwoBlockSession();
    const session = harness(ENABLED_CONFIG, { searchMemorySourceEnabled: false });
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.ok(session.tools.has("search_memory_source"));
    for (const event of ["agent_settled", "model_select", "session_tree", "session_compact"]) {
      await session.emit(event, { type: event }, ctx);
      assert.ok(session.activeTools().includes("read_memory_source"), `${event} retains source reading`);
      assert.ok(!session.activeTools().includes("search_memory_source"), `${event} cannot resurrect source search`);
    }
  }

  // ── Activation follows valid source reading ──

  {
    const { sm } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const active = session.activeTools();
    assert.ok(active.includes("read_memory_source"));
    assert.ok(active.includes("search_memory_source"), "valid Memory activates the search surface");
    assert.ok(active.includes("compact_to_memory_block"));
    assert.equal(active.indexOf("search_memory_source"), active.indexOf("read_memory_source") + 1,
      "search joins directly after the reading tool in the owned order");

    const search = session.tools.get("search_memory_source");

    // Navigation before every state entry deactivates both surfaces.
    sm.branch(sm.getBranch()[1].id);
    await session.emit("session_tree", { type: "session_tree", newLeafId: sm.getLeafId(), oldLeafId: sm.getLeafId() }, ctx);
    assert.ok(!session.activeTools().includes("search_memory_source"));
    await assert.rejects(
      () => search.execute("s:gone", { terms: ["anything"] }, undefined, undefined, ctx),
      (error) => /^MEMORY_NOT_AVAILABLE: /.test(error.message),
    );

    // Default-off configuration never activates any of the three tools.
    const offHarness = harness({ enabled: false, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 });
    await offHarness.emit("session_start", { type: "session_start", reason: "startup" }, commandContext(sm));
    assert.ok(!offHarness.activeTools().includes("search_memory_source"));
  }

  // ── Basic semantics: OR, case-insensitivity, block scope, grouping, order ──

  {
    const { sm } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const read = session.tools.get("read_memory_source");

    // Single term, case-insensitive, original casing preserved in the snippet.
    const alpha = await search.execute("s:alpha", { terms: ["SK-ALPHA-77"] }, undefined, undefined, ctx);
    assert.equal(alpha.details.complete, true);
    assert.equal(alpha.details.matchedTerms, 1);
    assert.equal(alpha.details.pageLocations, 1);
    assert.equal(alpha.details.totalMatches, 1);
    assert.equal(alpha.details.blocks.length, 2, "the default scope covers every current block");
    const alphaText = resultText(alpha);
    assert.ok(alphaText.includes('"SK-ALPHA-77"'), "matched-term attribution names the term");
    assert.ok(alphaText.includes("sk-Alpha-77"), "the snippet preserves original casing at the original location");
    assert.match(alphaText, /block 1 · page 1 of \d+/, "the row carries a directly readable block/page location");
    assert.match(alphaText, /view sv1-[0-9a-f]+/, "the result carries the opaque source-view token");
    assert.ok(!alphaText.includes(sm.getLeafId()), "entry ids never surface");

    // The referenced page is exactly what read_memory_source serves.
    const rowPage = /block 1 · page (\d+) of (\d+)/.exec(alphaText);
    const readBack = await read.execute("s:verify", { block: 1, page: Number(rowPage[1]) }, undefined, undefined, ctx);
    assert.ok(resultText(readBack).includes("sk-Alpha-77"),
      "the search location points at the page the reading tool serves");

    // Multi-term OR with Chinese and mixed-language text: two terms hitting
    // the same page group into one row that names both terms.
    const multi = await search.execute("s:multi", { terms: ["redirect", "归档代码", "nowhere-term"] }, undefined, undefined, ctx);
    assert.equal(multi.details.matchedTerms, 2, "the unmatched term does not count as matched");
    assert.equal(multi.details.pageLocations, 1, "both terms land on block 2's single page");
    assert.equal(multi.details.totalMatches, 2, "each term's occurrence is counted");
    const multiText = resultText(multi);
    assert.match(multiText, /block 2 · page 1 of \d+ · matched "redirect", "归档代码"/,
      "the row attributes both matched terms");
    assert.ok(multiText.includes("MARS-ROVER-77"), "the Chinese-adjacent mixed needle stays verbatim");
    assert.ok(multiText.includes("after the redirect"), "the English needle stays verbatim");

    // Terms matching different blocks produce rows in ascending block order.
    const spread = await search.execute("s:spread", { terms: ["sk-Alpha", "登录流程"] }, undefined, undefined, ctx);
    const spreadText = resultText(spread);
    const blockOne = spreadText.indexOf("block 1 ·");
    const blockTwo = spreadText.indexOf("block 2 ·");
    assert.ok(blockOne >= 0 && blockTwo > blockOne, "rows appear in ascending block order");

    // A Chinese term alone.
    const zh = await search.execute("s:zh", { terms: ["登录流程"] }, undefined, undefined, ctx);
    assert.equal(zh.details.totalMatches, 1);
    assert.ok(resultText(zh).includes("现在修复登录流程"), "original Chinese context is preserved exactly");

    // Block selector narrows the scope and reports it.
    const scoped = await search.execute("s:scoped", { terms: ["redirect"], block: 2 }, undefined, undefined, ctx);
    assert.deepEqual(scoped.details.blocks, [2]);
    assert.equal(scoped.details.pageLocations, 1);
    const scopedMiss = await search.execute("s:scoped-miss", { terms: ["sk-Alpha"], block: 2 }, undefined, undefined, ctx);
    assert.equal(scopedMiss.details.totalMatches, 0, "the block selector keeps block 1 out of scope");
    assert.equal(scopedMiss.details.complete, true);
    assert.match(resultText(scopedMiss), /no matches · scan complete/,
      "a complete zero-hit search states exactly that");
    await assert.rejects(
      () => search.execute("s:oor", { terms: ["x"], block: 3 }, undefined, undefined, ctx),
      (error) => /^BLOCK_OUT_OF_RANGE: /.test(error.message),
    );

    // Repeated matches on one page group into one row with an overflow note.
    const repeat = await search.execute("s:repeat", { terms: ["e"] }, undefined, undefined, ctx);
    const repeatText = resultText(repeat);
    const rows = repeatText.split("\n").filter((line) => /^block \d+ · /.test(line));
    assert.ok(rows.length > 0);
    assert.ok(repeat.details.totalMatches > rows.length,
      "repeated text does not create duplicate page rows");
    assert.match(repeatText, /\+\d+ more matches on this page/, "the overflow is visible and counted");

    // A term duplicated case-variants counts once.
    const deduped = await search.execute("s:dedupe", { terms: ["REDIRECT", "redirect"] }, undefined, undefined, ctx);
    assert.equal(deduped.details.terms, 1, "case-insensitive duplicate terms fold to one");
    assert.equal(deduped.details.matchedTerms, 1);

    // Summaries are never searched: the summary-only needles match nothing.
    const summaryOnly = await search.execute("s:summary", { terms: ["summary-only-needle-alpha"] }, undefined, undefined, ctx);
    assert.equal(summaryOnly.details.totalMatches, 0,
      "Memory Markdown summaries are not original-source evidence");
  }

  // ── Search input bounds ──

  {
    const { sm } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    await assert.rejects(
      () => search.execute("s:many", { terms: Array.from({ length: MEMORY_SEARCH_MAX_TERMS + 1 }, () => "x") }, undefined, undefined, ctx),
      (error) => /^SEARCH_INVALID_TERMS: /.test(error.message),
    );
    await assert.rejects(
      () => search.execute("s:long", { terms: ["x".repeat(121)] }, undefined, undefined, ctx),
      (error) => /^SEARCH_INVALID_TERMS: /.test(error.message),
    );
    await assert.rejects(
      () => search.execute("s:blank", { terms: ["   "] }, undefined, undefined, ctx),
      (error) => /^SEARCH_INVALID_TERMS: /.test(error.message),
    );
    await assert.rejects(
      () => search.execute("s:empty", { terms: [] }, undefined, undefined, ctx),
      (error) => /^SEARCH_INVALID_TERMS: /.test(error.message),
    );
    const exactlyMax = await search.execute("s:max", {
      terms: Array.from({ length: MEMORY_SEARCH_MAX_TERMS }, (_, i) => `distinct-term-${i}`),
    }, undefined, undefined, ctx);
    assert.equal(exactlyMax.details.terms, MEMORY_SEARCH_MAX_TERMS);
    assert.equal(exactlyMax.details.totalMatches, 0);
  }

  // ── Cross-page and multi-byte boundaries ──

  {
    // One block whose transcript exceeds one page, with a needle placed so
    // its UTF-8 bytes straddle the first page boundary.
    const sm = SessionManager.inMemory("/project");
    const needle = "CROSS-PAGE-NEEDLE-42";
    // Render one single-code-point content to learn the exact fixed prefix
    // (header + role label), then place the needle 12 bytes before the cut.
    const measure = renderSourceTranscript([{
      id: "measure", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "P", timestamp: 1 },
    }]);
    const fixedBytes = Buffer.byteLength(measure, "utf8") - 2; // minus "P" and the trailing newline
    const pad = MEMORY_SOURCE_PAGE_MAX_BYTES - 12 - fixedBytes;
    const straddling = `${"x".repeat(pad)}${needle}${"y".repeat(50)}`;
    const straddlingUser = sm.appendMessage({ role: "user", content: straddling, timestamp: 1 });
    sm.appendMessage({ role: "user", content: "current request", timestamp: 2 });
    seedMemoryState(sm, [{ endEntryId: straddlingUser, markdown: "# Straddle digest", retainedEntryIds: [] }]);

    // Sanity: the fixture really straddles the page boundary.
    const pages = paginateTranscript(renderSourceTranscript(sm.getBranch().slice(0, 1)
      .filter((entry) => entry.type === "message")));
    assert.ok(pages.length >= 2, "the straddling fixture spans at least two pages");
    assert.ok(pages[0].includes("CROSS-PAGE") && !pages[0].includes("NEEDLE-42"),
      "the needle is split across the page boundary");

    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const found = await search.execute("s:straddle", { terms: ["cross-page-needle-42"] }, undefined, undefined, ctx);
    assert.equal(found.details.totalMatches, 1, "a phrase crossing a page boundary stays discoverable");
    assert.equal(found.details.pageLocations, 1);
    const foundText = resultText(found);
    assert.match(foundText, /block 1 · pages 1–2 of \d+/, "the row names both pages");
    assert.match(foundText, /crosses a page boundary/, "the cross-page fact is stated");
    assert.ok(foundText.includes("CROSS-PAGE-NEEDLE-42"),
      "the snippet quotes the complete original phrase across the boundary");
    assert.ok(foundText.includes("…"), "clipped excerpts are visibly marked");
  }

  {
    // Multi-byte boundary: the page cut backs off inside a CJK phrase, and
    // the match still maps onto both pages.
    const sm = SessionManager.inMemory("/project");
    const measure = renderSourceTranscript([{
      id: "measure", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "P", timestamp: 1 },
    }]);
    const fixedBytes = Buffer.byteLength(measure, "utf8") - 2;
    // Place the phrase so the 16 KiB cut lands inside its second character —
    // the exact multi-byte case pagination backs off for.
    const target = MEMORY_SOURCE_PAGE_MAX_BYTES - 4;
    const cjkPadding = Math.floor((target - fixedBytes) / 3);
    const leftover = target - fixedBytes - cjkPadding * 3;
    const phrase = "短語跨界測試";
    const straddling = `${"x".repeat(leftover)}${"字".repeat(cjkPadding)}${phrase}${"文".repeat(30)}`;
    const straddlingUser = sm.appendMessage({ role: "user", content: straddling, timestamp: 1 });
    sm.appendMessage({ role: "user", content: "current request", timestamp: 2 });
    seedMemoryState(sm, [{ endEntryId: straddlingUser, markdown: "# CJK straddle digest", retainedEntryIds: [] }]);

    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const found = await search.execute("s:cjk", { terms: ["短語跨界"] }, undefined, undefined, ctx);
    assert.equal(found.details.totalMatches, 1, "a multi-byte phrase crossing the cut stays discoverable");
    const foundText = resultText(found);
    assert.match(foundText, /block 1 · pages 1–2 of \d+/, "both pages are identified");
    assert.ok(foundText.includes("短語跨界測試"), "the original multi-byte phrase is quoted whole");
  }

  // ── Response bounds: truncated results are truthful ──

  {
    // More matching pages than the row cap.
    const sm = SessionManager.inMemory("/project");
    for (let i = 0; i < MEMORY_SEARCH_MAX_PAGE_ROWS + 6; i++) {
      sm.appendMessage({
        role: "user",
        content: `distinct-page-fill-${i} ${"f".repeat(17_000)} carry-needle-here`,
        timestamp: i + 1,
      });
    }
    const lastCovered = sm.getBranch().at(-1).id;
    sm.appendMessage({ role: "user", content: "current request", timestamp: 999 });
    seedMemoryState(sm, [{ endEntryId: lastCovered, markdown: "# Many pages digest", retainedEntryIds: [] }]);

    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const capped = await search.execute("s:capped", { terms: ["carry-needle-here"] }, undefined, undefined, ctx);
    assert.equal(capped.details.complete, true, "display truncation is not an incomplete search");
    assert.ok(capped.details.pageLocations > MEMORY_SEARCH_MAX_PAGE_ROWS);
    assert.equal(capped.details.returnedLocations, MEMORY_SEARCH_MAX_PAGE_ROWS);
    assert.equal(capped.details.omittedLocations, capped.details.pageLocations - MEMORY_SEARCH_MAX_PAGE_ROWS);
    const cappedText = resultText(capped);
    assert.match(cappedText, /omitted by the response bound/, "omitted results are reported truthfully");
    assert.ok(Buffer.byteLength(cappedText, "utf8") <= MEMORY_SEARCH_RESPONSE_MAX_BYTES,
      "the complete response — header, rows, and footer — stays within the hard cap");
    const shownRows = cappedText.split("\n").filter((line) => /^block \d+ · /.test(line));
    assert.equal(shownRows.length, MEMORY_SEARCH_MAX_PAGE_ROWS);

    // A more specific term resolves the same needle completely.
    const narrowed = await search.execute("s:narrowed", { terms: ["distinct-page-fill-3"] }, undefined, undefined, ctx);
    assert.equal(narrowed.details.omittedLocations, 0);
    assert.equal(narrowed.details.pageLocations, 1);
    assert.equal(narrowed.details.totalMatches, 1);
  }

  {
    // The match cap stops the scan and reports an incomplete search.
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: `${"q".repeat(MEMORY_SEARCH_MATCH_CAP + 64)}`, timestamp: 1 });
    const covered = sm.getBranch().at(-1).id;
    sm.appendMessage({ role: "user", content: "current request", timestamp: 2 });
    seedMemoryState(sm, [{ endEntryId: covered, markdown: "# Flood digest", retainedEntryIds: [] }]);
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const flooded = await search.execute("s:flood", { terms: ["q"] }, undefined, undefined, ctx);
    assert.equal(flooded.details.complete, false, "the scan stopped at the match bound");
    assert.equal(flooded.details.totalMatches, MEMORY_SEARCH_MATCH_CAP);
    assert.match(resultText(flooded), /search incomplete · stopped at the \d+-match bound/,
      "an incomplete search is distinguishable from a zero-hit search");
  }

  // ── The source-view binding and stale rejection ──

  {
    const { sm, firstResult, secondEnd } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const read = session.tools.get("read_memory_source");

    const first = await search.execute("s:view1", { terms: ["redirect"] }, undefined, undefined, ctx);
    const view = first.details.view;
    assert.match(view, /^sv1-[0-9a-f]{24}$/);

    // A fresh read pinned to the view works and serves the same page.
    const pinned = await read.execute("s:pinned", { block: 2, page: 1, view }, undefined, undefined, ctx);
    assert.ok(resultText(pinned).includes("after the redirect"));

    // A blank view token behaves as absent (compatibility with loose callers).
    const blank = await read.execute("s:blank", { block: 2, page: 1, view: "   " }, undefined, undefined, ctx);
    assert.ok(resultText(blank).includes("after the redirect"));

    // Append one more block: the Memory view changes, the old token is stale.
    sm.appendMessage({ role: "user", content: "one more covered exchange", timestamp: 7 });
    const appendedEnd = sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "appended block body" }], stopReason: "stop", timestamp: 8,
    });
    seedMemoryState(sm, [
      { endEntryId: firstResult, markdown: "# Repo tour\n\n- summary-only-needle-alpha", retainedEntryIds: [] },
      { endEntryId: secondEnd, markdown: "# Login fix\n\n- summary-only-needle-beta", retainedEntryIds: [] },
      { endEntryId: appendedEnd, markdown: "# Third digest", retainedEntryIds: [] },
    ]);
    await session.emit("session_tree", { type: "session_tree", newLeafId: sm.getLeafId(), oldLeafId: sm.getLeafId() }, ctx);

    const secondSearch = await search.execute("s:view2", { terms: ["redirect"] }, undefined, undefined, ctx);
    assert.equal(secondSearch.details.blocks.length, 3, "the fresh search covers the new view");
    assert.notEqual(secondSearch.details.view, view, "a changed Memory view mints a new token");
    await assert.rejects(
      () => read.execute("s:stale", { block: 2, page: 1, view }, undefined, undefined, ctx),
      (error) => {
        assert.match(error.message, /^VIEW_STALE: /);
        assert.ok(!error.message.includes("after the redirect"), "the stale rejection never serves page content");
        return true;
      },
    );
    // Ordinary direct reads keep working under the changed view.
    const direct = await read.execute("s:direct", { block: 2, page: 1 }, undefined, undefined, ctx);
    assert.ok(resultText(direct).includes("after the redirect"),
      "direct block/page reads stay compatible without a view");
    // A fabricated token cannot masquerade as any valid view.
    await assert.rejects(
      () => read.execute("s:fake", { block: 2, page: 1, view: "sv1-deadbeefdeadbeefdeadbeef" }, undefined, undefined, ctx),
      (error) => /^VIEW_STALE: /.test(error.message),
    );
  }

  // ── Branch and session isolation of the view identity ──

  {
    const { sm, firstResult } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const home = await search.execute("s:home", { terms: ["redirect"] }, undefined, undefined, ctx);

    // A different session never shares the token, even with the same shape.
    const other = seedTwoBlockSession();
    const otherSession = harness();
    const otherCtx = commandContext(other.sm);
    await otherSession.emit("session_start", { type: "session_start", reason: "resume" }, otherCtx);
    const otherSearch = await otherSession.tools.get("search_memory_source")
      .execute("s:other", { terms: ["redirect"] }, undefined, undefined, otherCtx);
    assert.notEqual(otherSearch.details.view, home.details.view,
      "source-view tokens are per-derivation, never cross-session");

    // A sibling branch records its own state entry and mints its own view.
    sm.branch(firstResult);
    await session.emit("session_tree", { type: "session_tree", newLeafId: firstResult, oldLeafId: sm.getLeafId() }, ctx);
    const siblingEnd = sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "sibling branch work only" }], stopReason: "stop", timestamp: 9,
    });
    seedMemoryState(sm, [{ endEntryId: siblingEnd, markdown: "# Sibling digest", retainedEntryIds: [] }]);
    await session.emit("session_tree", { type: "session_tree", newLeafId: sm.getLeafId(), oldLeafId: firstResult }, ctx);
    const sibling = await search.execute("s:sibling", { terms: ["sibling"] }, undefined, undefined, ctx);
    assert.equal(sibling.details.totalMatches, 1);
    assert.notEqual(sibling.details.view, home.details.view, "a different Memory derivation mints a different view");
    await assert.rejects(
      () => session.tools.get("read_memory_source")
        .execute("s:cross", { block: 1, page: 1, view: home.details.view }, undefined, undefined, ctx),
      (error) => /^VIEW_STALE: /.test(error.message),
      "a sibling branch's search location cannot be replayed onto the other branch",
    );
  }

  // ── Protocol artifacts: search pairs are excluded as sources and pair-safe in requests ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "original covered request alpha", timestamp: 1 });
    const searchCall = sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "narration around the covered search round" },
        { type: "toolCall", id: "call-search-1", name: "search_memory_source", arguments: { terms: ["alpha"] } },
      ],
      stopReason: "toolUse", timestamp: 2,
    });
    const searchResult = sm.appendMessage({
      role: "toolResult", toolCallId: "call-search-1", toolName: "search_memory_source",
      content: [{ type: "text", text: "PROTOCOL-SEARCH-RESULT-NEEDLE appears only inside the search result body" }],
      isError: false, timestamp: 3,
    });
    const coveredEnd = sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "closing covered exchange" }], stopReason: "stop", timestamp: 4,
    });
    sm.appendMessage({ role: "user", content: "current request", timestamp: 5 });
    seedMemoryState(sm, [{ endEntryId: coveredEnd, markdown: "# Protocol digest", retainedEntryIds: [] }]);

    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");

    // The search result body is not original-source evidence.
    const ghost = await search.execute("s:ghost", { terms: ["PROTOCOL-SEARCH-RESULT-NEEDLE"] }, undefined, undefined, ctx);
    assert.equal(ghost.details.totalMatches, 0,
      "prior search result copies never become searchable original evidence");
    const readGhost = await search.execute("s:ghost2", { terms: ["original covered request alpha"] }, undefined, undefined, ctx);
    assert.equal(readGhost.details.totalMatches, 1, "the real original conversation stays searchable");

    // The covered search pair leaves the projected request whole — call and
    // result together, never a stranded half — exactly like a covered read.
    const rawRequest = sm.buildSessionContext().messages;
    const transformed = await session.emit("context", { type: "context", messages: rawRequest }, ctx);
    const serialized = JSON.stringify(transformed.messages);
    assert.ok(!serialized.includes("PROTOCOL-SEARCH-RESULT-NEEDLE"),
      "the covered search result leaves with its evicted exchange");
    assert.ok(!serialized.includes("call-search-1"),
      "the covered search call leaves together with its result");
    assert.ok(serialized.includes("current request"), "the working set stays raw");
    const carrier = transformed.messages.find((message) => message?.customType === CONTEXT_MEMORY_BLOCKS_TYPE);
    assert.ok(carrier, "the Memory carrier replaces the covered range");
  }

  // ── Searching is observational: no mutation, no compression invitation ──

  {
    // A plain session without ordinary tool batches, so the append selection
    // after the search is limited only by the observation gate under test.
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "walk me through the repo structure", timestamp: 1 });
    const coveredEnd = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "the session cookie was set after the redirect" }],
      stopReason: "stop", timestamp: 2,
    });
    sm.appendMessage({ role: "user", content: "ship it", timestamp: 3 });
    seedMemoryState(sm, [{ endEntryId: coveredEnd, markdown: "# First digest", retainedEntryIds: [] }]);
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const before = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    const beforeBranch = JSON.stringify(sm.getBranch().map((entry) => entry.id));

    await session.tools.get("search_memory_source")
      .execute("s:obs", { terms: ["redirect"] }, undefined, undefined, ctx);

    const after = session.registration.snapshot({ tokens: 40000, contextWindow: 200000 });
    assert.equal(JSON.stringify(before), JSON.stringify(after),
      "a search changes no snapshot state: no maintenance, no due change, no applied flag");
    assert.equal(beforeBranch, JSON.stringify(sm.getBranch().map((entry) => entry.id)),
      "a search writes nothing to the session");
    assert.equal(sm.getBranch().filter((entry) => entry.type === "custom" || entry.type === "compaction").length, 1,
      "the state entry count is unchanged — no sidecar or ledger was added");

    // A search never satisfies the source-serving observation gate: with no
    // provider-bound request observed since the eligible range appeared, a
    // compression attempt still refuses with SOURCE_NOT_SERVED.
    sm.appendMessage({ role: "user", content: "later eligible history for a second block", timestamp: 7 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "later covered answer with real substance" }],
      stopReason: "stop", timestamp: 8,
    });
    sm.appendMessage({ role: "user", content: "keep working on the follow-up", timestamp: 9 });
    await session.emit("agent_settled", { type: "agent_settled" }, ctx);
    await session.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-compact-obs", name: "compact_to_memory_block", arguments: {} }] },
    }, ctx);
    await assert.rejects(
      () => session.tools.get("compact_to_memory_block")
        .execute("call-compact-obs", { markdown: "# Never recorded\n\n- search did not serve sources" }, undefined, undefined, ctx),
      (error) => /^SOURCE_NOT_SERVED: /.test(error.message),
      "a search does not authorize compression through the source-serving gate",
    );
  }

  // ── Native compaction supersession: the search surface follows the new baseline ──

  {
    const { sm } = seedTwoBlockSession();
    sm.appendMessage({ role: "user", content: "one more round after the state entry", timestamp: 7 });
    const kept = sm.appendMessage({ role: "user", content: "kept tail anchor", timestamp: 8 });
    sm.appendCompaction("A plain native summary.", kept, 4000, undefined, false);
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    await session.emit("session_compact", {
      type: "session_compact",
      compactionEntry: sm.getBranch().at(-1),
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    }, ctx);
    assert.equal(session.registration.snapshot().state, "opaque");
    assert.ok(!session.activeTools().includes("search_memory_source"),
      "a superseding plain native compaction deactivates the search surface");
    await assert.rejects(
      () => session.tools.get("search_memory_source").execute("s:opaque", { terms: ["redirect"] }, undefined, undefined, ctx),
      (error) => /^MEMORY_NOT_AVAILABLE: /.test(error.message),
    );
  }

  // ── A rebuild-shaped Memory change mints a new view and stales the old one ──

  {
    // The recorded outcome of a suffix rebuild: one new state entry replaces
    // the newest adjacent block suffix with one block spanning the suffix's
    // originals plus new history. From the search surface's perspective the
    // contract is the derivation change itself.
    const { sm, firstResult } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const read = session.tools.get("read_memory_source");
    const before = await search.execute("s:pre-rebuild", { terms: ["redirect"] }, undefined, undefined, ctx);

    sm.appendMessage({ role: "user", content: "new eligible history inside the rebuilt range", timestamp: 7 });
    const rebuiltEnd = sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: "the rebuilt block body covers the suffix" }], stopReason: "stop", timestamp: 8,
    });
    seedMemoryState(sm, [
      { endEntryId: firstResult, markdown: "# Repo tour\n\n- summary-only-needle-alpha", retainedEntryIds: [] },
      { endEntryId: rebuiltEnd, markdown: "# Rebuilt digest\n\n- the merged suffix and new history", retainedEntryIds: [] },
    ]);
    await session.emit("session_tree", { type: "session_tree", newLeafId: sm.getLeafId(), oldLeafId: sm.getLeafId() }, ctx);

    const after = await search.execute("s:post-rebuild", { terms: ["rebuilt block body"] }, undefined, undefined, ctx);
    assert.equal(after.details.blocks.length, 2, "the rebuilt Memory derives with its new block list");
    assert.notEqual(after.details.view, before.details.view, "a rebuild changes the source view");
    await assert.rejects(
      () => read.execute("s:rebuild-stale", { block: 2, page: 1, view: before.details.view }, undefined, undefined, ctx),
      (error) => /^VIEW_STALE: /.test(error.message),
      "a pre-rebuild search reference cannot be replayed onto the rebuilt view",
    );
    const directAfterRebuild = await read.execute("s:rebuild-direct", { block: 2, page: 1 }, undefined, undefined, ctx);
    assert.ok(resultText(directAfterRebuild).includes("rebuilt block body"),
      "direct reads serve the rebuilt view without a token");
  }

  // ── Native session reopening: a fresh search works on the same valid view ──

  {
    const root = mkdtempSync(join(tmpdir(), "pi-square-source-search-reopen-"));
    const sm = SessionManager.create("/project", root);
    seedTwoBlockSession(sm);
    const { view: expectedView } = await (async () => {
      const session = harness();
      const ctx = commandContext(sm);
      await session.emit("session_start", { type: "session_start", reason: "new" }, ctx);
      const found = await session.tools.get("search_memory_source")
        .execute("s:pre-reopen", { terms: ["redirect"] }, undefined, undefined, ctx);
      return { view: found.details.view };
    })();

    const filesBefore = readdirSync(root).sort();
    const reopened = SessionManager.open(sm.getSessionFile(), root);
    const sessionTwo = harness();
    const ctxTwo = commandContext(reopened);
    await sessionTwo.emit("session_start", { type: "session_start", reason: "resume" }, ctxTwo);
    assert.ok(sessionTwo.activeTools().includes("search_memory_source"),
      "a reopened session with valid Memory re-activates the search surface");
    const afterReopen = await sessionTwo.tools.get("search_memory_source")
      .execute("s:post-reopen", { terms: ["redirect"] }, undefined, undefined, ctxTwo);
    assert.equal(afterReopen.details.totalMatches, 1);
    assert.equal(afterReopen.details.view, expectedView,
      "the same derivation on the reopened branch mints the same view token");
    await sessionTwo.tools.get("read_memory_source")
      .execute("s:reopen-read", { block: 2, page: 1, view: expectedView }, undefined, undefined, ctxTwo);

    // A post-reopen append stales the pre-reopen token across the reopen.
    reopened.appendMessage({ role: "user", content: "later exchange after reopening", timestamp: 9 });
    const appendedEnd = reopened.appendMessage({
      role: "assistant", content: [{ type: "text", text: "post-reopen covered answer" }], stopReason: "stop", timestamp: 10,
    });
    const branch = reopened.getBranch();
    const secondEnd = branch.find((entry) => entry.type === "message"
      && entry.message?.role === "assistant" && Array.isArray(entry.message.content)
      && entry.message.content.some((part) => part?.type === "text"
        && part.text.startsWith("the session cookie was set after the redirect")))?.id;
    const firstResult = branch.find((entry) => entry.type === "message"
      && entry.message?.role === "toolResult" && entry.message?.toolName === "read")?.id;
    seedMemoryState(reopened, [
      { endEntryId: firstResult, markdown: "# Repo tour\n\n- summary-only-needle-alpha", retainedEntryIds: [] },
      { endEntryId: secondEnd, markdown: "# Login fix\n\n- summary-only-needle-beta", retainedEntryIds: [] },
      { endEntryId: appendedEnd, markdown: "# Post-reopen digest", retainedEntryIds: [] },
    ]);
    await sessionTwo.emit("session_tree", { type: "session_tree", newLeafId: reopened.getLeafId(), oldLeafId: reopened.getLeafId() }, ctxTwo);
    const fresh = await sessionTwo.tools.get("search_memory_source")
      .execute("s:post-append", { terms: ["post-reopen covered answer"] }, undefined, undefined, ctxTwo);
    assert.equal(fresh.details.blocks.length, 3);
    assert.notEqual(fresh.details.view, expectedView, "the post-reopen append mints a new view");
    await assert.rejects(
      () => sessionTwo.tools.get("read_memory_source")
        .execute("s:reopen-stale", { block: 2, page: 1, view: expectedView }, undefined, undefined, ctxTwo),
      (error) => /^VIEW_STALE: /.test(error.message),
    );

    // Nothing durable was introduced beside Pi's own session files.
    const filesAfter = readdirSync(root).sort();
    assert.deepEqual(filesAfter, filesBefore,
      "searching writes no sidecar, index, or ledger beside the session file");
    rmSync(root, { recursive: true, force: true });
  }

  // ── The carrier stays byte-identical when only searches happen ──

  {
    const { sm } = seedTwoBlockSession();
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const first = await session.emit("context", { type: "context", messages: sm.buildSessionContext().messages }, ctx);
    await session.tools.get("search_memory_source").execute("s:quiet", { terms: ["redirect"] }, undefined, undefined, ctx);
    const second = await session.emit("context", { type: "context", messages: sm.buildSessionContext().messages }, ctx);
    assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages),
      "an unchanged Memory carrier is not altered by a search");
  }

  // ── Review regression: a rejected cross-boundary match never hides a valid
  //    overlapping candidate, and excerpts clip exactly at the boundary ──

  {
    // [text 'A', omitted search call, text 'A\nA'] renders 'A\nA\nA': the
    // first 'A\nA' occurrence crosses the omission boundary and is refused,
    // but the second text part itself contains the exact term and must hit.
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({ role: "user", content: "explore the overlapping batch", timestamp: 1 });
    const covered = sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "A" },
        { type: "toolCall", id: "overlapping-interrupted-search", name: "search_memory_source", arguments: { terms: ["clue"] } },
        { type: "text", text: "A\nA" },
      ],
      stopReason: "aborted", timestamp: 2,
    });
    sm.appendMessage({ role: "user", content: "current request", timestamp: 3 });
    seedMemoryState(sm, [{ endEntryId: covered, markdown: "# Overlap digest", retainedEntryIds: [] }]);
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const overlap = await search.execute("s:overlap", { terms: ["A\nA"] }, undefined, undefined, ctx);
    assert.equal(overlap.details.complete, true);
    assert.equal(overlap.details.totalMatches, 1,
      "the valid within-segment occurrence inside the second text part is found although the overlapping cross-boundary occurrence is refused");
    const overlapText = resultText(overlap);
    assert.ok(overlapText.includes("A\nA"), "the within-segment match renders its verbatim excerpt");
    assert.ok(!overlapText.includes("A\nA\nA"),
      "the excerpt never shows the cross-boundary run as one apparent phrase");
  }

  {
    // The excerpt right boundary: a match ending exactly at the omission
    // separator must clip in front of it — never join both sides. Excerpts
    // are multi-line, so the assertions read the full body, not one line.
    const buildSides = async (left, right) => {
      const sm = SessionManager.inMemory("/project");
      sm.appendMessage({ role: "user", content: "explore the excerpt boundary", timestamp: 1 });
      const covered = sm.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: left },
          { type: "toolCall", id: "excerpt-boundary-search", name: "search_memory_source", arguments: { terms: ["clue"] } },
          { type: "text", text: right },
        ],
        stopReason: "aborted", timestamp: 2,
      });
      sm.appendMessage({ role: "user", content: "current request", timestamp: 3 });
      seedMemoryState(sm, [{ endEntryId: covered, markdown: "# Excerpt digest", retainedEntryIds: [] }]);
      const session = harness();
      const ctx = commandContext(sm);
      await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
      return { search: session.tools.get("search_memory_source"), ctx };
    };

    // ASCII sides: exact-end right boundary and exact-start left boundary.
    {
      const { search, ctx } = await buildSides("LEFT-NEEDLE", "RIGHT-NEEDLE");
      const leftHit = await search.execute("s:left", { terms: ["LEFT-NEEDLE"] }, undefined, undefined, ctx);
      const leftText = resultText(leftHit);
      assert.ok(leftText.includes("LEFT-NEEDLE"), "the left side stays discoverable");
      assert.ok(!leftText.includes("RIGHT-NEEDLE"),
        "the left excerpt never includes the other side of the omission");
      assert.ok(/LEFT-NEEDLE…(\n|$)/.test(leftText),
        "the left excerpt ends with the visible clip marker exactly at the boundary");
      const rightHit = await search.execute("s:right", { terms: ["RIGHT-NEEDLE"] }, undefined, undefined, ctx);
      const rightText = resultText(rightHit);
      assert.ok(rightText.includes("RIGHT-NEEDLE"), "the right side stays discoverable");
      assert.ok(!rightText.includes("LEFT-NEEDLE"),
        "the right excerpt never includes the other side of the omission");
      assert.ok(/…(\n|\[assistant\]\n)?RIGHT-NEEDLE/.test(rightText),
        "the right excerpt opens with the visible clip marker exactly at the boundary");
    }

    // Unicode sides: the same clipping with multi-byte text.
    {
      const { search, ctx } = await buildSides("左针标记", "右针标记");
      const leftHit = await search.execute("s:zh-left", { terms: ["左针标记"] }, undefined, undefined, ctx);
      const leftText = resultText(leftHit);
      assert.ok(leftText.includes("左针标记"));
      assert.ok(!leftText.includes("右针标记"), "the Unicode left excerpt excludes the other side");
      assert.ok(/左针标记…(\n|$)/.test(leftText), "the Unicode left excerpt clips visibly at the boundary");
      const rightHit = await search.execute("s:zh-right", { terms: ["右针标记"] }, undefined, undefined, ctx);
      const rightText = resultText(rightHit);
      assert.ok(rightText.includes("右针标记"));
      assert.ok(!rightText.includes("左针标记"), "the Unicode right excerpt excludes the other side");
      assert.ok(rightText.includes("…右针标记"), "the Unicode right excerpt opens at the boundary");
    }
  }

  // ── Review regression: the complete response honors the 8 KiB hard cap ──

  {
    // The reviewer's reproduction: 18 dense CJK messages with two needle
    // occurrences each, all covered by one Memory block. The footer's status
    // and view lines, the newlines between content parts, and every count
    // must fit inside the published cap with truthful truncation counts.
    const sm = SessionManager.inMemory("/project");
    for (let i = 0; i < 18; i++) {
      sm.appendMessage({
        role: "user",
        content: "汉".repeat(5700) + " needle " + "字".repeat(100) + " needle " + "文".repeat(80),
        timestamp: i + 1,
      });
    }
    const covered = sm.getBranch().at(-1).id;
    sm.appendMessage({ role: "user", content: "current request", timestamp: 99 });
    seedMemoryState(sm, [{ endEntryId: covered, markdown: "# Dense digest", retainedEntryIds: [] }]);
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");
    const dense = await search.execute("s:dense", { terms: ["needle"] }, undefined, undefined, ctx);
    const denseText = dense.content.map((part) => part.text).join("\n");
    assert.ok(Buffer.byteLength(denseText, "utf8") <= MEMORY_SEARCH_RESPONSE_MAX_BYTES,
      `the joined content parts stay within ${MEMORY_SEARCH_RESPONSE_MAX_BYTES} bytes `
      + `(got ${Buffer.byteLength(denseText, "utf8")})`);
    assert.equal(dense.details.complete, true);
    assert.equal(dense.details.totalMatches, 36, "every match in the scanned scope is counted");
    assert.ok(dense.details.omittedLocations > 0, "rows dropped by the bound are reported as omitted");
    assert.equal(dense.details.pageLocations, dense.details.returnedLocations + dense.details.omittedLocations,
      "the location counts stay additive and truthful");
  }

  // ── Review regression: the term bound counts Unicode code points ──

  {
    const sm = SessionManager.inMemory("/project");
    sm.appendMessage({
      role: "user",
      content: "astral evidence 𐐀𐐀-MARKER and 😀😀-GLYPHS inside one message",
      timestamp: 1,
    });
    const covered = sm.getBranch().at(-1).id;
    sm.appendMessage({ role: "user", content: "current request", timestamp: 2 });
    seedMemoryState(sm, [{ endEntryId: covered, markdown: "# Astral digest", retainedEntryIds: [] }]);
    const session = harness();
    const ctx = commandContext(sm);
    await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
    const search = session.tools.get("search_memory_source");

    // 61 astral code points are 122 UTF-16 units but a legal 61-character term.
    const astral = await search.execute("s:astral", { terms: ["😀".repeat(61)] }, undefined, undefined, ctx);
    assert.equal(astral.details.terms, 1, "astral terms are bounded by code points, not UTF-16 units");

    // The exact boundaries: 120 code points pass on both planes, 121 refuse.
    const bmpAtBound = await search.execute("s:bmp-bound", { terms: ["漢".repeat(120)] }, undefined, undefined, ctx);
    assert.equal(bmpAtBound.details.complete, true, "120 BMP code points are a valid term");
    const astralAtBound = await search.execute("s:astral-bound", { terms: ["😀".repeat(120)] }, undefined, undefined, ctx);
    assert.equal(astralAtBound.details.complete, true, "120 astral code points are a valid term");
    await assert.rejects(
      () => search.execute("s:bmp-over", { terms: ["漢".repeat(121)] }, undefined, undefined, ctx),
      (error) => /^SEARCH_INVALID_TERMS: /.test(error.message),
    );
    await assert.rejects(
      () => search.execute("s:astral-over", { terms: ["😀".repeat(121)] }, undefined, undefined, ctx),
      (error) => /^SEARCH_INVALID_TERMS: /.test(error.message),
    );

    // Astral case folding still maps back onto the exact original text.
    const deseret = await search.execute("s:deseret", { terms: ["𐐨𐐨-marker"] }, undefined, undefined, ctx);
    assert.equal(deseret.details.totalMatches, 1, "case-insensitive matching folds astral code points");
    const deseretText = resultText(deseret);
    assert.ok(deseretText.includes("𐐀𐐀-MARKER"), "the snippet preserves the original astral casing");
    assert.ok(!deseretText.includes("𐐨𐐨-MARKER"), "the folded term never replaces the original text");
  }

  // ── Review regression: no match across omitted protocol content ──

  {
    // The reviewer's reproduction: an interrupted search call between two
    // text parts of one covered assistant message. The renderer joins the
    // surviving texts on adjacent lines; search must not treat that join as
    // continuous original text.
    const buildInterrupted = async (protocolName) => {
      const sm = SessionManager.inMemory("/project");
      sm.appendMessage({ role: "user", content: "explore the interrupted batch", timestamp: 1 });
      const carrier = sm.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "LEFT-NEEDLE" },
          { type: "toolCall", id: `synthetic-interrupted-${protocolName}`, name: protocolName, arguments: { terms: ["clue"] } },
          { type: "text", text: "RIGHT-NEEDLE" },
        ],
        stopReason: "aborted", timestamp: 2,
      });
      sm.appendMessage({ role: "user", content: "current request", timestamp: 3 });
      seedMemoryState(sm, [{ endEntryId: carrier, markdown: "# Interrupted digest", retainedEntryIds: [] }]);
      const session = harness();
      const ctx = commandContext(sm);
      await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
      return { session, ctx };
    };

    for (const protocolName of ["search_memory_source", "read_memory_source", "compact_to_memory_block"]) {
      const { session, ctx } = await buildInterrupted(protocolName);
      const search = session.tools.get("search_memory_source");
      const joined = await search.execute(`s:join-${protocolName}`, { terms: ["LEFT-NEEDLE\nRIGHT-NEEDLE"] }, undefined, undefined, ctx);
      assert.equal(joined.details.totalMatches, 0,
        `${protocolName}: no match is manufactured across the omitted call (including the interrupted, unanswered shape)`);
      assert.equal(joined.details.complete, true, "the refusal is a complete zero-hit search, not an error");
      for (const side of ["LEFT-NEEDLE", "RIGHT-NEEDLE"]) {
        const alone = await search.execute(`s:${side}`, { terms: [side] }, undefined, undefined, ctx);
        assert.equal(alone.details.totalMatches, 1, `${protocolName}: ${side} alone stays discoverable`);
        const excerpt = resultText(alone).split("\n").find((line) => line.startsWith("  · "));
        assert.ok(excerpt, `${protocolName}: ${side} renders an excerpt`);
        assert.ok(!excerpt.includes("LEFT-NEEDLE\nRIGHT-NEEDLE"),
          `${protocolName}: the excerpt never spans the omission join`);
        const other = side === "LEFT-NEEDLE" ? "RIGHT-NEEDLE" : "LEFT-NEEDLE";
        assert.ok(!excerpt.includes(other), `${protocolName}: the ${side} excerpt stays on its own side`);
      }
    }

    // Entry joins are never crossable either: an entire omitted protocol
    // exchange between two eligible entries must not become continuity.
    {
      const sm = SessionManager.inMemory("/project");
      sm.appendMessage({ role: "user", content: "ALPHA-ENTRY", timestamp: 1 });
      const protocolCall = sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "whole-exchange-search", name: "search_memory_source", arguments: { terms: ["x"] } }],
        stopReason: "toolUse", timestamp: 2,
      });
      sm.appendMessage({
        role: "toolResult", toolCallId: "whole-exchange-search", toolName: "search_memory_source",
        content: [{ type: "text", text: "WHOLE-EXCHANGE-RESULT" }], isError: false, timestamp: 3,
      });
      const covered = sm.appendMessage({ role: "user", content: "BETA-ENTRY", timestamp: 4 });
      sm.appendMessage({ role: "user", content: "current request", timestamp: 5 });
      seedMemoryState(sm, [{ endEntryId: covered, markdown: "# Entry-join digest", retainedEntryIds: [] }]);
      const session = harness();
      const ctx = commandContext(sm);
      await session.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
      const search = session.tools.get("search_memory_source");

      // The omitted exchange is ineligible as a whole; ALPHA and BETA derive
      // as adjacent sources whose rendered join carries the role framing.
      const spanning = await search.execute("s:entry-span", {
        terms: ["ALPHA-ENTRY\n\n[user]\nBETA-ENTRY"],
      }, undefined, undefined, ctx);
      assert.equal(spanning.details.totalMatches, 0,
        "no match spans the entry join that hides an omitted protocol exchange");
      const alpha = await search.execute("s:alpha", { terms: ["ALPHA-ENTRY"] }, undefined, undefined, ctx);
      assert.equal(alpha.details.totalMatches, 1);
      const alphaExcerpt = resultText(alpha).split("\n").find((line) => line.startsWith("  · "));
      assert.ok(!alphaExcerpt.includes("BETA-ENTRY"), "the excerpt stays inside one entry's rendering");

      // The retrieval copy itself is never original evidence.
      const ghost = await search.execute("s:entry-ghost", { terms: ["WHOLE-EXCHANGE-RESULT"] }, undefined, undefined, ctx);
      assert.equal(ghost.details.totalMatches, 0);

      // Within one entry, genuinely continuous multi-line text stays matchable.
      const sm2 = SessionManager.inMemory("/project");
      sm2.appendMessage({ role: "user", content: "first line of a continuous quote\nsecond line of the same message", timestamp: 1 });
      const covered2 = sm2.getBranch().at(-1).id;
      sm2.appendMessage({ role: "user", content: "current request", timestamp: 2 });
      seedMemoryState(sm2, [{ endEntryId: covered2, markdown: "# Multiline digest", retainedEntryIds: [] }]);
      const session2 = harness();
      const ctx2 = commandContext(sm2);
      await session2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
      const multiline = await session2.tools.get("search_memory_source")
        .execute("s:multiline", { terms: ["continuous quote\nsecond line"] }, undefined, undefined, ctx2);
      assert.equal(multiline.details.totalMatches, 1,
        "a multi-line term inside one continuous source segment still matches");
    }
  }

  console.log("context-memory source-search: all assertions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
