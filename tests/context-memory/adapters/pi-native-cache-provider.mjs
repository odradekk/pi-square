import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_TOKENS = 512;
const REPORT_STRING_MAX = 240;
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

let defaultRuntimePromise;

function defaultRuntime() {
  defaultRuntimePromise ??= ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return defaultRuntimePromise;
}

function boundedError(error) {
  return String(error?.message ?? error).slice(0, REPORT_STRING_MAX);
}

function textOf(payload, segment) {
  return payload.bytes.subarray(segment.contentStart, segment.contentEnd).toString("utf8");
}

function tailMessage(text, model) {
  const separator = text.indexOf(": ");
  const role = separator < 0 ? "user" : text.slice(0, separator);
  const body = separator < 0 ? text : text.slice(separator + 2);
  if (role !== "assistant") {
    return { role: "user", content: [{ type: "text", text: body }], timestamp: 0 };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: body }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: ZERO_COST,
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

/**
 * Reconstruct the public Pi Context that the pinned fixture represents.
 * Provider-specific wire conversion deliberately remains inside Pi.
 */
export function buildPiCacheContext(request, model) {
  const { payload } = request;
  let systemPrompt;
  let tools;
  const messages = [];
  let memoryParts;

  for (const segment of payload.table) {
    const content = textOf(payload, segment);
    if (segment.element === "system") {
      systemPrompt = content;
    } else if (segment.element === "tools") {
      tools = JSON.parse(content).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
    } else if (segment.element.startsWith("summary-part-")) {
      if (memoryParts === undefined) {
        memoryParts = [];
        messages.push({ role: "user", content: memoryParts, timestamp: 0 });
      }
      memoryParts.push({ type: "text", text: content });
    } else if (segment.element.startsWith("message-")) {
      messages.push(tailMessage(content, model));
    }
  }

  if (messages.at(-1)?.role === "assistant") {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue." }], timestamp: 0 });
  }
  return { systemPrompt, messages, tools };
}

function hasDeclaredCost(model) {
  const rates = [model.cost, ...(model.cost?.tiers ?? [])];
  return rates.some((rate) => [rate?.input, rate?.output, rate?.cacheRead, rate?.cacheWrite]
    .some((value) => typeof value === "number" && value > 0));
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function reportFromMessage(message, model) {
  const usage = message.usage;
  if (!usage || !isCount(usage.input) || !isCount(usage.output)
    || !isCount(usage.cacheRead) || !isCount(usage.cacheWrite)) {
    throw new Error("Pi stream ended without complete normalized usage");
  }
  const isAnthropic = model.api === "anthropic-messages";
  const oneHour = isCount(usage.cacheWrite1h) ? usage.cacheWrite1h : 0;
  const retentionWrite = isAnthropic && oneHour > 0
    ? {
        reported: true,
        bucket: "1h",
        tokens: oneHour,
      }
    : { reported: false, bucket: "unreported", tokens: 0 };
  return {
    usage: { inputTokens: usage.input, outputTokens: usage.output },
    cache: {
      // Pi's public Usage contract always normalizes both directions to
      // numbers. Availability is not a claim about raw-field presence.
      available: true,
      readAvailable: true,
      read: usage.cacheRead,
      writeAvailable: true,
      write: usage.cacheWrite,
      source: "pi-normalized",
      rawFieldPresence: "unknown",
    },
    retentionWrite,
    cost: usage.cost?.total ?? 0,
    costReported: hasDeclaredCost(model),
  };
}

async function consumePiStream(stream, model, observe) {
  let finalMessage;
  let firstToken = false;
  for await (const event of stream) {
    if (!firstToken && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")) {
      firstToken = true;
      observe.onFirstToken?.();
    }
    if (event.type === "error") {
      // Pi may include a provider response body in errorMessage. The native
      // runtime owns auth and does not expose its resolved credential here,
      // so persist no upstream text rather than risk archiving an echo.
      throw new Error(`Pi native model request failed (${event.reason})`);
    }
    if (event.type === "done") finalMessage = event.message;
  }
  if (!finalMessage) throw new Error("Pi stream ended without a final assistant message");
  return reportFromMessage(finalMessage, model);
}

/**
 * Cache experiment adapter backed by the same public model runtime Pi uses.
 * Model discovery, auth, payload conversion, compatibility behavior, cache
 * controls, response parsing, and usage normalization all remain Pi-owned.
 */
export function createPiNativeCacheProviderAdapter({
  provider,
  model: modelId,
  id = `${provider}/${modelId}/pi-native-cache/1`,
  runtimeFactory = defaultRuntime,
  fetch,
  cacheRetention = "short",
  breakpointPlacement,
  retentionBuckets = [],
}) {
  return {
    id,
    requiredEnv: [],
    describePins: () => ({
      provider,
      model: modelId,
      cacheReporting: "Pi 0.84.2 normalized Usage.cacheRead/cacheWrite",
      retentionBuckets,
      breakpointPlacement,
      settingsOmissions: [],
      priceNote: "cost uses Pi's configured model price table; an all-zero table is reported as unavailable",
      invocation: "Pi 0.84.2 ModelRuntime.streamSimple",
    }),
    async send(request, observe = {}) {
      if (typeof request.runNonce !== "string" || request.runNonce.length === 0) {
        throw new Error("cache experiment request is missing its Pi session nonce");
      }
      const runtime = await runtimeFactory();
      const model = runtime.getModel(provider, modelId);
      if (!model) {
        throw new Error(boundedError(`Pi models.json does not define ${provider}/${modelId}`));
      }
      const context = buildPiCacheContext(request, model);
      const stream = runtime.streamSimple(model, context, {
        cacheRetention,
        sessionId: `pi-square-cache-${provider}-${modelId}-${request.runNonce}`,
        maxTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        ...(fetch ? { fetch } : {}),
      });
      return consumePiStream(stream, model, observe);
    },
  };
}
