import { boundedErrorText, realTransport } from "./transport.mjs";

/**
 * CPA transparent-proxy probes on 2026-09-07 established the streamed usage
 * shapes this adapter consumes. GLM 5.3 returned
 * `prompt_tokens_details.cached_tokens`; GPT-5.6 Luna returned that read
 * field plus `cached_creation_tokens`. Both placed the complete usage object
 * on the final Chat Completions SSE chunk. The compatibility aliases below
 * additionally match Pi 0.84.2's OpenAI-completions parser
 * (`prompt_cache_hit_tokens` and `cache_write_tokens`).
 */

const PROVIDER = "cpa";
const API_KEY_ENV = "CPA_API_KEY";
const BASE_URL_ENV = "CPA_BASE_URL";
const BASE_URL_DEFAULT = "https://cpa.bearfamily.us";
const MAX_OUTPUT_TOKENS = 512;
const REPORT_STRING_MAX = 240;

const MODELS = Object.freeze({
  "glm-5.3": {
    id: "cpa/glm-5.3/openai-cache/1",
    cacheReporting: "read via usage.prompt_tokens_details.cached_tokens; cache writes unreported",
  },
  "gpt-5.6-luna": {
    id: "cpa/gpt-5.6-luna/openai-cache/1",
    cacheReporting: "read/write via usage.prompt_tokens_details.cached_tokens/cached_creation_tokens",
  },
});

const BREAKPOINT_PLACEMENT =
  "provider-managed automatic prefix matching; Pi's custom openai-completions path sends no explicit cache breakpoint or prompt_cache_key";
const PRICE_NOTE = "provider price table unavailable; cost is unreported and excluded from cross-model comparison";

function boundedString(value) {
  return String(value).slice(0, REPORT_STRING_MAX);
}

function scrubCredential(text, credential) {
  const value = String(text);
  if (!credential || credential.length < 3 || !value.includes(credential)) return value;
  return value.split(credential).join("‹credential›");
}

function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function tailMessageOf(text) {
  const separator = text.indexOf(": ");
  if (separator < 0) return { role: "user", content: text };
  const role = text.slice(0, separator);
  const content = text.slice(separator + 2);
  return role === "assistant" ? { role: "assistant", content } : { role: "user", content };
}

/** Reconstructs the fixture as Pi's OpenAI-compatible Chat Completions shape. */
export function buildOpenAiCacheRequest(request, model) {
  if (!(model in MODELS)) throw new Error(`unsupported cache experiment model: ${model}`);
  const { payload } = request;
  const contentOf = (segment) => payload.bytes.subarray(segment.contentStart, segment.contentEnd).toString("utf8");
  let system;
  let tools;
  const messages = [];
  let summaryParts = null;
  for (const segment of payload.table) {
    if (segment.element === "system") {
      system = contentOf(segment);
    } else if (segment.element === "tools") {
      tools = JSON.parse(contentOf(segment)).map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false,
        },
      }));
    } else if (segment.element.startsWith("summary-part-")) {
      if (summaryParts === null) {
        summaryParts = [];
        messages.push({ role: "user", content: summaryParts });
      }
      summaryParts.push({ type: "text", text: contentOf(segment) });
    } else if (segment.element.startsWith("message-")) {
      const message = tailMessageOf(contentOf(segment));
      messages.push({
        role: message.role,
        content: message.role === "assistant" ? message.content : [{ type: "text", text: message.content }],
      });
    }
  }
  if (messages.at(-1)?.role === "assistant") {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }
  return {
    model,
    messages: system === undefined ? messages : [{ role: "system", content: system }, ...messages],
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    store: false,
  };
}

async function consumeSse(response, observe, credential) {
  let usage;
  let firstTokenFired = false;
  const handleFrame = (frame) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (event.error) {
        throw new Error(boundedString(scrubCredential(`provider stream error: ${event.error.message ?? event.error}`, credential)));
      }
      if (event.usage !== null && typeof event.usage === "object") usage = event.usage;
      if (!firstTokenFired && event.choices?.some((choice) => {
        const delta = choice?.delta;
        return (typeof delta?.content === "string" && delta.content.length > 0)
          || (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0)
          || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0);
      })) {
        firstTokenFired = true;
        observe.onFirstToken?.();
      }
    }
  };

  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      handleFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) handleFrame(buffer);

  if (!isCount(usage?.prompt_tokens) || !isCount(usage?.completion_tokens)) {
    throw new Error("provider stream ended without complete usage");
  }
  const details = usage.prompt_tokens_details;
  const readField = details !== null && typeof details === "object"
    && Object.prototype.hasOwnProperty.call(details, "cached_tokens")
    ? "cached_tokens"
    : Object.prototype.hasOwnProperty.call(usage, "prompt_cache_hit_tokens") ? "prompt_cache_hit_tokens" : null;
  const creationField = details !== null && typeof details === "object"
    ? (Object.prototype.hasOwnProperty.call(details, "cache_write_tokens")
        ? "cache_write_tokens"
        : Object.prototype.hasOwnProperty.call(details, "cached_creation_tokens") ? "cached_creation_tokens" : null)
    : null;
  const readReported = readField !== null;
  const read = readField === "prompt_cache_hit_tokens" ? usage.prompt_cache_hit_tokens : readReported ? details.cached_tokens : 0;
  const write = creationField === null ? 0 : details[creationField];
  if ((readReported && !isCount(read)) || (creationField !== null && !isCount(write))) {
    throw new Error("provider returned malformed cache token counts");
  }
  if (read + write > usage.prompt_tokens) {
    throw new Error("provider cache token counts exceed prompt_tokens");
  }
  return {
    usage: { inputTokens: usage.prompt_tokens - read - write, outputTokens: usage.completion_tokens },
    cache: {
      reported: readReported || creationField !== null,
      readReported,
      read,
      write,
      writeReported: creationField !== null,
    },
    retentionWrite: { reported: false, bucket: "unreported", tokens: 0 },
    cost: 0,
    costReported: false,
  };
}

export function createOpenAiCacheProviderAdapter({ model, transport = realTransport() }) {
  const definition = MODELS[model];
  if (!definition) throw new Error(`unsupported cache experiment model: ${model}`);
  return {
    id: definition.id,
    requiredEnv: [API_KEY_ENV],
    describePins: () => ({
      provider: PROVIDER,
      model,
      cacheReporting: definition.cacheReporting,
      retentionBuckets: [],
      breakpointPlacement: BREAKPOINT_PLACEMENT,
      settingsOmissions: [],
      priceNote: PRICE_NOTE,
    }),
    async send(request, observe = {}) {
      const key = process.env[API_KEY_ENV];
      if (!key) throw new Error(`${API_KEY_ENV} is not set; the adapter never prints credential values`);
      const baseUrl = process.env[BASE_URL_ENV] || BASE_URL_DEFAULT;
      const response = await transport.fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(buildOpenAiCacheRequest(request, model)),
      });
      if (!response.ok) {
        const bodyText = await boundedErrorText(response, 200, [key]);
        throw new Error(boundedString(scrubCredential(`provider HTTP ${response.status}: ${bodyText}`, key)));
      }
      return consumeSse(response, observe, key);
    },
  };
}

export const openAiCacheProviderAdapters = Object.freeze([
  createOpenAiCacheProviderAdapter({ model: "glm-5.3" }),
  createOpenAiCacheProviderAdapter({ model: "gpt-5.6-luna" }),
]);
