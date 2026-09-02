# Context Memory continuity qualification — fixed human review rubric

This rubric is a fixed document, not code that decides (#224). It governs the
human review half of the Context Memory release qualification gate defined in
#215's testing decisions. The automated half is the deterministic oracle in
`oracles.mjs`; nothing in this rubric may be executed by a model. The digest
of this file is pinned into every qualification report, so a review is only
valid for the exact rubric version the report cites.

## 1. Scope and binding status

- One review covers exactly one qualification execution: the report written by
  `npm run qualify:continuity` (or its `--adapter` real-mode form executed by
  #227) with its recorded pins — implementation commit and digest, package and
  Pi versions, configuration, adapter arms with thinking and sampling
  settings, fixture digest, and seeds.
- A dry-run report (`mode: "dry-run"`, `releaseRelevant: false`) is never
  reviewed for release and never authorizes anything.
- The release verdict is the AND of the machine gates and this review. The
  reviewer can block a release; the reviewer can never unilaterally pass a
  gate the machine failed.

## 2. What the reviewer works from

- The bounded JSON and Markdown report. It contains run identities, turn
  counts, compression schedules, per-item oracle outcomes, failure ids, and
  pinned digests — and deliberately no Memory bodies, no source transcripts,
  no provider payloads, and no credentials.
- The scenario fixtures in `scenarios.mjs` for the exact fixture digest.
- Where a reported failure needs human eyes on the underlying run, the
  maintainer environment holding the recorded evidence for that execution.
  Reviewers must not re-run the scenarios to form a judgment about a recorded
  attempt.

## 3. The six severe failure classes

Confirm each machine classification against these definitions. The classes
are counted separately and never blended with recall percentages,
compression ratios, or cost numbers.

| class | definition | typical machine signal |
| --- | --- | --- |
| fabrication | the run asserted a predeclared false statement as fact | `forbidden-claim`, `final-task-claim` |
| uncertainty-promotion | the run answered an unestablished question with a specific value instead of uncertainty | `trap-promotion` |
| exact-detail-corruption | a critical exact value was recalled with a wrong value | `item-corruption` |
| negative-constraint | the run reversed a predeclared constraint in words or actions | `constraint-claim`, `constraint-action` |
| branch-contamination | facts from an abandoned session branch surfaced on the retained branch, or entered its Memory | `branch-visibility`, `memory-purity` |
| recursive-drift | a value that was correct before a suffix rebuild became wrong after it | `item-drift` |

Machine precedence: a corrupted probe across a rebuild boundary counts as
recursive drift, not plain corruption — the more specific class wins.

Trap semantics (#261): the machine passes an uncertainty trap when the answer
promotes no concrete value, whatever the refusal's phrasing — a negated
refusal ("no retention period has been established") is a pass, and refusal
style is never judged. Only the promotion signal, plus a non-empty answer
naming the subject, is machine-read. Confirm flagged promotions; do not
downgrade one because the surrounding prose sounds uncertain.

Scoring scope (#261): every scored turn's fixture question asks for exactly
the items the oracle scores there, so recall percentages measure what the
model was asked, not its verbosity or volunteered extras. The compression
schedule is fixture-owned: the branch is seeded with Memory rendering at
exactly half the budget, so every run must observe one append onto the seeded
Memory and two suffix rebuilds — deviations are instrument or controller
defects, never model variance.

## 4. Reviewer procedure per run

1. Confirm the run row exists with the expected scenario, variant, arm, and
   seed from the pins, and that the observed schedule shows the seeded
   schedule: one append onto the seeded Memory and two suffix rebuilds.
2. Spot-check at least two oracle items against the fixture: the predeclared
   `requires` patterns must actually appear in the scripted probe answers and
   the matching must be the documented case-insensitive substring rule.
3. Confirm no report field contains Memory Markdown, source transcript text,
   provider payload fragments, or credential material. Treat any such leak as
   a release-blocking report defect.
4. For every machine-flagged severe failure: confirm or challenge the
   classification using the class definitions above.
5. For canonical (secondary-arm) runs: confirm the final task outcome.

## 5. Ambiguity escalation — second human, never a model

- If the first reviewer finds a severe classification ambiguous — plausibly
  severe under one reading and non-severe under another — the case escalates
  to a second human reviewer.
- The case remains blocked until both humans agree on one classification.
  Persistent disagreement stays blocked; it is never resolved by coin flip,
  by an LLM judge, by tooling, or by re-running the scenario.
- No LLM may participate anywhere in the review: not as judge, not as
  summarizer of evidence, not as tiebreaker.
- A human may never mark a machine-failed oracle check as passed. The only
  remediation for a failed check is a change plus a rerun under §6.

## 6. Rerun integrity — no favorable selection

- Every execution appends one line to `attempts.jsonl` keyed by the pins
  digest. Attempts are append-only; nothing is overwritten or deleted.
- A failed verdict for one pins digest is never superseded by re-running the
  same pins. Reruns are legitimate only after a recorded change, scoped by
  the deterministic policy in `selectRerunScope`: model-visible or algorithm
  changes rerun all 16 runs; Pi/provider compatibility changes rerun the
  affected arms; defect fixes rerun the affected scenarios; pure UI or
  documentation changes rerun nothing.
- Choosing a favorable subset of attempts, seeds, or scenarios as "the"
  result is prohibited. The release verdict cites one complete execution and
  discloses every prior attempt on the same or earlier pins.

## 7. The release verdict (#227)

Record the AND-gate outcome against the report:

1. Zero confirmed severe failures across all six classes.
2. Critical recall exactly 100%.
3. Continuity recall at least 85% overall and at least 75% per scenario.
4. All four canonical final tasks successful.
5. Every run completed the required compression schedule.
6. No unresolved ambiguous severe case (§5).
7. The report is tied to the intended release commit and configuration.

The verdict must not claim universal correctness, provider-cache guarantees,
performance or cost-efficiency superiority, or fitness for default-on. Those
claims are out of scope for this rubric and for the qualification gate.

## 8. Sign-off

A completed review records: reviewer names (two where §5 applied), review
date, report pins digest, the resolved list of escalated cases, and the
final verdict (`ready to release as experimental/default-off` or
`release-blocked` with the exact failed conditions). The sign-off is stored
with the release evidence, not in this repository.
