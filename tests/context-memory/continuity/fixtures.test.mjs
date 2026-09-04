import assert from "node:assert/strict";
import { MARKER, format } from "../qualification/harness.mjs";
import {
  SCENARIOS,
  PRIMARY_ARM_VARIANTS,
  QUALIFICATION_CONFIG,
  MODEL_WINDOW,
  DUE_USAGE_TOKENS,
  SEED_BLOCKS,
  SEED_BLOCK_COUNT,
  buildScript,
  renderedMemoryTokens,
} from "./scenarios.mjs";

/**
 * Fixture contracts for the four continuity qualification scenarios (#224,
 * revised by #261): the required scenario kinds, the seeded compression
 * arithmetic that guarantees one append plus two suffix rebuilds in every
 * variant regardless of model-authored block sizes, the predeclared oracle
 * fields, the ask-versus-scored equality that makes every scored turn's
 * question ask for exactly what it scores, pattern disjointness across
 * families, and the leak detectability of every fixture-authored body. These
 * are contracts of the qualification fixtures themselves — orchestration and
 * scoring are covered by `runner.test.mjs`.
 *
 * #265 adds the fact-phrasing contracts: every scored fact accepts a
 * predeclared set of phrasings derived only from the fact's own structure and
 * established domain synonyms, and the discrimination guard — no accepting
 * phrasing of an item may match any of that item's corrupting phrasings, so
 * widening recall can never let a corrupted answer pass.
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

// ─── Seeded compression arithmetic per variant ──────────────────────

for (const scenario of SCENARIOS) {
  for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
    const script = buildScript(scenario, variant);
    const label = `${scenario.id}/${variant}`;

    // Three due submissions are scheduled in every variant; the seeded
    // half-budget arithmetic pins the controller's own decisions.
    const dueTurns = script.turns.filter((turn) => turn.fake?.submit);
    assert.equal(dueTurns.length, 3, `${label} schedules three due submissions`);

    // #261: the seed renders at EXACTLY half the budget with a code-point
    // total aligned to the chars/4 ceil, so the first due run appends and
    // every later one rebuilds — deterministically, for any model block size.
    assert.equal(script.seed.blockCount, SEED_BLOCK_COUNT, `${label} carries the two-block seed`);
    assert.equal(script.seed.blocks, SEED_BLOCKS, `${label} every variant shares the one fixture seed`);
    assert.equal(renderedMemoryTokens(script.seed.blocks), HALF_BUDGET_TOKENS,
      `${label} the seed renders at exactly half the Memory budget`);
    const seedCodePoints = format.MEMORY_SUMMARY_WRAPPER.length
      + format.MEMORY_BLOCK_SEPARATOR.length * SEED_BLOCK_COUNT
      + script.seed.blocks.reduce((sum, body) => sum + Array.from(body).length, 0);
    assert.equal(seedCodePoints % 4, 0,
      `${label} the seed's code points align to the chars/4 ceil so any non-empty added block strictly exceeds half`);
    for (const body of Object.values(script.blocks)) {
      assert.ok(renderedMemoryTokens([...script.seed.blocks, body]) > HALF_BUDGET_TOKENS,
        `${label} every scripted block over the seed crosses half budget, so the second and third due runs rebuild`);
      assert.ok(renderedMemoryTokens([...script.seed.blocks, body]) <= FULL_BUDGET_TOKENS,
        `${label} every committed Memory state fits the full Memory budget`);
    }

    // Every fixture-authored body — seed and model blocks alike — stays
    // inside the block bound and leak-detectable.
    for (const body of [...Object.values(script.blocks), ...script.seed.blocks]) {
      assert.ok(Buffer.byteLength(body, "utf8") <= 16 * 1024, `${label} block body inside the 16 KiB bound`);
      assert.ok(body.includes(MARKER), `${label} block body carries the leak marker`);
      assert.match(body, /(.)\1{63}/, `${label} block body carries a canary run for leak detection`);
    }

    // Every due turn is immediately preceded by a settle that crosses the due
    // point, so the schedule holds identically in every variant.
    for (const turn of dueTurns) {
      const index = script.turns.indexOf(turn);
      const predecessor = script.turns[index - 1];
      assert.ok(predecessor && predecessor.usageAfter === DUE_USAGE_TOKENS,
        `${label} due turn ${turn.id} follows a usage bump`);
    }

    // Turn ids are unique; probe targets exist.
    const ids = new Set(script.turns.map((turn) => turn.id));
    assert.equal(ids.size, script.turns.length, `${label} turn ids are unique`);
    for (const item of [...script.oracle.criticalItems, ...script.oracle.continuityItems]) {
      for (const probe of item.probes) {
        assert.ok(ids.has(probe), `${label} item ${item.id} probes existing turn ${probe}`);
      }
    }
    assert.ok(ids.has(script.oracle.finalTask.turn), `${label} final task targets an existing turn`);
    for (const trap of script.oracle.uncertaintyTraps) {
      for (const probe of trap.probes) assert.ok(ids.has(probe), `${label} trap ${trap.id} probes existing turn ${probe}`);
    }
    for (const expected of script.oracle.sourceToolUse) assert.ok(ids.has(expected.turn), `${label} source use targets an existing turn`);
    for (const probe of script.oracle.branch.probes) assert.ok(ids.has(probe), `${label} branch probe ${probe} exists`);
  }
}

// ─── The seed carries no fixture evidence of its own ────────────────

{
  for (const scenario of SCENARIOS) {
    for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
      const { oracle } = buildScript(scenario, variant);
      const label = `${scenario.id}/${variant}`;
      const scoredOrFailureTokens = [
        ...oracle.criticalItems.flatMap((item) => [...item.requires, ...(item.corruptsWith ?? [])]),
        ...oracle.continuityItems.flatMap((item) => item.requires),
        ...oracle.forbiddenClaims.flatMap((claim) => claim.patterns),
        ...oracle.negativeConstraints.flatMap((constraint) => constraint.claims),
        ...oracle.branch.abandoned.flatMap((entry) => entry.patterns),
        ...oracle.uncertaintyTraps.flatMap((trap) => trap.promote),
        ...oracle.finalTask.requires.flat(),
      ];
      for (const token of scoredOrFailureTokens) {
        assert.ok(
          !SEED_BLOCKS.some((body) => body.toLowerCase().includes(token.toLowerCase())),
          `${label}: the seeded Memory carries no scored or failure token (${token.replace(MARKER, "‹marker›")})`,
        );
      }
    }
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
      assert.ok(trap.promote.length > 0, `${label} trap ${trap.id} declares promote markers`);
      assert.ok(typeof trap.subject === "string" && trap.subject.length > 0,
        `${label} trap ${trap.id} declares the subject its question asks about`);
      assert.equal(trap.refuse, undefined,
        `${label} trap ${trap.id} declares no refuse list — a trap passes when nothing is promoted, whatever the phrasing (#261)`);
    }
    assert.ok(Array.isArray(oracle.branch.abandoned), `${label} declares branch visibility`);
    assert.ok(Array.isArray(oracle.sourceToolUse), `${label} declares expected source-tool use`);
    assert.ok(oracle.finalTask.requires.length > 0, `${label} predeclares final task success criteria`);
  }
}

// ─── Fact phrasing sets and the discrimination guard (#265) ────────

// The alternate phrasings each phrasal fact must accept, by item id. Each is
// derived from the fact's own structure or an established domain synonym —
// never from any run transcript, report, or provider call — and every one is
// checked below to reject its item's entire corruption vocabulary.
const REQUIRED_ALTERNATES = new Map([
  ["batch-size", ["batch size of 384", "384-row"]],
  ["lock-timeout", ["750 milliseconds", "750-ms"]],
  ["rounding-rule", ["ties to even"]],
  ["jpy-exponent", ["exponent of 0", "exponent is 0"]],
  ["partition-count", ["partition count of 16", "16-partition"]],
  ["amount-units", ["integers in minor units"]],
  ["integer-path", ["integers in minor units"]],
  ["backing-store", ["backed by Redis"]],
  ["rotation-cadence", ["21-day"]],
  ["followup-owner", ["on-call for storage"]],
]);

// Facts that are single exact tokens or bare proper-noun phrases: no
// structure exists to invert or reorder, and any loosening would trade the
// subject or the identifier away, so their accepting set stays singular.
const SINGLE_PHRASING_ITEMS = new Set([
  "idempotency-prefix",
  "flag-timeline",
  "ledger-owner",
  "rule-record",
  "signoff",
  "serial-allocator",
  "queue-owner",
  "incident-code",
  "tracking-ticket",
]);

{
  for (const scenario of SCENARIOS) {
    for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
      const { oracle } = buildScript(scenario, variant);
      const label = `${scenario.id}/${variant}`;
      const items = [...oracle.criticalItems, ...oracle.continuityItems];

      for (const item of items) {
        for (const pattern of item.requires) {
          assert.equal(typeof pattern, "string", `${label} item ${item.id} accepts only string phrasings`);
          assert.ok(pattern.length > 0, `${label} item ${item.id} accepts no empty phrasing`);
        }
        if (REQUIRED_ALTERNATES.has(item.id)) {
          for (const alternate of REQUIRED_ALTERNATES.get(item.id)) {
            assert.ok(item.requires.includes(alternate),
              `${label} item ${item.id} accepts the derived phrasing "${alternate.replace(MARKER, "‹marker›")}"`);
          }
          assert.ok(item.requires.length > 1, `${label} item ${item.id} accepts a set of phrasings, not one`);
        }
        if (SINGLE_PHRASING_ITEMS.has(item.id)) {
          assert.equal(item.requires.length, 1,
            `${label} token item ${item.id} keeps its single exact phrasing — no alternate is derivable without ambiguity`);
        }
        // The discrimination guard: a corrupt answer contains a corrupting
        // phrasing, so any accepting phrasing that is a substring of one
        // would let that corruption score as recalled.
        for (const pattern of item.requires) {
          for (const corrupt of item.corruptsWith ?? []) {
            assert.ok(
              !corrupt.toLowerCase().includes(pattern.toLowerCase()),
              `${label} item ${item.id}: accepting phrasing "${pattern.replace(MARKER, "‹marker›")}" must not match the corrupting phrasing "${corrupt.replace(MARKER, "‹marker›")}"`,
            );
          }
        }
      }

      // The final task is judged on the same footing as a probe: each of its
      // required facts is one item's exact accepting set — never a narrower
      // or wider phrasing list than the probes use for the same fact.
      for (const phrasings of oracle.finalTask.requires) {
        assert.ok(Array.isArray(phrasings) && phrasings.length > 0,
          `${label} final task facts are non-empty phrasing sets`);
        for (const pattern of phrasings) {
          assert.equal(typeof pattern, "string", `${label} final task phrasings are strings`);
          assert.ok(pattern.length > 0, `${label} final task phrasings are non-empty`);
        }
        assert.ok(
          items.some((item) => JSON.stringify(item.requires) === JSON.stringify(phrasings)),
          `${label} every final-task fact is judged by an oracle item's exact accepting set`,
        );
      }
    }
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

// The recovery variant decides when the recoverable value enters the
// conversation; with the two seeded blocks (#261) it always lands inside the
// one model-authored block — block 3 — because every rebuild replaces that
// block and extends its source range to the due turn.
{
  const scenario = SCENARIOS.find((s) => s.id === "source-recovery");
  for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
    const script = buildScript(scenario, variant);
    assert.equal(script.oracle.sourceToolUse[0].block, 3,
      `${variant} establishment lands in the model-authored block after the two seeded blocks`);
    const finalTurn = script.turns.find((turn) => turn.id === "t11-final");
    assert.equal(finalTurn.fake.sourceRead.block, script.oracle.sourceToolUse[0].block,
      `${variant} the scripted read targets the oracle's expected block`);
  }
  const noMemoryBodyHasIt = [...PRIMARY_ARM_VARIANTS, "canonical"]
    .map((variant) => buildScript(scenario, variant))
    .every((script) => [...Object.values(script.blocks), ...SEED_BLOCKS].every((body) => !body.includes("INC-4477")));
  assert.ok(noMemoryBodyHasIt, "no scripted or seeded Memory body carries the exact incident code");
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

// ─── Ask-versus-scored equality (#261: score only what the question asks) ──

{
  for (const scenario of SCENARIOS) {
    for (const variant of [...PRIMARY_ARM_VARIANTS, "canonical"]) {
      const script = buildScript(scenario, variant);
      const label = `${scenario.id}/${variant}`;
      const knownIds = new Set([...script.oracle.criticalItems, ...script.oracle.continuityItems].map((item) => item.id));

      const scoredAt = new Map();
      for (const item of [...script.oracle.criticalItems, ...script.oracle.continuityItems]) {
        for (const probe of item.probes) {
          if (!scoredAt.has(probe)) scoredAt.set(probe, new Set());
          scoredAt.get(probe).add(item.id);
        }
      }

      // Every probe and final turn is scored by at least one item; every
      // scored turn declares `asks`; and the declared asks are exactly the
      // items scored there — no more, no less.
      for (const turn of script.turns) {
        const scored = scoredAt.get(turn.id);
        if (turn.kind === "probe" || turn.kind === "final") {
          assert.ok(scored, `${label} ${turn.id} is a probe or final turn and is scored by at least one item`);
        } else {
          assert.equal(turn.asks, undefined, `${label} ${turn.id} is unscored and declares no asks`);
        }
        if (scored) {
          assert.ok(Array.isArray(turn.asks) && turn.asks.length > 0, `${label} scored turn ${turn.id} declares what it asks`);
          assert.deepEqual([...new Set(turn.asks)].sort(), [...scored].sort(),
            `${label} turn ${turn.id} asks for exactly the items the oracle scores there`);
          for (const id of turn.asks) assert.ok(knownIds.has(id), `${label} turn ${turn.id} asks for the known item ${id}`);
        } else if (turn.asks) {
          assert.fail(`${label} turn ${turn.id} declares asks but nothing is scored there`);
        }
      }
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
    "middle-variant critical probes sit after introduction and across the rebuilds",
  );
  assert.deepEqual(
    late.oracle.criticalItems[0].probes,
    ["t9c-probe", "t11-final"],
    "late-variant critical probes exist only after introduction",
  );
}

console.log("continuity fixtures: all checks passed");
