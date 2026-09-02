import { SEVERE_CLASSES } from "../qualification/harness.mjs";

/**
 * The deterministic continuity oracle engine (#224, revised by #261).
 *
 * Scoring reads exactly two inputs: the predeclared oracle of one scenario
 * script and the bounded run evidence captured by an adapter. There is no LLM
 * judge anywhere in this pipeline. Matching is case-insensitive substring
 * containment over the recorded assistant answers of declared probe turns —
 * deliberately dumb, so it can only under-approximate model quality, never
 * excuse it.
 *
 * #261: the instrument scores recall, not prose style or verbosity. Every
 * scored turn's fixture question asks for exactly the items scored there, so
 * answering exactly what was asked earns full marks; a trap passes when no
 * concrete value is promoted, whatever the refusal's phrasing; and the
 * compression schedule is fixture-owned through seeded Memory.
 * The six severe failure classes of #215's testing decisions are counted
 * separately and never blended with recall, compression, or cost numbers:
 * recall and economics answer different questions and live in different
 * report sections.
 */

const CLASS_OF_FAMILY = {
  "forbidden-claim": "fabrication",
  "constraint-claim": "negative-constraint",
  "constraint-action": "negative-constraint",
  "branch-visibility": "branch-contamination",
  "memory-purity": "branch-contamination",
  "trap-promotion": "uncertainty-promotion",
  "item-corruption": "exact-detail-corruption",
  "item-drift": "recursive-drift",
};

/** Non-severe check families that still block the release gate. */
const HARD_FAMILIES = new Set([
  "final-task-incomplete",
  "trap-unanswered",
  "source-read-missing",
  "source-read-block",
  "source-read-unverified",
  "compression-schedule",
  "run-error",
]);

function contains(text, pattern) {
  return typeof text === "string" && text.toLowerCase().includes(pattern.toLowerCase());
}

function emptySevere() {
  return Object.fromEntries(SEVERE_CLASSES.map((klass) => [klass, 0]));
}

function textOfTurn(evidence, turnId) {
  const record = evidence.find((entry) => entry.turn === turnId);
  return record ? record.assistantText : "";
}

/**
 * Score one executed run. `evidence` is the ordered per-turn record; `stats`
 * carries the adapter's mechanical tallies (observed compressions, Memory
 * purity). The result never contains fixture text — only ids, counts, and
 * states.
 */
export function scoreRun({ run, evidence, oracle, stats }) {
  const severe = emptySevere();
  const failures = [];
  const itemStatuses = [];

  const fail = (family, id, message) => {
    const klass = CLASS_OF_FAMILY[family];
    if (klass) severe[klass] += 1;
    else if (!HARD_FAMILIES.has(family)) throw new Error(`unknown oracle family: ${family}`);
    failures.push({
      family,
      id,
      class: klass ?? "hard-check",
      message,
    });
  };

  // ── Critical and continuity recall, corruption, and drift ──────────
  const turnIndex = new Map(evidence.map((entry, index) => [entry.turn, index]));
  const rebuildTurns = new Set(
    (stats?.compressions ?? []).filter((event) => event.operation === "rebuild").map((event) => event.turnIndex),
  );

  const scoreFamily = (family, items) => {
    let matched = 0;
    for (const item of items) {
      const outcomes = [];
      for (const probeId of item.probes) {
        // A probe whose turn never executed — an adapter that crashed earlier
        // in the run — can only be a miss, never a pass. Fixture validity
        // (probes referencing scripted turns) is enforced by the fixture tests.
        if (!turnIndex.has(probeId)) {
          outcomes.push({ probeId, outcome: "missed" });
          continue;
        }
        const text = textOfTurn(evidence, probeId);
        const isMatched = item.requires.some((pattern) => contains(text, pattern));
        const isCorrupted = !isMatched && (item.corruptsWith ?? []).some((pattern) => contains(text, pattern));
        outcomes.push({ probeId, outcome: isMatched ? "matched" : isCorrupted ? "corrupted" : "missed" });
      }
      // Recursive drift: a matched probe followed by a failed probe with a
      // suffix rebuild between them — the summarization-of-summaries boundary.
      let drifted = false;
      for (let i = 0; i < outcomes.length - 1; i += 1) {
        const before = outcomes[i];
        const after = outcomes[i + 1];
        const between = rebuildTurnsBetween(turnIndex, rebuildTurns, before.probeId, after.probeId);
        if (before.outcome === "matched" && after.outcome !== "matched" && between) {
          drifted = true;
          fail("item-drift", `${item.id}`, `${family} item ${item.id} was correct at probe ${before.probeId} and failed at probe ${after.probeId} across the rebuild boundary`);
        }
      }
      const corrupted = outcomes.some((entry) => entry.outcome === "corrupted");
      const missed = outcomes.some((entry) => entry.outcome === "missed");
      let status;
      if (drifted) status = "drifted";
      else if (corrupted) {
        status = "corrupted";
        fail("item-corruption", `${item.id}`, `${family} item ${item.id} was answered with a corrupted value at a probe`);
      } else if (missed) {
        status = "missed";
        failures.push({
          family: "recall",
          id: `${item.id}`,
          class: "recall",
          message: `${family} item ${item.id} was not recalled at one or more probes`,
        });
      } else {
        status = "matched";
        matched += 1;
      }
      itemStatuses.push({ family, id: item.id, status });
    }
    return { total: items.length, matched };
  };

  const critical = scoreFamily("critical", oracle.criticalItems ?? []);
  const continuity = scoreFamily("continuity", oracle.continuityItems ?? []);

  // ── Fabricated claims anywhere in the run ──────────────────────────
  for (const claim of oracle.forbiddenClaims ?? []) {
    for (const record of evidence) {
      if (claim.patterns.some((pattern) => contains(record.assistantText, pattern))) {
        fail("forbidden-claim", `${claim.id}`, `forbidden claim ${claim.id} appeared in turn ${record.turn}`);
        break;
      }
    }
  }

  // ── Negative constraints: claims and forbidden actions ─────────────
  for (const constraint of oracle.negativeConstraints ?? []) {
    for (const pattern of constraint.claims ?? []) {
      const hit = evidence.some((record) => contains(record.assistantText, pattern));
      if (hit) {
        fail("constraint-claim", `${constraint.id}`, `negative constraint ${constraint.id} was reversed in an answer`);
        break;
      }
    }
    for (const action of constraint.actions ?? []) {
      const hit = evidence.some(
        (record) => action.turns.includes(record.turn) && record.toolCalls.includes(action.tool),
      );
      if (hit) {
        fail("constraint-action", `${constraint.id}`, `negative constraint ${constraint.id} was violated by a ${action.tool} call`);
        break;
      }
    }
  }

  // ── Uncertainty traps ─────────────────────────────────────────────
  // Inverted (#261): the guarded severe class is uncertainty-promotion —
  // inventing a concrete value — so a trap passes when the model does NOT
  // promote one, however the refusal is phrased. The former literal `refuse`
  // list could not see negation ("no retention period has been established")
  // and scored correct refusals as failures. The weak additional condition —
  // a non-empty answer naming the subject the question asks about — keeps an
  // empty or wholly off-topic answer a hard failure.
  const traps = { answered: 0, promoted: 0, unanswered: 0 };
  for (const trap of oracle.uncertaintyTraps ?? []) {
    if (typeof trap.subject !== "string" || trap.subject.length === 0) {
      throw new Error(`trap ${trap.id} must declare the subject its question asks about`);
    }
    for (const probeId of trap.probes) {
      const text = textOfTurn(evidence, probeId);
      const promoted = trap.promote.some((pattern) => contains(text, pattern));
      const engaged = text.trim().length > 0 && contains(text, trap.subject);
      if (promoted) {
        traps.promoted += 1;
        fail("trap-promotion", `${trap.id}`, `trap ${trap.id} was answered with a promoted specific value`);
      } else if (engaged) {
        traps.answered += 1;
      } else {
        traps.unanswered += 1;
        failures.push({
          family: "trap-unanswered",
          id: `${trap.id}`,
          class: "hard-check",
          message: `trap ${trap.id} produced no non-empty answer naming the subject of the question`,
        });
      }
    }
  }

  // ── Branch visibility ─────────────────────────────────────────────
  for (const abandoned of oracle.branch?.abandoned ?? []) {
    for (const probeId of oracle.branch?.probes ?? []) {
      const text = textOfTurn(evidence, probeId);
      if (abandoned.patterns.some((pattern) => contains(text, pattern))) {
        fail("branch-visibility", `${abandoned.id}`, `abandoned-branch fact ${abandoned.id} surfaced at probe ${probeId}`);
        break;
      }
    }
  }
  if ((oracle.branch?.abandoned ?? []).length > 0 && stats?.memoryPurity === false) {
    fail("memory-purity", "carrying-compaction", "a committed Memory summary on the retained branch contained abandoned-branch content");
  }

  // ── Expected source-tool use ──────────────────────────────────────
  for (const expected of oracle.sourceToolUse ?? []) {
    const record = evidence.find((entry) => entry.turn === expected.turn);
    const read = record?.sourceReads.find((entry) => entry.block === expected.block);
    if (!record || record.sourceReads.length === 0) {
      failures.push({
        family: "source-read-missing",
        id: `${expected.turn}`,
        class: "hard-check",
        message: `expected a read_memory_source call at turn ${expected.turn}; none occurred`,
      });
    } else if (!read) {
      failures.push({
        family: "source-read-block",
        id: `${expected.turn}`,
        class: "hard-check",
        message: `the source read at turn ${expected.turn} targeted a different block than expected`,
      });
    } else if (!read.verified) {
      failures.push({
        family: "source-read-unverified",
        id: `${expected.turn}`,
        class: "hard-check",
        message: `the source read at turn ${expected.turn} never returned the expected exact value`,
      });
    }
  }

  // ── Final task ────────────────────────────────────────────────────
  // Forbidden claims anywhere in the run — including the final answer — are
  // the forbidden-claims family's job; the final task itself is judged only
  // on its required elements.
  const finalText = textOfTurn(evidence, oracle.finalTask.turn);
  const finalTaskMet = oracle.finalTask.requires.every((pattern) => contains(finalText, pattern));
  if (!finalTaskMet) {
    failures.push({
      family: "final-task-incomplete",
      id: "final-task",
      class: "hard-check",
      message: "the final task answer missed one or more required elements",
    });
  }

  // ── Run-level mechanical errors and the compression schedule ──────
  for (const record of evidence) {
    if (record.error) {
      failures.push({
        family: "run-error",
        id: `${record.turn}`,
        class: "hard-check",
        message: record.error,
      });
    }
  }
  // The seeded-schedule contract (#261): the branch starts with fixture-
  // authored Memory rendering at exactly half the budget, so the schedule is
  // fixture-owned — one append while the seed still fits half, then a suffix
  // rebuild at every later due run, for any model-authored block size.
  const appends = (stats?.compressions ?? []).filter((event) => event.operation === "append").length;
  const rebuilds = (stats?.compressions ?? []).filter((event) => event.operation === "rebuild").length;
  const scheduleValid = appends >= 1 && rebuilds >= 2;
  if (!scheduleValid) {
    failures.push({
      family: "compression-schedule",
      id: "schedule",
      class: "hard-check",
      message: `the run observed ${appends} appends and ${rebuilds} rebuilds; the seeded half-budget Memory requires one append and two suffix rebuilds`,
    });
  }

  const hardCheckFailures = failures.filter((failure) => failure.class === "hard-check");
  const severeTotal = Object.values(severe).reduce((sum, count) => sum + count, 0);
  return {
    run,
    severe,
    severeTotal,
    critical,
    continuity,
    itemStatuses,
    traps,
    finalTask: finalTaskMet,
    schedule: { appends, rebuilds, valid: scheduleValid },
    hardCheckFailures,
    failures,
    turns: evidence.length,
    ok: severeTotal === 0 && hardCheckFailures.length === 0 && finalTaskMet && scheduleValid
      && critical.matched === critical.total,
  };
}

function rebuildTurnsBetween(turnIndex, rebuildTurns, beforeTurn, afterTurn) {
  const before = turnIndex.get(beforeTurn);
  const after = turnIndex.get(afterTurn);
  if (before === undefined || after === undefined || after <= before) return false;
  for (const rebuildIndex of rebuildTurns) {
    if (rebuildIndex > before && rebuildIndex < after) return true;
  }
  return false;
}

/**
 * The release AND-gate over scored runs (#215's qualification thresholds).
 * Compression and cost numbers are deliberately absent: they are reported for
 * information and can never move this verdict.
 */
export function evaluateGates(runScores) {
  const severe = emptySevere();
  for (const score of runScores) {
    for (const klass of SEVERE_CLASSES) severe[klass] += score.severe[klass];
  }
  const severeTotal = Object.values(severe).reduce((sum, count) => sum + count, 0);

  const criticalTotal = runScores.reduce((sum, score) => sum + score.critical.total, 0);
  const criticalMatched = runScores.reduce((sum, score) => sum + score.critical.matched, 0);
  const continuityTotal = runScores.reduce((sum, score) => sum + score.continuity.total, 0);
  const continuityMatched = runScores.reduce((sum, score) => sum + score.continuity.matched, 0);

  const perScenario = new Map();
  for (const score of runScores) {
    const entry = perScenario.get(score.run.scenario) ?? { total: 0, matched: 0 };
    entry.total += score.continuity.total;
    entry.matched += score.continuity.matched;
    perScenario.set(score.run.scenario, entry);
  }
  const continuityPerScenario = Object.fromEntries(
    [...perScenario.entries()].map(([scenario, entry]) => [scenario, entry.total === 0 ? 1 : entry.matched / entry.total]),
  );

  const canonical = runScores.filter((score) => score.run.arm === "secondary");
  const canonicalFinalTasks = {
    passed: canonical.filter((score) => score.finalTask).length,
    total: canonical.length,
  };
  const schedule = {
    valid: runScores.filter((score) => score.schedule.valid).length,
    total: runScores.length,
  };
  const hardChecks = {
    failed: runScores.reduce((sum, score) => sum + score.hardCheckFailures.length, 0),
  };

  const criticalRecall = criticalTotal === 0 ? 1 : criticalMatched / criticalTotal;
  const continuityOverall = continuityTotal === 0 ? 1 : continuityMatched / continuityTotal;
  const perScenarioOk = Object.values(continuityPerScenario).every((value) => value >= 0.75);

  const gates = {
    severeFailures: { total: severeTotal, byClass: severe },
    criticalRecall,
    continuityRecallOverall: continuityOverall,
    continuityRecallPerScenario: continuityPerScenario,
    canonicalFinalTasks,
    scheduleComplete: schedule,
    hardChecks,
  };

  const result = severeTotal === 0
    && criticalRecall === 1
    && continuityOverall >= 0.85
    && perScenarioOk
    && canonicalFinalTasks.passed === canonicalFinalTasks.total
    && canonicalFinalTasks.total > 0
    && schedule.valid === schedule.total
    && hardChecks.failed === 0
    ? "pass"
    : "fail";

  return { gates, result };
}
