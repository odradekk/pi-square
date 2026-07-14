import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { run, test } from "./lib/test-helpers.mjs";

initTheme();
const packageRoot = resolve(import.meta.dirname, "..", "..");
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

function plain(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

test("guide builder is bounded, source-aware, and excludes prompt bodies and the user request", () => {
  const registry = discoverSubagents(packageRoot);
  const guide = buildSubagentConfigGuide(registry, packageRoot);
  assert.equal(SUBAGENT_CONFIG_GUIDE_TYPE, "pi-square.subagent-config-guide");
  assert.equal(guide.details.version, 1);
  assert.equal(guide.details.definitionCount, registry.definitions.length);
  assert.ok(guide.details.includedDefinitionCount <= 50);
  assert.deepEqual(guide.details.scopes, ["package"]);
  assert.match(guide.content, /Subagent Config Guide/);
  assert.match(guide.content, /resources\/subagents\/explorer\.yaml/);
  assert.match(guide.content, /next user message is the only authorized configuration request/i);
  assert.match(guide.content, /tools: \[none\] disables every built-in tool/);
  assert.match(guide.content, /resume keeps the original frozen values/);
  assert.doesNotMatch(guide.content, /Locate and explain the local code evidence|hide generalist in this project/);
  assert.ok(guide.content.length < 32_000);
});

test("collapsed guide is one native-style summary and expanded guide reveals bounded metadata", () => {
  const guide = buildSubagentConfigGuide(discoverSubagents(packageRoot), packageRoot);
  const collapsed = plain(renderSubagentConfigGuide(guide, { expanded: false }, plainTheme));
  assert.match(collapsed, /\[Subagent Config Guide\]/);
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

test("guide renderer uses custom-message shell tokens and sanitizes damaged content", () => {
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
  assert.ok(backgrounds.includes("customMessageBg"));
  assert.doesNotMatch(rendered, /owned|s3cr3t|\x1b|\x07/);
  assert.match(rendered, /api_key=\[REDACTED\]/);
});

test("real themes keep guide cards bounded at 40, 80, and 120 columns", () => {
  const guide = buildSubagentConfigGuide(discoverSubagents(packageRoot), packageRoot);
  for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", file));
    for (const width of [40, 80, 120]) {
      for (const expanded of [false, true]) {
        const lines = renderSubagentConfigGuide(guide, { expanded }, theme).render(width);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width}`);
      }
    }
  }
});

await run();
