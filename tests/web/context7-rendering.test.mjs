import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

initTheme();

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: true });
const { createLibsToolDefinition } = load(resolve(packageRoot, "src/web/tools/libs.ts"));
const { createDocsToolDefinition } = load(resolve(packageRoot, "src/web/tools/docs.ts"));
const tui = load(resolve(packageRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));

const plainTheme = {
  fg(_color, text) {
    return String(text);
  },
  bold(text) {
    return String(text);
  },
  bg(_color, text) {
    return String(text);
  },
};
const NO_CONTEXT = { lastComponent: undefined };

function renderLines(component, width = 100) {
  return component.render(width);
}

function plain(component, width = 100) {
  return renderLines(component, width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function assertWidth(component, width) {
  for (const line of renderLines(component, width)) {
    assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
  }
}

function counts(overrides = {}) {
  return { received: 1, invalid: 0, eligible: 1, returned: 1, oversized: 0, omitted: 0, ...overrides };
}

function libsDetails(overrides = {}) {
  return {
    libraryName: "react",
    query: "hooks",
    status: "ready",
    mode: "quality",
    limit: 5,
    searchFilterApplied: false,
    candidates: [{ rank: 1, id: "/facebook/react", title: "React", description: "UI library" }],
    counts: counts(),
    phase: "done",
    ...overrides,
  };
}

function docsDetails(overrides = {}) {
  return {
    libraryId: "/facebook/react",
    finalLibraryId: "/facebook/react",
    query: "hooks",
    status: "ready",
    redirected: false,
    kind: "all",
    mode: "quality",
    maxTokens: 12_000,
    rules: null,
    rulesOmitted: false,
    codeSnippets: [],
    infoSnippets: [],
    codeCounts: counts({ received: 0, eligible: 0, returned: 0 }),
    infoCounts: counts({ received: 0, eligible: 0, returned: 0 }),
    estimatedTokens: 0,
    phase: "done",
    ...overrides,
  };
}

function result(details, text = "stable model content") {
  return { content: [{ type: "text", text }], details };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("libs and docs keep the default Pi shell and define native renderers", () => {
  for (const definition of [createLibsToolDefinition(), createDocsToolDefinition()]) {
    assert.equal(typeof definition.renderCall, "function");
    assert.equal(typeof definition.renderResult, "function");
    assert.equal(definition.renderShell, undefined);
  }
});

test("renderCall emphasizes identity and shows only explicit optional parameters", () => {
  const libs = createLibsToolDefinition();
  const docs = createDocsToolDefinition();
  const previous = libs.renderCall({ libraryName: "react", query: "state", mode: "fast", limit: 0 }, plainTheme, NO_CONTEXT);
  const libsText = plain(previous, 100);
  assert.match(libsText, /libs react/);
  assert.match(libsText, /query "state"/);
  assert.match(libsText, /fast/);
  assert.match(libsText, /limit 0/);
  assert.equal(libs.renderCall({ libraryName: "vue", query: "refs" }, plainTheme, { lastComponent: previous }), previous);
  assert.doesNotMatch(plain(previous, 100), /quality|limit 5/);

  const docsText = plain(docs.renderCall({
    libraryId: "/facebook/react",
    query: "useState",
    mode: "fast",
    kind: "code",
    max_tokens: 0,
  }, plainTheme, NO_CONTEXT), 100);
  assert.match(docsText, /docs \/facebook\/react/);
  assert.match(docsText, /query "useState"/);
  assert.match(docsText, /fast · code · 0 tokens/);
  assert.doesNotMatch(plain(docs.renderCall({ libraryId: "/facebook/react", query: "hooks" }, plainTheme, NO_CONTEXT), 100), /quality|all|12000/);
});

test("collapsed results are summaries without candidate or document previews", () => {
  const libs = createLibsToolDefinition();
  const docs = createDocsToolDefinition();
  const libsText = plain(libs.renderResult(result(libsDetails({
    counts: counts({ received: 5, returned: 2, omitted: 1, oversized: 1, invalid: 1 }),
    searchFilterApplied: true,
    candidates: [
      { rank: 1, id: "/a/one", title: "PrivateCandidateToken" },
      { rank: 2, id: "/b/two", title: "Second" },
    ],
  })), { expanded: false, isPartial: false }, plainTheme), 100);
  assert.match(libsText, /2 libraries/);
  assert.match(libsText, /1 omitted · 1 oversized · 1 invalid · filter applied/);
  assert.doesNotMatch(libsText, /PrivateCandidateToken|\/a\/one/);
  assert.match(libsText, /expand/);

  const docsText = plain(docs.renderResult(result(docsDetails({
    redirected: true,
    finalLibraryId: "/facebook/react@19",
    rulesOmitted: true,
    codeSnippets: [{ title: "PrivateCodeToken", tokens: 100, codeList: [{ code: "secret()" }] }],
    infoSnippets: [{ breadcrumb: "PrivateDocToken", tokens: 50, content: "hidden" }],
    codeCounts: counts({ received: 3, returned: 1, omitted: 1, oversized: 1 }),
    infoCounts: counts({ returned: 1, invalid: 1 }),
    estimatedTokens: 1_250,
  })), { expanded: false, isPartial: false }, plainTheme), 100);
  assert.match(docsText, /1 code · 1 docs/);
  assert.match(docsText, /1.3k tokens/);
  assert.match(docsText, /redirected \/facebook\/react@19/);
  assert.match(docsText.replace(/\s+/g, " "), /1 omitted · 1 oversized · 1 invalid · rules omitted/);
  assert.doesNotMatch(docsText, /PrivateCodeToken|PrivateDocToken|secret/);
});

test("expanded libs shows every available field in a compact ranked list", () => {
  const definition = createLibsToolDefinition();
  const details = libsDetails({
    candidates: [{
      rank: 1,
      id: "/facebook/react",
      title: "React",
      description: "A **component** library",
      branch: "main",
      lastUpdateDate: "2026-01-02",
      state: "final",
      totalTokens: 12_345,
      totalSnippets: 234,
      stars: 99_999,
      trustScore: 9.8,
      benchmarkScore: 88.4,
      versions: ["19.0", "18.3"],
      source: "https://context7.com/facebook/react",
    }],
  });
  const expanded = plain(definition.renderResult(result(details), { expanded: true, isPartial: false }, plainTheme), 100);
  for (const expected of [
    "1. React", "/facebook/react", "A component library", "branch main", "final", "updated 2026-01-02",
    "12.3k tokens", "234 snippets", "100k stars", "trust 9.8", "benchmark 88.4", "versions 19.0, 18.3",
    "context7.com/facebook/react", "to collapse",
  ]) assert.ok(expanded.includes(expected), `missing ${expected}`);
});

test("libs renders only validated HTTP sources as hyperlinks and removes terminal controls", () => {
  tui.setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const definition = createLibsToolDefinition();
  const safe = definition.renderResult(result(libsDetails({
    candidates: [{ rank: 1, id: "/safe/id", title: "Safe", source: "https://user:pass@example.com/docs" }],
  })), { expanded: true, isPartial: false }, plainTheme).render(100).join("\n");
  assert.match(safe, /\x1b\]8;;https:\/\/example\.com\/docs/);
  assert.doesNotMatch(safe, /user:pass/);

  const unsafe = definition.renderResult(result(libsDetails({
    candidates: [{ rank: 1, id: "/unsafe/id", title: "Bad\x1b]0;owned\x07", source: "javascript:alert(1)" }],
  })), { expanded: true, isPartial: false }, plainTheme).render(100).join("\n");
  assert.doesNotMatch(unsafe, /\x1b\]8;;javascript:|]0;owned/);
  assert.match(stripVTControlCharacters(unsafe), /javascript:alert\(1\)/);
});

test("expanded docs preserves Rules, Code, Documentation order and complete selected content", () => {
  const definition = createDocsToolDefinition();
  const details = docsDetails({
    rules: { style: "strict", tests: true },
    codeSnippets: [{
      title: "Create state",
      pageTitle: "Hooks reference",
      description: "Use state in a component.",
      source: "https://react.dev/reference/react/useState",
      tokens: 120,
      codeList: [
        { language: "tsx", code: "const [value, setValue] = useState(0);" },
        { language: "ts", code: "setValue(1);" },
      ],
    }],
    infoSnippets: [{
      breadcrumb: "Reference > Hooks",
      source: "https://react.dev/reference/react",
      tokens: 80,
      content: "Read the **complete** guide. UniqueTailToken",
    }],
    codeCounts: counts(),
    infoCounts: counts(),
    estimatedTokens: 200,
  });
  const expanded = plain(definition.renderResult(result(details), { expanded: true, isPartial: false }, plainTheme), 100);
  const rules = expanded.indexOf("Rules");
  const code = expanded.indexOf("Code");
  const documentation = expanded.indexOf("Documentation");
  assert.ok(rules >= 0 && rules < code && code < documentation);
  for (const expected of [
    '"style": "strict"', "Create state  120 tokens", "Hooks reference", "Use state in a component.",
    "const [value, setValue] = useState(0);", "setValue(1);", "Reference > Hooks  80 tokens",
    "Read the complete guide. UniqueTailToken", "react.dev/reference/react/useState", "to collapse",
  ]) assert.ok(expanded.includes(expected), `missing ${expected}`);
});

test("docs neutralizes provider-authored links while preserving inline and fenced code", () => {
  tui.setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const definition = createDocsToolDefinition();
  const details = docsDetails({
    codeSnippets: [{
      title: "Unsafe\x1b]0;owned\x07",
      description: "[bad](javascript:alert(1)) and `const url = '[x](javascript:code)'`",
      tokens: 20,
      codeList: [{ language: "js", code: "const literal = '[inside](javascript:code)';" }],
    }],
    infoSnippets: [{
      breadcrumb: "Guide",
      tokens: 20,
      content: "[remote](https://evil.example/path) www.evil.example user@evil.example\n\n    [indented](javascript:still-code)",
    }],
    codeCounts: counts(),
    infoCounts: counts(),
  });
  const raw = definition.renderResult(result(details), { expanded: true, isPartial: false }, plainTheme).render(120).join("\n");
  const rendered = stripVTControlCharacters(raw);
  assert.doesNotMatch(raw, /\x1b\]8;;(?:javascript:|https:\/\/evil\.example|http:\/\/www\.evil\.example|mailto:user@evil\.example)/);
  assert.doesNotMatch(raw, /]0;owned/);
  assert.match(rendered, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(rendered, /const url = '\[x\]\(javascript:code\)'/);
  assert.match(rendered, /const literal = '\[inside\]\(javascript:code\)'/);
  assert.match(rendered, /\[indented\]\(javascript:still-code\)/);
});

test("docs safe source links are clickable and credentials are removed", () => {
  tui.setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const definition = createDocsToolDefinition();
  const details = docsDetails({
    infoSnippets: [{ breadcrumb: "Guide", tokens: 10, content: "Body", source: "https://user:pass@example.com/guide" }],
    infoCounts: counts(),
  });
  const raw = definition.renderResult(result(details), { expanded: true, isPartial: false }, plainTheme).render(100).join("\n");
  assert.match(raw, /\x1b\]8;;https:\/\/example\.com\/guide/);
  assert.doesNotMatch(raw, /user:pass/);
});

test("partial, pending, error, and empty states remain concise and non-expandable", () => {
  const libs = createLibsToolDefinition();
  const docs = createDocsToolDefinition();
  assert.match(plain(libs.renderResult(result(libsDetails()), { expanded: false, isPartial: true }, plainTheme)), /Searching libraries/);
  assert.match(plain(docs.renderResult(result(docsDetails()), { expanded: false, isPartial: true }, plainTheme)), /Fetching documentation/);
  assert.match(plain(libs.renderResult(result(libsDetails({ status: "pending", retryAfter: 12, candidates: [], counts: counts({ returned: 0 }) })), { expanded: false, isPartial: false }, plainTheme)), /retry in 12s/);
  assert.match(plain(docs.renderResult(result(docsDetails({ status: "error", error: "broken\x1b]0;owned\x07" })), { expanded: false, isPartial: false }, plainTheme)), /✗ broken/);
  const empty = plain(docs.renderResult(result(docsDetails()), { expanded: false, isPartial: false }, plainTheme));
  assert.match(empty, /0 snippets/);
  assert.doesNotMatch(empty, /expand/);
});

test("legacy details fall back to complete sanitized model content", () => {
  const libs = createLibsToolDefinition();
  const docs = createDocsToolDefinition();
  const longTail = "Legacy intro\n\n`inline [safe](javascript:code)`\n\nUniqueLegacyTail";
  const libsExpanded = plain(libs.renderResult(result({
    status: "ready",
    candidates: [null],
    counts: counts(),
  }, longTail), { expanded: true, isPartial: false }, plainTheme), 80);
  const docsRaw = docs.renderResult(result({
    status: "ready",
    codeSnippets: [{ title: "damaged", codeList: null }],
    infoSnippets: [],
    codeCounts: counts(),
    infoCounts: counts({ received: 0, eligible: 0, returned: 0 }),
  }, `\x1b]0;owned\x07${longTail}`), { expanded: true, isPartial: false }, plainTheme).render(80).join("\n");
  assert.match(libsExpanded, /UniqueLegacyTail/);
  assert.match(stripVTControlCharacters(docsRaw), /UniqueLegacyTail/);
  assert.doesNotMatch(docsRaw, /]0;owned/);
});

test("expanded docs does not add a second display truncation layer", () => {
  const definition = createDocsToolDefinition();
  const body = `${"Long documentation line. ".repeat(2_000)}UniqueMaximumTail`;
  const details = docsDetails({
    infoSnippets: [{ breadcrumb: "Long guide", tokens: 12_000, content: body }],
    infoCounts: counts(),
    estimatedTokens: 12_000,
  });
  const expanded = plain(definition.renderResult(result(details), { expanded: true, isPartial: false }, plainTheme), 80);
  assert.match(expanded, /UniqueMaximumTail/);
});

test("libs and docs render within every display boundary width", () => {
  const libs = createLibsToolDefinition();
  const docs = createDocsToolDefinition();
  const libsResult = result(libsDetails({
    candidates: [{
      rank: 1, id: "/scope/a-library-with-a-long-name", title: "A long library title for narrow terminals",
      description: "A long description with Unicode 文档 and enough words to wrap naturally.",
      versions: ["1.0.0", "2.0.0", "3.0.0"], totalTokens: 10_000,
    }],
  }));
  const docsResult = result(docsDetails({
    codeSnippets: [{ title: "A long code snippet title", tokens: 50, codeList: [{ language: "ts", code: "const value = 'a long line that should wrap without overflowing the terminal';" }] }],
    infoSnippets: [{ breadcrumb: "A long documentation breadcrumb", tokens: 50, content: "Long prose with Unicode 文档 that should wrap within narrow terminal widths." }],
    codeCounts: counts(), infoCounts: counts(), estimatedTokens: 100,
  }));
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    assertWidth(libs.renderCall({ libraryName: "a-library", query: "a long query that needs wrapping", mode: "fast", limit: 10 }, plainTheme, NO_CONTEXT), width);
    assertWidth(docs.renderCall({ libraryId: "/scope/library", query: "a long query that needs wrapping", kind: "all", max_tokens: 12_000 }, plainTheme, NO_CONTEXT), width);
    assertWidth(libs.renderResult(libsResult, { expanded: true, isPartial: false }, plainTheme), width);
    assertWidth(docs.renderResult(docsResult, { expanded: true, isPartial: false }, plainTheme), width);
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
