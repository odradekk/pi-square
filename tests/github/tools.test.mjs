import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const toolsModule = load(join(packageRoot, "src", "github", "tools.ts"));
const types = load(join(packageRoot, "src", "github", "types.ts"));
const {
  createGitHubCommitToolDefinition,
  createGitHubReadToolDefinition,
  createGitHubSearchToolDefinition,
  createGitHubToolDefinitions,
  createGitHubTreeToolDefinition,
  registerGitHubTools,
} = toolsModule;

function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, headers: new Headers(init.headers) };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function withToken(fn) {
  const old = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "github_pat_test-secret";
  try { return await fn(); }
  finally {
    if (old === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = old;
  }
}

function base64File(path, content, extra = {}) {
  return {
    type: "file",
    path,
    sha: "a".repeat(40),
    size: Buffer.byteLength(content),
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
    html_url: `https://github.com/acme/repo/blob/main/${path}`,
    ...extra,
  };
}

test("module exposes four strict parent tools with native renderers", () => {
  const definitions = createGitHubToolDefinitions();
  assert.deepEqual(definitions.map((tool) => tool.name), ["github_search", "github_read", "github_tree", "github_commit"]);
  for (const tool of definitions) {
    assert.equal(tool.renderShell, undefined);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.anyOf, undefined);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  assert.deepEqual(createGitHubSearchToolDefinition().parameters.required.sort(), ["kind", "query"]);
  assert.deepEqual(createGitHubCommitToolDefinition().parameters.required.sort(), ["ref", "repo"]);
  const registered = new Map();
  registerGitHubTools({ registerTool(tool) { registered.set(tool.name, tool); } });
  assert.deepEqual([...registered.keys()], definitions.map((tool) => tool.name));
});

test("missing PAT fails before network with stable details", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-square-github-missing-"));
  writeFileSync(join(dir, "auth.json"), "{}");
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.GITHUB_TOKEN;
  const mock = installFetch(() => { throw new Error("network must not run"); });
  try {
    const result = await createGitHubSearchToolDefinition().execute("x", { kind: "code", query: "hello" });
    assert.equal(result.details.errorCode, "MISSING_GITHUB_TOKEN");
    assert.match(result.content[0].text, /auth\.json/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("github_search parses repository and code results with completeness and rate metadata", () => withToken(async () => {
  const responses = [
    json(200, {
      total_count: 12,
      incomplete_results: false,
      items: [{ full_name: "acme/repo", html_url: "https://github.com/acme/repo", description: "A repo", language: "TypeScript", stargazers_count: 42 }],
    }, { link: '<https://api.github.com/search/repositories?page=2>; rel="next"', "x-ratelimit-remaining": "29", "x-ratelimit-limit": "30", "x-ratelimit-resource": "search" }),
    json(200, {
      total_count: 1,
      incomplete_results: true,
      items: [{ name: "index.ts", path: "src/index.ts", sha: "b".repeat(40), html_url: "https://github.com/acme/repo/blob/main/src/index.ts", repository: { full_name: "acme/repo" }, text_matches: [{ fragment: "const token = github_pat_source-secret;" }] }],
    }),
  ];
  const mock = installFetch((_call, index) => responses[index]);
  try {
    const repo = await createGitHubSearchToolDefinition().execute("x", { kind: "repositories", query: "acme", limit: 5 });
    assert.equal(repo.details.returned, 1);
    assert.equal(repo.details.hasMore, true);
    assert.equal(repo.details.rate.remaining, 29);
    assert.ok(Buffer.byteLength(JSON.stringify(repo.details)) <= types.GITHUB_DETAILS_CAP);
    assert.match(repo.content[0].text, /42 stars/);
    const code = await createGitHubSearchToolDefinition().execute("x", { kind: "code", query: "token repo:acme/repo" });
    assert.equal(code.details.incomplete, true);
    assert.doesNotMatch(code.content[0].text, /github_pat_source/);
    assert.match(code.content[0].text, /\[REDACTED\]/);
    assert.match(mock.calls[1].headers.get("accept"), /text-match/);
  } finally { mock.restore(); }
}));

test("github_search rejects provider-authored non-GitHub and credentialed URLs", () => withToken(async () => {
  const mock = installFetch(() => json(200, {
    total_count: 2,
    incomplete_results: false,
    items: [
      { full_name: "acme/repo", html_url: "https://evil.example/acme/repo" },
      { full_name: "acme/other", html_url: "https://user:pass@github.com/acme/other" },
    ],
  }));
  try {
    const result = await createGitHubSearchToolDefinition().execute("x", { kind: "repositories", query: "acme" });
    assert.equal(result.details.returned, 0);
    assert.doesNotMatch(result.content[0].text, /evil|user:pass/);
  } finally { mock.restore(); }
}));

test("github_search enforces final content and details budgets under high-cardinality results", () => withToken(async () => {
  const items = Array.from({ length: 50 }, (_, index) => ({
    name: `file-${index}.ts`,
    path: `${"deep/".repeat(150)}file-${index}.ts`,
    sha: "a".repeat(40),
    html_url: `https://github.com/acme/repo/blob/main/${"x".repeat(1_500)}-${index}`,
    repository: { full_name: "acme/repo" },
    text_matches: [{ fragment: "a".repeat(500) }, { fragment: "b".repeat(500) }],
  }));
  const mock = installFetch(() => json(200, { total_count: 50, incomplete_results: false, items }));
  try {
    const result = await createGitHubSearchToolDefinition().execute("x", { kind: "code", query: "needle", limit: 50 });
    assert.ok(result.details.omitted > 0);
    assert.ok(Buffer.byteLength(result.content[0].text) <= types.GITHUB_SEARCH_OUTPUT_CAP);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= types.GITHUB_DETAILS_CAP);
  } finally { mock.restore(); }
}));

test("github_search enforces the 1000-result window before network", () => withToken(async () => {
  const mock = installFetch(() => { throw new Error("network must not run"); });
  try {
    const result = await createGitHubSearchToolDefinition().execute("x", { kind: "code", query: "x", page: 21, limit: 50 });
    assert.equal(result.details.errorCode, "INVALID_INPUT");
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
}));

test("github_read returns bounded line pages, redacts credentials, and reports continuation", () => withToken(async () => {
  const source = ["one", "two github_pat_source-secret", "three", "four"].join("\n");
  const mock = installFetch(() => json(200, base64File("src/a.ts", source)));
  try {
    const result = await createGitHubReadToolDefinition().execute("x", { repo: "acme/repo", path: "src/a.ts", line: 2, limit: 2, ref: "main" });
    assert.equal(result.details.returnedLines, 2);
    assert.equal(result.details.totalLines, 4);
    assert.equal(result.details.hasMore, true);
    assert.match(result.content[0].text, /2: two \[REDACTED\]/);
    assert.match(result.content[0].text, /More lines: line 4/);
    const url = new URL(mock.calls[0].url);
    assert.equal(url.pathname, "/repos/acme/repo/contents/src/a.ts");
    assert.equal(url.searchParams.get("ref"), "main");
  } finally { mock.restore(); }
}));

test("github_read applies its cap to the complete serialized result", () => withToken(async () => {
  const mock = installFetch(() => json(200, base64File("long.txt", "😀".repeat(30_000))));
  try {
    const result = await createGitHubReadToolDefinition().execute("x", { repo: "acme/repo", path: "long.txt", limit: 1 });
    assert.ok(Buffer.byteLength(result.content[0].text) <= types.GITHUB_READ_OUTPUT_CAP);
    assert.equal(result.details.truncatedLines, 1);
    assert.doesNotMatch(result.content[0].text, /�/);
  } finally { mock.restore(); }
}));

test("github_read identifies binary files and refuses files over the local cap", () => withToken(async () => {
  const binary = { ...base64File("asset.bin", "x"), size: 3, content: Buffer.from([0, 1, 2]).toString("base64") };
  const large = { ...base64File("large.txt", ""), size: types.GITHUB_FILE_CAP + 1, content: "", encoding: "none" };
  const mock = installFetch((_call, index) => json(200, index === 0 ? binary : large));
  try {
    const first = await createGitHubReadToolDefinition().execute("x", { repo: "acme/repo", path: "asset.bin" });
    assert.equal(first.details.binary, true);
    assert.match(first.content[0].text, /Binary file/);
    const second = await createGitHubReadToolDefinition().execute("x", { repo: "acme/repo", path: "large.txt" });
    assert.equal(second.details.errorCode, "FILE_TOO_LARGE");
    assert.equal(mock.calls.length, 2);
  } finally { mock.restore(); }
}));

test("github_read uses the raw media type for larger object responses", () => withToken(async () => {
  const metadata = { type: "file", path: "large.txt", sha: "a".repeat(40), size: 5, encoding: "none", content: "", html_url: "https://github.com/acme/repo/blob/main/large.txt" };
  const mock = installFetch((call, index) => index === 0 ? json(200, metadata) : new Response("hello", { status: 200, headers: { "content-type": "application/octet-stream" } }));
  try {
    const result = await createGitHubReadToolDefinition().execute("x", { repo: "acme/repo", path: "large.txt" });
    assert.equal(result.details.binary, false);
    assert.match(result.content[0].text, /1: hello/);
    assert.equal(mock.calls[1].headers.get("accept"), "application/vnd.github.raw+json");
  } finally { mock.restore(); }
}));

test("github_tree traverses bounded depth, sorts paths, and paginates", () => withToken(async () => {
  const mock = installFetch((call) => {
    const path = new URL(call.url).pathname;
    if (path.endsWith("/contents")) return json(200, [
      { type: "file", path: "z.txt", size: 1, sha: "z", html_url: "https://github.com/acme/repo/blob/main/z.txt" },
      { type: "dir", path: "src", size: 0, sha: "s", html_url: "https://github.com/acme/repo/tree/main/src" },
    ]);
    return json(200, [{ type: "file", path: "src/a.ts", size: 2, sha: "a", html_url: "https://github.com/acme/repo/blob/main/src/a.ts" }]);
  });
  try {
    const result = await createGitHubTreeToolDefinition().execute("x", { repo: "acme/repo", depth: 2, offset: 1, limit: 2 });
    assert.deepEqual(result.details.entries.map((entry) => entry.path), ["src/a.ts", "z.txt"]);
    assert.equal(result.details.total, 3);
    assert.equal(result.details.requestsUsed, 2);
    assert.equal(result.details.requestBudgetExhausted, false);
  } finally { mock.restore(); }
}));

test("github_tree applies its cap to the complete serialized result", () => withToken(async () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({
    type: "file",
    path: `${"deep/".repeat(170)}file-${String(index).padStart(3, "0")}.ts`,
    size: index,
    sha: "a".repeat(40),
    html_url: `https://github.com/acme/repo/blob/main/file-${index}.ts`,
  }));
  const mock = installFetch(() => json(200, entries));
  try {
    const result = await createGitHubTreeToolDefinition().execute("x", { repo: "acme/repo", limit: 200 });
    assert.ok(result.details.returned < 200);
    assert.equal(result.details.hasMore, true);
    assert.ok(Buffer.byteLength(result.content[0].text) <= types.GITHUB_TREE_OUTPUT_CAP);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= types.GITHUB_DETAILS_CAP);
  } finally { mock.restore(); }
}));

test("github_tree stops at its request budget and marks the result incomplete", () => withToken(async () => {
  const dirs = Array.from({ length: 25 }, (_, index) => ({ type: "dir", path: `d${String(index).padStart(2, "0")}`, size: 0, sha: String(index) }));
  const mock = installFetch((_call, index) => json(200, index === 0 ? dirs : []));
  try {
    const result = await createGitHubTreeToolDefinition().execute("x", { repo: "acme/repo", depth: 2, limit: 5 });
    assert.equal(result.details.requestsUsed, 20);
    assert.equal(result.details.requestBudgetExhausted, true);
    assert.equal(result.details.hasMore, true);
    assert.equal(result.details.total, undefined);
    assert.ok(Buffer.byteLength(result.content[0].text) <= types.GITHUB_TREE_OUTPUT_CAP);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= types.GITHUB_DETAILS_CAP);
  } finally { mock.restore(); }
}));

test("github_commit includes bounded patches and marks missing or omitted patches", () => withToken(async () => {
  const hugePatch = "+x\n".repeat(40_000);
  const response = {
    sha: "c".repeat(40),
    html_url: "https://github.com/acme/repo/commit/c",
    commit: {
      message: "Fix token github_pat_source-secret\n\nBody",
      author: { name: "Dev", date: "2026-01-01T00:00:00Z" },
      verification: { verified: true },
    },
    stats: { additions: 3, deletions: 2, total: 5 },
    files: [
      { filename: "small.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" },
      { filename: "binary.bin", status: "modified", additions: 0, deletions: 0, changes: 0 },
      { filename: "huge.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: hugePatch },
    ],
  };
  const mock = installFetch(() => json(200, response, { link: '<https://api.github.com/commit?page=2>; rel="next"' }));
  try {
    const result = await createGitHubCommitToolDefinition().execute("x", { repo: "acme/repo", ref: "main", limit: 3 });
    assert.equal(result.details.returned, 3);
    assert.equal(result.details.hasMore, true);
    assert.equal(result.details.omittedPatches, 1);
    assert.deepEqual(result.details.files.map((file) => file.patchState), ["included", "missing", "omitted"]);
    assert.ok(Buffer.byteLength(result.content[0].text) <= types.GITHUB_COMMIT_OUTPUT_CAP);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= types.GITHUB_DETAILS_CAP);
    assert.doesNotMatch(result.content[0].text, /github_pat_source/);
    assert.match(result.content[0].text, /patch unavailable/);
    assert.match(result.content[0].text, /patch omitted/);
  } finally { mock.restore(); }
}));

let failures = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.error(`FAIL: ${name}`); console.error(error); }
}
console.log(`\n${tests.length} tests, ${failures} failed`);
process.exit(failures ? 1 : 0);
