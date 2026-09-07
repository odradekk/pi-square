import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_NONCE, SYSTEM_PROMPT, armNamespace, composeRequest, toolsFor } from "../cache-experiment/fixture.mjs";
import { estimateTokens, sha256Hex } from "../cache-experiment/evidence.mjs";
import { fakeClock } from "../cache-experiment/fake-provider.mjs";
import { runExperiment } from "../cache-experiment/runner.mjs";
import {
  CACHE_PROVIDER_PRICES,
  PREFILL_CONTINUATION_USER_TEXT,
  adapters as cacheProviderAdapters,
  buildClaudeCacheRequest,
  createCacheProviderAdapter,
} from "./cache-provider.mjs";

/**
 * Offline unit coverage for the credentialed provider-cache adapter (#248,
 * breakpoint placement re-modeled by #268).
 *
 * Every test drives the adapter against a stubbed transport serving scripted
 * SSE streams: no network call is made, no real credential is read (only a
 * synthetic placeholder value is set and asserted), and no real experiment
 * verdict is produced. The assertions pin the adapter contract the runner
 * and #227 rely on: table-faithful request reconstruction, the three
 * breakpoint positions mirroring Pi's anthropic-messages placement, the
 * temperature omission, absent-versus-zero cache reporting,
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
      breakpoint: "mirrors Pi's anthropic-messages placement",
      breakpoints: composed.layout.breakpoints,
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
          controller.enqueue(new Uint8Array(Buffer.from(text)));
        } else {
          for (let offset = 0; offset < text.length; offset += chunkSize) {
            controller.enqueue(new Uint8Array(Buffer.from(text.slice(offset, offset + chunkSize))));
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
  assert.deepEqual(
    cacheProviderAdapters.map((adapter) => adapter.describePins().model),
    ["claude-sonnet-5", "glm-5.3", "gpt-5.6-luna"],
    "the canonical cache adapter module exports the three-model comparison matrix",
  );
}

{
  const adapter = createCacheProviderAdapter({ transport: captureTransport(sseResponse(claudeFrames({}))) });
  assert.ok(!adapter.id.startsWith("simulated"), "the id marks real-mode execution in the report");
  assert.deepEqual(adapter.requiredEnv, ["CCR_CLAUDE_API_KEY"]);
  const pins = adapter.describePins();
  assert.equal(pins.provider, "ccr-claude");
  assert.equal(pins.model, "claude-sonnet-5");
  assert.equal(pins.cacheReporting, "reported");
  assert.ok(pins.breakpointPlacement.startsWith("mirrors Pi's anthropic-messages placement"),
    "the pins record the modelled breakpoint placement");
  for (const position of ["system blocks", "last immediate tool", "last block of the last user message"]) {
    assert.ok(pins.breakpointPlacement.includes(position), `the placement names the ${position} position`);
  }
  assert.equal(
    pins.breakpointPlacement,
    (await import("../cache-experiment/fixture.mjs")).BREAKPOINT_PLACEMENT,
    "the adapter and the fixture pin the same placement phrase",
  );
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
  const request = experimentRequest(1, "multiblock", "prime");
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
  assert.ok(Array.isArray(body.system), "the system prompt is one text block list, as Pi sends it");
  assert.equal(body.system[0].type, "text");
  assert.ok(body.system[0].text.includes(SYSTEM_PROMPT),
    "the system block carries the pinned system prompt");
  assert.ok(body.system[0].text.includes(armNamespace(DIGEST_NONCE, 1, "multiblock")),
    "the system block carries the run+group+arm cold namespace (#297 review findings 2 and 3)");
  assert.ok(
    body.system[0].text.indexOf("Experiment isolation namespace ") < body.system[0].text.indexOf(SYSTEM_PROMPT),
    "the namespace line precedes every shared cacheable byte of the system prompt",
  );
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" },
    "breakpoint 1: the system block carries cache_control, where Pi places it");
  const saltedTools = toolsFor(DIGEST_NONCE, { group: 1, arm: "multiblock", role: "prime" });
  assert.deepEqual(body.tools, saltedTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  })).map((tool, index) => (index === saltedTools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool)),
    "breakpoint 2: the last immediate tool carries cache_control, and only it");
  assert.ok(body.tools.every((tool, index) => tool.description.endsWith(`[isolation:${armNamespace(DIGEST_NONCE, 1, "multiblock")}]`)
    || tool.description === saltedTools[index].description),
    "every tool description carries the request's isolation token (#297 review finding 2)");
  assert.equal(body.messages[0].role, "user");
  // #297: the contiguous summary-part run is one user message with one text
  // block per part — the multiblock arm's per-block parts arrive as separate
  // ordered blocks, exactly as the uniform projection sends them.
  assert.equal(body.messages[0].content.length, 4, "the multiblock prime carries frame, block 1, block 2, frame");
  for (const [index, element] of ["summary-part-0", "summary-part-1", "summary-part-2", "summary-part-3"].entries()) {
    assert.equal(body.messages[0].content[index].type, "text");
    assert.equal(body.messages[0].content[index].text, segmentContent(request, element),
      `${element} is carried verbatim as its own ordered text block`);
  }
  assert.ok(body.messages[0].content.every((block) => block.cache_control === undefined),
    "no breakpoint sits at any carried Memory block — Pi places none there");
  const marked = body.messages.filter((message) => message.content.some((block) => block.cache_control));
  assert.equal(marked.length, 1);
  assert.equal(marked[0], body.messages[body.messages.length - 1],
    "breakpoint 3: the last message (a user turn) carries cache_control on its last block");
  assert.equal((transport.requests[0].init.body.match(/"cache_control"/g) ?? []).length, 3,
    "exactly three cache breakpoints per request: system, last tool, last user-message block");
  const tail = body.messages.slice(1);
  assert.equal(tail.length, 7, "the trace tail rides after the summary");
  assert.deepEqual(tail.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "user", "user"],
    "user/assistant rows pass through and the tool row surfaces as user text");
}
// ─── determinism and the append property at the wire level ──────────
{
  const transport = captureTransport(() => sseResponse(claudeFrames({ inputTokens: 1 })));
  const adapter = createCacheProviderAdapter({ transport });
  await adapter.send(experimentRequest(2, "multiblock", "prime"), {});
  const firstBody = transport.requests[0].init.body;
  await adapter.send(experimentRequest(2, "multiblock", "prime"), {});
  assert.equal(transport.requests[1].init.body, firstBody, "identical inputs produce byte-identical requests");

  // The cross-compaction append property on the wire (#297): the multiblock
  // arm's probe keeps every carried block's text block byte-identical and
  // inserts exactly one new block before the trailing frame, while the single
  // arm's one summary text block grows at its end with the appended block.
  // The nonce control's carried blocks stay byte-identical to its prime's —
  // its divergence lives in the per-request isolation namespace, asserted
  // below.
  const strip = (messages) => JSON.stringify(messages, (key, value) => (key === "cache_control" ? undefined : value));
  const summaryOf = (wire) => JSON.parse(wire).messages[0];

  await adapter.send(experimentRequest(2, "multiblock", "prime"), {});
  await adapter.send(experimentRequest(2, "multiblock", "probe"), {});
  const multiblockPrime = summaryOf(transport.requests.at(-2).init.body);
  const multiblockProbe = summaryOf(transport.requests.at(-1).init.body);
  assert.equal(multiblockPrime.content.length, 4);
  assert.equal(multiblockProbe.content.length, 5, "the appended block adds exactly one text block");
  assert.deepEqual(multiblockProbe.content.slice(0, 2), multiblockPrime.content.slice(0, 2),
    "the leading frame and block 1 stay byte-identical across the append");
  assert.equal(multiblockProbe.content[2].text, multiblockPrime.content[2].text,
    "block 2 stays byte-identical across the append");
  assert.equal(multiblockProbe.content[4].text, multiblockPrime.content[3].text,
    "the trailing frame part is unchanged; only the appended block's part is new");

  await adapter.send(experimentRequest(2, "single", "prime"), {});
  await adapter.send(experimentRequest(2, "single", "probe"), {});
  const singlePrime = summaryOf(transport.requests.at(-2).init.body);
  const singleProbe = summaryOf(transport.requests.at(-1).init.body);
  assert.equal(singlePrime.content.length, 1, "the baseline carries the whole summary as one text block");
  assert.equal(singleProbe.content.length, 1);
  assert.ok(singleProbe.content[0].text.startsWith(singlePrime.content[0].text.slice(0, singlePrime.content[0].text.length - 12)),
    "the single baseline's summary grows at its end with the appended block");

  await adapter.send(experimentRequest(2, "nonce", "prime"), {});
  await adapter.send(experimentRequest(2, "nonce", "probe"), {});
  const noncePrime = summaryOf(transport.requests.at(-2).init.body);
  const nonceProbe = summaryOf(transport.requests.at(-1).init.body);
  const noncePrimeSystem = JSON.parse(transport.requests.at(-2).init.body).system[0].text;
  const nonceProbeSystem = JSON.parse(transport.requests.at(-1).init.body).system[0].text;
  assert.equal(noncePrime.role, "user");
  assert.equal(noncePrime.content[1].text, nonceProbe.content[1].text,
    "the control's carried blocks are byte-identical to its prime: the divergence is not in the carried region");
  assert.notEqual(noncePrimeSystem, nonceProbeSystem,
    "the control's isolation namespace token differs per request (#297 review finding 3)");
  assert.ok(
    noncePrimeSystem.startsWith("Experiment isolation namespace ")
      && nonceProbeSystem.startsWith("Experiment isolation namespace "),
    "both namespace lines share their fixed-width framing at the front of the system block",
  );
}
// ─── no request ends with an assistant turn (no prefill rejection) ───

{
  // claude-sonnet-5 rejects assistant message prefill; the #297 fixture's
  // tails end with user turns, so no arm or role needs the fixed continuation
  // and the guard stays a defensive no-op. Cover every arm and both roles
  // through the pure builder.
  const continuationCount = (wire) => wire.body.messages.filter(
    (message) => message.content?.[0]?.text === PREFILL_CONTINUATION_USER_TEXT,
  ).length;
  for (const arm of ["multiblock", "single", "nonce"]) {
    for (const role of ["prime", "probe"]) {
      const wire = buildClaudeCacheRequest(experimentRequest(3, arm, role));
      assert.notEqual(wire.body.messages.at(-1).role, "assistant",
        `${arm}.${role} must end with a user turn (the gateway rejects assistant prefill)`);
      assert.equal(continuationCount(wire), 0, `${arm}.${role} already ends with a user turn and gains nothing`);
    }
  }
  // The full shapes, pinned: the summary user message followed by the seven
  // tail rows, both roles.
  const multiblockPrime = buildClaudeCacheRequest(experimentRequest(3, "multiblock", "prime"));
  assert.deepEqual(multiblockPrime.body.messages.map((message) => message.role), [
    "user", "user", "assistant", "user", "assistant", "user", "user", "user",
  ]);
  const singleProbe = buildClaudeCacheRequest(experimentRequest(3, "single", "probe"));
  assert.deepEqual(singleProbe.body.messages.map((message) => message.role), [
    "user", "user", "assistant", "user", "assistant", "user", "assistant", "user",
  ]);
  assert.notEqual(singleProbe.body.messages.at(-1).content[0].text, PREFILL_CONTINUATION_USER_TEXT,
    "the closing user turn is the fixture's own, never the continuation");
}

// ─── SSE parsing: usage, cache, retention, and first-token timing ────

{
  const transport = captureTransport(() => sseResponse(claudeFrames({
    inputTokens: 612, cacheRead: 0, cacheWrite: 487, retention: "1h", outputTokens: 64,
  })));
  const adapter = createCacheProviderAdapter({ transport });
  let firstTokenCalls = 0;
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {
    onFirstToken: () => { firstTokenCalls += 1; },
  });
  assert.equal(firstTokenCalls, 1, "onFirstToken fires exactly once, at the first content delta");
  assert.deepEqual(report.usage, { inputTokens: 612, outputTokens: 64 },
    "inputTokens is the uncached input only");
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 0, write: 487, writeReported: true },
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
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {});
  assert.deepEqual(report.usage, { inputTokens: 612, outputTokens: 64 });
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 0, write: 487, writeReported: true });
}

{
  const transport = captureTransport(() => sseResponse(claudeFrames({
    inputTokens: 900, cacheRead: 0, cacheWrite: 10, retention: "5m",
  })));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {});
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
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {});
  assert.deepEqual(report.usage, { inputTokens: 612, outputTokens: 64 });
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 200, write: 487, writeReported: true });
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
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {
    onFirstToken: () => { firstTokenCalls += 1; },
  });
  assert.equal(firstTokenCalls, 0);
  assert.deepEqual(report.usage, { inputTokens: 50, outputTokens: 8 });
}

{
  // Cache fields absent entirely: unreported, never zero.
  const transport = captureTransport(() => sseResponse(claudeFrames({ inputTokens: 50 })));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {});
  assert.deepEqual(report.cache, { reported: false, readReported: false, read: 0, write: 0, writeReported: false });
  assert.deepEqual(report.retentionWrite, { reported: false, bucket: "unreported", tokens: 0 });
}

{
  // Cache fields present and zero, retention detail present and zero.
  const transport = captureTransport(() => sseResponse(claudeFrames({
    inputTokens: 50, cacheRead: 0, cacheWrite: 0, retention: "zero",
  })));
  const adapter = createCacheProviderAdapter({ transport });
  const report = await adapter.send(experimentRequest(1, "multiblock", "prime"), {});
  assert.deepEqual(report.cache, { reported: true, readReported: true, read: 0, write: 0, writeReported: true });
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
    () => adapter.send(experimentRequest(1, "multiblock", "prime"), {}),
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
  await assert.rejects(() => adapter.send(experimentRequest(1, "multiblock", "prime"), {}), /provider stream error/);
}

{
  const transport = captureTransport(() => sseResponse("not sse at all"));
  const adapter = createCacheProviderAdapter({ transport });
  await assert.rejects(
    () => adapter.send(experimentRequest(1, "multiblock", "prime"), {}),
    /without complete usage/,
    "a stream with no usage frames fails closed",
  );
}

{
  delete process.env.CCR_CLAUDE_API_KEY;
  const adapter = createCacheProviderAdapter({ transport: captureTransport(sseResponse(claudeFrames({}))) });
  await assert.rejects(
    () => adapter.send(experimentRequest(1, "multiblock", "prime"), {}),
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
  // A stub gateway that behaves like a breakpoint cache. The serialized
  // directive text is a request instruction, not content — a provider hashes
  // the block content, with cache_control only marking where the prefix is
  // cut — so each body is normalized with every
  // `,"cache_control":{"type":"ephemeral"}` removed and the cut positions
  // recorded in normalized coordinates. Every request caches its prefix at
  // each of its three boundaries, and a later request is served the longest
  // previously-cached boundary its leading content still shares — matching
  // happens only at those boundaries, never at an arbitrary common prefix.
  // The write is reported in the 1 h bucket. A summary that changed after the
  // tools boundary can only fall back to the tools boundary, which is the
  // behavior the arms must separate.
  const DIRECTIVE = ',"cache_control":{"type":"ephemeral"}';
  const normalizeBody = (body) => {
    const boundaries = [];
    let text = "";
    let from = 0;
    for (;;) {
      const index = body.indexOf(DIRECTIVE, from);
      if (index < 0) break;
      text += body.slice(from, index);
      boundaries.push(text.length);
      from = index + DIRECTIVE.length;
    }
    text += body.slice(from);
    return { text, boundaries };
  };
  const cachedBoundaries = [];
  const transport = captureTransport((body) => {
    const { text, boundaries } = normalizeBody(body);
    let readBytes = 0;
    for (const entry of cachedBoundaries) {
      if (entry.boundary > text.length) continue;
      if (sha256Hex(text.slice(0, entry.boundary)) === entry.hash) {
        readBytes = Math.max(readBytes, entry.boundary);
      }
    }
    for (const boundary of boundaries) {
      cachedBoundaries.push({ hash: sha256Hex(text.slice(0, boundary)), boundary });
    }
    const read = estimateTokens(readBytes);
    const write = estimateTokens(Math.max(0, boundaries[boundaries.length - 1] - readBytes));
    const input = Math.max(0, estimateTokens(text.length) - read - write);
    return sseResponse(claudeFrames({ inputTokens: input, cacheRead: read, cacheWrite: write, retention: "1h" }));
  });

  const adapter = createCacheProviderAdapter({ transport });
  const clock = { now: Date.now, mono: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
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
    assert.equal(group.multiblock.probe.retentionBucket, "1h");
    assert.ok(group.multiblock.probe.ttftMs !== null, "TTFT is locally measured through the real clock");
  }
  // The wire body orders system, messages, tools — so the stub's second and
  // third breakpoints sit after the appended block and can never serve the
  // probe; only the system breakpoint survives the append. The arms under
  // test therefore read only the system boundary while the control reads
  // nothing — a gap this stub's scale keeps inside the pinned liveness
  // margin, so the control is dead here and the verdict is inconclusive
  // (#297 review finding 3): exactly what a measurement that cannot
  // distinguish the carried region must produce.
  for (const group of report.groups) {
    assert.ok(group.multiblock.probe.cacheRead > 0, "the arm under test still reads the system boundary across the append");
    assert.equal(group.nonce.probe.cacheRead, 0, "the per-request control namespace can never be served");
    assert.ok(group.multiblock.probe.cacheRead < group.multiblock.prime.cacheWrite,
      "the append falls back from the full-carried read the prime wrote");
  }
  assert.equal(report.conclusion.cache, "inconclusive");
  assert.equal(report.conclusion.final, "inconclusive");
  assert.equal(report.conclusion.livenessSatisfied, false,
    "the gap the stub can show sits inside the pinned liveness margin, so the control is honestly dead");
  assert.ok(report.conclusion.reasons.some((reason) => reason.includes("liveness control dead")));
  assert.equal(exitCode, 0, "integrity, not the conclusion label, decides the exit code");
}

// ─── a gateway echoing the credential never reaches the report ──────

{
  // #297 review round 3: an error body (or stream error frame) that echoes
  // the API key must be scrubbed exactly — the actual value replaced, the
  // surrounding text preserved — before the error enters the report, and
  // the runner's self-check must catch any survivor.
  const SYNTHETIC_KEY = "sk-echo-test-0123456789abcdef-XYZ";
  const echoBody = JSON.stringify({ error: `invalid api key ${SYNTHETIC_KEY} for this account` });
  const transport = captureTransport(() => ({
    ok: false,
    status: 401,
    text: async () => echoBody,
  }));
  const adapter = createCacheProviderAdapter({ transport });
  process.env.CCR_CLAUDE_API_KEY = SYNTHETIC_KEY;
  try {
    await assert.rejects(
      () => adapter.send(experimentRequest(1, "multiblock", "prime"), {}),
      (error) => {
        assert.ok(!error.message.includes(SYNTHETIC_KEY), "the echoed HTTP error text no longer contains the credential");
        assert.ok(error.message.includes("‹credential›"), "the credential is replaced exactly once per occurrence");
        assert.ok(error.message.includes("provider HTTP 401"), "the bounded error context is preserved");
        return true;
      },
    );
  } finally {
    delete process.env.CCR_CLAUDE_API_KEY;
  }
  // Redaction happens before the report cap: otherwise a long credential
  // crossing that boundary would leak its leading fragment even though the
  // complete value was no longer present to match.
  const LONG_KEY = `sk-${"q".repeat(230)}-tail`;
  const longEchoTransport = captureTransport(() => ({
    ok: false,
    status: 401,
    text: async () => `invalid api key ${LONG_KEY}`,
  }));
  process.env.CCR_CLAUDE_API_KEY = LONG_KEY;
  try {
    const longEchoAdapter = createCacheProviderAdapter({ transport: longEchoTransport });
    await assert.rejects(
      () => longEchoAdapter.send(experimentRequest(1, "multiblock", "prime"), {}),
      (error) => {
        assert.ok(!error.message.includes(LONG_KEY.slice(0, 32)), "a cap-crossing credential leaks no prefix");
        assert.ok(error.message.includes("‹credential›"));
        return true;
      },
    );
  } finally {
    delete process.env.CCR_CLAUDE_API_KEY;
  }
  // The stream-error path scrubs too: a mid-stream error frame echoes the key.
  const echoFrame = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { message: `upstream rejected key ${SYNTHETIC_KEY}` } })}\n\n`,
  ].join("");
  const streamTransport = {
    fetch: async () => sseResponse(echoFrame),
  };
  process.env.CCR_CLAUDE_API_KEY = SYNTHETIC_KEY;
  try {
    const streamAdapter = createCacheProviderAdapter({ transport: streamTransport });
    await assert.rejects(
      () => streamAdapter.send(experimentRequest(1, "multiblock", "prime"), {}),
      (error) => {
        assert.ok(!error.message.includes(SYNTHETIC_KEY), "the echoed stream error text no longer contains the credential");
        assert.ok(error.message.includes("‹credential›"));
        return true;
      },
    );
  } finally {
    delete process.env.CCR_CLAUDE_API_KEY;
  }
  // The runner-level boundary: an adapter whose error bypasses its own scrub
  // still fails integrity and is redacted before progress, reports, or text.
  const leakingAdapter = {
    id: "simulated-leak/1",
    describePins: () => ({ provider: "simulated", model: "simulated/leak-v1", cacheReporting: "reported", retentionBuckets: ["default"] }),
    requiredEnv: ["CCR_CLAUDE_API_KEY"],
    async send() {
      throw new Error(`upstream said: bad key ${SYNTHETIC_KEY}`);
    },
  };
  process.env.CCR_CLAUDE_API_KEY = SYNTHETIC_KEY;
  try {
    const events = [];
    const { report, exitCode, json, humanText } = await runExperiment({
      adapter: leakingAdapter,
      clock: fakeClock(),
      secretValues: [SYNTHETIC_KEY],
      generatedAt: () => "2026-01-01T00:00:00.000Z",
      onEvent: (event) => events.push(event),
    });
    assert.equal(report.integrity.ok, false);
    assert.ok(report.integrity.failures.some((failure) => failure.includes("credential value")),
      "the runner names the credential leak without retaining its value");
    assert.ok(!json.includes(SYNTHETIC_KEY), "the emitted artifact redacts the credential");
    assert.ok(!JSON.stringify(report).includes(SYNTHETIC_KEY), "the returned report redacts the credential");
    assert.ok(!humanText.includes(SYNTHETIC_KEY), "the text artifact redacts the credential");
    assert.ok(!JSON.stringify(events).includes(SYNTHETIC_KEY), "live progress redacts the credential");
    assert.equal(report.conclusion.final, "inconclusive");
    assert.equal(exitCode, 1);
  } finally {
    delete process.env.CCR_CLAUDE_API_KEY;
  }
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
