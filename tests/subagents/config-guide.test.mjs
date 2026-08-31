import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { run, test } from "./lib/test-helpers.mjs";

initTheme();
const packageRoot = resolve(import.meta.dirname, "..", "..");
const cleanCwd = join(tmpdir(), `pi-square-config-guide-${process.pid}`);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(cleanCwd, "agent");
const load = jiti(import.meta.url, { moduleCache: false });
const { discoverSubagents } = await load(join(packageRoot, "src", "subagents", "definitions.ts"));
const {
  buildSubagentConfigGuide,
  renderSubagentConfigGuide,
  SUBAGENT_CONFIG_GUIDE_TYPE,
} = await load(join(packageRoot, "src", "subagents", "config-guide.ts"));
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

const plainTheme = {
  fg(_color, text) { return String(text); },
  bg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};

// The guide embeds package-layer file paths in width-bounded rendered output,
// so a fixture carrying the real checkout root makes the wrap point — and with
// it every contiguity assertion — depend on where the repository sits (#232).
// Rewrite the real root to a fixed synthetic one short enough that the current
// assertions hold with margin, and keep a deliberately long one for wrap cases.
const syntheticGuideRoot = "/opt/pi-square";
const longGuideRoot = "/home/example/orca/workspaces/pi-square/232-path-independence-wrap-coverage";

function withPackageRoot(registry, root) {
  const rewrite = (filePath) => (
    filePath === packageRoot || filePath.startsWith(packageRoot + sep)
      ? join(root, relative(packageRoot, filePath))
      : filePath
  );
  return {
    ...registry,
    definitions: registry.definitions.map((definition) => ({
      ...definition,
      layers: definition.layers.map((layer) => ({ ...layer, filePath: rewrite(layer.filePath) })),
    })),
  };
}

function plain(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

test("guide builder is bounded, source-aware, and excludes prompt bodies and the user request", () => {
  const registry = discoverSubagents(cleanCwd);
  const guide = buildSubagentConfigGuide(registry, cleanCwd);
  assert.equal(SUBAGENT_CONFIG_GUIDE_TYPE, "pi-square.subagent-config-guide");
  assert.equal(guide.details.version, 1);
  assert.equal(guide.details.definitionCount, registry.definitions.length);
  assert.ok(guide.details.includedDefinitionCount <= 50);
  assert.deepEqual(guide.details.scopes, ["package"]);
  assert.match(guide.content, /Subagent Config Guide/);
  assert.match(guide.content, /subagents\/explorer\.yaml/);
  assert.match(guide.content, /next user message is the only authorized configuration request/i);
  assert.match(guide.content, /tools: \[none\] disables every built-in tool/);
  assert.match(guide.content, /resume keeps the original frozen values/);
  assert.doesNotMatch(guide.content, /Locate and explain the local code evidence|hide generalist in this project/);
  assert.ok(guide.content.length < 32_000);
});

test("collapsed guide is one native-style summary and expanded guide reveals bounded metadata", () => {
  const registry = withPackageRoot(discoverSubagents(cleanCwd), syntheticGuideRoot);
  const guide = buildSubagentConfigGuide(registry, syntheticGuideRoot);
  const collapsed = plain(renderSubagentConfigGuide(guide, { expanded: false }, plainTheme));
  assert.match(collapsed, /✓ ● Config guide/);
  assert.match(collapsed, /6 definitions/);
  assert.match(collapsed, /package/);
  assert.match(collapsed, /expand/);
  assert.doesNotMatch(collapsed, /promptVersion|explorer\.yaml/);

  const expanded = plain(renderSubagentConfigGuide(guide, { expanded: true }, plainTheme));
  assert.match(expanded, /Configuration contract/);
  assert.match(expanded, /promptVersion: 2/);
  assert.match(expanded, /explorer\.yaml/);
  assert.match(expanded, /collapse/);
});

test("deliberately long definition paths wrap within the display width instead of overflowing", () => {
  const registry = withPackageRoot(discoverSubagents(cleanCwd), longGuideRoot);
  const guide = buildSubagentConfigGuide(registry, syntheticGuideRoot);
  const plainLines = renderSubagentConfigGuide(guide, { expanded: true }, plainTheme)
    .render(80)
    .map((line) => stripVTControlCharacters(line));
  const joined = plainLines.map((line) => line.trimEnd()).join("");
  const longPaths = registry.definitions.flatMap(
    (definition) => definition.layers
      .filter((layer) => layer.filePath.startsWith(longGuideRoot + sep))
      .map((layer) => ({ name: definition.name, filePath: layer.filePath })),
  );
  assert.ok(longPaths.length > 0, "fixture must carry at least one deliberately long path");
  for (const { name, filePath } of longPaths) {
    assert.ok(filePath.length > 80, `${name} fixture path exceeds the 80-column width`);
    assert.ok(plainLines.every((line) => !line.includes(filePath)), `${name} path never fits intact on one line`);
    assert.ok(joined.includes(filePath), `${name} path survives the wrap piecewise`);
  }
});

test("guide renderer is unframed, uses semantic text tokens, and sanitizes damaged content", () => {
  const backgrounds = [];
  const theme = {
    ...plainTheme,
    bg(color, text) { backgrounds.push(color); return String(text); },
  };
  const component = renderSubagentConfigGuide({
    content: "Guide\x1b]0;owned\x07\napi_key=s3cr3t",
    details: { version: 1, definitionCount: 1, includedDefinitionCount: 1, scopes: ["project"] },
  }, { expanded: true }, theme);
  const rendered = plain(component);
  assert.equal(backgrounds.includes("customMessageBg"), false, "guide must not use a background card");
  assert.doesNotMatch(rendered, /owned|s3cr3t|\x1b|\x07/);
  assert.match(rendered, /api_key=\[REDACTED\]/);
});

test("real themes keep the unframed guide bounded at every display boundary width", () => {
  const guide = buildSubagentConfigGuide(discoverSubagents(cleanCwd), cleanCwd);
  for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", file));
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      for (const expanded of [false, true]) {
        const lines = renderSubagentConfigGuide(guide, { expanded }, theme).render(width);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width}`);
      }
    }
  }
});

test("guide uses operational interface grammar with workflow icon and title-case label", () => {
  const guide = buildSubagentConfigGuide(discoverSubagents(cleanCwd), cleanCwd);
  const collapsed = plain(renderSubagentConfigGuide(guide, { expanded: false }, plainTheme));
  // ● bullet from the design-spec icon vocabulary
  assert.match(collapsed, /●/, "guide header uses ● bullet");
  // Title-case label, not all-caps
  assert.match(collapsed, /Config guide/, "guide header uses title-case label");
  assert.doesNotMatch(collapsed, /SUBAGENT CONFIG/, "guide header is not all-caps");
  // Uses standard semantic tokens, not customMessage* tokens
  const tokenTheme = {
    fg(color, text) { return `[${color}]{${text}}`; },
    bg(_c, t) { return String(t); },
    bold(t) { return String(t); },
  };
  const tokenCollapsed = renderSubagentConfigGuide(guide, { expanded: false }, tokenTheme).render(80).join("");
  assert.doesNotMatch(tokenCollapsed, /customMessage/, "guide does not use customMessage tokens");
});

test("guide expanded view uses width-aware rule instead of fixed-width border", () => {
  const guide = buildSubagentConfigGuide(discoverSubagents(cleanCwd), cleanCwd);
  const expanded = plain(renderSubagentConfigGuide(guide, { expanded: true }, plainTheme), 100);
  // The expanded view should show the markdown content with Configuration contract
  assert.match(expanded, /Configuration contract/);
  assert.match(expanded, /promptVersion: 2/);
  // Should NOT use the fixed 24-char borderMuted rule
  assert.doesNotMatch(expanded, /borderMuted/);
});

try {
  await run();
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
