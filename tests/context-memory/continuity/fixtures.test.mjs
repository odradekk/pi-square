import assert from "node:assert/strict";
import { SCENARIOS, PRIMARY_ARM_VARIANTS, buildScript, workloadPrompt } from "./scenarios.mjs";
assert.deepEqual(SCENARIOS.map((x) => x.id), ["exact-work", "constraint-reversal", "branch-isolation", "source-recovery"]);
assert.deepEqual(PRIMARY_ARM_VARIANTS, ["early", "middle", "late"]);
assert.equal(new Set(Array.from({ length: 12 }, (_, index) => workloadPrompt(index + 1))).size, 12);
assert.match(workloadPrompt(12), /handoff readiness/);
for (const scenario of SCENARIOS) {
  const scripts = PRIMARY_ARM_VARIANTS.map((v) => buildScript(scenario.id, v));
  for (const script of [...scripts, buildScript(scenario, "canonical")]) {
    assert.ok(script.introPrompt.length >= 10_000); assert.equal(script.artifactPath, "handoff.json");
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
assert.ok(buildScript("constraint-reversal", "early").revisionPrompt); assert.ok(buildScript("branch-isolation", "early").abandonedPrompt); assert.equal(buildScript("source-recovery", "early").oracle.requireSourceRead, true);
console.log("context-memory continuity fixtures: ok");
