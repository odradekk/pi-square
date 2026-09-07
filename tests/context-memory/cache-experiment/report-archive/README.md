# Provider-cache experiment evidence archive

Committed copies of credentialed experiment runs for durable review access.
Each pair is the unmodified output of one `npm run experiment:provider-cache
-- --adapter tests/context-memory/adapters/cache-provider.mjs` execution; the
JSON records the exact implementation commit, its tree digest, and the run
nonce (under each lane's `pins` in a comparison report), and its own
`integrity`/`conclusion` fields are the evidence. The gitignored `report/`
directory holds the working copies;
generated runs always write there first. Runs produced by the hardened
publisher at `668c938` or later are complete iff their txt file ends with the
`report complete` sentinel; the superseded pre-sentinel defect evidence below
is intentionally retained byte-for-byte and does not satisfy that boundary.

- `provider-cache-experiment-credentialed-2026-09-07T14-07-07-836Z.{json,txt}`
  — three-lane comparison at commit `d6de41b72d4e2c933541981d139d2f95124a9f6a`
  (tree `5b4ce2870b162201fdc806c35ee3546e9e0028a7`), 90 requests with all
  lane integrity checks passing. Sonnet 5 is conclusive NEUTRAL (multiblock
  22.2%, single 22.3%, live nonce 0.0%); GLM 5.3 is INCONCLUSIVE because
  multiblock, single, and nonce all read about 1.7%; GPT-5.6 Luna is
  INCONCLUSIVE because every cache-read/cache-creation value was zero.

- `provider-cache-experiment-credentialed-2026-09-07T12-26-42-072Z.{json,txt}`
  — final run at commit `fcf11cc6b9769d886c6882de400fa8657724a1e9`
  (tree `7cac949abd356767b9d73867f92bb85827f30ba4`): conclusive
  NEUTRAL with the liveness control alive (nonce 0.0% vs multiblock 22.2%,
  single baseline 22.2%), all 15 primes reading zero, and the hardened
  credential/report, monotonic timing, Git provenance, and host-capability
  boundaries in place.
- `provider-cache-experiment-credentialed-2026-09-07T10-26-08-281Z.{json,txt}`
  — superseded by the final integrity fixes, but otherwise valid; run at
  commit `668c9389581b0a8faa7e99fbbe930b11def3ccf9` (tree
  `9850ac5498bea6c237ad392d97d3e09e99520b6a`): conclusive NEUTRAL with the
  liveness control alive (nonce 0.0% vs multiblock 22.2%, single baseline
  22.2%) and all 15 primes reading zero — five genuinely independent cold
  prime/probe pairs (run+group+arm isolation).
- `provider-cache-experiment-credentialed-2026-09-07T09-35-49-418Z.{json,txt}`
  — superseded, kept as defect evidence: run at `c8ba7a2` with run+arm (no
  group) isolation, where groups 2–5's primes read 1372/1380 tokens cached by
  earlier same-arm groups, so the five groups were not independent pairs.
