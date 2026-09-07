import { createPiNativeCacheProviderAdapter } from "./pi-native-cache-provider.mjs";

const PROVIDER = "cpa";
const BREAKPOINT_PLACEMENT =
  "Pi's native custom openai-completions path: provider-managed prefix caching; no explicit breakpoint or prompt_cache_key at short retention";

const MODELS = Object.freeze({
  "glm-5.3": "cpa/glm-5.3/pi-native-cache/1",
  "gpt-5.6-luna": "cpa/gpt-5.6-luna/pi-native-cache/1",
});

export function createOpenAiCacheProviderAdapter({ model, ...options }) {
  const id = MODELS[model];
  if (!id) throw new Error(`unsupported cache experiment model: ${model}`);
  return createPiNativeCacheProviderAdapter({
    provider: PROVIDER,
    model,
    id,
    breakpointPlacement: BREAKPOINT_PLACEMENT,
    ...options,
  });
}

export const openAiCacheProviderAdapters = Object.freeze([
  createOpenAiCacheProviderAdapter({ model: "glm-5.3" }),
  createOpenAiCacheProviderAdapter({ model: "gpt-5.6-luna" }),
]);
