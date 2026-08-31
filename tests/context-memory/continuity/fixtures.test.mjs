import assert from "node:assert/strict";
import { MARKER } from "../qualification/harness.mjs";
import {
  SCENARIOS,
  PRIMARY_ARM_VARIANTS,
  QUALIFICATION_CONFIG,
  MODEL_WINDOW,
  DUE_USAGE_TOKENS,
  buildScript,
  renderedMemoryTokens,
} from "./scenarios.mjs";

/**
 * Fixture contracts for the four continuity qualification scenarios (#224):
 * the required scenario kinds, the compression arithmetic that guarantees
 * two appends plus one suffix rebuild in every variant, the predeclared
 * oracle fields, pattern disjointness across families, and the leak
 * detectability of every fixture-authored body. These are contracts of the
 * qualification fixtures themselves — orchestration and scoring are covered
 * by `runner.test.mjs`.
 */

const HALF_BUDGET_TOKENS = Math.round((MODEL_WINDOW * QUALIFICATION_CONFIG.memoryBudgetPercent) / 100) / 2;
const FULL_BUDGET_TOKENS = Math.round((MODEL_WINDOW * QUALIFICATION_CONFIG.memoryBudgetPercent) / 100);

const REQUIRED_SCENARIOS = new Map([
  ["exact-work", "exact-work continuity"],
  ["constraint-reversal", "constraint reversal"],
  ["branch-isolation", "branch isolation"],
  ["source-recovery", "source-recovery/rebuild"],
]);

// ─── Scenario registry ─────────────────────────────────────────────

{
  assert.equal(SCENARIOS.length, 4, "exactly the four required scenarios");
  for (const scenario of SCENARIOS) {
    assert.equal(REQUIRED_SCENARIOS.get(scenario.id), scenario.requirement, `${scenario.id} carries its required kind`);
    assert.deepEqual(scenario.variants, PRIMARY_ARM_VARIANTS, `${scenario.id} supports the early/middle/late primary variants`);
    assert.ok(PRIMARY_ARM_VARIANTS.includes(scenario.canonicalVariant), `${scenario.id} canonical variant is a declared variant`);
    assert.equal(typeof scenario.title, "string");
    assert.equal(typeof scenario.summary, "string");
  }
}

// ─── Compression schedule arithmetic per variant ───────────────────

for (const scenario of SCENARIOS) {
  for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
    const script = buildScript(scenario, variant);

    // Two appends and one suffix rebuild are scheduled in every variant: the
    // half/full budget arithmetic pins the controller's own decision.
    const dueTurns = script.turns.filter((turn) => turn.fake?.submit);
    assert.equal(dueTurns.length, 3, `${scenario.id}/${variant} schedules three due submissions`);
    assert.ok(renderedMemoryTokens([script.blocks.b1]) <= HALF_BUDGET_TOKENS,
      `${scenario.id}/${variant} block 1 alone fits the half budget so the second due run appends`);
    assert.ok(renderedMemoryTokens([script.blocks.b1, script.blocks.b2]) > HALF_BUDGET_TOKENS,
      `${scenario.id}/${variant} blocks 1+2 cross the half budget so the third due run rebuilds`);
    assert.ok(renderedMemoryTokens([script.blocks.b1, script.blocks.b3]) <= FULL_BUDGET_TOKENS,
      `${scenario.id}/${variant} the rebuilt pair fits the full Memory budget`);
    for (const body of Object.values(script.blocks)) {
      assert.ok(Buffer.byteLength(body, "utf8") <= 16 * 1024, `${scenario.id}/${variant} block body inside the 16 KiB bound`);
      assert.ok(body.includes(MARKER), `${scenario.id}/${variant} block body carries the leak marker`);
      assert.match(body, /(.)\1{63}/, `${scenario.id}/${variant} block body carries a canary run for leak detection`);
    }

    // Every due turn is immediately preceded by a settle that crosses the due
    // point, so the schedule holds identically in every variant.
    for (const turn of dueTurns) {
      const index = script.turns.indexOf(turn);
      const predecessor = script.turns[index - 1];
      assert.ok(predecessor && predecessor.usageAfter === DUE_USAGE_TOKENS,
        `${scenario.id}/${variant} due turn ${turn.id} follows a usage bump`);
    }

    // Turn ids are unique; probe targets exist.
    const ids = new Set(script.turns.map((turn) => turn.id));
    assert.equal(ids.size, script.turns.length, `${scenario.id}/${variant} turn ids are unique`);
    for (const item of [...script.oracle.criticalItems, ...script.oracle.continuityItems]) {
      for (const probe of item.probes) {
        assert.ok(ids.has(probe), `${scenario.id}/${variant} item ${item.id} probes existing turn ${probe}`);
      }
    }
    assert.ok(ids.has(script.oracle.finalTask.turn), `${scenario.id}/${variant} final task targets an existing turn`);
    for (const trap of script.oracle.uncertaintyTraps) {
      for (const probe of trap.probes) assert.ok(ids.has(probe), `${scenario.id}/${variant} trap ${trap.id} probes an existing turn`);
    }
    for (const expected of script.oracle.sourceToolUse) assert.ok(ids.has(expected.turn), `${scenario.id}/${variant} source use targets an existing turn`);
    for (const probe of script.oracle.branch.probes) assert.ok(ids.has(probe), `${scenario.id}/${variant} branch probe ${probe} exists`);
  }
}

// ─── Oracle predeclaration ─────────────────────────────────────────

for (const scenario of SCENARIOS) {
  for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
    const { oracle } = buildScript(scenario, variant);
    const label = `${scenario.id}/${variant}`;

    assert.ok(oracle.criticalItems.length >= 2, `${label} predeclares at least two critical items`);
    assert.ok(oracle.continuityItems.length >= 2, `${label} predeclares at least two continuity items`);
    for (const item of oracle.criticalItems) {
      assert.ok(item.requires.length > 0, `${label} critical ${item.id} declares requires patterns`);
      assert.ok((item.corruptsWith ?? []).length > 0, `${label} critical ${item.id} declares corruption aliases`);
      assert.ok(item.probes.length > 0);
    }
    assert.ok((oracle.forbiddenClaims ?? []).length >= 1, `${label} predeclares forbidden claims`);
    assert.ok((oracle.negativeConstraints ?? []).length >= 1, `${label} predeclares a negative constraint`);
    for (const constraint of oracle.negativeConstraints) {
      assert.ok((constraint.claims ?? []).length >= 1, `${label} constraint ${constraint.id} carries claim patterns`);
      assert.ok((constraint.actions ?? []).length >= 1, `${label} constraint ${constraint.id} carries a forbidden action`);
      for (const action of constraint.actions) {
        assert.ok(action.tool && action.turns.length > 0, `${label} constraint ${constraint.id} action names a tool and watch turns`);
      }
    }
    assert.ok((oracle.uncertaintyTraps ?? []).length >= 1, `${label} predeclares an uncertainty trap`);
    for (const trap of oracle.uncertaintyTraps) {
      assert.ok(trap.promote.length > 0 && trap.refuse.length > 0, `${label} trap ${trap.id} declares promote and refuse markers`);
    }
    assert.ok(Array.isArray(oracle.branch.abandoned), `${label} declares branch visibility`);
    assert.ok(Array.isArray(oracle.sourceToolUse), `${label} declares expected source-tool use`);
    assert.ok(oracle.finalTask.requires.length > 0, `${label} predeclares final task success criteria`);
  }
}

// Branch visibility belongs to the branch scenario; source-tool use to the
// recovery scenario — the fixtures stay complementary, not duplicated.
{
  const branch = buildScript(SCENARIOS.find((s) => s.id === "branch-isolation"), "middle");
  assert.ok(branch.oracle.branch.abandoned.length >= 2, "the branch scenario predeclares abandoned facts");
  assert.equal(branch.oracle.sourceToolUse.length, 0);
  for (const other of ["exact-work", "constraint-reversal", "source-recovery"]) {
    const script = buildScript(SCENARIOS.find((s) => s.id === other), "middle");
    assert.equal(script.oracle.branch.abandoned.length, 0, `${other} declares no abandoned facts`);
  }
  const recovery = buildScript(SCENARIOS.find((s) => s.id === "source-recovery"), "middle");
  assert.equal(recovery.oracle.sourceToolUse.length, 1, "the recovery scenario expects exactly one source read");
  assert.equal(recovery.oracle.sourceToolUse[0].turn, "t11-final", "the expected source read belongs to the final task");
  for (const other of ["exact-work", "constraint-reversal", "branch-isolation"]) {
    const script = buildScript(SCENARIOS.find((s) => s.id === other), "middle");
    assert.equal(script.oracle.sourceToolUse.length, 0, `${other} expects no source read`);
  }
}

// The recovery variant decides which Memory block holds the recoverable
// value, so the expected read target moves with it.
{
  const scenario = SCENARIOS.find((s) => s.id === "source-recovery");
  assert.equal(buildScript(scenario, "early").oracle.sourceToolUse[0].block, 1, "early establishment lands in block 1");
  assert.equal(buildScript(scenario, "middle").oracle.sourceToolUse[0].block, 2, "middle establishment lands in block 2");
  assert.equal(buildScript(scenario, "late").oracle.sourceToolUse[0].block, 2, "late establishment lands in the rebuilt block 2");
  const noMemoryBodyHasIt = [buildScript(scenario, "early"), buildScript(scenario, "middle"), buildScript(scenario, "late")]
    .every((script) => Object.values(script.blocks).every((body) => !body.includes("INC-4477")));
  assert.ok(noMemoryBodyHasIt, "no scripted Memory body carries the exact incident code");
}

// ─── Pattern disjointness across oracle families ───────────────────

{
  const families = (oracle) => [
    ...oracle.forbiddenClaims.flatMap((claim) => claim.patterns),
    ...oracle.negativeConstraints.flatMap((constraint) => constraint.claims),
    ...oracle.branch.abandoned.flatMap((entry) => entry.patterns),
    ...oracle.uncertaintyTraps.flatMap((trap) => trap.promote),
    ...oracle.criticalItems.flatMap((item) => item.corruptsWith),
  ];
  for (const scenario of SCENARIOS) {
    for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
      const { oracle } = buildScript(scenario, variant);
      const all = families(oracle);
      assert.equal(new Set(all).size, all.length,
        `${scenario.id}/${variant}: every forbidden/promote/corruption pattern belongs to exactly one failure family`);
    }
  }
}

// ─── Critical-evidence placement differs per variant ───────────────

{
  const scenario = SCENARIOS.find((s) => s.id === "exact-work");
  const early = buildScript(scenario, "early");
  const middle = buildScript(scenario, "middle");
  const late = buildScript(scenario, "late");

  const firstUserText = (script) => script.turns[0].user;
  assert.ok(firstUserText(early).includes("idempotency key prefix"), "the early variant establishes critical evidence before the first compression");
  assert.ok(!firstUserText(middle).includes("idempotency key prefix"), "the middle variant does not");
  assert.ok(!firstUserText(late).includes("idempotency key prefix"), "the late variant does not");
  assert.ok(late.turns.some((turn) => turn.id === "t9b-spec"), "the late variant introduces critical evidence after the rebuild");
  assert.deepEqual(
    middle.oracle.criticalItems[0].probes,
    ["t6-probe", "t9-probe", "t11-final"],
    "middle-variant critical probes sit after introduction and across the rebuild",
  );
  assert.deepEqual(
    late.oracle.criticalItems[0].probes,
    ["t9c-probe", "t11-final"],
    "late-variant critical probes exist only after introduction",
  );
}

console.log("continuity fixtures: all checks passed");
