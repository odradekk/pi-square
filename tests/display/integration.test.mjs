import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DISPLAY_CATALOG } = await load("../../src/display/catalog.ts");
const { OperationalDisplayComponent } = await load("../../src/display/components.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");
const root = join(import.meta.dirname, "..", "..");
const themeModulePath = pathToFileURL(join(
  root,
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
const thirdPartyTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const themes = [
  ["dark", loadThemeFromPath(join(root, "themes", "pi-square-theme-dark.json"))],
  ["light", loadThemeFromPath(join(root, "themes", "pi-square-theme-light.json"))],
  ["third-party", thirdPartyTheme],
];
const widths = [39, 40, 63, 64, 80, 99, 100, 120];
const states = ["pending", "partial", "success", "warning", "error", "aborted"];
const expectedRails = { pending: "⠋", partial: "⠋", success: "✓", warning: "!", error: "✗", aborted: "×" };

assert.equal(new Set(DISPLAY_CATALOG.map((entry) => entry.name)).size, DISPLAY_CATALOG.length);
assert.ok(DISPLAY_CATALOG.every((entry) => entry.parent));

for (const entry of DISPLAY_CATALOG) {
  for (const status of states) {
    const description = {
      version: 1,
      tool: entry.name,
      family: entry.family,
      status,
      title: entry.name.toUpperCase(),
      target: "src/target\x1b]0;owned\x07.ts",
      metadata: [{ label: "count", value: "12" }, { label: "api_key", value: "api_key=secret-value" }],
      rows: status === "success" ? [] : [{ text: status === "error" ? "Bearer hidden-token" : `${status} state` }],
      preview: { text: "preview one\npreview two\npreview three", omittedLines: 2 },
      progress: status === "pending" || status === "partial" ? { current: 2, total: 5, label: "items" } : undefined,
      truncated: status === "warning",
      error: status === "error" ? "password=do-not-show" : undefined,
      diff: entry.name === "edit" || entry.name === "write"
        ? { path: "src/target.ts", before: "before\nshared\n", after: "after\nshared\n", projected: entry.name === "write" }
        : undefined,
    };
    for (const [themeName, theme] of themes) {
      for (const width of widths) {
        for (const resultMode of ["hidden", "summary", "preview"]) {
          const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode };
          const component = new OperationalDisplayComponent(description, policy, theme, { expanded: resultMode === "preview" });
          const lines = component.render(width);
          assert.ok(lines.length > 0, `${entry.name}/${status}/${themeName}/${width} rendered empty`);
          assert.ok(lines.every((line) => visibleWidth(line) <= width), `${entry.name}/${status}/${themeName} exceeded ${width}`);
          const plain = stripVTControlCharacters(lines.join("\n"));
          assert.match(plain, new RegExp(`^${expectedRails[status]}`));
          assert.doesNotMatch(plain, /owned|secret-value|hidden-token|do-not-show|\x1b|\x07/);
          if (status === "error") assert.match(plain, /\[REDACTED\]/, "errors must remain visible and redacted under every result mode");
        }
      }
    }
  }
}

for (const threshold of [70, 100, 120, 240]) {
  const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", diffView: "auto", diffSplitMinWidth: threshold };
  const description = {
    version: 1,
    tool: "write",
    family: "filesystem",
    status: "pending",
    title: "WRITE",
    diff: { path: "src/file.ts", before: "old\n", after: "new\n", projected: true },
  };
  for (const width of [threshold - 1, threshold]) {
    const lines = new OperationalDisplayComponent(description, policy, thirdPartyTheme, { expanded: true }).render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `diff threshold ${threshold}/${width} overflowed`);
    assert.match(lines.join("\n"), /projected/i);
  }
}

console.log(`display integration matrix: ${DISPLAY_CATALOG.length} tools, all lifecycle states, themes, and boundary widths OK`);
