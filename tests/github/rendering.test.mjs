import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme();
const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  renderGitHubCommitCall,
  renderGitHubReadCall,
  renderGitHubResult,
  renderGitHubSearchCall,
  renderGitHubTreeCall,
} = load(join(packageRoot, "src", "github", "render.ts"));
const themeModulePath = pathToFileURL(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme", "theme.js")).href;
const { loadThemeFromPath } = await import(themeModulePath);

const plainTheme = {
  fg(_color, value) { return String(value); },
  bg(_color, value) { return String(value); },
  bold(value) { return String(value); },
};
const context = { lastComponent: undefined };
function render(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("calls show identity and explicit pagination without leaking control sequences", () => {
  assert.match(render(renderGitHubSearchCall({ kind: "code", query: "token\x1b]0;x\x07", page: 2 }, plainTheme, context)), /github_search token/);
  assert.match(render(renderGitHubReadCall({ repo: "acme/repo", path: "src/a.ts", ref: "main", line: 20 }, plainTheme, context)), /github_read acme\/repo:src\/a\.ts/);
  assert.match(render(renderGitHubTreeCall({ repo: "acme/repo", depth: 2, offset: 10 }, plainTheme, context)), /depth 2 · offset 10/);
  assert.match(render(renderGitHubCommitCall({ repo: "acme/repo", ref: "abc", limit: 5 }, plainTheme, context)), /github_commit acme\/repo@abc/);
});

test("collapsed results expose only bounded summaries and completeness metadata", () => {
  const cases = [
    [{ tool: "search", phase: "done", kind: "code", query: "x", page: 1, limit: 10, total: 20, returned: 2, incomplete: true, hasMore: true }, /2 code results.*incomplete/],
    [{ tool: "read", phase: "done", repo: "acme/repo", resolvedPath: "src/a.ts", line: 1, limit: 10, returnedLines: 10, totalLines: 20, hasMore: true }, /10 lines.*20 total.*more/],
    [{ tool: "tree", phase: "done", repo: "acme/repo", depth: 2, offset: 0, limit: 10, returned: 10, hasMore: true, remoteTruncated: false, requestBudgetExhausted: true, requestsUsed: 20 }, /10 tree entries.*request cap/],
    [{ tool: "commit", phase: "done", repo: "acme/repo", ref: "abc", page: 1, limit: 10, returned: 3, hasMore: true, omittedPatches: 1, additions: 2, deletions: 1 }, /3 changed files.*1 patch omitted.*more/],
  ];
  for (const [details, expected] of cases) {
    const output = render(renderGitHubResult({ content: [{ type: "text", text: "PRIVATE SOURCE BODY" }], details }, { expanded: false, isPartial: false }, plainTheme));
    assert.match(output, expected);
    assert.doesNotMatch(output, /PRIVATE SOURCE BODY/);
    assert.match(output, /expand/);
  }
});

test("partial, error, binary, and expanded output are explicit and sanitized", () => {
  const partial = render(renderGitHubResult({ content: [{ type: "text", text: "loading" }], details: { tool: "tree", phase: "loading", repo: "acme/repo", depth: 1, offset: 0, limit: 10, returned: 0, hasMore: false, remoteTruncated: false, requestBudgetExhausted: false, requestsUsed: 0 } }, { expanded: false, isPartial: true }, plainTheme));
  assert.match(partial, /Browsing GitHub tree/);

  const error = render(renderGitHubResult({ content: [{ type: "text", text: "hidden" }], details: { tool: "read", phase: "done", repo: "acme/repo", line: 1, limit: 10, returnedLines: 0, hasMore: false, error: "Authorization: Bearer ghp_leaked-secret" } }, { expanded: false, isPartial: false }, plainTheme));
  assert.match(error, /\[REDACTED\]/);
  assert.doesNotMatch(error, /ghp_leaked|expand/);

  const binary = render(renderGitHubResult({ content: [{ type: "text", text: "metadata" }], details: { tool: "read", phase: "done", repo: "acme/repo", resolvedPath: "a.bin", size: 3, binary: true, line: 1, limit: 10, returnedLines: 0, hasMore: false } }, { expanded: false, isPartial: false }, plainTheme));
  assert.match(binary, /binary a\.bin.*3 bytes/);

  const expandedComponent = renderGitHubResult({ content: [{ type: "text", text: "# remote\n[bad](javascript:alert(1))\ngithub_pat_source_secret" }], details: { tool: "search", phase: "done", kind: "repositories", query: "x", page: 1, limit: 10, total: 1, returned: 1, incomplete: false, hasMore: false } }, { expanded: true, isPartial: false }, plainTheme);
  const rawExpanded = expandedComponent.render(80).join("\n");
  const expanded = rawExpanded.split("\n").map((line) => stripVTControlCharacters(line)).join("\n");
  assert.doesNotMatch(expanded, /github_pat_source/);
  assert.match(expanded, /\[REDACTED\]/);
  assert.doesNotMatch(rawExpanded, /\x1b]8;;javascript:/, "provider-authored javascript link must remain inert");
  assert.match(expanded, /collapse/);
});

test("real dark and light themes keep calls and results within every display boundary width", () => {
  const result = {
    content: [{ type: "text", text: "github_commit acme/repository@abcdef\n\n## src/a-very-long-file-name.ts\n```diff\n-long line ".repeat(8) + "\n```" }],
    details: { tool: "commit", phase: "done", repo: "acme/repository", ref: "abcdef", page: 1, limit: 20, returned: 1, hasMore: false, omittedPatches: 0, additions: 1, deletions: 1 },
  };
  for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", file));
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      const components = [
        renderGitHubSearchCall({ kind: "code", query: "a very long query repo:acme/repository", page: 2, limit: 50 }, theme, {}),
        renderGitHubReadCall({ repo: "acme/repository", path: "src/a-very-long-file-name.ts", ref: "feature/branch", line: 100, limit: 200 }, theme, {}),
        renderGitHubTreeCall({ repo: "acme/repository", path: "src/deep/path", depth: 4, offset: 100, limit: 200 }, theme, {}),
        renderGitHubCommitCall({ repo: "acme/repository", ref: "abcdef0123456789", page: 2, limit: 50 }, theme, {}),
        renderGitHubResult(result, { expanded: false, isPartial: false }, theme),
        renderGitHubResult(result, { expanded: true, isPartial: false }, theme),
      ];
      for (const component of components) {
        for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width}: ${line}`);
      }
    }
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.error(`FAIL: ${name}`); console.error(error); }
}
console.log(`\n${tests.length} tests, ${failures} failed`);
process.exit(failures ? 1 : 0);
