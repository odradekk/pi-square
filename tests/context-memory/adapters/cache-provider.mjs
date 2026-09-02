import { boundedErrorText, realTransport } from "./transport.mjs";

/**
 * The credentialed provider-cache experiment adapter (#248, executed by #227;
 * breakpoint placement re-modeled by #268).
 *
 * It implements the adapter contract validated by
 * `tests/context-memory/cache-experiment/runner.mjs` — `{ id, describePins(),
 * send(request, observe) }` — against the `ccr-claude` gateway only, and
 * builds every request as a deterministic reconstruction of the experiment's
 * canonical payload:
 *
 * - The wire request is reconstructed from `request.payload.table`: the
 *   `system` segment becomes the system block, the `tools` segment becomes
 *   the tool list, the `summary` segment becomes the leading context user
 *   message, and each `message-N` segment becomes one tail message. No
 *   timestamps, ids, or nonce-shaped fields are injected anywhere, so equal
 *   canonical payload prefixes produce equal wire prefixes and the provider's
 *   cache can only ever see the variability the fixture intends.
 * - The cache breakpoints are placed exactly where Pi's anthropic-messages
 *   converter places them (Pi 0.84.2,
 *   `@earendil-works/pi-ai/dist/api/anthropic-messages.js`): one on the
 *   system block, one on the last immediate tool, and one on the last block
 *   of the last user message. The carried summary is one text block, as Pi
 *   renders a compactionSummary (`@earendil-works/pi-coding-agent/dist/core/messages.js`),
 *   and it carries no breakpoint of its own — so a request whose summary
 *   changed can only fall back to the tools boundary, which is the property
 *   the fixture's negative control exists to expose. `describePins()`
 *   records the placement as "mirrors Pi's anthropic-messages placement" with
 *   the three positions named.
 * - `temperature` is omitted although the pinned settings carry 0:
 *   `claude-sonnet-5` rejects `temperature` (issue #248's probed facts), so
 *   the pinned settings cannot be fully applied on any model that caches.
 *   The omission is recorded in the adapter's pins rather than silently
 *   dropped.
 * - `retentionWrite.bucket` reports the bucket the provider actually used
 *   (`cache_creation.ephemeral_1h_input_tokens` versus `ephemeral_5m`), not
 *   the one requested: the probed gateway lands writes in the 1 h bucket even
 *   when plain 5 m `ephemeral` is requested.
 * - `usage.inputTokens` is the uncached input only. The Anthropic Messages
 *   usage object counts uncached input in `input_tokens` and reports cached
 *   input separately through `cache_read_input_tokens` and
 *   `cache_creation_input_tokens`, so no subtraction is applied.
 * - `cache.reported: false` means the response carried none of the cache
 *   fields; `{reported: true, read: 0, write: 0}` means both fields were
 *   present and zero. Absent evidence is never recorded as a zero.
 * - The adapter parses the SSE stream itself, fires `observe.onFirstToken()`
 *   at the first `content_block_delta`, and performs no internal retry: one
 *   transport call per request, and any failure propagates to the runner as
 *   an integrity failure.
 *
 * This module is never executed by #248: real execution, credentials, and
 * the verdict belong to #227 and the maintainer. The offline unit tests
 * drive it against a stubbed transport only.
 */

const PROVIDER = "ccr-claude";
const MODEL = "claude-sonnet-5";
const API_KEY_ENV = "CCR_CLAUDE_API_KEY";
const BASE_URL_ENV = "CCR_CLAUDE_BASE_URL";
const BASE_URL_DEFAULT = "https://ccr.bearfamily.us";
/** `SETTINGS.maxOutputTokens` from the pinned fixture; the only settings applied verbatim. */
const MAX_OUTPUT_TOKENS = 512;
/**
 * The fixed user continuation appended when the reconstructed conversation
 * ends with an assistant turn: claude-sonnet-5 rejects assistant message
 * prefill ("The conversation must end with a user message"), and every probe
 * tail ends with the release-notes assistant turn. The text is a constant by
 * construction and never varies per request; as the closing user turn it is
 * the block that carries the tail breakpoint, exactly as a closing user turn
 * does in a real Pi conversation.
 */
export const PREFILL_CONTINUATION_USER_TEXT = "Continue.";
const REPORT_STRING_MAX = 240;
const PRICE_NOTE_MAX = 240;

/**
 * Declared price table, US dollars per million tokens. These are the
 * published Sonnet-tier prices the dry-run table also uses; the report treats
 * cost as informational, and #227 adjusts the table if the gateway's real
 * prices differ. The note in the pins marks it as declared, not measured.
 */
export const CACHE_PROVIDER_PRICES = Object.freeze({
  inputPerMTok: 3,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  outputPerMTok: 15,
});

const SETTINGS_OMISSIONS = [
  "temperature (pinned 0) omitted: claude-sonnet-5 rejects temperature (deprecated for this model); the omission is deliberate, not silent",
];

const PRICE_NOTE =
  "cost from the adapter's declared estimated price table (USD/MTok in/out/cache-read/cache-write 3/15/0.3/3.75); not provider-measured";

/**
 * The pinned breakpoint placement, declared in the adapter's pins and copied
 * into the report: the three positions Pi's anthropic-messages converter sets
 * (Pi 0.84.2, `@earendil-works/pi-ai/dist/api/anthropic-messages.js`).
 */
const BREAKPOINT_PLACEMENT =
  "mirrors Pi's anthropic-messages placement: system blocks, last immediate tool, last block of the last user message";

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

function boundedString(value, cap = REPORT_STRING_MAX) {
  return String(value).slice(0, cap);
}

// ─── Wire reconstruction from the canonical payload table ───────────

function tailMessageOf(text) {
  const separator = text.indexOf(": ");
  if (separator < 0) return { role: "user", content: text };
  const role = text.slice(0, separator);
  const body = text.slice(separator + 2);
  // The fixture's `tool` tail rows carry tool output as plain text; mapping
  // them to user-role text avoids inventing tool-call ids the payload does
  // not contain. Everything after the breakpoint is deterministic either way.
  return role === "assistant" ? { role: "assistant", content: body } : { role: "user", content: body };
}

/**
 * Reconstructs one Claude Messages request from the canonical payload. Pure:
 * the same table always produces the same request body, and no per-request
 * variability is injected anywhere. Returns the serializable body plus the
 * three blocks that carry the cache breakpoints, in placement order: the
 * system block, the last immediate tool, and the last block of the last user
 * message — exactly where Pi's anthropic-messages converter places them.
 */
export function buildClaudeCacheRequest(request) {
  const payload = request.payload;
  const contentOf = (segment) => payload.bytes.subarray(segment.contentStart, segment.contentEnd).toString("utf8");

  let system = null;
  let tools = null;
  const messages = [];
  for (const segment of payload.table) {
    if (segment.element === "system") {
      system = contentOf(segment);
    } else if (segment.element === "tools") {
      tools = JSON.parse(contentOf(segment)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    } else if (segment.element === "summary") {
      messages.push({ role: "user", content: [{ type: "text", text: contentOf(segment) }] });
    } else if (segment.element.startsWith("message-")) {
      const message = tailMessageOf(contentOf(segment));
      // One text block per tail message keeps caching matched at the same
      // boundaries the canonical bytes describe.
      messages.push({ role: message.role, content: [{ type: "text", text: message.content }] });
    }
  }

  // The gateway's model rejects assistant message prefill, and every probe's
  // tail ends with an assistant turn; one fixed user continuation closes the
  // conversation. Primes already end with a user turn and gain nothing.
  if (messages.at(-1)?.role === "assistant") {
    messages.push({ role: "user", content: [{ type: "text", text: PREFILL_CONTINUATION_USER_TEXT }] });
  }

  // Breakpoint 1 of 3, the system blocks: the system prompt becomes one text
  // block carrying cache_control, exactly as Pi sends it.
  const systemBlock = system === null ? null : { type: "text", text: system, cache_control: { type: "ephemeral" } };
  // Breakpoint 2 of 3, the last immediate tool.
  if (tools !== null && tools.length > 0) {
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  }
  // Breakpoint 3 of 3, the last block of the last user message. The
  // reconstruction always ends with a user turn (the tool row for primes, the
  // fixed continuation for probes), as every Pi conversation does.
  const lastMessage = messages[messages.length - 1];
  const tailBlock = Array.isArray(lastMessage?.content) ? lastMessage.content[lastMessage.content.length - 1] : undefined;
  if (tailBlock && (tailBlock.type === "text" || tailBlock.type === "image" || tailBlock.type === "tool_result")) {
    tailBlock.cache_control = { type: "ephemeral" };
  }

  return {
    body: {
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemBlock === null ? undefined : [systemBlock],
      messages,
      tools: tools === null ? undefined : tools,
      stream: true,
    },
    breakpointBlocks: [systemBlock, tools?.at(-1) ?? null, tailBlock?.cache_control ? tailBlock : null],
  };
}

// ─── SSE consumption ────────────────────────────────────────────────

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Consumes one Anthropic streaming response. `message_start` carries the
 * input-side usage; `message_delta` carries the authoritative final usage;
 * `content_block_delta` is the first-token signal. Any `error` event fails
 * the request. Nothing is buffered beyond the usage fields the report needs.
 */
async function consumeSse(response, observe) {
  const usage = {};
  let firstTokenFired = false;
  // Anthropic reports input-side usage in `message_start` and the final
  // `output_tokens` in `message_delta`. The first defined value of an
  // input-side field wins (a delta carrying zeroed input fields must not
  // clobber the start values); `output_tokens` takes the last writer.
  const applyUsage = (patch) => {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null || value === undefined) continue;
      if (typeof value === "number") {
        if (!isCount(value)) continue;
        if (key === "output_tokens" || usage[key] === undefined) usage[key] = value;
      } else if (usage[key] === undefined) {
        usage[key] = value; // object-valued detail such as `cache_creation`
      }
    }
  };
  const handleEvent = (frame) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue; // a malformed frame is ignored; the usage contract fails closed below
      }
      if (event.type === "error") {
        const message = event.error?.message ?? event.message ?? "provider stream error";
        throw new Error(boundedString(`provider stream error: ${message}`, REPORT_STRING_MAX));
      }
      if (event.type === "content_block_delta" && !firstTokenFired) {
        firstTokenFired = true;
        observe.onFirstToken?.();
      }
      if (event.type === "message_start" && event.message?.usage) {
        applyUsage(event.message.usage);
      }
      if (event.type === "message_delta" && event.usage) {
        applyUsage(event.usage);
      }
    }
  };

  let buffer = "";
  // The platform `fetch` yields Uint8Array chunks, not Node Buffers, and a
  // multi-byte code point can straddle a chunk boundary. A streaming
  // TextDecoder covers both; `String(chunk)` would stringify the byte values.
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      handleEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  if (buffer.trim().length > 0) handleEvent(buffer);

  if (!isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
    throw new Error(boundedString("provider stream ended without complete usage", REPORT_STRING_MAX));
  }

  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  const cacheReported = isCount(read) || isCount(write);
  const cache = cacheReported
    ? { reported: true, read: isCount(read) ? read : 0, write: isCount(write) ? write : 0 }
    : { reported: false, read: 0, write: 0 };

  const detail = usage.cache_creation;
  let retentionWrite;
  if (detail !== null && typeof detail === "object"
    && (isCount(detail.ephemeral_5m_input_tokens) || isCount(detail.ephemeral_1h_input_tokens))) {
    const oneHour = isCount(detail.ephemeral_1h_input_tokens) ? detail.ephemeral_1h_input_tokens : 0;
    const fiveMinute = isCount(detail.ephemeral_5m_input_tokens) ? detail.ephemeral_5m_input_tokens : 0;
    retentionWrite = oneHour > 0
      ? { reported: true, bucket: "1h", tokens: oneHour }
      : fiveMinute > 0
        ? { reported: true, bucket: "5m", tokens: fiveMinute }
        : { reported: true, bucket: "unspecified", tokens: 0 };
  } else {
    retentionWrite = { reported: false, bucket: "unreported", tokens: 0 };
  }

  const cost = roundCost(
    (usage.input_tokens * CACHE_PROVIDER_PRICES.inputPerMTok
      + cache.read * CACHE_PROVIDER_PRICES.cacheReadPerMTok
      + cache.write * CACHE_PROVIDER_PRICES.cacheWritePerMTok
      + usage.output_tokens * CACHE_PROVIDER_PRICES.outputPerMTok) / 1e6,
  );
  return {
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    cache,
    retentionWrite,
    cost,
  };
}

// ─── The adapter ────────────────────────────────────────────────────

/**
 * Builds the real cache-experiment adapter. `options.transport` is the stub
 * seam for the offline tests; production callers take the default `fetch`
 * transport. Construction performs no I/O and reads no environment.
 */
export function createCacheProviderAdapter(options = {}) {
  const transport = options.transport ?? realTransport();
  return {
    id: "ccr-claude/anthropic-cache/1",
    requiredEnv: [API_KEY_ENV],
    describePins: () => ({
      provider: PROVIDER,
      model: MODEL,
      cacheReporting: "reported",
      retentionBuckets: ["5m", "1h"],
      breakpointPlacement: BREAKPOINT_PLACEMENT,
      settingsOmissions: SETTINGS_OMISSIONS,
      priceNote: boundedString(PRICE_NOTE, PRICE_NOTE_MAX),
    }),
    async send(request, observe = {}) {
      const key = process.env[API_KEY_ENV];
      if (!key) {
        throw new Error(boundedString(`${API_KEY_ENV} is not set; the adapter never prints credential values`));
      }
      const baseUrl = process.env[BASE_URL_ENV] || BASE_URL_DEFAULT;
      const { body } = buildClaudeCacheRequest(request);
      const response = await transport.fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          // One credential header only: x-api-key is verified against the
          // gateway; the OpenAI path is the sole Bearer user.
          "x-api-key": key,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(boundedString(`provider HTTP ${response.status}: ${await boundedErrorText(response)}`, REPORT_STRING_MAX));
      }
      return consumeSse(response, observe);
    },
  };
}

export default createCacheProviderAdapter();
