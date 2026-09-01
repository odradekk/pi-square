import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT, TOOLS, composeRequest } from "../cache-experiment/fixture.mjs";
import { estimateTokens } from "../cache-experiment/evidence.mjs";
import { runExperiment } from "../cache-experiment/runner.mjs";
import {
  CACHE_PROVIDER_PRICES,
  PREFILL_CONTINUATION_USER_TEXT,
  buildClaudeCacheRequest,
  createCacheProviderAdapter,
} from "./cache-provider.mjs";

/**
 * Offline unit coverage for the credentialed provider-cache adapter (#248).
 *
 * Every test drives the adapter against a stubbed transport serving scripted
 * SSE streams: no network call is made, no real credential is read (only a
 * synthetic placeholder value is set and asserted), and no real experiment
 * verdict is produced. The assertions pin the adapter contract the runner
 * and #227 rely on: table-faithful request reconstruction, breakpoint
 * placement, the temperature omission, absent-versus-zero cache reporting,
 * retention-bucket honesty, first-token timing, and bounded failures.
 */

const KEY = "test-cache-key-placeholder";
const SAVED_ENV = {};
for (const name of ["CCR_CLAUDE_API_KEY", "CCR_CLAUDE_BASE_URL"]) {
  SAVED_ENV[name] = process.env[name];
}
process.env.CCR_CLAUDE_API_KEY = KEY;
delete process.env.CCR_CLAUDE_BASE_URL;
process.on("exit", () => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ─── helpers ────────────────────────────────────────────────────────

function experimentRequest(group, arm, role) {
  const composed = composeRequest({ group, arm, role });
  return {
    group,
    arm,
    role,
    payload: composed.payload,
    digest: null,
    tokenEstimate: 0,
    cacheControl: {
      bucket: "default",
      ttlMs: 300_000,
      breakpoint: "end-of-carried-summary",
      coveredBytes: composed.layout.summary.end,
    },
  };
}

function segmentContent(request, element) {
  const segment = request.payload.table.find((entry) => entry.element === element);
  return request.payload.bytes.subarray(segment.contentStart, segment.contentEnd).toString("utf8");
}

function sseText(frames) {
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
}

function sseResponse(frames, { chunkSize } = {}) {
  const text = typeof frames === "string" ? frames : sseText(frames);
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        if (!chunkSize) {
          controller.enqueue(Buffer.from(text));
        } else {
          for (let offset = 0; offset < text.length; offset += chunkSize) {
            controller.enqueue(Buffer.from(text.slice(offset, offset + chunkSize)));
          }
        }
        controller.close();
      },
    }),
  };
}

/** One Anthropic-shaped stream with injectable usage facts. */
function claudeFrames({ inputTokens = 100, cacheRead, cacheWrite, retention, outputTokens = 64 }) {
  const usage = { input_tokens: inputTokens, output_tokens: 1 };
  if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
  if (cacheWrite !== undefined) usage.cache_creation_input_tokens = cacheWrite;
  if (retention === "1h") usage.cache_creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite };
  if (retention === "5m") usage.cache_creation = { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 };
  if (retention === "zero") usage.cache_creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
  return [
    { event: "message_start", data: { type: "message_start", message: { usage } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function captureTransport(handler) {
  const transport = {
    requests: [],
    async fetch(url, init) {
      transport.requests.push({ url, init, body: init.body });
      const response = typeof handler === "function" ? handler(init.body, transport.requests.length) : handler;
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return transport;
}

// ─── declaration and pins ───────────────────────────────────────────

{
  const adapter = createCacheProviderAdapter({ transport: captureTransport(sseResponse(claudeFrames({}))) });
  assert.ok(!adapter.id.startsWith("simulated"), "the id marks real-mode execution in the report");
  assert.deepEqual(adapter.requiredEnv, ["CCR_CLAUDE_API_KEY"]);
  const pins = adapter.describePins();
  assert.equal(pins.provider, "ccr-claude");
  assert.equal(pins.model, "claude-sonnet-5");
  assert.equal(pins.cacheReporting, "reported");
  (function walkStrings(value) {
    if (typeof value === "string") {
      assert.ok(value.length <= 240, `pin strings stay bounded: ${value.slice(0, 40)}…`);
    } else if (Array.isArray(value)) value.forEach(walkStrings);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walkStrings);
  })(pins);
  assert.ok(pins.settingsOmissions.some((note) => note.includes("temperature")),
    "the temperature omission is recorded in the pins, not silently dropped");
  assert.ok(typeof pins.priceNote === "string" && pins.priceNote.includes("estimated"),
    "the price table is declared as an estimate");
}

// ─── wire reconstruction from the payload table ─────────────────────

{
  const transport = captureTransport(() => sseResponse(claudeFrames({ inputTokens: 1 })));
  const adapter = createCacheProviderAdapter({ transport });
  const request = experimentRequest(1, "stable", "prime");
  await adapter.send(request, {});

  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].url, "https://ccr.bearfamily.us/v1/messages");
  assert.equal(transport.requests[0].init.headers["x-api-key"], KEY);
  assert.ok(!("authorization" in transport.requests[0].init.headers),
    "the anthropic path carries the credential once, in x-api-key only");
  assert.equal(transport.requests[0].init.headers["anthropic-version"], "2023-06-01");

  const body = JSON.parse(transport.requests[0].init.body);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.max_tokens, 512, "SETTINGS.maxOutputTokens applies verbatim");
  assert.equal(body.stream, true);
  assert.ok(!("temperature" in body), "temperature is omitted, not sent as zero");
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.deepEqual(body.tools, TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  })));
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content[0].type, "text");
  assert.equal(body.messages[0].content[0].text, segmentContent(request, "summary"),
    "the summary segment is carried verbatim as the leading context message");
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" },
    "the breakpoint sits on the block containing coveredBytes (the summary's end)");
  assert.equal((transport.requests[0].init.body.match(/"cache_control"/g) ?? []).length, 1,
    "exactly one cache breakpoint per request");
  const tail = body.messages.slice(1);
  assert.equal(tail.length, 6, "the trace tail rides after the summary");
  assert.deepEqual(tail.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "user"],
    "user/assistant rows pass through and the tool row surfaces as user text");
}

// ─── determinism and the prefix property at the wire level ──────────

{
  const transport = captureTransport(() => sseResponse(claudeFrames({ inputTokens: 1 })));
  const adapter = createCacheProviderAdapter({ transport });
  await adapter.send(experimentRequest(2, "stable", "prime"), {});
  const firstBody = transport.requests[0].init.body;
  await adapter.send(experimentRequest(2, "stable", "prime"), {});
  assert.equal(transport.requests[1].init.body, firstBody, "identical inputs produce byte-identical requests");

  const summaryOf = (index) => JSON.parse(transport.requests[index].init.body).messages[0].content[0].text;
  await adapter.send(experimentRequest(2, "stable", "probe"), {});
  assert.ok(summaryOf(2).startsWith(summaryOf(0)),
    "the stable probe's wire summary extends the prime's (no injected variability)");
  const noncePrime = transport.requests.length;
  await adapter.send(experimentRequest(2, "nonce", "prime"), {});
  await adapter.send(experimentRequest(2, "nonce", "probe"), {});
  assert.ok(!summaryOf(noncePrime + 1).startsWith(summaryOf(noncePrime)),
    "the negative control's summary diverges inside the earliest block");
}

// ─── no request ends with an assistant turn (no prefill rejection) ───

{
  // claude-sonnet-5 rejects assistant message prefill; every probe tail ends
  // with the release-notes assistant turn, so the reconstruction closes the
  // conversation with one fixed user continuation. Cover every arm and both
  // roles through the pure builder.
  const continuationCount = (wire) => wire.body.messages.filter(
    (message) => message.content?.[0]?.text === PREFILL_CONTINUATION_USER_TEXT,
  ).length;
  for (const arm of ["stable", "nonce", "native"]) {
    for (const role of ["prime", "probe"]) {
      const wire = buildClaudeCacheRequest(experimentRequest(3, arm, role));
      assert.notEqual(wire.body.messages.at(-1).role, "assistant",
        `${arm}.${role} must end with a user turn (the gateway rejects assistant prefill)`);
      assert.equal(continuationCount(wire), role === "probe" ? 1 : 0,
        role === "probe"
          ? `${arm}.${role} gains exactly one fixed continuation turn`
          : `${arm}.${role} already ends with a user turn and gains nothing`);
    }
  }
  // The full probe shape, pinned: the prime's seven messages, the probe's
  // extra user+assistant tail pair, then the fixed continuation.
  const stableProbe = buildClaudeCacheRequest(experimentRequest(3, "stable", "probe"));
  assert.deepEqual(stableProbe.body.messages.map((message) => message.role), [
    "user", "user", "assistant", "user", "assistant", "user", "user",
    "user", "assistant", "user",
  ]);
  assert.equal(stableProbe.body.messages.at(-1).content[0].text, PREFILL_CONTINUATION_USER_TEXT);
  // The continuation is one constant, never per-request variability.
  const nonceProbe = buildClaudeCacheRequest(experimentRequest(4, "nonce", "probe"));
  assert.equal(nonceProbe.body.messages.at(-1).content[0].text, PREFILL_CONTINUATION_USER_TEXT);
}

// ─── SSE parsing: usage, cache, retention, and first-token timing ────

{
  const transport = captureTransport(() => sseResponse(claudeFrames({
    inputTokens: 612, cacheRead: 0, cacheWrite: 487, retention: "1h", outputTokens: 64,
  })));
  const adapter = createCacheProviderAdapter({ transport });
  let firstTokenCalls = 0;
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {
    onFirstToken: () => { firstTokenCalls += 1; },
  });
  assert.equal(firstTokenCalls, 1, "onFirstToken fires exactly once, at the first content delta");
  assert.deepEqual(report.usage, { inputTokens: 612, outputTokens: 64 },
    "inputTokens is the uncached input only");
  assert.deepEqual(report.cache, { reported: true, read: 0, write: 487 },
    "present-and-zero fields stay distinguishable from absent fields");
  assert.deepEqual(report.retentionWrite, { reported: true, bucket: "1h", tokens: 487 },
    "the retention bucket reports what the provider used, not what was requested");
  const expectedCost = Math.round(
    (612 * CACHE_PROVIDER_PRICES.inputPerMTok
      + 0 * CACHE_PROVIDER_PRICES.cacheReadPerMTok
      + 487 * CACHE_PROVIDER_PRICES.cacheWritePerMTok
      + 64 * CACHE_PROVIDER_PRICES.outputPerMTok) / 1e6 * 1e6,
  ) / 1e6;
  assert.equal(report.cost, expectedCost);
}

{
  // The parser reassembles frames split across arbitrary chunk boundaries.
  const transport = captureTransport(() => sseResponse(
    claudeFrames({ inputTokens: 612, cacheRead: 0, cacheWrite: 487, retention: "1h" }),
    { chunkSize: 7 },
  ));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {});
  assert.deepEqual(report.usage, { inputTokens: 612, outputTokens: 64 });
  assert.deepEqual(report.cache, { reported: true, read: 0, write: 487 });
}

{
  const transport = captureTransport(() => sseResponse(claudeFrames({
    inputTokens: 900, cacheRead: 0, cacheWrite: 10, retention: "5m",
  })));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {});
  assert.deepEqual(report.retentionWrite, { reported: true, bucket: "5m", tokens: 10 });
}

{
  // A message_delta carrying zeroed input fields must not clobber the
  // message_start values.
  const frames = claudeFrames({ inputTokens: 612, cacheRead: 200, cacheWrite: 487, retention: "1h" });
  frames[5] = {
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 0, output_tokens: 64 } },
  };
  const transport = captureTransport(() => sseResponse(frames));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {});
  assert.deepEqual(report.usage, { inputTokens: 612, outputTokens: 64 });
  assert.deepEqual(report.cache, { reported: true, read: 200, write: 487 });
}

{
  // No content delta at all: first token is never signalled, but the report
  // still completes from the usage frames.
  const frames = claudeFrames({ inputTokens: 50, outputTokens: 8 }).filter(
    (frame) => frame.event !== "content_block_delta",
  );
  const transport = captureTransport(() => sseResponse(frames));
  const adapter = createCacheProviderAdapter({ transport });
  let firstTokenCalls = 0;
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {
    onFirstToken: () => { firstTokenCalls += 1; },
  });
  assert.equal(firstTokenCalls, 0);
  assert.deepEqual(report.usage, { inputTokens: 50, outputTokens: 8 });
}

{
  // Cache fields absent entirely: unreported, never zero.
  const transport = captureTransport(() => sseResponse(claudeFrames({ inputTokens: 50 })));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {});
  assert.deepEqual(report.cache, { reported: false, read: 0, write: 0 });
  assert.deepEqual(report.retentionWrite, { reported: false, bucket: "unreported", tokens: 0 });
}

{
  // Cache fields present and zero, retention detail present and zero.
  const transport = captureTransport(() => sseResponse(claudeFrames({
    inputTokens: 50, cacheRead: 0, cacheWrite: 0, retention: "zero",
  })));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "stable", "prime"), {});
  assert.deepEqual(report.cache, { reported: true, read: 0, write: 0 });
  assert.deepEqual(report.retentionWrite, { reported: true, bucket: "unspecified", tokens: 0 });
}

// ─── failures: bounded, credential-free, no retry ────────────────────

{
  const transport = captureTransport(() => ({
    ok: false,
    status: 503,
    text: async () => `upstream overloaded ${"z".repeat(400)}`,
  }));
  const adapter = createCacheProviderAdapter({ transport });
  await assert.rejects(
    () => adapter.send(experimentRequest(1, "stable", "prime"), {}),
    (error) => {
      assert.match(error.message, /provider HTTP 503/);
      assert.ok(error.message.length <= 240, "the error text is bounded");
      assert.ok(!error.message.includes(KEY), "the error never echoes the credential");
      assert.ok(!/(.)\1{63}/.test(error.message), "padding runs are dropped");
      return true;
    },
  );
  assert.equal(transport.requests.length, 1, "no internal retry");
}

{
  const errorFrame = sseText([
    { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
  ]);
  const transport = captureTransport(() => sseResponse(errorFrame));
  const adapter = createCacheProviderAdapter({ transport });
  await assert.rejects(() => adapter.send(experimentRequest(1, "stable", "prime"), {}), /provider stream error/);
}

{
  const transport = captureTransport(() => sseResponse("not sse at all"));
  const adapter = createCacheProviderAdapter({ transport });
  await assert.rejects(
    () => adapter.send(experimentRequest(1, "stable", "prime"), {}),
    /without complete usage/,
    "a stream with no usage frames fails closed",
  );
}

{
  delete process.env.CCR_CLAUDE_API_KEY;
  const adapter = createCacheProviderAdapter({ transport: captureTransport(sseResponse(claudeFrames({}))) });
  await assert.rejects(
    () => adapter.send(experimentRequest(1, "stable", "prime"), {}),
    (error) => {
      assert.match(error.message, /CCR_CLAUDE_API_KEY is not set/);
      assert.ok(!error.message.includes(KEY));
      return true;
    },
  );
  process.env.CCR_CLAUDE_API_KEY = KEY;
}

// ─── a full offline experiment through the real runner ──────────────

{
  // A stub gateway that behaves like the probed one: it serves the longest
  // common wire-prefix shared with any prior request, bounded by the
  // request's own breakpoint, and reports the write in the 1 h bucket.
  function commonPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let shared = 0;
    while (shared < limit && a[shared] === b[shared]) shared += 1;
    return shared;
  }
  const GATEWAY_PREFIX_TOKENS = 539;
  const priorBodies = [];
  const transport = captureTransport((body) => {
    const breakpoint = body.indexOf('"cache_control"');
    let readBytes = 0;
    for (const previous of priorBodies) {
      readBytes = Math.max(readBytes, commonPrefixLength(body, previous));
    }
    readBytes = Math.min(readBytes, breakpoint);
    priorBodies.push(body);
    const read = estimateTokens(readBytes);
    const write = estimateTokens(Math.max(0, breakpoint - readBytes));
    const input = Math.max(0, estimateTokens(body.length) + GATEWAY_PREFIX_TOKENS - read - write);
    return sseResponse(claudeFrames({ inputTokens: input, cacheRead: read, cacheWrite: write, retention: "1h" }));
  });

  const adapter = createCacheProviderAdapter({ transport });
  const clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  const { report, exitCode } = await runExperiment({
    adapter,
    clock,
    generatedAt: () => "2026-01-01T00:00:00.000Z",
  });

  assert.equal(transport.requests.length, 30, "five interleaved paired groups over three arms");
  assert.equal(report.mode, "credentialed", "a non-simulated adapter id marks real mode");
  assert.equal(report.integrity.ok, true);
  assert.equal(report.totals.requests, 30);
  assert.equal(report.adapter.id, "ccr-claude/anthropic-cache/1");
  assert.deepEqual(report.pins.settingsOmissions, adapter.describePins().settingsOmissions,
    "the runner carries the adapter's settings omissions into the pinned report");
  assert.equal(typeof report.pins.priceNote, "string");
  for (const group of report.groups) {
    assert.equal(group.quality, "measurable");
    assert.equal(group.stable.probe.retentionBucket, "1h");
    assert.ok(group.stable.probe.ttftMs !== null, "TTFT is locally measured through the real clock");
  }
  assert.equal(report.conclusion.cache, "positive");
  assert.equal(report.conclusion.final, "positive");
  assert.equal(exitCode, 0);
}

// ─── the command's --adapter surface refuses offline, by name only ──

{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const adapterModule = join(HERE, "cache-provider.mjs");
  const strippedEnv = { ...process.env };
  delete strippedEnv.CCR_CLAUDE_API_KEY;
  delete strippedEnv.CCR_CLAUDE_BASE_URL;

  // The requiredEnv name-check path: the command names the missing variable,
  // never a value, and exits before any request could be sent.
  const missing = spawnSync(process.execPath, [join(HERE, "..", "cache-experiment", "experiment.mjs"), "--adapter", adapterModule], {
    encoding: "utf8",
    env: strippedEnv,
  });
  assert.equal(missing.status, 2, `the name check refuses before execution:\n${missing.stdout}\n${missing.stderr}`);
  assert.ok(missing.stderr.includes("CCR_CLAUDE_API_KEY"));
  assert.ok(missing.stderr.includes("never prints credential values"));

  const noValue = spawnSync(process.execPath, [join(HERE, "..", "cache-experiment", "experiment.mjs"), "--adapter"], {
    encoding: "utf8",
    env: strippedEnv,
  });
  assert.equal(noValue.status, 2);
  assert.ok(noValue.stderr.includes("--adapter requires a module path"));
}

console.log("cache-adapter.test.mjs: all offline adapter coverage passed");
