import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";

import jiti from "jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const agentDir = resolve(packageRoot, "..", "..");
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

const encoder = new TextEncoder();

function installMockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    const callIndex = calls.length;
    const record = { url: urlStr, headers: {}, signal: init?.signal };
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        for (const [k, v] of h.entries()) record.headers[k] = v;
      } else if (typeof h === "object") {
        for (const [k, v] of Object.entries(h)) record.headers[k] = String(v);
      }
    }
    calls.push(record);
    return await handler(urlStr, init, callIndex, record);
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

function searchOk(results, extra = {}) {
  return jsonResponse(200, { results, searchFilterApplied: false, ...extra });
}

function contextOk(codeSnippets = [], infoSnippets = [], rules = undefined) {
  const body = { codeSnippets, infoSnippets };
  if (rules !== undefined) body.rules = rules;
  return jsonResponse(200, body);
}

function pendingResponse(retryAfter = "30") {
  return jsonResponse(202, {}, { "Retry-After": retryAfter });
}

function streamingResponse(status, chunks, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Load tool modules
// ---------------------------------------------------------------------------

const libsModule = load(join(packageRoot, "src", "web", "tools", "libs.ts"));
const docsModule = load(join(packageRoot, "src", "web", "tools", "docs.ts"));

const { createLibsToolDefinition, registerLibsTool } = libsModule;
const { createDocsToolDefinition, registerDocsTool } = docsModule;

const CONTEXT7_BASE = "https://context7.com/api/v2";

// ---------------------------------------------------------------------------
// Temp agent dir for missing-key tests
// ---------------------------------------------------------------------------

const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-square-c7-tools-test-"));
writeFileSync(join(tempAgentDir, "settings.json"), "{}");
writeFileSync(join(tempAgentDir, "auth.json"), "{}");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// === Schema tests ===

test("libs schema has libraryName, query, mode, limit", () => {
  const def = createLibsToolDefinition();
  const props = def.parameters.properties;
  assert.ok(props.libraryName, "libraryName required");
  assert.ok(props.query, "query required");
  assert.ok(props.mode, "mode should exist");
  assert.ok(props.limit, "limit should exist");
  assert.equal(def.parameters.required?.includes("libraryName"), true);
  assert.equal(def.parameters.required?.includes("query"), true);
});

test("libs limit default is 5, range 1-10", () => {
  const def = createLibsToolDefinition();
  const limit = def.parameters.properties.limit;
  assert.equal(limit.default, 5);
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, 10);
});

test("docs schema has libraryId, query, mode, kind, max_tokens", () => {
  const def = createDocsToolDefinition();
  const props = def.parameters.properties;
  assert.ok(props.libraryId, "libraryId required");
  assert.ok(props.query, "query required");
  assert.ok(props.mode, "mode should exist");
  assert.ok(props.kind, "kind should exist");
  assert.ok(props.max_tokens, "max_tokens should exist");
  assert.equal(def.parameters.required?.includes("libraryId"), true);
  assert.equal(def.parameters.required?.includes("query"), true);
});

test("docs max_tokens default is 12000, range 500-50000", () => {
  const def = createDocsToolDefinition();
  const mt = def.parameters.properties.max_tokens;
  assert.equal(mt.default, 12000);
  assert.equal(mt.minimum, 500);
  assert.equal(mt.maximum, 50000);
});

test("docs libraryId has pattern constraint", () => {
  const def = createDocsToolDefinition();
  const lid = def.parameters.properties.libraryId;
  assert.ok(lid.pattern, "libraryId should have a pattern");
});

// === Registration wrapper tests ===

test("registerLibsTool registers tool named libs", () => {
  const tools = new Map();
  const pi = {
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
  registerLibsTool(pi);
  assert.ok(tools.has("libs"), "libs tool should be registered");
});

test("registerDocsTool registers tool named docs", () => {
  const tools = new Map();
  const pi = {
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
  registerDocsTool(pi);
  assert.ok(tools.has("docs"), "docs tool should be registered");
});

// === Missing key ===

test("libs fails before network when key missing", async () => {
  const savedKey = process.env.CONTEXT7_API_KEY;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.CONTEXT7_API_KEY;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  const mock = installMockFetch(() => searchOk([]));
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /CONTEXT7_API_KEY|Missing.*key/i);
    assert.equal(result.details.status, "error");
    assert.equal(mock.calls.length, 0, "should not make network request without key");
  } finally {
    mock.restore();
    if (savedKey !== undefined) process.env.CONTEXT7_API_KEY = savedKey;
    if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("docs fails before network when key missing", async () => {
  const savedKey = process.env.CONTEXT7_API_KEY;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.CONTEXT7_API_KEY;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  const mock = installMockFetch(() => contextOk());
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "hooks" });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /CONTEXT7_API_KEY|Missing.*key/i);
    assert.equal(result.details.status, "error");
    assert.equal(mock.calls.length, 0, "should not make network request without key");
  } finally {
    mock.restore();
    if (savedKey !== undefined) process.env.CONTEXT7_API_KEY = savedKey;
    if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("libs propagates a pre-aborted signal", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const controller = new AbortController();
  controller.abort();
  const mock = installMockFetch(() => searchOk([]));
  try {
    const def = createLibsToolDefinition();
    await assert.rejects(
      def.execute("test", { libraryName: "react", query: "hooks" }, controller.signal),
      (error) => error?.name === "AbortError",
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs propagates a pre-aborted signal", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const controller = new AbortController();
  controller.abort();
  const mock = installMockFetch(() => contextOk());
  try {
    const def = createDocsToolDefinition();
    await assert.rejects(
      def.execute("test", { libraryId: "/facebook/react", query: "hooks" }, controller.signal),
      (error) => error?.name === "AbortError",
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === libs normalization and counts ===

test("libs normalizes valid candidates with all fields", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([
      {
        id: "/facebook/react",
        title: "React",
        description: "UI library",
        branch: "main",
        lastUpdateDate: "2025-01-15T10:30:00.000Z",
        state: "finalized",
        totalTokens: 500000,
        totalSnippets: 2500,
        stars: 220000,
        trustScore: 10,
        benchmarkScore: 95.5,
        versions: ["v18.2.0", "v17.0.2"],
        source: "https://user:secret@example.com/react\u001b[31m",
      },
    ]),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.counts.received, 1);
    assert.equal(result.details.counts.invalid, 0);
    assert.equal(result.details.counts.eligible, 1);
    assert.equal(result.details.counts.returned, 1);
    const c = result.details.candidates[0];
    assert.equal(c.rank, 1);
    assert.equal(c.id, "/facebook/react");
    assert.equal(c.title, "React");
    assert.equal(c.description, "UI library");
    assert.equal(c.branch, "main");
    assert.equal(c.totalTokens, 500000);
    assert.equal(c.totalSnippets, 2500);
    assert.equal(c.stars, 220000);
    assert.deepEqual(c.versions, ["v18.2.0", "v17.0.2"]);
    assert.equal(c.lastUpdateDate, "2025-01-15T10:30:00.000Z");
    assert.equal(c.state, "finalized");
    assert.equal(c.trustScore, 10);
    assert.equal(c.benchmarkScore, 95.5);
    assert.equal(c.source, "https://example.com/react");
    assert.match(result.content[0].text, /tokens: 500000/);
    assert.match(result.content[0].text, /snippets: 2500/);
    assert.match(result.content[0].text, /trust: 10/);
    assert.doesNotMatch(result.content[0].text, /user:secret|\u001b/);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs skips candidates missing required id", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([
      { title: "No ID", description: "missing id" },
      { id: "/facebook/react", title: "React" },
    ]),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.counts.received, 2);
    assert.equal(result.details.counts.invalid, 1);
    assert.equal(result.details.counts.eligible, 1);
    assert.equal(result.details.candidates.length, 1);
    assert.equal(result.details.candidates[0].id, "/facebook/react");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs skips candidates missing required title", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([
      { id: "/no/title" },
      { id: "/has/title", title: "Good" },
    ]),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.counts.invalid, 1);
    assert.equal(result.details.candidates.length, 1);
    assert.equal(result.details.candidates[0].title, "Good");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs omits optional fields with wrong types", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([
      {
        id: "/facebook/react",
        title: "React",
        description: 12345, // wrong type
        totalTokens: "not a number", // wrong type
        versions: "not an array", // wrong type
        stars: true, // wrong type
        source: "javascript:alert(1)",
      },
    ]),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    const c = result.details.candidates[0];
    assert.equal(c.description, undefined, "wrong-type description omitted");
    assert.equal(c.totalTokens, undefined, "wrong-type totalTokens omitted");
    assert.equal(c.versions, undefined, "wrong-type versions omitted");
    assert.equal(c.stars, undefined, "wrong-type stars omitted");
    assert.equal(c.source, undefined, "unsafe source scheme omitted");
    // Still valid because id and title are present
    assert.equal(result.details.counts.invalid, 0);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs valid empty results is ready, not error", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => searchOk([]));
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.candidates.length, 0);
    assert.equal(result.details.counts.received, 0);
    assert.equal(result.details.counts.returned, 0);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs caps oversized candidates and reports the omission", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([{ id: "/large/library", title: "Large", description: "x".repeat(150_000) }]),
  );
  try {
    const result = await createLibsToolDefinition().execute(
      "test",
      { libraryName: "large", query: "usage" },
    );
    assert.equal(result.details.counts.oversized, 1);
    assert.equal(result.details.candidates.length, 0);
    assert.match(result.content[0].text, /1 oversized/);
    assert.ok(result.content[0].text.length <= 128_000);
    assert.ok(JSON.stringify(result.details).length <= 128_000);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs reselects later candidates under high-cardinality aggregate pressure", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const candidates = [
    { id: "/large/library", title: "Large", description: "x".repeat(31_940) },
    ...Array.from({ length: 20_000 }, (_, index) => ({ id: `/small/${index}`, title: "Small" })),
  ];
  const mock = installMockFetch(() => searchOk(candidates));
  try {
    const result = await createLibsToolDefinition().execute(
      "test",
      { libraryName: "many", query: "aggregate cap", limit: 10 },
    );
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.counts.received, 20_001);
    assert.equal(result.details.counts.returned, 10);
    assert.equal(result.details.candidates[0].rank, 2, "later candidates should be reconsidered when the prefix cannot leave room for its summary");
    assert.ok(result.details.counts.omitted > 0);
    assert.ok(result.content[0].text.length <= 32_000);
    assert.ok(JSON.stringify(result.details).length <= 128_000);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs limit caps returned candidates", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    id: `/lib/${i}`,
    title: `Lib ${i}`,
  }));
  const mock = installMockFetch(() => searchOk(candidates));
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks", limit: 3 });
    assert.equal(result.details.candidates.length, 3);
    assert.equal(result.details.counts.returned, 3);
    assert.equal(result.details.counts.eligible, 8);
    assert.equal(result.details.candidates[0].rank, 1);
    assert.equal(result.details.candidates[2].rank, 3);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs preserves provider rank and reports limited candidates in content", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([
      { title: "invalid without id" },
      { id: "/valid/one", title: "One" },
      { id: "/valid/two", title: "Two" },
    ]),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "valid", query: "usage", limit: 1 });
    assert.equal(result.details.candidates[0].rank, 2, "rank must refer to provider position before invalid records are skipped");
    assert.equal(result.details.counts.omitted, 1);
    assert.match(result.content[0].text, /1 candidate omitted/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs preserves searchFilterApplied flag", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    jsonResponse(200, { results: [{ id: "/x", title: "X" }], searchFilterApplied: true }),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.searchFilterApplied, true);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs default limit is 5", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    id: `/lib/${i}`,
    title: `Lib ${i}`,
  }));
  const mock = installMockFetch(() => searchOk(candidates));
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.candidates.length, 5, "default limit should be 5");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs output Markdown includes rank, id, title", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    searchOk([{ id: "/facebook/react", title: "React", description: "UI lib" }]),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    const text = result.content[0].text;
    assert.match(text, /\[1\]/);
    assert.match(text, /\/facebook\/react/);
    assert.match(text, /React/);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === docs normalization ===

test("docs parses code snippets with valid codeList items", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      {
        codeTitle: "Example",
        codeDescription: "desc",
        codeLanguage: "typescript",
        codeTokens: 50,
        codeId: "https://github.com/x/y/blob/main/z#_snippet_0",
        pageTitle: "Page",
        codeList: [{ language: "typescript", code: "const x = 1;" }],
      },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.codeSnippets.length, 1);
    const s = result.details.codeSnippets[0];
    assert.equal(s.title, "Example");
    assert.equal(s.language, "typescript");
    assert.equal(s.tokens, 50);
    assert.equal(s.codeList.length, 1);
    assert.equal(s.codeList[0].language, "typescript");
    assert.ok(s.codeList[0].code.includes("const x = 1;"));
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs preserves and renders every valid codeList item", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      {
        codeTitle: "Two variants",
        codeTokens: 20,
        codeList: [
          { language: "ts", code: "const tsValue = 1;" },
          { language: "js", code: "const jsValue = 1;" },
        ],
      },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "variants" });
    assert.equal(result.details.codeSnippets[0].codeList.length, 2);
    assert.match(result.content[0].text, /const tsValue = 1;/);
    assert.match(result.content[0].text, /const jsValue = 1;/);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs parses info snippets", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([], [
      { pageId: "https://github.com/x/y", breadcrumb: "A > B", content: "Important info", contentTokens: 30 },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.infoSnippets.length, 1);
    const s = result.details.infoSnippets[0];
    assert.equal(s.content, "Important info");
    assert.equal(s.tokens, 30);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs skips code snippet with no valid codeList items", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      { codeTitle: "Bad", codeList: [{ language: "ts", code: "" }] }, // empty code
      { codeTitle: "Good", codeList: [{ language: "ts", code: "const x = 1;" }] },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.codeCounts.invalid, 1);
    assert.equal(result.details.codeSnippets.length, 1);
    assert.equal(result.details.codeSnippets[0].title, "Good");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs skips code snippet missing title", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      { codeList: [{ language: "ts", code: "const x = 1;" }] }, // no title
      { codeTitle: "Good", codeList: [{ language: "ts", code: "const x = 1;" }] },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.codeCounts.invalid, 1);
    assert.equal(result.details.codeSnippets.length, 1);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs skips info snippet with no string content", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([], [
      { content: 12345 }, // wrong type
      { content: "valid content" },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.infoCounts.invalid, 1);
    assert.equal(result.details.infoSnippets.length, 1);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs valid empty arrays is ready", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => contextOk([], []));
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.codeSnippets.length, 0);
    assert.equal(result.details.infoSnippets.length, 0);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Kind filtering ===

test("docs kind=code returns only code snippets", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk(
      [{ codeTitle: "Code", codeList: [{ language: "ts", code: "const x = 1;" }] }],
      [{ content: "Info text" }],
    ),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState", kind: "code" });
    assert.equal(result.details.codeSnippets.length, 1);
    assert.equal(result.details.infoSnippets.length, 0);
    // Info was still received but not returned
    assert.ok(result.details.infoCounts.received >= 1);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs kind=info returns only info snippets", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk(
      [{ codeTitle: "Code", codeList: [{ language: "ts", code: "const x = 1;" }] }],
      [{ content: "Info text" }],
    ),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState", kind: "info" });
    assert.equal(result.details.codeSnippets.length, 0);
    assert.equal(result.details.infoSnippets.length, 1);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs kind=all serializes code before info in Markdown", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk(
      [{ codeTitle: "Code Snippet", codeList: [{ language: "ts", code: "const x = 1;" }] }],
      [{ content: "Info text here" }],
    ),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    const text = result.content[0].text;
    const codeIdx = text.indexOf("Code Snippet");
    const infoIdx = text.indexOf("Info text here");
    assert.ok(codeIdx >= 0 && infoIdx >= 0, "both should appear");
    assert.ok(codeIdx < infoIdx, "code should come before info");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Budget behavior ===

test("docs respects max_tokens budget", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  // Create code snippets with known token costs
  const snippets = Array.from({ length: 20 }, (_, i) => ({
    codeTitle: `Snippet ${i}`,
    codeTokens: 1000, // 1000 tokens each
    codeList: [{ language: "ts", code: `const x${i} = ${i};` }],
  }));
  const mock = installMockFetch(() => contextOk(snippets));
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", {
      libraryId: "/facebook/react",
      query: "useState",
      max_tokens: 5000,
    });
    // With 1000-token snippets and 5000 budget, should fit ~5
    assert.ok(result.details.codeSnippets.length <= 5, `should fit at most 5 1000-token snippets in 5000 budget, got ${result.details.codeSnippets.length}`);
    assert.equal(result.details.codeCounts.oversized, 0, "individually valid snippets are not oversized");
    assert.ok(result.details.codeCounts.omitted > 0, "snippets that do not fit the remaining budget are omitted");
    assert.match(result.content[0].text, /snippet.*omitted/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs over-budget snippet is skipped, later ones may fit", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      { codeTitle: "Huge", codeTokens: 100000, codeList: [{ language: "ts", code: "x".repeat(1000) }] },
      { codeTitle: "Small", codeTokens: 100, codeList: [{ language: "ts", code: "const x = 1;" }] },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", {
      libraryId: "/facebook/react",
      query: "useState",
      max_tokens: 1000,
    });
    assert.ok(result.details.codeCounts.oversized >= 1, "huge snippet should be oversized");
    assert.ok(result.details.codeSnippets.some((s) => s.title === "Small"), "small snippet should still be selected");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs missing token count uses ceil(length/4) estimate", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const code = "const x = 1;"; // 13 chars → ceil(13/4) = 4 tokens
  const mock = installMockFetch(() =>
    contextOk([
      { codeTitle: "NoTokens", codeList: [{ language: "ts", code }] },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    const s = result.details.codeSnippets[0];
    // The serialized markdown for this snippet is longer than just the code,
    // so tokens should be at least ceil(code.length / 4) = 4
    assert.ok(s.tokens >= 4, `token estimate should be >= ceil(13/4)=4, got ${s.tokens}`);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs uses serialized size when upstream token metadata is fractional or too low", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([{
      codeTitle: "Undercounted",
      codeTokens: 0.5,
      codeList: [{ language: "ts", code: "x".repeat(3_000) }],
    }]),
  );
  try {
    const result = await createDocsToolDefinition().execute(
      "test",
      { libraryId: "/facebook/react", query: "tokens", max_tokens: 500 },
    );
    assert.equal(result.details.codeSnippets.length, 0);
    assert.equal(result.details.codeCounts.oversized, 1);
    assert.ok(result.details.estimatedTokens <= 500);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs skips a details-oversized snippet and retains a later small snippet", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => contextOk([
    {
      codeTitle: "Details oversized",
      codeDescription: "x".repeat(140_000),
      codeList: [{ language: "ts", code: "const tooLarge = true;" }],
    },
    {
      codeTitle: "Small",
      codeList: [{ language: "ts", code: "const kept = true;" }],
    },
  ]));
  try {
    const result = await createDocsToolDefinition().execute(
      "test",
      { libraryId: "/facebook/react", query: "details cap", max_tokens: 50_000 },
    );
    assert.equal(result.details.codeCounts.oversized, 1);
    assert.equal(result.details.codeCounts.omitted, 0);
    assert.deepEqual(result.details.codeSnippets.map((snippet) => snippet.title), ["Small"]);
    assert.match(result.content[0].text, /const kept = true/);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs handles near-cap high-cardinality arrays without argument expansion", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const records = '{"content":"x"},'.repeat(130_999) + '{"content":"x"}';
  const body = `{"codeSnippets":[],"infoSnippets":[${records}]}`;
  assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024, "fixture must remain below the raw cap");
  const mock = installMockFetch(() => jsonResponse(200, body));
  try {
    const result = await createDocsToolDefinition().execute(
      "test",
      { libraryId: "/facebook/react", query: "many records", kind: "info", max_tokens: 500 },
    );
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.infoCounts.received, 131_000);
    assert.ok(result.details.infoCounts.returned > 0);
    assert.ok(result.details.infoCounts.omitted > 0);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Opaque rules ===

test("docs preserves opaque rules when they fit", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk(
      [],
      [],
      { instructions: "Always use TypeScript strict mode", style: "functional" },
    ),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.ok(result.details.rules, "rules should be preserved");
    assert.equal(result.details.rulesOmitted, false);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs omits rules as whole unit when too large", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const hugeRules = { text: "x".repeat(500000) };
  const mock = installMockFetch(() => contextOk([], [], hugeRules));
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", {
      libraryId: "/facebook/react",
      query: "useState",
      max_tokens: 500,
    });
    assert.equal(result.details.rulesOmitted, true, "huge rules should be omitted as a whole");
    assert.equal(result.details.rules, null, "omitted rules should be null");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs applies the details cap to otherwise admissible rules", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => contextOk(
    [{ codeTitle: "Retained", codeList: [{ language: "ts", code: "const kept = true;" }] }],
    [],
    { text: "x".repeat(150_000) },
  ));
  try {
    const result = await createDocsToolDefinition().execute(
      "test",
      { libraryId: "/facebook/react", query: "rules", max_tokens: 50_000 },
    );
    assert.equal(result.details.rules, null);
    assert.equal(result.details.rulesOmitted, true);
    assert.match(result.content[0].text, /rules omitted/);
    assert.ok(JSON.stringify(result.details).length <= 128_000);
    assert.equal(result.details.codeSnippets.length, 1, "dropping oversized rules must not discard valid snippets");
    assert.match(result.content[0].text, /const kept = true/);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Pending and error results ===

test("docs 202 returns pending status", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => pendingResponse("60"));
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.status, "pending");
    assert.equal(result.details.retryAfter, 60);
    assert.match(result.content[0].text, /pending|finalized|processing/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs error returns error status", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => jsonResponse(404, { error: "not_found", message: "Library not found" }));
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.status, "error");
    assert.match(result.content[0].text, /404|not found|error/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs 202 returns pending status", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => pendingResponse("30"));
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.status, "pending");
    assert.equal(result.details.retryAfter, 30);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("in-flight tool updates use pending status", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const updates = [];
  const mock = installMockFetch((url) => url.includes("/libs/search") ? searchOk([]) : contextOk());
  try {
    await createLibsToolDefinition().execute(
      "libs",
      { libraryName: "react", query: "hooks" },
      undefined,
      (update) => updates.push(update),
    );
    await createDocsToolDefinition().execute(
      "docs",
      { libraryId: "/facebook/react", query: "hooks" },
      undefined,
      (update) => updates.push(update),
    );
    assert.equal(updates[0].details.status, "pending");
    assert.equal(updates[0].details.phase, "searching");
    assert.equal(updates[1].details.status, "pending");
    assert.equal(updates[1].details.phase, "fetching");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Safe URLs and fences ===

test("docs Markdown uses code fences with language", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      { codeTitle: "Test", codeList: [{ language: "python", code: "print('hello')" }] },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    const text = result.content[0].text;
    assert.match(text, /```python/);
    assert.match(text, /print\('hello'\)/);
    assert.match(text, /```$/m);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs handles code with unknown language safely", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      { codeTitle: "Test", codeList: [{ language: "", code: "x = 1" }] },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    const text = result.content[0].text;
    // Should still produce a fenced code block
    assert.match(text, /```/);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs chooses a fence longer than embedded backtick runs and sanitizes metadata", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    contextOk([
      {
        codeTitle: "\u001b[31mTitle\nInjected",
        codeDescription: "Description\u0000text",
        codeId: "https://user:secret@example.com/path#source",
        codeList: [{ language: "ts`\nunsafe", code: "before\n```\nafter" }],
      },
    ]),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "fences" });
    const text = result.content[0].text;
    assert.match(text, /````\n(?:before\n```\nafter)\n````/);
    assert.doesNotMatch(text, /\u001b|\u0000|user:secret|unsafe/);
    assert.equal(result.details.codeSnippets[0].source, "https://example.com/path#source");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Malformed provider records ===

test("docs rejects a non-array codeSnippets field", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    jsonResponse(200, { codeSnippets: "not an array", infoSnippets: [] }),
  );
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.status, "error");
    assert.match(result.details.error, /codeSnippets/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs rejects a non-array results field", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    jsonResponse(200, { results: "not an array", searchFilterApplied: false }),
  );
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.status, "error");
    assert.match(result.details.error, /results/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs rejects a missing results field", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => jsonResponse(200, { searchFilterApplied: false }));
  try {
    const def = createLibsToolDefinition();
    const result = await def.execute("test", { libraryName: "react", query: "hooks" });
    assert.equal(result.details.status, "error");
    assert.match(result.details.error, /results/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs rejects a non-array infoSnippets field", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() =>
    jsonResponse(200, { codeSnippets: [], infoSnippets: "not an array" }),
  );
  try {
    const result = await createDocsToolDefinition().execute(
      "test",
      { libraryId: "/facebook/react", query: "useState" },
    );
    assert.equal(result.details.status, "error");
    assert.match(result.details.error, /infoSnippets/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs and docs reject non-object top-level responses", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => jsonResponse(200, null));
  try {
    const libs = await createLibsToolDefinition().execute(
      "libs",
      { libraryName: "react", query: "hooks" },
    );
    const docs = await createDocsToolDefinition().execute(
      "docs",
      { libraryId: "/facebook/react", query: "hooks" },
    );
    assert.equal(libs.details.status, "error");
    assert.match(libs.details.error, /expected an object/i);
    assert.equal(docs.details.status, "error");
    assert.match(docs.details.error, /expected an object/i);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === Presentation tests ===

for (const [name, createDefinition] of [
  ["libs", createLibsToolDefinition],
  ["docs", createDocsToolDefinition],
]) {
  test(`${name} keeps the default Pi shell and defines native renderers`, () => {
    const definition = createDefinition();
    assert.equal(typeof definition.renderCall, "function");
    assert.equal(typeof definition.renderResult, "function");
    assert.equal(definition.renderShell, undefined);
  });
}

// === Mode mapping (fast=true for fast mode) ===

test("libs fast mode sends fast=true", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => searchOk([]));
  try {
    const def = createLibsToolDefinition();
    await def.execute("test", { libraryName: "react", query: "hooks", mode: "fast" });
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get("fast"), "true");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("libs and docs details record effective mode and local limits", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch((url) => url.includes("/libs/search") ? searchOk([]) : contextOk());
  try {
    const libs = await createLibsToolDefinition().execute(
      "libs",
      { libraryName: "react", query: "hooks", mode: "fast", limit: 3 },
    );
    const docs = await createDocsToolDefinition().execute(
      "docs",
      { libraryId: "/facebook/react", query: "hooks", mode: "fast", max_tokens: 900 },
    );
    assert.equal(libs.details.mode, "fast");
    assert.equal(libs.details.limit, 3);
    assert.equal(docs.details.mode, "fast");
    assert.equal(docs.details.maxTokens, 900);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs fast mode sends fast=true", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => contextOk());
  try {
    const def = createDocsToolDefinition();
    await def.execute("test", { libraryId: "/facebook/react", query: "useState", mode: "fast" });
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get("fast"), "true");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs always sends type=json", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => contextOk());
  try {
    const def = createDocsToolDefinition();
    await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get("type"), "json");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

test("docs max_tokens is not sent upstream", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch(() => contextOk());
  try {
    const def = createDocsToolDefinition();
    await def.execute("test", { libraryId: "/facebook/react", query: "useState", max_tokens: 5000 });
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.has("max_tokens"), false, "max_tokens should not be sent upstream");
    assert.equal(url.searchParams.has("maxTokens"), false);
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
  }
});

// === redirect details ===

test("docs details include redirect info when redirected", async () => {
  process.env.CONTEXT7_API_KEY = "test-key";
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) {
      return new Response(JSON.stringify({ redirectUrl: "/facebook/react-canonical" }), {
        status: 301,
        headers: { "Content-Type": "application/json", Location: "https://context7.com/facebook/react-canonical" },
      });
    }
    return contextOk();
  });
  try {
    const def = createDocsToolDefinition();
    const result = await def.execute("test", { libraryId: "/facebook/react", query: "useState" });
    assert.equal(result.details.redirected, true);
    assert.equal(result.details.finalLibraryId, "/facebook/react-canonical");
    assert.equal(result.details.libraryId, "/facebook/react");
  } finally {
    mock.restore();
    delete process.env.CONTEXT7_API_KEY;
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
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

// === Cleanup ===
rmSync(tempAgentDir, { recursive: true, force: true });

console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
