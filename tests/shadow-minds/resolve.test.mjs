import assert from "node:assert/strict";
import { resolve } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const pi = resolve(import.meta.dirname, "..", "..");

const {
  matchesParentModelFilter,
  resolveShadowThinkingLevel,
  resolveShadowModel,
} = await load(resolve(pi, "src/shadow-minds/resolve.ts"));

// ── Exact parent-model filtering: exact provider/model-id or '*' ────

{
  assert.equal(matchesParentModelFilter(undefined, "acme/a1"), true, "no filter matches everything");
  assert.equal(matchesParentModelFilter([], "acme/a1"), true, "empty filter matches everything");
  assert.equal(matchesParentModelFilter(["*"], "acme/a1"), true);
  assert.equal(matchesParentModelFilter(["acme/a1"], "acme/a1"), true);
  assert.equal(matchesParentModelFilter(["acme/a1", "other/b2"], "other/b2"), true);
  assert.equal(matchesParentModelFilter(["acme/a1"], "acme/a2"), false, "no family or prefix matching");
  assert.equal(matchesParentModelFilter(["acme/*"], "acme/a1"), false, "wildcards are not patterns");
  assert.equal(matchesParentModelFilter(["acme/a1"], undefined), false, "no parent model never matches a filter");
  assert.equal(matchesParentModelFilter(["*"], undefined), false);
}

// ── Ordered thinking-level fallback ─────────────────────────────────

{
  const model = { reasoning: true, thinkingLevelMap: { high: "high", medium: "medium", low: "low", xhigh: null } };
  // Shadow value wins over the effective configuration default and parent.
  assert.deepEqual(resolveShadowThinkingLevel("high", "medium", "low", model), { level: "high" });
  // An unsupported Shadow value falls through to the supported configuration default.
  assert.deepEqual(resolveShadowThinkingLevel("xhigh", "medium", "low", model), { level: "medium" });
  // An unsupported config value falls through to the supported parent value.
  assert.deepEqual(resolveShadowThinkingLevel(undefined, "xhigh", "low", model), { level: "low" });
  // No candidate lets Pi choose its ordinary model default.
  assert.deepEqual(resolveShadowThinkingLevel(undefined, undefined, undefined, model), {});
  // If candidates exist but none are supported, the run fails rather than clamping silently.
  assert.match(resolveShadowThinkingLevel("xhigh", undefined, undefined, model).error, /does not support/i);
  // A non-reasoning model supports only off, so a later off candidate remains usable.
  assert.deepEqual(resolveShadowThinkingLevel("high", "off", undefined, { reasoning: false }), { level: "off" });
}

// ── Explicit model resolution (moved from the session wiring) ───────

function ctx(overrides = {}) {
  return {
    model: { provider: "acme", id: "parent-model" },
    modelRegistry: {
      find: (provider, id) => (provider === "other" && id === "cross-model"
        ? { provider, id, contextWindow: 100_000 }
        : undefined),
    },
    ...overrides,
  };
}

{
  // No explicit model inherits the parent model with a provider/id label.
  const inherited = resolveShadowModel(undefined, ctx());
  assert.deepEqual(inherited.model, { provider: "acme", id: "parent-model" });
  assert.equal(inherited.label, "acme/parent-model");
  assert.equal(inherited.error, undefined);
}

{
  // An explicit model resolves through the registry, cross-provider included.
  const explicit = resolveShadowModel("other/cross-model", ctx({
    modelRegistry: {
      find: (provider, id) => ({ provider, id, contextWindow: 100_000 }),
      hasConfiguredAuth: () => true,
    },
  }));
  assert.equal(explicit.label, "other/cross-model");
  assert.equal(explicit.error, undefined);
  assert.deepEqual(explicit.model, { provider: "other", id: "cross-model", contextWindow: 100_000 });
}

{
  // An explicit model without configured authentication fails before a child is created.
  const unauthenticated = resolveShadowModel("other/cross-model", ctx({
    modelRegistry: {
      find: (provider, id) => ({ provider, id }),
      hasConfiguredAuth: () => false,
    },
  }));
  assert.equal(unauthenticated.model, undefined);
  assert.match(unauthenticated.error, /no configured authentication/i);
}

{
  // An explicit unknown model fails and never silently falls back.
  const missing = resolveShadowModel("other/missing", ctx());
  assert.equal(missing.model, undefined);
  assert.match(missing.error, /Unknown Shadow model 'other\/missing'/);
}

{
  // A malformed spec fails with the expected shape.
  assert.match(resolveShadowModel("no-slash", ctx()).error, /Invalid model 'no-slash'/);
  const noParent = resolveShadowModel(undefined, ctx({ model: undefined }));
  assert.match(noParent.error, /No parent model is selected/);
}

console.log("shadow-minds resolve tests: OK");
