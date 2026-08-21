import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import jiti from "jiti";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { collectEnhancedFooterSnapshot } = await load(join(packageRoot, "src", "footer", "data.ts"));
const { renderEnhancedFooter } = await load(join(packageRoot, "src", "footer", "render.ts"));
const themeModulePath = pathToFileURL(join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath, setThemeInstance } = await import(themeModulePath);

initTheme();
const activeTheme = loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json"));
setThemeInstance(activeTheme);

const model = { id: "gpt-test", name: "GPT Test", provider: "test-provider", reasoning: true, contextWindow: 200_000 };
const entries = [{
  type: "message",
  message: {
    role: "assistant",
    usage: {
      input: 1_200,
      output: 300,
      cacheRead: 800,
      cacheWrite: 100,
      cost: { total: 0.012 },
    },
  },
}];
const sessionManager = {
  getEntries() { return entries; },
  getCwd() { return packageRoot; },
  getSessionName() { return "native-parity"; },
};
// Pi 0.84.2 resolves the footer subscription marker through
// modelRuntime.isUsingSubscription, while an extension can only recompose it
// from the registry. Both fakes report the same answer so the parity assertion
// compares rendering rather than diverging inputs.
const modelRegistry = {
  isUsingOAuth() { return false; },
  getProvider() { return undefined; },
};
const modelRuntime = { isUsingSubscription() { return false; } };
const contextUsage = { percent: 75, contextWindow: 200_000 };
const footerData = {
  getGitBranch() { return "main"; },
  getExtensionStatuses() { return new Map(); },
  getAvailableProviderCount() { return 2; },
  onBranchChange() { return () => {}; },
};
const ctx = {
  model,
  modelRegistry,
  sessionManager,
  getContextUsage() { return contextUsage; },
};
const pi = { getThinkingLevel() { return "high"; } };
const snapshot = collectEnhancedFooterSnapshot(ctx, pi, footerData);
const enhanced = renderEnhancedFooter(activeTheme, 160, snapshot).map((line) => stripVTControlCharacters(line)).join("\n");

const nativeSession = {
  state: { model, thinkingLevel: "high" },
  sessionManager,
  modelRegistry,
  modelRuntime,
  getContextUsage() { return contextUsage; },
};
const native = new FooterComponent(nativeSession, footerData)
  .render(160)
  .map((line) => stripVTControlCharacters(line))
  .join("\n");

for (const value of ["pi-square", "main", "native-parity", "test-provider", "↑1.2k", "↓300", "R800", "W100", "$0.012", "200k"]) {
  assert.ok(native.includes(value), `native footer missing ${value}`);
  assert.ok(enhanced.includes(value), `enhanced footer missing ${value}`);
}
assert.match(native, /gpt-test.*high/);
assert.match(enhanced, /GPT Test.*HIGH/);
assert.match(native, /75\.0%/);
assert.match(enhanced, /75%/);
assert.equal(snapshot.usage.latestCacheHitRate, (800 / 2_100) * 100);

console.log("enhanced footer parity: Pi native project, model, usage, cost, and context semantics OK");
