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

1. Confirm all 24 rows and 12 corresponding pairs are present:
   `ccr-claude/claude-sonnet-5` and `cpa/glm-5.3` each run early, middle, and
   late for every scenario from the same 12-case corpus. Seeds, script and
   evaluation digests must match within every pair. Both model queues must
   have started concurrently, cases and requests must be sequential inside
   each queue, and every cell must carry distinct isolation hashes. The
   introductory positions must precede the first compaction. A historical v2
   16-cell report is readable only as historical evidence and cannot satisfy
   this check.
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
   For source recovery, confirm each credited exact witness came from a
   successful search/read call-result pair visible in a later native request
   before handoff. A sufficient search excerpt requires no page read; any
   supplement must remain contiguous and source/view-bound. Each credited fact
   must share one excerpt or returned page with its complete original witness;
   never borrow provenance from a separate unit. Reject internal
   hit counts, summary copies, failed/stale/wrong-branch results, same-batch
   search-and-write, filtered results, clipped qualifiers, fabricated joins,
   and post-handoff observations.
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
6. Review the per-cell, paired, and per-model measurements and their declared
   directional cache, retrieval, evidence, append, rebuild, input, and elapsed
   differences without converting missing values to zero. Pi 0.84.2 normalizes
   omitted raw cache fields to zero at this public seam, so zero-only cache
   values must remain unknown; only positive cache counts establish reporting.
   Provider input/cache fields and returned evidence bytes are distinct units. If the separate recovery A/B was run,
   verify both arms used identical fixture/script/evaluation digests and that
   read-only requests actually omitted `search_memory_source`; those 12 cells
   never satisfy or replace the main 24-cell completeness requirement.

## Sign-off

Record reviewers, date, report hash/pins, any escalation, and either
`release-blocked` or `reviewed experimental/default-off evidence`. This gate
makes no claim of universal correctness, cost efficiency, or default-on
readiness.
