import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

// Initialize the global theme so getMarkdownTheme()/keyHint() produce
// deterministic styled output for the render assertions below.
initTheme();

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const sharedNodeModules = join(packageRoot, "node_modules");

const existingNodePath = process.env.NODE_PATH ? process.env.NODE_PATH.split(":") : [];
if (!existingNodePath.includes(sharedNodeModules)) {
  process.env.NODE_PATH = [sharedNodeModules, ...existingNodePath].filter(Boolean).join(":");
  Module._initPaths();
}

const load = jiti(import.meta.url, { moduleCache: false });

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function installMockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    const record = { url: urlStr, headers: {}, method: init?.method ?? "GET", signal: init?.signal };
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        for (const [k, v] of h.entries()) record.headers[k] = v;
      } else if (typeof h === "object") {
        for (const [k, v] of Object.entries(h)) record.headers[k] = String(v);
      }
    }
    calls.push(record);
    return await handler(urlStr, init, calls.length - 1, record);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status, body, headers = {}) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function searchOk(entries, extra = {}) {
  return jsonResponse(200, { data: entries, ...extra });
}

function readerOk({ title = "", url, finalUrl, description = "", content, usage, links, images }) {
  const data = { title, url, description, content };
  if (finalUrl) data.url = finalUrl;
  if (usage) data.usage = usage;
  if (links) data.links = links;
  if (images) data.images = images;
  return jsonResponse(200, { data });
}

// ---------------------------------------------------------------------------
// Load tool modules
// ---------------------------------------------------------------------------

const searchModule = load(join(packageRoot, "src", "web", "tools", "search.ts"));
const fetchModule = load(join(packageRoot, "src", "web", "tools", "fetch.ts"));
const renderModule = load(join(packageRoot, "src", "web", "shared", "render.ts"));

const { createSearchToolDefinition, registerSearchTool } = searchModule;
const { createFetchToolDefinition, registerFetchTool } = fetchModule;
const { formatMarkdownLink, formatMarkdownUrl, sanitizeMarkdownForTerminal } = renderModule;

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

// Passthrough theme for the `theme` render argument. keyHint() and the
// Markdown component use the real global theme; we strip ANSI before asserting.
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

function render(component, width) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function assertMaxWidth(renderedLines, width) {
  for (const line of renderedLines) {
    assert.ok(
      visibleWidth(line) <= width,
      `rendered line exceeds width ${width} (${visibleWidth(line)}): ${JSON.stringify(line)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Temp agent dir for missing-key tests
// ---------------------------------------------------------------------------

const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-square-web-tools-test-"));
writeFileSync(join(tempAgentDir, "settings.json"), "{}");
writeFileSync(join(tempAgentDir, "auth.json"), "{}");

// Bodies with >= 200 non-whitespace characters so the fetch thin-content
// retry threshold is NOT triggered by default.
const LONG_BODY = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
const LONG_BODY_B = "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. ".repeat(6);
const UNICODE_BODY = `😀 café é ${LONG_BODY}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function withKey(fn) {
  return async () => {
    const saved = process.env.JINA_API_KEY;
    process.env.JINA_API_KEY = "test-key";
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = saved;
    }
  };
}

// === Registration & shell ===

test("Markdown display sanitization removes terminal controls and neutralizes source-authored links", () => {
  assert.equal(
    formatMarkdownLink("A [remote] *title*", "https://example.com/a b"),
    "[A \\[remote\\] \\*title\\*](<https://example.com/a%20b>)",
  );
  assert.equal(formatMarkdownUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(formatMarkdownLink("Unsafe", "javascript:alert(1)"), "Unsafe (javascript:alert(1))");

  const safe = sanitizeMarkdownForTerminal([
    "\x1b]0;owned\x07[x](javascript:alert(1))",
    "[x][bad]",
    "[bad]: javascript:alert(1)",
    "<javascript:alert(1)>",
    "> [shortcut]",
    ">",
    "> [shortcut]: javascript:alert(1)",
    "`[inline](javascript:literal)`",
    "```md",
    "[code](javascript:literal)",
    "```",
  ].join("\n"));
  assert.equal(safe.includes("\x1b"), false);
  assert.ok(safe.includes("\\[x](javascript:alert(1))"));
  assert.ok(safe.includes("\\[x]\\[bad]"));
  assert.ok(safe.includes("\\[bad]: javascript:alert(1)"));
  assert.ok(safe.includes("\\<javascript:alert(1)>"));
  assert.ok(safe.includes("> \\[shortcut]"));
  assert.ok(safe.includes("> \\[shortcut]: javascript:alert(1)"));
  assert.ok(safe.includes("`[inline](javascript:literal)`"), "inline code stays exact");
  assert.ok(safe.includes("```md\n[code](javascript:literal)\n```"), "fenced code stays exact");
});

test("registerSearchTool registers tool named search", () => {
  const tools = new Map();
  registerSearchTool({ registerTool: (def) => tools.set(def.name, def) });
  assert.ok(tools.has("search"));
});

test("registerFetchTool registers tool named fetch", () => {
  const tools = new Map();
  registerFetchTool({ registerTool: (def) => tools.set(def.name, def) });
  assert.ok(tools.has("fetch"));
});

for (const [name, create] of [
  ["search", createSearchToolDefinition],
  ["fetch", createFetchToolDefinition],
]) {
  test(`${name} keeps the default Pi shell and defines renderers`, () => {
    const def = create();
    assert.equal(def.renderShell, undefined, "must not set renderShell:self");
    assert.equal(typeof def.renderCall, "function", "renderCall must be defined");
    assert.equal(typeof def.renderResult, "function", "renderResult must be defined");
  });
}

// === Search: content regression + details ===

test(
  "search content is the stable ranked text and details.results carries provenance",
  withKey(async () => {
    const mock = installMockFetch(() =>
      searchOk([
        { title: "Alpha Result", url: "https://alpha.example/x", description: "First match" },
        { title: "Beta Site", url: "https://beta.example/y", description: "Second match" },
      ]),
    );
    try {
      const result = await createSearchToolDefinition().execute("t", { queries: ["alpha"] });
      const expected = [
        "[1] Alpha Result",
        "    https://alpha.example/x",
        "    First match",
        "    [q1#1]",
        "",
        "[2] Beta Site",
        "    https://beta.example/y",
        "    Second match",
        "    [q1#2]",
      ].join("\n");
      assert.equal(result.content[0].text, expected);

      assert.equal(result.details.totalBeforeDedup, 2);
      assert.equal(result.details.totalAfterDedup, 2);
      assert.equal(result.details.results.length, 2);
      assert.equal(result.details.results[0].title, "Alpha Result");
      assert.equal(result.details.results[0].url, "https://alpha.example/x");
      assert.equal(result.details.results[0].provenance, "[q1#1]");
      assert.equal(result.details.results[1].provenance, "[q1#2]");
    } finally {
      mock.restore();
    }
  }),
);

test(
  "search merges and de-duplicates across queries, reporting before/after counts",
  withKey(async () => {
    // Both queries return the same URL -> one merged result with two matches.
    const mock = installMockFetch(() =>
      searchOk([{ title: "Shared", url: "https://shared.example", description: "d" }]),
    );
    try {
      const result = await createSearchToolDefinition().execute("t", {
        queries: ["a", "b"],
      });
      assert.equal(result.details.totalBeforeDedup, 2);
      assert.equal(result.details.totalAfterDedup, 1);
      assert.equal(result.details.results.length, 1);
      assert.equal(result.details.results[0].provenance, "[q1#1, q2#1]");
    } finally {
      mock.restore();
    }
  }),
);

test("search fails before network when key missing", async () => {
  const savedKey = process.env.JINA_API_KEY;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.JINA_API_KEY;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  const mock = installMockFetch(() => searchOk([]));
  try {
    const result = await createSearchToolDefinition().execute("t", { queries: ["x"] });
    assert.match(result.content[0].text, /JINA_API_KEY|Missing.*key/i);
    assert.equal(result.details.error, "Missing JINA_API_KEY");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    if (savedKey !== undefined) process.env.JINA_API_KEY = savedKey;
    if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  }
});

// === Search: rendering ===

test(
  "search renderCall shows tool name, queries, and options; reuses lastComponent",
  withKey(async () => {
    const mock = installMockFetch(() => searchOk([]));
    try {
      const def = createSearchToolDefinition();
      const args = { queries: ["alpha", "beta"], limit: 5, sites: ["example.com"], no_cache: true };
      const first = def.renderCall(args, plainTheme, NO_CONTEXT);
      const lines = render(first, 80);
      assert.ok(lines[0].includes("search"));
      assert.ok(lines[0].includes('"alpha"'));
      assert.ok(lines[0].includes('"beta"'));
      assert.ok(lines.some((l) => l.includes("limit 5")));
      assert.ok(lines.some((l) => l.includes("site example.com")));
      assert.ok(lines.some((l) => l.includes("no-cache")));
      assert.equal(render(first, 200).length, 1, "call summary is one logical line");

      // Reuse: passing lastComponent returns the same instance, updated.
      const second = def.renderCall({ queries: ["gamma"] }, plainTheme, { lastComponent: first });
      assert.equal(second, first);
      assert.ok(render(second, 80)[0].includes('"gamma"'));
      assertMaxWidth(render(second, 80), 80);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "search renderResult collapsed summarizes counts and shows an expand hint",
  withKey(async () => {
    const mock = installMockFetch(() =>
      searchOk([
        { title: "A", url: "https://a.example", description: "da" },
        { title: "B", url: "https://b.example", description: "db" },
        { title: "C", url: "https://c.example", description: "dc" },
      ]),
    );
    try {
      const result = await createSearchToolDefinition().execute("t", { queries: ["q"], limit: 2 });
      const lines = render(
        createSearchToolDefinition().renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      assert.ok(lines[0].includes("2 results"));
      assert.ok(lines[0].includes("to expand"));
      assertMaxWidth(lines, 80);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "search renderResult expanded lists all results with clickable titles",
  withKey(async () => {
    const mock = installMockFetch(() =>
      searchOk([
        { title: "Alpha Result", url: "https://alpha.example/x", description: "First match" },
        { title: "Beta Site", url: "https://beta.example/y", description: "Second match" },
      ]),
    );
    try {
      const result = await createSearchToolDefinition().execute("t", { queries: ["alpha"] });
      const lines = render(
        createSearchToolDefinition().renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      const joined = lines.join("\n");
      assert.ok(joined.includes("Alpha Result"), "title rendered");
      assert.ok(joined.includes("https://alpha.example/x"), "url rendered");
      assert.ok(joined.includes("First match"), "description rendered");
      assert.ok(joined.includes("[q1#1]"), "provenance rendered");
      assert.ok(joined.includes("to collapse"), "collapse hint rendered");
      assertMaxWidth(lines, 80);
    } finally {
      mock.restore();
    }
  }),
);

test("search renderResult expanded falls back to full content for legacy details", () => {
  const def = createSearchToolDefinition();
  const legacy = {
    content: [{ type: "text", text: "[1] Legacy result\n    https://legacy.example\n    Legacy description" }],
    details: {
      queries: ["legacy"],
      failedQueries: [],
      count: 10,
      phase: "done",
      totalBeforeDedup: 1,
      totalAfterDedup: 1,
    },
  };
  const lines = render(def.renderResult(legacy, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT), 80);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Legacy result"));
  assert.ok(joined.includes("Legacy description"));
  assert.ok(joined.includes("to collapse"));
});

test(
  "search renderResult partial shows a phase label",
  withKey(async () => {
    const def = createSearchToolDefinition();
    const partial = {
      content: [{ type: "text", text: "Searching..." }],
      details: { queries: ["q"], failedQueries: [], count: 10, phase: "searching" },
    };
    const lines = render(def.renderResult(partial, { expanded: false, isPartial: true }, plainTheme, NO_CONTEXT), 80);
    assert.match(lines.join("\n"), /searching/i);
  }),
);

test(
  "search renderResult error (all queries failed) shows the error in collapsed state",
  withKey(async () => {
    const mock = installMockFetch(() => jsonResponse(500, { error: "boom" }));
    try {
      const result = await createSearchToolDefinition().execute("t", { queries: ["q"] });
      assert.equal(result.details.error !== undefined, true);
      const lines = render(
        createSearchToolDefinition().renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      assert.ok(lines[0].includes("✗"), "error glyph shown");
    } finally {
      mock.restore();
    }
  }),
);

test(
  "search limit omission is not reported as a duplicate",
  withKey(async () => {
    const mock = installMockFetch((_url, _init, i) =>
      searchOk([{ title: `Result ${i}`, url: `https://result-${i}.example`, description: "d" }]),
    );
    try {
      const def = createSearchToolDefinition();
      const result = await def.execute("t", { queries: ["a", "b"], limit: 1 });
      assert.equal(result.details.totalBeforeDedup, 2);
      assert.equal(result.details.totalAfterDedup, 2);
      assert.equal(result.details.results.length, 1);
      const collapsed = render(def.renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT), 80).join("\n");
      assert.ok(collapsed.includes("1 omitted"));
      assert.equal(collapsed.includes("duplicate"), false);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "search renderResult partial query failure reports the failed count",
  withKey(async () => {
    // First query fails, second succeeds.
    const mock = installMockFetch((_url, _init, i) =>
      i === 0 ? jsonResponse(500, { error: "down" }) : searchOk([{ title: "Ok", url: "https://ok.example", description: "d" }]),
    );
    try {
      const result = await createSearchToolDefinition().execute("t", { queries: ["bad", "good"] });
      assert.equal(result.details.failedQueries.length, 1);
      assert.equal(result.details.results.length, 1);
      const lines = render(
        createSearchToolDefinition().renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      assert.ok(lines[0].includes("1 result"));
      assert.ok(lines[0].includes("1 failed"));
    } finally {
      mock.restore();
    }
  }),
);

// === Fetch: content regression + offset details ===

test(
  "search partial failure with no results still expands to the per-query error",
  withKey(async () => {
    const mock = installMockFetch((_url, _init, i) =>
      i === 0 ? jsonResponse(500, { error: "down" }) : searchOk([]),
    );
    try {
      const def = createSearchToolDefinition();
      const result = await def.execute("t", { queries: ["bad", "empty"] });
      const collapsed = render(def.renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT), 80).join("\n");
      assert.ok(collapsed.includes("0 results"));
      assert.ok(collapsed.includes("to expand"));
      const expanded = render(def.renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT), 80).join("\n");
      assert.ok(expanded.includes("bad:"));
      assert.ok(expanded.includes("HTTP 500"));
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch single-page content is stable and page offsets slice the section and body",
  withKey(async () => {
    const mock = installMockFetch(() =>
      readerOk({ title: "Example Page", url: "https://example.com/page", description: "An example page.", content: LONG_BODY }),
    );
    try {
      const result = await createFetchToolDefinition().execute("t", { urls: ["https://example.com/page"] });
      const expected =
        "## Example Page\nURL: https://example.com/page\nDescription: An example page.\n\n" + LONG_BODY;
      assert.equal(result.content[0].text, expected);

      const page = result.details.pages[0];
      assert.equal(page.url, "https://example.com/page");
      assert.equal(page.title, "Example Page");
      assert.equal(page.retried, false);
      assert.equal(result.content[0].text.slice(page.start, page.end), expected);
      assert.equal(result.content[0].text.slice(page.bodyStart, page.end), LONG_BODY);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch multi-page content joins sections with the separator and preserves order",
  withKey(async () => {
    const mock = installMockFetch((url) => {
      if (url.includes("first.example")) {
        return readerOk({ title: "First 😀", url: "https://first.example", content: UNICODE_BODY });
      }
      return readerOk({ title: "Second", url: "https://second.example", content: LONG_BODY_B });
    });
    try {
      const result = await createFetchToolDefinition().execute("t", {
        urls: ["https://first.example", "https://second.example"],
      });
      const text = result.content[0].text;
      assert.ok(text.includes("\n\n---\n\n"), "sections separated by horizontal rule");
      assert.equal(result.details.pages.length, 2);
      assert.equal(result.details.pages[0].title, "First 😀");
      assert.equal(result.details.pages[1].title, "Second");
      // Each page's section and body slice out of the joined content exactly.
      for (const page of result.details.pages) {
        const section = text.slice(page.start, page.end);
        assert.ok(section.startsWith("## "), "section starts with its heading");
        assert.ok(!section.includes("\n\n---\n\n"), "section does not contain the separator");
      }
      assert.equal(text.slice(result.details.pages[0].bodyStart, result.details.pages[0].end), UNICODE_BODY);
      assert.equal(text.slice(result.details.pages[1].bodyStart, result.details.pages[1].end), LONG_BODY_B);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch keeps links and image summaries in both model content and the display body slice",
  withKey(async () => {
    const mock = installMockFetch(() =>
      readerOk({
        title: "Rich Page",
        url: "https://example.com/rich",
        content: LONG_BODY,
        links: [{ text: "Docs", url: "https://docs.example/guide" }],
        images: [{ alt: "Logo", url: "https://images.example/logo.png" }],
      }),
    );
    try {
      const result = await createFetchToolDefinition().execute("t", {
        urls: ["https://example.com/rich"],
        include_links: true,
        describe_images: true,
      });
      const expected = [
        "## Rich Page",
        "URL: https://example.com/rich",
        "",
        LONG_BODY,
        "",
        "### Links",
        "- [Docs](https://docs.example/guide)",
        "",
        "### Images",
        "- Logo: https://images.example/logo.png",
      ].join("\n");
      assert.equal(result.content[0].text, expected);
      const page = result.details.pages[0];
      assert.equal(result.content[0].text.slice(page.bodyStart, page.end), expected.slice(expected.indexOf(LONG_BODY)));
    } finally {
      mock.restore();
    }
  }),
);

test("fetch fails before network when key missing", async () => {
  const savedKey = process.env.JINA_API_KEY;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.JINA_API_KEY;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  const mock = installMockFetch(() => readerOk({ url: "https://x.example", content: LONG_BODY }));
  try {
    const result = await createFetchToolDefinition().execute("t", { urls: ["https://x.example"] });
    assert.match(result.content[0].text, /JINA_API_KEY|Missing.*key/i);
    assert.equal(result.details.error, "Missing JINA_API_KEY");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    if (savedKey !== undefined) process.env.JINA_API_KEY = savedKey;
    if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  }
});

// === Fetch: rendering ===

test(
  "fetch renderCall shows urls plus mode and options",
  withKey(async () => {
    const mock = installMockFetch(() => readerOk({ url: "https://x.example", content: LONG_BODY }));
    try {
      const def = createFetchToolDefinition();
      const args = {
        urls: ["https://example.com/a", "https://example.com/b"],
        mode: "full",
        max_tokens: 9000,
        include_links: true,
      };
      const lines = render(def.renderCall(args, plainTheme, NO_CONTEXT), 80);
      assert.ok(lines[0].includes("fetch"));
      assert.ok(lines[0].includes("example.com/a"));
      assert.ok(lines.some((l) => l.includes("full")));
      assert.ok(lines.some((l) => l.includes("9000 tokens")));
      assert.ok(lines.some((l) => l.includes("links")));
      assert.ok(lines.join("\n").includes("+1"), "additional URLs are summarized by count");
      assert.equal(render(def.renderCall(args, plainTheme, NO_CONTEXT), 200).length, 1, "call summary is one logical line");
      assertMaxWidth(lines, 80);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch renderResult collapsed summarizes fetched/failed/retried",
  withKey(async () => {
    const mock = installMockFetch(() => readerOk({ title: "P", url: "https://example.com/p", content: LONG_BODY }));
    try {
      const result = await createFetchToolDefinition().execute("t", { urls: ["https://example.com/p"] });
      const lines = render(
        createFetchToolDefinition().renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      assert.ok(lines[0].includes("1 page fetched"));
      assert.ok(lines[0].includes("to expand"));
      assertMaxWidth(lines, 80);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch renderResult expanded shows title link, metadata, and full body without truncation",
  withKey(async () => {
    const body = "UniqueBodyToken ".repeat(20) + LONG_BODY; // > 200 non-ws
    const mock = installMockFetch(() =>
      readerOk({ title: "Example Page", url: "https://example.com/page", description: "d", content: body }),
    );
    try {
      const result = await createFetchToolDefinition().execute("t", { urls: ["https://example.com/page"] });
      const lines = render(
        createFetchToolDefinition().renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      const joined = lines.join("\n");
      assert.ok(joined.includes("Example Page"), "title heading shown");
      assert.ok(joined.includes("https://example.com/page"), "clickable url shown");
      assert.ok(joined.includes("lines"), "line-count metadata shown");
      assert.ok(joined.includes("UniqueBodyToken"), "full body is present (not truncated)");
      assert.ok(joined.includes("to collapse"), "collapse hint shown");
      assertMaxWidth(lines, 80);
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch expanded output preserves description and split token usage metadata",
  withKey(async () => {
    const mock = installMockFetch(() =>
      readerOk({
        title: "Metadata Page",
        url: "https://example.com/meta",
        description: "A useful description",
        content: LONG_BODY,
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    try {
      const def = createFetchToolDefinition();
      const result = await def.execute("t", { urls: ["https://example.com/meta"] });
      assert.equal(result.details.pages[0].description, "A useful description");
      assert.equal(result.details.pages[0].usage, "3+4 tokens");
      const expanded = render(def.renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT), 80).join("\n");
      assert.ok(expanded.includes("A useful description"));
      assert.ok(expanded.includes("3+4 tokens"));
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch renderResult partial shows a fetching label",
  withKey(async () => {
    const def = createFetchToolDefinition();
    const partial = {
      content: [{ type: "text", text: "Fetching..." }],
      details: { urls: ["https://x.example"], succeeded: 0, failed: 0, results: [], failedUrls: [], phase: "fetching" },
    };
    const lines = render(def.renderResult(partial, { expanded: false, isPartial: true }, plainTheme, NO_CONTEXT), 80);
    assert.match(lines.join("\n"), /fetching/i);
  }),
);

test(
  "fetch renderResult error (cancelled) shows the error in collapsed state",
  withKey(async () => {
    const def = createFetchToolDefinition();
    const errResult = {
      content: [{ type: "text", text: "Request cancelled." }],
      details: {
        urls: ["https://x.example"],
        succeeded: 0,
        failed: 0,
        results: [],
        failedUrls: [],
        phase: "done",
        error: "Cancelled",
      },
    };
    const lines = render(def.renderResult(errResult, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT), 80);
    assert.ok(lines[0].includes("✗"));
    assert.ok(lines[0].includes("Cancelled"));
  }),
);

test(
  "fetch all-failed result uses an error summary and remains expandable",
  withKey(async () => {
    const mock = installMockFetch(() => jsonResponse(404, { error: "missing" }));
    try {
      const def = createFetchToolDefinition();
      const result = await def.execute("t", { urls: ["https://a.example", "https://b.example"] });
      const collapsed = render(def.renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT), 80).join("\n");
      assert.ok(collapsed.includes("✗ 2 pages failed"));
      assert.ok(collapsed.includes("to expand"));
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch partial failure preserves input order and shows the failed page in place",
  withKey(async () => {
    const mock = installMockFetch((url) => {
      if (url.includes("ok.example")) {
        return readerOk({ title: "Ok Page", url: "https://ok.example", content: LONG_BODY });
      }
      return jsonResponse(500, { error: "server error" });
    });
    try {
      const result = await createFetchToolDefinition().execute("t", {
        urls: ["https://ok.example", "https://bad.example"],
      });
      assert.equal(result.details.succeeded, 1);
      assert.equal(result.details.failed, 1);
      assert.equal(result.details.pages.length, 2);
      assert.equal(result.details.pages[0].error, undefined);
      assert.equal(result.details.pages[1].error !== undefined, true);
      assert.ok(result.details.pages[1].title.startsWith("bad.example"), "failed page title is shortened url");
      const failedPage = result.details.pages[1];
      assert.ok(result.content[0].text.slice(failedPage.start, failedPage.end).includes("[Failed:"));

      // Collapsed summary mentions the failure.
      const collapsed = render(
        createFetchToolDefinition().renderResult(result, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      assert.ok(collapsed[0].includes("1 failed"));

      // Expanded preserves order: success first, failure second (in place).
      const expanded = render(
        createFetchToolDefinition().renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      const joined = expanded.join("\n");
      const okIdx = joined.indexOf("Ok Page");
      const failIdx = joined.indexOf("bad.example");
      assert.ok(okIdx >= 0 && failIdx > okIdx, "failed page rendered after the success, in input order");
      assert.ok(joined.includes("✗"), "failed page uses the visible error state");
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch expanded output shows the redirect target",
  withKey(async () => {
    const mock = installMockFetch(() =>
      readerOk({
        title: "Moved Page",
        url: "https://example.com/start",
        finalUrl: "https://example.com/final",
        content: LONG_BODY,
      }),
    );
    try {
      const result = await createFetchToolDefinition().execute("t", { urls: ["https://example.com/start"] });
      const expanded = render(
        createFetchToolDefinition().renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      ).join("\n");
      assert.ok(expanded.includes("Redirected to"));
      assert.ok(expanded.includes("https://example.com/final"));
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch retries once on thin content and reports retried metadata",
  withKey(async () => {
    const mock = installMockFetch((url, init) => {
      if (url.startsWith("https://r.jina.ai/")) {
        const headers = init?.headers ?? {};
        const isBrowserRetry =
          headers["X-Engine"] === "browser" || headers["X-Engine"] === "browser";
        const content = isBrowserRetry ? LONG_BODY : "tiny";
        return readerOk({ title: "T", url: "https://retry.example", content });
      }
      return jsonResponse(200, {});
    });
    try {
      const result = await createFetchToolDefinition().execute("t", { urls: ["https://retry.example"] });
      assert.equal(result.details.pages[0].retried, true);
      // Two reader calls: initial thin + browser retry.
      const readerCalls = mock.calls.filter((c) => c.url.startsWith("https://r.jina.ai/"));
      assert.equal(readerCalls.length, 2);
      assert.equal(readerCalls[1].headers["X-Engine"], "browser");
      // Expanded render surfaces the retried metadata.
      const expanded = render(
        createFetchToolDefinition().renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT),
        80,
      );
      assert.ok(expanded.join("\n").includes("retried"));
    } finally {
      mock.restore();
    }
  }),
);

test(
  "fetch sanitizes the display copy while preserving unsafe source bytes in model content",
  withKey(async () => {
    const body = `${LONG_BODY}\n\x1b]0;owned\x07\n[unsafe](javascript:alert(1))`;
    const mock = installMockFetch(() =>
      readerOk({ title: "Unsafe Page", url: "https://example.com/unsafe", content: body }),
    );
    try {
      const def = createFetchToolDefinition();
      const result = await def.execute("t", { urls: ["https://example.com/unsafe"] });
      assert.ok(result.content[0].text.includes("\x1b]0;owned\x07"), "model content stays byte-compatible");
      const rendered = def.renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT).render(80).join("\n");
      assert.equal(rendered.includes("]0;owned"), false, "terminal title control is absent from display");
      assert.equal(rendered.includes("\x1b]8;;javascript:"), false, "unsafe hyperlink is never emitted");
    } finally {
      mock.restore();
    }
  }),
);

test("fetch legacy all-failed details show an expand hint for their preserved content", () => {
  const def = createFetchToolDefinition();
  const legacy = {
    content: [{ type: "text", text: "## legacy.example\n\n[Failed: unavailable]" }],
    details: {
      urls: ["https://legacy.example"],
      succeeded: 0,
      failed: 1,
      results: [],
      failedUrls: [{ url: "https://legacy.example", error: "unavailable", retried: false }],
      phase: "done",
    },
  };
  const collapsed = render(def.renderResult(legacy, { expanded: false, isPartial: false }, plainTheme, NO_CONTEXT), 80).join("\n");
  assert.ok(collapsed.includes("✗ 1 page failed"));
  assert.ok(collapsed.includes("to expand"));
});

test("fetch renderResult expanded falls back to full content for legacy details without pages", () => {
  const def = createFetchToolDefinition();
  const legacy = {
    content: [{ type: "text", text: "## Legacy Heading\n\nLegacy body text here." }],
    details: {
      urls: ["https://legacy.example"],
      succeeded: 1,
      failed: 0,
      results: [{ url: "https://legacy.example", finalUrl: "https://legacy.example", lines: 1, retried: false }],
      failedUrls: [],
      phase: "done",
    },
  };
  const lines = render(def.renderResult(legacy, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT), 80);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Legacy Heading"), "heading rendered from full content");
  assert.ok(joined.includes("Legacy body text here."), "body rendered from full content");
});

test("fetch renderResult expanded wraps within a narrow terminal", async () => {
  const def = createFetchToolDefinition();
  const result = {
    content: [{ type: "text", text: "## T\nURL: https://example.com\n\n" + LONG_BODY }],
    details: {
      urls: ["https://example.com"],
      succeeded: 1,
      failed: 0,
      results: [],
      failedUrls: [],
      pages: [
        {
          url: "https://example.com",
          title: "T",
          lines: 6,
          retried: false,
          start: 0,
          end: ("## T\nURL: https://example.com\n\n" + LONG_BODY).length,
          bodyStart: "## T\nURL: https://example.com\n\n".length,
        },
      ],
      phase: "done",
    },
  };
  const lines = render(def.renderResult(result, { expanded: true, isPartial: false }, plainTheme, NO_CONTEXT), 30);
  assertMaxWidth(lines, 30);
});

// === Run ===

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

rmSync(tempAgentDir, { recursive: true, force: true });

console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
