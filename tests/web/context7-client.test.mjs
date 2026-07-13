import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Mock fetch infrastructure
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function installMockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    const callIndex = calls.length;
    const record = {
      url: urlStr,
      method: init?.method ?? "GET",
      headers: {},
      signal: init?.signal,
      redirect: init?.redirect,
      body: init?.body,
    };
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        for (const [k, v] of h.entries()) record.headers[k] = v;
      } else if (typeof h === "object") {
        for (const [k, v] of Object.entries(h)) record.headers[k] = String(v);
      }
    }
    calls.push(record);
    const response = await handler(urlStr, init, callIndex, record);
    return response;
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

function redirectResponse(redirectUrl, extra = {}) {
  const body = { redirectUrl, ...extra };
  return new Response(JSON.stringify(body), {
    status: 301,
    headers: {
      "Content-Type": "application/json",
      Location: `https://context7.com${redirectUrl}`,
      ...extra.headers,
    },
  });
}

function pendingResponse(retryAfter = "30") {
  return jsonResponse(202, {}, { "Retry-After": retryAfter });
}

function retryableResponse(status, retryAfter, body = {}) {
  const headers = {};
  if (retryAfter !== undefined) headers["Retry-After"] = retryAfter;
  return jsonResponse(status, { error: "rate_limited", message: "Rate limited", ...body }, headers);
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

function delayedStreamResponse(status, chunks, delayMs, headers = {}) {
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((r) => setTimeout(r, delayMs));
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
// Load client module
// ---------------------------------------------------------------------------

const client = load(join(packageRoot, "src", "web", "clients", "context7.ts"));

const {
  searchContext7Libraries,
  fetchContext7Context,
  resolveContext7ApiKey,
} = client;

const CONTEXT7_BASE = "https://context7.com/api/v2";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// === URL construction and auth ===

test("search builds correct URL with libraryName, query, and fast=false", async () => {
  const mock = installMockFetch(() => searchOk([]));
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(mock.calls.length, 1);
    const url = new URL(mock.calls[0].url);
    assert.equal(url.pathname, "/api/v2/libs/search");
    assert.equal(url.searchParams.get("libraryName"), "react");
    assert.equal(url.searchParams.get("query"), "hooks");
    assert.equal(url.searchParams.get("fast"), "false");
  } finally {
    mock.restore();
  }
});

test("search maps fast=true quality mode", async () => {
  const mock = installMockFetch(() => searchOk([]));
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: true },
      "test-key",
    );
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get("fast"), "true");
  } finally {
    mock.restore();
  }
});

test("context builds correct URL with libraryId, query, type=json", async () => {
  const mock = installMockFetch(() => contextOk());
  try {
    await fetchContext7Context(
      { libraryId: "/facebook/react", query: "useState", fast: false },
      "test-key",
    );
    assert.equal(mock.calls.length, 1);
    const url = new URL(mock.calls[0].url);
    assert.equal(url.pathname, "/api/v2/context");
    assert.equal(url.searchParams.get("libraryId"), "/facebook/react");
    assert.equal(url.searchParams.get("query"), "useState");
    assert.equal(url.searchParams.get("type"), "json");
    assert.equal(url.searchParams.get("fast"), "false");
  } finally {
    mock.restore();
  }
});

test("both endpoints send Bearer auth and redirect: manual", async () => {
  const mock = installMockFetch(() => contextOk());
  try {
    await fetchContext7Context(
      { libraryId: "/facebook/react", query: "useState", fast: false },
      "test-key",
    );
    assert.equal(mock.calls[0].headers["Authorization"], "Bearer test-key");
    assert.equal(mock.calls[0].redirect, "manual");
  } finally {
    mock.restore();
  }
});

// === Credentials and precedence ===

test("resolveContext7ApiKey returns env key when set", () => {
  const saved = process.env.CONTEXT7_API_KEY;
  process.env.CONTEXT7_API_KEY = "env-key";
  try {
    assert.equal(resolveContext7ApiKey(), "env-key");
  } finally {
    if (saved === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = saved;
  }
});

test("resolveContext7ApiKey reads auth.json when env is unset", () => {
  const savedKey = process.env.CONTEXT7_API_KEY;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const testAgentDir = mkdtempSync(join(tmpdir(), "context7-auth-"));
  writeFileSync(join(testAgentDir, "settings.json"), "{}", "utf8");
  writeFileSync(join(testAgentDir, "auth.json"), JSON.stringify({ context7: { key: "file-key" } }), "utf8");
  delete process.env.CONTEXT7_API_KEY;
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
  try {
    assert.equal(resolveContext7ApiKey(), "file-key");
  } finally {
    rmSync(testAgentDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = savedKey;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
});

test("env key takes precedence over auth file", () => {
  const savedKey = process.env.CONTEXT7_API_KEY;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const testAgentDir = mkdtempSync(join(tmpdir(), "context7-auth-"));
  writeFileSync(join(testAgentDir, "settings.json"), "{}", "utf8");
  writeFileSync(join(testAgentDir, "auth.json"), JSON.stringify({ context7: { key: "file-key" } }), "utf8");
  process.env.CONTEXT7_API_KEY = "env-wins";
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
  try {
    assert.equal(resolveContext7ApiKey(), "env-wins");
  } finally {
    rmSync(testAgentDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = savedKey;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
});

// === No-cache behavior ===

test("two identical search calls make two requests", async () => {
  const mock = installMockFetch(() => searchOk([]));
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(mock.calls.length, 2, "no local cache: two identical calls make two requests");
  } finally {
    mock.restore();
  }
});

// === 200 success ===

test("search 200 returns ready with parsed data", async () => {
  const mock = installMockFetch(() =>
    searchOk([{ id: "/facebook/react", title: "React", description: "UI library" }]),
  );
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.ok(result.data);
    assert.equal(result.data.results.length, 1);
    assert.equal(result.data.results[0].id, "/facebook/react");
  } finally {
    mock.restore();
  }
});

test("context 200 returns ready with parsed data", async () => {
  const mock = installMockFetch(() =>
    contextOk(
      [{ codeTitle: "Test", codeList: [{ language: "ts", code: "const x = 1;" }] }],
      [{ content: "Info here", contentTokens: 10 }],
    ),
  );
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "useState", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.redirected, false);
    assert.equal(result.finalLibraryId, "/facebook/react");
    assert.ok(result.data.codeSnippets);
    assert.ok(result.data.infoSnippets);
  } finally {
    mock.restore();
  }
});

// === 202 pending ===

test("search 202 returns pending with retryAfter from header", async () => {
  const mock = installMockFetch(() => pendingResponse("45"));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "pending");
    assert.equal(result.retryAfter, 45);
    assert.equal(result.data, null);
  } finally {
    mock.restore();
  }
});

test("context final 202 returns pending, no polling", async () => {
  const mock = installMockFetch(() => pendingResponse("60"));
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "useState", fast: false },
      "test-key",
    );
    assert.equal(result.status, "pending");
    assert.equal(mock.calls.length, 1, "no polling on 202");
  } finally {
    mock.restore();
  }
});

test("202 Retry-After metadata is bounded independently of retry wait", async () => {
  const mock = installMockFetch(() => pendingResponse("999999999"));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "pending");
    assert.equal(result.retryAfter, 86_400);
  } finally {
    mock.restore();
  }
});

test("202 responses cancel unread bodies before returning pending", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode("ignored")); },
    cancel() { cancelled = true; },
  });
  const mock = installMockFetch(() => new Response(stream, {
    status: 202,
    headers: { "Retry-After": "30" },
  }));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "pending");
    assert.equal(cancelled, true);
  } finally {
    mock.restore();
  }
});

// === Retry behavior ===

for (const status of [429, 500, 503, 504]) {
  test(`retry on ${status} succeeds on second call`, async () => {
    const mock = installMockFetch((_url, _init, i) => {
      if (i === 0) return retryableResponse(status, "0");
      return searchOk([{ id: "/facebook/react", title: "React" }]);
    });
    try {
      const result = await searchContext7Libraries(
        { libraryName: "react", query: "hooks", fast: false },
        "test-key",
      );
      assert.equal(result.status, "ready");
      assert.equal(mock.calls.length, 2, `should retry once on ${status}`);
    } finally {
      mock.restore();
    }
  });
}

test("retry exhausted: two consecutive 429s make exactly 2 requests (1 original + 1 retry)", async () => {
  const mock = installMockFetch(() => retryableResponse(429, "0"));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.equal(mock.calls.length, 2, "exactly 2 calls: no third retry");
  } finally {
    mock.restore();
  }
});

test("non-retryable status (404) makes exactly 1 request", async () => {
  const mock = installMockFetch(() => jsonResponse(404, { error: "not_found", message: "Not found" }));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.equal(mock.calls.length, 1);
    assert.match(result.error, /404/);
  } finally {
    mock.restore();
  }
});

test("non-retryable status (400) makes exactly 1 request", async () => {
  const mock = installMockFetch(() => jsonResponse(400, { error: "bad_request", message: "Bad request" }));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

// === Retry-After parsing ===

test("missing Retry-After waits immediately (0 delay)", async () => {
  const start = Date.now();
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return jsonResponse(429, { error: "rate_limited", message: "Rate limited" });
    return searchOk([]);
  });
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `missing Retry-After should not wait long (elapsed: ${elapsed}ms)`);
  } finally {
    mock.restore();
  }
});

test("negative Retry-After waits immediately", async () => {
  const start = Date.now();
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "-5");
    return searchOk([]);
  });
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `negative Retry-After should not wait long (elapsed: ${elapsed}ms)`);
  } finally {
    mock.restore();
  }
});

test("Retry-After seconds capped at 5", async () => {
  const start = Date.now();
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "30");
    return searchOk([]);
  });
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 4000 && elapsed < 5500, `over-cap Retry-After should wait ~5s (elapsed: ${elapsed}ms)`);
  } finally {
    mock.restore();
  }
});

test("Retry-After HTTP date in past waits immediately", async () => {
  const start = Date.now();
  const pastDate = new Date(Date.now() - 60000).toUTCString();
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, pastDate);
    return searchOk([]);
  });
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `past HTTP date should not wait (elapsed: ${elapsed}ms)`);
  } finally {
    mock.restore();
  }
});

test("Retry-After HTTP date in future waits until then (capped at 5s)", async () => {
  const start = Date.now();
  const futureDate = new Date(Date.now() + 30000).toUTCString();
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, futureDate);
    return searchOk([]);
  });
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 4000 && elapsed < 5500, `future date capped at 5s (elapsed: ${elapsed}ms)`);
  } finally {
    mock.restore();
  }
});

test("Retry-After small seconds waits that amount", async () => {
  const start = Date.now();
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "1");
    return searchOk([]);
  });
  try {
    await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 900 && elapsed < 1500, `1s Retry-After should wait ~1s (elapsed: ${elapsed}ms)`);
  } finally {
    mock.restore();
  }
});

// === 301 redirect (context only) ===

test("301 redirect follows to same-origin canonical ID", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return redirectResponse("/vercel/next.js");
    return contextOk();
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/vercel/next", query: "app router", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.redirected, true);
    assert.equal(result.finalLibraryId, "/vercel/next.js");
    assert.equal(mock.calls.length, 2);
    // Second call should use the canonical ID
    const secondUrl = new URL(mock.calls[1].url);
    assert.equal(secondUrl.searchParams.get("libraryId"), "/vercel/next.js");
    // Authorization is still sent (same origin)
    assert.equal(mock.calls[1].headers["Authorization"], "Bearer test-key");
  } finally {
    mock.restore();
  }
});

test("301 redirect from Location header when no redirectUrl body field", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) {
      return new Response(JSON.stringify({}), {
        status: 301,
        headers: {
          "Content-Type": "application/json",
          Location: "https://context7.com/facebook/react",
        },
      });
    }
    return contextOk();
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react-old", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.redirected, true);
    assert.equal(result.finalLibraryId, "/facebook/react");
  } finally {
    mock.restore();
  }
});

test("301 Location may point at the Context endpoint with a canonical libraryId", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) {
      return new Response("", {
        status: 301,
        headers: { Location: "https://context7.com/api/v2/context?libraryId=%2Ffacebook%2Freact" },
      });
    }
    return contextOk();
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react-old", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.finalLibraryId, "/facebook/react");
    assert.equal(new URL(mock.calls[1].url).searchParams.get("libraryId"), "/facebook/react");
  } finally {
    mock.restore();
  }
});

test("unsafe redirect (different origin) is an error", async () => {
  const mock = installMockFetch(() => {
    return new Response(JSON.stringify({ redirectUrl: "https://evil.com/facebook/react" }), {
      status: 301,
      headers: { "Content-Type": "application/json", Location: "https://evil.com/facebook/react" },
    });
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.equal(mock.calls.length, 1, "should not follow unsafe redirect");
  } finally {
    mock.restore();
  }
});

test("second redirect is an error (max one redirect)", async () => {
  const mock = installMockFetch(() => redirectResponse("/facebook/react-v2"));
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.equal(mock.calls.length, 2, "should stop after second redirect attempt");
  } finally {
    mock.restore();
  }
});

test("301 redirect with invalid library ID is an error", async () => {
  const mock = installMockFetch(() => redirectResponse("not-a-valid-id"));
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
  } finally {
    mock.restore();
  }
});

test("missing redirect target (no redirectUrl, no Location) is an error", async () => {
  const mock = installMockFetch(() => {
    return new Response(JSON.stringify({}), {
      status: 301,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
  } finally {
    mock.restore();
  }
});

// === Retry + redirect combinations ===

test("retry-then-redirect: 429 then 200 after retry, redirect not needed", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "0");
    return contextOk();
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.redirected, false);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("redirect-then-retry: 301 then 429 then 200 (max 3 requests)", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return redirectResponse("/facebook/react-canonical");
    if (i === 1) return retryableResponse(429, "0");
    return contextOk();
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.redirected, true);
    assert.equal(mock.calls.length, 3, "max 3 requests: redirect + retry + success");
  } finally {
    mock.restore();
  }
});

test("retry-then-redirect: 429 then 301 then 200 (max 3 requests)", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "0");
    if (i === 1) return redirectResponse("/facebook/react-canonical");
    return contextOk();
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
    assert.equal(result.redirected, true);
    assert.equal(mock.calls.length, 3, "max 3 requests: retry + redirect + success");
  } finally {
    mock.restore();
  }
});

test("retry-then-retry exceeds budget: second 429 after retry is terminal (2 requests)", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "0");
    return retryableResponse(429, "0");
  });
  try {
    const result = await fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
    );
    // After retry on call 1, the retry budget is exhausted;
    // call 2 gets 429 again but no more retries → terminal error
    assert.equal(result.status, "error");
    assert.equal(mock.calls.length, 2, "one retry means max 2 requests on consecutive 429s");
  } finally {
    mock.restore();
  }
});

// === Abort ===

test("abort during retry delay propagates AbortError", async () => {
  const mock = installMockFetch((_url, _init, i) => {
    if (i === 0) return retryableResponse(429, "10");
    return searchOk([]);
  });
  const controller = new AbortController();
  try {
    const promise = searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, (error) => error?.name === "AbortError");
    assert.equal(mock.calls.length, 1, "abort during delay must prevent the retry request");
  } finally {
    mock.restore();
  }
});

test("abort observed immediately after fetch propagates before status handling", async () => {
  const controller = new AbortController();
  const mock = installMockFetch(() => {
    controller.abort();
    return pendingResponse("30");
  });
  try {
    await assert.rejects(
      searchContext7Libraries(
        { libraryName: "react", query: "hooks", fast: false },
        "test-key",
        controller.signal,
      ),
      (error) => error?.name === "AbortError",
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("abort during body streaming propagates AbortError", async () => {
  const controller = new AbortController();
  const mock = installMockFetch(() => delayedStreamResponse(200, ["chunk1-", "chunk2-", "chunk3-"], 50));
  try {
    const promise = fetchContext7Context(
      { libraryId: "/facebook/react", query: "hooks", fast: false },
      "test-key",
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(promise, (error) => error?.name === "AbortError");
  } finally {
    mock.restore();
  }
});

// === Malformed JSON ===

test("malformed JSON returns error", async () => {
  const mock = installMockFetch(() =>
    new Response("{broken json!!", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
  } finally {
    mock.restore();
  }
});

// === Bounded errors ===

test("error response body is parsed and included in error message", async () => {
  const mock = installMockFetch(() =>
    jsonResponse(403, { error: "forbidden", message: "Access denied to this library" }),
  );
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /403/);
  } finally {
    mock.restore();
  }
});

test("oversized error bodies are bounded before formatting", async () => {
  const marker = "SHOULD_NOT_SURVIVE";
  const huge = "x".repeat(64_000) + marker;
  const mock = installMockFetch(() => new Response(huge, { status: 403 }));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.ok(result.error.length < 12_000, "formatted provider errors must remain bounded");
    assert.doesNotMatch(result.error, /SHOULD_NOT_SURVIVE/);
  } finally {
    mock.restore();
  }
});

test("provider error messages strip ANSI and control characters", async () => {
  const mock = installMockFetch(() =>
    jsonResponse(403, { error: "\u001b[31mforbidden\u001b[0m", message: "line\u0000break" }),
  );
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /forbidden.*linebreak/);
    assert.doesNotMatch(result.error, /\u001b|\u0000|\[31m|\[0m/);
  } finally {
    mock.restore();
  }
});

test("error with non-JSON body still produces error", async () => {
  const mock = installMockFetch(() =>
    new Response("Internal Server Error", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    }),
  );
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    // 500 is retryable, so it retries once then errors
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

// === Multi-chunk raw overflow (> 2 MiB) ===

test("raw response over 2 MiB cap is rejected", async () => {
  // Build a response that exceeds 2 MiB in multiple chunks
  const bigChunk = "x".repeat(1024 * 1024); // 1 MiB per chunk
  const mock = installMockFetch(() =>
    streamingResponse(200, [bigChunk, bigChunk, bigChunk]), // 3 MiB total
  );
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /2.*MiB|2097152|raw.*cap|too large/i);
  } finally {
    mock.restore();
  }
});

test("raw response just under 2 MiB is accepted", async () => {
  const okChunk = '{"results":[],"searchFilterApplied":false}';
  const padding = " ".repeat(1024 * 1024); // ~1 MiB padding (within JSON structure)
  const body = `{"results":[],"searchFilterApplied":false,"padding":"${padding}"}`;
  // This is under 2 MiB
  assert.ok(body.length < 2 * 1024 * 1024, "test body should be under 2 MiB");
  const mock = installMockFetch(() => jsonResponse(200, body));
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "ready");
  } finally {
    mock.restore();
  }
});

// === Network error ===

test("network error on first call returns error", async () => {
  const mock = installMockFetch(() => {
    throw new TypeError("fetch failed: ECONNRESET");
  });
  try {
    const result = await searchContext7Libraries(
      { libraryName: "react", query: "hooks", fast: false },
      "test-key",
    );
    assert.equal(result.status, "error");
    // Network errors are not retried (only HTTP status codes are)
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
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

console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
