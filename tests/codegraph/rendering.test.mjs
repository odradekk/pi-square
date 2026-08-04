import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { resolve } from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

initTheme();
const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { createCodeGraphToolDefinition } = await load(resolve(packageRoot, "src", "codegraph", "tool.ts"));
const def = createCodeGraphToolDefinition({ resolveBinary: async () => ({}), runCommand: async () => ({}) });
const theme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};
const context = { lastComponent: undefined };

function details(overrides = {}) {
  return {
    version: 1,
    operation: "explore",
    phase: "done",
    projectPath: "/repo",
    status: { initialized: true, fileCount: 12 },
    autoSynced: true,
    outputChars: 20,
    outputTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function plain(component, width) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

const call = def.renderCall({ operation: "explore", query: "How does request routing work?", projectPath: "services/api", maxFiles: 6 }, theme, context);
assert.match(plain(call, 120), /codegraph explore How does request routing work/);
assert.match(plain(call, 120), /projectPath=services\/api/);
assert.match(plain(call, 120), /maxFiles=6/);

const result = {
  content: [{ type: "text", text: "## Flow\n\n```ts\nexport function route() {}\n```" }],
  details: details(),
};
const collapsed = plain(def.renderResult(result, { expanded: false, isPartial: false }, theme), 80);
assert.match(collapsed, /explore done/);
assert.match(collapsed, /auto-synced/);
assert.match(collapsed, /12 files/);
assert.doesNotMatch(collapsed, /export function/);

const expanded = plain(def.renderResult(result, { expanded: true, isPartial: false }, theme), 80);
assert.match(expanded, /Flow/);
assert.match(expanded, /export function route/);

const recoverable = plain(def.renderResult({
  content: [{ type: "text", text: JSON.stringify({ code: "NOT_INDEXED" }) }],
  details: details({ phase: "recoverable", code: "NOT_INDEXED", message: "Initialize once" }),
}, { expanded: false, isPartial: false }, theme), 80);
assert.match(recoverable, /NOT_INDEXED/);
assert.match(recoverable, /Initialize once/);

const partial = plain(def.renderResult({ content: [], details: details({ phase: "running", message: "syncing files" }) }, { expanded: false, isPartial: true }, theme), 80);
assert.match(partial, /explore/);
assert.match(partial, /syncing files/);

for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
  for (const component of [
    def.renderCall({ operation: "explore", query: "A very long semantic question about routing through several framework layers", projectPath: "services/backend" }, theme, context),
    def.renderResult(result, { expanded: false, isPartial: false }, theme),
    def.renderResult(result, { expanded: true, isPartial: false }, theme),
  ]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
    }
  }
}

console.log("codegraph rendering tests: OK");
