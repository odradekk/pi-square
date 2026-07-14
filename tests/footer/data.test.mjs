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
