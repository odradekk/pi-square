# Context Memory continuity qualification review rubric

This is a human review aid. The machine report may say
`pass-needs-human-review`; it is never, by itself, a release pass. No LLM may
judge, summarize, or resolve this review.

## Evidence to review

- The exact JSON report and its commit/tree/dirty, Pi, model/API, 100k-window,
  4096-output, and Context Memory configuration pins.
- The private evidence file when it was retained. Its SHA-256 is recorded in
  the report and its pins and attempt ID must match the report; it is stored
  beneath the gitignored report directory with owner-only file permissions and
  must have passed the shared credential cleaner. Missing or overflowed
  evidence requires human review and blocks a positive conclusion.
- The fixture version in `scenarios.mjs` and deterministic oracle in
  `oracles.mjs`. Do not re-run a scenario to reinterpret a recorded attempt.

## Required checks

1. Confirm all 16 rows are present: `ccr-claude/claude-sonnet-5` runs early,
   middle, and late for every scenario; `cpa/glm-5.3` runs the canonical
   variant. The primary middle position is canonical too. The introductory
   positions must precede the first compaction.
2. Confirm every row has integrity and coverage success: original brief and
   revision entries are covered by current Memory, the pre-final workspace
   is unchanged, and no raw answer remains outside Memory in the recorded
   first final context. The lexical leakage screen is not a semantic proof;
   inspect that context. Confirm the declared append / rebuild counts.
   A partial, crashed, timed-out, or overflowed run fails the
   complete-matrix requirement.
3. Review the complete retained trajectory and successive Memory blocks for
   all six severe classes, including cases no field check can detect: fabrication,
   uncertainty promotion, exact-detail corruption, negative-constraint
   violation, branch contamination, and recursive drift. Confirm reported
   machine signals against that evidence. Zero machine counters do not prove
   absence of semantic failures. Ambiguity requires a
   second human and remains blocked until resolved.
4. Confirm the deterministic gate results: zero severe failures, complete
   critical recall, required continuity recall, canonical final-task success,
   and required compaction schedule. The reviewer may block a machine pass but
   may not waive a machine failure. A noncanonical continuity miss may remain
   in an otherwise passing aggregate only when the oracle's documented 85%
   overall and 75%-per-scenario thresholds still pass; it is not equivalent to
   a critical, severe, or canonical-final-task failure.
5. Confirm the checkout was clean before credentialed work began. The
   append-only attempt log must include paired `started` and terminal records
   with the report's unique attempt ID. The log preserves attempts but does not
   itself enforce selection policy; reviewers must disclose prior failed
   attempts with the same pins rather than select a later favorable rerun.

## Sign-off

Record reviewers, date, report hash/pins, any escalation, and either
`release-blocked` or `reviewed experimental/default-off evidence`. This gate
makes no claim of universal correctness, cost efficiency, or default-on
readiness.
