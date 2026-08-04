import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import jiti from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { formatFooterCwd, formatFooterTokens, renderEnhancedFooter } = await load(join(packageRoot, "src", "footer", "render.ts"));
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
const { loadThemeFromPath } = await import(themeModulePath);

function snapshot(overrides = {}) {
  return {
    cwd: packageRoot,
    branch: "main",
    sessionName: "footer-modernization",
    modelName: "GPT 5.6 Sol",
    provider: "ccr-gpt",
    showProvider: true,
    thinkingLevel: "high",
    reasoning: true,
    subscription: false,
    usage: {
      input: 12_400,
      output: 2_100,
      cacheRead: 8_200,
      cacheWrite: 100,
      cost: 0.014,
      latestCacheHitRate: 80.4,
    },
    contextPercent: 68,
    contextWindow: 200_000,
    statuses: [],
    ...overrides,
  };
}

assert.equal(formatFooterTokens(999), "999");
assert.equal(formatFooterTokens(1_200), "1.2k");
assert.equal(formatFooterTokens(12_400), "12k");
assert.equal(formatFooterTokens(1_200_000), "1.2M");
assert.equal(formatFooterCwd("/home/example/work", "/home/example"), "~/work");
assert.equal(formatFooterCwd("/srv/work", "/home/example"), "/srv/work");

for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
  const theme = loadThemeFromPath(join(packageRoot, "themes", file));
  const styledSubagents = `${theme.fg("muted", "subagents 1")} ${theme.fg("accent", "explorer")} ${theme.fg("warning", "running")}`;
  const current = snapshot({
    statuses: [
      { key: "z-other", text: "\u001b[31mready\nnow\u001b[0m" },
      { key: "pi-square.subagents", text: styledSubagents },
    ],
  });

  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = renderEnhancedFooter(theme, width, current);
    assert.equal(lines.length, 3, `${file} at ${width} must include the conditional status row`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width} columns`);
    const plain = lines.map((line) => stripVTControlCharacters(line));
    assert.match(plain[0], /pi-square/);
    assert.match(plain[0], /GPT 5\.6 Sol/);
    assert.match(plain.join("\n"), /HIGH/);
    assert.match(plain[1], /Context/);
    assert.match(plain[1], /68%/);
    assert.match(plain[2], /^! subagents 1/);
    assert.match(plain[2], /ready now|ready|\.\.\.$/);
    assert.doesNotMatch(plain[2], /\r|\n|\t|\u001b/);

    if (width >= 100) {
      assert.match(plain[0], /ccr-gpt \/ GPT 5\.6 Sol/);
      assert.match(plain[0], /footer-modernization/);
      assert.match(plain[1], /↑12k/);
      assert.match(plain[1], /Cache R8\.2k W100 80%/);
      assert.match(plain[1], /\$0\.014/);
      assert.match(plain[1], /200k/);
    } else if (width >= 64) {
      assert.doesNotMatch(plain[0], /ccr-gpt|footer-modernization/);
      assert.match(plain[1], /↑12k/);
      assert.match(plain[1], /R8\.2k W100 80%/);
      assert.match(plain[1], /\$0\.014/);
      assert.match(plain[1], /68%/);
    } else {
      assert.doesNotMatch(plain[0], /ccr-gpt|footer-modernization/);
      assert.doesNotMatch(plain[1], /↑12k|Cache|\$0\.014/);
      assert.match(plain[1], /HIGH/);
    }
  }
}

const privacy = snapshot({
  branch: "api_key=branch-secret",
  sessionName: "\x1b]0;owned\x07",
  provider: "Bearer provider-secret",
  modelName: "ghp_MODELSECRET",
  statuses: [{ key: "external", text: "password=status-secret" }],
});
const privacyText = stripVTControlCharacters(renderEnhancedFooter(
  loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json")),
  120,
  privacy,
).join("\n"));
assert.doesNotMatch(privacyText, /branch-secret|provider-secret|MODELSECRET|status-secret|owned/);
assert.match(privacyText, /\[REDACTED\]/);

function trackingTheme() {
  const calls = [];
  return {
    calls,
    fg(color, text) { calls.push({ color, text: String(text) }); return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

for (const [percent, expected] of [[70, "accent"], [71, "warning"], [91, "error"]]) {
  const theme = trackingTheme();
  renderEnhancedFooter(theme, 120, snapshot({ contextPercent: percent }));
  assert.ok(theme.calls.some((call) => call.color === expected && call.text === `${percent}%`));
}

const withoutStatuses = renderEnhancedFooter(trackingTheme(), 80, snapshot({ statuses: [] }));
assert.equal(withoutStatuses.length, 2);

console.log("operational footer rendering: dark/light layouts at every display boundary width OK");
