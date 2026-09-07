# Provider-cache experiment evidence archive

Committed copies of credentialed experiment runs for durable review access.
Each pair is the unmodified output of one `npm run experiment:provider-cache
-- --adapter tests/context-memory/adapters/cache-provider.mjs` execution; the
JSON records the exact implementation commit, its tree digest, and the run
nonce under `pins`, and its own `integrity`/`conclusion` fields are the
evidence. The gitignored `report/` directory holds the working copies;
generated runs always write there first. Runs produced by the hardened
publisher at `668c938` or later are complete iff their txt file ends with the
`report complete` sentinel; the superseded pre-sentinel defect evidence below
is intentionally retained byte-for-byte and does not satisfy that boundary.

- `provider-cache-experiment-credentialed-2026-09-07T10-26-08-281Z.{json,txt}`
  — run at commit `668c9389581b0a8faa7e99fbbe930b11def3ccf9` (tree
  `9850ac5498bea6c237ad392d97d3e09e99520b6a`): conclusive NEUTRAL with the
  liveness control alive (nonce 0.0% vs multiblock 22.2%, single baseline
  22.2%) and all 15 primes reading zero — five genuinely independent cold
  prime/probe pairs (run+group+arm isolation).
- `provider-cache-experiment-credentialed-2026-09-07T09-35-49-418Z.{json,txt}`
  — superseded, kept as defect evidence: run at `c8ba7a2` with run+arm (no
  group) isolation, where groups 2–5's primes read 1372/1380 tokens cached by
  earlier same-arm groups, so the five groups were not independent pairs.
