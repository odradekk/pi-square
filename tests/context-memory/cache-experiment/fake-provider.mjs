import { BREAKPOINT_PLACEMENT } from "./fixture.mjs";
import { estimateTokens, sha256Hex } from "./evidence.mjs";

/**
 * The dry-run provider seam for the provider-cache experiment (#225, re-modeled
 * by #268).
 *
 * The adapter is an honest breakpoint cache simulation, not a verdict
 * generator. Every request declares the same breakpoints Pi's
 * anthropic-messages converter places — the system blocks, the last immediate
 * tool, and the last block of the last user message, as canonical byte
 * positions in `cacheControl.breakpoints`. Each request caches its prefix at
 * each of those boundaries, and a later request is served the longest
 * previously-cached boundary whose bytes it still shares — never an arbitrary
 * common prefix. A request whose carried content diverges after the tools
 * boundary therefore falls back to exactly the tools boundary: that is the
 * property the negative control exists to expose (#268 defect 1, where every
 * arm changed its summary and every arm read the same tools-boundary
 * constant). Writes are charged for the newly covered remainder up to the
 * coverage boundary (the last breakpoint), entries expire at the pinned TTL,
 * and TTFT is measured locally through the injected clock.
 *
 * Not modeled, deliberately: Anthropic's look-back window from the final
 * breakpoint, and capacity pressure — capacity is generous and LRU-only, so
 * the simulation models TTL behavior and boundary matching, not eviction.
 * The report says so.
 *
 * Real credentialed execution is #227: this slice ships no adapter that
 * performs network I/O, and no test requires credentials.
 */

/** A deterministic clock seam: `now()` for timestamps, `sleep()` for gaps. */
export function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
}

/** Deterministic dry-run price table, US dollars per million tokens. */
export const DRY_RUN_PRICES = Object.freeze({
  inputPerMTok: 3,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  outputPerMTok: 15,
});

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The simulated cache adapter. `cacheReporting: "unsupported"` models a
 * provider whose responses carry no cache fields at all: every request then
 * reports `reported: false`, which the verdict rules treat as missing
 * evidence, never as a zero.
 */
export function simulatedCacheAdapter({
  clock,
  ttlMs = 300_000,
  prices = DRY_RUN_PRICES,
  cacheReporting = "reported",
  capacity = 256,
}) {
  // Content-addressed breakpoint entries: prefix hash -> { boundary, expiresAt }.
  // Map insertion order is the LRU order; re-setting an existing hash refreshes it.
  const entries = new Map();

  return {
    id: "simulated-prefix-cache/1",
    describePins: () => ({
      provider: "simulated",
      model: "simulated/prefix-cache-v1",
      cacheReporting,
      retentionBuckets: ["default"],
      breakpointPlacement: BREAKPOINT_PLACEMENT,
    }),
    async send(request, observe = {}) {
      const sentAt = clock.now();
      for (const [hash, entry] of entries) {
        if (entry.expiresAt <= sentAt) entries.delete(hash);
      }

      const breakpoints = request.cacheControl.breakpoints;
      const coveredBytes = breakpoints[breakpoints.length - 1];
      const totalTokens = estimateTokens(request.payload.bytes.length);
      let read = 0;
      let write = 0;
      if (cacheReporting === "reported") {
        // The longest previously-cached boundary this request's leading bytes
        // still match, exactly as a breakpoint cache serves it: a summary that
        // changed after the tools boundary can only fall back to the tools
        // boundary, never to a mid-block common prefix.
        let readBytes = 0;
        for (const [hash, entry] of entries) {
          if (entry.boundary > request.payload.bytes.length) continue;
          if (sha256Hex(request.payload.bytes.subarray(0, entry.boundary)) === hash) {
            readBytes = Math.max(readBytes, entry.boundary);
          }
        }
        read = estimateTokens(readBytes);
        write = estimateTokens(Math.max(0, coveredBytes - readBytes));
        for (const boundary of breakpoints) {
          const hash = sha256Hex(request.payload.bytes.subarray(0, boundary));
          entries.delete(hash);
          if (entries.size >= capacity) entries.delete(entries.keys().next().value);
          entries.set(hash, { boundary, expiresAt: sentAt + ttlMs });
        }
      }
      const uncached = Math.max(0, totalTokens - read - write);
      const outputTokens = request.role === "prime" ? 48 : 64;

      // TTFT scales with work the cache did not absorb; measured by the runner.
      const ttftMs = 50 + uncached + write + Math.floor(read / 8);
      await clock.sleep(ttftMs);
      if (observe.onFirstToken) observe.onFirstToken();

      const cost = roundCost(
        (uncached * prices.inputPerMTok
          + read * prices.cacheReadPerMTok
          + write * prices.cacheWritePerMTok
          + outputTokens * prices.outputPerMTok) / 1e6,
      );
      return {
        usage: { inputTokens: uncached, outputTokens },
        cache: cacheReporting === "reported"
          ? { reported: true, read, write }
          : { reported: false, read: 0, write: 0 },
        retentionWrite: cacheReporting === "reported"
          ? { reported: true, bucket: request.cacheControl.bucket, tokens: write }
          : { reported: false, bucket: "unreported", tokens: 0 },
        cost,
      };
    },
  };
}
