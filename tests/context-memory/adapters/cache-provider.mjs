import { BREAKPOINT_PLACEMENT } from "../cache-experiment/fixture.mjs";
import { openAiCacheProviderAdapters } from "./cache-openai-provider.mjs";
import { createPiNativeCacheProviderAdapter } from "./pi-native-cache-provider.mjs";

export function createCacheProviderAdapter(options = {}) {
  return createPiNativeCacheProviderAdapter({
    provider: "ccr-claude",
    model: "claude-sonnet-5",
    id: "ccr-claude/claude-sonnet-5/pi-native-cache/1",
    breakpointPlacement: `Pi's native anthropic-messages placement: ${BREAKPOINT_PLACEMENT}`,
    retentionBuckets: ["5m", "1h"],
    ...options,
  });
}

const anthropicCacheProviderAdapter = createCacheProviderAdapter();

/** All three lanes share Pi's native ModelRuntime and execute concurrently. */
export const adapters = Object.freeze([anthropicCacheProviderAdapter, ...openAiCacheProviderAdapters]);

export default anthropicCacheProviderAdapter;
