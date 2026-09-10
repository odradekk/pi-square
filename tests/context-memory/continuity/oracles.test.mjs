import assert from "node:assert/strict";
import { SCENARIOS, PRIMARY_ARM_VARIANTS, buildScript } from "./scenarios.mjs";
import { scoreRun, evaluateGates } from "./oracles.mjs";

const verified = { ok: true, failures: [] };

function scoreArtifact(scenario = "exact-work", variant = "early", arm = "primary", artifactText) {
  const script = buildScript(scenario, variant);
  return scoreRun({
    run: { scenario, variant, arm }, script,
    artifactText: artifactText ?? JSON.stringify(script.oracle.expected),
    integrity: verified, coverage: verified,
    sourceReads: script.oracle.requireSourceRead ? [{ ok: true, complete: true, coversSource: true }] : [],
  });
}

const passingMatrix = SCENARIOS.flatMap(({ id }) => [
  ...PRIMARY_ARM_VARIANTS.map((variant) => scoreArtifact(id, variant)),
  scoreArtifact(id, "canonical", "secondary"),
]);
assert.equal(evaluateGates(passingMatrix).result, "pass");

// Exact types and values, not substrings or a valid fragment in invalid JSON.
{
  const script = buildScript("exact-work", "early");
  for (const artifact of [
    "not JSON",
    '{"project":"QUARTZ-71","project":"bad"}',
    JSON.stringify({ ...script.oracle.expected, project: "QUARTZ-71 or something else" }),
    JSON.stringify({ ...script.oracle.expected, batch_ceiling: "347" }),
    JSON.stringify({ ...script.oracle.expected, deployment_region: "guessed-region" }),
    JSON.stringify({ ...script.oracle.expected, extra: true }),
  ]) {
    assert.equal(scoreArtifact("exact-work", "early", "primary", artifact).result, "fail");
  }
  const absent = scoreRun({ run: {}, script, artifactText: JSON.stringify(script.oracle.expected) });
  assert.equal(absent.result, "inconclusive", "correct answers without coverage cannot pass");
}

// Exactly one of each registered matrix cell is required.
{
  assert.equal(evaluateGates(passingMatrix.slice(1)).result, "inconclusive");
  const duplicate = [...passingMatrix];
  duplicate[1] = duplicate[0];
  assert.equal(evaluateGates(duplicate).result, "inconclusive");
  const unknown = [...passingMatrix];
  unknown[0] = { ...unknown[0], run: { ...unknown[0].run, scenario: "invented" } };
  assert.equal(evaluateGates(unknown).result, "inconclusive");
}

// Noncanonical supporting-field misses may stay within the published gates;
// canonical final tasks and the per-scenario floor still bind independently.
{
  const expected = buildScript("exact-work", "early").oracle.expected;
  const tolerated = [...passingMatrix];
  tolerated[0] = scoreArtifact("exact-work", "early", "primary", JSON.stringify({ ...expected, owner: null }));
  assert.equal(tolerated[0].finalTask, false);
  assert.equal(evaluateGates(tolerated).result, "pass");

  const canonicalMiss = [...passingMatrix];
  canonicalMiss[1] = scoreArtifact("exact-work", "middle", "primary", JSON.stringify({ ...expected, owner: null }));
  assert.equal(evaluateGates(canonicalMiss).result, "fail");

  const belowScenarioFloor = [...tolerated];
  belowScenarioFloor[2] = scoreArtifact("exact-work", "late", "primary", JSON.stringify({ ...expected, owner: null, mode: null }));
  assert.equal(evaluateGates(belowScenarioFloor).result, "fail");
}

// Missing pages and severe signals cannot be hidden by otherwise correct files.
{
  const script = buildScript("source-recovery", "early");
  const incomplete = scoreRun({
    run: { scenario: script.id, variant: "early", arm: "primary" }, script,
    artifactText: JSON.stringify(script.oracle.expected), integrity: verified, coverage: verified,
    sourceReads: [{ ok: true, complete: false, coversSource: true }],
  });
  assert.equal(incomplete.result, "fail");
  const severe = [...passingMatrix];
  severe[0] = { ...severe[0], severe: { ...severe[0].severe, fabrication: 1 } };
  assert.equal(evaluateGates(severe).result, "fail");
}

console.log("context-memory continuity oracles: OK");
