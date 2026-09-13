import assert from "node:assert/strict";
import { PLACEMENTS, SCENARIOS, buildScript } from "./scenarios.mjs";
import { scoreRun, evaluateGates } from "./oracles.mjs";

const verified = { ok: true, failures: [], appends: 1, rebuilds: 2 };
function scoreArtifact(scenario = "exact-work", placement = "early", lane = "sonnet", artifactText) {
  const script = buildScript(scenario, placement);
  return scoreRun({
    run: { scenario, placement, lane }, script,
    artifactText: artifactText ?? JSON.stringify(script.oracle.expected),
    integrity: verified, coverage: verified,
    retrievalQualification: { qualified: true, code: "qualified-search-snippet" },
  });
}

const passingMatrix = ["sonnet", "glm"].flatMap((lane) =>
  SCENARIOS.flatMap(({ id }) => PLACEMENTS.map((placement) => scoreArtifact(id, placement, lane))));
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
    assert.equal(scoreArtifact("exact-work", "early", "sonnet", artifact).result, "fail");
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
  tolerated[0] = scoreArtifact("exact-work", "early", "sonnet", JSON.stringify({ ...expected, owner: null }));
  assert.equal(tolerated[0].finalTask, false);
  assert.equal(evaluateGates(tolerated).result, "pass");

  const canonicalMiss = [...passingMatrix];
  canonicalMiss[1] = scoreArtifact("exact-work", "middle", "sonnet", JSON.stringify({ ...expected, owner: null }));
  assert.equal(evaluateGates(canonicalMiss).result, "fail");

  const belowScenarioFloor = [...tolerated];
  belowScenarioFloor[2] = scoreArtifact("exact-work", "late", "sonnet", JSON.stringify({ ...expected, owner: null, mode: null }));
  belowScenarioFloor[12] = scoreArtifact("exact-work", "early", "glm", JSON.stringify({ ...expected, mode: null }));
  assert.equal(evaluateGates(belowScenarioFloor).result, "fail");
}

// Missing pages and severe signals cannot be hidden by otherwise correct files.
{
  const script = buildScript("source-recovery", "early");
  const incomplete = scoreRun({
    run: { scenario: script.id, placement: "early", lane: "sonnet" }, script,
    artifactText: JSON.stringify(script.oracle.expected), integrity: verified, coverage: verified,
    retrievalQualification: { qualified: false, code: "source-evidence-incomplete" },
  });
  assert.equal(incomplete.result, "fail");
  const severe = [...passingMatrix];
  severe[0] = { ...severe[0], severe: { ...severe[0].severe, fabrication: 1 } };
  assert.equal(evaluateGates(severe).result, "fail");
}

console.log("context-memory continuity oracles: OK");
