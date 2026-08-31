import { estimateTokens } from "./evidence.mjs";

/**
 * The dry-run provider seam for the provider-cache experiment (#225).
 *
 * The adapter is an honest byte-prefix cache simulation, not a verdict
 * generator: it serves the longest common byte prefix shared with any
 * unexpired prior request (bounded by each side's retention breakpoint),
 * charges writes for the newly covered remainder, expires entries at the
 * pinned TTL, and reports a locally measured TTFT through the injected clock.
 * Capacity is generous and LRU-only so the simulation models TTL behavior,
 * not capacity pressure — the report says so.
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

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared;
}

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
  const entries = []; // { bytes: Buffer, coveredBytes: number, expiresAt: number }

  return {
    id: "simulated-prefix-cache/1",
    describePins: () => ({
      provider: "simulated",
      model: "simulated/prefix-cache-v1",
      cacheReporting,
      retentionBuckets: ["default"],
    }),
    async send(request, observe = {}) {
      const sentAt = clock.now();
      const live = entries.filter((entry) => entry.expiresAt > sentAt);
      entries.length = 0;
      entries.push(...live);

      const coveredBytes = Math.min(request.cacheControl.coveredBytes, request.payload.bytes.length);
      const totalTokens = estimateTokens(request.payload.bytes.length);
      let read = 0;
      let write = 0;
      if (cacheReporting === "reported") {
        let readBytes = 0;
        for (const entry of live) {
          const common = commonPrefixLength(request.payload.bytes, entry.bytes);
          readBytes = Math.max(readBytes, Math.min(common, entry.coveredBytes, coveredBytes));
        }
        read = estimateTokens(readBytes);
        write = estimateTokens(Math.max(0, coveredBytes - readBytes));
      }
      const uncached = Math.max(0, totalTokens - read - write);
      const outputTokens = request.role === "prime" ? 48 : 64;

      // TTFT scales with work the cache did not absorb; measured by the runner.
      const ttftMs = 50 + uncached + write + Math.floor(read / 8);
      await clock.sleep(ttftMs);
      if (observe.onFirstToken) observe.onFirstToken();

      if (cacheReporting === "reported") {
        if (entries.length >= capacity) entries.shift();
        entries.push({ bytes: request.payload.bytes, coveredBytes, expiresAt: sentAt + ttlMs });
      }

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
