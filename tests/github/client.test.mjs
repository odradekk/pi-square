import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  GitHubApiError,
  githubRequest,
  resolveGitHubToken,
} = load(join(packageRoot, "src", "github", "client.ts"));

function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const call = { url: String(url), init, headers };
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

test("token resolution uses GITHUB_TOKEN before auth.json github.key", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-square-github-auth-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldToken = process.env.GITHUB_TOKEN;
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ github: { key: "file-token" } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.GITHUB_TOKEN;
  try {
    assert.equal(resolveGitHubToken(), "file-token");
    process.env.GITHUB_TOKEN = "env-token";
    assert.equal(resolveGitHubToken(), "env-token");
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request fixes origin and required authenticated headers while encoding query", async () => {
  const mock = installFetch(() => json(200, { ok: true }, {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": "1234",
    "x-ratelimit-resource": "core",
    link: '<https://api.github.com/test?page=2>; rel="next"',
  }));
  try {
    const result = await githubRequest({ token: "secret", path: "/search/code", query: { q: "a b&x" } });
    const url = new URL(mock.calls[0].url);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.searchParams.get("q"), "a b&x");
    assert.equal(mock.calls[0].headers.get("authorization"), "Bearer secret");
    assert.equal(mock.calls[0].headers.get("user-agent"), "pi-square");
    assert.equal(mock.calls[0].headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(mock.calls[0].init.redirect, "manual");
    assert.equal(result.hasNext, true);
    assert.deepEqual(result.rate, { limit: 5000, remaining: 4999, used: 1, reset: 1234, resource: "core" });
  } finally { mock.restore(); }
});

test("one same-origin redirect is followed and cross-origin redirects are rejected", async () => {
  const same = installFetch((_call, index) => index === 0
    ? new Response("", { status: 301, headers: { location: "https://api.github.com/repos/new/name" } })
    : json(200, { ok: true }));
  try {
    await githubRequest({ token: "secret", path: "/repos/old/name" });
    assert.equal(same.calls.length, 2);
    assert.equal(same.calls[1].headers.get("authorization"), "Bearer secret");
  } finally { same.restore(); }

  const cross = installFetch(() => new Response("", { status: 302, headers: { location: "https://evil.example/steal" } }));
  try {
    await assert.rejects(
      githubRequest({ token: "secret", path: "/repos/old/name" }),
      (error) => error instanceof GitHubApiError && error.code === "UNSAFE_REDIRECT",
    );
    assert.equal(cross.calls.length, 1);
  } finally { cross.restore(); }
});

test("transient failures retry once and rate limits do not retry", async () => {
  const transient = installFetch((_call, index) => index === 0 ? json(503, { message: "later" }) : json(200, { ok: true }));
  try {
    await githubRequest({ token: "secret", path: "/test" });
    assert.equal(transient.calls.length, 2);
  } finally { transient.restore(); }

  const limited = installFetch(() => json(403, { message: "API rate limit exceeded" }, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "4567",
  }));
  try {
    await assert.rejects(
      githubRequest({ token: "secret", path: "/test" }),
      (error) => error instanceof GitHubApiError && error.code === "RATE_LIMITED" && error.rate.reset === 4567,
    );
    assert.equal(limited.calls.length, 1);
  } finally { limited.restore(); }
});

test("provider errors redact credentials and classify inaccessible resources", async () => {
  const mock = installFetch(() => json(404, { message: "Authorization: Bearer ghp_leaked-token" }));
  try {
    await assert.rejects(
      githubRequest({ token: "secret", path: "/private" }),
      (error) => {
        assert.equal(error.code, "NOT_FOUND_OR_INACCESSIBLE");
        assert.doesNotMatch(error.message, /ghp_leaked|secret/);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      },
    );
  } finally { mock.restore(); }
});

test("oversized error bodies are bounded and exact configured tokens are redacted", async () => {
  const mock = installFetch((_call, index) => index === 0
    ? json(401, { message: `plain-secret-token ${"x".repeat(20_000)}` })
    : json(500, { message: "y".repeat(20_000) }));
  try {
    await assert.rejects(
      githubRequest({ token: "plain-secret-token", path: "/first" }),
      (error) => {
        assert.doesNotMatch(error.message, /plain-secret-token/);
        assert.ok(error.message.length < 1_100);
        return true;
      },
    );
    await assert.rejects(
      githubRequest({ token: "another-token", path: "/second" }),
      (error) => error.message.length < 1_100,
    );
  } finally { mock.restore(); }
});

test("response caps, malformed JSON, raw bytes, and pre-abort are enforced", async () => {
  const oversized = installFetch(() => new Response("0123456789", { status: 200 }));
  try {
    await assert.rejects(githubRequest({ token: "x", path: "/test", cap: 5 }), /exceeded 5 byte cap/);
  } finally { oversized.restore(); }

  const malformed = installFetch(() => new Response("{", { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await assert.rejects(
      githubRequest({ token: "x", path: "/test" }),
      (error) => error instanceof GitHubApiError && error.code === "INVALID_RESPONSE",
    );
  } finally { malformed.restore(); }

  const raw = installFetch(() => new Response(new Uint8Array([0, 1, 2]), { status: 200 }));
  try {
    const result = await githubRequest({ token: "x", path: "/test", responseType: "bytes" });
    assert.deepEqual([...result.data], [0, 1, 2]);
  } finally { raw.restore(); }

  const controller = new AbortController();
  controller.abort();
  const never = installFetch(() => { throw new Error("should not fetch"); });
  try {
    await assert.rejects(githubRequest({ token: "x", path: "/test", signal: controller.signal }), { name: "AbortError" });
    assert.equal(never.calls.length, 0);
  } finally { never.restore(); }
});

let failures = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.error(`FAIL: ${name}`); console.error(error); }
}
console.log(`\n${tests.length} tests, ${failures} failed`);
process.exit(failures ? 1 : 0);
