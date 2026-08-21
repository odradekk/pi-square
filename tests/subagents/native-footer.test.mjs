import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import jiti from "jiti";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { renderNativeSubagentStatus } = await load(join(packageRoot, "src", "subagents", "status.ts"));
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

function backgroundJob(id, name, call) {
  return {
    id,
    status: "running",
    createdAt: 1,
    updatedAt: 2,
    details: {
      agent: { name },
      timeline: [
        { kind: "tool", phase: "start", text: call },
        { kind: "tool", phase: "end", text: "SECRET TOOL RESULT" },
      ],
    },
  };
}

const session = {
  state: {
    model: { id: "gpt-test", provider: "test-provider", reasoning: true, contextWindow: 200_000 },
    thinkingLevel: "high",
  },
  sessionManager: {
    getEntries() {
      return [{
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
    },
    getCwd() { return packageRoot; },
    getSessionName() { return "native-footer"; },
  },
  getContextUsage() { return { percent: 75, contextWindow: 200_000 }; },
  modelRegistry: { isUsingOAuth() { return false; }, getProvider() { return undefined; } },
  // Pi 0.84.2's native footer reads the subscription marker from modelRuntime.
  modelRuntime: { isUsingSubscription() { return false; } },
};

for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
  const activeTheme = loadThemeFromPath(join(packageRoot, "themes", file));
  setThemeInstance(activeTheme);
  const jobs = [
    backgroundJob("subagent_11111111-1111-4111-8111-111111111111", "explorer", "rg statusline in src"),
    backgroundJob("subagent_22222222-2222-4222-8222-222222222222", "oracle", "read password=private-value"),
  ];
  const status = renderNativeSubagentStatus(activeTheme, jobs);
  const statuses = new Map([["pi-square.subagents", status]]);
  const footer = new FooterComponent(session, {
    getGitBranch() { return "main"; },
    getExtensionStatuses() { return statuses; },
    getAvailableProviderCount() { return 2; },
    onBranchChange() { return () => {}; },
  });

  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = footer.render(width);
    assert.equal(lines.length, 3, `${file} at ${width} columns must use the native two rows plus status row`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} footer exceeded ${width} columns`);
    const plain = lines.map((line) => stripVTControlCharacters(line));
    assert.match(plain[0], /pi-square|\.\.\./);
    assert.match(plain[1], /75\.0%|\.\.\./);
    assert.match(plain[2], /^subagents 2/);
    assert.doesNotMatch(plain[2], /SECRET TOOL RESULT|private-value/);
  }
}

console.log("native Pi footer integration: dark/light themes at every display boundary width OK");
