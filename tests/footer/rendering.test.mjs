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

// ─── Layout: model/provider/thinking | usage/cache/cost; Loc | context ─
for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
  const theme = loadThemeFromPath(join(packageRoot, "themes", file));
  const styledSubagents = `${theme.fg("muted", "subagents 1")} ${theme.fg("accent", "explorer")} ${theme.fg("warning", "running")}`;

  // Test without statuses first — should be exactly 2 lines
  const noStatus = snapshot({ statuses: [] });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = renderEnhancedFooter(theme, width, noStatus);
    assert.equal(lines.length, 2, `${file} at ${width} must be 2 lines without statuses`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width} columns`);
  }

  // Test with statuses — should be exactly 3 lines
  const withStatus = snapshot({
    statuses: [
      { key: "z-other", text: "\u001b[31mready\nnow\u001b[0m" },
      { key: "pi-square.subagents", text: styledSubagents },
    ],
  });
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = renderEnhancedFooter(theme, width, withStatus);
    assert.equal(lines.length, 3, `${file} at ${width} must include the conditional status row`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width} columns`);
    const plain = lines.map((line) => stripVTControlCharacters(line));

    // Row 1: model and thinking
    assert.match(plain[0], /GPT 5\.6 Sol/, `${file} at ${width}: row 1 has model`);
    assert.match(plain.join("\n"), /HIGH/, `${file} at ${width}: thinking level visible`);

    // Row 2: Context
    assert.match(plain[1], /Context/, `${file} at ${width}: row 2 has Context`);
    assert.match(plain[1], /68%/, `${file} at ${width}: row 2 has context percent`);

    // Row 3: status with per-status markers
    assert.match(plain[2], /●/, `${file} at ${width}: subagent status has ● marker`);
    assert.match(plain[2], /subagents 1/, `${file} at ${width}: subagent text visible`);
    assert.doesNotMatch(plain[2], /\r|\n|\t|\u001b/, `${file} at ${width}: no control chars in status`);

    if (width >= 100) {
      // Wide: full provider/model, Loc with path+branch+session, usage+cache+cost+window
      assert.match(plain[0], /GPT 5\.6 Sol \/ ccr-gpt/, `${file} wide: provider/model`);
      assert.match(plain[0], /↑12k/, `${file} wide: input usage on row 1`);
      assert.match(plain[0], /Cache R8\.2k W100 80%/, `${file} wide: cache on row 1`);
      assert.match(plain[0], /\$0\.014/, `${file} wide: cost on row 1`);
      assert.match(plain[1], /Loc:/, `${file} wide: Loc label`);
      assert.match(plain[1], /footer-modernization/, `${file} wide: session name`);
      assert.match(plain[1], /200k/, `${file} wide: context window`);
    } else if (width >= 64) {
      // Medium: model only (no provider), usage+cache+cost, context bar
      assert.doesNotMatch(plain[0], /ccr-gpt/, `${file} medium: no provider`);
      assert.match(plain[0], /↑12k/, `${file} medium: input usage on row 1`);
      assert.match(plain[0], /R8\.2k W100 80%/, `${file} medium: cache on row 1`);
      assert.match(plain[0], /\$0\.014/, `${file} medium: cost on row 1`);
      assert.match(plain[1], /Loc:/, `${file} medium: Loc label`);
      assert.match(plain[1], /68%/, `${file} medium: context percent`);
    } else {
      // Narrow: model only, context bar with thinking
      assert.doesNotMatch(plain[0], /ccr-gpt/, `${file} narrow: no provider`);
      assert.doesNotMatch(plain[0], /↑12k|Cache|\$0\.014/, `${file} narrow: no usage on row 1`);
      assert.match(plain[1], /HIGH/, `${file} narrow: thinking level on row 2`);
    }
  }
}

// ─── Privacy: credential redaction ──────────────────────────────────
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

// ─── Context color thresholds ───────────────────────────────────────
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

// ─── Without statuses: exactly 2 lines ──────────────────────────────
const withoutStatuses = renderEnhancedFooter(trackingTheme(), 80, snapshot({ statuses: [] }));
assert.equal(withoutStatuses.length, 2);

// ─── Per-status markers: ● for subagents, ! for display diagnostics ─
{
  const theme = trackingTheme();
  const lines = renderEnhancedFooter(theme, 120, snapshot({
    statuses: [
      { key: "pi-square.subagents", text: "subagents 2" },
      { key: "pi-square.display", text: "Ownership conflict" },
    ],
  }));
  const plain = stripVTControlCharacters(lines[2]);
  assert.match(plain, /●/, "subagent status uses ● marker");
  assert.match(plain, /!/, "display diagnostic uses ! marker");
  assert.match(plain, /Ownership conflict/, "display diagnostic text visible");
}

// ─── Subagent status through the production footer path ───────────
{
  const darkTheme = loadThemeFromPath(join(packageRoot, "themes", "pi-square-theme-dark.json"));
  const subagentStatus = {
    key: "pi-square.subagents",
    text: "subagents 1 │ explorer aabbccdd ● running · rg pattern in src",
  };
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = renderEnhancedFooter(darkTheme, width, snapshot({ statuses: [subagentStatus] }));
    assert.equal(lines.length, 3, `status row at ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `bounded at ${width}`);
    const plain = stripVTControlCharacters(lines[2]);
    assert.match(plain, /●/, `subagent marker at ${width}`);
    assert.match(plain, /subagents 1/, `subagent count at ${width}`);
  }
}

// ─── Subagent status ordering: subagent before display before generic ─
{
  const theme = trackingTheme();
  const lines = renderEnhancedFooter(theme, 120, snapshot({
    statuses: [
      { key: "z-other", text: "generic" },
      { key: "pi-square.display", text: "diagnostic" },
      { key: "pi-square.subagents", text: "subagents 1" },
    ],
  }));
  const plain = stripVTControlCharacters(lines[2]);
  const subagentPos = plain.indexOf("●");
  const displayPos = plain.indexOf("!");
  const genericPos = plain.indexOf("·");
  assert.ok(subagentPos < displayPos, "subagent status before display diagnostic");
  assert.ok(displayPos < genericPos, "display diagnostic before generic extension");
}

console.log("operational footer rendering: dark/light layouts at every display boundary width OK");
