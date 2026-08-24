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
  // Shadow value wins over the activating parent value.
  assert.equal(resolveShadowThinkingLevel("high", "low"), "high");
  // No Shadow value falls back to the parent value unchanged.
  assert.equal(resolveShadowThinkingLevel(undefined, "low"), "low");
  assert.equal(resolveShadowThinkingLevel("off", undefined), "off");
  assert.equal(resolveShadowThinkingLevel(undefined, undefined), undefined);
  // An unsupported Shadow value never shadows a usable parent value.
  assert.equal(resolveShadowThinkingLevel("ultra", "low"), "low");
  // An unsupported parent value is dropped, not passed through.
  assert.equal(resolveShadowThinkingLevel(undefined, "turbo"), undefined);
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
  const explicit = resolveShadowModel("other/cross-model", ctx());
  assert.equal(explicit.label, "other/cross-model");
  assert.equal(explicit.error, undefined);
  assert.deepEqual(explicit.model, { provider: "other", id: "cross-model", contextWindow: 100_000 });
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
