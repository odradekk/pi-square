import assert from "node:assert/strict";
import { SCENARIOS, PRIMARY_ARM_VARIANTS, SEED_EXCHANGE, SEED_MEMORY, SEED_SESSION_CONFIG, buildScript, renderedMemoryTokensOf, workloadPrompt } from "./scenarios.mjs";
import { CONTINUITY_SESSION_CONFIG } from "./session.mjs";
assert.deepEqual(SCENARIOS.map((x) => x.id), ["exact-work", "constraint-reversal", "branch-isolation", "source-recovery"]);
assert.deepEqual(PRIMARY_ARM_VARIANTS, ["early", "middle", "late"]);
assert.equal(new Set(Array.from({ length: 12 }, (_, index) => workloadPrompt(index + 1))).size, 12);
assert.match(workloadPrompt(12), /handoff readiness/);
for (const scenario of SCENARIOS) {
  const scripts = PRIMARY_ARM_VARIANTS.map((v) => buildScript(scenario.id, v));
  for (const script of [...scripts, buildScript(scenario, "canonical")]) {
    assert.ok(script.introPrompt.length >= 40_000); assert.equal(script.artifactPath, "handoff.json");
    assert.ok(Object.hasOwn(script.setupFiles, "status.mjs"));
    assert.ok(Object.values(script.setupFiles).every((text) => !script.evidenceTokens.some((token) => text.includes(token))));
    for (const value of Object.values(script.oracle.expected)) {
      if (value !== null) assert.ok(!script.finalPrompt.includes(String(value)), "final prompt does not disclose expected values");
    }
    assert.equal((script.finalPrompt.match(/\|null/g) ?? []).length, Object.keys(script.oracle.expected).length, "every domain field is independently nullable");
    assert.deepEqual(new Set(Object.keys(script.oracle.expected)), new Set([...script.oracle.critical, ...script.oracle.continuity, ...script.oracle.unknown, ...script.oracle.constraints]));
  }
  const positions = scripts.map((s) => Math.max(s.introPrompt.indexOf("Authoritative brief:"), s.introPrompt.indexOf("Authoritative main-branch brief:"), s.introPrompt.indexOf("Original authoritative source:"), s.introPrompt.indexOf("Initial authoritative brief:")) / s.introPrompt.length);
  assert.ok(positions[0] < .2 && positions[1] > .35 && positions[1] < .65 && positions[2] > .8);
}
// The seeded pre-run Memory owns the append-versus-rebuild schedule (#325):
// it must render at exactly half the budget with a code-point total that is
// an exact multiple of four, so any non-empty model block strictly exceeds
// half and every post-seed maintenance rebuilds.
{
  assert.equal(SEED_SESSION_CONFIG.contextWindow, CONTINUITY_SESSION_CONFIG.contextWindow, "the seed arithmetic pins the session's exact window");
  assert.equal(SEED_SESSION_CONFIG.memoryBudgetPercent, CONTINUITY_SESSION_CONFIG.memoryBudgetPercent, "the seed arithmetic pins the session's exact budget percent");
  const halfBudget = Math.round((CONTINUITY_SESSION_CONFIG.contextWindow * CONTINUITY_SESSION_CONFIG.memoryBudgetPercent) / 100) / 2;
  assert.equal(SEED_MEMORY.halfBudgetTokens, halfBudget);
  assert.equal(SEED_MEMORY.renderedTokens, halfBudget, "the seed renders at exactly half the Memory budget");
  assert.equal(renderedMemoryTokensOf(SEED_MEMORY.blocks), halfBudget, "the estimator agrees with the recorded seed size");
  assert.equal((SEED_MEMORY.renderedTokens * 4) % 4, 0, "the seed's code-point total aligns to the chars/4 ceil exactly");
  assert.ok(renderedMemoryTokensOf([...SEED_MEMORY.blocks, "x"]) > halfBudget, "adding one character crosses the half budget");
  assert.equal(SEED_EXCHANGE.length, SEED_MEMORY.blockCount, "one seed block summarizes each fixture exchange");
  for (const body of SEED_MEMORY.blocks) for (const token of ["QUARTZ-71", "AMBER-NEW", "MAIN-PINE-83", "SOURCE-EMBER-47", "PROJECT-ZEBRA-71"]) {
    assert.ok(!body.includes(token), "the seed never carries an oracle-scored fact");
  }
}


console.log("context-memory continuity fixtures: ok");
