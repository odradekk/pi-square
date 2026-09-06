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
    "[remote](https://evil.example/path)",
    "www.evil.example user@evil.example",
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
  assert.ok(safe.includes("\\[x](javascript\\:alert(1))"));
  assert.ok(safe.includes("\\[x]\\[bad]"));
  assert.ok(safe.includes("\\[bad]: javascript\\:alert(1)"));
  assert.ok(safe.includes("\\[remote](https\\://evil.example/path)"));
  assert.ok(safe.includes("www\\.evil.example user\\@evil.example"));
  assert.ok(safe.includes("\\<javascript\\:alert(1)>"));
  assert.ok(safe.includes("> \\[shortcut]"));
  assert.ok(safe.includes("> \\[shortcut]: javascript\\:alert(1)"));
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

// === Fetch: content regression + offset details ===

test(
  "search partial failure with no results preserves the per-query error details",
  withKey(async () => {
    const mock = installMockFetch((_url, _init, i) =>
      i === 0 ? jsonResponse(500, { error: "down" }) : searchOk([]),
    );
    try {
      const result = await createSearchToolDefinition().execute("t", { queries: ["bad", "empty"] });
      assert.equal(result.details.results.length, 0);
      assert.equal(result.details.failedQueries.length, 1);
      assert.equal(result.details.failedQueries[0].query, "bad");
      assert.match(result.details.failedQueries[0].error, /HTTP 500/);
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
