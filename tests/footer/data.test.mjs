import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { collectEnhancedFooterSnapshot } = await load(join(packageRoot, "src", "footer", "data.ts"));

const entries = [
  {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 900,
        cacheWrite: 0,
        cost: { total: 0.01 },
      },
    },
  },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "ignored" }] } },
  {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 200,
        output: 30,
        cacheRead: 300,
        cacheWrite: 100,
        cost: 0.02,
      },
    },
  },
];
const statuses = new Map([
  ["other", "ready"],
  ["pi-square.subagents", "subagents 1"],
]);
const ctx = {
  model: {
    id: "gpt-test",
    name: "GPT Test",
    provider: "test-provider",
    reasoning: true,
    contextWindow: 200_000,
  },
  modelRegistry: { isUsingOAuth() { return true; } },
  sessionManager: {
    getEntries() { return entries; },
    getCwd() { return "/workspace/project"; },
    getSessionName() { return "footer-test"; },
  },
  getContextUsage() { return { percent: 72.5, contextWindow: 180_000 }; },
};
const footerData = {
  getGitBranch() { return "main"; },
  getExtensionStatuses() { return statuses; },
  getAvailableProviderCount() { return 2; },
  onBranchChange() { return () => {}; },
};
const snapshot = collectEnhancedFooterSnapshot(ctx, { getThinkingLevel() { return "high"; } }, footerData);

assert.deepEqual(snapshot.usage, {
  input: 300,
  output: 50,
  cacheRead: 1_200,
  cacheWrite: 100,
  cost: 0.03,
  latestCacheHitRate: 50,
});
assert.equal(snapshot.cwd, "/workspace/project");
assert.equal(snapshot.branch, "main");
assert.equal(snapshot.sessionName, "footer-test");
assert.equal(snapshot.modelName, "GPT Test");
assert.equal(snapshot.provider, "test-provider");
assert.equal(snapshot.showProvider, true);
assert.equal(snapshot.thinkingLevel, "high");
assert.equal(snapshot.reasoning, true);
assert.equal(snapshot.subscription, true);
assert.equal(snapshot.contextPercent, 72.5);
assert.equal(snapshot.contextWindow, 180_000);
assert.deepEqual(snapshot.statuses, [
  { key: "other", text: "ready" },
  { key: "pi-square.subagents", text: "subagents 1" },
]);

const empty = collectEnhancedFooterSnapshot({
  ...ctx,
  model: undefined,
  sessionManager: {
    getEntries() { return []; },
    getCwd() { return "/tmp"; },
    getSessionName() { return undefined; },
  },
  getContextUsage() { return undefined; },
}, { getThinkingLevel() { return "off"; } }, {
  ...footerData,
  getGitBranch() { return null; },
  getExtensionStatuses() { return new Map(); },
  getAvailableProviderCount() { return 1; },
});
assert.equal(empty.modelName, "no-model");
assert.equal(empty.provider, undefined);
assert.equal(empty.contextPercent, null);
assert.equal(empty.contextWindow, 0);
assert.equal(empty.subscription, false);
assert.deepEqual(empty.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

console.log("enhanced footer data: native cumulative semantics OK");

// --- FooterSnapshotProvider cache contract ---
//
// The session is append-only, so a stable entry count means no new entries.
// The provider must reuse cached usage totals and session name without
// scanning entries again, and must recompute after a new entry is appended.
const { FooterSnapshotProvider } = await load(join(packageRoot, "src", "footer", "data.ts"));

function makeEntry(usage) {
  return {
    type: "message",
    message: { role: "assistant", usage },
  };
}

let getEntriesCalls = 0;
let getSessionNameCalls = 0;
let mutableEntries = [
  makeEntry({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } }),
  { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
];
const memoCtx = {
  model: { id: "m", name: "M", provider: "p", reasoning: false, contextWindow: 100_000 },
  modelRegistry: { isUsingOAuth() { return false; } },
  sessionManager: {
    getEntries() { getEntriesCalls += 1; return [...mutableEntries]; },
    getCwd() { return "/proj"; },
    getSessionName() { getSessionNameCalls += 1; return "memo-test"; },
  },
  getContextUsage() { return { percent: 50, contextWindow: 100_000 }; },
};
const memoFooterData = {
  getGitBranch() { return "dev"; },
  getExtensionStatuses() { return new Map(); },
  getAvailableProviderCount() { return 1; },
  onBranchChange() { return () => {}; },
};
const memoPi = { getThinkingLevel() { return "off"; } };

const provider = new FooterSnapshotProvider();

// First snapshot: scans entries and resolves the session name.
getEntriesCalls = 0;
getSessionNameCalls = 0;
const first = provider.snapshot(memoCtx, memoPi, memoFooterData);
assert.equal(first.usage.input, 100);
assert.equal(first.usage.cost, 0.01);
assert.equal(first.sessionName, "memo-test");
assert.equal(getEntriesCalls, 1, "first snapshot reads the entries");
assert.equal(getSessionNameCalls, 1, "first snapshot resolves the session name");

// Second snapshot with the same entry count: getEntries() still runs
// (the SDK exposes no cheaper entry-count API), but the expensive usage
// scan and the session name lookup are skipped. The cached usage object
// is reused by reference identity.
getEntriesCalls = 0;
getSessionNameCalls = 0;
const second = provider.snapshot(memoCtx, memoPi, memoFooterData);
assert.equal(getEntriesCalls, 1, "getEntries runs each frame to read the count");
assert.equal(getSessionNameCalls, 0, "repeated snapshot with unchanged entries does not scan the session name");
assert.equal(second.usage, first.usage, "cached usage totals are reused by reference identity");

// Append a new assistant entry: the entry count changes, so the provider
// recomputes totals, cost, and cache hit rate.
getSessionNameCalls = 0;
mutableEntries.push(makeEntry({ input: 200, output: 30, cacheRead: 300, cacheWrite: 100, cost: 0.02 }));
const afterAppend = provider.snapshot(memoCtx, memoPi, memoFooterData);
assert.equal(afterAppend.usage.input, 300, "new entry updates input totals");
assert.equal(afterAppend.usage.output, 50, "new entry updates output totals");
assert.equal(afterAppend.usage.cost, 0.03, "new entry updates cost");
assert.equal(afterAppend.usage.latestCacheHitRate, 50, "new entry updates the cache hit rate");
assert.notEqual(afterAppend.usage, second.usage, "new entry produces a freshly computed usage object");
assert.equal(getSessionNameCalls, 1, "entry count change re-resolves the session name");

// The provider holds no persisted counter: a fresh instance starts empty.
const fresh = new FooterSnapshotProvider();
const freshSnapshot = fresh.snapshot(memoCtx, memoPi, memoFooterData);
assert.deepEqual(freshSnapshot.usage, afterAppend.usage, "a fresh provider recomputes from scratch");

console.log("footer snapshot provider cache contract: OK");
