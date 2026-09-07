# Provider-cache experiment evidence archive

Committed copies of credentialed experiment runs for durable review access.
Each pair is the unmodified output of one `npm run experiment:provider-cache
-- --adapter tests/context-memory/adapters/cache-provider.mjs` execution; the
JSON records the exact implementation commit, its tree digest, and the run
nonce under `pins`, and its own `integrity`/`conclusion` fields are the
evidence. The gitignored `report/` directory holds the working copies;
generated runs always write there first.

- `provider-cache-experiment-credentialed-2026-09-07T09-35-49-418Z.{json,txt}`
  — run at commit `c8ba7a24fe6fc29c505d0994afb9bfd472eee875` (tree
  `f5a65aaf19ecb017808fc1bc3abbf5cf1158256e`): conclusive NEUTRAL with the
  liveness control alive (nonce 0.0% vs multiblock 22.1%, single baseline
  22.3%).
